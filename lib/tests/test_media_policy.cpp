#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"

#include "media_policy.h"
#include "../../shared/queue_prefetch.h"
#include "../../shared/presentation_style.h"
#include <map>

TEST_CASE("coming next reserves full text before applying its half-window limit") {
    for (float stage : {320.0f, 640.0f, 1280.0f})
        for (float dpi : {1.0f, 1.5f, 2.0f})
            for (float natural : {48.25f, 160.5f, 1500.0f})
                for (float cover : {0.0f, 1.0f}) {
                    const auto font = ssc::nextTypography(stage, dpi);
                    const auto card = ssc::nextCardSize(stage, font, natural, 40 * dpi, cover, dpi);
                    CHECK(card.width <= stage * .5f);
                    CHECK(card.height >= 40 * dpi + font.padY * 2);
                    const float extra = font.padX * 2 + (font.cover + font.gap) * cover;
                    if (natural + 3 * dpi + extra <= stage * .5f) {
                        CHECK(card.textWidth > natural);
                        CHECK(card.width < stage * .5f);
                    } else if (natural + extra > stage * .5f) {
                        CHECK(card.width == doctest::Approx(stage * .5f));
                        CHECK(card.textWidth < natural);
                    }
                }
}

TEST_CASE("native queue planning carries options and bounds staggered prefetch") {
    std::vector<ssc::TrackInfo> queue(70);
    for (auto& track : queue) { track.album = "Album"; track.artist = "Composer"; track.track = "Cue"; }
    queue[1].stationIdent = true;
    ssc::MediaRequest options; options.includeTitleLogo = true; options.providers = "tmdb,fanart";
    const auto plan = ssc::planQueueMedia(queue, options);
    REQUIRE(plan.size() == ssc::kQueuedTrackStoreLimit - 1);
    CHECK(plan.front().delayMs == 0);
    CHECK(plan[1].delayMs == ssc::queuePrefetchDelayMs(2));
    CHECK(plan.front().request.album == "Album");
    CHECK(plan.front().request.includeTitleLogo);
    CHECK(plan.front().request.providers == options.providers);
    CHECK(plan.front().key == ssc::mediaCacheKey(queue.front(), plan.front().request));
}
TEST_CASE("native cache eviction keeps recently used prepared tracks") {
    struct Entry { unsigned used; };
    std::map<int, Entry> cache;
    cache[1].used = 4; cache[2].used = 2; cache[3].used = 3;
    ssc::trimMediaCache(cache, 2);
    CHECK(cache.size() == 2); CHECK(cache.count(1) == 1); CHECK(cache.count(2) == 0);
    ssc::trimMediaCache(cache, 0); CHECK(cache.empty());
}
#include "../../shared/image_limits.h"
#include "../../shared/image_alpha_bounds.h"
#include "../../shared/title_logo_presentation.h"
TEST_CASE("title logo crop excludes transparent padding with shared alpha threshold") {
    std::vector<unsigned char> pixels(10 * 8 * 4);
    pixels[3] = 15;
    pixels[(2 * 10 + 3) * 4 + 3] = 16;
    pixels[(5 * 10 + 8) * 4 + 3] = 255;
    auto bounds = ssc::visibleAlphaBounds(pixels.data(), 10, 8, 40);
    CHECK(bounds.left == 3); CHECK(bounds.top == 2); CHECK(bounds.right == 9); CHECK(bounds.bottom == 6);
    std::fill(pixels.begin(), pixels.end(), 0);
    bounds = ssc::visibleAlphaBounds(pixels.data(), 10, 8, 40);
    CHECK(bounds.right <= bounds.left); CHECK(bounds.bottom <= bounds.top);
}

TEST_CASE("title logos preserve aspect bounds and clear the composer") {
    for (const float width : {390.0f, 1280.0f}) {
        const auto logo = ssc::titleLogoSize(704, 290, width, 844, 24, 1);
        CHECK(logo.width / logo.height == doctest::Approx(704.0f / 290));
        const auto font = ssc::posterTypography(width, 844);
        CHECK(font.padY + logo.rowHeight + font.lineGap > logo.height * .5f);
        CHECK(logo.width <= width * .72f);
        CHECK(logo.height <= 844 * .24f);
    }
    const auto tall = ssc::titleLogoSize(120, 280, 390, 844, 24, 1);
    CHECK(tall.height > tall.width);
    const auto font = ssc::posterTypography(390, 844);
    CHECK(font.padY + tall.rowHeight + font.lineGap > tall.height * .5f);
    const auto wide = ssc::titleLogoSize(1600, 80, 390, 844, 24, 1);
    CHECK(wide.width <= 390 * .72f);
    CHECK(wide.width / wide.height == doctest::Approx(20));
}

