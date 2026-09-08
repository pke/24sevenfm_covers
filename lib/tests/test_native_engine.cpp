#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include <future>
#include "../../shared/cover_engine.cpp"

// Exercise the production scheduler/publication path without starting network or
// a GPU window. The real renderer's byte/ratings setters do not require a device.
struct CoverEngineTestAccess {
    CoverEngine engine;
    CoverEngineTestAccess() {
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
        CHECK(engine.infoTitle_.empty());
        CHECK(engine.infoArtist_.empty());
        CHECK_FALSE(engine.mediaDirty_);
        CHECK_FALSE(engine.haveBackdrop_);
        CHECK_FALSE(engine.ratingHasContent_);
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
            else engine.publishRatings(epoch, std::vector<d2d::RatingBadge>(1));
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
        CHECK(engine.infoTitle_ == L"Old album (1:00)");
        CHECK(engine.mediaDirty_);
        engine.decodePendingMedia(nullptr);
        CHECK(engine.ratingHasContent_);
        CHECK(engine.ratingIntroEpoch_ == fresh);
    }
};

TEST_CASE("native blocked publishers validate the epoch inside the publication lock") {
    CoverEngineTestAccess test;
    SUBCASE("metadata") { test.blockedPublication(0); }
    SUBCASE("artwork") { test.blockedPublication(1); }
    SUBCASE("ratings") { test.blockedPublication(2); }
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
