#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include "d2d_renderer.h"
#include "rating_assets.h"
#include "rating_fixture.h"
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
    void paint(HWND hwnd, float progress = 1.0f, float ratingProgress = 1.0f) {
        d2d::render(hwnd, 1, d2d::Transition::Crossfade, 90, 1.0f / 16, false,
            nullptr, 1, L"Benchmark album", L"Artist", progress, true,
            ratingProgress, 1, 1, L"Benchmark album", L"Track (1:30)", 0);
        CHECK(d2d::backdropReady());
        CHECK(d2d::rendererDiagnostics().failedFrames == 0);
    }
};

// Deterministic compressed artwork; fixture construction is outside all timings.
std::string artwork(UINT width, UINT height, unsigned seed = 0, bool alpha = false, bool tail = false) {
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
        if (alpha && tail) pixels[at + 3] = x >= 20 && x < 220 && y >= 10 && y < 70
            && (x < 180 || (y >= 38 && y < 42)) ? 255 : 0;
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

TEST_CASE("backdrop cycling keeps the blurred default without drawing a hidden cover in either layout") {
    RendererFixture fixture;
    const auto cover = artwork(300, 300);
    d2d::setCover(cover.data(), cover.size(), false);
    for (int layout : {0, 1}) for (bool hidden : {true, false}) {
        d2d::setBackdropLoading(hidden);
        d2d::setBackdropNavigationOpacity(.5f);
        d2d::resetRendererDiagnostics();
        d2d::render(fixture.portrait, 1, d2d::Transition::Crossfade, -1, .08f, false,
            nullptr, layout, L"Album", L"Artist");
        CHECK(d2d::rendererDiagnostics().failedFrames == 0);
        CHECK((d2d::rendererDiagnostics().coverDraws == 0) == hidden);
    }
    // Arrow geometry uses the same DPI scale for drawing and pointer hit tests.
    CHECK(d2d::backdropNavigationHitTest(fixture.portrait, 0, 0) == 0);
    CHECK(d2d::backdropNavigationHitTest(fixture.portrait, 300, 450) == 0);
}

TEST_CASE("coming next and fanart hints render together in both layouts") {
    RendererFixture fixture;
    const std::string cover = artwork(300, 300);
    d2d::setCover(cover.data(), cover.size(), false);
    ssc::ComingNextFrame next;
    next.cover = std::make_shared<const std::string>(cover);
    next.coverOpacity = 1;
    next.album = std::wstring(200, L'W') + L" \u00c4\u00d6\u00dc";
    for (HWND window : {fixture.portrait, fixture.landscape}) {
        RECT client{};
        REQUIRE(GetClientRect(window, &client));
        d2d::resetTarget();
        for (int layout : {0, 1}) for (int seconds : {-1, 9}) for (float opacity : {0.0f, .5f, 1.0f}) {
            next.opacity = opacity;
            next.artist = seconds < 0 ? L"" : L"Composer";
            d2d::render(window, 1, d2d::Transition::Crossfade, seconds, .08f, false,
                nullptr, layout, L"Current album", L"Current artist", 1, true, 1, 1, 1,
                L"Current album", L"Cue", 0, &next, opacity);
            CHECK(d2d::rendererDiagnostics().failedFrames == 0);
            CHECK(d2d::fanartHintHitTest(window, 25, 25) == (opacity > 0));
            CHECK_FALSE(d2d::fanartHintHitTest(window, 0, 0));
            CHECK_FALSE(d2d::fanartHintHitTest(window, client.right - 1, client.bottom - 1));
            CHECK_FALSE(d2d::fanartHintHitTest(window == fixture.portrait ? fixture.landscape : fixture.portrait, 25, 25));
            if (opacity == .5f) {
                // A half-entered card extends beyond the stage, rather than
                // fading in at its resting position. Both edges move together.
                CHECK(d2d::rendererDiagnostics().comingNextRight > client.right);
                CHECK(d2d::rendererDiagnostics().comingNextLeft < client.right);
            } else if (opacity == 1.0f) {
                CHECK(d2d::rendererDiagnostics().comingNextRight < client.right);
                CHECK(d2d::rendererDiagnostics().comingNextLeft >= 0);
            }
        }
        d2d::resetTarget();
        CHECK_FALSE(d2d::fanartHintHitTest(window, 25, 25));
    }
}

TEST_CASE("coming next only trims text after growing to half of the window") {
    RendererFixture fixture;
    const auto cover = std::make_shared<const std::string>(artwork(300, 300));
    ssc::ComingNextFrame next; next.opacity = next.coverOpacity = 1;
    for (HWND window : {fixture.portrait, fixture.landscape}) {
        RECT client{}; REQUIRE(GetClientRect(window, &client));
        for (bool rtl : {false, true}) for (bool preview : {false, true}) {
            SetWindowLongPtrW(window, GWL_EXSTYLE, rtl ? WS_EX_LAYOUTRTL : 0);
            d2d::resetTarget();
            next.cover = preview ? cover : nullptr;
            for (const auto& album : {L"Super 8", L"Die Hard 2: Die Harder", L"Star Trek: First Contact", L"\u00c5ngstr\u00f6m: gjpqy"}) {
                next.album = album; next.artist = L"John Williams";
                d2d::render(window, 1, d2d::Transition::Crossfade, 9, .08f, false,
                    nullptr, 1, L"Current album", L"Current artist", 1, true, 1, 1, 1,
                    L"Current album", L"Cue", 0, &next);
                const auto stats = d2d::rendererDiagnostics();
                CHECK(stats.failedFrames == 0);
                CHECK(stats.comingNextTrimmedLines == 0);
                CHECK(stats.comingNextTextWidth >= stats.comingNextNaturalTextWidth);
                CHECK(stats.comingNextRight - stats.comingNextLeft < client.right * .5f);
            }
            next.album = std::wstring(200, L'W');
            d2d::render(window, 1, d2d::Transition::Crossfade, 9, .08f, false,
                nullptr, 1, L"Current album", L"Current artist", 1, true, 1, 1, 1,
                L"Current album", L"Cue", 0, &next);
            const auto stats = d2d::rendererDiagnostics();
            CHECK(stats.comingNextTrimmedLines > 0);
            CHECK(stats.comingNextRight - stats.comingNextLeft == doctest::Approx(client.right * .5f));
        }
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
    badge.png = ratingFixturePng(); REQUIRE_FALSE(badge.png.empty());
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

TEST_CASE("rating images replace fallback text only during their incoming fade") {
    RendererFixture fixture;
    const auto cover = artwork(300, 300);
    d2d::setCover(cover.data(), cover.size(), false);
    d2d::setBackdrop(cover.data(), cover.size(), false);
    d2d::RatingBadge badge; badge.country = L"DE"; badge.system = L"FSK"; badge.rating = L"12";
    d2d::setRatings({badge}, false);
    fixture.paint(fixture.portrait);
    badge.png = ratingFixturePng(); REQUIRE_FALSE(badge.png.empty());
    d2d::setRatings({badge}, true);
    d2d::resetRendererDiagnostics();
    fixture.paint(fixture.portrait, 1, 0);
    CHECK(d2d::rendererDiagnostics().decodes == 0); // outgoing text remains visible
    fixture.paint(fixture.portrait, 1, .5f);
    CHECK(d2d::rendererDiagnostics().decodes == 1);
    fixture.paint(fixture.portrait, 1, 1);
    CHECK(d2d::rendererDiagnostics().decodes == 1);
    d2d::endMediaFade();
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

TEST_CASE("native logo alignment survives cached decoding and target recreation") {
    RendererFixture fixture;
    const auto cover = artwork(200, 200);
    d2d::setCover(cover.data(), cover.size(), false);
    const auto logo = artwork(240, 80, 0, true, true);
    d2d::setTitleLogo(logo, L"Benchmark album", 0);
    fixture.paint(fixture.portrait);
    CHECK(d2d::rendererDiagnostics().logoHorizontalAnchor == doctest::Approx(.4f));
    d2d::resetTarget();
    fixture.paint(fixture.landscape);
    CHECK(d2d::rendererDiagnostics().logoHorizontalAnchor == doctest::Approx(.4f));
    d2d::setTitleLogo(artwork(100, 80, 0, true), L"Benchmark album", 0);
    fixture.paint(fixture.portrait);
    CHECK(d2d::rendererDiagnostics().logoHorizontalAnchor == .5f);
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

TEST_CASE("presentation frames share artwork uploads with legacy readiness state") {
    RendererFixture fixture;
    const auto cover = std::make_shared<const std::string>(artwork(1200, 1200));
    const auto hero = std::make_shared<const std::string>(artwork(3840, 2160, 1));
    const auto nextHero = std::make_shared<const std::string>(artwork(2160, 3840, 2));
    d2d::setCover(cover->data(), cover->size(), false);
    d2d::setBackdrop(hero->data(), hero->size(), false);
    ssc::FrameState frame;
    frame.cover = {{cover, 1, 1, 1}};
    frame.backdrop = {{hero, 1, 1, 1}};
    frame.coverOpacity = 1;
    frame.coverRect = {20, 20, 200, 200};
    const auto paint = [&] {
        d2d::render(fixture.portrait, 1, d2d::Transition::Crossfade, -1, .08f,
            false, nullptr, 1, L"Album", L"Artist", 1, false, 1, 1, 1,
            L"Album", L"Track", 0, nullptr, 0, &frame);
        CHECK(d2d::backdropReady());
        CHECK(d2d::rendererDiagnostics().failedFrames == 0);
    };
    paint();
    auto stats = d2d::rendererDiagnostics();
    std::printf("FRAME_ARTWORK initial: count=%zu bytes=%zu\n", stats.artworkBitmapCount, stats.artworkBitmapBytes);
    CHECK(stats.artworkBitmapCount == 2);
    CHECK(stats.artworkBitmapBytes == (size_t(1200) * 1200 + size_t(3840) * 2160) * 4);
    // A repeated publication must reuse the same allocation, including after
    // switching to an outgoing/incoming mixture and recreating the render target.
    d2d::setCover(cover->data(), cover->size(), false);
    d2d::setBackdrop(hero->data(), hero->size(), false);
    paint();
    CHECK(d2d::rendererDiagnostics().artworkBitmapCount == 2);
    d2d::setBackdrop(nextHero->data(), nextHero->size(), true);
    frame.backdrop = {{hero, 1, 1, 1}, {nextHero, .5f, 1, 1}};
    paint();
    CHECK(d2d::rendererDiagnostics().artworkBitmapCount == 3);
    d2d::resetTarget();
    paint();
    CHECK(d2d::rendererDiagnostics().artworkBitmapCount == 3);
    d2d::endMediaFade();
    frame.backdrop = {{nextHero, 1, 1, 1}};
    paint();
    CHECK(d2d::rendererDiagnostics().artworkBitmapCount == 2);
    d2d::shutdown();
    CHECK(d2d::rendererDiagnostics().artworkBitmapCount == 0);
}
