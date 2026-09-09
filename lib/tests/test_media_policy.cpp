#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"

#include "media_policy.h"
#include "../../shared/image_limits.h"

TEST_CASE("native image limits accept UHD and DCI 4K backdrops") {
    CHECK(ssc::coverDimsOk(3840, 2160));
    CHECK(ssc::coverDimsOk(4096, 2160));
    CHECK(ssc::coverDimsOk(2160, 4096));
    CHECK_FALSE(ssc::coverDimsOk(4097, 2160));
    CHECK_FALSE(ssc::coverDimsOk(3840, 8192));
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
