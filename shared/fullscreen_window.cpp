// fullscreen_window.cpp - see fullscreen_window.h.
#include "fullscreen_window.h"

#include <shobjidl.h>    // ITaskbarList2::MarkFullscreenWindow
#include <windowsx.h>     // GET_X_LPARAM / GET_Y_LPARAM

#include "cover_engine.h" // CoverEngine::instance(), SSC_WM_NEWCOVER
#include "media_policy.h" // kStageIdleMs: shared web/native fullscreen timeout

namespace ssc {

static const char* kFsClass = "SST24FullscreenWnd";

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "uuid.lib")

// A monitor-sized popup is not enough for every Windows shell configuration:
// the taskbar can remain above it until Explorer is explicitly told which window
// owns the fullscreen presentation. Keep this best-effort so older shells and
// hosts with a different COM apartment still use the normal topmost fallback.
static void markShellFullscreen(HWND hwnd, BOOL fullscreen) {
    const HRESULT apartment = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    ITaskbarList2* taskbar = nullptr;
    if (SUCCEEDED(CoCreateInstance(CLSID_TaskbarList, nullptr, CLSCTX_INPROC_SERVER,
                                   IID_PPV_ARGS(&taskbar)))) {
        if (SUCCEEDED(taskbar->HrInit()))
            taskbar->MarkFullscreenWindow(hwnd, fullscreen);
        taskbar->Release();
    }
    if (SUCCEEDED(apartment)) CoUninitialize();
}

// The module (viewer exe, or a plugin DLL) that owns this code - the right HINSTANCE
// for RegisterClass / CreateWindow whether we're standalone or loaded into a host.
static HINSTANCE moduleInstance() {
    HINSTANCE h = nullptr;
    GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       (LPCSTR)&kFsClass, &h);
    return h;
}

void FullscreenWindow::wakeCursor(HWND hwnd) {
    if (!hwnd || hwnd != hwnd_) return;
    cursorHidden_ = false;
    SetCursor(LoadCursor(nullptr, IDC_ARROW));
    KillTimer(hwnd, kCursorIdleTimer);
    if (!cursorAutoHideSuspended_)
        SetTimer(hwnd, kCursorIdleTimer, ssc::kStageIdleMs, nullptr);
}

