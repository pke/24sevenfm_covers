#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include "../../shared/presentation_pipeline.h"
#include <condition_variable>
#include <mutex>
#include <thread>
#include "rating_fixture.h"

namespace {
ssc::TrackInfo track(const char* name) {
    ssc::TrackInfo t; t.album = name; t.track = name; t.artist = "Composer"; return t;
}
ssc::PresentationPipeline::Frame prepared(const ssc::TrackInfo& t) {
    auto frame = std::make_shared<ssc::PreparedPresentation>(); frame->track = t;
    frame->cover = "cover"; frame->backdrop = "backdrop"; frame->logo = "logo";
    frame->cacheable = true; return frame;
}
}
TEST_CASE("rating-only updates cannot reload current artwork") {
    const auto png = ratingFixturePng(); REQUIRE_FALSE(png.empty());
    unsigned requests = 0;
    ssc::MediaResolverConfig config;
    config.transport = [&](const std::string& host, unsigned short, const std::string& path,
        const std::string&, const std::string&, const std::string&, int) {
        ++requests; CHECK(host == config.apiHost);
        ssc::HttpResponse response; response.status = 200;
        if (path.find("/api/media?") == 0) {
            CHECK(path.find("art=0") != std::string::npos);
            response.body = R"({"status":"matched","album":"Film","backdrop":"https://image.tmdb.org/t/p/w1280/never.jpg","source":"tmdb","certifications":[{"country":"DE","system":"FSK","rating":"12","label":"FSK 12"}]})";
        } else {
            CHECK(path.find("/ratings/v1/") == 0); response.body = png;
        }
        return response;
    };
    ssc::MediaRequest request; request.includeArt = true; request.includeTitleLogo = true; request.ratingCountries = "DE";
    const auto assets = ssc::prepareRatings(track("Film"), request, nullptr, ssc::MediaResolver(config));
    REQUIRE(assets.size() == 1); CHECK(assets[0].country == "DE"); CHECK(assets[0].bytes == png); CHECK(requests == 2);
}
TEST_CASE("prefetched media is promoted as one complete cached presentation") {
    std::mutex mutex; std::condition_variable cv;
    int nextLoads = 0; bool nextReady = false, promoted = false, complete = true;
    ssc::PresentationPipeline pipeline(
        [&](const ssc::TrackInfo& t, const ssc::MediaRequest&, const std::atomic<bool>*) {
            std::lock_guard<std::mutex> lock(mutex);
            if (t.album == "B") ++nextLoads;
            return prepared(t);
        },
        [](const std::atomic<bool>*) { return std::vector<ssc::TrackInfo>{track("B")}; },
        [&](ssc::PresentationPipeline::Frame frame, bool queued, bool cached, unsigned long long) {
            std::lock_guard<std::mutex> lock(mutex);
            complete = complete && !frame->cover.empty() && !frame->backdrop.empty() && !frame->logo.empty();
            if (frame->track.album == "B" && queued) nextReady = true;
            if (frame->track.album == "B" && !queued) promoted = cached;
            cv.notify_all();
        });
    ssc::MediaRequest options;
    pipeline.current(track("A"), options);
    {
        std::unique_lock<std::mutex> lock(mutex);
        REQUIRE(cv.wait_for(lock, std::chrono::seconds(3), [&] { return nextReady; }));
    }
    pipeline.current(track("B"), options);
    {
        std::unique_lock<std::mutex> lock(mutex);
        REQUIRE(cv.wait_for(lock, std::chrono::seconds(3), [&] { return promoted; }));
        CHECK(nextLoads == 1); CHECK(complete);
    }
    pipeline.stop();
}
TEST_CASE("a new current track cancels stale preparation before publication") {
    std::mutex mutex; std::condition_variable cv; bool loading = false, published = false, stale = false;
    ssc::PresentationPipeline pipeline(
        [&](const ssc::TrackInfo& t, const ssc::MediaRequest&, const std::atomic<bool>* cancel) {
            if (t.album == "old") {
                { std::lock_guard<std::mutex> lock(mutex); loading = true; cv.notify_all(); }
                while (!cancel->load()) std::this_thread::yield();
            }
            return prepared(t);
        }, [](const std::atomic<bool>*) { return std::vector<ssc::TrackInfo>{}; },
        [&](ssc::PresentationPipeline::Frame frame, bool, bool, unsigned long long) {
            std::lock_guard<std::mutex> lock(mutex);
            stale = stale || frame->track.album == "old"; published = frame->track.album == "new"; cv.notify_all();
        });
    pipeline.current(track("old"), ssc::MediaRequest());
    { std::unique_lock<std::mutex> lock(mutex); REQUIRE(cv.wait_for(lock, std::chrono::seconds(3), [&] { return loading; })); }
    pipeline.current(track("new"), ssc::MediaRequest());
    { std::unique_lock<std::mutex> lock(mutex); REQUIRE(cv.wait_for(lock, std::chrono::seconds(3), [&] { return published; })); CHECK_FALSE(stale); }
    pipeline.stop();
}
TEST_CASE("viewport changes prepare only new artwork classes and reuse cached orientations") {
    std::mutex mutex; std::condition_variable cv;
    int loads = 0, publications = 0; bool cached = false; ssc::MediaRequest loaded;
    ssc::PresentationPipeline pipeline(
        [&](const ssc::TrackInfo& t, const ssc::MediaRequest& request, const std::atomic<bool>*) {
            std::lock_guard<std::mutex> lock(mutex); ++loads; loaded = request; return prepared(t);
        }, [](const std::atomic<bool>*) { return std::vector<ssc::TrackInfo>{}; },
        [&](ssc::PresentationPipeline::Frame, bool, bool hit, unsigned long long) {
            std::lock_guard<std::mutex> lock(mutex); cached = hit; ++publications; cv.notify_all();
        });
    auto wait = [&](int count) {
        std::unique_lock<std::mutex> lock(mutex);
        return cv.wait_for(lock, std::chrono::seconds(3), [&] { return publications >= count; });
    };
    pipeline.viewport(600, 900); pipeline.current(track("Film"), ssc::MediaRequest());
    REQUIRE(wait(1)); CHECK(ssc::wantsPortraitArtwork(loaded));
    auto generation = pipeline.generation();
    CHECK(pipeline.viewport(620, 920) == generation);
    pipeline.viewport(1000, 600); REQUIRE(wait(2)); CHECK_FALSE(ssc::wantsPortraitArtwork(loaded));
    CHECK(loads == 2);
    pipeline.viewport(600, 900); REQUIRE(wait(3)); CHECK(cached); CHECK(loads == 2);
    pipeline.viewport(2100, 1200); REQUIRE(wait(4)); CHECK(ssc::wants4kArtwork(loaded)); CHECK(loads == 3);
    pipeline.stop();
}
TEST_CASE("provider changes reprepare the current track and retain cached artwork variants") {
    std::mutex mutex; std::condition_variable cv;
    int loads = 0, publications = 0; bool cached = false;
    ssc::MediaRequest loaded; ssc::PresentationPipeline::Frame shown, original;
    ssc::PresentationPipeline pipeline(
        [&](const ssc::TrackInfo& t, const ssc::MediaRequest& request, const std::atomic<bool>*) {
            std::lock_guard<std::mutex> lock(mutex); ++loads; loaded = request;
            auto frame = std::make_shared<ssc::PreparedPresentation>(*prepared(t));
            frame->logo = request.providers; return frame;
        }, [](const std::atomic<bool>*) { return std::vector<ssc::TrackInfo>{}; },
        [&](ssc::PresentationPipeline::Frame frame, bool queued, bool hit, unsigned long long) {
            if (queued) return;
            std::lock_guard<std::mutex> lock(mutex); shown = frame; cached = hit;
            ++publications; cv.notify_all();
        });
    auto wait = [&](int count) {
        std::unique_lock<std::mutex> lock(mutex);
        return cv.wait_for(lock, std::chrono::seconds(3), [&] { return publications >= count; });
    };
    ssc::MediaRequest options; options.providers = "fanart,tmdb"; options.includeTitleLogo = true;
    CHECK(pipeline.options(options) == 0);
    pipeline.viewport(600, 900); pipeline.current(track("Film"), options);
    REQUIRE(wait(1)); original = shown;
    auto generation = pipeline.generation();
    CHECK(pipeline.options(options) == generation);
    options.providers = "tmdb"; options.width = 1000; options.height = 600;
    CHECK(pipeline.options(options) > generation);
    REQUIRE(wait(2)); CHECK_FALSE(cached); CHECK(loads == 2);
    CHECK(shown->track.album == "Film"); CHECK(shown->logo == "tmdb");
    CHECK(ssc::wantsPortraitArtwork(loaded)); // actual viewport wins over stale host dimensions
    options.providers = "fanart,tmdb";
    pipeline.options(options); REQUIRE(wait(3)); CHECK(cached); CHECK(loads == 2);
    CHECK(shown == original); // restore the complete prepared frame, without another download
    pipeline.stop();
}
