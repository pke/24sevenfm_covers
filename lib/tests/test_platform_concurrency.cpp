#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include "../platform_concurrency.h"
#include <atomic>
#include <thread>
#include <vector>

using ssc::platform::Mutex;
using ssc::platform::ConditionVariable;
using ssc::platform::Thread;

TEST_CASE("platform unique locks reject invalid ownership transitions") {
    Mutex mutex;
    ssc::platform::UniqueLock lock(mutex);
    CHECK(lock.owns_lock());
    CHECK_THROWS_AS(lock.lock(), std::exception);
    lock.unlock();
    CHECK_FALSE(lock.owns_lock());
    CHECK_THROWS_AS(lock.unlock(), std::exception);
    lock.lock();
    CHECK(lock.owns_lock());
}

TEST_CASE("platform workers preserve ownership and serialize concurrent writes") {
    Mutex mutex;
    int count = 0;
    std::vector<Thread> workers;
    for (int worker = 0; worker < 8; ++worker)
        workers.emplace_back([&] {
            for (int i = 0; i < 2000; ++i) {
                ssc::platform::LockGuard lock(mutex);
                ++count;
            }
        });
    Thread moved(std::move(workers[0]));
    CHECK_FALSE(workers[0].joinable());
    CHECK(moved.joinable());
    Thread assigned;
    assigned = std::move(moved);
    CHECK_FALSE(moved.joinable());
    assigned.join();
    CHECK_FALSE(assigned.joinable());
    for (size_t i = 1; i < workers.size(); ++i) workers[i].join();
    CHECK(count == 16000);
    CHECK_THROWS_AS(assigned.join(), std::exception);
}

TEST_CASE("platform waits retain predicates through early and spurious notifications") {
    Mutex mutex;
    ConditionVariable cv;
    bool ready = true;
    cv.notify_all(); // notification arrives before the waiter takes its lock
    ssc::platform::UniqueLock lock(mutex);
    CHECK(cv.wait_for(lock, std::chrono::milliseconds(0), [&] { return ready; }));
    ready = false;
    CHECK_FALSE(cv.wait_for(lock, std::chrono::milliseconds(0), [&] { return ready; }));
    Thread notifier([&] {
        for (int i = 0; i < 16; ++i) {
            cv.notify_all();
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    });
    const auto start = std::chrono::steady_clock::now();
    CHECK_FALSE(cv.wait_for(lock, std::chrono::milliseconds(40), [&] { return ready; }));
    CHECK(std::chrono::steady_clock::now() - start >= std::chrono::milliseconds(40));
    // A timed wait must return with the caller's lock still owned.
    CHECK(lock.owns_lock());
    lock.unlock();
    notifier.join();
}

TEST_CASE("platform notification wakes every blocked worker without losing publication") {
    Mutex mutex;
    ConditionVariable cv;
    int waiting = 0, completed = 0;
    bool released = false;
    std::vector<Thread> workers;
    for (int i = 0; i < 4; ++i)
        workers.emplace_back([&] {
            ssc::platform::UniqueLock lock(mutex);
            ++waiting;
            cv.notify_all();
            cv.wait(lock, [&] { return released; });
            ++completed;
        });
    {
        ssc::platform::UniqueLock lock(mutex);
        const bool allWaiting = cv.wait_for(lock, std::chrono::seconds(5), [&] { return waiting == 4; });
        CHECK(allWaiting);
        released = true; // release even after a timeout, so cleanup cannot strand workers
        cv.notify_all();
    }
    for (auto& worker : workers) worker.join();
    CHECK(completed == 4);
}

#if defined(_WIN32) && !defined(SSC_USE_STD_CONCURRENCY)
TEST_CASE("Windows worker joins release their kernel handles") {
    Thread warmup([] {});
    warmup.join();
    DWORD before = 0, after = 0;
    REQUIRE(GetProcessHandleCount(GetCurrentProcess(), &before));
    for (int i = 0; i < 128; ++i) {
        Thread worker([] {});
        worker.join();
    }
    REQUIRE(GetProcessHandleCount(GetCurrentProcess(), &after));
    CHECK(after == before);
}
#endif
