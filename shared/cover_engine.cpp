#include "../lib/platform_text.h"
// cover_engine.cpp - see header. Host-agnostic; talks only to the shared Direct2D
// renderer, the CoverMonitor library, and an HWND. Ported from the Winamp plugin so
// both hosts share identical cover/preload/animation behaviour.
#include "cover_engine.h"
#include "media_worker.h"

#include <algorithm>
#include <cctype>
#include <chrono>

#include <map>
#include <memory>

#include <vector>

#include "coverfetch.h"
#include "http_client.h"
#include "image_probe.h"
#include "rating_assets.h"
#include "media_policy.h"
#include "media_resolver.h"
#include "stations.h"
#if SSC_ENABLE_DEBUG_OVERLAY
#include "diagnostics.h"
#include "diagnostic_timeline.h"
#endif



// --- logging ----------------------------------------------------------------
// Diagnostics are compiled only with SSC_ENABLE_DEBUG_OVERLAY=1. The stage
// snapshot is available with D in those builds. Both the %TEMP% file AND
// OutputDebugString stay silent unless a sentinel file exists next to where the log
// would go: %TEMP%\<base>.log.enable. Support drops that file, restarts the host,
// reproduces, then sends %TEMP%\<base>.log. When enabled, the file is capped at 1 MB
// with one rolled generation (<base>.log.1), so it can never grow without bound.
namespace {
#if SSC_ENABLE_DEBUG_OVERLAY
ssc::platform::Mutex g_logMutex;
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
    ssc::DiagnosticLog::instance().event("engine", std::string(msg));
    ssc::platform::LockGuard lock(g_logMutex);
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
#endif
#if !SSC_ENABLE_DEBUG_OVERLAY
#define logLine(...) ((void)0)
#endif

// UTF-8 (the station feed's encoding) -> UTF-16 for DirectWrite (poster info box).
std::wstring toWide(const std::string& s) {
    if (s.empty()) return std::wstring();
    int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
    if (n <= 0) return std::wstring();
    std::wstring w((size_t)n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), &w[0], n);
    return w;
}

std::vector<d2d::RatingBadge> ratingBadges(const std::vector<ssc::PreparedRating>& ratings) {
    std::vector<d2d::RatingBadge> out;
    for (const auto& asset : ratings) {
        const auto& c = asset.certification;
        d2d::RatingBadge badge;
        badge.country = toWide(c.country); badge.system = toWide(c.system);
        badge.rating = toWide(c.rating); badge.label = toWide(c.label); badge.png = asset.bytes;
        for (const auto& descriptor : c.descriptors) {
            if (!badge.descriptors.empty()) badge.descriptors += L", ";
            badge.descriptors += toWide(descriptor);
        }
        out.push_back(std::move(badge));
    }
    return out;
}
std::vector<d2d::RatingBadge> ratingBadges(const ssc::MediaResult& result,
    const ssc::RatingAssetCache& cache = ssc::ratingAssets()) {
    return ratingBadges(ssc::cachedRatings(result, cache));
}

bool clientAnimationsEnabled() {
    BOOL enabled = TRUE;
    return !SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &enabled, 0) || enabled;
}

} // namespace

// One shared asynchronous lane owns resolver/CDN traffic for all native hosts.
// Network work never runs on a host UI thread or the CoverMonitor thread. Every
// queue snapshot gets a fresh epoch/cancellation token, so a late old-station or
// old-orientation reply can populate its keyed cache but can never reach the renderer.
#include "queue_prefetch.h"
struct CoverEngine::MediaWorkerState : ssc::MediaWorkerState {
    Settings settingsSnapshot; // UI-owned settings copied under the worker mutex
#if SSC_ENABLE_DEBUG_OVERLAY
    ssc::DiagnosticTimeline timeline;
#endif
};

namespace {

// Both queue-only refreshes and new epochs use the same job construction path.
// Keep its string ownership/cancellation setup out of both scheduler branches.
__declspec(noinline) void queueMediaPrefetchLocked(CoverEngine::MediaWorkerState* state,
        const ssc::MediaRequest& request, int station, bool animateBackdrop = true,
        bool immediateCachedTitleLogo = false) {
    for (const auto& planned : ssc::planQueueMedia(state->queue, request)) {
        CoverEngine::MediaWorkerState::Work queued;
        queued.due = CoverEngine::MediaWorkerState::Clock::now()
            + std::chrono::milliseconds(planned.delayMs);
        queued.order = ++state->order; queued.epoch = state->epoch;
        queued.track = planned.track; queued.request = planned.request; queued.cancel = state->cancel;
        queued.creditHost = ssc::station(station).host;
        queued.animateBackdrop = animateBackdrop;
        queued.immediateCachedTitleLogo = immediateCachedTitleLogo;
        state->work.push_back(std::move(queued));
    }
}


using ssc::cacheMedia;
using ssc::cachedBackdrop;
using ssc::effectiveFanartKey;
using ssc::sameBackdropConfig;
using ssc::sameResolverConfig;

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
#if SSC_ENABLE_DEBUG_OVERLAY
    ssc::platform::LockGuard lock(g_logMutex);
    if (!base.empty()) { g_logBase = base; g_logResolved = false; } // re-resolve sentinel for new base
#endif
}

void CoverEngine::startMediaWorker() {
    if (media_) return;
    media_ = new MediaWorkerState();
    MediaWorkerState* state = media_;
    state->settingsSnapshot = settings;
    state->thread = ssc::platform::Thread([this, state] { runMediaWorker(state); });
}

void CoverEngine::runMediaWorker(MediaWorkerState* state) {
    ssc::MediaWorkerCallbacks callbacks;
    callbacks.publishRatings = [this](auto epoch, const auto& ratings) { publishRatings(epoch, ratingBadges(ratings)); };
    callbacks.publishTitleLogo = [this](auto epoch, const auto& bytes, const auto& album, bool immediate) { publishTitleLogo(epoch, bytes, album, immediate); };
    callbacks.publishCycledBackdrop = [this](auto epoch, auto selection, const auto& bytes, const auto& result) { publishCycledBackdrop(epoch, selection, bytes, result); };
    callbacks.publishMetadata = [this](auto epoch, const auto& result, int length) { publishMetadata(epoch, result, length); };
    callbacks.publishQueuedMetadata = [this](auto epoch, const auto& track, const auto& result) { publishQueuedMetadata(epoch, track, result); };
    callbacks.publishMedia = [this](auto epoch, const auto& bytes, const auto& ratings, bool failed, const auto* result, bool animate) {
        publishMedia(epoch, bytes, ratingBadges(ratings), failed, result, animate);
    };
    callbacks.selectionCurrent = [this](auto epoch, auto selection) {
        ssc::platform::LockGuard lock(mutex_);
        return epoch == activeMediaEpoch_ && selection == backdropSelection_;
    };
    ssc::runMediaWorker(state, callbacks);
}

void CoverEngine::stopMediaWorker() {
    MediaWorkerState* state = media_;
    if (!state) return;
    {
        ssc::platform::LockGuard lock(state->mutex);
        state->stopping = true;
        {
            ssc::platform::LockGuard publication(mutex_);
            ++activeMediaEpoch_;
            mediaDirty_ = false;
            comingNext_.setQueue("", L"", L"");
        }
        if (state->cancel) state->cancel->store(true);
        state->work.clear();
        state->cv.notify_all();
    }
    if (state->thread.joinable()) state->thread.join();
    delete state;
    media_ = nullptr;
}

