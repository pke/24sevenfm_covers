#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"

#include "rating_assets.h"
#include "image_probe.h"

#include <cstring>

TEST_CASE("every accepted native certification has a bundled PNG logo") {
    const char* entries[][3] = {
        {"DE", "FSK", "0"}, {"DE", "FSK", "6"}, {"DE", "FSK", "12"},
        {"DE", "FSK", "16"}, {"DE", "FSK", "18"},
        {"US", "MPA", "G"}, {"US", "MPA", "PG"}, {"US", "MPA", "PG-13"},
        {"US", "MPA", "R"}, {"US", "MPA", "NC-17"},
        {"US", "TV Parental Guidelines", "TV-Y"},
        {"US", "TV Parental Guidelines", "TV-Y7"},
        {"US", "TV Parental Guidelines", "TV-Y7-FV"},
        {"US", "TV Parental Guidelines", "TV-G"},
        {"US", "TV Parental Guidelines", "TV-PG"},
        {"US", "TV Parental Guidelines", "TV-14"},
        {"US", "TV Parental Guidelines", "TV-MA"},
    };
    const unsigned char signature[] = {0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a};
    for (size_t i = 0; i < sizeof(entries) / sizeof(entries[0]); ++i) {
        const void* data = nullptr; size_t size = 0;
        INFO(entries[i][2]);
        REQUIRE(ssc::ratingAssetPng(entries[i][0], entries[i][1], entries[i][2], data, size));
        REQUIRE(data != nullptr);
        REQUIRE(size > sizeof(signature));
        CHECK(std::memcmp(data, signature, sizeof(signature)) == 0);
        CHECK(ssc::decodableImage(std::string(static_cast<const char*>(data), size)));
    }
}

TEST_CASE("image probe rejects a corrupt provider response") {
    CHECK_FALSE(ssc::decodableImage("not an image"));
}

TEST_CASE("unknown rating cannot select an arbitrary bundled asset") {
    const void* data = reinterpret_cast<const void*>(1); size_t size = 99;
    CHECK_FALSE(ssc::ratingAssetPng("US", "MPA", "UNRATED", data, size));
    CHECK(data == nullptr);
    CHECK(size == 0);
}
