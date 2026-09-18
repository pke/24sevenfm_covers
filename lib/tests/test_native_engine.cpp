#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include <future>
#include "../../shared/cover_engine.cpp"
#include "../../shared/rating_assets.h"

TEST_CASE("coming next retains outgoing content, handles rapid queue changes and reduced motion") {
    ssc::ComingNextPresentation next;
    next.setQueue("a", L"Album A", L"Artist A");
    CHECK(next.advance(false, 10, 0, 250).album.empty());
    CHECK(next.advance(true, -1, 0, 250).album.empty());
    CHECK(next.advance(true, 11, 0, 250).album.empty());
    CHECK(next.advance(true, 10, 100, 250).opacity == 0);
    auto frame = next.advance(true, 9, 225, 250);
    CHECK(frame.opacity == doctest::Approx(.802403).epsilon(.0001)); // CSS ease halfway in
    CHECK(frame.album == L"Album A");
    CHECK(next.advance(true, 0, 350, 250).opacity == 1);
    frame = next.advance(false, 0, 400, 250);
    CHECK(frame.opacity == 1);
    CHECK(frame.album == L"Album A");
    frame = next.advance(false, 0, 525, 250);
    CHECK(frame.opacity == doctest::Approx(.197597).epsilon(.0001)); // CSS ease halfway out
    CHECK(frame.artist == L"Artist A");
    next.setQueue("b", L"Album B", L"");
    next.advance(true, 5, 550, 250);
    next.setQueue("c", L"Album C", L"Artist C");
    CHECK(next.advance(true, 5, 600, 250).album == L"Album A");
    frame = next.advance(true, 5, 850, 250);
    CHECK(frame.album == L"Album C");
    CHECK(frame.opacity == 0);
    CHECK(next.advance(true, 4, 1100, 250).opacity == 1);
    next.setQueue("", L"", L"");
    CHECK(next.advance(true, 3, 1200, 250).album == L"Album C");
    CHECK(next.advance(true, 3, 1450, 250).album.empty());
    next.setQueue("d", L"Album D", L"");
    CHECK(next.advance(true, 10, 1500, 0).opacity == 1);
    CHECK(next.advance(false, 10, 1500, 0).album.empty());
}

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
    void comingNextQueue() {
        ssc::TrackInfo current, first, second;
        current.album = "Current"; first.album = "Crown, The"; second.album = "Next album";
        first.track = "First cue"; second.track = "Second cue";
        engine.scheduleMedia(current, {first, second});
        const auto epoch = state().epoch;
        const auto frame = [&] { return engine.comingNext_.advance(true, 10, 100, 0); };
        CHECK(frame().album == L"Crown, The"); // feed fallback does not wait for API/art
        ssc::MediaResult result; result.album = "The Crown"; result.artist = "Composer";
        result.hasMetadata = true;
        engine.publishQueuedMetadata(epoch, first, result);
        CHECK(frame().album == L"The Crown");
        CHECK(frame().artist == L"Composer");
        engine.scheduleMedia(current, {}); // current-only refresh is not an empty queue
        CHECK(frame().album == L"The Crown");
        engine.settings.comingNext = true; engine.repaint();
        CHECK(state().epoch == epoch); // the display switch does not change API/cache identity
        CHECK(frame().album == L"The Crown");
        CHECK_FALSE(engine.settings.showRemaining);
        CHECK_FALSE(engine.haveCover_);
        engine.setRemaining(5); // native playback clock includes the station's five-second gap
        engine.updateComingNext(GetTickCount());
        engine.updateComingNext(GetTickCount() + 250);
        CHECK(engine.comingNextFrame_.album == L"The Crown");
        CHECK(engine.comingNextFrame_.opacity == 1);

        // A later row can be cached before a fresh queue moves it to the front.
        result.album = "Normalized next";
        cacheMedia(&state(), "prepared", second, state().request, result, "unused pixels");
        engine.scheduleMedia(current, {second});
        CHECK(frame().album == L"Normalized next");
        engine.publishQueuedMetadata(epoch, first, result); // late reordered row
        CHECK(frame().album == L"Normalized next");
        engine.scheduleMedia(current, {}, false, true); // authoritative empty response
        CHECK(frame().album.empty());
        CHECK(state().queue.empty());
        engine.publishQueuedMetadata(epoch, second, result);
        CHECK(frame().album.empty());

        engine.scheduleMedia(current, {first});
        REQUIRE_FALSE(frame().album.empty());
        engine.scheduleMedia(second, {}); // playback boundary drops the old announcement
        engine.publishQueuedMetadata(epoch, first, result);
        CHECK(frame().album.empty());
        engine.scheduleMedia(second, {first});
        engine.stopMediaWorker();
        engine.publishQueuedMetadata(epoch, first, result);
        CHECK(frame().album.empty());
    }
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
        engine.settings.comingNext = true; engine.repaint();
        {
            std::lock_guard<std::mutex> lock(engine.mutex_);
            const auto frame = engine.comingNext_.advance(true, 10, 100, 0);
            CHECK(frame.album == L"Queued");
        }
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
    enum class TextArtwork { Missing, ResolverFailure, CachedImage, ImageFailure };
    void titleLogoBackdrop(bool cachedMiss, TextArtwork textArtwork) {
        engine.stopMediaWorker();
        engine.settings.backdrops = true;
        engine.settings.titleLogos = !cachedMiss;
        engine.startMediaWorker();
        const void* png = nullptr; size_t length = 0;
        REQUIRE(ssc::ratingAssetPng("DE", "FSK", "12", png, length));
        const std::string image(static_cast<const char*>(png), length);
        std::atomic<unsigned> backdropDownloads{0};
        ssc::MediaResolverConfig config;
        config.transport = [&](const std::string& host, unsigned short, const std::string& path,
                const std::string&, const std::string&, const std::string&, int) {
            ssc::HttpResponse response; response.status = 200;
            if (host == "assets.fanart.tv") {
                if (path.find("logo.png") == std::string::npos) ++backdropDownloads;
                if (path.find("unavailable.png") != std::string::npos) response.status = 503;
                else response.body = image;
            }
            else if (path.find("&logos=1") != std::string::npos)
                response.body = R"({"backdrop":"https://assets.fanart.tv/fanart/backdrop.png","source":"fanart","logo":{"url":"https://assets.fanart.tv/fanart/logo.png","source":"fanart"}})";
            else if (path.find("&art=0") != std::string::npos) response.body = "{}";
            else if (textArtwork == TextArtwork::ResolverFailure)
                response.status = 503;
            else if (textArtwork == TextArtwork::CachedImage)
                response.body = R"({"backdrop":"https://assets.fanart.tv/fanart/backdrop.png","source":"fanart"})";
            else if (textArtwork == TextArtwork::ImageFailure)
                response.body = R"({"backdrop":"https://assets.fanart.tv/fanart/unavailable.png","source":"fanart"})";
            else response.body = "{}";
            return response;
        };
        { std::lock_guard<std::mutex> lock(state().mutex); state().resolver = ssc::MediaResolver(config); }
        struct JoinWorker { std::function<void()> stop; ~JoinWorker() { stop(); } };
        JoinWorker join{[&] { engine.stopMediaWorker(); }};
        const auto settleBackdrop = [&] {
            for (unsigned i = 0; i < 1000; ++i) {
                bool ready;
                { std::lock_guard<std::mutex> lock(engine.mutex_);
                  ready = engine.mediaDirty_ && engine.pendingBackdropChange_
                      && engine.pendingMediaEpoch_ == engine.activeMediaEpoch_; }
                if (ready) { engine.decodePendingMedia(nullptr); return true; }
                std::this_thread::sleep_for(std::chrono::milliseconds(5));
            }
            return false;
        };
        schedule("Current");
        REQUIRE(settleBackdrop());
        if (cachedMiss) {
            CHECK_FALSE(engine.haveBackdrop_);
            engine.settings.titleLogos = true; engine.repaint();
            REQUIRE(settleBackdrop());
        }
        REQUIRE(engine.haveBackdrop_);
        for (unsigned i = 0; i < 2; ++i) {
            engine.settings.titleLogos = false; engine.repaint();
            REQUIRE(settleBackdrop());
            CHECK(engine.settings.backdrops);
            CHECK(engine.haveBackdrop_);
            { std::lock_guard<std::mutex> lock(engine.mutex_);
              CHECK(engine.pendingTitleLogoBytes_.empty()); }
            engine.settings.titleLogos = true; engine.repaint();
            REQUIRE(settleBackdrop());
            CHECK(engine.haveBackdrop_);
        }
        CHECK(backdropDownloads == (textArtwork == TextArtwork::ImageFailure ? 7u : 1u));
        // The title option must not interfere with explicitly disabling art.
        engine.settings.backdrops = false; engine.repaint();
        REQUIRE(settleBackdrop());
        CHECK_FALSE(engine.haveBackdrop_);
        engine.settings.backdrops = true; engine.repaint();
        REQUIRE(settleBackdrop());
        CHECK(engine.haveBackdrop_);
        // A backdrop fallback cannot cross track or provider identities.
        if (textArtwork == TextArtwork::Missing) {
            engine.settings.titleLogos = false; engine.repaint();
            REQUIRE(settleBackdrop());
            schedule("Different album");
            REQUIRE(settleBackdrop());
            CHECK_FALSE(engine.haveBackdrop_);
            schedule("Current");
            REQUIRE(settleBackdrop());
            CHECK(engine.haveBackdrop_);
            engine.settings.mediaProviders = "tmdb"; engine.repaint();
            REQUIRE(settleBackdrop());
            CHECK_FALSE(engine.haveBackdrop_);
        }
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
    void viewportCacheHandoff(bool portraitArt, bool landscapeArt) {
        struct Windows {
            HWND portrait = CreateWindowExW(0, L"STATIC", L"Portrait test", WS_POPUP,
                0, 0, 600, 900, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
            HWND landscape = CreateWindowExW(0, L"STATIC", L"Fullscreen test", WS_POPUP,
                0, 0, 3840, 2160, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
            ~Windows() { DestroyWindow(portrait); DestroyWindow(landscape); }
        } windows;
        REQUIRE(windows.portrait); REQUIRE(windows.landscape);
        const HWND initial = portraitArt ? windows.portrait : windows.landscape;
        const HWND alternate = portraitArt ? windows.landscape : windows.portrait;
        engine.stopMediaWorker();
        engine.settings.backdrops = true; engine.settings.titleLogos = true;
        engine.settings.transition = 1;
        engine.hwnd_.store(initial);
        engine.startMediaWorker();
        const void* png = nullptr; size_t length = 0;
        REQUIRE(ssc::ratingAssetPng("DE", "FSK", "12", png, length));
        const std::string image(static_cast<const char*>(png), length);
        std::promise<void> entered, release;
        auto enteredFuture = entered.get_future();
        auto releaseFuture = release.get_future().share();
        std::atomic<unsigned> requests{0};
        struct JoinWorker { std::function<void()> stop; ~JoinWorker() { stop(); } };
        JoinWorker join{[&] {
            release.set_value(); engine.stopMediaWorker(); engine.setWindow(nullptr); d2d::shutdown();
        }};
        REQUIRE(d2d::init());
        d2d::setCover(image.data(), image.size(), false);
        engine.haveCover_ = true;
        ssc::MediaResolverConfig config;
        config.transport = [&](const std::string&, unsigned short, const std::string&,
                const std::string&, const std::string&, const std::string&, int) {
            if (++requests == 1) { entered.set_value(); releaseFuture.wait(); }
            ssc::HttpResponse response; response.status = 200; response.body = "{}"; return response;
        };
        ssc::TrackInfo current, queued;
        current.album = "Cached movie"; current.track = "Cue";
        queued.album = "Blocked queue request";
        {
            std::lock_guard<std::mutex> lock(state().mutex);
            state().resolver = ssc::MediaResolver(config);
            for (bool portrait : {true, false}) {
                ssc::MediaRequest request;
                request.includeTitleLogo = true; request.includeRatings = engine.settings.ratings;
                request.width = portrait ? 600 : 3840; request.height = portrait ? 900 : 2160;
                ssc::MediaResult result; result.status = ssc::MediaResult::Hit;
                result.album = current.album; result.hasTint = true; result.tint[0] = portrait ? 1 : 2;
                const bool haveArtwork = portrait ? portraitArt : landscapeArt;
                if (haveArtwork) result.backdropUrl = portrait ? "portrait" : "landscape";
                else result.status = ssc::MediaResult::Miss;
                result.titleLogoUrl = "cached logo";
                cacheMedia(&state(), ssc::mediaCacheKey(current, request), current, request,
                           result, haveArtwork ? image : std::string());
            }
            state().titleLogoCache["cached logo"] = image;
        }
        engine.scheduleMedia(current, {queued});
        REQUIRE(enteredFuture.wait_for(std::chrono::seconds(5)) == std::future_status::ready);
        engine.decodePendingMedia(nullptr);
        REQUIRE(engine.haveBackdrop_);
        for (HWND target : {alternate, initial, alternate, initial}) {
            // A stale clock must not consume the new fade during target recreation.
            engine.mediaFadeStart_ = GetTickCount() - engine.settings.fadeMs - 1000;
            const DWORD handoffStarted = GetTickCount();
            engine.setWindow(target); // cached images must commit even while HTTP is blocked
            const bool expectBackdrop = target == windows.portrait ? portraitArt : landscapeArt;
            CHECK(engine.haveBackdrop_ == expectBackdrop);
            CHECK_FALSE(engine.mediaDirty_);
            CHECK(engine.pendingMediaHasTint_ == expectBackdrop);
            if (expectBackdrop)
                CHECK(engine.pendingMediaTint_[0] == (target == windows.portrait ? 1 : 2));
            CHECK(engine.mediaFading_ == clientAnimationsEnabled());
            // The host's retained portrait pixels must already be replaced when
            // setWindow returns, before the covering fullscreen window is removed.
            CHECK_FALSE(engine.mediaFadePending_);
            CHECK(d2d::backdropReady());
            if (clientAnimationsEnabled()) CHECK((LONG)(engine.mediaFadeStart_ - handoffStarted) >= 0);
            engine.onPaint(target);
            CHECK(d2d::backdropReady());
            CHECK_FALSE(engine.mediaFadePending_);
            CHECK(engine.mediaFading_ == clientAnimationsEnabled()); // upload time did not consume the fade
            const auto epoch = state().epoch;
            const HWND old = target == windows.portrait ? windows.landscape : windows.portrait;
            engine.onTimer(old, CoverEngine::kHeartbeat);
            CHECK(state().epoch == epoch); // queued host timers cannot reselect its old viewport
            engine.publishRatings(epoch, {});
            engine.onNewMedia(old);
            CHECK(engine.mediaDirty_); // stale host messages cannot consume the new window's mailbox
            engine.onNewMedia(target);
            CHECK_FALSE(engine.mediaDirty_);
            CHECK(engine.haveBackdrop_ == expectBackdrop);
            CHECK(requests == 1);
        }
        { std::lock_guard<std::mutex> lock(state().mutex); CHECK(state().cache.size() == 2); }
    }
    void viewportMissUsesDefault(bool portraitArt) {
        struct Window {
            HWND value = CreateWindowExW(0, L"STATIC", L"Viewport miss test", WS_POPUP,
                0, 0, 600, 900, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
            ~Window() { DestroyWindow(value); }
        } window;
        REQUIRE(window.value);
        const auto resize = [&](bool portrait) {
            REQUIRE(SetWindowPos(window.value, nullptr, 0, 0, portrait ? 600 : 1280,
                portrait ? 900 : 720, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE));
        };
        resize(portraitArt);
        engine.stopMediaWorker();
        engine.settings.backdrops = true;
        engine.hwnd_.store(window.value);
        engine.startMediaWorker();
        const void* png = nullptr; size_t length = 0;
        REQUIRE(ssc::ratingAssetPng("DE", "FSK", "12", png, length));
        const std::string image(static_cast<const char*>(png), length);
        std::promise<void> entered, release;
        auto enteredFuture = entered.get_future();
        auto releaseFuture = release.get_future().share();
        std::atomic<unsigned> missingVariantRequests{0};
        bool released = false;
        struct JoinWorker { std::function<void()> stop; ~JoinWorker() { stop(); } };
        JoinWorker join{[&] {
            if (!released) release.set_value();
            engine.stopMediaWorker(); engine.setWindow(nullptr);
        }};
        ssc::MediaResolverConfig config;
        config.transport = [&](const std::string& host, unsigned short, const std::string& path,
                const std::string&, const std::string&, const std::string&, int) {
            ssc::HttpResponse response; response.status = 200;
            if (host == "assets.fanart.tv") response.body = image;
            else if (path.find(portraitArt ? "&width=600" : "&width=1280") != std::string::npos)
                response.body = portraitArt
                    ? R"({"backdrop":"https://assets.fanart.tv/fanart/portrait.png","source":"fanart"})"
                    : R"({"backdrop":"https://assets.fanart.tv/fanart/landscape.png","source":"fanart"})";
            else {
                if (path.find(portraitArt ? "&width=1280" : "&width=600") != std::string::npos
                        && ++missingVariantRequests == 1) {
                    entered.set_value(); releaseFuture.wait();
                }
                response.body = "{}";
            }
            return response;
        };
        { std::lock_guard<std::mutex> lock(state().mutex); state().resolver = ssc::MediaResolver(config); }
        const auto settled = [&] {
            for (unsigned i = 0; i < 1000; ++i) {
                bool ready;
                { std::lock_guard<std::mutex> lock(engine.mutex_);
                  ready = engine.mediaDirty_ && engine.pendingMediaEpoch_ == engine.activeMediaEpoch_
                      && engine.pendingBackdropChange_; }
                if (ready) { engine.decodePendingMedia(nullptr); return true; }
                std::this_thread::sleep_for(std::chrono::milliseconds(5));
            }
            return false;
        };
        schedule("Current");
        REQUIRE(settled());
        REQUIRE(engine.haveBackdrop_);
        for (unsigned i = 0; i < 2; ++i) {
            resize(!portraitArt);
            engine.repaint();
            if (i == 0) {
                REQUIRE(enteredFuture.wait_for(std::chrono::seconds(5)) == std::future_status::ready);
                engine.decodePendingMedia(nullptr);
                CHECK(engine.haveBackdrop_); // keep outgoing art only while the variant is unresolved
                release.set_value(); released = true;
            } else {
                std::lock_guard<std::mutex> lock(engine.mutex_);
                CHECK(engine.mediaDirty_); // a cached miss is published synchronously too
                CHECK(engine.pendingMediaClear_);
            }
            REQUIRE(settled()); // first a fresh miss, then the same cached miss
            CHECK_FALSE(engine.haveBackdrop_);
            CHECK(engine.pendingMediaClear_);
            for (bool logos : {true, false}) {
                engine.settings.titleLogos = logos; engine.repaint();
                REQUIRE(settled());
                CHECK_FALSE(engine.haveBackdrop_); // logo toggles cannot borrow the other orientation
            }
            resize(portraitArt);
            engine.repaint();
            REQUIRE(settled());
            CHECK(engine.haveBackdrop_);
        }
        CHECK(missingVariantRequests == 2); // one request per logo option; repeated viewport changes use cache
        engine.settings.backdrops = false; engine.repaint();
        REQUIRE(settled());
        CHECK_FALSE(engine.haveBackdrop_); // explicit disabling still clears the presentation
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
            if (work.current) CHECK(work.animateBackdrop);
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
            if (work.current) CHECK(work.animateBackdrop);
        CHECK(engine.info_.title() == L"The Crown (1:00)");
        engine.hwnd_.store(nullptr);
    }
};

TEST_CASE("native coming next consumes queue metadata and rejects empty or stale snapshots") {
    CoverEngineTestAccess test; test.comingNextQueue();
}
TEST_CASE("native resize updates current and queue resolution without downgrading metadata") {
    CoverEngineTestAccess test; test.artworkResize();
}
TEST_CASE("native fullscreen swaps cached viewport artwork without waiting for queued HTTP") {
    bool portraitArt = true, landscapeArt = true;
    SUBCASE("both orientations have artwork") {}
    SUBCASE("portrait-only artwork fades to default in landscape") { landscapeArt = false; }
    SUBCASE("landscape-only artwork fades to default in portrait") { portraitArt = false; }
    CoverEngineTestAccess test; test.viewportCacheHandoff(portraitArt, landscapeArt);
}
TEST_CASE("native viewport misses use the default without discarding the other orientation's cache") {
    bool portraitArt = true;
    SUBCASE("missing landscape variant") {}
    SUBCASE("missing portrait variant") { portraitArt = false; }
    CoverEngineTestAccess test; test.viewportMissUsesDefault(portraitArt);
}
TEST_CASE("native title logos prepare queued images and reuse metadata across toggles and promotion") {
    CoverEngineTestAccess test; test.queuedTitleLogos();
}
TEST_CASE("native same-track UI refinements do not fade the backdrop") {
    CoverEngineTestAccess test; test.mediaTransitionPolicy();
}
TEST_CASE("native logo toggles preserve the backdrop across separate response caches") {
    bool cachedMiss = false;
    auto textArtwork = CoverEngineTestAccess::TextArtwork::Missing;
    SUBCASE("cached response without artwork") { cachedMiss = true; }
    SUBCASE("fresh response without artwork") {}
    SUBCASE("failed resolver request") { textArtwork = CoverEngineTestAccess::TextArtwork::ResolverFailure; }
    SUBCASE("same image URL reuses prepared bytes") { textArtwork = CoverEngineTestAccess::TextArtwork::CachedImage; }
    SUBCASE("failed image request") { textArtwork = CoverEngineTestAccess::TextArtwork::ImageFailure; }
    CoverEngineTestAccess test; test.titleLogoBackdrop(cachedMiss, textArtwork);
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
