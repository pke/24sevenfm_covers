#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include "../../shared/media_worker.h"
#include "rating_fixture.h"
#include <condition_variable>
#include <mutex>
#include <thread>

TEST_CASE("common media options preserve station eligibility and independent ratings") {
    ssc::MediaPreferences preferences;
    preferences.backdrops = false; preferences.logos = true; preferences.ratings = true;
    preferences.providers = "tmdb,fanart"; preferences.fanartKey = "private-key";
    auto request = ssc::mediaOptions(preferences, 9000, -10);
    CHECK_FALSE(request.includeArt); CHECK_FALSE(request.includeTitleLogo); CHECK(request.includeRatings);
    CHECK(request.providers == "tmdb,fanart"); CHECK(request.fanartClientKey == "private-key");
    CHECK(request.width == 8192); CHECK(request.height == 0);
    preferences.backdrops = true;
    request = ssc::mediaOptions(preferences, 600, 900);
    CHECK(request.includeTitleLogo); CHECK(ssc::wantsPortraitArtwork(request));
    preferences.ratingCountries.clear(); CHECK_FALSE(ssc::mediaOptions(preferences).includeRatings);
    for (int station = 1; station < 5; ++station) {
        preferences.station = station; preferences.ratingCountries = "DE,US";
        request = ssc::mediaOptions(preferences);
        CHECK_FALSE(request.includeArt); CHECK_FALSE(request.includeTitleLogo); CHECK_FALSE(request.includeRatings);
    }
}
TEST_CASE("shared identity and metadata keep enrichment separate from queue ownership") {
    ssc::TrackInfo track; track.album = "Raw album"; track.track = "Cue";
    track.coverUrl = "cover"; track.albumUrl = "album";
    const auto queueId = ssc::queuedTrackIdentity(track);
    track.artist = "Enriched composer";
    CHECK(ssc::queuedTrackIdentity(track) == queueId);
    CHECK(ssc::trackIdentity(track, 0) != ssc::trackIdentity(track, 1));
    auto request = ssc::requestForTrack(track, ssc::MediaRequest());
    CHECK(request.artist == track.artist); CHECK(request.track == track.track);
    ssc::MediaResult media; media.album = "Unconfirmed";
    CHECK(ssc::presentationText(track, media, 0).album == "Raw album");
    media.hasMetadata = true; media.album = "Canonical album"; media.track = "Canonical cue";
    const auto text = ssc::presentationText(track, media, 0);
    CHECK(text.album == "Canonical album"); CHECK(text.track == "Canonical cue");
    CHECK(text.artist.empty()); // canonical empty fields must not regain raw feed text
    CHECK(text.authoritative);
}
TEST_CASE("station cover preparation validates host image and cancellation before publishing") {
    const auto png = ratingFixturePng(); REQUIRE_FALSE(png.empty());
    int calls = 0; bool corrupt = false, abort = false; std::atomic<bool> cancel{false};
    ssc::MediaPreparation preparation(ssc::MediaResolver(),
        [&](const std::string& host, unsigned short port, const std::string& path, int timeout, const std::atomic<bool>* token) {
            ++calls; CHECK(host == ssc::station(0).host); CHECK(port == 443); CHECK(timeout == 20);
            CHECK_FALSE(path.empty()); CHECK(token == &cancel);
            ssc::HttpResponse response; response.status = 200; response.body = corrupt ? "not an image" : png;
            if (abort) cancel.store(true);
            return response;
        });
    CHECK(preparation.cover("", 0, 20, &cancel) == png); // bundled station URL fallback
    const std::string host = ssc::station(0).host;
    CHECK(preparation.cover("http://" + host + "/cover/test.jpg", 0, 20, &cancel) == png);
    for (const auto& url : std::vector<std::string>{"https://evil.test/image.png", "https://" + host + ".evil.test/image.png",
            "https://" + host + "@evil.test/image.png", "ftp://" + host + "/image.png"})
        CHECK(preparation.cover(url, 0, 20, &cancel).empty());
    CHECK(calls == 2);
    corrupt = true; CHECK(preparation.cover("", 0, 20, &cancel).empty());
    corrupt = false; abort = true; CHECK(preparation.cover("", 0, 20, &cancel).empty());
    CHECK(calls == 4); CHECK(preparation.cover("", 0, 20, &cancel).empty()); CHECK(calls == 4);
}
TEST_CASE("provider image preparation rejects corrupt payloads and preserves certification data") {
    int calls = 0; bool corrupt = false;
    ssc::MediaResolverConfig config;
    config.transport = [&](const std::string&, unsigned short, const std::string&,
        const std::string&, const std::string&, const std::string&, int) {
        ++calls; ssc::HttpResponse response; response.status = 200;
        response.body = corrupt ? "broken" : ratingFixturePng(); return response;
    };
    ssc::MediaPreparation preparation{ssc::MediaResolver(config)};
    ssc::MediaResult media; media.status = ssc::MediaResult::Hit; media.source = "tmdb";
    media.backdropUrl = "https://image.tmdb.org/t/p/w1280/image.jpg";
    media.titleLogoUrl = "https://image.tmdb.org/t/p/w500/logo.png"; media.titleLogoSource = "tmdb";
    CHECK_FALSE(preparation.backdrop(media).empty()); CHECK_FALSE(preparation.logo(media).empty());
    corrupt = true; CHECK(preparation.backdrop(media).empty()); CHECK(preparation.logo(media).empty());
    corrupt = false;
    ssc::Certification cert; cert.country = "DE"; cert.system = "FSK"; cert.rating = "12"; cert.label = "FSK 12";
    cert.descriptors.push_back("Content description"); media.certifications.push_back(cert);
    ssc::MediaRequest options; options.ratingCountries = "XDE";
    CHECK(preparation.ratings(media, options).empty()); CHECK(calls == 4);
    options.ratingCountries = "US,DE";
    const auto ratings = preparation.ratings(media, options);
    REQUIRE(ratings.size() == 1); CHECK(ratings[0].country == "DE");
    CHECK(ratings[0].certification.descriptors == cert.descriptors); CHECK_FALSE(ratings[0].bytes.empty());
}
TEST_CASE("shared backdrop cache never substitutes a different provider or orientation") {
    ssc::MediaWorkerState state;
    ssc::TrackInfo track; track.album = "Film"; track.track = "Cue";
    ssc::MediaRequest request; request.width = 600; request.height = 900;
    ssc::MediaResult media; media.status = ssc::MediaResult::Hit; media.backdropUrl = "poster";
    ssc::cacheMedia(&state, "poster", track, request, media, "prepared poster");
    ssc::MediaWorkerState::CacheEntry hit;
    request.includeTitleLogo = true;
    CHECK(ssc::cachedBackdrop(&state, track, request, hit)); CHECK(hit.bytes == "prepared poster");
    request.width = 900; request.height = 600;
    CHECK_FALSE(ssc::cachedBackdrop(&state, track, request, hit));
    request.width = 600; request.height = 900; request.providers = "tmdb";
    CHECK_FALSE(ssc::cachedBackdrop(&state, track, request, hit));
}

