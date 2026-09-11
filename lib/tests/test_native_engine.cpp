#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include <future>
#include "../../shared/cover_engine.cpp"
#include "../../shared/rating_assets.h"

// Exercise the production scheduler/publication path without starting network or
// a GPU window. The real renderer's byte/ratings setters do not require a device.
struct CoverEngineTestAccess {
    CoverEngine engine;
    CoverEngineTestAccess() {
        engine.settings.transition = 0; // deterministic publication tests; fades are tested below
        engine.media_ = new CoverEngine::MediaWorkerState();
        engine.media_->settingsSnapshot = engine.settings;
    }
    ~CoverEngineTestAccess() { engine.stopMediaWorker(); }
    CoverEngine::MediaWorkerState& state() { return *engine.media_; }
    unsigned long long schedule(const char* album, bool reload = false) {
        ssc::TrackInfo info; info.album = album; info.track = "Cue";
        engine.scheduleMedia(info, std::vector<ssc::TrackInfo>(), reload);
        std::lock_guard<std::mutex> lock(state().mutex);
        return state().epoch;
    }
    void publish(unsigned long long epoch) {
        ssc::MediaResult result; result.album = "Old album"; result.artist = "Old artist";
        engine.publishMetadata(epoch, result, 60);
        std::vector<d2d::RatingBadge> ratings(1);
        ratings[0].rating = L"12";
        engine.publishMedia(epoch, "old image bytes", ratings, false);
        engine.publishRatings(epoch, ratings);
    }
    void checkNoOldData() {
        CHECK(engine.info_.title().empty());
        CHECK(engine.info_.artist().empty());
        CHECK_FALSE(engine.mediaDirty_);
        CHECK_FALSE(engine.haveBackdrop_);
        CHECK_FALSE(engine.ratingHasContent_);
        CHECK(engine.pendingTitleLogoBytes_.empty());
    }
    void blockedPublication(int kind) {
        const auto epoch = schedule("Old album");
        std::unique_lock<std::mutex> lock(engine.mutex_);
        std::promise<void> entered;
        auto ready = entered.get_future();
        auto worker = std::async(std::launch::async, [&] {
            entered.set_value();
            if (kind == 0) {
                ssc::MediaResult result; result.album = "Old album";
                engine.publishMetadata(epoch, result, 60);
            } else if (kind == 1)
                engine.publishMedia(epoch, "old image bytes", std::vector<d2d::RatingBadge>(1), false);
            else if (kind == 2) engine.publishRatings(epoch, std::vector<d2d::RatingBadge>(1));
            else engine.publishTitleLogo(epoch, "old logo bytes", "Old album");
        });
        ready.wait();
        // The publisher cannot complete while the publication mutex is held.
        CHECK(worker.wait_for(std::chrono::milliseconds(20)) == std::future_status::timeout);
        ++engine.activeMediaEpoch_;
        lock.unlock();
        worker.get();
        checkNoOldData();
    }
    void pendingReplacement() {
        const auto old = schedule("Old album");
        engine.publishMedia(old, "old image bytes", std::vector<d2d::RatingBadge>(1), false);
        schedule("New album");
        engine.decodePendingMedia(nullptr);
        checkNoOldData();
        // Defense at the UI commit boundary, even if a stale mailbox is present.
        engine.mediaDirty_ = true;
        engine.pendingMediaEpoch_ = old;
        engine.decodePendingMedia(nullptr);
        checkNoOldData();
    }
    void restart() {
        const auto old = schedule("Old album");
        engine.stopMediaWorker();
        engine.media_ = new CoverEngine::MediaWorkerState();
        const auto fresh = schedule("New album");
        CHECK(fresh > old);
        publish(old);
        checkNoOldData();
        publish(fresh);
        CHECK(engine.info_.title() == L"Old album (1:00)");
        CHECK(engine.mediaDirty_);
        engine.decodePendingMedia(nullptr);
        CHECK(engine.ratingHasContent_);
        CHECK(engine.ratingIntroEpoch_ == fresh);
    }
    void stationIdentLabel(int selected, const std::string& album, const std::string& expected) {
        // The callback uses the monitor snapshot, not mutable UI settings. Mark
        // its logo as already shown to exercise the real path without networking.
        state().settingsSnapshot.station = selected;
        engine.settings.station = (selected + 1) % ssc::kStationCount;
        engine.shownUrl_ = ssc::station(selected).logoUrl;
        ssc::TrackInfo info;
        info.album = album; info.track = "Station Jingle"; info.artist = "24seven.fm";
        info.stationIdent = true;
        engine.onCoverChanged("", info);
        CHECK(engine.info_.title() == toWide(expected));
        CHECK(engine.info_.artist() == (expected.empty() ? L"" : L"24seven.fm"));
        CHECK(state().current.album == album); // no mutation of raw identity
        CHECK(state().work.empty()); // jingles never need a media/provider request
    }
    void canonicalRetry() {
        auto epoch = schedule("Crown, The");
        ssc::MediaResult canonical; canonical.album = "The Crown";
        canonical.artist = "Composer"; canonical.hasMetadata = true;
        engine.publishMetadata(epoch, canonical, 60);
        epoch = schedule("Crown, The", true);
        ssc::MediaResult raw; raw.album = "Crown, The"; raw.artist = "Raw artist";
        engine.publishMetadata(epoch, raw, 60);
        CHECK(engine.info_.title() == L"The Crown (1:00)");
        CHECK(engine.info_.artist() == L"Composer");
        // A settled older endpoint response (Miss) has the same fallback policy.
        raw.status = ssc::MediaResult::Miss;
        engine.publishMetadata(epoch, raw, 60);
        CHECK(engine.info_.title() == L"The Crown (1:00)");
        const auto next = schedule("Next track");
        CHECK(engine.info_.title().empty());
        engine.publishMetadata(epoch, canonical, 60); // late previous-track response
        CHECK(engine.info_.title().empty());
        raw.album = "Next track";
        engine.publishMetadata(next, raw, 60);
        CHECK(engine.info_.title() == L"Next track (1:00)");
    }
    void coverStation() {
        engine.shownBytes_ = "SST image"; engine.shownStation_ = 0;
        engine.settings.station = 1; // mutable UI selection is NOT byte identity
        std::string bytes = "stale";
        CHECK_FALSE(engine.currentCover(bytes, 1));
        CHECK(bytes.empty());
        CHECK(engine.currentCover(bytes, 0));
        CHECK(bytes == "SST image");
        CHECK_FALSE(engine.currentCover(bytes, -1));
    }
    void queuedTitleLogos() {
        engine.stopMediaWorker();
        engine.settings.backdrops = true;
        engine.startMediaWorker();
        const void* png = nullptr; size_t length = 0;
        REQUIRE(ssc::ratingAssetPng("DE", "FSK", "12", png, length));
        const std::string image(static_cast<const char*>(png), length);
        std::atomic<unsigned> resolutions{0}, downloads{0};
        ssc::MediaResolverConfig config;
        config.transport = [&](const std::string& host, unsigned short, const std::string& path,
                const std::string&, const std::string&, const std::string&, int) {
            ssc::HttpResponse response; response.status = 200;
            if (host == "assets.fanart.tv") { ++downloads; response.body = image; }
            else {
                ++resolutions;
                const std::string album = path.find("Queued") == std::string::npos ? "Current" : "Queued";
                response.body = "{\"metadata\":{\"album\":\"" + album + "\",\"track\":\"Cue\",\"artist\":\"\"}";
                if (path.find("&logos=1") != std::string::npos)
                    response.body += ",\"logo\":{\"url\":\"https://assets.fanart.tv/fanart/" + album + ".png\",\"source\":\"fanart\"}";
                response.body += "}";
            }
            return response;
        };
        { std::lock_guard<std::mutex> lock(state().mutex); state().resolver = ssc::MediaResolver(config); }
        struct JoinWorker { std::function<void()> stop; ~JoinWorker() { stop(); } };
        JoinWorker join{[&] { engine.stopMediaWorker(); }};
        ssc::TrackInfo current, queued;
        current.album = "Current"; current.track = "Cue";
        queued.album = "Queued"; queued.track = "Cue";
        engine.scheduleMedia(current, {queued});
        const auto waitFor = [&](size_t metadataCount, size_t logoCount) {
            for (unsigned i = 0; i < 1000; ++i) {
                {
                    std::lock_guard<std::mutex> lock(state().mutex);
                    if (state().cache.size() == metadataCount && state().titleLogoCache.size() == logoCount)
                        return true;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(5));
            }
            return false;
        };
        REQUIRE(waitFor(2, 0));
        CHECK(downloads == 0); CHECK(resolutions == 2);
        engine.settings.titleLogos = true; engine.repaint();
        REQUIRE(waitFor(4, 2));
        CHECK(downloads == 2); CHECK(resolutions == 4);
        engine.decodePendingMedia(nullptr);

        // Reordering providers is a real artwork selection change, but a logo
        // already downloaded for that resulting resolver hit must be swapped
        // directly instead of exposing plain album text between two logos.
        engine.settings.mediaProviders = "tmdb,fanart,tvmaze,steamgriddb";
        engine.repaint();
        REQUIRE(waitFor(6, 2));
        {
            std::lock_guard<std::mutex> lock(engine.mutex_);
            CHECK(engine.pendingTitleLogoAlbum_ == "Current");
            CHECK(engine.pendingTitleLogoImmediate_);
        }
        CHECK(downloads == 2); CHECK(resolutions == 6);
        engine.settings.mediaProviders = "fanart,tmdb,tvmaze,steamgriddb";
        engine.repaint(); // exact metadata + logo bytes are cached for this order
        engine.settings.titleLogos = false; engine.repaint();
        engine.settings.titleLogos = true; engine.repaint();
        engine.scheduleMedia(queued, {}); // promote the prepared queue item
        for (unsigned i = 0; i < 1000; ++i) {
            bool ready;
            { std::lock_guard<std::mutex> lock(engine.mutex_);
              ready = engine.pendingTitleLogoAlbum_ == "Queued" && !engine.pendingTitleLogoBytes_.empty(); }
            if (ready) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
        { std::lock_guard<std::mutex> lock(engine.mutex_);
          CHECK(engine.pendingTitleLogoAlbum_ == "Queued"); }
        engine.stopMediaWorker(); // join before captured fixtures leave scope
        CHECK(downloads == 2); CHECK(resolutions == 6);
    }
    void mediaTransitionPolicy() {
        engine.settings.station = 0;
        engine.settings.backdrops = true;
        engine.settings.titleLogos = true;
        state().settingsSnapshot = engine.settings;
        ssc::TrackInfo current; current.album = "Current"; current.track = "Cue";
        engine.scheduleMedia(current, {});
        REQUIRE(state().work.size() == 1);
        CHECK(state().work[0].animateBackdrop); // initial track presentation
        CHECK_FALSE(state().work[0].immediateCachedTitleLogo);

        engine.settings.titleLogos = false;
        engine.repaint();
        REQUIRE(state().work.size() == 1);
        CHECK_FALSE(state().work[0].animateBackdrop);
        CHECK_FALSE(state().work[0].immediateCachedTitleLogo);

        engine.settings.titleLogos = true;
        engine.repaint();
        REQUIRE(state().work.size() == 1);
        CHECK_FALSE(state().work[0].animateBackdrop);
        CHECK_FALSE(state().work[0].immediateCachedTitleLogo);

        engine.settings.mediaProviders = "tmdb,fanart,tvmaze,steamgriddb";
        engine.repaint();
        REQUIRE(state().work.size() == 1);
        CHECK(state().work[0].animateBackdrop);
        CHECK(state().work[0].immediateCachedTitleLogo);
    }
    void artworkResize() {
        struct HiddenWindow {
            HWND value = CreateWindowExW(0, L"STATIC", L"Artwork resolution test",
                WS_POPUP, 0, 0, 1280, 720, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
            ~HiddenWindow() { if (value) DestroyWindow(value); }
        } window;
        REQUIRE(window.value != nullptr);
        engine.hwnd_.store(window.value);
        engine.settings.station = 0; engine.settings.backdrops = true;
        state().settingsSnapshot = engine.settings;
        ssc::TrackInfo current, queued;
        current.album = "Crown, The"; queued.album = "Queued";
        engine.scheduleMedia(current, {queued});
        const auto hdEpoch = state().epoch;
        CHECK(state().request.width == 1280);
        CHECK(state().request.height == 720);
        CHECK_FALSE(ssc::wants4kArtwork(state().request));
        ssc::MediaResult canonical; canonical.album = "The Crown"; canonical.hasMetadata = true;
        engine.publishMetadata(hdEpoch, canonical, 60);

        SetWindowPos(window.value, nullptr, 0, 0, 3840, 2160, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
        engine.onTimer(window.value, CoverEngine::kHeartbeat);
        const auto uhdEpoch = state().epoch;
        CHECK(uhdEpoch > hdEpoch);
        CHECK(state().request.width == 3840);
        CHECK(state().request.height == 2160);
        CHECK(state().work.size() == 2); // current and queue use the new variant
        for (const auto& work : state().work) {
            CHECK(ssc::wants4kArtwork(work.request));
            if (work.current) CHECK_FALSE(work.animateBackdrop);
        }
        CHECK(engine.info_.title() == L"The Crown (1:00)");
        ssc::MediaResult fallback; fallback.album = "Crown, The";
        engine.publishMetadata(uhdEpoch, fallback, 60);
        CHECK(engine.info_.title() == L"The Crown (1:00)");

        SetWindowPos(window.value, nullptr, 0, 0, 2560, 1440, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
        engine.onTimer(window.value, CoverEngine::kHeartbeat);
        CHECK(state().epoch == uhdEpoch); // no per-pixel request churn
        SetWindowPos(window.value, nullptr, 0, 0, 2160, 3840, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
        engine.onTimer(window.value, CoverEngine::kHeartbeat);
        CHECK(state().epoch > uhdEpoch);
        CHECK(ssc::wantsPortraitArtwork(state().request));
        CHECK(ssc::wants4kArtwork(state().request));
        for (const auto& work : state().work)
            if (work.current) CHECK_FALSE(work.animateBackdrop);
        CHECK(engine.info_.title() == L"The Crown (1:00)");
        engine.hwnd_.store(nullptr);
    }
};

TEST_CASE("native resize updates current and queue resolution without downgrading metadata") {
    CoverEngineTestAccess test; test.artworkResize();
}
TEST_CASE("native title logos prepare queued images and reuse metadata across toggles and promotion") {
    CoverEngineTestAccess test; test.queuedTitleLogos();
}
TEST_CASE("native same-track UI refinements do not fade the backdrop") {
    CoverEngineTestAccess test; test.mediaTransitionPolicy();
}
TEST_CASE("native canonical metadata survives retries and resets only for a different track") {
    CoverEngineTestAccess test; test.canonicalRetry();
}
TEST_CASE("native album art exports bytes only for their owning station") {
    CoverEngineTestAccess test; test.coverStation();
}
TEST_CASE("native info handoff retains outgoing text until exit and reveals settled replacement") {
    ssc::InfoPresentation info;
    info.begin("old", 100, 1000);
    CHECK(info.title().empty());
    info.settle(L"Old title", L"Old artist", true, 100, 1000);
    CHECK(info.advance(600, 1000) == doctest::Approx(.5f));
    CHECK(info.advance(1100, 1000) == 1.0f);
    info.begin("new", 1200, 1000);
    info.settle(L"New title", L"New artist", true, 1300, 1000);
    CHECK(info.advance(1700, 1000) == doctest::Approx(.5f));
    CHECK(info.title() == L"Old title");
    CHECK(info.artist() == L"Old artist");
    CHECK(info.advance(2200, 1000) == 0.0f);
    CHECK(info.title() == L"New title");
    CHECK(info.advance(2700, 1000) == doctest::Approx(.5f));
    CHECK(info.advance(3200, 1000) == 1.0f);
    CHECK_FALSE(info.animating());
}
TEST_CASE("native info stays hidden after exit until a slow resolver settles") {
    ssc::InfoPresentation info;
    info.begin("old", 100, 0); info.settle(L"Old", L"Artist", true, 100, 0);
    info.begin("new", 200, 1000);
    CHECK(info.advance(1200, 1000) == 0.0f);
    CHECK(info.title().empty());
    CHECK(info.advance(12000, 1000) == 0.0f);
    info.settle(L"Raw fallback", L"Artist", false, 12000, 1000);
    CHECK(info.advance(12500, 1000) == doctest::Approx(.5f));
    CHECK(info.title() == L"Raw fallback");
    // A live reduced-motion change completes the animation immediately.
    CHECK(info.advance(12500, 0) == 1.0f);
    CHECK_FALSE(info.animating());
}
TEST_CASE("native info cancels obsolete pending metadata during rapid track changes") {
    ssc::InfoPresentation info;
    info.begin("old", 100, 0); info.settle(L"Old", L"", true, 100, 0);
    info.begin("intermediate", 200, 1000);
    info.settle(L"Never shown", L"", true, 250, 1000);
    info.begin("latest", 300, 1000);
    info.advance(2000, 1000);
    CHECK(info.title().empty());
    info.settle(L"Latest", L"", true, 2100, 0);
    CHECK(info.title() == L"Latest");
}

TEST_CASE("native station jingles display the selected station name without changing raw metadata") {
    CoverEngineTestAccess test;
    for (int i = 0; i < ssc::kStationCount; ++i)
        for (const char* marker : {"StationID", "Station ID", " \tstationid\r\n"})
            test.stationIdentLabel(i, marker, ssc::station(i).displayName);
}
TEST_CASE("native station ident labels preserve real album titles and empty metadata") {
    CoverEngineTestAccess test;
    for (const char* album : {"Station Identity", "StationID Live", "An Unregistered Album", ""})
        test.stationIdentLabel(0, album, album);
}

TEST_CASE("native blocked publishers validate the epoch inside the publication lock") {
    CoverEngineTestAccess test;
    SUBCASE("metadata") { test.blockedPublication(0); }
    SUBCASE("artwork") { test.blockedPublication(1); }
    SUBCASE("ratings") { test.blockedPublication(2); }
    SUBCASE("title logo") { test.blockedPublication(3); }
}
TEST_CASE("native track change discards pending artwork and ratings before UI commit") {
    CoverEngineTestAccess test;
    test.pendingReplacement();
}
TEST_CASE("native worker restart never reuses a publication epoch") {
    CoverEngineTestAccess test;
    test.restart();
}
TEST_CASE("native settings edits and monitor scheduling use coherent snapshots") {
    CoverEngineTestAccess test;
    test.engine.settings.backdrops = true;
    test.engine.settings.mediaProviders = "fanart," + std::string(2048, 'a');
    test.engine.settings.fanartClientKey = std::string(4096, 'a');
    test.engine.repaint();
    test.schedule("Current");
    std::atomic<bool> done{false};
    std::atomic<bool> coherent{true};
    std::promise<void> started;
    auto ready = started.get_future();
    std::thread monitor([&] {
        test.schedule("Current");
        started.set_value();
        while (!done.load()) {
            test.schedule("Current");
            std::lock_guard<std::mutex> lock(test.state().mutex);
            const auto& r = test.state().request;
            if (r.providers.substr(7) != std::string(2048, r.fanartClientKey[0])
                    || r.fanartClientKey != std::string(4096, r.fanartClientKey[0])) coherent = false;
        }
    });
    ready.wait();
    for (int i = 0; i < 500; ++i) {
        const char marker = (i % 2) ? 'a' : 'b';
        test.engine.settings.mediaProviders = "fanart," + std::string(2048, marker);
        test.engine.settings.fanartClientKey = std::string(4096, marker);
        test.engine.repaint();
    }
    done = true;
    monitor.join();
    CHECK(coherent.load());
}
TEST_CASE("native repaint preserves the latest current track and its queued work") {
    CoverEngineTestAccess test;
    test.schedule("Current");
    ssc::TrackInfo next; next.album = "Queued";
    test.state().queue.push_back(next);
    test.engine.settings.ratings = true;
    test.engine.repaint();
    CHECK(test.state().current.album == "Current");
    REQUIRE(test.state().queue.size() == 1);
    CHECK(test.state().queue[0].album == "Queued");
    REQUIRE(test.state().work.size() == 2);
    const auto epoch = test.state().epoch;
    auto cancel = test.state().cancel;
    test.engine.retryMedia();
    CHECK(test.state().epoch > epoch);
    CHECK(cancel->load());
    REQUIRE(test.state().work.size() == 2);
    CHECK(test.state().work[0].reload);
    CHECK_FALSE(test.state().work[1].reload);
}
