// UTC calendar adapter. Shared parsers do not depend on a platform's tm API.
#pragma once
#include <cstdint>
#include <ctime>
#if defined(_WIN32) && !defined(SSC_USE_CRT_TIME)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <chrono>
#endif

namespace ssc { namespace platform {
#if defined(_WIN32) && !defined(SSC_USE_CRT_TIME)
inline std::uint64_t utcFileTimeTicks() {
    // Resolve the Windows 8+ precise clock dynamically to retain Windows 7
    // compatibility. Both APIs return UTC, independently of the host timezone.
    typedef void (WINAPI *ReadTime)(LPFILETIME);
    static const ReadTime precise = reinterpret_cast<ReadTime>(
        GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "GetSystemTimePreciseAsFileTime"));
    FILETIME utc = {};
    if (precise) precise(&utc); else GetSystemTimeAsFileTime(&utc);
    ULARGE_INTEGER ticks;
    ticks.LowPart = utc.dwLowDateTime;
    ticks.HighPart = utc.dwHighDateTime;
    return ticks.QuadPart;
}
#endif

inline std::time_t utcNowSeconds() {
#if defined(_WIN32) && !defined(SSC_USE_CRT_TIME)
    return static_cast<std::time_t>(static_cast<std::int64_t>(utcFileTimeTicks() / 10000000ULL) - 11644473600LL);
#else
    return std::time(nullptr);
#endif
}

inline std::int64_t utcNowMilliseconds() {
#if defined(_WIN32) && !defined(SSC_USE_CRT_TIME)
    return static_cast<std::int64_t>(utcFileTimeTicks() / 10000ULL) - 11644473600000LL;
#else
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
#endif
}

inline double utcNowMillisecondsPrecise() {
#if defined(_WIN32) && !defined(SSC_USE_CRT_TIME)
    const std::uint64_t ticks = utcFileTimeTicks();
    const std::int64_t seconds = static_cast<std::int64_t>(ticks / 10000000ULL) - 11644473600LL;
    return static_cast<double>(seconds) * 1000 + static_cast<double>(ticks % 10000000ULL) / 10000;
#else
    return std::chrono::duration<double, std::milli>(
        std::chrono::system_clock::now().time_since_epoch()).count();
#endif
}

inline std::time_t utcEpochSeconds(int year, int month, int day,
                                  int hour, int minute, int second) {
#if defined(_WIN32) && !defined(SSC_USE_CRT_TIME) && !defined(_USE_32BIT_TIME_T)
    // Preserve the existing _mkgmtime64 input bounds and normalization. Win32
    // rejects day 32/hour 25, so convert the first of the normalized month and
    // add the remaining fields as seconds instead. No timezone or DST involved.
    if (year < 1969 || year > 3002) return std::time_t(-1);
    std::int64_t normalizedMonth = static_cast<std::int64_t>(month) - 1;
    std::int64_t normalizedYear = year + normalizedMonth / 12;
    normalizedMonth %= 12;
    if (normalizedMonth < 0) { normalizedMonth += 12; --normalizedYear; }
    if (normalizedYear < 1969 || normalizedYear > 3002) return std::time_t(-1);
    SYSTEMTIME utc = {};
    utc.wYear = static_cast<WORD>(normalizedYear);
    utc.wMonth = static_cast<WORD>(normalizedMonth + 1);
    utc.wDay = 1;
    FILETIME fileTime = {};
    if (!SystemTimeToFileTime(&utc, &fileTime)) return std::time_t(-1);
    ULARGE_INTEGER ticks;
    ticks.LowPart = fileTime.dwLowDateTime;
    ticks.HighPart = fileTime.dwHighDateTime;
    const std::int64_t epoch = static_cast<std::int64_t>(ticks.QuadPart / 10000000ULL)
        - 11644473600LL + (static_cast<std::int64_t>(day) - 1) * 86400
        + static_cast<std::int64_t>(hour) * 3600
        + static_cast<std::int64_t>(minute) * 60 + second;
    // UCRT accepts a small margin around its documented epoch; retain that
    // behavior, including negative seconds around midnight on 1970-01-01.
    if (epoch < -43200 || epoch > 0x793582affLL + 50400) return std::time_t(-1);
    return static_cast<std::time_t>(epoch);
#else
    std::tm utc = {};
    utc.tm_year = year - 1900;
    utc.tm_mon = month - 1;
    utc.tm_mday = day;
    utc.tm_hour = hour;
    utc.tm_min = minute;
    utc.tm_sec = second;
    utc.tm_isdst = -1;
#ifdef _WIN32
    return _mkgmtime(&utc);
#else
    return timegm(&utc);
#endif
#endif
}
} }
