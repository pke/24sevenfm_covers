#pragma once
#include <cstdint>
#include <cstdio>
#include <string>
#ifdef _WIN32
#include <windows.h>
#else
#include <ctime>
#endif

namespace ssc {
enum class UtcFormat { Date, Iso8601, Display };

#ifdef _WIN32
inline std::string formatUtcTime(const SYSTEMTIME& utc, UtcFormat format) {
    const char* pattern = format == UtcFormat::Date ? "%04u-%02u-%02u" :
        format == UtcFormat::Iso8601 ? "%04u-%02u-%02uT%02u:%02u:%02uZ" :
        "%04u-%02u-%02u %02u:%02u:%02u UTC";
    char text[32];
    std::snprintf(text, sizeof(text), pattern, unsigned(utc.wYear), unsigned(utc.wMonth),
        unsigned(utc.wDay), unsigned(utc.wHour), unsigned(utc.wMinute), unsigned(utc.wSecond));
    return text;
}
#endif

inline std::string formatUtcTime(std::int64_t epochSeconds, UtcFormat format) {
#ifdef _WIN32
    // Preserve gmtime_s's supported range (1970 through 3000), and reject bad
    // persisted timestamps before multiplying seconds into FILETIME ticks.
    if (epochSeconds < 0 || epochSeconds > 32535215999LL) return {};
    ULARGE_INTEGER ticks;
    ticks.QuadPart = (static_cast<ULONGLONG>(epochSeconds) + 11644473600ULL) * 10000000ULL;
    const FILETIME fileTime = {ticks.LowPart, ticks.HighPart};
    SYSTEMTIME utc = {};
    if (!FileTimeToSystemTime(&fileTime, &utc)) return {};
    return formatUtcTime(utc, format);
#else
    const auto time = static_cast<std::time_t>(epochSeconds);
    if (static_cast<std::int64_t>(time) != epochSeconds) return {};
    std::tm utc = {};
    if (!gmtime_r(&time, &utc)) return {};
    const char* pattern = format == UtcFormat::Date ? "%Y-%m-%d" :
        format == UtcFormat::Iso8601 ? "%Y-%m-%dT%H:%M:%SZ" : "%Y-%m-%d %H:%M:%S UTC";
    char text[32];
    if (!std::strftime(text, sizeof(text), pattern, &utc)) return {};
    return text;
#endif
}
} // namespace ssc
