#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include "d2d_renderer.h"
#include "rating_assets.h"
#include <wincodec.h>
#include <wrl/client.h>
#include <chrono>
#include <cstdio>
#include <cstdlib>

using Microsoft::WRL::ComPtr;

namespace {
struct RendererFixture {
    HWND portrait = nullptr, landscape = nullptr;
    RendererFixture() {
        REQUIRE(d2d::init());
        portrait = CreateWindowExW(0, L"STATIC", L"Renderer portrait test", WS_POPUP,
            0, 0, 600, 900, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
        landscape = CreateWindowExW(0, L"STATIC", L"Renderer landscape test", WS_POPUP,
            0, 0, 3840, 2160, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
        REQUIRE(portrait != nullptr);
        REQUIRE(landscape != nullptr);
        d2d::setPosterBlur(24);
        d2d::resetRendererDiagnostics();
    }
    ~RendererFixture() {
        d2d::shutdown();
        DestroyWindow(portrait);
        DestroyWindow(landscape);
    }
    void paint(HWND hwnd, float progress = 1.0f) {
        d2d::render(hwnd, 1, d2d::Transition::Crossfade, 90, 1.0f / 16, false,
            nullptr, 1, L"Benchmark album", L"Artist", progress, true,
            1, 1, 1, L"Benchmark album", L"Track (1:30)", 0);
        CHECK(d2d::backdropReady());
        CHECK(d2d::rendererDiagnostics().failedFrames == 0);
    }
};

// Deterministic compressed artwork; fixture construction is outside all timings.
std::string artwork(UINT width, UINT height, unsigned seed = 0, bool alpha = false) {
    ComPtr<IWICImagingFactory> factory;
    REQUIRE(SUCCEEDED(CoCreateInstance(CLSID_WICImagingFactory, nullptr,
        CLSCTX_INPROC_SERVER, IID_PPV_ARGS(factory.GetAddressOf()))));
    ComPtr<IStream> stream;
    REQUIRE(SUCCEEDED(CreateStreamOnHGlobal(nullptr, TRUE, &stream)));
    ComPtr<IWICBitmapEncoder> encoder;
    REQUIRE(SUCCEEDED(factory->CreateEncoder(alpha ? GUID_ContainerFormatPng
        : GUID_ContainerFormatJpeg, nullptr, &encoder)));
    REQUIRE(SUCCEEDED(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache)));
    ComPtr<IWICBitmapFrameEncode> frame;
    REQUIRE(SUCCEEDED(encoder->CreateNewFrame(&frame, nullptr)));
    REQUIRE(SUCCEEDED(frame->Initialize(nullptr)));
    REQUIRE(SUCCEEDED(frame->SetSize(width, height)));
    WICPixelFormatGUID format = alpha ? GUID_WICPixelFormat32bppBGRA : GUID_WICPixelFormat24bppBGR;
    REQUIRE(SUCCEEDED(frame->SetPixelFormat(&format)));
    REQUIRE(IsEqualGUID(format, alpha ? GUID_WICPixelFormat32bppBGRA : GUID_WICPixelFormat24bppBGR));
    const UINT stride = width * (alpha ? 4 : 3);
    std::vector<BYTE> pixels(static_cast<size_t>(stride) * height);
    for (UINT y = 0; y < height; ++y) for (UINT x = 0; x < width; ++x) {
        const size_t at = static_cast<size_t>(y) * stride + x * (alpha ? 4 : 3);
        pixels[at] = static_cast<BYTE>((x / 9 + y / 13 + seed * 41) % 256);
        pixels[at + 1] = static_cast<BYTE>((x / 5 + seed * 23) % 256);
        pixels[at + 2] = static_cast<BYTE>((y / 7 + seed * 17) % 256);
        if (alpha) pixels[at + 3] = x > width / 4 && x < width * 3 / 4
            && y > height / 4 && y < height * 3 / 4 ? 192 : 0;
    }
    REQUIRE(SUCCEEDED(frame->WritePixels(height, stride, static_cast<UINT>(pixels.size()), pixels.data())));
    REQUIRE(SUCCEEDED(frame->Commit()));
    REQUIRE(SUCCEEDED(encoder->Commit()));
    STATSTG stat = {};
    REQUIRE(SUCCEEDED(stream->Stat(&stat, STATFLAG_NONAME)));
    std::string bytes(static_cast<size_t>(stat.cbSize.QuadPart), '\0');
    LARGE_INTEGER start = {};
    REQUIRE(SUCCEEDED(stream->Seek(start, STREAM_SEEK_SET, nullptr)));
    ULONG read = 0;
    REQUIRE(SUCCEEDED(stream->Read(&bytes[0], static_cast<ULONG>(bytes.size()), &read)));
    REQUIRE(read == bytes.size());
    return bytes;
}
}

TEST_CASE("native renderer prepares cached artwork across repeated window handoffs") {
    RendererFixture fixture;
    const std::string cover = artwork(1200, 1200);
    const std::string portrait = artwork(2160, 3840, 1);
    const std::string landscape = artwork(3840, 2160, 2);
    const std::string logo = artwork(800, 400, 3, true);
    d2d::setCover(cover.data(), cover.size(), false);
    d2d::setTitleLogo(logo, L"Benchmark album", 0);
    d2d::RatingBadge badge; badge.country = L"DE"; badge.system = L"FSK"; badge.rating = L"12";
    d2d::setRatings(std::vector<d2d::RatingBadge>(1, badge), false);

    // Warm both variants, including the outgoing surface of the crossfade.
    for (int i = 0; i < 3; ++i) {
        const std::string& bytes = i % 2 ? landscape : portrait;
        d2d::resetTarget();
        d2d::setBackdrop(bytes.data(), bytes.size(), true);
        fixture.paint(i % 2 ? fixture.landscape : fixture.portrait);
        d2d::endMediaFade();
    }
    d2d::resetRendererDiagnostics();
    const auto begin = std::chrono::steady_clock::now();
    for (int i = 0; i < 8; ++i) {
        const std::string& bytes = i % 2 ? portrait : landscape;
        d2d::resetTarget();
        d2d::setBackdrop(bytes.data(), bytes.size(), true);
        fixture.paint(i % 2 ? fixture.portrait : fixture.landscape, 0);
        d2d::endMediaFade();
    }
    const double elapsed = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - begin).count();
    const auto stats = d2d::rendererDiagnostics();
    CHECK(stats.frames == 8);
    CHECK(stats.decodes == 0);
    CHECK(stats.blurGenerations == 0);
    CHECK(stats.cacheHits > 0);
    CHECK(stats.blurBytes == 240 * 240 * 4);
    if (std::getenv("SSC_RENDER_BENCHMARK"))
        std::printf("HANDOFF average ms: total=%.2f frame=%.2f target=%.2f images=%.2f blur=%.2f; decodes=%zu blurs=%zu hits=%zu bytes=%zu\n",
            elapsed / 8, stats.frameMs / 8, stats.targetMs / 8, stats.imageMs / 8,
            stats.blurMs / 8, stats.decodes, stats.blurGenerations, stats.cacheHits, stats.cacheBytes);
}

