// Portable prepared-frame engine. Hosts receive complete immutable presentations;
// networking, metadata normalization, cache and queue scheduling stay off UI threads.
#pragma once
#include "queue_prefetch.h"
#include "media_preparation.h"
#include "../lib/platform_concurrency.h"
#include <map>
#include <memory>

namespace ssc {
struct PreparedPresentation {
    TrackInfo track;
    MediaResult media;
    std::string cover, backdrop, logo;
    std::vector<PreparedRating> ratings;
    bool cacheable = false;
    size_t byteSize() const {
        size_t bytes = cover.size() + backdrop.size() + logo.size();
        for (const auto& rating : ratings) bytes += rating.bytes.size();
        return bytes;
    }
};

class PresentationPipeline {
public:
    using Frame = std::shared_ptr<const PreparedPresentation>;
    using Publish = std::function<void(Frame, bool queued, bool cached, unsigned long long generation)>;
    using Loader = std::function<Frame(const TrackInfo&, const MediaRequest&, const std::atomic<bool>*)>;
    using Queue = std::function<std::vector<TrackInfo>(const std::atomic<bool>*)>;
    PresentationPipeline(Loader load, Queue queue, Publish publish);
    ~PresentationPipeline();
    unsigned long long current(const TrackInfo&, const MediaRequest&);
    // Reprepare the current track and queue with new provider/display options.
    // Hosts retain the visible frame and feed connection; the cache is preserved.
    unsigned long long options(const MediaRequest&);
    // Reprepare only when orientation or resolution class changes; keep the
    // current frame visible until its complete replacement is ready.
    unsigned long long viewport(int width, int height);
    unsigned long long generation();
    void cancel();
    void stop();
private:
    using Clock = std::chrono::steady_clock;
    struct Job {
        TrackInfo track; MediaRequest request; std::string key;
        Clock::time_point due; unsigned long long epoch = 0, order = 0;
        bool current = false, queue = false, firstQueued = false;
        std::shared_ptr<std::atomic<bool>> cancel;
    };
    struct Entry { Frame frame; unsigned long long used = 0; };
    void run();
    void put(const std::string& key, Frame frame);
    unsigned long long enqueueCurrent(); // mutex held
    Loader load_; Queue queue_; Publish publish_;
    platform::Mutex mutex_; platform::ConditionVariable cv_; platform::Thread worker_;
    std::map<std::string, Entry> cache_;
    std::vector<Job> jobs_;
    std::shared_ptr<std::atomic<bool>> cancel_;
    bool stopping_ = false;
    bool hasCurrent_ = false;
    TrackInfo currentTrack_;
    MediaRequest currentRequest_;
    int viewportWidth_ = 0, viewportHeight_ = 0;
    unsigned long long epoch_ = 0, order_ = 0, used_ = 0;
};

// Default loader uses only the portable core. A Frame is published only after
// every requested image has finished preparing; no cover-only intermediate state.
PreparedPresentation preparePresentation(TrackInfo track, MediaRequest options,
    int station, const std::atomic<bool>* cancel = nullptr);
// Independent overlay update: this path never requests cover/backdrop/logo images.
std::vector<PreparedRating> prepareRatings(const TrackInfo& track, MediaRequest options,
    const std::atomic<bool>* cancel = nullptr, const MediaResolver& resolver = MediaResolver());
} // namespace ssc
