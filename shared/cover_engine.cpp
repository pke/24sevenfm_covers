// cover_engine.cpp - see header. Host-agnostic; talks only to the shared Direct2D
// renderer, the CoverMonitor library, and an HWND. Ported from the Winamp plugin so
// both hosts share identical cover/preload/animation behaviour.
#include "cover_engine.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <map>
#include <memory>
#include <thread>
#include <vector>

#include "coverfetch.h"
#include "http_client.h"
#include "image_probe.h"
#include "media_policy.h"
#include "media_resolver.h"
#include "stations.h"

// --- logging ----------------------------------------------------------------
// Diagnostics are OFF in production and have no UI toggle. Both the %TEMP% file AND
// OutputDebugString stay silent unless a sentinel file exists next to where the log
// would go: %TEMP%\<base>.log.enable. Support drops that file, restarts the host,
// reproduces, then sends %TEMP%\<base>.log. When enabled, the file is capped at 1 MB
// with one rolled generation (<base>.log.1), so it can never grow without bound.
namespace {
std::mutex g_logMutex;
// Log basename, shared by the OutputDebugString tag and the %TEMP% file. Each host
// overrides it (CoverEngine::setLogName) so Winamp / foobar / the viewer write to
// distinct files instead of interleaving into one. Set once at startup.
std::string g_logBase = "24seven.fm-covers";
bool g_logEnabled  = false;  // resolved once from the sentinel (see logEnabled)
bool g_logResolved = false;

std::string tempDir() { char t[MAX_PATH] = {0}; GetTempPathA(MAX_PATH, t); return t; }

// Enabled iff the per-host sentinel file exists. Resolved once and cached - the tech
// drops the file and restarts the host, so there is no need to re-probe per line.
bool logEnabled() {
    if (!g_logResolved) {
        const std::string sentinel = tempDir() + g_logBase + ".log.enable";
        g_logEnabled  = GetFileAttributesA(sentinel.c_str()) != INVALID_FILE_ATTRIBUTES;
        g_logResolved = true;
    }
    return g_logEnabled;
}

// 1 MB cap, single generation: at the cap, move <base>.log to <base>.log.1 (replacing
// any previous roll) and start fresh. Bounds total on-disk size at ~2 MB.
void rotateIfLarge(const std::string& path) {
    WIN32_FILE_ATTRIBUTE_DATA fad;
    if (!GetFileAttributesExA(path.c_str(), GetFileExInfoStandard, &fad)) return;
    const ULONGLONG size = ((ULONGLONG)fad.nFileSizeHigh << 32) | fad.nFileSizeLow;
    if (size < (1ull << 20)) return;
    const std::string prev = path + ".1";
    DeleteFileA(prev.c_str());               // MoveFileA won't overwrite an existing dest
    MoveFileA(path.c_str(), prev.c_str());
}

void logLine(const std::string& msg) {
    std::lock_guard<std::mutex> lock(g_logMutex);
    if (!logEnabled()) return;               // prod default: no file, no OutputDebugString
    OutputDebugStringA(("[" + g_logBase + "] " + msg + "\n").c_str());
    const std::string path = tempDir() + g_logBase + ".log";
    rotateIfLarge(path);
    HANDLE h = CreateFileA(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ, nullptr,
                           OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h != INVALID_HANDLE_VALUE) {
        const std::string line = msg + "\r\n";
        DWORD written = 0;
        WriteFile(h, line.data(), (DWORD)line.size(), &written, nullptr);
        CloseHandle(h);
    }
}

// UTF-8 (the station feed's encoding) -> UTF-16 for DirectWrite (poster info box).
std::wstring toWide(const std::string& s) {
    if (s.empty()) return std::wstring();
    int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
    if (n <= 0) return std::wstring();
    std::wstring w((size_t)n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), &w[0], n);
    return w;
}

std::vector<d2d::RatingBadge> ratingBadges(const ssc::MediaResult& result) {
    std::vector<d2d::RatingBadge> out;
    for (size_t i = 0; i < result.certifications.size(); ++i) {
        const ssc::Certification& c = result.certifications[i];
        d2d::RatingBadge badge;
        badge.country = toWide(c.country);
        badge.system = toWide(c.system);
        badge.rating = toWide(c.rating);
        badge.label = toWide(c.label);
        for (size_t j = 0; j < c.descriptors.size(); ++j) {
            if (j) badge.descriptors += L", ";
            badge.descriptors += toWide(c.descriptors[j]);
        }
        out.push_back(badge);
    }
    return out;
}

bool clientAnimationsEnabled() {
    BOOL enabled = TRUE;
    return !SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &enabled, 0) || enabled;
}

// Downloads a cover image. Windows goes over HTTPS:443 (WinHTTP/TLS); the station
// also serves the images on plain HTTP:80, which the socket path uses elsewhere.
std::string downloadCover(const std::string& url, const std::atomic<bool>* cancel = nullptr) {
    std::string rest = url;
    const auto scheme = rest.find("://");
    if (scheme != std::string::npos)
        rest = rest.substr(scheme + 3);
    const auto slash = rest.find('/');
    const std::string host = (slash == std::string::npos) ? rest : rest.substr(0, slash);
    const std::string path = (slash == std::string::npos) ? "/" : rest.substr(slash);
#if defined(_WIN32)
    const unsigned short port = 443;
#else
    const unsigned short port = 80;
#endif
    ssc::HttpResponse res = ssc::httpRequest(host, port, path, "GET",
                                             std::string(), std::string(), 20, cancel);
    if (!res.ok())
        logLine("download failed: status=" + std::to_string(res.status) + " " + res.error);
    if (!res.ok() || !ssc::decodableImage(res.body)) {
        if (res.ok()) logLine("download failed: response is not a bounded decodable image");
        return std::string();
    }
    return res.body;
}
} // namespace