TEST_CASE("native renderer reuses blur after target and device release but invalidates changed inputs") {
    RendererFixture fixture;
    const std::string cover = artwork(300, 300);
    const std::string other = artwork(300, 300, 1);
    d2d::setCover(cover.data(), cover.size(), false);
    fixture.paint(fixture.portrait);
    REQUIRE(d2d::rendererDiagnostics().blurGenerations == 1);
    d2d::resetRendererDiagnostics();
    d2d::resetTarget();
    d2d::releaseBlur(); // hide/show must not recreate the blur device just for upload
    d2d::setCover(cover.data(), cover.size(), true);
    fixture.paint(fixture.landscape, .5f);
    CHECK(d2d::rendererDiagnostics().decodes == 0);
    CHECK(d2d::rendererDiagnostics().blurGenerations == 0);

    d2d::setPosterBlur(25);
    fixture.paint(fixture.landscape);
    CHECK(d2d::rendererDiagnostics().decodes == 0);
    CHECK(d2d::rendererDiagnostics().blurGenerations == 1);
    d2d::setPosterBlur(25);
    fixture.paint(fixture.landscape);
    CHECK(d2d::rendererDiagnostics().blurGenerations == 1);

    d2d::setCover(other.data(), other.size(), true);
    fixture.paint(fixture.landscape);
    CHECK(d2d::rendererDiagnostics().decodes == 1);
    CHECK(d2d::rendererDiagnostics().blurGenerations == 2);
    d2d::shutdown();
    CHECK(d2d::rendererDiagnostics().cacheBytes == 0);
    CHECK(d2d::rendererDiagnostics().cacheEntries == 0);
    CHECK(d2d::rendererDiagnostics().blurBytes == 0);
    REQUIRE(d2d::init());
    d2d::setCover(cover.data(), cover.size(), false);
    fixture.paint(fixture.portrait);
    CHECK(d2d::rendererDiagnostics().decodes == 2);
    CHECK(d2d::rendererDiagnostics().blurGenerations == 3);
}

