// cover_engine.h - host-agnostic cover engine shared by the Winamp and foobar2000
// plugins. Owns everything that is NOT host-specific: the CoverMonitor (+ next-cover
// preload/reconcile), cover download/decode, the crossfade + rolling-countdown
// animation state, and the current settings. It draws into an HWND the host gives
// it via the shared Direct2D renderer.
//
// The host provides only: the drawing window (created however the host docks it),
// the source of track-title changes (Winamp polls IPC; foobar gets play_callback
// events) delivered via onTitleChanged(), and persistence of `settings`.
//
// The host must forward these window messages to the matching methods:
//   WM_PAINT               -> onPaint(hwnd)
//   WM_TIMER               -> onTimer(hwnd, id)   (engine owns a repaint heartbeat)
//   SSC_WM_NEWCOVER (WM_APP+1) -> onNewCover(hwnd)
//
// Countdown: the remaining time is KNOWN per track (from the poll / the preloaded
// length), so we just anchor it once and compute it locally from the clock on each
// repaint - no per-second callbacks or cross-thread tick messages.
#ifndef SSC_COVER_ENGINE_H
#define SSC_COVER_ENGINE_H

#include <windows.h>
#include <atomic>
#include <mutex>
#include <string>

#include "d2d_renderer.h" // d2d::Transition + render/setCover/...

namespace ssc { class CoverMonitor; }

// Message the host forwards to the engine (posted by the engine to its window).
#define SSC_WM_NEWCOVER (WM_APP + 1)

class CoverEngine {
public:
    // Options the host loads from / saves to its own storage (Winamp INI,
    // foobar cfg_var). The engine only reads them while drawing.
    struct Settings {
        bool showOverlay = false; // remaining-time overlay
        int  overlaySize = 2;     // 0 small, 1 medium, 2 large
        int  transition  = 1;     // 0 none, 1 crossfade, 2 flip-h, 3 flip-v
        bool rollDigits  = false; // animate the countdown (rolling)
        int  fadeMs      = 500;   // transition duration, 500..2000
        int  station     = 0;     // index into ssc::kStations (see stations.h); 0 = SST
    };
    Settings settings;

    static CoverEngine& instance();

    // --- lifecycle ---------------------------------------------------------
    // Create + start the CoverMonitor (idempotent). autoAdvance=false (default):
    // covers advance only when the host reports a track change via onTitleChanged()
    // - used by the Winamp/foobar plugins so covers track the player's actual
    // (buffered) playback. autoAdvance=true: the monitor follows the station's live
    // clock on its own - used by the standalone desktop viewer, which has no player.
    void start(bool autoAdvance = false);
    void stop();             // stop the monitor (host shutdown)
    void setWindow(HWND h);  // the D2D drawing window (nullptr when destroyed)

    // Switch to a different 24seven.fm station (index into ssc::kStations). If the
    // monitor is already running it is rebuilt against the new host and the current
    // cover state is dropped so the new station loads fresh. No-op if unchanged.
    // The viewer calls this from its station picker; the plugins call it to
    // auto-follow whichever family stream the player is tuned to.
    void setStation(int index);

    // --- host events -------------------------------------------------------
    // A track title the host observed (Winamp: polled IPC title; foobar: ICY
    // dynamic-info title). Filters out stream/status placeholders, and on a genuine
    // track change swaps to the preloaded cover instantly (else shows "Loading...")
    // then reconciles + preloads via the monitor. Safe to call repeatedly with an
    // unchanged title (no-op).
    void onTitleChanged(const std::string& title);
    void resetTitle();       // playback stopped -> next tune-in reloads
    void repaint();          // request a redraw (e.g. after a settings change)

    // The JPEG bytes of the cover currently on screen, for handing to a host's own
    // album-art system (foobar's album_art_fallback). False if nothing shown yet.
    bool currentCover(std::string& out);

    // --- window messages (forwarded by the host) ---------------------------
    void onPaint(HWND h);
    void onTimer(HWND h, UINT_PTR id);
    void onNewCover(HWND h); // SSC_WM_NEWCOVER: decode the pending cover

    // Engine-owned repaint heartbeat (~30fps); the engine sets it on the window and
    // the host just forwards WM_TIMER to onTimer. Drives the crossfade + countdown.
    static const UINT_PTR kHeartbeat = 4;

private:
    CoverEngine() = default;
    CoverEngine(const CoverEngine&) = delete;
    CoverEngine& operator=(const CoverEngine&) = delete;

    void startMonitor();     // create + start the CoverMonitor for settings.station
    void decodePending(HWND h);
    void onCoverChanged(const std::string& url); // monitor bg-thread callback body
    d2d::Transition transitionEffect() const;
    bool transitionAnimates() const { return settings.transition != 0; }
    float overlayFrac() const;

    // Countdown: anchor the remaining seconds at a known instant, then compute it
    // locally from the clock. setRemaining(-1) hides the overlay.
    void setRemaining(int secs);
    int  currentRemaining() const;

    std::mutex  mutex_;
    std::string coverBytes_;             // pending cover to decode (guarded)
    bool        dirty_ = false;
    std::string shownUrl_, nextUrl_, nextBytes_; // preload state (guarded)
    std::string shownBytes_;             // bytes of the cover currently shown (guarded)
    int         nextLen_ = -1;

    std::atomic<int>   remAnchor_{-1};   // remaining seconds at the anchor (-1 = unknown/hidden)
    std::atomic<DWORD> remAnchorAt_{0};  // GetTickCount() when the anchor was set
    std::atomic<bool>  loading_{false};

    // Render/animation state - UI thread only.
    bool  fading_ = false;
    bool  haveCover_ = false;
    DWORD fadeStart_ = 0;

    ssc::CoverMonitor* monitor_ = nullptr;
    bool autoAdvance_ = false;           // run mode remembered from start(), for setStation() rebuilds
    HWND hwnd_ = nullptr;
    std::string lastTitle_;              // last accepted real title (UI thread)
};

#endif // SSC_COVER_ENGINE_H
