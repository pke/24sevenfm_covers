// cover_engine.cpp - see header. Host-agnostic; talks only to the shared Direct2D
// renderer, the CoverMonitor library, and an HWND. Ported from the Winamp plugin so
// both hosts share identical cover/preload/animation behaviour.
#include "cover_engine.h"

#include <algorithm>
#include <cctype>

#include "coverfetch.h"
#include "http_client.h"

// --- logging ----------------------------------------------------------------
namespace {
std::mutex g_logMutex;
void logLine(const std::string& msg) {
    std::lock_guard<std::mutex> lock(g_logMutex);
    OutputDebugStringA(("[24sevencover] " + msg + "\n").c_str());
    char tmp[MAX_PATH] = {0};
    GetTempPathA(MAX_PATH, tmp);
    const std::string path = std::string(tmp) + "24sevencover.log";
    HANDLE h = CreateFileA(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ, nullptr,
                           OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h != INVALID_HANDLE_VALUE) {
        const std::string line = msg + "\r\n";
        DWORD written = 0;
        WriteFile(h, line.data(), (DWORD)line.size(), &written, nullptr);
        CloseHandle(h);
    }
}

// Downloads a cover image over plain HTTP:80 (station serves images without TLS).
std::string downloadCover(const std::string& url) {
    std::string rest = url;
    const auto scheme = rest.find("://");
    if (scheme != std::string::npos)
        rest = rest.substr(scheme + 3);
    const auto slash = rest.find('/');
    const std::string host = (slash == std::string::npos) ? rest : rest.substr(0, slash);
    const std::string path = (slash == std::string::npos) ? "/" : rest.substr(slash);
    ssc::HttpResponse res = ssc::httpRequest(host, 80, path, "GET");
    if (!res.ok())
        logLine("download failed: status=" + std::to_string(res.status) + " " + res.error);
    return res.ok() ? res.body : std::string();
}
} // namespace

CoverEngine& CoverEngine::instance() {
    static CoverEngine e;
    return e;
}

float CoverEngine::overlayFrac() const {
    switch (settings.overlaySize) {
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
void CoverEngine::start() {
    if (monitor_) return;
    // Manual mode: covers advance off the host's track-title changes (onTitleChanged
    // -> refresh), not the station's live clock, so covers track what is actually
    // playing. Flaky server -> recover quickly from a failed fetch.
    ssc::Config cfg;
    cfg.errorRetrySeconds = 8;
    cfg.autoAdvance = false;
    monitor_ = new ssc::CoverMonitor([this](const std::string& url, const ssc::TrackInfo& info) {
        // Anchor the countdown from the current-playing endpoint's remaining
        // (Length - |SystemTime - PlayStart|) - known even when we join mid-track. This
        // re-syncs on every poll (each title change triggers one); between polls the
        // overlay counts down locally. A title-change swap sets an instant estimate (the
        // preloaded next length) which this poll then confirms/corrects.
        setRemaining(info.remainingSeconds);
        onCoverChanged(url);
    }, cfg);
    monitor_->setErrorCallback([this](const std::string& m) {
        logLine("monitor error: " + m);
        loading_.store(false);
        if (hwnd_) InvalidateRect(hwnd_, nullptr, FALSE);
    });
    monitor_->start();
    logLine("engine started");
}

void CoverEngine::stop() {
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

void CoverEngine::setWindow(HWND h) {
    if (hwnd_) KillTimer(hwnd_, kHeartbeat);
    hwnd_ = h;
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
            if (hwnd_) InvalidateRect(hwnd_, nullptr, FALSE);
            for (int a = 0; a < 3 && img.empty(); ++a) img = downloadCover(url);
            logLine("downloaded current " + std::to_string(img.size()) + " bytes");
        } else {
            logLine("current already preloaded, no download");
        }
        if (img.empty()) {
            loading_.store(false);
            if (hwnd_) InvalidateRect(hwnd_, nullptr, FALSE);
        } else {
            { std::lock_guard<std::mutex> lock(mutex_); coverBytes_ = img; dirty_ = true; shownUrl_ = url; shownBytes_ = img; }
            if (hwnd_) PostMessageA(hwnd_, SSC_WM_NEWCOVER, 0, 0);
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
            for (int a = 0; a < 2 && nextImg.empty(); ++a) nextImg = downloadCover(nextUrl);
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
        lower.rfind("streamingsoundtracks.com", 0) != 0;
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
            if (hwnd_) PostMessageA(hwnd_, SSC_WM_NEWCOVER, 0, 0);
        } else {
            logLine("track change: no preload ready, loading...");
            loading_.store(true);
            if (hwnd_) InvalidateRect(hwnd_, nullptr, FALSE);
        }
    }
    if (monitor_) monitor_->refresh(); // reconcile + preload following track (bg)
}

void CoverEngine::resetTitle() {
    lastTitle_.clear();       // next accepted title reloads
    setRemaining(-1);         // hide the countdown until the next track starts
}

void CoverEngine::repaint() {
    if (hwnd_) InvalidateRect(hwnd_, nullptr, FALSE);
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
    // Only show the countdown once a cover is up, so it never floats on a black
    // screen before the first cover has loaded.
    const int rem = (settings.showOverlay && haveCover_) ? currentRemaining() : -1;
    const wchar_t* status = loading_.load() ? L"Loading cover..." : nullptr;
    d2d::render(h, alpha, transitionEffect(), rem, overlayFrac(), settings.rollDigits, status);
}

// The engine's repaint heartbeat: redraw only while something is actually changing -
// a crossfade, the "Loading..." badge, or the countdown over a shown cover.
void CoverEngine::onTimer(HWND h, UINT_PTR id) {
    if (id != kHeartbeat) return;
    if (fading_ || loading_.load() || (settings.showOverlay && haveCover_))
        InvalidateRect(h, nullptr, FALSE);
}
