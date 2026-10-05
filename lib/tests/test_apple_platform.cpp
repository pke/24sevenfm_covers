#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include "../http_client.h"
#include "../image_probe.h"
#include "rating_fixture.h"

TEST_CASE("cancelled requests return without connecting") {
    std::atomic<bool> cancel{true};
    const auto response = ssc::httpRequest("example.invalid", 443, "/", "GET", "", "", 30, &cancel);
    CHECK(response.status == 0);
    CHECK(response.error == "Cancelled");
    CHECK(response.body.empty());
}

TEST_CASE("invalid destinations are rejected before connecting") {
    CHECK_FALSE(ssc::httpRequest("example.invalid", 22, "/", "GET").ok());
    CHECK_FALSE(ssc::httpRequest("", 443, "/", "GET").ok());
    CHECK_FALSE(ssc::httpRequest("example.invalid", 443, "relative", "GET").ok());
    const auto response = ssc::httpRequest("example.invalid@localhost", 443, "/", "GET");
    CHECK(response.error == "Invalid HTTP URL");
}

TEST_CASE("ImageIO decodes a real PNG and rejects truncated or oversized data") {
    const auto png = ratingFixturePng();
    REQUIRE_FALSE(png.empty());
    CHECK(ssc::decodableImage(png));
    CHECK_FALSE(ssc::decodableImage(png.substr(0, 24)));
    CHECK_FALSE(ssc::decodableImage("not an image"));
    CHECK_FALSE(ssc::decodableImage(std::string(16u * 1024u * 1024u + 1u, 'x')));
}
