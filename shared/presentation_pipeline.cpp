#include "presentation_pipeline.h"
#include "stations.h"
#include "../lib/image_probe.h"
#include <algorithm>

namespace ssc {
std::vector<PreparedRating> prepareRatings(const TrackInfo& track, MediaRequest options,
    const std::atomic<bool>* cancel, const MediaResolver& resolver) {
    if ((cancel && cancel->load()) || track.stationIdent || track.album.empty()) return {};
    options = requestForTrack(track, options);
    options.includeArt = false; options.includeTitleLogo = false; options.includeRatings = true;
    return MediaPreparation(resolver).ratings(resolver.resolve(options, cancel), options, cancel);
}
PresentationPipeline::PresentationPipeline(Loader load, Queue queue, Publish publish)
    : load_(std::move(load)), queue_(std::move(queue)), publish_(std::move(publish)) {
    worker_ = platform::Thread([this] { run(); });
}
PresentationPipeline::~PresentationPipeline() { stop(); }
void PresentationPipeline::cancel() {
    platform::LockGuard lock(mutex_);
    stopping_ = true;
    if (cancel_) cancel_->store(true);
    jobs_.clear(); cv_.notify_all();
}
void PresentationPipeline::stop() {
    cancel(); if (worker_.joinable()) worker_.join();
}
unsigned long long PresentationPipeline::generation() {
    platform::LockGuard lock(mutex_); return epoch_;
}
unsigned long long PresentationPipeline::current(const TrackInfo& track, const MediaRequest& request) {
    platform::LockGuard lock(mutex_);
    if (stopping_) return 0;
    currentTrack_ = track; currentRequest_ = request; hasCurrent_ = true;
    if (viewportWidth_ > 0 && viewportHeight_ > 0) {
        currentRequest_.width = viewportWidth_; currentRequest_.height = viewportHeight_;
    }
    return enqueueCurrent();
}
unsigned long long PresentationPipeline::options(const MediaRequest& request) {
    platform::LockGuard lock(mutex_);
    if (stopping_) return epoch_;
    const auto previous = currentRequest_;
    currentRequest_ = request;
    if (viewportWidth_ > 0 && viewportHeight_ > 0) {
        currentRequest_.width = viewportWidth_; currentRequest_.height = viewportHeight_;
    }
    if (!hasCurrent_ || mediaCacheKey(currentTrack_, previous) == mediaCacheKey(currentTrack_, currentRequest_))
        return epoch_;
    return enqueueCurrent();
}
unsigned long long PresentationPipeline::viewport(int width, int height) {
    platform::LockGuard lock(mutex_);
    if (stopping_ || width <= 0 || height <= 0) return epoch_;
    viewportWidth_ = std::min(width, 8192); viewportHeight_ = std::min(height, 8192);
    const auto previous = currentRequest_;
    currentRequest_.width = viewportWidth_; currentRequest_.height = viewportHeight_;
    if (!hasCurrent_ || (wantsPortraitArtwork(previous) == wantsPortraitArtwork(currentRequest_)
        && wants4kArtwork(previous) == wants4kArtwork(currentRequest_))) return epoch_;
    return enqueueCurrent();
}
unsigned long long PresentationPipeline::enqueueCurrent() {
    if (cancel_) cancel_->store(true);
    cancel_ = std::make_shared<std::atomic<bool>>(false);
    jobs_.clear(); ++epoch_;
    Job current;
    current.track = currentTrack_; current.request = currentRequest_; current.key = mediaCacheKey(currentTrack_, currentRequest_);
    current.epoch = epoch_; current.cancel = cancel_; current.current = true;
    current.order = ++order_; current.due = Clock::now(); jobs_.push_back(current);
    Job queue = current; queue.current = false; queue.queue = true; queue.order = ++order_;
    jobs_.push_back(std::move(queue)); cv_.notify_all(); return epoch_;
}
void PresentationPipeline::put(const std::string& key, Frame frame) {
    if (!frame || !frame->cacheable) return;
    Entry entry; entry.frame = frame; entry.used = ++used_; cache_[key] = std::move(entry);
    // Queue credits can be absent in the raw snapshot. Cache the enriched identity
    // as well so the live feed can reuse its prefetched result when Artist arrives.
    trimMediaCache(cache_);
    const size_t budget = 128u * 1024u * 1024u;
    for (;;) {
        size_t total = 0;
        for (const auto& value : cache_) total += value.second.frame->byteSize();
        if (total <= budget || cache_.empty()) break;
        trimMediaCache(cache_, cache_.size() - 1);
    }
}
void PresentationPipeline::run() {
    for (;;) {
        Job job;
        Frame frame;
        {
            platform::UniqueLock lock(mutex_);
            for (;;) {
                if (stopping_) return;
                if (jobs_.empty()) { cv_.wait(lock); continue; }
                auto first = std::min_element(jobs_.begin(), jobs_.end(), [](const Job& a, const Job& b) {
                    return a.due < b.due || (a.due == b.due && a.order < b.order);
                });
                if (first->due > Clock::now()) { cv_.wait_until(lock, first->due); continue; }
                job = std::move(*first); jobs_.erase(first);
                if (!job.queue) {
                    auto cached = cache_.find(job.key);
                    if (cached != cache_.end()) { cached->second.used = ++used_; frame = cached->second.frame; }
                }
                break;
            }
        }
        if (job.cancel->load()) continue;
        if (job.queue) {
            const auto queue = queue_(job.cancel.get());
            if (job.cancel->load()) continue;
            const auto plan = planQueueMedia(queue, job.request);
            platform::LockGuard lock(mutex_);
            if (stopping_ || job.epoch != epoch_) continue;
            bool first = true;
            for (const auto& planned : plan) {
                Job pending; pending.track = planned.track; pending.request = planned.request; pending.key = planned.key;
                pending.cancel = job.cancel; pending.epoch = job.epoch; pending.order = ++order_;
                pending.firstQueued = first; first = false;
                pending.due = Clock::now() + std::chrono::milliseconds(planned.delayMs);
                jobs_.push_back(std::move(pending));
            }
            cv_.notify_all(); continue;
        }
        const bool cached = (bool)frame;
        if (!frame) frame = load_(job.track, job.request, job.cancel.get());
        if (!frame || job.cancel->load()) continue;
        {
            platform::LockGuard lock(mutex_);
            if (stopping_ || job.epoch != epoch_) continue;
            if (!cached) {
                put(job.key, frame);
                const auto enrichedKey = mediaCacheKey(frame->track, job.request);
                if (enrichedKey != job.key) put(enrichedKey, frame);
            }
        }
        // The host must still validate its session/generation at UI dispatch.
        if (job.current || job.firstQueued) publish_(frame, !job.current, cached, job.epoch);
    }
}

PreparedPresentation preparePresentation(TrackInfo track, MediaRequest options, int stationIndex,
    const std::atomic<bool>* cancel) {
    PreparedPresentation result;
    const auto cancelled = [&] { return cancel && cancel->load(); };
    if (cancelled()) return result;
    const auto& stationInfo = station(stationIndex);
    MediaResolver resolver;
    MediaPreparation preparation(resolver);
    track = preparation.enrichCredit(track, stationInfo.host, cancel);
    result.track = track;
    options = requestForTrack(track, options);
    if (!track.stationIdent && !track.album.empty()) result.media = resolver.resolve(options, cancel);
    if (cancelled()) return result;
    result.cover = preparation.cover(track.coverUrl, stationIndex, 12, cancel);
    if (cancelled()) return result;
    if (options.includeArt && result.media.hasBackdrop()) {
        result.backdrop = preparation.backdrop(result.media, cancel);
    }
    if (options.includeTitleLogo && !result.media.titleLogoUrl.empty()) {
        result.logo = preparation.logo(result.media, cancel);
    }
    result.ratings = preparation.ratings(result.media, options, cancel);
    result.cacheable = !cancelled() && !result.cover.empty()
        && (track.stationIdent || result.media.status != MediaResult::Failure)
        && (!options.includeArt || !result.media.hasBackdrop() || !result.backdrop.empty());
    return result;
}
} // namespace ssc