// One shared asynchronous lane owns resolver/CDN traffic for all native hosts.
// Network work never runs on a host UI thread or the CoverMonitor thread. Every
// queue snapshot gets a fresh epoch/cancellation token, so a late old-station or
// old-orientation reply can populate its keyed cache but can never reach the renderer.
struct CoverEngine::MediaWorkerState {
    typedef std::chrono::steady_clock Clock;
    struct CacheEntry {
        ssc::TrackInfo track;
        ssc::MediaRequest request;
        ssc::MediaResult result;
        std::string bytes;
        unsigned long long used = 0;
    };
    struct Work {
        enum Kind { Resolve, Download } kind = Resolve;
        Clock::time_point due;
        unsigned long long order = 0;
        unsigned long long epoch = 0;
        unsigned attempt = 0;
        bool current = false;
        bool reload = false;
        ssc::TrackInfo track;
        ssc::MediaRequest request;
        ssc::MediaResult result;
        std::string key;
        std::shared_ptr<std::atomic<bool> > cancel;
    };

    std::mutex mutex;
    std::condition_variable cv;
    std::thread thread;
    bool stopping = false;
    unsigned long long epoch = 0, order = 0, lru = 0;
    std::atomic<unsigned long long> activeEpoch{0};
    std::shared_ptr<std::atomic<bool> > cancel;
    std::vector<Work> work;
    std::map<std::string, CacheEntry> cache;
    ssc::TrackInfo current;
    std::vector<ssc::TrackInfo> queue;
    ssc::MediaRequest request;
    ssc::MediaResolver resolver;
};

namespace {

void cacheMedia(CoverEngine::MediaWorkerState* state, const std::string& key,
                const ssc::TrackInfo& track, const ssc::MediaRequest& request,
                const ssc::MediaResult& result, const std::string& bytes) {
    CoverEngine::MediaWorkerState::CacheEntry entry;
    entry.track = track; entry.request = request; entry.result = result;
    entry.bytes = bytes; entry.used = ++state->lru;
    state->cache[key] = entry;
    while (state->cache.size() > ssc::kQueuedTrackStoreLimit) {
        std::map<std::string, CoverEngine::MediaWorkerState::CacheEntry>::iterator oldest = state->cache.begin();
        for (std::map<std::string, CoverEngine::MediaWorkerState::CacheEntry>::iterator it = state->cache.begin();
             it != state->cache.end(); ++it)
            if (it->second.used < oldest->second.used) oldest = it;
        state->cache.erase(oldest);
    }
}

std::string effectiveFanartKey(const ssc::MediaRequest& request) {
    if (!request.includeArt) return std::string();
    const std::string surrounded = "," + request.providers + ",";
    return surrounded.find(",fanart,") == std::string::npos
        ? std::string() : request.fanartClientKey;
}

bool sameResolverConfig(const ssc::MediaRequest& a, const ssc::MediaRequest& b) {
    return a.providers == b.providers && a.ratingCountries == b.ratingCountries
        && effectiveFanartKey(a) == effectiveFanartKey(b)
        && a.includeArt == b.includeArt && a.includeRatings == b.includeRatings
        && a.portrait == b.portrait;
}

} // namespace

CoverEngine& CoverEngine::instance() {
    static CoverEngine e;
    return e;
}

float CoverEngine::remainingFrac() const {
    switch (settings.remainingSize) {
        case 0:  return 0.048f; // web: 4.8% of fitted cover side
        case 1:  return 0.062f; // web: 6.2%
        default: return 0.080f; // web: 8.0%
    }
}

d2d::Transition CoverEngine::transitionEffect() const {
    switch (settings.transition) {
        case 2:  return d2d::Transition::FlipHorizontal;
        case 3:  return d2d::Transition::FlipVertical;
        default: return d2d::Transition::Crossfade;
    }
}

// --- lifecycle --------------------------------------------------------------
void CoverEngine::setLogName(const std::string& base) {
    std::lock_guard<std::mutex> lock(g_logMutex);
    if (!base.empty()) { g_logBase = base; g_logResolved = false; } // re-resolve sentinel for new base
}

