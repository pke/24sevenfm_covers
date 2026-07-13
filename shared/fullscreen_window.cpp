// fullscreen_window.cpp - see fullscreen_window.h.
#include "fullscreen_window.h"

#include <windowsx.h>     // GET_X_LPARAM / GET_Y_LPARAM

#include "cover_engine.h" // CoverEngine::instance(), SSC_WM_NEWCOVER

namespace ssc {

static const char* kFsClass = "SST24FullscreenWnd";

// The module (viewer exe, or a plugin DLL) that owns this code - the right HINSTANCE
// for RegisterClass / CreateWindow whether we're standalone or loaded into a host.
static HINSTANCE moduleInstance() {
    HINSTANCE h = nullptr;
    GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       (LPCSTR)&kFsClass, &h);
    return h;
}

LRESULT CALLBACK FullscreenWindow::proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    FullscreenWindow* self = (FullscreenWindow*)GetWindowLongPtrA(hwnd, GWLP_USERDATA);
    switch (msg) {
        case WM_PAINT: {
            PAINTSTRUCT ps; BeginPaint(hwnd, &ps);
            CoverEngine::instance().onPaint(hwnd); // D2D presents itself
            EndPaint(hwnd, &ps);
            return 0;
        }
        case WM_TIMER:
            CoverEngine::instance().onTimer(hwnd, wp);
            return 0;
        case SSC_WM_NEWCOVER:
            CoverEngine::instance().onNewCover(hwnd);
            return 0;
        case WM_ERASEBKGND:
            return 1; // D2D clears + paints the whole client (class brush is black anyway)
        case WM_LBUTTONDBLCLK:
            if (self) self->exit();
            return 0;
        case WM_KEYDOWN:
            if (wp == VK_ESCAPE && self) { self->exit(); return 0; }
            if (wp == 'N') { CoverEngine::instance().demoNext(); return 0; } // demo mode: next cover
            break;
        case WM_CONTEXTMENU: {
            if (!self) break;
            POINT pt = { GET_X_LPARAM(lp), GET_Y_LPARAM(lp) };
            if (pt.x == -1 && pt.y == -1) { // keyboard-invoked: client centre
                RECT rc; GetClientRect(hwnd, &rc);
                pt.x = rc.right / 2; pt.y = rc.bottom / 2;
                ClientToScreen(hwnd, &pt);
            }
            covermenu::Actions act = self->menu_;   // host Options/Poster (+ persist for stations)
            act.toggleFullscreen = [self] { self->exit(); }; // Fullscreen item -> leave fullscreen
            covermenu::showPopup(hwnd, pt, CoverEngine::instance(), act,
                                 /*includeFullscreen*/ true, /*fullscreenOn*/ true,
                                 /*includeStations*/ self->stations_);
            return 0;
        }
        case WM_CLOSE:
            if (self) self->exit();
            return 0;
    }
    return DefWindowProcA(hwnd, msg, wp, lp);
}

void FullscreenWindow::enter(HWND anchor, const covermenu::Actions& menu, std::function<void()> onExit,
                             bool includeStations) {
    if (hwnd_ || !anchor) return;
    stations_ = includeStations;

    static bool registered = false;
    if (!registered) {
        WNDCLASSA wc = {};
        wc.style         = CS_DBLCLKS;                             // deliver double-clicks
        wc.lpfnWndProc   = proc;
        wc.hInstance     = moduleInstance();
        wc.lpszClassName = kFsClass;
        wc.hCursor       = LoadCursor(nullptr, IDC_ARROW);
        wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);    // black backdrop
        RegisterClassA(&wc);
        registered = true;
    }

    host_ = anchor; menu_ = menu; onExit_ = std::move(onExit);

    // Create under a per-monitor-v2 thread context so the window covers the PHYSICAL
    // monitor exactly, even inside a system-DPI-aware host (foobar). Loaded dynamically:
    // no-op on Windows before 10 1607, which have no mixed-DPI virtualization anyway.
    typedef HANDLE (WINAPI *SetCtx_t)(HANDLE);
    SetCtx_t setCtx = nullptr; HANDLE prevCtx = nullptr;
    if (HMODULE u = GetModuleHandleA("user32.dll"))
        setCtx = (SetCtx_t)GetProcAddress(u, "SetThreadDpiAwarenessContext");
    if (setCtx) prevCtx = setCtx((HANDLE)(INT_PTR)-4); // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2

    MONITORINFO mi = { sizeof(mi) };
    GetMonitorInfoA(MonitorFromWindow(anchor, MONITOR_DEFAULTTONEAREST), &mi);
    hwnd_ = CreateWindowExA(WS_EX_TOPMOST, kFsClass, "", WS_POPUP,
                            mi.rcMonitor.left, mi.rcMonitor.top,
                            mi.rcMonitor.right - mi.rcMonitor.left,
                            mi.rcMonitor.bottom - mi.rcMonitor.top,
                            nullptr, nullptr, moduleInstance(), nullptr);

    if (setCtx && prevCtx) setCtx(prevCtx); // restore the thread's original awareness

    if (!hwnd_) { host_ = nullptr; onExit_ = nullptr; return; }

    SetWindowLongPtrA(hwnd_, GWLP_USERDATA, (LONG_PTR)this);
    CoverEngine::instance().setWindow(hwnd_); // engine now renders into the fullscreen window
    ShowWindow(hwnd_, SW_SHOW);
    SetForegroundWindow(hwnd_);
    SetFocus(hwnd_); // so Esc reaches proc
}

void FullscreenWindow::exit() {
    if (!hwnd_) return;
    HWND w = hwnd_; hwnd_ = nullptr;                      // null first: re-entrancy safe
    CoverEngine::instance().setWindow(host_);             // engine back to the host window
    SetWindowLongPtrA(w, GWLP_USERDATA, 0);
    DestroyWindow(w);
    std::function<void()> cb = onExit_;
    onExit_ = nullptr; host_ = nullptr; menu_ = covermenu::Actions{};
    if (cb) cb();
}

void FullscreenWindow::toggle(HWND anchor, const covermenu::Actions& menu, std::function<void()> onExit,
                              bool includeStations) {
    if (hwnd_) exit();
    else       enter(anchor, menu, std::move(onExit), includeStations);
}

} // namespace ssc