TEST_CASE("title lettering is centred without clipping an asymmetric decorative tail") {
    for (bool mirror : {false, true}) for (unsigned scale : {1u, 2u}) {
        const unsigned width = 240 * scale, height = 80 * scale, stride = width * 4 + 16;
        std::vector<unsigned char> pixels(stride * height, 0);
        for (unsigned y = 10 * scale; y < 70 * scale; ++y)
            for (unsigned x = 20 * scale; x < 220 * scale; ++x) {
                if (x >= 180 * scale && (y < 38 * scale || y >= 42 * scale)) continue;
                const auto column = mirror ? width - x - 1 : x;
                pixels[y * stride + column * 4 + 3] = 255;
            }
        const auto bounds = ssc::visibleAlphaBounds(pixels.data(), width, height, stride);
        const auto anchor = ssc::titleLogoHorizontalAnchor(pixels.data(), width, height, stride, bounds);
        CHECK(anchor == doctest::Approx(mirror ? .6f : .4f));
        const ssc::TitleLogoSize size{200, 60, 40};
        const auto rect = ssc::titleLogoRect(340, 500, size, anchor);
        // The main 160px title, not the 40px flare, is centred on the panel.
        const float letteringCentre = mirror ? 120 : 80;
        CHECK(rect.left + letteringCentre == doctest::Approx(340));
        CHECK(rect.right - rect.left == 200); // complete artwork retained, no rescaling
        CHECK(rect.top == 470); CHECK(rect.bottom == 530);
        CHECK(bounds.right - bounds.left == 200 * scale);
    }
}

TEST_CASE("balanced and uniformly thin logos retain ordinary geometric centring") {
    for (unsigned thickness : {2u, 50u}) {
        std::vector<unsigned char> pixels(200 * 60 * 4, 0);
        for (unsigned y = 0; y < thickness; ++y)
            for (unsigned x = 10; x < 190; ++x) pixels[(y * 200 + x) * 4 + 3] = 255;
        pixels[3] = 15; // nearly transparent noise remains excluded
        const auto bounds = ssc::visibleAlphaBounds(pixels.data(), 200, 60, 800);
        CHECK(ssc::titleLogoHorizontalAnchor(pixels.data(), 200, 60, 800, bounds) == .5f);
    }
    CHECK(ssc::titleLogoHorizontalAnchor(nullptr, 0, 0, 0, {0,0,0,0}) == .5f);
}
TEST_CASE("title logo composer clearance is halved at every viewport and DPI") {
    for (const float dpi : {1.f, 1.5f, 2.f}) for (const float width : {320.f, 680.f, 1280.f})
        for (const auto pixels : {std::pair<float,float>{1600,80}, {704,290}, {120,280}}) {
            const auto font = ssc::posterTypography(width*dpi, 820*dpi);
            const auto logo = ssc::titleLogoSize(pixels.first,pixels.second,width*dpi,820*dpi,font.title,dpi);
            const float oldRow = std::max(logo.height*.5f,std::clamp(font.title*1.3f,40*dpi,72*dpi));
            const float oldGap = font.padY + oldRow + font.lineGap - logo.height*.5f;
            const float gap = font.padY + logo.rowHeight + font.lineGap - logo.height*.5f;
            CHECK(gap == doctest::Approx(oldGap*.5f));
            CHECK(gap > 0);
        }
}
TEST_CASE("title logos protrude halfway over the panel for every aspect ratio") {
    for (const auto dimensions : {std::pair<float, float>{1200, 160}, {700, 290}, {120, 280}}) {
        const auto size = ssc::titleLogoSize(dimensions.first, dimensions.second, 680, 760, 28, 1);
        const auto rect = ssc::titleLogoRect(340, 500, size);
        CHECK(500 - rect.top == doctest::Approx(size.height * .5f));
        CHECK(rect.bottom - 500 == doctest::Approx(size.height * .5f));
        CHECK((rect.left + rect.right) * .5f == doctest::Approx(340));
    }
}