void CoverEngine::startMediaWorker() {
    if (media_) return;
    media_ = new MediaWorkerState();
    MediaWorkerState* state = media_;
    state->thread = std::thread([this, state] {
        for (;;) {
            MediaWorkerState::Work item;
            {
                std::unique_lock<std::mutex> lock(state->mutex);
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
                    item = state->work[best];
                    state->work.erase(state->work.begin() + best);
                    break;
                }
            }
            if (!item.cancel || item.cancel->load()) continue;

            if (item.kind == MediaWorkerState::Work::Resolve) {
                // Queue rows can omit composer credit. Use the same project-owned
                // credit endpoint as web before resolving, never scrape arbitrary URLs.
                if (!item.current && item.track.artist.empty() && !item.track.albumUrl.empty()) {
                    bool creditOk = false;
                    const std::string artist = state->resolver.resolveCredit(
                        item.track.album, item.track.albumUrl,
                        ssc::station(0).host, &creditOk, item.cancel.get());
                    if (item.cancel->load()) continue;
                    if (creditOk && !artist.empty()) item.track.artist = artist;
                }
                item.request.album = item.track.album;
                item.request.track = item.track.track;
                item.request.artist = item.track.artist;
                item.key = ssc::mediaCacheKey(item.track, item.request);

                MediaWorkerState::CacheEntry cached;
                MediaWorkerState::CacheEntry cachedFallback;
                bool haveCached = false;
                bool haveCachedFallback = false;
                if (!item.reload) {
                    std::lock_guard<std::mutex> lock(state->mutex);
                    std::map<std::string, MediaWorkerState::CacheEntry>::iterator it = state->cache.find(item.key);
                    if (it != state->cache.end()) {
                        it->second.used = ++state->lru;
                        cached = it->second;
                        haveCached = true;
                    }
                    if (item.current && haveCached && cached.bytes.empty()) {
                        for (std::map<std::string, MediaWorkerState::CacheEntry>::const_iterator candidate = state->cache.begin();
                             candidate != state->cache.end(); ++candidate) {
                            if (candidate->first != item.key
                                    && candidate->second.track.album == item.track.album
                                    && candidate->second.track.track == item.track.track
                                    && sameResolverConfig(candidate->second.request, item.request)
                                    && candidate->second.result.status == ssc::MediaResult::Hit
                                    && !candidate->second.bytes.empty()) {
                                cachedFallback = candidate->second;
                                haveCachedFallback = true; break;
                            }
                        }
                    }
                }
                if (haveCached) {
                    if (item.current) {
                        publishMetadata(item.epoch, cached.result, item.track.lengthSeconds);
                        if (haveCachedFallback) {
                            ssc::MediaResult merged = cachedFallback.result;
                            if (!cached.result.certifications.empty())
                                merged.certifications = cached.result.certifications;
                            publishMedia(item.epoch, cachedFallback.bytes, ratingBadges(merged), false,
                                         &cachedFallback.result);
                        } else {
                            publishMedia(item.epoch, cached.bytes, ratingBadges(cached.result), false,
                                         &cached.result);
                        }
                    }
                    continue;
                }

                const ssc::MediaResult resolved = state->resolver.resolve(item.request, item.cancel.get());
                if (item.cancel->load()) continue;
                if (resolved.status == ssc::MediaResult::Failure) {
                    // A current-track refinement must not erase an already prepared
                    // queue hit. Failures remain uncached and retry on the feed cadence.
                    if (item.current) {
                        // The resolver retains the validated stream metadata when
                        // /api/media cannot provide its normalized form. Show that
                        // fallback instead of leaving native clients without a title.
                        publishMetadata(item.epoch, resolved, item.track.lengthSeconds);
                        MediaWorkerState::CacheEntry fallback;
                        bool haveFallback = false;
                        {
                            std::lock_guard<std::mutex> lock(state->mutex);
                            for (std::map<std::string, MediaWorkerState::CacheEntry>::const_iterator it = state->cache.begin();
                                 it != state->cache.end(); ++it) {
                                if (it->second.track.album == item.track.album
                                        && it->second.track.track == item.track.track
                                        && sameResolverConfig(it->second.request, item.request)
                                        && it->second.result.status == ssc::MediaResult::Hit) {
                                    fallback = it->second; haveFallback = true; break;
                                }
                            }
                        }
                        if (haveFallback)
                            publishMedia(item.epoch, fallback.bytes, ratingBadges(fallback.result), false,
                                         &fallback.result);
                    }
                    const unsigned failure = item.attempt + 1;
                    item.attempt = failure;
                    item.due = MediaWorkerState::Clock::now()
                        + std::chrono::milliseconds(item.current
                            ? ssc::stationRetryDelayMs(failure) : 60000);
                    std::lock_guard<std::mutex> lock(state->mutex);
                    if (!state->stopping && item.epoch == state->epoch) {
                        item.order = ++state->order;
                        state->work.push_back(item);
                        state->cv.notify_all();
                    }
                    continue;
                }
                if (item.current)
                    publishMetadata(item.epoch, resolved, item.track.lengthSeconds);

                if (resolved.status == ssc::MediaResult::Miss || !resolved.hasBackdrop()) {
                    MediaWorkerState::CacheEntry fallback;
                    bool haveFallback = false;
                    if (item.current) {
                        std::lock_guard<std::mutex> lock(state->mutex);
                        for (std::map<std::string, MediaWorkerState::CacheEntry>::const_iterator it = state->cache.begin();
                             it != state->cache.end(); ++it) {
                            if (it->second.track.album == item.track.album
                                    && it->second.track.track == item.track.track
                                    && sameResolverConfig(it->second.request, item.request)
                                    && it->second.result.status == ssc::MediaResult::Hit) {
                                fallback = it->second; haveFallback = true; break;
                            }
                        }
                    }
                    {
                        std::lock_guard<std::mutex> lock(state->mutex);
                        cacheMedia(state, item.key, item.track, item.request, resolved, std::string());
                    }
                    if (item.current) {
                        if (haveFallback) {
                            ssc::MediaResult merged = fallback.result;
                            if (!resolved.certifications.empty()) merged.certifications = resolved.certifications;
                            publishMedia(item.epoch, fallback.bytes, ratingBadges(merged), false,
                                         &fallback.result);
                        } else {
                            publishMedia(item.epoch, std::string(), ratingBadges(resolved), false);
                        }
                    }
                    continue;
                }

                MediaWorkerState::Work image = item;
                if (item.current) {
                    // Ratings are independent of art loading. Reveal them as soon
                    // as the resolver is authoritative; the backdrop can still use
                    // its own bounded image retry sequence.
                    publishRatings(item.epoch, ratingBadges(resolved));
                }
                image.kind = MediaWorkerState::Work::Download;
                image.result = resolved;
                image.attempt = 0;
                // Finish the current item as one transaction before another due
                // queue resolver can occupy the single network lane for 20 seconds.
                image.due = MediaWorkerState::Clock::now() - std::chrono::hours(1);
                {
                    std::lock_guard<std::mutex> lock(state->mutex);
                    if (!state->stopping && image.epoch == state->epoch) {
                        image.order = ++state->order;
                        state->work.push_back(image);
                        state->cv.notify_all();
                    }
                }
                continue;
            }

            std::string bytes;
            const bool downloaded = state->resolver.downloadBackdrop(item.result, bytes, item.cancel.get())
                && ssc::decodableImage(bytes);
            if (item.cancel->load()) continue;
            if (!downloaded) {
                const unsigned failure = item.attempt + 1;
                const int delay = ssc::backdropImageRetryDelayMs(failure);
                if (delay >= 0) {
                    item.attempt = failure;
                    item.due = MediaWorkerState::Clock::now() + std::chrono::milliseconds(delay);
                    std::lock_guard<std::mutex> lock(state->mutex);
                    if (!state->stopping && item.epoch == state->epoch) {
                        item.order = ++state->order;
                        state->work.push_back(item);
                        state->cv.notify_all();
                    }
                } else if (item.current) {
                    publishMedia(item.epoch, std::string(), ratingBadges(item.result), true);
                }
                continue;
            }

            {
                std::lock_guard<std::mutex> lock(state->mutex);
                cacheMedia(state, item.key, item.track, item.request, item.result, bytes);
            }
            if (item.current)
                publishMedia(item.epoch, bytes, ratingBadges(item.result), false, &item.result);
        }
    });
}

void CoverEngine::stopMediaWorker() {
    MediaWorkerState* state = media_;
    if (!state) return;
    {
        std::lock_guard<std::mutex> lock(state->mutex);
        state->stopping = true;
        if (state->cancel) state->cancel->store(true);
        state->work.clear();
        state->cv.notify_all();
    }
    if (state->thread.joinable()) state->thread.join();
    delete state;
    media_ = nullptr;
}