TEST_CASE("credit enrichment is best effort and never changes known or cancelled feed data") {
    int calls = 0; std::atomic<bool> cancel{false}; bool abort = false;
    ssc::MediaResolverConfig config;
    config.transport = [&](const std::string&, unsigned short, const std::string& path,
        const std::string&, const std::string&, const std::string&, int) {
        ++calls; CHECK(path.find("/api/credit?") == 0);
        ssc::HttpResponse response; response.status = 200; response.body = R"({"artist":"Composer"})";
        if (abort) cancel.store(true); return response;
    };
    ssc::MediaPreparation preparation{ssc::MediaResolver(config)};
    ssc::TrackInfo track; track.album = "Film";
    track.albumUrl = "https://streamingsoundtracks.com/modules.php?name=Album&asin=B000000001";
    track.artist = "Known";
    CHECK(preparation.enrichCredit(track, ssc::station(0).host, &cancel).artist == "Known"); CHECK(calls == 0);
    track.artist.clear(); track.stationIdent = true;
    CHECK(preparation.enrichCredit(track, ssc::station(0).host, &cancel).artist.empty()); CHECK(calls == 0);
    track.stationIdent = false;
    const auto enriched = preparation.enrichCredit(track, ssc::station(0).host, &cancel);
    CHECK(enriched.artist == "Composer"); CHECK(calls == 1); CHECK(track.artist.empty());
    abort = true;
    CHECK(preparation.enrichCredit(track, ssc::station(0).host, &cancel).artist.empty()); CHECK(calls == 2);
    CHECK(preparation.enrichCredit(track, ssc::station(0).host, &cancel).artist.empty()); CHECK(calls == 2);
}

