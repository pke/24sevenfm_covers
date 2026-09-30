#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include "../mini_json.h"
#include <cerrno>
#include <clocale>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>

TEST_CASE("JSON numbers preserve CRT precision and range handling") {
    const auto compare = [](const std::string& text) {
        CAPTURE(text);
        errno = 0;
        char* end = nullptr;
        const double expected = std::strtod(text.c_str(), &end);
        const bool accepted = errno != ERANGE && end && !*end && std::isfinite(expected);
        ssc::JsonValue actual;
        const bool parsed = ssc::parseJson(text, actual);
        CHECK(parsed == accepted);
        if (parsed && accepted) {
            CHECK(actual.type == ssc::JsonValue::Number);
            CHECK(std::memcmp(&actual.number, &expected, sizeof(double)) == 0);
        }
    };
    for (const char* text : {"0", "-0", "0.0", "-0e10", "0e99999", "-0e-99999",
            "0.1", "-0.1", "12.125", "123456789.987654321", "1E+20", "1e-20",
            "9007199254740991", "9007199254740992", "9007199254740993",
            "1.00000000000000011102230246251565404236316680908203125",
            "1.7976931348623157e308", "1.7976931348623159e308", "1e99999", "-1e99999",
            "2.2250738585072014e-308", "2.225073858507201e-308", "1e-309",
            "4.9406564584124654e-324", "2.4703282292062327e-324", "1e-99999"}) compare(text);
    compare("1." + std::string(2000, '1'));
    compare("0." + std::string(1000, '0') + "1e1001");

    // Compare exact double bits, including signed zero, across the exponent range.
    std::uint64_t state = 0x24f00d;
    for (unsigned sample = 0; sample < 10000; ++sample) {
        state = state * 6364136223846793005ULL + 1442695040888963407ULL;
        double number;
        std::memcpy(&number, &state, sizeof(number));
        if (!std::isfinite(number)) continue;
        char text[64];
        std::snprintf(text, sizeof(text), "%.17g", number);
        compare(text);
    }
}

TEST_CASE("JSON number grammar remains strict") {
    for (const char* text : {"+1", "01", "-01", "00", "-", ".1", "1.", "1e",
            "1e+", "1e-", "1e2.3", "1 2", "1,5", "0x10", "nan", "NaN", "inf",
            "Infinity", "-Infinity", "[1e]", "[01]", "{\"n\":1.}"}) {
        CAPTURE(text);
        ssc::JsonValue value;
        CHECK_FALSE(ssc::parseJson(text, value));
    }
    ssc::JsonValue value;
    REQUIRE(ssc::parseJson(" {\"n\": [-0, 1.25, -2E+3, 4e-2]} \r\n", value));
    const auto* numbers = value.get("n");
    REQUIRE(numbers != nullptr);
    REQUIRE(numbers->array.size() == 4);
    CHECK(std::signbit(numbers->array[0].number));
    CHECK(numbers->array[1].number == 1.25);
    CHECK(numbers->array[2].number == -2000);
    CHECK(numbers->array[3].number == 0.04);
}

#if defined(_MSVC_LANG) && _MSVC_LANG >= 201703L
TEST_CASE("native JSON number parsing is independent of the host locale") {
    struct RestoreLocale {
        std::string original = std::setlocale(LC_NUMERIC, nullptr);
        ~RestoreLocale() { std::setlocale(LC_NUMERIC, original.c_str()); }
    } restore;
    REQUIRE(std::setlocale(LC_NUMERIC, "German_Germany.1252") != nullptr);
    REQUIRE(std::string(std::localeconv()->decimal_point) == ",");
    ssc::JsonValue value;
    REQUIRE(ssc::parseJson("12.5", value));
    CHECK(value.number == 12.5);
    REQUIRE(ssc::parseJson("1.25e2", value));
    CHECK(value.number == 125);
    CHECK_FALSE(ssc::parseJson("12,5", value));
    CHECK(std::string(std::localeconv()->decimal_point) == ",");
}
#endif