void CoverEngine::scheduleMedia(const ssc::TrackInfo& current,
                                const std::vector<ssc::TrackInfo>& queue, bool forceReload) {
    MediaWorkerState* state = media_;
    if (!state) return;
    ssc::MediaRequest request;
    request.providers = settings.mediaProviders;
    request.fanartClientKey = settings.fanartClientKey;
    const bool soundtrackMedia = settings.station == 0;
    request.includeArt = soundtrackMedia && settings.backdrops;
    request.includeRatings = soundtrackMedia && settings.ratings;
    request.ratingCountries = settings.ratingDE && settings.ratingUS ? "DE,US"
        : settings.ratingDE ? "DE" : settings.ratingUS ? "US" : "DE,US";
    RECT client = {};
    const HWND window = hwnd_.load();
    request.portrait = window && GetClientRect(window, &client)
        && (client.bottom - client.top) > (client.right - client.left);
    mediaPortrait_.store(request.portrait ? 1 : 0);

    // A queue snapshot normally arrives just after current-playing. Attach it to
    // the existing epoch instead of aborting/restarting the current resolver call.
    if (!forceReload) {
        std::lock_guard<std::mutex> lock(state->mutex);
        const bool sameCurrent = state->epoch != 0
            && state->current.album == current.album && state->current.track == current.track
            && state->current.artist == current.artist && state->current.coverUrl == current.coverUrl
            && sameResolverConfig(state->request, request);
        if (sameCurrent) {
            if (queue.empty()) return; // current refresh: keep the existing staggered queue
            state->work.erase(std::remove_if(state->work.begin(), state->work.end(),
                [](const MediaWorkerState::Work& item) { return !item.current; }), state->work.end());
            state->queue.assign(queue.begin(), queue.begin()
                + (queue.size() < ssc::kQueuedTrackStoreLimit ? queue.size() : ssc::kQueuedTrackStoreLimit));
            for (size_t i = 0; i < state->queue.size(); ++i) {
                if (state->queue[i].album.empty() || state->queue[i].stationIdent) continue;
                MediaWorkerState::Work queued;
                queued.due = MediaWorkerState::Clock::now()
                    + std::chrono::milliseconds(ssc::queuePrefetchDelayMs(i));
                queued.order = ++state->order; queued.epoch = state->epoch;
                queued.current = false; queued.track = state->queue[i];
                queued.request = request; queued.cancel = state->cancel;
                state->work.push_back(queued);
            }
            state->cv.notify_all();
            return;
        }
    }

    unsigned long long epoch;
    std::shared_ptr<std::atomic<bool> > cancel(new std::atomic<bool>(false));
    {
        std::lock_guard<std::mutex> lock(state->mutex);
        if (state->cancel) state->cancel->store(true);
        state->cancel = cancel;
        epoch = ++state->epoch;
        state->activeEpoch.store(epoch);
        state->work.clear();
        state->current = current;
        state->queue.assign(queue.begin(), queue.begin()
            + (queue.size() < ssc::kQueuedTrackStoreLimit ? queue.size() : ssc::kQueuedTrackStoreLimit));
        state->request = request;
    }

    // Even with visual media disabled, /api/media canonicalizes Album/Track/Artist
    // without contacting third-party providers. This is the single native source
    // for HTML entities and rotated articles.
    const bool enabled = !current.stationIdent && !current.album.empty();
    if (!enabled) {
        clearMedia(epoch);
        return;
    }

    std::lock_guard<std::mutex> lock(state->mutex);
    MediaWorkerState::Work now;
    now.due = MediaWorkerState::Clock::now(); now.order = ++state->order;
    now.epoch = epoch; now.current = true; now.reload = forceReload;
    now.track = current; now.request = request; now.cancel = cancel;
    state->work.push_back(now);
    for (size_t i = 0; i < state->queue.size(); ++i) {
        if (state->queue[i].album.empty() || state->queue[i].stationIdent) continue;
        MediaWorkerState::Work queued = now;
        queued.current = false; queued.reload = false; queued.track = state->queue[i];
        queued.due += std::chrono::milliseconds(ssc::queuePrefetchDelayMs(i));
        queued.order = ++state->order;
        state->work.push_back(queued);
    }
    state->cv.notify_all();
}

void CoverEngine::publishMedia(unsigned long long epoch, const std::string& backdropBytes,
                               const std::vector<d2d::RatingBadge>& ratings, bool imageFailed,
                               const ssc::MediaResult* mediaResult) {
    if (!media_ || media_->activeEpoch.load() != epoch) return;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        pendingBackdropBytes_ = backdropBytes;
        pendingRatings_ = ratings;
        pendingMediaClear_ = backdropBytes.empty();
        pendingBackdropChange_ = true;
        mediaImageFailed_ = imageFailed;
        pendingMediaHasTint_ = !backdropBytes.empty() && mediaResult && mediaResult->hasTint;
        pendingMediaEpoch_ = epoch;
        if (pendingMediaHasTint_)
            for (int i = 0; i < 3; ++i) pendingMediaTint_[i] = mediaResult->tint[i];
        mediaDirty_ = true;
    }
    if (HWND w = hwnd_.load()) PostMessageA(w, SSC_WM_NEWMEDIA, 0, 0);
}

void CoverEngine::publishRatings(unsigned long long epoch,
                                 const std::vector<d2d::RatingBadge>& ratings) {
    if (!media_ || media_->activeEpoch.load() != epoch) return;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        pendingRatings_ = ratings;
        pendingBackdropChange_ = false;
        pendingMediaEpoch_ = epoch;
        mediaImageFailed_ = false;
        mediaDirty_ = true;
    }
    if (HWND w = hwnd_.load()) PostMessageA(w, SSC_WM_NEWMEDIA, 0, 0);
}

void CoverEngine::publishMetadata(unsigned long long epoch, const ssc::MediaResult& result,
                                  int lengthSeconds) {
    if (!media_ || media_->activeEpoch.load() != epoch || result.album.empty()) return;
    std::string title = result.album;
    if (!result.track.empty()) title += " - " + result.track;
    if (lengthSeconds > 0) {
        const int mm = lengthSeconds / 60, ss = lengthSeconds % 60;
        title += " (" + std::to_string(mm) + ":" + (ss < 10 ? "0" : "")
            + std::to_string(ss) + ")";
    }
    {
        std::lock_guard<std::mutex> lock(mutex_);
        infoTitle_ = toWide(title);
        infoArtist_ = toWide(result.artist);
    }
    invalidate();
}

