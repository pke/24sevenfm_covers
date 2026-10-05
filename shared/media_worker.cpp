#include "media_worker.h"
#include "../lib/image_probe.h"
#include "../lib/diagnostics.h"

namespace ssc {
void cacheMedia(MediaWorkerState* state, const std::string& key,
                const ssc::TrackInfo& track, const ssc::MediaRequest& request,
                const ssc::MediaResult& result, const std::string& bytes) {
    MediaWorkerState::CacheEntry entry;
    entry.track = track; entry.request = request; entry.result = result;
    entry.bytes = bytes; entry.used = ++state->lru;
    state->cache[key] = std::move(entry);
    ssc::trimMediaCache(state->cache);
}

// Caller holds the worker mutex. Only decoded-safe image hits can replace art;
// metadata/rating/logo-only hits must not hide a usable backdrop in another entry.
bool cachedBackdrop(MediaWorkerState* state, const ssc::TrackInfo& track,
                    const ssc::MediaRequest& request,
                    MediaWorkerState::CacheEntry& result,
                    const std::string* url) {
    MediaWorkerState::CacheEntry* newest = nullptr;
    for (auto& entry : state->cache) {
        auto& candidate = entry.second;
        if (candidate.track.album == track.album && candidate.track.track == track.track
                && sameBackdropConfig(candidate.request, request)
                && candidate.result.hasBackdrop() && !candidate.bytes.empty()
                && (!url || candidate.result.backdropUrl == *url)
                && (!newest || candidate.used > newest->used)) newest = &candidate;
    }
    if (!newest) return false;
    newest->used = ++state->lru;
    result = *newest;
    return true;
}

std::vector<PreparedRating> cachedRatings(const MediaResult& result, const RatingAssetCache& cache) {
    std::vector<PreparedRating> out;
    for (const auto& cert : result.certifications) {
        PreparedRating asset; asset.country = cert.country; asset.bytes = cache.find(cert); asset.certification = cert;
        out.push_back(std::move(asset));
    }
    return out;
}
void runMediaWorker(MediaWorkerState* state, const MediaWorkerCallbacks& callbacks) {
    for (;;) {
        MediaWorkerState::Work item;
        {
            ssc::platform::UniqueLock lock(state->mutex);
            for (;;) {
                if (state->stopping) return;
                if (state->work.empty()) {
                    state->cv.wait(lock);
                    continue;
                }
                size_t best = 0;
                for (size_t i = 1; i < state->work.size(); ++i) {
                    if (state->work[i].due < state->work[best].due
                            || (state->work[i].due == state->work[best].due
                                && state->work[i].order < state->work[best].order)) best = i;
                }
                const MediaWorkerState::Clock::time_point now = MediaWorkerState::Clock::now();
                if (state->work[best].due > now) {
                    state->cv.wait_until(lock, state->work[best].due);
                    continue;
                }
                item = std::move(state->work[best]);
                state->work.erase(state->work.begin() + best);
                break;
            }
        }
        if (!item.cancel || item.cancel->load()) continue;

        if (item.kind == MediaWorkerState::Work::Ratings) {
            bool ready = true;
            bool changed = false;
            for (const auto& cert : item.result->certifications) {
                if (item.cancel->load()) break;
                if (!ssc::ratingAssets().find(cert).empty()) continue;
                const bool loaded = ssc::ratingAssets().load(cert, state->resolver, item.cancel.get());
                changed = changed || loaded;
                ready = ready && loaded;
            }
            if ((ready || changed) && item.current && !item.cancel->load())
                callbacks.publishRatings(item.epoch, cachedRatings(*item.result));
            if (!ready && !item.cancel->load() && item.attempt < 2) {
                item.due = MediaWorkerState::Clock::now() + std::chrono::seconds(++item.attempt * 30);
                ssc::platform::LockGuard lock(state->mutex);
                if (!state->stopping && item.epoch == state->epoch) {
                    item.order = ++state->order;
                    state->work.push_back(std::move(item));
                    state->cv.notify_all();
                }
            }
            continue;
        }
        const auto queueRatingAssets = [&](const ssc::MediaResult& result) {
            if (!item.request.includeRatings || result.certifications.empty()) return;
            bool missing = false;
            for (const auto& cert : result.certifications)
                missing = missing || ssc::ratingAssets().find(cert).empty();
            if (!missing) return;
            if (item.current) callbacks.publishRatings(item.epoch, cachedRatings(result));
            auto work = item;
            work.kind = MediaWorkerState::Work::Ratings;
            work.result = std::make_shared<ssc::MediaResult>(result);
            work.attempt = 0;
            work.due = MediaWorkerState::Clock::now() + std::chrono::milliseconds(50);
            ssc::platform::LockGuard lock(state->mutex);
            if (state->stopping || item.epoch != state->epoch) return;
            for (const auto& pending : state->work)
                if (pending.kind == MediaWorkerState::Work::Ratings && pending.epoch == item.epoch
                        && pending.key == item.key) return;
            work.order = ++state->order;
            state->work.push_back(std::move(work));
            state->cv.notify_all();
        };

        const auto prepareTitleLogo = [&](const ssc::MediaResult& result) {
            if (!item.request.includeArt) return;
            std::string bytes;
            bool cacheHit = false;
            if (!result.titleLogoUrl.empty()) {
                {
                    ssc::platform::LockGuard lock(state->mutex);
                    const auto found = state->titleLogoCache.find(result.titleLogoUrl);
                    if (found != state->titleLogoCache.end()) {
                        bytes = found->second;
                        cacheHit = !bytes.empty();
                    }
                }
                if (bytes.empty()) bytes = MediaPreparation(state->resolver).logo(result, item.cancel.get());
                if (!cacheHit && !bytes.empty() && !item.cancel->load()) {
                    ssc::platform::LockGuard lock(state->mutex);
                    state->titleLogoCache[result.titleLogoUrl] = bytes;
                    while (state->titleLogoCache.size() > ssc::kQueuedTrackStoreLimit)
                        state->titleLogoCache.erase(state->titleLogoCache.begin());
                } else if (bytes.empty() || !ssc::decodableImage(bytes, result.titleLogoUrl)) bytes.clear();
            }
            if (item.current && !item.cancel->load())
                callbacks.publishTitleLogo(item.epoch, bytes, result.album,
                                 item.immediateCachedTitleLogo
                                     && cacheHit && !bytes.empty());
        };

        if (item.kind == MediaWorkerState::Work::Cycle) {
            std::string bytes;
            for (unsigned attempt = 0; attempt < 3 && !item.cancel->load(); ++attempt) {
                if (!callbacks.selectionCurrent(item.epoch, item.selection)) break;
                bytes = MediaPreparation(state->resolver).backdrop(*item.result, item.cancel.get());
                if (!bytes.empty()) break;
                bytes.clear();
            }
            if (!item.cancel->load()) callbacks.publishCycledBackdrop(item.epoch, item.selection, bytes, *item.result);
            continue;
        }
        if (item.kind == MediaWorkerState::Work::Resolve) {
            // Queue rows can omit composer credit. Use the same project-owned
            // credit endpoint as web before resolving, never scrape arbitrary URLs.
            if (!item.current) item.track = MediaPreparation(state->resolver).enrichCredit(
                item.track, item.creditHost, item.cancel.get());
            if (item.cancel->load()) continue;
            item.request = requestForTrack(item.track, item.request);
            item.key = ssc::mediaCacheKey(item.track, item.request);

            MediaWorkerState::CacheEntry cached;
            MediaWorkerState::CacheEntry cachedFallback;
            bool haveCached = false;
            bool haveCachedFallback = false;
            if (!item.reload) {
                ssc::platform::LockGuard lock(state->mutex);
                std::map<std::string, MediaWorkerState::CacheEntry>::iterator it = state->cache.find(item.key);
                if (it != state->cache.end()) {
                    it->second.used = ++state->lru;
                    cached = it->second;
                    haveCached = true;
                }
                if (item.current && haveCached && cached.bytes.empty())
                    haveCachedFallback = cachedBackdrop(state, item.track, item.request, cachedFallback);
            }
            if (haveCached) {
                queueRatingAssets(cached.result.certifications.empty() && haveCachedFallback
                    ? cachedFallback.result : cached.result);
#if SSC_ENABLE_DEBUG_OVERLAY
                ssc::DiagnosticLog::instance().event("cache.media.hit", item.track);
#endif
                if (item.current) callbacks.publishMetadata(item.epoch, cached.result, item.track.lengthSeconds);
                else callbacks.publishQueuedMetadata(item.epoch, item.track, cached.result);
                prepareTitleLogo(haveCachedFallback
                    && sameResolverConfig(cachedFallback.request, item.request)
                    ? cachedFallback.result : cached.result);
                if (item.current && !item.backdropPublished) {
                    if (haveCachedFallback) {
                        const auto& ratings = cached.result.certifications.empty() ? cachedFallback.result : cached.result;
                        callbacks.publishMedia(item.epoch, cachedFallback.bytes, cachedRatings(ratings), false,
                                     &cachedFallback.result, item.animateBackdrop);
                    } else {
                        callbacks.publishMedia(item.epoch, cached.bytes, cachedRatings(cached.result), false,
                                     &cached.result, item.animateBackdrop);
                    }
                }
                continue;
            }

            ssc::MediaResult resolved = state->resolver.resolve(item.request, item.cancel.get());
            if (item.cancel->load()) continue;
            if (!item.current) callbacks.publishQueuedMetadata(item.epoch, item.track, resolved);
            if (resolved.status == ssc::MediaResult::Failure) {
                // A current-track refinement must not erase an already prepared
                // queue hit. Failures remain uncached and retry on the feed cadence.
                if (item.current) {
                    // The resolver retains the validated stream metadata when
                    // /api/media cannot provide its normalized form. Show that
                    // fallback instead of leaving native clients without a title.
                    callbacks.publishMetadata(item.epoch, resolved, item.track.lengthSeconds);
                    MediaWorkerState::CacheEntry fallback;
                    bool haveFallback = false;
                    {
                        ssc::platform::LockGuard lock(state->mutex);
                        haveFallback = cachedBackdrop(state, item.track, item.request, fallback);
                    }
                    if (haveFallback) {
                        queueRatingAssets(fallback.result);
                        if (sameResolverConfig(fallback.request, item.request))
                            prepareTitleLogo(fallback.result);
                        callbacks.publishMedia(item.epoch, fallback.bytes, cachedRatings(fallback.result), false,
                                     &fallback.result, item.animateBackdrop);
                    }
                }
                const unsigned failure = item.attempt + 1;
                item.attempt = failure;
                item.due = MediaWorkerState::Clock::now()
                    + std::chrono::milliseconds(item.current
                        ? ssc::stationRetryDelayMs(failure) : 60000);
                ssc::platform::LockGuard lock(state->mutex);
                if (!state->stopping && item.epoch == state->epoch) {
                    item.order = ++state->order;
                    state->work.push_back(std::move(item));
                    state->cv.notify_all();
                }
                continue;
            }
            if (item.current)
                callbacks.publishMetadata(item.epoch, resolved, item.track.lengthSeconds);
            queueRatingAssets(resolved);
            prepareTitleLogo(resolved);
            if (item.cancel->load()) continue;

            if (resolved.status == ssc::MediaResult::Miss || !resolved.hasBackdrop()) {
                MediaWorkerState::CacheEntry fallback;
                bool haveFallback = false;
                if (item.current) {
                    ssc::platform::LockGuard lock(state->mutex);
                    haveFallback = cachedBackdrop(state, item.track, item.request, fallback);
                }
                {
                    ssc::platform::LockGuard lock(state->mutex);
                    cacheMedia(state, item.key, item.track, item.request, resolved, std::string());
                }
                if (item.current) {
                    if (haveFallback) {
                        if (resolved.titleLogoUrl.empty()
                                && sameResolverConfig(fallback.request, item.request))
                            prepareTitleLogo(fallback.result);
                        const auto& ratings = resolved.certifications.empty() ? fallback.result : resolved;
                        callbacks.publishMedia(item.epoch, fallback.bytes, cachedRatings(ratings), false,
                                     &fallback.result, item.animateBackdrop);
                    } else {
                        callbacks.publishMedia(item.epoch, std::string(), cachedRatings(resolved), false,
                                     nullptr, item.animateBackdrop);
                    }
                }
                continue;
            }

            if (item.current) {
                // Ratings are independent of art loading. Reveal them as soon
                // as the resolver is authoritative; the backdrop can still use
                // its own bounded image retry sequence.
                callbacks.publishRatings(item.epoch, cachedRatings(resolved));
            }
            MediaWorkerState::Work image = std::move(item);
            image.kind = MediaWorkerState::Work::Download;
            image.result = std::make_shared<ssc::MediaResult>(std::move(resolved));
            image.attempt = 0;
            // Finish the current item as one transaction before another due
            // queue resolver can occupy the single network lane for 20 seconds.
            image.due = MediaWorkerState::Clock::now() - std::chrono::hours(1);
            {
                ssc::platform::LockGuard lock(state->mutex);
                if (!state->stopping && image.epoch == state->epoch) {
                    image.order = ++state->order;
                    state->work.push_back(std::move(image));
                    state->cv.notify_all();
                }
            }
            continue;
        }

        std::string bytes;
        if (!item.reload) {
            ssc::platform::LockGuard lock(state->mutex);
            MediaWorkerState::CacheEntry prepared;
            if (cachedBackdrop(state, item.track, item.request, prepared, &item.result->backdropUrl))
                bytes = prepared.bytes;
        }
        if (bytes.empty()) bytes = MediaPreparation(state->resolver).backdrop(*item.result, item.cancel.get());
        const bool downloaded = !bytes.empty();
        if (item.cancel->load()) continue;
        if (!downloaded) {
            const unsigned failure = item.attempt + 1;
            const int delay = ssc::backdropImageRetryDelayMs(failure);
            if (delay >= 0) {
                item.attempt = failure;
                item.due = MediaWorkerState::Clock::now() + std::chrono::milliseconds(delay);
                ssc::platform::LockGuard lock(state->mutex);
                if (!state->stopping && item.epoch == state->epoch) {
                    item.order = ++state->order;
                    state->work.push_back(std::move(item));
                    state->cv.notify_all();
                }
            } else if (item.current) {
                MediaWorkerState::CacheEntry fallback;
                bool haveFallback;
                {
                    ssc::platform::LockGuard lock(state->mutex);
                    haveFallback = cachedBackdrop(state, item.track, item.request, fallback);
                }
                callbacks.publishMedia(item.epoch, haveFallback ? fallback.bytes : std::string(),
                             cachedRatings(*item.result), true,
                             haveFallback ? &fallback.result : nullptr, item.animateBackdrop);
            }
            continue;
        }

        {
            ssc::platform::LockGuard lock(state->mutex);
            cacheMedia(state, item.key, item.track, item.request, *item.result, bytes);
        }
        if (item.current)
            callbacks.publishMedia(item.epoch, bytes, cachedRatings(*item.result), false,
                         item.result.get(), item.animateBackdrop);
    }
}

} // namespace ssc
