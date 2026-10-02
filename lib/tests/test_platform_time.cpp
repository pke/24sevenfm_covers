#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include "../platform_time.h"
#include <random>
#include <chrono>

TEST_CASE("UTC clocks retain Unix seconds milliseconds and fractional millisecond units") {
    const auto beforeSeconds = std::time(nullptr);
    const auto beforeMs = std::chrono::duration<double, std::milli>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    const auto seconds = ssc::platform::utcNowSeconds();
    const auto milliseconds = ssc::platform::utcNowMilliseconds();
    const double preciseMs = ssc::platform::utcNowMillisecondsPrecise();
    const auto afterMs = std::chrono::duration<double, std::milli>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    const auto afterSeconds = std::time(nullptr);
    CHECK(seconds >= beforeSeconds);
    CHECK(seconds <= afterSeconds);
    // Include floor-to-millisecond rounding (and the older Win32 clock's tick).
    CHECK(milliseconds >= beforeMs - 20);
    CHECK(milliseconds <= afterMs + 20);
    CHECK(preciseMs >= beforeMs - 20);
    CHECK(preciseMs <= afterMs + 20);
}

TEST_CASE("UTC adapter preserves leap years epoch and calendar normalization") {
    using ssc::platform::utcEpochSeconds;
    CHECK(utcEpochSeconds(1970, 1, 1, 0, 0, 0) == 0);
    CHECK(utcEpochSeconds(2000, 2, 29, 0, 0, 0) == 951782400);
    CHECK(utcEpochSeconds(2100, 2, 29, 0, 0, 0) == utcEpochSeconds(2100, 3, 1, 0, 0, 0));
    CHECK(utcEpochSeconds(2026, 0, 32, 25, 60, 60) == utcEpochSeconds(2026, 1, 2, 2, 1, 0));
    CHECK(utcEpochSeconds(2025, 13, 1, 0, 0, 0) == utcEpochSeconds(2026, 1, 1, 0, 0, 0));
}

#ifdef _WIN32
TEST_CASE("UTC adapter matches existing Windows CRT bounds and overflowing feed fields") {
    const auto compare = [](int year, int month, int day, int hour, int minute, int second) {
        std::tm original = {};
        original.tm_year = year - 1900;
        original.tm_mon = month - 1;
        original.tm_mday = day;
        original.tm_hour = hour;
        original.tm_min = minute;
        original.tm_sec = second;
        original.tm_isdst = -1;
        CAPTURE(year); CAPTURE(month); CAPTURE(day);
        CAPTURE(hour); CAPTURE(minute); CAPTURE(second);
        CHECK(ssc::platform::utcEpochSeconds(year, month, day, hour, minute, second) == _mkgmtime(&original));
    };
    for (int year : {1900, 1968, 1969, 1970, 2000, 2038, 2100, 3000, 3001, 3002, 3003, 9999})
        for (int month : {0, 1, 2, 12, 13, 99})
            for (int day : {0, 1, 18, 19, 28, 29, 31, 32, 99})
                compare(year, month, day, 0, 0, 0);
    for (int hour = -13; hour <= 24; ++hour)
        for (int second : {-1, 0, 1, 59, 60, 99}) {
            compare(1970, 1, 1, hour, 0, second);
            compare(3001, 1, 19, hour, 0, second);
        }
    std::mt19937 generator(24);
    std::uniform_int_distribution<int> years(1960, 3010), fields(0, 99);
    for (int i = 0; i < 10000; ++i)
        compare(years(generator), fields(generator), fields(generator),
                fields(generator), fields(generator), fields(generator));
}
#endif