void CoverEngine::clearMedia(unsigned long long epoch) {
    publishMedia(epoch, std::string(), std::vector<d2d::RatingBadge>(), false);
}

void CoverEngine::start(bool autoAdvance) {
    std::lock_guard<std::mutex> life(monitorLifecycle_);
    if (monitor_ || demoOn_) return;
    autoAdvance_ = autoAdvance;
    startMediaWorker();
    // Screenshot/demo mode (checked once, here): if the demo folder exists, play its
    // covers instead of a station. Everything downstream is the unchanged real engine.
    if (ssc::Demo::active() && demo_.load()) {
        demoOn_ = true;
        logLine("demo mode: " + std::to_string(demo_.count()) + " covers");
        showDemoFrame();
        return;
    }
    // Live: plugins (autoAdvance=false) advance covers off the host's track-title changes
    // (onTitleChanged -> refresh); the viewer (autoAdvance=true) follows the station clock.
    startMonitor();
    logLine("engine started");
}

// Creates the CoverMonitor for the currently-selected station. Split out of start()
// so setStation() can rebuild it against a new host. Flaky server -> recover quickly.
void CoverEngine::startMonitor() {
    const ssc::StationInfo& st = ssc::station(settings.station);
    ssc::Config cfg;
    cfg.errorRetrySeconds = 8;
    cfg.errorRetryMaxSeconds = 60;
    cfg.cycleErrorRetryAfterCap = true;
    cfg.autoAdvance = autoAdvance_;
    cfg.host = st.host; // JSON + cover host; CoverLink is then pinned to this host
    monitor_ = new ssc::CoverMonitor([this](const std::string& url, const ssc::TrackInfo& info) {
        // Anchor the countdown from the current-playing endpoint's remaining
        // (Length - |SystemTime - PlayStart|) - known even when we join mid-track. This
        // re-syncs on every poll (each title change triggers one); between polls the
        // overlay counts down locally. A title-change swap sets an instant estimate (the
        // preloaded next length) which this poll then confirms/corrects.
        setRemaining(info.remainingSeconds);
        // Keep the outgoing text until /api/media has completed. Its result then
        // supplies canonical metadata or the validated stream fallback; on startup
        // the empty info state therefore remains hidden for the whole request.
        if (info.stationIdent) {
            std::lock_guard<std::mutex> lock(mutex_);
            infoTitle_ = toWide(info.album);
            infoArtist_ = toWide(info.artist);
        }
        onCoverChanged(url, info);
    }, cfg);
    monitor_->setErrorCallback([this](const std::string& m) {
        logLine("monitor error: " + m);
        loading_.store(false);
        invalidate();
    });
    monitor_->start();
    logLine(std::string("monitor on ") + st.displayName + " (" + st.host + ")");
}

void CoverEngine::setStation(int index) {
    if (demoOn_) return; // demo mode drives its own covers; ignore station switches
    // Robust against a caller that forgot to gate on a family-stream match:
    // ssc::stationIndexForText() returns -1 for a foreign stream, and we must NOT let
    // that silently clamp to 0 (SST) and show SST covers for something unrecognized.
    // Any out-of-range index is ignored; the current station stays untouched.
    if (index < 0 || index >= ssc::kStationCount) {
        logLine("setStation: ignoring invalid index " + std::to_string(index));
        return;
    }
    std::lock_guard<std::mutex> life(monitorLifecycle_);
    if (index == settings.station && monitor_) return; // already on this station
    settings.station = index;
    if (!monitor_) return; // not started yet; start() will pick up settings.station

    // Rebuild the monitor against the new host and drop the old station's cover so
    // we don't briefly show the wrong art. Safe on the UI thread: stop() joins the
    // monitor's background thread before we tear it down.
    monitor_->stop(); delete monitor_; monitor_ = nullptr;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        coverBytes_.clear(); dirty_ = false;
        shownUrl_.clear(); shownBytes_.clear();
        nextUrl_.clear(); nextBytes_.clear(); nextLen_ = -1;
        infoTitle_.clear(); infoArtist_.clear();
    }
    coverRetryAt_.store(0); coverRetryFailures_ = 0; coverRetryUrl_.clear();
    scheduleMedia(ssc::TrackInfo(), std::vector<ssc::TrackInfo>());
    resetTitle();          // next accepted title reloads; hide the countdown
    loading_.store(true);  // show "Loading..." until the new station replies
    invalidate();
    startMonitor();
    if (monitor_) monitor_->refresh(); // fetch the new station's current cover now
}

void CoverEngine::stop() {
    {
        std::lock_guard<std::mutex> life(monitorLifecycle_);
        if (monitor_) { monitor_->stop(); delete monitor_; monitor_ = nullptr; }
        demoOn_ = false;
    }
    stopMediaWorker();
    logLine("engine stopped");
}

// Advance to the next demo cover (crossfades via the same setCover path). No-op unless
// demo mode is active; called by the 'N' hotkey and by onTimer's auto-advance.
void CoverEngine::demoNext() {
    if (!demoOn_) return;
    demo_.advance();
    showDemoFrame();
}

// Feed the current demo frame's cover + metadata through the normal display path, so the
// crossfade, poster overlay and countdown all work exactly as with a live cover.
void CoverEngine::showDemoFrame() {
    const ssc::DemoFrame& f = demo_.current();
    {
        std::lock_guard<std::mutex> lock(mutex_);
        coverBytes_ = f.bytes; dirty_ = true;
        std::string t = f.album;
        if (!f.album.empty() && !f.track.empty()) t = f.album + " - " + f.track;
        else if (!f.track.empty())                t = f.track;
        if (!t.empty() && f.seconds > 0) {
            const int mm = f.seconds / 60, ss = f.seconds % 60;
            t += " (" + std::to_string(mm) + ":" + (ss < 10 ? "0" : "") + std::to_string(ss) + ")";
        }
        infoTitle_  = toWide(t);
        infoArtist_ = toWide(f.artist);
    }
    setRemaining(f.seconds > 0 ? f.seconds : -1); // seconds>0: countdown + auto-advance; 0: static
    loading_.store(false);
    notifyNewCover(); // -> decodePending on the UI thread -> d2d::setCover (fades if a cover is up)
}