TEST_CASE("title logo fades retain outgoing bytes and reverse rapid toggles without snapping") {
    ssc::TitleLogoPresentation logo;
    logo.set("first", L"Album", 100, 1000);
    CHECK(logo.advance(600, 1000) == doctest::Approx(.5));
    CHECK(logo.bytes() == "first");
    logo.set("", L"", 600, 1000);
    CHECK(logo.advance(1100, 1000) == doctest::Approx(.25));
    CHECK(logo.bytes() == "first");
    logo.set("first", L"Album", 1100, 1000);
    CHECK(logo.advance(1100, 1000) == doctest::Approx(.25));
    CHECK(logo.advance(2100, 1000) == 1);
    logo.set("second", L"Next", 2100, 1000);
    CHECK(logo.advance(2600, 1000) == doctest::Approx(.5));
    CHECK(logo.album() == L"Album");
    CHECK(logo.advance(3100, 1000) == 0);
    CHECK(logo.bytes() == "second");
    CHECK(logo.album() == L"Next");
    CHECK(logo.advance(3100, 0) == 1); // system reduced motion takes effect immediately
    logo.set("", L"", 3200, 0);
    CHECK(logo.bytes().empty());
    CHECK_FALSE(logo.animating());
}

TEST_CASE("native image limits accept UHD and DCI 4K backdrops") {
    CHECK(ssc::coverDimsOk(3840, 2160));
    CHECK(ssc::coverDimsOk(4096, 2160));
    CHECK(ssc::coverDimsOk(2160, 4096));
    CHECK_FALSE(ssc::coverDimsOk(4097, 2160));
    CHECK_FALSE(ssc::coverDimsOk(3840, 8192));
}

TEST_CASE("title logo layout waits for the fade then animates independently") {
    ssc::TitleLogoPresentation logo;
    ssc::TitleLogoLayout layout;
    logo.set("logo", L"Long album title", 100, 1000);
    const auto frame = [&](std::uint32_t now, int fadeMs = 1000) {
        return layout.advance(logo.advance(now, fadeMs) == 1, now, fadeMs);
    };
    CHECK(frame(100) == 0);
    CHECK(frame(600) == 0); // still-visible text keeps its original width and height
    CHECK_FALSE(layout.animating());
    CHECK(frame(1100) == 0); // fully opaque logo starts a separate geometry transition
    CHECK_FALSE(logo.animating());
    CHECK(layout.animating()); // the renderer must keep repainting after the fade
    CHECK(frame(1600) == doctest::Approx(.5));
    CHECK(frame(2100) == 1);
    CHECK_FALSE(layout.animating());

    logo.set("", L"", 2100, 1000);
    CHECK(frame(2200) == 1); // expand continuously when toggled back to text
    CHECK(frame(2700) == doctest::Approx(.5));
    logo.set("logo", L"Long album title", 2700, 1000);
    CHECK(frame(2700) == doctest::Approx(.5)); // no jump on a rapid reversal
    CHECK(frame(3200) == 0);
    CHECK(frame(3700) == 0);
    CHECK(frame(4200) == doctest::Approx(.5));
    CHECK(frame(4200, 0) == 1); // reduced motion also settles the geometry
    CHECK_FALSE(layout.animating());
    logo.set("", L"", 4300, 0);
    CHECK(frame(4300, 0) == 0);
    CHECK_FALSE(layout.animating());
}

TEST_CASE("native retry cadence is identical to the web player") {
    CHECK(ssc::coverRetryDelayMs(1) == 5000);
    CHECK(ssc::coverRetryDelayMs(2) == 10000);
    CHECK(ssc::coverRetryDelayMs(3) == 20000);
    CHECK(ssc::coverRetryDelayMs(4) == 300000);
    CHECK(ssc::coverRetryDelayMs(50) == 300000);

    CHECK(ssc::backdropImageRetryDelayMs(1) == 1000);
    CHECK(ssc::backdropImageRetryDelayMs(2) == 2000);
    CHECK(ssc::backdropImageRetryDelayMs(3) == -1);

    CHECK(ssc::stationRetryDelayMs(1) == 8000);
    CHECK(ssc::stationRetryDelayMs(2) == 16000);
    CHECK(ssc::stationRetryDelayMs(3) == 32000);
    CHECK(ssc::stationRetryDelayMs(4) == 60000);
    CHECK(ssc::stationRetryDelayMs(5) == 8000);
    CHECK(ssc::stationRetryDelayMs(6) == 16000);
    CHECK(ssc::stationRetryDelayMs(20) == 60000);
}

