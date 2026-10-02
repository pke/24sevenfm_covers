// Small concurrency facade. Shared code stays C++11-compatible; Windows uses
// native locks/waits without pulling in the C++ runtime's synchronization layer.
#pragma once

#include <chrono>
#include <condition_variable> // cv_status; the Windows backend does not instantiate std waits

#if defined(_WIN32) && !defined(SSC_USE_STD_CONCURRENCY)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <process.h>
#include <exception>
#include <memory>
#include <type_traits>
#include <utility>

namespace ssc { namespace platform {

class ConcurrencyError : public std::exception {
public:
    explicit ConcurrencyError(const char* message) noexcept : message_(message) {}
    const char* what() const noexcept override { return message_; }
private:
    const char* message_; // all messages have static lifetime; no allocation/locale work
};

class Mutex {
public:
    Mutex() noexcept = default;
    Mutex(const Mutex&) = delete;
    Mutex& operator=(const Mutex&) = delete;
    void lock() noexcept { AcquireSRWLockExclusive(&lock_); }
    void unlock() noexcept { ReleaseSRWLockExclusive(&lock_); }
private:
    friend class ConditionVariable;
    SRWLOCK lock_ = SRWLOCK_INIT;
};

class LockGuard {
public:
    explicit LockGuard(Mutex& mutex) noexcept : mutex_(mutex) { mutex_.lock(); }
    ~LockGuard() { mutex_.unlock(); }
    LockGuard(const LockGuard&) = delete;
    LockGuard& operator=(const LockGuard&) = delete;
private:
    Mutex& mutex_;
};

class UniqueLock {
public:
    explicit UniqueLock(Mutex& mutex) noexcept : mutex_(&mutex), owned_(true) { mutex_->lock(); }
    ~UniqueLock() { if (owned_) mutex_->unlock(); }
    UniqueLock(const UniqueLock&) = delete;
    UniqueLock& operator=(const UniqueLock&) = delete;
    bool owns_lock() const noexcept { return owned_; }
    Mutex* mutex() const noexcept { return mutex_; }
    void lock() {
        if (owned_) throw ConcurrencyError("Lock is already owned");
        mutex_->lock(); owned_ = true;
    }
    void unlock() {
        if (!owned_) throw ConcurrencyError("Lock is not owned");
        mutex_->unlock(); owned_ = false;
    }
private:
    Mutex* mutex_;
    bool owned_;
};

class ConditionVariable {
public:
    ConditionVariable() noexcept = default;
    ConditionVariable(const ConditionVariable&) = delete;
    ConditionVariable& operator=(const ConditionVariable&) = delete;
    void notify_one() noexcept { WakeConditionVariable(&condition_); }
    void notify_all() noexcept { WakeAllConditionVariable(&condition_); }
    void wait(UniqueLock& lock) {
        if (!lock.owns_lock()) throw ConcurrencyError("Wait requires an owned lock");
        if (!SleepConditionVariableSRW(&condition_, &lock.mutex()->lock_, INFINITE, 0))
            throw ConcurrencyError("Condition variable wait failed");
    }
    template<class Predicate>
    void wait(UniqueLock& lock, Predicate predicate) {
        while (!predicate()) wait(lock);
    }
    template<class Clock, class Duration>
    std::cv_status wait_until(UniqueLock& lock,
                             const std::chrono::time_point<Clock, Duration>& deadline) {
        if (!lock.owns_lock()) throw ConcurrencyError("Wait requires an owned lock");
        for (;;) {
            const auto remaining = deadline - Clock::now();
            if (remaining <= remaining.zero()) return std::cv_status::timeout;
            // Round up so sub-millisecond waits do not return before the deadline.
            auto milliseconds = std::chrono::duration_cast<std::chrono::milliseconds>(remaining);
            if (milliseconds < remaining) milliseconds += std::chrono::milliseconds(1);
            const DWORD timeout = milliseconds.count() >= MAXDWORD - 1
                ? MAXDWORD - 1 : static_cast<DWORD>(milliseconds.count());
            if (SleepConditionVariableSRW(&condition_, &lock.mutex()->lock_, timeout, 0))
                return std::cv_status::no_timeout; // callers must recheck their predicate
            if (GetLastError() != ERROR_TIMEOUT)
                throw ConcurrencyError("Condition variable wait failed");
            // A long deadline can require several bounded Win32 waits.
        }
    }
    template<class Rep, class Period>
    std::cv_status wait_for(UniqueLock& lock,
                           const std::chrono::duration<Rep, Period>& duration) {
        return wait_until(lock, std::chrono::steady_clock::now() + duration);
    }
    template<class Rep, class Period, class Predicate>
    bool wait_for(UniqueLock& lock,
                  const std::chrono::duration<Rep, Period>& duration, Predicate predicate) {
        const auto deadline = std::chrono::steady_clock::now() + duration;
        while (!predicate())
            if (wait_until(lock, deadline) == std::cv_status::timeout) return predicate();
        return true;
    }
private:
    CONDITION_VARIABLE condition_ = CONDITION_VARIABLE_INIT;
};

// Owning, joinable worker; destruction/move-assignment of a live worker terminates,
// as std::thread does. Workers must return normally; they are never force-killed.
class Thread {
public:
    Thread() noexcept = default;
    template<class Function>
    explicit Thread(Function&& function) {
        typedef typename std::decay<Function>::type Task;
        std::unique_ptr<Task> task(new Task(std::forward<Function>(function)));
        // These workers still use strings, allocation, etc. Keep CRT thread-local
        // initialization and cleanup; replacing this with CreateThread is unsafe.
        const uintptr_t started = _beginthreadex(nullptr, 0, &run<Task>, task.get(), 0, &id_);
        if (!started) throw ConcurrencyError("Worker thread creation failed");
        task.release();
        handle_ = reinterpret_cast<HANDLE>(started);
    }
    ~Thread() { if (joinable()) std::terminate(); }
    Thread(const Thread&) = delete;
    Thread& operator=(const Thread&) = delete;
    Thread(Thread&& other) noexcept : handle_(other.handle_), id_(other.id_) {
        other.handle_ = nullptr; other.id_ = 0;
    }
    Thread& operator=(Thread&& other) noexcept {
        if (joinable()) std::terminate();
        handle_ = other.handle_; id_ = other.id_;
        other.handle_ = nullptr; other.id_ = 0;
        return *this;
    }
    bool joinable() const noexcept { return handle_ != nullptr; }
    void join() {
        if (!joinable() || id_ == GetCurrentThreadId())
            throw ConcurrencyError("Cannot join this worker thread");
        if (WaitForSingleObject(handle_, INFINITE) != WAIT_OBJECT_0)
            throw ConcurrencyError("Worker thread join failed");
        CloseHandle(handle_);
        handle_ = nullptr; id_ = 0;
    }
private:
    template<class Task>
    static unsigned __stdcall run(void* context) noexcept {
        std::unique_ptr<Task> task(static_cast<Task*>(context));
        try { (*task)(); } catch (...) { std::terminate(); }
        return 0;
    }
    HANDLE handle_ = nullptr;
    unsigned id_ = 0;
};

} } // namespace ssc::platform

#else
#include <mutex>
#include <condition_variable>
#include <thread>
namespace ssc { namespace platform {
using Mutex = std::mutex;
using LockGuard = std::lock_guard<Mutex>;
using UniqueLock = std::unique_lock<Mutex>;
using ConditionVariable = std::condition_variable;
using Thread = std::thread;
} }
#endif