// Anchor the countdown so onPaint can compute it locally from the clock. The
// station plays a ~5s gap after each track's reported Length, so the raw remaining
// hits 0 about 5s before the next title arrives; pad by that gap so 0:00 lines up
// with the actual changeover instead of sitting at 0:00.
void CoverEngine::setRemaining(int secs) {
    static const int kInterTrackGapSecs = 5;
    remAnchor_.store(secs >= 0 ? secs + kInterTrackGapSecs : secs);
    remAnchorAt_.store(GetTickCount());
}
int CoverEngine::currentRemaining() const {
    const int base = remAnchor_.load();
    if (base < 0) return -1;
    const int elapsed = (int)((GetTickCount() - remAnchorAt_.load()) / 1000);
    const int rem = base - elapsed;
    return rem > 0 ? rem : 0;
}

// Snapshot the atomic window once, then act on the local - the monitor thread may
// null it (setWindow) between the check and the use otherwise.
void CoverEngine::invalidate() const {
    if (HWND w = hwnd_.load()) InvalidateRect(w, nullptr, FALSE);
}
void CoverEngine::notifyNewCover() const {
    if (HWND w = hwnd_.load()) PostMessageA(w, SSC_WM_NEWCOVER, 0, 0);
}

void CoverEngine::setWindow(HWND h) {
    if (HWND w = hwnd_.load()) KillTimer(w, kHeartbeat);
    hwnd_.store(h);
    if (!h) return;
    ratingPointerInside_ = false;
    ratingPointerAutoHide_ = false;
    ratingPointerVisibleUntil_ = 0;
    updateRatingVisibility(GetTickCount());
    SetTimer(h, kHeartbeat, 33, nullptr); // ~30fps repaint heartbeat (fade + countdown)
    d2d::resetTarget(); // rebuild the render target for the (possibly new) window
    // Show whatever we have: if a cover is pending, decode it now; otherwise ask the
    // monitor to (re)fetch the current one for this freshly-created window.
    bool havePending, haveMediaPending;
    { std::lock_guard<std::mutex> lock(mutex_); havePending = !coverBytes_.empty(); if (havePending) dirty_ = true;
      haveMediaPending = mediaDirty_; }
    if (havePending) PostMessageA(h, SSC_WM_NEWCOVER, 0, 0);
    else if (monitor_) monitor_->refresh();
    if (haveMediaPending) PostMessageA(h, SSC_WM_NEWMEDIA, 0, 0);
    InvalidateRect(h, nullptr, FALSE);
}

// --- monitor callback (background thread) -----------------------------------
void CoverEngine::onCoverChanged(const std::string& url, const ssc::TrackInfo& info) {
    // Match the web player's ident fallback: an empty/untrusted CoverLink displays
    // the selected station logo. The URL is a project-owned constant, never feed data.
    const std::string displayUrl = url.empty() ? ssc::station(settings.station).logoUrl : url;
    logLine("poll: current cover = " + displayUrl + (url.empty() ? " (station ident)" : ""));

    // Start current media resolution immediately and independently. Queue metadata
    // is attached below without restarting this request.
    scheduleMedia(info, std::vector<ssc::TrackInfo>());

    // stop()/setStation() run on the host UI thread and join this (monitor) thread.
    // If we are mid-retry when that happens, abandon the remaining downloads so the
    // join returns promptly instead of grinding through every attempt's timeout.
    const std::atomic<bool>* cancelTok = monitor_ ? monitor_->cancelToken() : nullptr;

    // (1) Reconcile: only (re)show if `url` isn't already displayed.
    bool alreadyShown;
    std::string img;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        alreadyShown = (displayUrl == shownUrl_);
        if (displayUrl == nextUrl_ && !nextBytes_.empty()) img = nextBytes_;
    }
    if (!alreadyShown) {
        if (img.empty()) {
            loading_.store(true);
            invalidate();
            img = downloadCover(displayUrl, cancelTok);
            logLine("downloaded current " + std::to_string(img.size()) + " bytes");
        } else {
            logLine("current already preloaded, no download");
        }
        if (img.empty()) {
            loading_.store(false);
            if (coverRetryUrl_ != displayUrl) { coverRetryUrl_ = displayUrl; coverRetryFailures_ = 0; }
            const int delay = ssc::coverRetryDelayMs(++coverRetryFailures_);
            coverRetryAt_.store(GetTickCount() + (DWORD)delay);
            logLine("current cover retry in " + std::to_string(delay) + " ms");
            invalidate();
        } else {
            { std::lock_guard<std::mutex> lock(mutex_); coverBytes_ = img; dirty_ = true; shownUrl_ = displayUrl; shownBytes_ = img; }
            coverRetryFailures_ = 0; coverRetryUrl_.clear(); coverRetryAt_.store(0);
            notifyNewCover();
        }
    }

    // (2) One queue request supplies both the next square cover and all media
    // prefetch metadata, so the clients cannot drift on Album/Track/Artist data.
    std::vector<ssc::TrackInfo> queue;
    if (monitor_ && monitor_->queue(queue)) {
        scheduleMedia(info, queue);
    }
    if (!queue.empty() && !queue[0].coverUrl.empty()) {
        const std::string nextUrl = queue[0].coverUrl;
        const int nextLen = queue[0].lengthSeconds;
        bool haveIt;
        { std::lock_guard<std::mutex> lock(mutex_); haveIt = (nextUrl == nextUrl_ && !nextBytes_.empty()); }
        if (!haveIt) {
            std::string nextImg = downloadCover(nextUrl, cancelTok);
            logLine("preloaded next " + std::to_string(nextImg.size()) + " bytes, len=" +
                    std::to_string(nextLen) + "s: " + nextUrl);
            std::lock_guard<std::mutex> lock(mutex_);
            nextUrl_ = nextUrl;
            nextBytes_.swap(nextImg);
            nextLen_ = nextLen > 0 ? nextLen : -1;
        }
    }
}

