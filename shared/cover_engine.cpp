// cover_engine.cpp - see header. Host-agnostic; talks only to the shared Direct2D
// renderer, the CoverMonitor library, and an HWND. Ported from the Winamp plugin so
// both hosts share identical cover/preload/animation behaviour.
#include "cover_engine.h"

#include <algorithm>
#include <cctype>

#include "coverfetch.h"
#include "http_client.h"
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
    return res.ok() ? res.body : std::string();
}
} // namespace

CoverEngine& CoverEngine::instance() {
    static CoverEngine e;
    return e;
}

float CoverEngine::remainingFrac() const {
    switch (settings.remainingSize) {
        case 0:  return 1.0f / 22.0f; // small
        case 1:  return 1.0f / 16.0f; // medium
        default: return 1.0f / 12.0f; // large
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

void CoverEngine::start(bool autoAdvance) {
    std::lock_guard<std::mutex> life(monitorLifecycle_);
    if (monitor_) return;
    // Plugins (autoAdvance=false): covers advance off the host's track-title changes
    // (onTitleChanged -> refresh), not the station's live clock, so covers track what
    // is actually playing. Desktop viewer (autoAdvance=true): no player, so the monitor
    // follows the station's live clock on its own.
    autoAdvance_ = autoAdvance;
    startMonitor();
    logLine("engine started");
}

// Creates the CoverMonitor for the currently-selected station. Split out of start()
// so setStation() can rebuild it against a new host. Flaky server -> recover quickly.
void CoverEngine::startMonitor() {
    const ssc::StationInfo& st = ssc::station(settings.station);
    ssc::Config cfg;
    cfg.errorRetrySeconds = 8;
    cfg.autoAdvance = autoAdvance_;
    cfg.host = st.host; // JSON + cover host; CoverLink is then pinned to this host
    monitor_ = new ssc::CoverMonitor([this](const std::string& url, const ssc::TrackInfo& info) {
        // Anchor the countdown from the current-playing endpoint's remaining
        // (Length - |SystemTime - PlayStart|) - known even when we join mid-track. This
        // re-syncs on every poll (each title change triggers one); between polls the
        // overlay counts down locally. A title-change swap sets an instant estimate (the
        // preloaded next length) which this poll then confirms/corrects.
        setRemaining(info.remainingSeconds);
        // Capture track metadata for the poster info box (title + composer + runtime),
        // formatted like the station's own title: "Album - Track (M:SS)".
        std::string t = info.album;
        if (!info.album.empty() && !info.track.empty()) t = info.album + " - " + info.track;
        else if (!info.track.empty())                   t = info.track;
        if (!t.empty() && info.lengthSeconds > 0) {
            const int mm = info.lengthSeconds / 60, ss = info.lengthSeconds % 60;
            t += " (" + std::to_string(mm) + ":" + (ss < 10 ? "0" : "") + std::to_string(ss) + ")";
        }
        {
            std::lock_guard<std::mutex> lock(mutex_);
            infoTitle_  = toWide(t); // album/track/artist arrive HTML-decoded from the lib
            infoArtist_ = toWide(info.artist);
        }
        onCoverChanged(url);
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
    resetTitle();          // next accepted title reloads; hide the countdown
    loading_.store(true);  // show "Loading..." until the new station replies
    invalidate();
    startMonitor();
    if (monitor_) monitor_->refresh(); // fetch the new station's current cover now
}

void CoverEngine::stop() {
    std::lock_guard<std::mutex> life(monitorLifecycle_);
    if (monitor_) { monitor_->stop(); delete monitor_; monitor_ = nullptr; }
    logLine("engine stopped");
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
    SetTimer(h, kHeartbeat, 33, nullptr); // ~30fps repaint heartbeat (fade + countdown)
    d2d::resetTarget(); // rebuild the render target for the (possibly new) window
    // Show whatever we have: if a cover is pending, decode it now; otherwise ask the
    // monitor to (re)fetch the current one for this freshly-created window.
    bool havePending;
    { std::lock_guard<std::mutex> lock(mutex_); havePending = !coverBytes_.empty(); if (havePending) dirty_ = true; }
    if (havePending) PostMessageA(h, SSC_WM_NEWCOVER, 0, 0);
    else if (monitor_) monitor_->refresh();
    InvalidateRect(h, nullptr, FALSE);
}

// --- monitor callback (background thread) -----------------------------------
void CoverEngine::onCoverChanged(const std::string& url) {
    logLine("poll: current cover = " + url);

    // stop()/setStation() run on the host UI thread and join this (monitor) thread.
    // If we are mid-retry when that happens, abandon the remaining downloads so the
    // join returns promptly instead of grinding through every attempt's timeout.
    const auto aborting = [this] { return monitor_ && monitor_->cancelled(); };
    const std::atomic<bool>* cancelTok = monitor_ ? monitor_->cancelToken() : nullptr;

    // (1) Reconcile: only (re)show if `url` isn't already displayed.
    bool alreadyShown;
    std::string img;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        alreadyShown = (url == shownUrl_);
        if (url == nextUrl_ && !nextBytes_.empty()) img = nextBytes_;
    }
    if (!alreadyShown) {
        if (img.empty()) {
            loading_.store(true);
            invalidate();
            for (int a = 0; a < 3 && img.empty() && !aborting(); ++a) img = downloadCover(url, cancelTok);
            logLine("downloaded current " + std::to_string(img.size()) + " bytes");
        } else {
            logLine("current already preloaded, no download");
        }
        if (img.empty()) {
            loading_.store(false);
            invalidate();
        } else {
            { std::lock_guard<std::mutex> lock(mutex_); coverBytes_ = img; dirty_ = true; shownUrl_ = url; shownBytes_ = img; }
            notifyNewCover();
        }
    }

    // (2) Preload the next track's cover (+ length, to prime the countdown).
    std::string nextUrl;
    int nextLen = 0;
    if (monitor_ && monitor_->nextCoverUrl(nextUrl, &nextLen) && !nextUrl.empty()) {
        bool haveIt;
        { std::lock_guard<std::mutex> lock(mutex_); haveIt = (nextUrl == nextUrl_ && !nextBytes_.empty()); }
        if (!haveIt) {
            std::string nextImg;
            for (int a = 0; a < 2 && nextImg.empty() && !aborting(); ++a) nextImg = downloadCover(nextUrl, cancelTok);
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

void CoverEngine::repaint() {
    invalidate();
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

    const bool fade = transitionAnimates() && haveCover_ && h;
    d2d::setCover(bytes.data(), bytes.size(), fade);
    if (fade) { fadeStart_ = GetTickCount(); fading_ = true; } // heartbeat drives the fade
    haveCover_ = true;
    loading_.store(false);
    logLine("cover decoded + shown (" + std::to_string(bytes.size()) + " bytes)");
    if (h) InvalidateRect(h, nullptr, FALSE);
}

void CoverEngine::onNewCover(HWND h) { decodePending(h); }

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
    const bool poster = settings.layout == 1;
    // The remaining-time overlay is one feature (size + rolling settings) shown in both
    // layouts - as a top-right badge in fill, in the info box in poster - gated by the
    // same "Show remaining time overlay" option. The renderer formats + rolls it.
    const int rem = (settings.showRemaining && haveCover_) ? currentRemaining() : -1;
    const wchar_t* status = loading_.load() ? L"Loading cover..." : nullptr; // no "Playing" label
    std::wstring title, artist;
    if (poster) { std::lock_guard<std::mutex> lock(mutex_); title = infoTitle_; artist = infoArtist_; }
    d2d::setPosterBlur(settings.posterBlur);
    d2d::render(h, alpha, transitionEffect(), rem, remainingFrac(), settings.rollDigits, status,
                settings.layout, title.c_str(), artist.c_str());
}

// The engine's repaint heartbeat: redraw only while something is actually changing -
// a crossfade, the "Loading..." badge, or the countdown over a shown cover. This is
// layout-independent: the poster's countdown is the same showRemaining case, and its
// transition is the same fading_ case, so a settled poster frame stays idle too.
void CoverEngine::onTimer(HWND h, UINT_PTR id) {
    if (id != kHeartbeat) return;
    if (fading_ || loading_.load() || (settings.showRemaining && haveCover_))
        InvalidateRect(h, nullptr, FALSE);
}