TEST_CASE("queue prefetch is immediate once then staggered one item per minute") {
    CHECK(ssc::kQueuedTrackStoreLimit == 64);
    CHECK(ssc::queuePrefetchDelayMs(0) == 0);
    CHECK(ssc::queuePrefetchDelayMs(1) == 60000);
    CHECK(ssc::queuePrefetchDelayMs(63) == 3780000);
}

TEST_CASE("media cache identity includes artist and all resolver-affecting options") {
    ssc::TrackInfo a;
    a.album = "Same album"; a.track = "Cue"; a.artist = "Composer A";
    ssc::MediaRequest request;
    const std::string base = ssc::mediaCacheKey(a, request);

    ssc::TrackInfo b = a; b.artist = "Composer B";
    CHECK(ssc::mediaCacheKey(b, request) != base);
    b = a; b.track = "Other cue";
    CHECK(ssc::mediaCacheKey(b, request) != base);

    ssc::MediaRequest changed = request; changed.width = 600; changed.height = 900;
    CHECK(ssc::mediaCacheKey(a, changed) != base);
    changed = request; changed.includeArt = false;
    CHECK(ssc::mediaCacheKey(a, changed) != base);
    changed = request; changed.includeRatings = false;
    CHECK(ssc::mediaCacheKey(a, changed) != base);
    changed = request; changed.providers = "tmdb,fanart";
    CHECK(ssc::mediaCacheKey(a, changed) != base);
    changed = request; changed.ratingCountries = "DE";
    CHECK(ssc::mediaCacheKey(a, changed) != base);
    changed = request; changed.fanartClientKey = "personal-key";
    CHECK(ssc::mediaCacheKey(a, changed) != base);
    changed.providers = "tmdb,tvmaze";
    CHECK(ssc::mediaCacheKey(a, changed) ==
          ssc::mediaCacheKey(a, [&] { ssc::MediaRequest r = changed;
              r.fanartClientKey.clear(); return r; }()));
}

TEST_CASE("artwork caches separate HD and 4K without fragmenting for every resized pixel") {
    ssc::TrackInfo track; track.album = "Interstellar";
    ssc::MediaRequest request; request.width = 1920; request.height = 1080;
    const auto hd = ssc::mediaCacheKey(track, request);
    CHECK_FALSE(ssc::wants4kArtwork(request));
    request.width = 2560; request.height = 1440;
    const auto uhd = ssc::mediaCacheKey(track, request);
    CHECK(ssc::wants4kArtwork(request)); CHECK(uhd != hd);
    request.width = 3840; request.height = 2160;
    CHECK(ssc::mediaCacheKey(track, request) == uhd);
    request.width = 4096;
    CHECK(ssc::mediaCacheKey(track, request) == uhd);
    request.includeArt = false;
    const auto metadata = ssc::mediaCacheKey(track, request);
    request.width = 800; request.height = 600;
    CHECK(ssc::mediaCacheKey(track, request) == metadata);
    request.width = 600; request.height = 800;
    CHECK(ssc::mediaCacheKey(track, request) == metadata);
}

TEST_CASE("native artwork format follows dimensions and squares stay landscape") {
    ssc::MediaRequest request;
    CHECK_FALSE(ssc::wantsPortraitArtwork(request));
    request.width = 1000; request.height = 1000;
    CHECK_FALSE(ssc::wantsPortraitArtwork(request));
    request.height = 1001;
    CHECK(ssc::wantsPortraitArtwork(request));
    request.includeArt = false;
    CHECK_FALSE(ssc::wantsPortraitArtwork(request));
}

