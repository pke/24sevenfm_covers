#pragma once
#include "media_preparation.h"
#include "rating_assets.h"
#include "queue_prefetch.h"
#include <memory>

namespace ssc {
struct MediaWorkerState {
    typedef std::chrono::steady_clock Clock;
    struct CacheEntry {
        ssc::TrackInfo track;
        ssc::MediaRequest request;
        ssc::MediaResult result;
        std::string bytes;
        unsigned long long used = 0;
    };
    struct Work {
        enum Kind { Resolve, Download, Cycle, Ratings } kind = Resolve;
        unsigned long long selection = 0;
        Clock::time_point due;
        unsigned long long order = 0;
        unsigned long long epoch = 0;
        unsigned attempt = 0;
        bool current = false;
        bool reload = false;
        ssc::TrackInfo track;
        ssc::MediaRequest request;
        // Resolve jobs carry no result. Only image/rating/cycle jobs allocate
        // a payload; retry/move/queue operations share that owned result.
        std::shared_ptr<ssc::MediaResult> result;
        std::string key, creditHost;
        bool animateBackdrop = true;
        bool backdropPublished = false;
        bool immediateCachedTitleLogo = false;
        std::shared_ptr<std::atomic<bool> > cancel;
    };

    ssc::platform::Mutex mutex;
    ssc::platform::ConditionVariable cv;
    ssc::platform::Thread thread;
    bool stopping = false;
    unsigned long long epoch = 0, order = 0, lru = 0;
    std::shared_ptr<std::atomic<bool> > cancel;
    std::vector<Work> work;
    std::map<std::string, CacheEntry> cache;
    std::map<std::string, std::string> titleLogoCache; // decoded-safe bytes, bounded like queue art
    ssc::TrackInfo current;
    std::vector<ssc::TrackInfo> queue;
    bool queueSnapshotReady = false;
    ssc::MediaRequest request;
    ssc::MediaResolver resolver;
};

struct MediaWorkerCallbacks {
    std::function<void(unsigned long long, const std::vector<PreparedRating>&)> publishRatings;
    std::function<void(unsigned long long, const std::string&, const std::string&, bool)> publishTitleLogo;
    std::function<void(unsigned long long, unsigned long long, const std::string&, const MediaResult&)> publishCycledBackdrop;
    std::function<void(unsigned long long, const MediaResult&, int)> publishMetadata;
    std::function<void(unsigned long long, const TrackInfo&, const MediaResult&)> publishQueuedMetadata;
    std::function<void(unsigned long long, const std::string&, const std::vector<PreparedRating>&,
        bool, const MediaResult*, bool)> publishMedia;
    std::function<bool(unsigned long long, unsigned long long)> selectionCurrent;
};
// Caller owns lifetime and serialized scheduling. Callbacks run outside the work
// mutex; publication adapters must reject stale epochs again at UI dispatch.
void runMediaWorker(MediaWorkerState*, const MediaWorkerCallbacks&);
void cacheMedia(MediaWorkerState*, const std::string&, const TrackInfo&, const MediaRequest&,
    const MediaResult&, const std::string&);
bool cachedBackdrop(MediaWorkerState*, const TrackInfo&, const MediaRequest&,
    MediaWorkerState::CacheEntry&, const std::string* url = nullptr);
std::vector<PreparedRating> cachedRatings(const MediaResult&, const RatingAssetCache& cache = ratingAssets());
} // namespace ssc