// The production resolver worker runs on Apple as well as Windows in this test.
// Transport is a fixture; there are no windows, GPU resources or live services.
TEST_CASE("portable resolver worker publishes normalized data and reuses prepared cache") {
    ssc::MediaWorkerState state;
    std::mutex mutex; std::condition_variable cv; int published = 0, requests = 0;
    std::string album, pixels;
    ssc::MediaResolverConfig config;
    config.transport = [&](const std::string&, unsigned short, const std::string& path,
        const std::string&, const std::string&, const std::string&, int) {
        ++requests; ssc::HttpResponse response; response.status = 200;
        response.body = path.find("/api/media?") == 0
            ? R"({"metadata":{"album":"Canonical film","artist":"Composer","track":"Cue"},"source":"tmdb","backdrop":"https://image.tmdb.org/t/p/w1280/image.jpg"})"
            : ratingFixturePng(); return response;
    };
    state.resolver = ssc::MediaResolver(config);
    ssc::MediaWorkerCallbacks callbacks;
    callbacks.publishRatings = [](auto, const auto&) {};
    callbacks.publishTitleLogo = [](auto, const auto&, const auto&, bool) {};
    callbacks.publishCycledBackdrop = [](auto, auto, const auto&, const auto&) {};
    callbacks.publishQueuedMetadata = [](auto, const auto&, const auto&) {};
    callbacks.selectionCurrent = [](auto, auto) { return true; };
    callbacks.publishMetadata = [&](auto, const auto& media, int) { album = media.album; };
    callbacks.publishMedia = [&](auto epoch, const auto& bytes, const auto&, bool failed, const auto*, bool) {
        std::lock_guard<std::mutex> lock(mutex); CHECK(epoch == 1); CHECK_FALSE(failed);
        pixels = bytes; ++published; cv.notify_all();
    };
    state.epoch = 1; state.cancel = std::make_shared<std::atomic<bool>>(false);
    ssc::MediaWorkerState::Work work; work.current = true; work.epoch = 1; work.cancel = state.cancel;
    work.track.album = "Film"; work.track.track = "Cue"; work.request.includeRatings = false;
    auto enqueue = [&] {
        ssc::platform::LockGuard lock(state.mutex); work.due = ssc::MediaWorkerState::Clock::now();
        state.work.push_back(work); state.cv.notify_all();
    };
    enqueue(); std::thread worker([&] { ssc::runMediaWorker(&state, callbacks); });
    auto wait = [&](int count) {
        std::unique_lock<std::mutex> lock(mutex);
        return cv.wait_for(lock, std::chrono::seconds(3), [&] { return published >= count; });
    };
    const bool first = wait(1);
    if (first) { enqueue(); CHECK(wait(2)); }
    { ssc::platform::LockGuard lock(state.mutex); state.stopping = true; state.cancel->store(true); state.cv.notify_all(); }
    worker.join();
    REQUIRE(first); CHECK(album == "Canonical film"); CHECK(pixels == ratingFixturePng()); CHECK(requests == 2);
}