void CoverEngine::scheduleMedia(const ssc::TrackInfo& current,
                                const std::vector<ssc::TrackInfo>& queue, bool forceReload,
                                bool queueSnapshot) {
    MediaWorkerState* state = media_;
    if (!state) return;
    ssc::platform::LockGuard lock(state->mutex);
    scheduleMediaLocked(state, current, queue, forceReload, queueSnapshot);
}

void CoverEngine::scheduleMediaLocked(MediaWorkerState* state, const ssc::TrackInfo& current,
                                      const std::vector<ssc::TrackInfo>& queue, bool forceReload,
                                      bool queueSnapshot) {
    if (state->stopping) return;
    const Settings& snapshot = state->settingsSnapshot;
    // GetQueue may already have dequeued the music scheduled AFTER an inserted
    // ident. Only a confirmed music track may consume the saved announcement.
    const bool retainQueue = current.stationIdent && state->queueSnapshotReady;
    const auto updateQueue = [&] {
        if (retainQueue || &queue == &state->queue) return;
        state->queue.assign(queue.begin(), queue.begin()
            + (queue.size() < ssc::kQueuedTrackStoreLimit ? queue.size() : ssc::kQueuedTrackStoreLimit));
        state->queueSnapshotReady = queueSnapshot || !queue.empty();
    };
#if SSC_ENABLE_DEBUG_OVERLAY
    state->timeline.observe(ssc::station(snapshot.station).host, ssc::diagnosticTrackRecord(current));
#endif
    ssc::MediaPreferences preferences;
    preferences.station = snapshot.station; preferences.backdrops = snapshot.backdrops;
    preferences.logos = snapshot.titleLogos; preferences.ratings = snapshot.ratings;
    preferences.providers = snapshot.mediaProviders; preferences.fanartKey = snapshot.fanartClientKey;
    // Preserve the Windows settings schema's legacy both-countries fallback.
    preferences.ratingCountries = snapshot.ratingDE && snapshot.ratingUS ? "DE,US"
        : snapshot.ratingDE ? "DE" : snapshot.ratingUS ? "US" : "DE,US";
    ssc::MediaRequest request = ssc::mediaOptions(preferences);
    RECT client = {};
    const HWND window = hwnd_.load();
    // The shared renderer/fullscreen window uses physical client coordinates,
    // so do not multiply these by the window DPI a second time.
    if (window && GetClientRect(window, &client)
            && client.right > client.left && client.bottom > client.top) {
        request.width = (std::min)(8192L, client.right - client.left);
        request.height = (std::min)(8192L, client.bottom - client.top);
    }
    mediaPortrait_.store(ssc::wantsPortraitArtwork(request) ? 1 : 0);
    mediaResolutionClass_.store(ssc::wants4kArtwork(request) ? 1 : 0);

    const bool sameTrackIdentity = state->epoch != 0
        && state->current.album == current.album && state->current.track == current.track
        && state->current.artist == current.artist && state->current.coverUrl == current.coverUrl;
    const bool artworkSelectionChanged = state->request.providers != request.providers
        || effectiveFanartKey(state->request) != effectiveFanartKey(request)
        || state->request.includeArt != request.includeArt;
    const bool immediateCachedTitleLogo = sameTrackIdentity
        && state->request.includeTitleLogo && request.includeTitleLogo
        && state->request.providers != request.providers;
    const bool viewportChanged = ssc::wantsPortraitArtwork(state->request) != ssc::wantsPortraitArtwork(request)
        || ssc::wants4kArtwork(state->request) != ssc::wants4kArtwork(request);
    // Logo/rating refinements keep the image stable. A different artwork format
    // crossfades once ready, or fades to the default when that variant misses.
    const bool animateBackdrop = !sameTrackIdentity || artworkSelectionChanged || viewportChanged || forceReload;

    // A queue snapshot normally arrives just after current-playing. Attach it to
    // the existing epoch instead of aborting/restarting the current resolver call.
    if (!forceReload) {
        const bool sameCurrent = state->epoch != 0
            && state->current.album == current.album && state->current.track == current.track
            && state->current.artist == current.artist && state->current.coverUrl == current.coverUrl
            && state->request.includeTitleLogo == request.includeTitleLogo
            && sameResolverConfig(state->request, request);
        if (sameCurrent) {
            if (queue.empty() && !queueSnapshot) return; // not an authoritative queue response
            state->work.erase(std::remove_if(state->work.begin(), state->work.end(),
                [](const MediaWorkerState::Work& item) { return !item.current; }), state->work.end());
            // repaint/retry can pass the stored queue itself.
            updateQueue();
            setComingNextQueueLocked(state);
            queueMediaPrefetchLocked(state, request, snapshot.station);
            state->cv.notify_all();
            return;
        }
    }

    unsigned long long epoch;
    std::shared_ptr<std::atomic<bool> > cancel(new std::atomic<bool>(false));
    {
        if (state->cancel) state->cancel->store(true);
        state->cancel = cancel;
        {
            // Generation changes and publication share the SAME lock. An old
            // publisher can finish before this boundary, but never after it.
            ssc::platform::LockGuard publication(mutex_);
            epoch = state->epoch = ++activeMediaEpoch_;
            fanartKeyRejected_ = false;
            if (!sameTrackIdentity || state->request.providers != request.providers
                    || effectiveFanartKey(state->request) != effectiveFanartKey(request)) {
                for (auto& selected : backdropSelections_) selected = BackdropSelection();
            }
            backdropPortrait_ = ssc::wantsPortraitArtwork(request);
            cyclingEpoch_ = 0;
            backdropSelection_ = 0;
            backdropLoading_ = false;
            if (!sameTrackIdentity && !retainQueue) comingNext_.setQueue("", L"", L"");
            mediaDirty_ = false; // discard an old result waiting in the UI mailbox
            titleLogoDirty_ = false;
            if (!request.includeTitleLogo || state->current.album != current.album
                    || state->current.track != current.track || state->current.artist != current.artist
                    || current.stationIdent) {
                pendingTitleLogoBytes_.clear(); pendingTitleLogoAlbum_.clear();
                pendingTitleLogoEpoch_ = epoch; pendingTitleLogoImmediate_ = false;
                titleLogoDirty_ = true;
                if (window) PostMessageA(window, SSC_WM_NEWMEDIA, 0, 0);
            }
            infoFadeMs_ = (snapshot.transition != 0 || window) && clientAnimationsEnabled()
                ? (snapshot.transition == 0 ? 120 : snapshot.fadeMs) : 0;
            info_.begin(ssc::platform::integerText(snapshot.station) + "\n" + current.album + "\n"
                + current.track + "\n" + current.artist + (current.stationIdent ? "\nident" : "\ntrack"),
                GetTickCount(), infoFadeMs_);
        }
        state->work.clear();
        state->current = current;
        updateQueue();
        state->request = request;
    }
    setComingNextQueueLocked(state);

    // Even with visual media disabled, /api/media canonicalizes Album/Track/Artist
    // without contacting third-party providers. This is the single native source
    // for HTML entities and rotated articles.
    const bool enabled = !current.stationIdent && !current.album.empty();
    if (!enabled) {
        clearMedia(epoch);
        return;
    }

    MediaWorkerState::Work now;
    now.due = MediaWorkerState::Clock::now(); now.order = ++state->order;
    now.epoch = epoch; now.current = true; now.reload = forceReload;
    now.track = current; now.request = request; now.cancel = cancel;
    now.creditHost = ssc::station(snapshot.station).host;
    now.animateBackdrop = animateBackdrop;
    now.immediateCachedTitleLogo = immediateCachedTitleLogo;
    bool logoPrepared = false;
    if (!forceReload) {
        // A cached current item must not queue behind a slow (even cancelled)
        // HTTP request. This includes confirmed misses: artwork for the previous
        // viewport must fade to the default when the new viewport has no backdrop.
        // Publish under the new epoch directly from the scheduler.
        const auto cached = state->cache.find(ssc::mediaCacheKey(current, request));
        if (cached != state->cache.end()) {
#if SSC_ENABLE_DEBUG_OVERLAY
            ssc::DiagnosticLog::instance().event("cache.media.hit", current);
#endif
            auto& entry = cached->second;
            entry.used = ++state->lru;
            MediaWorkerState::CacheEntry fallback;
            const bool haveFallback = entry.bytes.empty() && cachedBackdrop(state, current, request, fallback);
            const auto& artwork = haveFallback ? fallback : entry;
            const auto& ratings = entry.result.certifications.empty() ? artwork.result : entry.result;
            publishMetadata(epoch, entry.result, current.lengthSeconds);
            publishMedia(epoch, artwork.bytes, ratingBadges(ratings), false,
                         &artwork.result, animateBackdrop);
            now.backdropPublished = true;
            const auto& logoResult = haveFallback && sameResolverConfig(fallback.request, request)
                ? fallback.result : entry.result;
            const auto logo = state->titleLogoCache.find(logoResult.titleLogoUrl);
            logoPrepared = logoResult.titleLogoUrl.empty() || logo != state->titleLogoCache.end();
            if (logoPrepared)
                publishTitleLogo(epoch, logo == state->titleLogoCache.end() ? std::string() : logo->second,
                                 logoResult.album, immediateCachedTitleLogo);
        }
    }
    if (!now.backdropPublished || !logoPrepared) state->work.push_back(std::move(now));
    queueMediaPrefetchLocked(state, request, snapshot.station, animateBackdrop, immediateCachedTitleLogo);
    state->cv.notify_all();
}

