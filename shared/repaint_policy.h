// repaint_policy.h - decides WHEN the engine repaints and how fast its heartbeat
// timer ticks. Pure logic, Win32-free (like window_rect.h) so it is unit-tested.
//
// Background: the old heartbeat ran at a fixed ~30fps and invalidated the window
// whenever the countdown was visible - re-rendering an unchanged frame ~28 times
// a second (the value changes once a second, the digit roll lasts 350 ms). The
// policy repaints only while something on screen actually changes, and slows the
// timer down to match:
//   fast (33 ms)      - an animation is running (crossfade or digit roll)
//   watch (100 ms)    - something may change soon: the countdown's next second,
//                       the loading state, a timed demo frame's auto-advance
//   idle (500 ms)     - a settled frame; the tick only re-evaluates this policy
#ifndef SSC_REPAINT_POLICY_H
#define SSC_REPAINT_POLICY_H

namespace ssc {

const int kHeartbeatFastMs      = 33;   // animation frame rate (~30fps)
const int kHeartbeatCountdownMs = 100;  // watch rate: catch a 1 Hz change promptly
const int kHeartbeatIdleMs      = 500;  // settled: cheap policy re-check only

// What is live on screen right now. Built by the engine from its own state.
struct RenderActivity {
    bool fading;               // crossfade/flip transition in progress
    bool loading;              // "Loading cover..." badge is up
    bool overlayRolling;       // last render reported the digit roll still animating
    bool countdownVisible;     // the remaining-time overlay is shown at all
    bool demoTimed;            // demo mode frame with seconds > 0 (auto-advance pending)
    int  remaining;            // current countdown value (seconds; -1 = hidden)
    int  lastPaintedRemaining; // the value the last paint actually drew
};

// A repaint is needed only while something changes: an animation frame, the
// loading badge (cleared/updated by background events), or a countdown value
// that differs from what is on screen.
inline bool needsRepaint(const RenderActivity& a) {
    if (a.fading || a.loading || a.overlayRolling) return true;
    return a.countdownVisible && a.remaining != a.lastPaintedRemaining;
}

// The heartbeat interval that fits the current activity (see table above).
inline int heartbeatIntervalMs(const RenderActivity& a) {
    if (a.fading || a.overlayRolling) return kHeartbeatFastMs;
    if (a.loading || a.countdownVisible || a.demoTimed) return kHeartbeatCountdownMs;
    return kHeartbeatIdleMs;
}

} // namespace ssc

#endif // SSC_REPAINT_POLICY_H
