#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include "../../shared/blur_math.h"

TEST_CASE("the working sigma reproduces a source-pixel blur at the working size") {
    CHECK(ssc::workingBlurSigma(24, 240, 240, 240) == doctest::Approx(24));
    CHECK(ssc::workingBlurSigma(24, 1200, 1200, 240) == doctest::Approx(4.8));
    CHECK(ssc::workingBlurSigma(24, 3000, 3000, 240) == doctest::Approx(1.92));
    CHECK(ssc::workingBlurSigma(24, 0, 100, 240) == doctest::Approx(24));
}

TEST_CASE("box downscale averages every source pixel exactly once") {
    std::vector<std::uint8_t> pixels(size_t(4) * 4 * 4);
    for (unsigned y = 0; y < 4; ++y) for (unsigned x = 0; x < 4; ++x)
        for (int c = 0; c < 4; ++c) pixels[(y * 4 + x) * 4 + c] = std::uint8_t((x < 2 ? 10 : 50) + (y < 2 ? 0 : 100) + c);
    const auto out = ssc::boxDownscale4(pixels.data(), 4, 4, 2);
    REQUIRE(out.size() == 2 * 2 * 4);
    CHECK(out[0] == 10);  CHECK(out[3] == 13);
    CHECK(out[4] == 50);  CHECK(out[8] == 110); CHECK(out[12] == 150);
}

TEST_CASE("box downscale handles uneven ratios and a uniform image stays uniform") {
    std::vector<std::uint8_t> pixels(size_t(1000) * 777 * 4, 77);
    const auto out = ssc::boxDownscale4(pixels.data(), 1000, 777, 240);
    REQUIRE(out.size() == size_t(240) * 240 * 4);
    for (auto value : out) CHECK(value == 77);
}

TEST_CASE("box downscale refuses to upscale") {
    std::vector<std::uint8_t> pixels(size_t(100) * 100 * 4, 1);
    const auto out = ssc::boxDownscale4(pixels.data(), 100, 100, 240);
    CHECK(out.size() == size_t(240) * 240 * 4);
    CHECK(out[0] == 0);
}