void CoverEngine::publishMedia(unsigned long long epoch, const std::string& backdropBytes,
                               const std::vector<d2d::RatingBadge>& ratings, bool imageFailed,
                               const ssc::MediaResult* mediaResult, bool animateBackdrop) {
    {
        ssc::platform::LockGuard lock(mutex_);
        if (!epoch || activeMediaEpoch_ != epoch) return;
        if (cyclingEpoch_ == epoch && backdropSelection_) return; // keep the user's selection
        cyclingMedia_ = mediaResult ? *mediaResult : ssc::MediaResult();
        cyclingEpoch_ = epoch;
        backdropIndex_ = 0;
        pendingBackdropBytes_ = backdropBytes;
        // Viewport changes resolve the provider's default again. Restore the
        // listener's choice only when it still belongs to this variant's list.
        const auto& selected = backdropSelections_[backdropPortrait_ ? 1 : 0];
        if (mediaResult && !selected.bytes.empty()) {
            for (size_t i = 0; i < cyclingMedia_.backdrops.size(); ++i) {
                const auto& candidate = cyclingMedia_.backdrops[i];
                if (candidate.url == selected.result.backdropUrl && candidate.source == selected.result.source) {
                    backdropIndex_ = i;
                    pendingBackdropBytes_ = selected.bytes;
                    mediaResult = &selected.result;
                    imageFailed = false;
                    break;
                }
            }
        }
        pendingRatings_ = ratings;
        pendingMediaClear_ = pendingBackdropBytes_.empty();
        pendingBackdropChange_ = true;
        pendingBackdropAnimate_ = animateBackdrop;
        mediaImageFailed_ = imageFailed;
        pendingMediaHasTint_ = !pendingBackdropBytes_.empty() && mediaResult && mediaResult->hasTint;
        pendingMediaEpoch_ = epoch;
        if (pendingMediaHasTint_)
            for (int i = 0; i < 3; ++i) pendingMediaTint_[i] = mediaResult->tint[i];
        mediaDirty_ = true;
    }
    if (HWND w = hwnd_.load()) PostMessageA(w, SSC_WM_NEWMEDIA, 0, 0);
}

void CoverEngine::publishRatings(unsigned long long epoch,
                                 const std::vector<d2d::RatingBadge>& ratings) {
    {
        ssc::platform::LockGuard lock(mutex_);
        if (!epoch || activeMediaEpoch_ != epoch) return;
        pendingRatings_ = ratings;
        pendingBackdropChange_ = mediaDirty_ && pendingBackdropChange_;
        pendingMediaEpoch_ = epoch;
        mediaImageFailed_ = false;
        mediaDirty_ = true;
    }
    if (HWND w = hwnd_.load()) PostMessageA(w, SSC_WM_NEWMEDIA, 0, 0);
}

using ssc::queuedTrackIdentity;

void CoverEngine::setComingNextQueueLocked(MediaWorkerState* state) {
    const ssc::TrackInfo* next = nullptr;
    for (const auto& track : state->queue) {
        if (!track.album.empty() && !track.stationIdent) { next = &track; break; }
    }
    ssc::platform::LockGuard lock(mutex_);
    if (!next) { comingNext_.setQueue("", L"", L""); return; }
    const std::string identity = queuedTrackIdentity(*next);
    comingNext_.setQueue(identity, toWide(next->album), toWide(next->artist));
    if (next->coverUrl == nextUrl_ && !nextBytes_.empty()) comingNext_.setCover(identity, nextBytes_);
    // A previously prefetched row may have just become first. Text is independent
    // of artwork orientation/provider settings; reuse it without copying images.
    const MediaWorkerState::CacheEntry* best = nullptr;
    for (const auto& item : state->cache) {
        const auto& entry = item.second;
        if (queuedTrackIdentity(entry.track) == identity
                && (next->artist.empty() || next->artist == entry.track.artist)
                && (!best || entry.used > best->used)) best = &entry;
    }
    if (best) comingNext_.resolve(identity, toWide(best->result.album),
        toWide(best->result.artist), best->result.hasMetadata);
}

void CoverEngine::publishQueuedMetadata(unsigned long long epoch, const ssc::TrackInfo& track,
                                        const ssc::MediaResult& result) {
    {
        ssc::platform::LockGuard lock(mutex_);
        if (!epoch || epoch != activeMediaEpoch_) return;
        comingNext_.resolve(queuedTrackIdentity(track),
            toWide(result.album.empty() ? track.album : result.album),
            toWide(result.artist.empty() ? track.artist : result.artist), result.hasMetadata);
    }
    invalidate();
}

bool CoverEngine::updateComingNext(DWORD now) {
    ssc::platform::LockGuard lock(mutex_);
    const auto frame = comingNext_.advance(settings.comingNext, currentRemaining(), now,
        clientAnimationsEnabled() ? ssc::kComingNextTransitionMs : 0);
    const bool changed = frame != comingNextFrame_;
    comingNextFrame_ = frame;
    return changed;
}

