// Platform-independent queue planning and LRU eviction for native renderers.
#pragma once
#include "../lib/media_policy.h"
#include "media_preparation.h"
#include <vector>

namespace ssc {
struct QueuedMediaWork {
    TrackInfo track;
    MediaRequest request;
    std::string key;
    long long delayMs = 0;
};
inline std::vector<QueuedMediaWork> planQueueMedia(const std::vector<TrackInfo>& queue, const MediaRequest& options) {
    std::vector<QueuedMediaWork> plan;
    for (size_t i = 0; i < queue.size() && i < kQueuedTrackStoreLimit; ++i) {
        if (queue[i].album.empty() || queue[i].stationIdent) continue;
        QueuedMediaWork work;
        work.track = queue[i]; work.request = requestForTrack(work.track, options);
        work.key = mediaCacheKey(work.track, work.request);
        work.delayMs = queuePrefetchDelayMs(i);
        plan.push_back(std::move(work));
    }
    return plan;
}
template<class Map>
void trimMediaCache(Map& cache, size_t maximum = kQueuedTrackStoreLimit) {
    while (cache.size() > maximum) {
        auto oldest = cache.begin();
        for (auto it = cache.begin(); it != cache.end(); ++it)
            if (it->second.used < oldest->second.used) oldest = it;
        cache.erase(oldest);
    }
}
} // namespace ssc