// --- host events ------------------------------------------------------------
void CoverEngine::onTitleChanged(const std::string& title) {
    if (demoOn_) return; // demo mode ignores host track-title changes
    // Only real ICY track titles drive cover advance. Reject Winamp/foobar status
    // placeholders ("[Connecting]", "[Buffering: N%]"), the bare stream URL, and the
    // station's own name string (real titles only CONTAIN it, in a trailing paren).
    std::string lower = title;
    std::transform(lower.begin(), lower.end(), lower.begin(),
                   [](unsigned char c){ return (char)std::tolower(c); });
    const bool realTitle = !title.empty() && title[0] != '[' &&
        lower.rfind("http://", 0) != 0 && lower.rfind("https://", 0) != 0 &&
        lower.rfind(ssc::station(settings.station).host, 0) != 0; // bare station host placeholder
    if (!realTitle || title == lastTitle_) return;

    // First real title after tune-in only establishes the current track (the
    // preload is the NEXT track, so swapping to it here would flash wrong art).
    const bool firstTitle = lastTitle_.empty();
    lastTitle_ = title;
    if (!firstTitle) {
        bool swapped = false;
        int  swapLen = -1;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (!nextBytes_.empty()) {
                coverBytes_.swap(nextBytes_);
                dirty_ = true;
                shownUrl_ = nextUrl_;
                shownBytes_ = coverBytes_; // the swapped-in preloaded bytes
                swapLen = nextLen_;
                nextBytes_.clear(); nextUrl_.clear(); nextLen_ = -1;
                swapped = true;
            }
        }
        // The new track just started for us, so its remaining is its full (preloaded)
        // length. This is the only place the countdown is anchored; the heartbeat
        // repaints and the overlay counts down from here.
        setRemaining(swapLen);
        if (swapped) {
            logLine("track change: instant swap to preloaded cover (len=" + std::to_string(swapLen) + "s)");
            notifyNewCover();
        } else {
            logLine("track change: no preload ready, loading...");
            loading_.store(true);
            invalidate();
        }
    }
    if (monitor_) monitor_->refresh(); // reconcile + preload following track (bg)
}

void CoverEngine::resetTitle() {
    lastTitle_.clear();       // next accepted title reloads
    setRemaining(-1);         // hide the countdown until the next track starts
}

float CoverEngine::ratingVisibilityAlpha(DWORD now) {
    if (!ratingVisibilityAnimating_) return ratingVisibilityTo_;
    const DWORD elapsed = now - ratingVisibilityStart_;
    if (!clientAnimationsEnabled() || elapsed >= ssc::kRatingVisibilityFadeMs) {
        ratingVisibilityAnimating_ = false;
        ratingVisibilityFrom_ = ratingVisibilityTo_;
        return ratingVisibilityTo_;
    }
    const float progress = static_cast<float>(elapsed) / ssc::kRatingVisibilityFadeMs;
    return ratingVisibilityFrom_ + (ratingVisibilityTo_ - ratingVisibilityFrom_) * progress;
}

void CoverEngine::setRatingVisibility(bool visible, DWORD now) {
    const float target = visible ? 1.0f : 0.0f;
    if (target == ratingVisibilityTo_) return;
    ratingVisibilityFrom_ = ratingVisibilityAlpha(now);
    ratingVisibilityTo_ = target;
    ratingVisibilityStart_ = now;
    ratingVisibilityAnimating_ = clientAnimationsEnabled()
        && ratingVisibilityFrom_ != ratingVisibilityTo_;
    if (!ratingVisibilityAnimating_) ratingVisibilityFrom_ = target;
    invalidate();
}

void CoverEngine::updateRatingVisibility(DWORD now) {
    if (!ratingHasContent_) return;
    setRatingVisibility(ssc::shouldShowRatings(now, ratingIntroUntil_,
        ratingPointerInside_, ratingPointerAutoHide_, ratingPointerVisibleUntil_), now);
}

void CoverEngine::onPointerMove(HWND h, bool fullscreenAutoHide) {
    if (!h || h != hwnd_.load()) return;
    TRACKMOUSEEVENT tracking = { sizeof(tracking), TME_LEAVE, h, 0 };
    TrackMouseEvent(&tracking);
    const DWORD now = GetTickCount();
    ratingPointerInside_ = true;
    ratingPointerAutoHide_ = fullscreenAutoHide;
    ratingPointerVisibleUntil_ = fullscreenAutoHide ? now + ssc::kStageIdleMs : 0;
    updateRatingVisibility(now);
}

void CoverEngine::onPointerLeave(HWND h) {
    if (!h || h != hwnd_.load()) return;
    ratingPointerInside_ = false;
    ratingPointerVisibleUntil_ = 0;
    updateRatingVisibility(GetTickCount());
}

void CoverEngine::repaint() {
    if (media_) {
        ssc::TrackInfo current;
        std::vector<ssc::TrackInfo> queue;
        {
            std::lock_guard<std::mutex> lock(media_->mutex);
            current = media_->current; queue = media_->queue;
        }
        if (!current.album.empty()) scheduleMedia(current, queue);
    }
    invalidate();
}

void CoverEngine::retryMedia() {
    if (!media_) return;
    ssc::TrackInfo current;
    std::vector<ssc::TrackInfo> queue;
    {
        std::lock_guard<std::mutex> lock(media_->mutex);
        current = media_->current; queue = media_->queue;
    }
    if (!current.album.empty()) scheduleMedia(current, queue, true);
}

bool CoverEngine::currentCover(std::string& out) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (shownBytes_.empty()) return false;
    out = shownBytes_;
    return true;
}

// --- window messages --------------------------------------------------------
void CoverEngine::decodePending(HWND h) {
    std::string bytes;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (dirty_) { bytes.swap(coverBytes_); dirty_ = false; }
    }
    if (bytes.empty()) return;

    const bool fade = transitionAnimates() && haveCover_ && h && clientAnimationsEnabled();
    d2d::setCover(bytes.data(), bytes.size(), fade);
    if (fade) { fadeStart_ = GetTickCount(); fading_ = true; } // heartbeat drives the fade
    haveCover_ = true;
    loading_.store(false);
    logLine("cover decoded + shown (" + std::to_string(bytes.size()) + " bytes)");
    if (h) InvalidateRect(h, nullptr, FALSE);
}

void CoverEngine::onNewCover(HWND h) { decodePending(h); }