void CoverEngine::publishMetadata(unsigned long long epoch, const ssc::MediaResult& result,
                                  int /*lengthSeconds*/) {
    if (result.album.empty()) return;
    std::string title = result.album;
    std::string track = result.track;
    if (!result.track.empty()) title += " - " + result.track;
    {
        ssc::platform::LockGuard lock(mutex_);
        if (!epoch || activeMediaEpoch_ != epoch) return;
        info_.settle(toWide(title), toWide(result.artist), result.hasMetadata,
            GetTickCount(), infoFadeMs_, toWide(result.album), toWide(track));
        fanartKeyRejected_ = result.fanartKeyRejected;
    }
    invalidate();
}

void CoverEngine::clearMedia(unsigned long long epoch) {
    publishTitleLogo(epoch, "", "");
    publishMedia(epoch, std::string(), std::vector<d2d::RatingBadge>(), false);
}

void CoverEngine::publishTitleLogo(unsigned long long epoch, const std::string& bytes,
                                   const std::string& album, bool immediate) {
    {
        ssc::platform::LockGuard lock(mutex_);
        if (!epoch || epoch != activeMediaEpoch_) return;
        pendingTitleLogoBytes_ = bytes; pendingTitleLogoAlbum_ = album;
        pendingTitleLogoEpoch_ = epoch; pendingTitleLogoImmediate_ = immediate;
        titleLogoDirty_ = true;
    }
    if (HWND w = hwnd_.load()) PostMessageA(w, SSC_WM_NEWMEDIA, 0, 0);
}

void CoverEngine::start(bool autoAdvance) {
    ssc::platform::LockGuard life(monitorLifecycle_);
    if (monitor_ || demoOn_) return;
    autoAdvance_ = autoAdvance;
    startMediaWorker();
    // Screenshot/demo mode (checked once, here): if the demo folder exists, play its
    // covers instead of a station. Everything downstream is the unchanged real engine.
    if (ssc::Demo::active() && demo_.load()) {
        demoOn_ = true;
        logLine("demo mode: " + ssc::platform::integerText(demo_.count()) + " covers");
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
        // overlay counts down locally. Host title changes request confirmation;
        // they cannot tell us whether music or an inserted jingle is starting.
        setRemaining(info.remainingSeconds);
        // Keep the outgoing text until /api/media has completed. Its result then
        // supplies canonical metadata or the validated stream fallback; on startup
        // the empty info state therefore remains hidden for the whole request.
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
        logLine("setStation: ignoring invalid index " + ssc::platform::integerText(index));
        return;
    }
    ssc::platform::LockGuard life(monitorLifecycle_);
    if (index == settings.station && monitor_) return; // already on this station
    settings.station = index;
    if (!monitor_) return; // not started yet; start() will pick up settings.station

    // Rebuild the monitor against the new host and drop the old station's cover so
    // we don't briefly show the wrong art. Safe on the UI thread: stop() joins the
    // monitor's background thread before we tear it down.
    monitor_->stop(); delete monitor_; monitor_ = nullptr;
    if (media_) {
        ssc::platform::LockGuard lock(media_->mutex);
        media_->settingsSnapshot = settings;
        scheduleMediaLocked(media_, ssc::TrackInfo(), std::vector<ssc::TrackInfo>(), true);
    }
    {
        ssc::platform::LockGuard lock(mutex_);
        coverBytes_.clear(); dirty_ = false;
        shownUrl_.clear(); shownBytes_.clear(); shownStation_ = -1;
        nextUrl_.clear(); nextBytes_.clear();
    }
    coverRetryAt_.store(0); coverRetryFailures_ = 0; coverRetryUrl_.clear();
    resetTitle();          // next accepted title reloads; hide the countdown
    loading_.store(true);  // show "Loading..." until the new station replies
    invalidate();
    startMonitor();
    if (monitor_) monitor_->refresh(); // fetch the new station's current cover now
}