TEST_CASE("rating visibility follows web intro hover and fullscreen idle policy") {
    CHECK(ssc::kRatingTrackVisibleMs == 10000);
    CHECK(ssc::kStageIdleMs == 2000);
    CHECK(ssc::shouldShowRatings(1000, 2000, false, false, 0));
    CHECK_FALSE(ssc::shouldShowRatings(2000, 2000, false, false, 0));
    CHECK(ssc::shouldShowRatings(3000, 0, true, false, 0));
    CHECK_FALSE(ssc::shouldShowRatings(3000, 0, false, false, 0));
    CHECK(ssc::shouldShowRatings(3000, 0, true, true, 3001));
    CHECK_FALSE(ssc::shouldShowRatings(3001, 0, true, true, 3001));
    // Deadline comparisons remain correct when the 32-bit tick count wraps.
    CHECK(ssc::shouldShowRatings(0xfffffff0u, 0x00000010u, false, false, 0));
}

TEST_CASE("rating badge size follows target DPI on fullscreen stages") {
    CHECK(ssc::ratingLogoHeight(1080.0f, 1.0f) == doctest::Approx(70.5f));
    CHECK(ssc::ratingLogoHeight(2160.0f, 2.0f) == doctest::Approx(141.0f));
    CHECK(ssc::ratingLogoHeight(2160.0f, 1.0f) == doctest::Approx(70.5f));
    CHECK(ssc::ratingLogoHeight(200.0f, 1.5f) == doctest::Approx(42.3f));
}

TEST_CASE("rating logos aspect-fit inside the same square slot as the web player") {
    const ssc::RatingLogoSize fsk = ssc::containRatingLogo(256.0f, 256.0f, 70.5f);
    CHECK(fsk.width == doctest::Approx(70.5f));
    CHECK(fsk.height == doctest::Approx(70.5f));

    const ssc::RatingLogoSize pg13 = ssc::containRatingLogo(504.0f, 256.0f, 70.5f);
    CHECK(pg13.width == doctest::Approx(70.5f));
    CHECK(pg13.height == doctest::Approx(35.8095f));
    CHECK(pg13.width / pg13.height == doctest::Approx(504.0f / 256.0f));

    const ssc::RatingLogoSize invalid = ssc::containRatingLogo(0.0f, 256.0f, 70.5f);
    CHECK(invalid.width == 0.0f);
    CHECK(invalid.height == 0.0f);
}

TEST_CASE("poster info box retains a bottom margin after wrapped titles grow") {
    CHECK(ssc::clampPosterInfoTop(480.0f, 200.0f, 680.0f, 12.0f)
          == doctest::Approx(468.0f));
    CHECK(ssc::clampPosterInfoTop(300.0f, 200.0f, 680.0f, 12.0f)
          == doctest::Approx(300.0f));
    CHECK(ssc::clampPosterInfoTop(-20.0f, 100.0f, 680.0f, 12.0f)
          == doctest::Approx(0.0f));
    CHECK(ssc::clampPosterInfoTop(100.0f, 700.0f, 680.0f, 12.0f)
          == doctest::Approx(0.0f));
}

TEST_CASE("poster info box follows content width independently of the cover") {
    CHECK(ssc::posterInfoWidth(1000, 100, 24, 1, 512) == doctest::Approx(562));
    CHECK(ssc::posterInfoWidth(500, 100, 24, 1, 500) == doctest::Approx(430));
    // A 1374 x 808 window has a roughly 469 px cover. Long metadata may use more
    // horizontal room just like the web player instead of wrapping at that cover edge.
    CHECK(ssc::posterInfoWidth(1374.0f, 720.0f, 24.0f, 1.0f)
          == doctest::Approx(770.0f));
    CHECK(ssc::posterInfoWidth(1374.0f, 1400.0f, 24.0f, 1.0f)
          == doctest::Approx(1181.64f));
    CHECK(ssc::posterInfoWidth(1374.0f, 20.0f, 24.0f, 1.0f)
          == doctest::Approx(90.0f));
}

TEST_CASE("portrait poster cover preserves a top margin while fitting above info") {
    const ssc::PosterCoverFit constrained =
        ssc::fitPortraitPosterCover(430.0f, 400.0f, 8.0f, 40.0f);
    CHECK(constrained.side == doctest::Approx(352.0f));
    CHECK(constrained.top == doctest::Approx(40.0f));
    CHECK(constrained.top + constrained.side + 8.0f == doctest::Approx(400.0f));

    const ssc::PosterCoverFit centered =
        ssc::fitPortraitPosterCover(280.0f, 500.0f, 8.0f, 40.0f);
    CHECK(centered.side == doctest::Approx(280.0f));
    CHECK(centered.top == doctest::Approx(126.0f));
}
