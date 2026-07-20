// window_rect.h - persisting a cover window's position and size.
//
// Winamp offers no interface for this: embedWindowState's RECT is INPUT only (Winamp
// places the frame with it and forgets it), and its extra_data[] is reserved for Winamp's
// own use. Winamp persists geometry for its own windows in winamp.ini, not for plugins.
// So a plugin that wants to reopen where the user left it has to store the rect itself.
//
// Deliberately free of Win32: it takes plain ints and a ConfigStore, so the awkward parts
// (a saved rect on a monitor that no longer exists, a window shrunk to nothing) are
// ordinary unit tests rather than something you can only find by unplugging a screen.
// The host supplies the numbers - GetWindowRect on the way out, the virtual-screen
// metrics on the way in.
#ifndef SSC_WINDOW_RECT_H
#define SSC_WINDOW_RECT_H

#include "config_store.h"

namespace ssc {

struct WindowRect {
    int x = 0, y = 0, w = 0, h = 0;
};

// Smallest window we will restore. Anything less is treated as a mis-save and grown,
// rather than handing back something too small to see or grab.
const int kMinWindowSize = 120;

// How much of the window must remain within the desktop bounds to count as reachable.
// Wide enough to grab the title bar, tall enough for that bar to be visible.
const int kMinVisibleW = 100;
const int kMinVisibleH = 30;

// True if enough of `r` lies inside the desktop bounds for the user to reach it. Pass the
// VIRTUAL screen (all monitors) - on Windows, GetSystemMetrics(SM_XVIRTUALSCREEN) and
// friends, whose origin is negative when a monitor sits left of / above the primary.
inline bool rectVisibleIn(const WindowRect& r, int boundsLeft, int boundsTop,
                          int boundsRight, int boundsBottom) {
    const int left   = r.x > boundsLeft ? r.x : boundsLeft;
    const int top    = r.y > boundsTop  ? r.y : boundsTop;
    const int right  = (r.x + r.w) < boundsRight  ? (r.x + r.w) : boundsRight;
    const int bottom = (r.y + r.h) < boundsBottom ? (r.y + r.h) : boundsBottom;
    return (right - left) >= kMinVisibleW && (bottom - top) >= kMinVisibleH;
}

inline void saveWindowRect(ssccfg::ConfigStore& store, const WindowRect& r) {
    store.writeInt("winX", r.x);
    store.writeInt("winY", r.y);
    store.writeInt("winW", r.w);
    store.writeInt("winH", r.h);
}

inline bool sameRect(const WindowRect& a, const WindowRect& b) {
    return a.x == b.x && a.y == b.y && a.w == b.w && a.h == b.h;
}

// Saves `now` only if it differs from `last` (which is then updated). Returns true if it
// wrote. Hosts poll this while running rather than saving once on shutdown: a shutdown
// hook is missed whenever the host is killed, crashes, or - as with Winamp closing to the
// tray - simply never gets around to calling it. A degenerate rect (a minimised or
// not-yet-placed window) is ignored, so it can't overwrite a good saved position.
inline bool saveWindowRectIfMoved(ssccfg::ConfigStore& store, const WindowRect& now,
                                  WindowRect& last) {
    if (now.w <= 0 || now.h <= 0) return false;
    if (sameRect(now, last)) return false;
    saveWindowRect(store, now);
    last = now;
    return true;
}

// Reads a previously saved rect into `out`. Returns false when there is nothing usable
// stored - first run, or a size that would restore an unusable window - in which case
// `out` is untouched and the caller keeps its own default. Position is never second-
// guessed here (a negative x is a perfectly normal second monitor); whether it is still
// on screen is rectVisibleIn's job, once the host knows the current desktop bounds.
inline bool loadWindowRect(ssccfg::ConfigStore& store, WindowRect& out) {
    const int w = store.readInt("winW", 0);
    const int h = store.readInt("winH", 0);
    if (w <= 0 || h <= 0) return false;   // nothing saved, or a degenerate size

    out.x = store.readInt("winX", 0);
    out.y = store.readInt("winY", 0);
    out.w = w < kMinWindowSize ? kMinWindowSize : w;
    out.h = h < kMinWindowSize ? kMinWindowSize : h;
    return true;
}

} // namespace ssc

#endif // SSC_WINDOW_RECT_H
