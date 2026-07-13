// fullscreen.h - shared borderless-fullscreen toggle for a host window, so the viewer
// and both plugins don't each reimplement it. It handles the two window shapes we have:
//
//   * a TOP-LEVEL window (the viewer, or a plugin's standalone-fallback window): drop
//     WS_OVERLAPPEDWINDOW in place and size to the monitor; restore its placement.
//   * a docked CHILD window (Winamp's gen_ff child, a foobar layout element): reparent
//     it out to a borderless top-level popup covering the monitor, and reparent it back
//     on exit. The host owns the child's geometry inside its frame/layout, so it must
//     re-place the child after exit (nudge its frame, or restore the saved rect) - use
//     parent() to reach the container. This class does NOT reposition the child on exit.
//
// enter() auto-detects which shape the window is (WS_CHILD) - the caller just toggles.
#ifndef SSC_FULLSCREEN_H
#define SSC_FULLSCREEN_H

#include <windows.h>

namespace ssc {

struct Fullscreen {
    bool active = false;

    bool toggle(HWND h) { active ? exit(h) : enter(h); return active; }

    void enter(HWND h) {
        if (active || !h) return;
        style_      = GetWindowLongPtrA(h, GWL_STYLE);
        exStyle_    = GetWindowLongPtrA(h, GWL_EXSTYLE);
        reparented_ = (style_ & WS_CHILD) != 0;
        MONITORINFO mi = { sizeof(mi) };
        GetMonitorInfoA(MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST), &mi);
        if (reparented_) {                                  // docked child -> top-level popup
            parent_ = GetParent(h);
            SetParent(h, nullptr);
            SetWindowLongPtrA(h, GWL_STYLE, (style_ & ~(LONG_PTR)WS_CHILD) | WS_POPUP);
        } else {                                            // already top-level -> drop the frame
            place_.length = sizeof(place_);
            GetWindowPlacement(h, &place_);
            SetWindowLongPtrA(h, GWL_STYLE, style_ & ~(LONG_PTR)WS_OVERLAPPEDWINDOW);
        }
        SetWindowPos(h, HWND_TOPMOST, mi.rcMonitor.left, mi.rcMonitor.top,
                     mi.rcMonitor.right - mi.rcMonitor.left,
                     mi.rcMonitor.bottom - mi.rcMonitor.top,
                     SWP_FRAMECHANGED | SWP_SHOWWINDOW);
        SetForegroundWindow(h);
        SetFocus(h);                                        // so Esc reaches the host WndProc
        active = true;
    }

    void exit(HWND h) {
        if (!active || !h) return;
        SetWindowLongPtrA(h, GWL_STYLE, style_);
        SetWindowLongPtrA(h, GWL_EXSTYLE, exStyle_);
        if (reparented_) {
            SetParent(h, parent_);                          // back into the host frame/layout
            SetWindowPos(h, HWND_NOTOPMOST, 0, 0, 0, 0,
                         SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED);
        } else {
            SetWindowPos(h, HWND_NOTOPMOST, 0, 0, 0, 0,
                         SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED);
            SetWindowPlacement(h, &place_);                 // restore the windowed rect
        }
        active = false;
    }

    HWND parent() const { return parent_; } // the saved container (child case), for host re-layout

private:
    LONG_PTR        style_ = 0, exStyle_ = 0;
    WINDOWPLACEMENT place_ = {};
    HWND            parent_ = nullptr;
    bool            reparented_ = false;
};

} // namespace ssc

#endif // SSC_FULLSCREEN_H
