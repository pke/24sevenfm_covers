// fullscreen_window.h - a dedicated, borderless, per-monitor-DPI-aware fullscreen
// window shared by the viewer and both plugins. Instead of reparenting or restyling
// the host's own window, entering fullscreen creates a fresh top-level window covering
// the monitor and points the shared CoverEngine at it (setWindow). Because the window
// is created under a per-monitor-v2 thread context, it covers the PHYSICAL monitor
// exactly even inside a system-DPI-aware host process (foobar2000) - no bitmap-stretch
// seam. The host's own window is left completely untouched.
//
// The window handles Esc / double-click / right-click itself; on dismissal it points
// the engine back at the host window, destroys itself, and runs onExit.
#ifndef SSC_FULLSCREEN_WINDOW_H
#define SSC_FULLSCREEN_WINDOW_H

#include <windows.h>
#include <functional>

#include "cover_menu.h" // covermenu::Actions for the fullscreen right-click menu

namespace ssc {

class FullscreenWindow {
public:
    bool active() const { return hwnd_ != nullptr; }
    HWND hwnd()  const { return hwnd_; }

    // Enter fullscreen on the monitor containing `anchor` (the host's cover window);
    // `menu` supplies the host's Options/Poster actions; onExit runs after teardown.
    // includeStations adds the station picker to the fullscreen right-click menu (viewer).
    void enter(HWND anchor, const covermenu::Actions& menu, std::function<void()> onExit,
               bool includeStations = false);
    void exit();
    void toggle(HWND anchor, const covermenu::Actions& menu, std::function<void()> onExit,
                bool includeStations = false);

private:
    static LRESULT CALLBACK proc(HWND, UINT, WPARAM, LPARAM);

    HWND hwnd_ = nullptr;              // the fullscreen window (null when inactive)
    HWND host_ = nullptr;             // host cover window to restore the engine to
    covermenu::Actions    menu_;      // host Options/Poster actions
    std::function<void()> onExit_;    // host callback after teardown
    bool stations_ = false;           // show the station picker in the right-click menu
};

} // namespace ssc

#endif // SSC_FULLSCREEN_WINDOW_H
