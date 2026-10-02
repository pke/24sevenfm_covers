#pragma once
#include <cstdint>
#include <cstdio>
#include <string>
#include "platform_text.h"
#ifdef _WIN32
#include <windows.h>
#else
#include <ctime>
#endif

namespace ssc {
enum class UtcFormat { Date, Iso8601, Display };

#ifdef _WIN32
inline std::string formatUtcTime(const SYSTEMTIME& utc, UtcFormat format) {
    const std::string date = platform::unsignedText(utc.wYear, 4) + "-"
        + platform::unsignedText(utc.wMonth, 2) + "-" + platform::unsignedText(utc.wDay, 2);
    if (format == UtcFormat::Date) return date;
    return date + (format == UtcFormat::Iso8601 ? "T" : " ")
        + platform::unsignedText(utc.wHour, 2) + ":" + platform::unsignedText(utc.wMinute, 2)
        + ":" + platform::unsignedText(utc.wSecond, 2)
        + (format == UtcFormat::Iso8601 ? "Z" : " UTC");
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