TEST_CASE("native decoded cache distinguishes cropped logos and preserves alpha pixels") {
    RendererFixture fixture;
    const std::string png = artwork(100, 80, 0, true);
    d2d::setCover(png.data(), png.size(), false);
    d2d::setTitleLogo(png, L"Benchmark album", 0);
    fixture.paint(fixture.portrait);
    auto stats = d2d::rendererDiagnostics();
    CHECK(stats.decodes == 2);
    CHECK(stats.cacheEntries == 2);
    // Original 100x80 cover plus only the 49x39 nontransparent logo rectangle.
    CHECK(stats.cacheBytes == 2 * png.size() + (100 * 80 + 49 * 39) * 4);
    d2d::resetRendererDiagnostics();
    d2d::resetTarget();
    fixture.paint(fixture.landscape);
    CHECK(d2d::rendererDiagnostics().decodes == 0);
    CHECK(d2d::rendererDiagnostics().cacheEntries == 2);
}

TEST_CASE("native decoded cache bounds both memory and retained image count") {
    RendererFixture fixture;
    SUBCASE("small images use least recently used eviction") {
        const std::string first = artwork(16, 16, 0);
        const std::string second = artwork(16, 16, 1);
        for (unsigned i = 0; i < 16; ++i) {
            const std::string bytes = artwork(16, 16, i);
            d2d::setBackdrop(bytes.data(), bytes.size(), false);
            fixture.paint(fixture.portrait);
        }
        CHECK(d2d::rendererDiagnostics().cacheEntries == 16);
        d2d::setBackdrop(first.data(), first.size(), false); // refresh oldest entry
        fixture.paint(fixture.portrait);
        const std::string extra = artwork(16, 16, 16);
        d2d::setBackdrop(extra.data(), extra.size(), false);
        fixture.paint(fixture.portrait);
        CHECK(d2d::rendererDiagnostics().cacheEntries == 16);
        CHECK(d2d::rendererDiagnostics().cacheEvictions == 1);
        d2d::resetRendererDiagnostics();
        d2d::setBackdrop(first.data(), first.size(), false);
        fixture.paint(fixture.portrait);
        CHECK(d2d::rendererDiagnostics().decodes == 0);
        d2d::setBackdrop(second.data(), second.size(), false); // evicted entry decodes again
        fixture.paint(fixture.portrait);
        CHECK(d2d::rendererDiagnostics().decodes == 1);
    }
    SUBCASE("large images obey byte budget before reaching entry limit") {
        for (unsigned i = 0; i < 3; ++i) {
            const std::string bytes = artwork(4096, 4096, i);
            d2d::setBackdrop(bytes.data(), bytes.size(), false);
            fixture.paint(fixture.portrait);
            CHECK(d2d::rendererDiagnostics().cacheBytes <= 128 * 1024 * 1024);
        }
        CHECK(d2d::rendererDiagnostics().cacheEvictions == 2);
        CHECK(d2d::rendererDiagnostics().cacheEntries == 1);
    }
}

TEST_CASE("native decoded cache never admits malformed or oversized images") {
    RendererFixture fixture;
    std::string bytes;
    SUBCASE("invalid encoded bytes") { bytes = "not an image"; }
    SUBCASE("WIC-valid oversized header") { bytes = artwork(4097, 1); }
    d2d::setBackdrop(bytes.data(), bytes.size(), false);
    d2d::render(fixture.portrait, 1, d2d::Transition::Crossfade, -1, 1.0f / 16,
        false, nullptr, 0, nullptr, nullptr);
    CHECK_FALSE(d2d::backdropReady());
    CHECK(d2d::rendererDiagnostics().cacheEntries == 0);
    CHECK(d2d::rendererDiagnostics().cacheBytes == 0);
}