void FullscreenWindow::hideCursor(HWND hwnd) {
    if (!hwnd || hwnd != hwnd_ || cursorAutoHideSuspended_) return;
    KillTimer(hwnd, kCursorIdleTimer);

    // CSS cursor:none only applies while the pointer is over the web stage. Match
    // that on multi-monitor Windows desktops and do not hide a pointer currently
    // owned by another window (for example a system overlay).
    POINT point = {};
    if (!GetCursorPos(&point) || WindowFromPoint(point) != hwnd) return;
    cursorHidden_ = true;
    SetCursor(nullptr);
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
            if (self && wp == kCursorIdleTimer) {
                self->hideCursor(hwnd);
                return 0;
            }
            CoverEngine::instance().onTimer(hwnd, wp);
            return 0;
        case SSC_WM_NEWCOVER:
            CoverEngine::instance().onNewCover(hwnd);
            return 0;
        case SSC_WM_NEWMEDIA:
            CoverEngine::instance().onNewMedia(hwnd);
            return 0;
        case WM_ERASEBKGND:
            return 1; // D2D clears + paints the whole client (class brush is black anyway)
        case WM_ACTIVATE:
            if (self && LOWORD(wp) != WA_INACTIVE) {
                // Explorer applies MarkFullscreenWindow to the active presentation.
                // Reassert after activation: marking before SetForegroundWindow left
                // the primary taskbar in front while secondary taskbars happened to
                // be covered by the topmost monitor-sized popup.
                markShellFullscreen(hwnd, TRUE);
                SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
            break;
        case WM_LBUTTONDOWN:
            if (self && CoverEngine::instance().onAlbumClick(hwnd, GET_X_LPARAM(lp), GET_Y_LPARAM(lp))
                    && self->menu_.persist) self->menu_.persist();
            return 0;
        case WM_LBUTTONDBLCLK:
            if (CoverEngine::instance().albumToggleHitTest(
                    hwnd, GET_X_LPARAM(lp), GET_Y_LPARAM(lp))) return 0;
            if (self) self->exit();
            return 0;
        case WM_KEYDOWN:
            if (wp == VK_ESCAPE && self) { self->exit(); return 0; }
            if (wp == 'N') { CoverEngine::instance().demoNext(); return 0; } // demo mode: next cover
            break;
        case WM_MOUSEMOVE:
            if (self) self->wakeCursor(hwnd);
            CoverEngine::instance().onPointerMove(hwnd, /*fullscreenAutoHide=*/true);
            return 0;
        case WM_MOUSELEAVE:
            CoverEngine::instance().onPointerLeave(hwnd);
            return 0;
        case WM_CONTEXTMENU: {
            if (!self) break;
            self->cursorAutoHideSuspended_ = true;
            self->wakeCursor(hwnd);
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
            if (self->hwnd_ == hwnd) {
                self->cursorAutoHideSuspended_ = false;
                self->wakeCursor(hwnd);
            }
            return 0;
        }
        case WM_SETCURSOR:
            if (self && LOWORD(lp) == HTCLIENT) {
                const LPCTSTR cursor = CoverEngine::instance().albumToggleAtCursor(hwnd)
                    ? IDC_HAND : IDC_ARROW;
                SetCursor(self->cursorHidden_ ? nullptr : LoadCursor(nullptr, cursor));
                return TRUE;
            }
            break; // let DefWindowProc handle menu/non-client cursors; never fall into WM_CLOSE
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
    hwnd_ = CreateWindowExA(WS_EX_TOPMOST | WS_EX_TOOLWINDOW, kFsClass, "", WS_POPUP,
                            mi.rcMonitor.left, mi.rcMonitor.top,
                            mi.rcMonitor.right - mi.rcMonitor.left,
                            mi.rcMonitor.bottom - mi.rcMonitor.top,
                            nullptr, nullptr, moduleInstance(), nullptr);

    if (setCtx && prevCtx) setCtx(prevCtx); // restore the thread's original awareness

    if (!hwnd_) { host_ = nullptr; onExit_ = nullptr; return; }

    SetWindowLongPtrA(hwnd_, GWLP_USERDATA, (LONG_PTR)this);
    CoverEngine::instance().setWindow(hwnd_); // engine now renders into the fullscreen window
    ShowWindow(hwnd_, SW_SHOW);
    // Re-assert both the physical monitor bounds and the topmost band after the
    // window becomes visible. Explorer evaluates fullscreen windows at this point;
    // relying only on CreateWindowEx leaves the taskbar above the popup on some
    // Windows 11 taskbar configurations.
    SetWindowPos(hwnd_, HWND_TOPMOST,
                 mi.rcMonitor.left, mi.rcMonitor.top,
                 mi.rcMonitor.right - mi.rcMonitor.left,
                 mi.rcMonitor.bottom - mi.rcMonitor.top,
                 SWP_FRAMECHANGED | SWP_SHOWWINDOW);
    SetForegroundWindow(hwnd_);
    BringWindowToTop(hwnd_);
    SetFocus(hwnd_); // so Esc reaches proc
    // The shell contract is activation-sensitive on the primary monitor. Notify
    // Explorer only after the popup owns foreground/focus, then restore topmost.
    markShellFullscreen(hwnd_, TRUE);
    SetWindowPos(hwnd_, HWND_TOPMOST, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    cursorAutoHideSuspended_ = false;
    wakeCursor(hwnd_); // web parity: visible on entry, idle after two seconds
}

void FullscreenWindow::exit() {
    if (!hwnd_) return;
    HWND w = hwnd_; hwnd_ = nullptr;                      // null first: re-entrancy safe
    KillTimer(w, kCursorIdleTimer);
    cursorHidden_ = false;
    cursorAutoHideSuspended_ = false;
    SetCursor(LoadCursor(nullptr, IDC_ARROW));
    CoverEngine::instance().setWindow(host_);             // engine back to the host window
    markShellFullscreen(w, FALSE);
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