void CoverEngine::stop() {
#if SSC_ENABLE_DEBUG_OVERLAY
    debugOverlay_.attach(nullptr, {});
#endif
    {
        ssc::platform::LockGuard life(monitorLifecycle_);
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
        ssc::platform::LockGuard lock(mutex_);
        coverBytes_ = f.bytes; dirty_ = true;
        std::string t = f.album;
        if (!f.album.empty() && !f.track.empty()) t = f.album + " - " + f.track;
        else if (!f.track.empty())                t = f.track;
        if (!t.empty() && f.seconds > 0) {
            const int mm = f.seconds / 60, ss = f.seconds % 60;
            t += " (" + ssc::platform::integerText(mm) + ":" + (ss < 10 ? "0" : "") + ssc::platform::integerText(ss) + ")";
        }
        const int duration = settings.transition != 0 && clientAnimationsEnabled() ? settings.fadeMs : 0;
        info_.begin("demo\n" + t + "\n" + f.artist, GetTickCount(), duration);
        info_.settle(toWide(t), toWide(f.artist), true, GetTickCount(), duration);
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
    {
        ssc::platform::LockGuard lock(mutex_);
        const HWND previous = hwnd_.load();
        if (previous && previous != h) retainedViews_.insert_or_assign(previous, presentation_);
        if (h && h != previous) {
            const auto found = retainedViews_.find(h);
            if (found != retainedViews_.end()) {
                // Content is source state; replay it into the returning view's
                // own layout/overlay timelines instead of borrowing fullscreen's.
                const auto currentInfo = info_;
                const auto currentNext = comingNext_;
                const auto currentFrame = frame_;
                presentation_ = found->second;
                info_ = currentInfo; comingNext_ = currentNext;
                if (!currentFrame.cover.empty()) presentation_.setArtwork(currentFrame.cover.back().image);
                presentation_.setLogo(currentFrame.logo,currentFrame.logoAlbum);
            }
        }
        for (auto it=retainedViews_.begin(); it!=retainedViews_.end();) {
            if (!IsWindow(it->first)) it=retainedViews_.erase(it); else ++it;
        }
    }
    hwnd_.store(h);
#if SSC_ENABLE_DEBUG_OVERLAY
    debugOverlay_.attach(h, [this] { return debugSnapshot(); });
#endif
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
    { ssc::platform::LockGuard lock(mutex_); havePending = !coverBytes_.empty(); if (havePending) dirty_ = true;
      haveMediaPending = mediaDirty_; }
    if (havePending) PostMessageA(h, SSC_WM_NEWCOVER, 0, 0);
    else if (monitor_) monitor_->refresh();
    if (haveMediaPending) PostMessageA(h, SSC_WM_NEWMEDIA, 0, 0);
    repaint(); // select and publish a cached viewport variant before the first paint
    decodePendingMedia(h);
    updatePresentation(h);
    // Replace this HWND's retained pixels before fullscreen uncovers it. Merely
    // invalidating leaves its old portrait surface visible until the next WM_PAINT,
    // followed by the outgoing fullscreen image and then the intended crossfade.
    onPaint(h);
    InvalidateRect(h, nullptr, FALSE);
}

#if SSC_ENABLE_DEBUG_OVERLAY
ssc::JsonValue CoverEngine::debugSnapshot() {
    using namespace ssc;
    JsonValue out = DiagnosticLog::instance().snapshot();
    auto& root = out.object;
    diagnosticSetString(root, "client", g_logBase);
    diagnosticSetString(root, "build", std::string(__DATE__) + " " + __TIME__);
    diagnosticSetString(root, "resolverVersion", MediaResolverConfig().resolverVersion);
    diagnosticSetString(root, "station", ssc::station(settings.station).host);
    JsonValue display = diagnosticObject(); RECT r = {}; GetClientRect(hwnd_.load(), &r);
    diagnosticSetNumber(display.object, "width", r.right); diagnosticSetNumber(display.object, "height", r.bottom);
    diagnosticSetString(display.object, "orientation", r.bottom > r.right ? "portrait" : "landscape");
    diagnosticSetString(display.object, "resolution", r.right > 1920 || r.bottom > 1080 ? "4k" : "hd");
    diagnosticSetString(display.object, "layout", settings.layout ? "poster" : "fill");
    diagnosticSetString(display.object, "renderer", "Direct2D");
    const auto renderer = d2d::liveDiagnostics();
    diagnosticSetNumber(display.object, "coverWidth", renderer.coverWidth);
    diagnosticSetNumber(display.object, "coverHeight", renderer.coverHeight);
    diagnosticSetNumber(display.object, "backdropWidth", renderer.backdropWidth);
    diagnosticSetNumber(display.object, "backdropHeight", renderer.backdropHeight);
    diagnosticSetNumber(display.object, "decodedCacheBytes", static_cast<double>(renderer.cacheBytes));
    diagnosticSetNumber(display.object, "decodedCacheEntries", static_cast<double>(renderer.cacheEntries));
    diagnosticSetNumber(display.object, "blurBytes", static_cast<double>(renderer.blurBytes));
    diagnosticSetBool(display.object, "backdropVisible", haveBackdrop_);
    diagnosticSetNumber(display.object, "remainingSeconds", currentRemaining());
    BOOL motion = TRUE; SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &motion, 0);
    diagnosticSetBool(display.object, "reducedMotion", !motion);
    root["display"] = display;
    JsonValue options = diagnosticObject();
    diagnosticSetBool(options.object, "backdrops", settings.backdrops);
    diagnosticSetBool(options.object, "titleLogos", settings.titleLogos);
    diagnosticSetBool(options.object, "ratings", settings.ratings);
    diagnosticSetString(options.object, "providers", settings.mediaProviders);
    diagnosticSetBool(options.object, "hideCoverWithBackdrop", settings.hideCoverWithBackdrop);
    diagnosticSetBool(options.object, "personalAccessConfigured", !settings.fanartClientKey.empty());
    root["settings"] = options;
    if (media_) {
        ssc::platform::LockGuard lock(media_->mutex);
        auto track = [](const TrackInfo& t) {
            JsonValue value = diagnosticObject();
            diagnosticSetString(value.object, "album", t.album); diagnosticSetString(value.object, "artist", t.artist);
            diagnosticSetString(value.object, "track", t.track); diagnosticSetString(value.object, "coverUrl", t.coverUrl);
            diagnosticSetString(value.object, "originalCoverUrl", t.originalCover);
            diagnosticSetString(value.object, "thumbnailUrl", t.thumbnailUrl);
            diagnosticSetNumber(value.object, "lengthSeconds", t.lengthSeconds); return value;
        };
        root["track"] = track(media_->current);
        root["queue"] = diagnosticArray();
        for (const auto& t : media_->queue) root["queue"].array.push_back(track(t));
        JsonValue cache = diagnosticObject();
        diagnosticSetNumber(cache.object, "mediaEntries", static_cast<double>(media_->cache.size()));
        diagnosticSetNumber(cache.object, "logoEntries", static_cast<double>(media_->titleLogoCache.size()));
        diagnosticSetNumber(cache.object, "pendingWork", static_cast<double>(media_->work.size()));
        diagnosticSetNumber(cache.object, "epoch", static_cast<double>(media_->epoch));
        diagnosticSetString(cache.object, "expiry", "session / bounded LRU");
        root["localCache"] = cache;
        auto timeline = media_->timeline.entries(media_->queue, currentRemaining());
        for (auto& item : timeline.array) {
            auto prepared = diagnosticObject();
            auto artworkDetails = diagnosticObject();
            artworkDetails.object["coverUrl"] = debugValue(item, "coverUrl");
            auto resolvedVariants = diagnosticArray();
            bool metadata = false, artwork = false, image = false; unsigned variants = 0;
            for (const auto& entry : media_->cache) {
                const auto& cached = entry.second;
                if (cached.track.album != debugValue(item, "album").string
                        || cached.track.track != debugValue(item, "track").string) continue;
                ++variants; metadata = metadata || cached.result.hasMetadata;
                artwork = artwork || cached.result.hasBackdrop(); image = image || !cached.bytes.empty();
                auto resolved = diagnosticObject();
                diagnosticSetString(resolved.object, "album", cached.result.album);
                diagnosticSetString(resolved.object, "track", cached.result.track);
                diagnosticSetString(resolved.object, "artist", cached.result.artist);
                diagnosticSetString(resolved.object, "backdropUrl", cached.result.backdropUrl);
                diagnosticSetString(resolved.object, "logoUrl", cached.result.titleLogoUrl);
                diagnosticSetString(resolved.object, "source", cached.result.source);
                diagnosticSetString(resolved.object, "status", cached.result.status == MediaResult::Hit ? "hit"
                    : cached.result.status == MediaResult::Miss ? "miss" : "failure");
                diagnosticSetString(resolved.object, "orientation", wantsPortraitArtwork(cached.request) ? "portrait" : "landscape");
                diagnosticSetString(resolved.object, "resolution", wants4kArtwork(cached.request) ? "4k" : "hd");
                diagnosticSetNumber(resolved.object, "imageBytes", static_cast<double>(cached.bytes.size()));
                resolved.object["tint"] = diagnosticArray();
                if (cached.result.hasTint) for (const auto channel : cached.result.tint)
                    resolved.object["tint"].array.push_back(diagnosticNumber(channel));
                resolvedVariants.array.push_back(resolved);
            }
            diagnosticSetBool(prepared.object, "metadata", metadata);
            diagnosticSetBool(prepared.object, "artwork", artwork);
            diagnosticSetBool(prepared.object, "imageBytes", image);
            diagnosticSetNumber(prepared.object, "variants", variants);
            item.object["cache"] = prepared;
            artworkDetails.object["variants"] = resolvedVariants;
            diagnosticSetString(artworkDetails.object, "status", variants ? "Cached results for this track" : "No cached resolver result for this track");
            item.object["artwork"] = artworkDetails;
        }
        root["timeline"] = timeline;
        const auto found = media_->cache.find(mediaCacheKey(media_->current, media_->request));
        if (found != media_->cache.end()) {
            const auto& result = found->second.result;
            JsonValue resolved = diagnosticObject();
            diagnosticSetString(resolved.object, "album", result.album);
            diagnosticSetString(resolved.object, "artist", result.artist); diagnosticSetString(resolved.object, "track", result.track);
            diagnosticSetString(resolved.object, "backdropUrl", result.backdropUrl);
            diagnosticSetString(resolved.object, "logoUrl", result.titleLogoUrl);
            diagnosticSetString(resolved.object, "source", result.source);
            diagnosticSetString(resolved.object, "status", result.status == MediaResult::Hit ? "hit" : result.status == MediaResult::Miss ? "miss" : "failure");
            root["resolved"] = resolved;
        }
    }
    {
        ssc::platform::LockGuard lock(mutex_);
        diagnosticSetString(root, "shownCoverUrl", shownUrl_);
        diagnosticSetString(root, "preloadedCoverUrl", nextUrl_);
        diagnosticSetNumber(root, "shownCoverBytes", static_cast<double>(shownBytes_.size()));
    }
    return diagnosticSanitize(std::move(out));
}
#endif