void CoverEngine::decodePendingMedia(HWND h) {
    std::string bytes;
    std::vector<d2d::RatingBadge> ratings;
    bool clear = false, failed = false, backdropChange = false, hasTint = false;
    unsigned long long epoch = 0;
    int tint[3] = {255, 255, 255};
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!mediaDirty_) return;
        bytes.swap(pendingBackdropBytes_);
        ratings.swap(pendingRatings_);
        clear = pendingMediaClear_;
        backdropChange = pendingBackdropChange_;
        failed = mediaImageFailed_;
        hasTint = pendingMediaHasTint_;
        epoch = pendingMediaEpoch_;
        for (int i = 0; i < 3; ++i) tint[i] = pendingMediaTint_[i];
        mediaDirty_ = false;
    }
    const bool fade = transitionAnimates() && h && clientAnimationsEnabled();
    if (backdropChange) {
        if (clear) d2d::clearBackdrop(fade);
        else d2d::setBackdrop(bytes.data(), bytes.size(), fade, hasTint ? tint : nullptr);
    }
    const DWORD now = GetTickCount();
    const bool ratingsWereHidden = ratingVisibilityAlpha(now) <= 0.001f;
    const bool ratingContentFade = fade && !ratingsWereHidden;
    d2d::setRatings(ratings, ratingContentFade);
    if (!ratings.empty()) {
        ratingHasContent_ = true;
        if (ratingIntroEpoch_ != epoch) {
            ratingIntroEpoch_ = epoch;
            ratingIntroUntil_ = now + ssc::kRatingTrackVisibleMs;
            setRatingVisibility(true, now);
        } else {
            updateRatingVisibility(now);
        }
    } else {
        ratingHasContent_ = false;
        ratingIntroUntil_ = 0;
    }
    if (backdropChange) haveBackdrop_ = !clear;
    if (fade) {
        if (backdropChange) { mediaFadeStart_ = GetTickCount(); mediaFading_ = true; }
        ratingFadeStart_ = now; ratingFading_ = ratingContentFade;
    } else {
        if (backdropChange) mediaFading_ = false;
        ratingFading_ = false;
        d2d::endMediaFade();
    }
    if (failed) logLine("backdrop image failed after web-parity retries; manual retry remains available");
    if (h) InvalidateRect(h, nullptr, FALSE);
}

void CoverEngine::onNewMedia(HWND h) { decodePendingMedia(h); }

void CoverEngine::onPaint(HWND h) {
    float alpha = 1.0f;
    if (fading_) {
        const DWORD el = GetTickCount() - fadeStart_;
        if (settings.fadeMs <= 0 || el >= (DWORD)settings.fadeMs) {
            fading_ = false;      // fade finished
            d2d::endFade();
        } else {
            alpha = (float)el / settings.fadeMs;
        }
    }
    float mediaAlpha = 1.0f;
    if (mediaFading_) {
        const DWORD el = GetTickCount() - mediaFadeStart_;
        if (settings.fadeMs <= 0 || el >= (DWORD)settings.fadeMs) {
            mediaFading_ = false;
            if (!ratingFading_) d2d::endMediaFade();
        } else {
            mediaAlpha = (float)el / settings.fadeMs;
        }
    }
    float ratingAlpha = 1.0f;
    if (ratingFading_) {
        const DWORD el = GetTickCount() - ratingFadeStart_;
        if (settings.fadeMs <= 0 || el >= (DWORD)settings.fadeMs) {
            ratingFading_ = false;
            // Only release both outgoing buffers after their independent fades end.
            if (!mediaFading_) d2d::endMediaFade();
        } else {
            ratingAlpha = (float)el / settings.fadeMs;
        }
    }
    const DWORD now = GetTickCount();
    updateRatingVisibility(now);
    const float ratingOpacity = ratingVisibilityAlpha(now);
    const bool poster = settings.layout == 1;
    // The remaining-time overlay is one feature (size + rolling settings) shown in both
    // layouts - as a top-right badge in fill, in the info box in poster - gated by the
    // same "Show remaining time overlay" option. The renderer formats + rolls it.
    const int rem = (settings.showRemaining && haveCover_) ? currentRemaining() : -1;
    const wchar_t* status = loading_.load() ? L"Loading cover..." : nullptr; // no "Playing" label
    std::wstring title, artist;
    if (poster) { std::lock_guard<std::mutex> lock(mutex_); title = infoTitle_; artist = infoArtist_; }
    d2d::setPosterBlur(settings.posterBlur);
    d2d::setCoverRadius(settings.borderRadius);
    d2d::render(h, alpha, transitionEffect(), rem, remainingFrac(),
                settings.rollDigits && clientAnimationsEnabled(), status,
                settings.layout, title.c_str(), artist.c_str(), mediaAlpha,
                settings.hideCoverWithBackdrop, ratingAlpha, ratingOpacity);
}

// The engine's repaint heartbeat: redraw only while something is actually changing -
// a crossfade, the "Loading..." badge, or the countdown over a shown cover. This is
// layout-independent: the poster's countdown is the same showRemaining case, and its
// transition is the same fading_ case, so a settled poster frame stays idle too.
void CoverEngine::onTimer(HWND h, UINT_PTR id) {
    if (id != kHeartbeat) return;
    updateRatingVisibility(GetTickCount());
    // Demo auto-advance: when a demo frame's countdown expires, roll to the next cover
    // (which crossfades). Frames with seconds==0 have no countdown, so they stay put.
    if (demoOn_ && demo_.current().seconds > 0 && currentRemaining() == 0) { demoNext(); return; }
    const DWORD retryAt = coverRetryAt_.load();
    if (retryAt && (LONG)(GetTickCount() - retryAt) >= 0) {
        coverRetryAt_.store(0);
        if (monitor_) monitor_->refresh();
    }
    RECT rc = {};
    if (media_ && mediaPortrait_.load() >= 0 && GetClientRect(h, &rc)) {
        const int portrait = (rc.bottom - rc.top) > (rc.right - rc.left) ? 1 : 0;
        if (portrait != mediaPortrait_.load()) repaint();
    }
    if (fading_ || mediaFading_ || ratingFading_ || ratingVisibilityAnimating_ || loading_.load()
            || (settings.showRemaining && haveCover_))
        InvalidateRect(h, nullptr, FALSE);
}
