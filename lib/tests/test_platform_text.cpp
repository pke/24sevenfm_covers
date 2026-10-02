#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include "../platform_text.h"
#include <clocale>
#include <limits>
#include <random>

TEST_CASE("platform byte scans preserve standard string charset semantics") {
    std::mt19937 generator(24);
    for (int i = 0; i < 1000; ++i) {
        std::string text, set;
        for (unsigned n = generator() % 64; n; --n) text += static_cast<char>(generator() % 256);
        for (unsigned n = generator() % 16; n; --n) set += static_cast<char>(1 + generator() % 255);
        const size_t start = generator() % 80;
        CHECK(ssc::platform::firstOf(text, set.c_str(), start) == text.find_first_of(set, start));
        CHECK(ssc::platform::firstNotOf(text, set.c_str(), start) == text.find_first_not_of(set, start));
        CHECK(ssc::platform::lastNotOf(text, set.c_str()) == text.find_last_not_of(set));
    }
    CHECK(ssc::platform::firstOf("abc", "abc", std::string::npos) == std::string::npos);
    CHECK(ssc::platform::firstNotOf("abc", "", std::string::npos) == std::string::npos);
}

TEST_CASE("platform integer text preserves full range and bounded zero padding") {
    CHECK(ssc::platform::unsignedText(0) == "0");
    CHECK(ssc::platform::unsignedText((std::numeric_limits<std::uint64_t>::max)()) == "18446744073709551615");
    CHECK(ssc::platform::signedText((std::numeric_limits<std::int64_t>::min)()) == "-9223372036854775808");
    CHECK(ssc::platform::signedText((std::numeric_limits<std::int64_t>::max)()) == "9223372036854775807");
    CHECK(ssc::platform::signedText(-1) == "-1");
    CHECK(ssc::platform::integerText(-1) == "-1");
    CHECK(ssc::platform::integerText((std::numeric_limits<std::uint64_t>::max)()) == "18446744073709551615");
    CHECK(ssc::platform::integerText((std::numeric_limits<std::int64_t>::min)()) == "-9223372036854775808");
    CHECK(ssc::platform::unsignedText(7, 2) == "07");
    CHECK(ssc::platform::unsignedText(2026, 4) == "2026");
    CHECK(ssc::platform::unsignedText(123, 2) == "123");
    CHECK(ssc::platform::unsignedText(1, 100) == std::string(31, '0') + "1");
}

TEST_CASE("platform number text preserves precision signed zero and finite limits") {
    CHECK(ssc::platform::numberText(12.125, true) == "12.12");
    CHECK(ssc::platform::numberText(12.375, true) == "12.38");
    CHECK(ssc::platform::numberText(-0., true) == "-0.00");
    CHECK(ssc::platform::numberText(-0., false) == "-0");
    CHECK(ssc::platform::numberText(1234567., false) == "1.23457e+06");
    CHECK(ssc::platform::numberText(0.00000125, false) == "1.25e-06");
    CHECK(ssc::platform::numberText((std::numeric_limits<double>::max)(), true).size() == 312);
    CHECK(ssc::platform::numberText(std::numeric_limits<double>::infinity(), false) == "null");
    CHECK(ssc::platform::numberText(std::numeric_limits<double>::quiet_NaN(), true) == "null");
}

#ifdef _WIN32
TEST_CASE("platform text backends leave the host numeric locale unchanged") {
    struct RestoreLocale {
        std::string original = std::setlocale(LC_NUMERIC, nullptr);
        ~RestoreLocale() { std::setlocale(LC_NUMERIC, original.c_str()); }
    } restore;
    REQUIRE(std::setlocale(LC_NUMERIC, "German_Germany.1252") != nullptr);
    CHECK(ssc::platform::numberText(12.5, true) == "12.50");
    CHECK(ssc::platform::numberText(12.5, false) == "12.5");
    CHECK(std::string(std::localeconv()->decimal_point) == ",");
}
#endif