// --- monitor callback (background thread) -----------------------------------
void CoverEngine::onCoverChanged(const std::string& url, const ssc::TrackInfo& info) {
    // Match the web player's ident fallback: an empty/untrusted CoverLink displays
    // the selected station logo. The URL is a project-owned constant, never feed data.
    int station = 0;
    if (media_) {
        ssc::platform::LockGuard lock(media_->mutex);
        station = media_->settingsSnapshot.station;
    }
    const std::string displayUrl = url.empty() ? ssc::station(station).logoUrl : url;
    logLine("poll: current cover = " + displayUrl + (url.empty() ? " (station ident)" : ""));

    // Start current media resolution immediately and independently. Queue metadata
    // is attached below without restarting this request.
    scheduleMedia(info, std::vector<ssc::TrackInfo>());
    if (info.stationIdent) {
        ssc::platform::LockGuard lock(mutex_);
        info_.settle(toWide(ssc::stationIdentAlbumLabel(info.album, station)),
            toWide(info.artist), false, GetTickCount(), infoFadeMs_);
    }

    // stop()/setStation() run on the host UI thread and join this (monitor) thread.
    // If we are mid-retry when that happens, abandon the remaining downloads so the
    // join returns promptly instead of grinding through every attempt's timeout.
    const std::atomic<bool>* cancelTok = monitor_ ? monitor_->cancelToken() : nullptr;

    // (1) Reconcile: only (re)show if `url` isn't already displayed.
    bool alreadyShown;
    std::string img;
    {
        ssc::platform::LockGuard lock(mutex_);
        alreadyShown = (displayUrl == shownUrl_);
        if (displayUrl == nextUrl_ && !nextBytes_.empty()) img = nextBytes_;
    }
    if (!alreadyShown) {
        if (img.empty()) {
            loading_.store(true);
            invalidate();
            img = ssc::MediaPreparation().cover(displayUrl, station, 20, cancelTok);
            logLine("downloaded current " + ssc::platform::integerText(img.size()) + " bytes");
        } else {
            logLine("current already preloaded, no download");
        }
        if (img.empty()) {
            loading_.store(false);
            if (coverRetryUrl_ != displayUrl) { coverRetryUrl_ = displayUrl; coverRetryFailures_ = 0; }
            const int delay = ssc::coverRetryDelayMs(++coverRetryFailures_);
            coverRetryAt_.store(GetTickCount() + (DWORD)delay);
            logLine("current cover retry in " + ssc::platform::integerText(delay) + " ms");
            invalidate();
        } else {
            { ssc::platform::LockGuard lock(mutex_); coverBytes_ = img; dirty_ = true;
                shownUrl_ = displayUrl; shownBytes_ = img; shownStation_ = station; }
            coverRetryFailures_ = 0; coverRetryUrl_.clear(); coverRetryAt_.store(0);
            notifyNewCover();
        }
    }

    // (2) One queue request supplies both the next square cover and all media
    // prefetch metadata, so the clients cannot drift on Album/Track/Artist data.
    std::vector<ssc::TrackInfo> queue;
    bool haveQueueSnapshot = false;
    if (media_) {
        ssc::platform::LockGuard lock(media_->mutex);
        haveQueueSnapshot = media_->queueSnapshotReady;
        if (haveQueueSnapshot) queue = media_->queue;
    }
    // A retry or an early ICY notification can still confirm the old track.
    // Fetch only once per confirmed music track, as the web player does.
    if (!haveQueueSnapshot && monitor_ && monitor_->queue(queue)) {
        scheduleMedia(info, queue, false, true);
    }
    if (!queue.empty() && !queue[0].coverUrl.empty()) {
        const std::string nextUrl = queue[0].coverUrl;
        const int nextLen = queue[0].lengthSeconds;
        bool haveIt;
        { ssc::platform::LockGuard lock(mutex_); haveIt = (nextUrl == nextUrl_ && !nextBytes_.empty()); }
        if (!haveIt) {
            std::string nextImg = ssc::MediaPreparation().cover(nextUrl, station, 20, cancelTok);
            logLine("preloaded next " + ssc::platform::integerText(nextImg.size()) + " bytes, len=" +
                    ssc::platform::integerText(nextLen) + "s: " + nextUrl);
            ssc::platform::LockGuard lock(mutex_);
            nextUrl_ = nextUrl;
            nextBytes_.swap(nextImg);
            comingNext_.setCover(queuedTrackIdentity(queue[0]), nextBytes_);
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

    // A title notification may introduce a jingle, not the queued music. Keep
    // its prepared cover until the now-playing feed confirms that identity.
    const bool firstTitle = lastTitle_.empty();
    lastTitle_ = title;
    if (!firstTitle) {
        setRemaining(-1);
        invalidate();
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
    { ssc::platform::LockGuard lock(mutex_); presentation_.pointerChanged(true, fullscreenAutoHide, true); }
    updateRatingVisibility(now);
}

void CoverEngine::onPointerLeave(HWND h) {
    if (!h || h != hwnd_.load()) return;
    ratingPointerInside_ = false;
    { ssc::platform::LockGuard lock(mutex_); presentation_.pointerChanged(false, false, false); }
    ratingPointerVisibleUntil_ = 0;
    updateRatingVisibility(GetTickCount());
}

void CoverEngine::repaint() {
    if (media_) {
        ssc::platform::LockGuard lock(media_->mutex);
        media_->settingsSnapshot = settings;
        // Snapshot + reschedule are one transaction: a monitor callback cannot
        // insert a newer track between reading current and scheduling it again.
        if (!media_->current.album.empty())
            scheduleMediaLocked(media_, media_->current, media_->queue, false);
    }
    invalidate();
}

bool CoverEngine::albumToggleHitTest(HWND h, int x, int y) const {
    if (h != hwnd_.load() || settings.station != 0 || !settings.backdrops
            || settings.layout != 1) return false;
    return d2d::albumHitTest(h, x, y);
}

bool CoverEngine::albumToggleAtCursor(HWND h) const {
    POINT point = {};
    return GetCursorPos(&point) && ScreenToClient(h, &point)
        && (albumToggleHitTest(h, point.x, point.y) || backdropHitTest(h, point.x, point.y));
}

bool CoverEngine::fanartHintHitTest(HWND h, int x, int y) const {
    ssc::platform::LockGuard lock(mutex_);
    return h == hwnd_.load() && settings.station == 0 && settings.backdrops
        && fanartKeyRejected_ && d2d::fanartHintHitTest(h, x, y);
}

bool CoverEngine::fanartHintAtCursor(HWND h) const {
    POINT point = {};
    return GetCursorPos(&point) && ScreenToClient(h, &point)
        && fanartHintHitTest(h, point.x, point.y);
}

bool CoverEngine::onAlbumClick(HWND h, int x, int y) {
    if (!albumToggleHitTest(h, x, y)) return false;
    settings.titleLogos = !settings.titleLogos;
    repaint();
    return true;
}

bool CoverEngine::cycleBackdrop(HWND h, int direction) {
    if (h != hwnd_.load() || !media_ || !settings.backdrops || !direction) return false;
    ssc::platform::LockGuard workLock(media_->mutex);
    ssc::platform::LockGuard lock(mutex_);
    const size_t count = cyclingMedia_.backdrops.size();
    if (cyclingEpoch_ != activeMediaEpoch_ || count < 2) return false;
    backdropIndex_ = (backdropIndex_ + count + (direction < 0 ? -1 : 1)) % count;
    MediaWorkerState::Work item;
    item.kind = MediaWorkerState::Work::Cycle;
    item.selection = ++backdropSelection_;
    item.epoch = activeMediaEpoch_;
    item.current = true;
    item.cancel = media_->cancel;
    item.result = std::make_shared<ssc::MediaResult>(cyclingMedia_);
    item.result->backdropUrl = cyclingMedia_.backdrops[backdropIndex_].url;
    item.result->source = cyclingMedia_.backdrops[backdropIndex_].source;
    if (backdropIndex_) item.result->hasTint = false;
    item.due = MediaWorkerState::Clock::now() - std::chrono::hours(1);
    item.order = ++media_->order;
    media_->work.erase(std::remove_if(media_->work.begin(), media_->work.end(),
        [](const MediaWorkerState::Work& work) { return work.kind == MediaWorkerState::Work::Cycle; }), media_->work.end());
    media_->work.push_back(std::move(item));
    mediaDirty_ = false;
    const bool fade = transitionAnimates() && h && clientAnimationsEnabled();
    if (!backdropLoading_) {
        d2d::clearBackdrop(fade);
        mediaFading_ = mediaFadePending_ = fade;
    }
    backdropLoading_ = true;
    media_->cv.notify_all();
    invalidate();
    return true;
}

void CoverEngine::publishCycledBackdrop(unsigned long long epoch, unsigned long long selection,
                                       const std::string& bytes, const ssc::MediaResult& result) {
    ssc::platform::LockGuard lock(mutex_);
    if (activeMediaEpoch_ != epoch || backdropSelection_ != selection) return;
    if (!bytes.empty()) {
        auto& selected = backdropSelections_[backdropPortrait_ ? 1 : 0];
        selected.result = result;
        selected.bytes = bytes;
    }
    pendingBackdropBytes_ = bytes;
    pendingMediaEpoch_ = epoch;
    pendingMediaClear_ = bytes.empty();
    pendingBackdropChange_ = pendingBackdropAnimate_ = true;
    pendingRatings_ = ratingBadges(result);
    pendingMediaHasTint_ = result.hasTint;
    for (int i = 0; i < 3; ++i) pendingMediaTint_[i] = result.tint[i];
    mediaImageFailed_ = bytes.empty();
    mediaDirty_ = true;
    if (HWND h = hwnd_.load()) PostMessageA(h, SSC_WM_NEWMEDIA, 0, 0);
}

bool CoverEngine::onBackdropKey(HWND h, unsigned key) {
    if ((key != VK_LEFT && key != VK_RIGHT) || GetKeyState(VK_CONTROL) < 0
            || GetKeyState(VK_MENU) < 0 || GetKeyState(VK_SHIFT) < 0
            || GetKeyState(VK_LWIN) < 0 || GetKeyState(VK_RWIN) < 0) return false;
    return cycleBackdrop(h, key == VK_LEFT ? -1 : 1);
}

int CoverEngine::backdropHitTest(HWND h, int x, int y) const {
    ssc::platform::LockGuard lock(mutex_);
    if (!h || h != hwnd_.load() || !settings.backdrops || !ratingPointerInside_
            || (ratingPointerAutoHide_ && (LONG)(ratingPointerVisibleUntil_ - GetTickCount()) <= 0)
            || cyclingEpoch_ != activeMediaEpoch_ || cyclingMedia_.backdrops.size() < 2) return 0;
    return d2d::backdropNavigationHitTest(h, x, y);
}

bool CoverEngine::onBackdropClick(HWND h, int x, int y) {
    const int direction = backdropHitTest(h, x, y);
    return direction && cycleBackdrop(h, direction);
}

float CoverEngine::backdropNavigationAlpha(DWORD now) {
    bool available;
    { ssc::platform::LockGuard lock(mutex_);
      available = settings.backdrops && cyclingEpoch_ == activeMediaEpoch_ && cyclingMedia_.backdrops.size() > 1; }
    const bool visible = available && ratingPointerInside_
        && (!ratingPointerAutoHide_ || (LONG)(ratingPointerVisibleUntil_ - now) > 0);
    const float target = visible ? 1.0f : 0.0f;
    const float step = navigationTick_ ? (now - navigationTick_) / 200.0f : 0;
    navigationTick_ = now;
    if (!clientAnimationsEnabled()) navigationAlpha_ = target;
    else if (navigationAlpha_ < target) navigationAlpha_ = (std::min)(target, navigationAlpha_ + step);
    else navigationAlpha_ = (std::max)(target, navigationAlpha_ - step);
    return navigationAlpha_;
}

float CoverEngine::fanartHintOpacity(DWORD now) {
    ssc::platform::LockGuard lock(mutex_);
    const bool visible = settings.station == 0 && settings.backdrops && fanartKeyRejected_;
    const int fadeMs = clientAnimationsEnabled() ? 200 : 0;
    fanartHint_.begin(visible ? "fanart-key-rejected" : "", now, fadeMs);
    if (visible) fanartHint_.settle(L"fanart.tv key rejected", L"Check provider settings", false, now, fadeMs);
    return fanartHintAlpha_ = fanartHint_.advance(now, fadeMs);
}

void CoverEngine::retryMedia() {
    if (!media_) return;
    ssc::platform::LockGuard lock(media_->mutex);
    media_->settingsSnapshot = settings;
    if (!media_->current.album.empty())
        scheduleMediaLocked(media_, media_->current, media_->queue, true);
}

bool CoverEngine::currentCover(std::string& out, int stationIndex) {
    ssc::platform::LockGuard lock(mutex_);
    out.clear();
    if (stationIndex < 0 || stationIndex != shownStation_ || shownBytes_.empty()) return false;
    out = shownBytes_;
    return true;
}

// --- window messages --------------------------------------------------------
void CoverEngine::decodePending(HWND h) {
    std::string bytes;
    {
        ssc::platform::LockGuard lock(mutex_);
        if (dirty_) { bytes.swap(coverBytes_); dirty_ = false; }
    }
    if (bytes.empty()) return;

    const bool fade = transitionAnimates() && haveCover_ && h && clientAnimationsEnabled();
    d2d::setCover(bytes.data(), bytes.size(), fade);
    { ssc::platform::LockGuard lock(mutex_); presentation_.setArtwork(std::make_shared<const std::string>(bytes)); }
    if (fade) { fadeStart_ = GetTickCount(); fading_ = true; } // heartbeat drives the fade
    haveCover_ = true;
    loading_.store(false);
    logLine("cover decoded + shown (" + ssc::platform::integerText(bytes.size()) + " bytes)");
    if (h) InvalidateRect(h, nullptr, FALSE);
}

void CoverEngine::onNewCover(HWND h) { if (h == hwnd_.load()) { decodePending(h); updatePresentation(h); } }

void CoverEngine::decodePendingMedia(HWND h) {
    // Validate AND commit under the publication lock. Epoch advancement cannot
    // race the renderer after the pending payload has been taken from its mailbox.
    ssc::platform::LockGuard lock(mutex_);
    if (titleLogoDirty_) {
        titleLogoDirty_ = false;
        if (pendingTitleLogoEpoch_ == activeMediaEpoch_) {
            presentation_.setLogo(settings.titleLogos && settings.backdrops ? pendingTitleLogoBytes_ : std::string(), toWide(pendingTitleLogoAlbum_));

        }
        if (h) InvalidateRect(h, nullptr, FALSE);
    }
    if (!mediaDirty_) return;
    mediaDirty_ = false;
    if (pendingMediaEpoch_ != activeMediaEpoch_) return;
    std::string bytes;
    std::vector<d2d::RatingBadge> ratings;
    bool clear = false, failed = false, backdropChange = false, animateBackdrop = true,
         hasTint = false;
    unsigned long long epoch = 0;
    int tint[3] = {255, 255, 255};
    {
        bytes.swap(pendingBackdropBytes_);
        ratings.swap(pendingRatings_);
        clear = pendingMediaClear_;
        backdropChange = pendingBackdropChange_;
        animateBackdrop = pendingBackdropAnimate_;
        failed = mediaImageFailed_;
        hasTint = pendingMediaHasTint_;
        epoch = pendingMediaEpoch_;
        for (int i = 0; i < 3; ++i) tint[i] = pendingMediaTint_[i];
    }
    const bool animate = transitionAnimates() && h && clientAnimationsEnabled();
    const bool backdropFade = animate && animateBackdrop;
    if (backdropChange) {
        presentation_.setArtwork(clear ? ssc::ImageReference() : std::make_shared<const std::string>(bytes), true);
        presentation_.backdropChanged(!clear);
        if (!clear) backdropLoading_ = false;
        if (clear) d2d::clearBackdrop(backdropFade);
        else d2d::setBackdrop(bytes.data(), bytes.size(), backdropFade, hasTint ? tint : nullptr);
    }
    const DWORD now = GetTickCount();
    const bool ratingsWereHidden = ratingVisibilityAlpha(now) <= 0.001f;
    const bool ratingContentFade = animate && !ratingsWereHidden;
    presentation_.setRatingContent(d2d::setRatings(ratings, ratingContentFade));
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
    if (backdropChange) {
        mediaFading_ = backdropFade;
        mediaFadePending_ = backdropFade;
    }
    ratingFadeStart_ = now;
    ratingFading_ = ratingContentFade;
    if (!mediaFading_ && !ratingFading_)
        d2d::endMediaFade();
    if (failed) logLine("backdrop image failed after web-parity retries; manual retry remains available");
    if (h) InvalidateRect(h, nullptr, FALSE);
}

void CoverEngine::onNewMedia(HWND h) { if (h == hwnd_.load()) { decodePendingMedia(h); updatePresentation(h); } }

void CoverEngine::updatePresentation(HWND h) {
    if (h != hwnd_.load()) return;
    const DWORD now = GetTickCount();
    updateRatingVisibility(now);
    backdropNavigationAlpha(now); fanartHintOpacity(now);
    ssc::platform::LockGuard lock(mutex_);
    ssc::PresentationSettings options;
    options.reducedMotion = !clientAnimationsEnabled(); options.poster = settings.layout == 1;
    options.countdown = settings.showRemaining && haveCover_; options.countdownSize = settings.remainingSize;
    options.countdownSizing = ssc::CountdownSizing::ViewportRelative;
    options.rolling = settings.rollDigits; options.next = settings.comingNext;
    options.ratings = settings.ratings; options.hideCover = settings.hideCoverWithBackdrop;
    options.effect = settings.transition; options.fadeMs = settings.fadeMs;
    options.blur = settings.posterBlur; options.radius = settings.borderRadius;
    presentation_.settingsChanged(options);
    presentation_.remainingChanged(currentRemaining());
    // Existing publishers validate media epochs under this same lock. Track
    // identity is independent of artwork retries and provider/viewport changes.
    presentation_.observeIdentity(info_.displayedIdentity());
    presentation_.ratingsChanged(ratingHasContent_, false);
    presentation_.backdropChanged(haveBackdrop_);
    presentation_.advance();
    d2d::measurePresentation(h,presentation_);
    frame_ = presentation_.advance();
    if (mediaFadePending_) { mediaFadePending_ = false; mediaFadeStart_ = now; }
    const DWORD elapsed = now - ratingFadeStart_;
    frame_.ratingContent = !ratingFading_ || options.reducedMotion ? 1.f
        : ssc::unit(float(elapsed) / (std::max)(1, settings.fadeMs));
    if (!frame_.animating) { fading_ = mediaFading_ = mediaFadePending_ = false; d2d::endFade(); }
    if (frame_.ratingContent >= 1) ratingFading_ = false;
    if (!mediaFading_ && !ratingFading_) d2d::endMediaFade();
    comingNextFrame_ = frame_.next;
}

void CoverEngine::onPaint(HWND h) {
    if (h != hwnd_.load()) return;
    const auto& frame = frame_;
    const int rem = frame.countdown.opacity > 0 ? frame.countdown.seconds : -1;
    const wchar_t* status = loading_.load() ? L"Loading cover..." : nullptr;
    d2d::setPosterBlur(settings.posterBlur); d2d::setCoverRadius(settings.borderRadius);
    { ssc::platform::LockGuard lock(mutex_);
      d2d::setBackdropLoading(backdropLoading_ && settings.hideCoverWithBackdrop); }
    d2d::setBackdropNavigationOpacity(navigationAlpha_);
    d2d::render(h, 1, transitionEffect(), rem, remainingFrac(), settings.rollDigits, status,
        settings.layout, frame.title.c_str(), frame.artist.c_str(), 1,
        settings.hideCoverWithBackdrop, frame.ratingContent, frame.ratingOpacity, frame.infoOpacity,
        frame.album.c_str(), frame.track.c_str(), 0, &frame.next, fanartHintAlpha_, &frame);
}

// The engine's repaint heartbeat: redraw only while something is actually changing -
// a crossfade, the "Loading..." badge, or the countdown over a shown cover. This is
// layout-independent: the poster's countdown is the same showRemaining case, and its
// transition is the same fading_ case, so a settled poster frame stays idle too.
void CoverEngine::onTimer(HWND h, UINT_PTR id) {
    if (id != kHeartbeat || h != hwnd_.load()) return;
    const auto previousNext = frame_.next;
    updatePresentation(h);
    updateRatingVisibility(GetTickCount());
    const bool comingNextChanged = frame_.next != previousNext;
    const float oldNavigationAlpha = navigationAlpha_;
    backdropNavigationAlpha(GetTickCount());
    const float oldFanartHintAlpha = fanartHintAlpha_;
    fanartHintOpacity(GetTickCount());
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
        ssc::MediaRequest viewport;
        viewport.includeArt = settings.station == 0 && settings.backdrops;
        if (rc.right > rc.left && rc.bottom > rc.top) {
            viewport.width = (std::min)(8192L, rc.right - rc.left);
            viewport.height = (std::min)(8192L, rc.bottom - rc.top);
        }
        const int portrait = ssc::wantsPortraitArtwork(viewport) ? 1 : 0;
        const int resolution = ssc::wants4kArtwork(viewport) ? 1 : 0;
        if (portrait != mediaPortrait_.load() || resolution != mediaResolutionClass_.load()) repaint();
    }
    bool infoAnimating;
    { ssc::platform::LockGuard lock(mutex_); infoAnimating = info_.animating(); }
    if (frame_.animating || fading_ || mediaFading_ || infoAnimating || ratingFading_ || d2d::titleLogoAnimating()
            || ratingVisibilityAnimating_ || navigationAlpha_ != oldNavigationAlpha
            || fanartHintAlpha_ != oldFanartHintAlpha || comingNextChanged || loading_.load()
            || (settings.showRemaining && haveCover_))
        InvalidateRect(h, nullptr, FALSE);
}
