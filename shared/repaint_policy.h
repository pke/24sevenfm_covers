// repaint_policy.h - when the engine repaints and how fast its heartbeat ticks.
// Pure logic, Win32-free (like window_rect.h), so it is unit-tested.
//
// The heartbeat used to tick at a fixed ~30 fps and invalidate the window on every
// tick while the countdown was visible, re-rendering an unchanged frame ~29 times a
// second (the value changes once a second; its digit roll lasts 350 ms). Now:
//   animation (33 ms)  - a fade, roll, entrance or slide is running
//   watch (<= 250 ms)  - settled: the tick only re-evaluates deadlines (pointer
//                        auto-hide, rating intro, cover retry, viewport class) and
//                        wakes just after the countdown's next second boundary
// and a repaint happens only while something on screen actually changes.
#ifndef SSC_REPAINT_POLICY_H
#define SSC_REPAINT_POLICY_H

#include <cstdint>

namespace ssc {

const unsigned kHeartbeatAnimationMs = 33;
const unsigned kHeartbeatWatchMs = 250;
const unsigned kHeartbeatMinimumMs = 10;

struct HeartbeatState {
    bool animating = false;     // any visual transition is in progress
    int shownSeconds = -1;      // countdown value the current frame shows (-1 = hidden)
    int paintedSeconds = -1;    // countdown value the last paint put on screen
    unsigned msToNextSecond = 0; // 0 = no running countdown
};

inline bool needsRepaint(const HeartbeatState& s) {
    return s.animating || s.shownSeconds != s.paintedSeconds;
}

inline unsigned heartbeatIntervalMs(const HeartbeatState& s) {
    if (s.animating) return kHeartbeatAnimationMs;
    unsigned ms = kHeartbeatWatchMs;
    if (s.msToNextSecond) {
        const unsigned boundary = s.msToNextSecond + 2; // land just after the change
        if (boundary < ms) ms = boundary < kHeartbeatMinimumMs ? kHeartbeatMinimumMs : boundary;
    }
    return ms;
}

// The countdown decrements every whole second after its anchor (GetTickCount based,
// wrap-safe through unsigned arithmetic).
inline unsigned msUntilNextSecond(std::uint32_t now, std::uint32_t anchoredAt) {
    return 1000u - (now - anchoredAt) % 1000u;
}

} // namespace ssc

#endif // SSC_REPAINT_POLICY_H
