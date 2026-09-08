// gen_24sevenfm_covers.cpp - Winamp 5.x general-purpose plugin that shows the cover
// art of the track currently playing on Streaming Soundtracks (24seven.fm) in a
// dockable Winamp window.
//
// Why a gen_ plugin (not vis_): Winamp calls general-purpose plugins' init() on
// its OWN UI thread. That means the gen_ff embed frame we create with
// IPC_GET_EMBEDIF / embedWindow() lives on Winamp's UI thread, so Winamp's
// window manager wires up its dragging + magnetic docking - exactly what a vis_
// plugin (called on a separate thread) could never get.
//
// This file is now just the WINAMP host glue: the dockable window, IPC title
// polling, INI settings, and the options dialog. All cover/preload/animation logic
// lives in the shared, host-agnostic CoverEngine (../shared/cover_engine.*), which
// the foobar2000 component drives too.
//
// IMPORTANT: build as a 32-bit DLL - Winamp 5.x is a 32-bit application.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <windowsx.h>   // GET_X_LPARAM / GET_Y_LPARAM (context-menu coords)
#include <commctrl.h>   // trackbar (duration slider), tab control
#include <shellapi.h>   // ShellExecute (About link)
#pragma comment(lib, "shell32.lib")

#include <algorithm>
#include <cctype>
#include <mutex>
#include <string>

#include "gen.h"
#include "gen_resource.h"
#include "d2d_renderer.h"   // d2d::init/shutdown (rendering itself lives in the engine)
#include "cover_engine.h"   // shared cover/preload/animation engine
#include "cover_menu.h"        // shared right-click context menu (Poster / Options)
#include "fullscreen_window.h" // shared dedicated per-monitor fullscreen window
#include "options_panel.h"  // shared options page (dialog + control logic)
#include "child_fade.h"
#include "stations.h"       // 24seven.fm station table + stream-URL detection
#include "config.h"         // shared option schema + INI adapter
#include "window_rect.h"    // save/restore the frame's position (Winamp won't do it)

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "comctl32.lib")

// --- Winamp IPC (subset of wa_ipc.h) ---------------------------------------
#define WM_WA_IPC WM_USER
#define IPC_ISPLAYING        104
#define IPC_GETLISTPOS       125
#define IPC_GETPLAYLISTFILE  211
#define IPC_GETPLAYLISTTITLE 212
#define IPC_GET_EMBEDIF      505
#define IPC_GETINIDIRECTORY  335   // returns Winamp's settings directory (char*)

typedef struct embedWindowState {
    HWND me;
    int  flags;
    RECT r;
    void* user_ptr;
    int  extra_data[64];
} embedWindowState;
typedef HWND (*embedWindowFn)(embedWindowState*);
#define EMBED_FLAGS_NORESIZE 0x1

static const char* kWndClass = "SST24CoverGenWnd";
static const UINT_PTR kGateTimer = 1; // gating + title poll (engine owns timers 2/3)

static HINSTANCE          g_hInst = nullptr;
static HWND               g_winamp = nullptr;
static HWND               g_hwnd = nullptr;       // our drawing child window
static HWND               g_embedFrame = nullptr; // gen_ff dockable frame
static embedWindowState   g_embedState;
static bool               g_d2dReady = false;
static bool               g_userClosed = false;    // user dismissed the frame; don't auto-reopen until re-tune
static bool               g_active = false;        // engine + GPU resources live only while the window is shown

static CoverEngine& eng() { return CoverEngine::instance(); }

// --- settings (Winamp INI <-> engine.settings) ------------------------------
static std::string iniPath() {
    const char* dir = g_winamp ? (const char*)SendMessageA(g_winamp, WM_WA_IPC, 0, IPC_GETINIDIRECTORY) : nullptr;
    char tmp[MAX_PATH] = {0};
    if (!dir || !*dir) { GetTempPathA(MAX_PATH, tmp); dir = tmp; }
    std::string p = dir;
    if (!p.empty() && p.back() != '\\' && p.back() != '/') p += '\\';
    return p + "24seven.fm-covers.ini";
}
static void loadSettings() {
    ssccfg::IniConfigStore store(iniPath());
    ssccfg::load(eng().settings, store);
}
static void saveSettings() {
    ssccfg::IniConfigStore store(iniPath());
    ssccfg::save(eng().settings, store);
}

// --- window geometry (see shared/window_rect.h) -----------------------------
// Winamp does not persist a plugin window's position, so we do. The decisions live in
// shared/window_rect.h (unit-tested); this is only the Win32 that feeds them.
static const ssc::WindowRect kDefaultRect = { 200, 200, 500, 500 };

// Where the frame is now. Works while it is hidden (the user closed it) - a hidden
// window keeps its last position, which is exactly what should be restored next time.
static bool currentFrameRect(ssc::WindowRect& out) {
    if (!g_embedFrame || !IsWindow(g_embedFrame)) return false;
    RECT rc;
    if (!GetWindowRect(g_embedFrame, &rc)) return false;
    out.x = rc.left; out.y = rc.top;
    out.w = rc.right - rc.left; out.h = rc.bottom - rc.top;
    return out.w > 0 && out.h > 0;
}

// Last geometry written, so the poll below only touches the INI when it actually moved.
static ssc::WindowRect g_savedRect;

// Persist the position if it changed. Called from the gate timer (~1s) rather than only
// from quit(): Winamp is commonly set to minimise to the tray on close, so quit() may not
// run for hours - and never at all if Winamp is killed or crashes. Polling costs one
// GetWindowRect per tick and writes only on an actual move/resize.
static void saveWindowPosIfMoved() {
    ssc::WindowRect r;
    if (!currentFrameRect(r)) return;
    if (!ssc::sameRect(r, g_savedRect)) {
        ssccfg::IniConfigStore store(iniPath());
        ssc::saveWindowRectIfMoved(store, r, g_savedRect);
    }
}

// The saved rect, or the default when nothing is stored or it would land off-screen -
// a monitor unplugged since last run must not strand the window where it can't be
// reached. SM_?VIRTUALSCREEN covers all monitors, and its origin is negative when one
// sits left of / above the primary.
static ssc::WindowRect startupRect() {
    ssccfg::IniConfigStore store(iniPath());
    ssc::WindowRect r;
    if (!ssc::loadWindowRect(store, r)) return kDefaultRect;
    const int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
    const int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if (!ssc::rectVisibleIn(r, vx, vy, vx + vw, vy + vh)) return kDefaultRect;
    return r;
}

// Plugin entry points (defined below) and the descriptor Winamp fills in.
static int  init();
static void config();
static void quit();
static INT_PTR CALLBACK PrefsPageProc(HWND, UINT, WPARAM, LPARAM);
static INT_PTR CALLBACK OptionsScrollHostProc(HWND, UINT, WPARAM, LPARAM);
static void showOwnOptions(HWND owner);
static prefsDlgRec g_prefsRec = {}; // our node in Winamp's Preferences treeview (persistent)

static winampGeneralPurposePlugin g_plugin = {
    GPPHDR_VER,
    (char*)"24seven.fm Covers (dockable cover art)",
    init,
    config,
    quit,
    nullptr, // hwndParent   (filled by Winamp)
    nullptr, // hDllInstance (filled by Winamp)
};

// --- tuned-to-station detection (Winamp IPC) --------------------------------
// Which 24seven.fm station is Winamp tuned to? Returns an index into ssc::kStations,
// or -1 when playing something that isn't a family stream. The playlist FILE (the
// stream URL, e.g. http://hi5.death.fm/) is authoritative; the title is a fallback.
static int tunedStationIndex() {
    if (!g_winamp || !IsWindow(g_winamp))
        return 0; // no host window (e.g. options preview): show the default station
    if (SendMessageA(g_winamp, WM_WA_IPC, 0, IPC_ISPLAYING) == 0)
        return -1;
    const int pos = (int)SendMessageA(g_winamp, WM_WA_IPC, 0, IPC_GETLISTPOS);
    const char* url = (const char*)SendMessageA(g_winamp, WM_WA_IPC, pos, IPC_GETPLAYLISTFILE);
    const int byUrl = ssc::stationIndexForText(url);
    if (byUrl >= 0) return byUrl;
    const char* title = (const char*)SendMessageA(g_winamp, WM_WA_IPC, pos, IPC_GETPLAYLISTTITLE);
    return ssc::stationIndexForText(title);
}

// The cover monitor (poll/download thread) and the Direct2D render target exist only
// while the window is actually shown. When it's dismissed - user-closed or not tuned
// to a family stream - we stop polling the station and free the GPU resources, so a
// hidden window costs no network, no background thread and no render target / VRAM.
static void setActive(bool on) {
    if (on == g_active) return;
    g_active = on;
    if (on) {
        // Bring up Direct2D/WIC/DirectWrite on FIRST activation, not at plugin load.
        // Doing it in init() ran on Winamp's UI thread during startup and loaded the
        // graphics stack even for users who never tune to a 24seven.fm station -
        // contradicting the rule the gate is built on: idle costs nothing. d2d::init()
        // is idempotent, so re-activating is free.
        if (!g_d2dReady) g_d2dReady = d2d::init();
        eng().setWindow(g_hwnd); // heartbeat timer + render target (rebuilt on next paint)
        eng().start();           // cover monitor (autoAdvance=false: follows the ICY title)
    } else {
        eng().stop();             // stop the poll/download thread (returns promptly)
        eng().setWindow(nullptr); // kill the ~30fps heartbeat, detach the HWND
        eng().resetTitle();       // so the next show reloads the current cover
        d2d::resetTarget();       // release the render target + cached cover bitmaps
        d2d::releaseBlur();       // release the poster-mode blur device (if any)
    }
}

// --- fullscreen -------------------------------------------------------------
// The shared FullscreenWindow creates a dedicated per-monitor top-level window and
// points the engine at it; the gen_ff frame + our child are left untouched (the
// fullscreen window simply covers them). The gate (below) drops fullscreen when we
// tune out. Nothing to hide or re-lay-out here anymore.
static ssc::FullscreenWindow g_fsWin;

static void setFullscreen(bool on) {
    if (on == g_fsWin.active() || !g_hwnd) return;
    if (on) {
        covermenu::Actions act;
        act.openOptions = [] { showOwnOptions(g_fsWin.hwnd()); };
        act.persist = [] { saveSettings(); };
        g_fsWin.enter(g_hwnd, act, [] {});
    } else {
        g_fsWin.exit();
    }
}

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
        case SSC_WM_NEWCOVER:
            eng().onNewCover(hwnd);
            return 0;
        case SSC_WM_NEWMEDIA:
            eng().onNewMedia(hwnd);
            return 0;
        case WM_TIMER: {
            if (wp != kGateTimer) { eng().onTimer(hwnd, wp); return 0; } // engine repaint heartbeat

            // Gating only. gen_ff owns the frame's geometry AND sizes our child to
            // the content area - we must not touch the child's position/size (doing
            // so paints over the frame's title bar and kills its drag).
            HWND top = g_embedFrame ? g_embedFrame : hwnd;

            saveWindowPosIfMoved(); // persist a move/resize now, not only at quit()

            // Demo/screenshot mode: always show the window and let the engine self-drive
            // (it entered demo mode in start()); no tuning or title feeding.
            if (ssc::Demo::active()) {
                setActive(true);
                if (!g_fsWin.active() && !IsWindowVisible(top)) {
                    ShowWindow(top, SW_SHOWNA);
                    InvalidateRect(hwnd, nullptr, FALSE);
                }
                return 0;
            }

            const int stationIdx = tunedStationIndex();
            const bool tuned = stationIdx >= 0;
            if (!tuned) g_userClosed = false; // tuning out re-arms the auto-show

            // The window is shown iff tuned to a family stream and not user-dismissed.
            // The engine + GPU resources track that visibility via setActive().
            if (tuned && !g_userClosed) {
                setActive(true);
                // Auto-follow whichever family station Winamp is tuned to (no-op if
                // unchanged), and feed its ICY stream title so covers advance off what
                // Winamp is actually playing (the engine filters placeholders + dedups).
                eng().setStation(stationIdx);
                if (g_winamp) {
                    const int pos = (int)SendMessageA(g_winamp, WM_WA_IPC, 0, IPC_GETLISTPOS);
                    const char* t = (const char*)SendMessageA(g_winamp, WM_WA_IPC, pos, IPC_GETPLAYLISTTITLE);
                    eng().onTitleChanged(t ? t : "");
                }
                if (!g_fsWin.active() && !IsWindowVisible(top)) { // frame stays hidden in fullscreen
                    ShowWindow(top, SW_SHOWNA);
                    InvalidateRect(hwnd, nullptr, FALSE);
                }
            } else {
                if (g_fsWin.active()) setFullscreen(false); // tuning out / dismissing drops fullscreen first
                if (IsWindowVisible(top)) ShowWindow(top, SW_HIDE);
                setActive(false); // stop polling + free the render target
            }
            return 0;
        }
        case WM_CLOSE:
            // gen_ff posts WM_CLOSE to the content window when its title-bar close
            // button is clicked. DefWindowProc would DESTROY the window, leaving the
            // frame a permanently black empty shell. Instead dismiss it: hide the
            // frame and latch it so the gate doesn't reopen it until the user tunes
            // out and back in. (Also covers the standalone-window fallback.)
            ShowWindow(g_embedFrame ? g_embedFrame : hwnd, SW_HIDE);
            g_userClosed = true;
            return 0;
        case WM_CONTEXTMENU: { // right-click the cover -> shared popup (no station list,
                               // no Fullscreen: gen_ff owns the docked frame's geometry)
            POINT pt = { GET_X_LPARAM(lp), GET_Y_LPARAM(lp) };
            if (pt.x == -1 && pt.y == -1) { // keyboard-invoked (Menu key): client centre
                RECT rc; GetClientRect(hwnd, &rc);
                pt.x = rc.right / 2; pt.y = rc.bottom / 2;
                ClientToScreen(hwnd, &pt);
            }
            covermenu::Actions act;
            act.openOptions = [] { // open Winamp Preferences straight to our page
                if (g_winamp) SendMessageA(g_winamp, WM_WA_IPC, (WPARAM)&g_prefsRec, IPC_OPENPREFSTOPAGE);
            };
            act.persist          = [] { saveSettings(); };
            act.toggleFullscreen = [] { setFullscreen(!g_fsWin.active()); };
            covermenu::showPopup(hwnd, pt, eng(), act, /*includeFullscreen*/ true, g_fsWin.active());
            return 0;
        }
        case WM_LBUTTONDBLCLK: // double-click the cover -> enter fullscreen (Esc/dbl-click there exits)
            setFullscreen(!g_fsWin.active());
            return 0;
        case WM_MOUSEMOVE:
            eng().onPointerMove(hwnd, /*fullscreenAutoHide=*/false);
            return 0;
        case WM_MOUSELEAVE:
            eng().onPointerLeave(hwnd);
            return 0;
        case WM_KEYDOWN:
            if (wp == 'N') { eng().demoNext(); return 0; } // demo mode: next cover (no-op otherwise)
            break;
        case WM_SIZE: // gen_ff resized our child - just repaint at the new size
            InvalidateRect(hwnd, nullptr, FALSE);
            return 0;
        case WM_ERASEBKGND:
            return 1;
        case WM_PAINT: {
            PAINTSTRUCT ps;
            BeginPaint(hwnd, &ps); // validates the update region; D2D presents itself
            if (g_d2dReady) eng().onPaint(hwnd);
            EndPaint(hwnd, &ps);
            return 0;
        }
    }
    return DefWindowProcA(hwnd, msg, wp, lp);
}

static int init() {
    g_winamp = g_plugin.hwndParent;    // Winamp filled these in before calling init()
    g_hInst = g_plugin.hDllInstance;
    loadSettings();

    // NOTE: Direct2D is deliberately NOT initialised here - setActive() brings it up on
    // first activation, keeping the graphics stack off Winamp's startup path.

    WNDCLASSA wc = {};
    wc.style = CS_DBLCLKS; // deliver WM_LBUTTONDBLCLK on the cover (double-click -> fullscreen)
    wc.lpfnWndProc = WndProc;
    wc.hInstance = g_hInst;
    wc.lpszClassName = kWndClass;
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
    RegisterClassA(&wc);

    // Create the dockable gen_ff frame (on this UI thread) and put our drawing
    // window inside it as a child. This is what gives real dock/snap behaviour.
    if (g_winamp && IsWindow(g_winamp)) {
        embedWindowFn embedFn = (embedWindowFn)SendMessageA(g_winamp, WM_WA_IPC, 0, IPC_GET_EMBEDIF);
        if (embedFn) {
            ZeroMemory(&g_embedState, sizeof(g_embedState));
            g_embedState.flags = 0; // resizable
            // Reopen where the user left it. embedWindowState.r is input only - Winamp
            // places the frame with it and never writes it back - so this is the one
            // chance to restore the position.
            const ssc::WindowRect wr = startupRect();
            g_embedState.r.left = wr.x;          g_embedState.r.top    = wr.y;
            g_embedState.r.right = wr.x + wr.w;  g_embedState.r.bottom = wr.y + wr.h;
            g_savedRect = wr; // seed, so the poll doesn't rewrite what we just restored
            g_embedFrame = embedFn(&g_embedState);
            if (!(g_embedFrame && IsWindow(g_embedFrame)))
                g_embedFrame = nullptr;
        }
    }

    if (g_embedFrame) {
        SetWindowTextA(g_embedFrame, "24seven.fm Covers");
        // Content is a ZERO-sized child; gen_ff positions and sizes it inside the
        // frame (below the skinned title bar) and resizes it on frame resize. We
        // never set its geometry - that's what was painting over the title bar and
        // preventing the frame from being dragged. (Pattern from WACUP's
        // gen_waveseek: CreateWindow(... WS_CHILD, 0,0,0,0, frame ...).)
        g_hwnd = CreateWindowExA(WS_EX_NOPARENTNOTIFY, kWndClass, "",
                                 WS_CHILD | WS_VISIBLE, 0, 0, 0, 0,
                                 g_embedFrame, nullptr, g_hInst, nullptr);
        ShowWindow(g_embedFrame, SW_HIDE); // hidden until tuned in
    } else {
        // Fallback: a plain top-level window, moved by the OS via its title bar.
        g_hwnd = CreateWindowExA(0, kWndClass, "24seven.fm Covers", WS_OVERLAPPEDWINDOW,
                                 CW_USEDEFAULT, CW_USEDEFAULT, 500, 500,
                                 g_winamp, nullptr, g_hInst, nullptr);
    }
    if (!g_hwnd)
        return 1;
    SetTimer(g_hwnd, kGateTimer, 500, nullptr);

    // The gate timer activates the engine (setActive) the first time Winamp is tuned
    // to a family stream and the window is shown - not here - so a plugin loaded while
    // idle (or not listening to the family) uses no thread, no network and no GPU.
    eng().setLogName("24seven.fm-covers-winamp");

    // Add our options to Winamp's Preferences treeview (Plug-ins section). The page is
    // the shared options dialog and applies live - the prefs tree has no per-page OK
    // (Winamp owns the Close button). Removed in quit(). InitCommonControlsEx registers
    // the trackbar class so the duration slider exists when Winamp builds the page.
    INITCOMMONCONTROLSEX icc = {
        sizeof(icc), ICC_BAR_CLASSES | ICC_LISTVIEW_CLASSES | ICC_TAB_CLASSES
    };
    InitCommonControlsEx(&icc);
    g_prefsRec.hInst = g_hInst;
    g_prefsRec.dlgID = IDD_PREFS_SCROLL_HOST;
    g_prefsRec.proc  = (void*)OptionsScrollHostProc;
    g_prefsRec.name  = (char*)"24seven.fm Covers";
    g_prefsRec.where = 0; // General Preferences section
    if (g_winamp) SendMessageA(g_winamp, WM_WA_IPC, (WPARAM)&g_prefsRec, IPC_ADD_PREFS_DLG);
    return 0;
}

// The own dialog is used both from Configure and from our fullscreen context menu.
// The latter must not switch to Winamp's host preferences or tear fullscreen down.
static HFONT g_linkFont = nullptr;

// Positions a tab page child dialog inside the tab control's display area.
static void placePage(HWND dlg, HWND tab, HWND page) {
    RECT rc; GetWindowRect(tab, &rc);
    MapWindowPoints(HWND_DESKTOP, dlg, (POINT*)&rc, 2);
    TabCtrl_AdjustRect(tab, FALSE, &rc); // window rect -> display (content) rect
    SetWindowPos(page, HWND_TOP, rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top, SWP_NOZORDER);
}

// "About" tab page: version (kept in sync with version.h) + a clickable link.
static INT_PTR CALLBACK AboutTabProc(HWND dlg, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
        case WM_INITDIALOG: {
            SetDlgItemTextA(dlg, IDC_ABOUT_VER, "Version " SSC_VER_STR);
            HFONT f = (HFONT)SendMessageA(dlg, WM_GETFONT, 0, 0); // underline the link
            LOGFONTA lf = {};
            if (f && GetObjectA(f, sizeof(lf), &lf)) {
                lf.lfUnderline = TRUE;
                if (g_linkFont) DeleteObject(g_linkFont);
                g_linkFont = CreateFontIndirectA(&lf);
                if (g_linkFont)
                    SendDlgItemMessageA(dlg, IDC_ABOUT_LINK, WM_SETFONT, (WPARAM)g_linkFont, TRUE);
            }
            return TRUE;
        }
        case WM_CTLCOLORSTATIC:
            if ((HWND)lp == GetDlgItem(dlg, IDC_ABOUT_LINK)) {
                SetTextColor((HDC)wp, RGB(0, 0, 238)); // link blue
                SetBkMode((HDC)wp, TRANSPARENT);
                return (INT_PTR)GetStockObject(NULL_BRUSH);
            }
            break;
        case WM_SETCURSOR:
            if ((HWND)wp == GetDlgItem(dlg, IDC_ABOUT_LINK)) {
                SetCursor(LoadCursor(nullptr, IDC_HAND));
                SetWindowLongPtr(dlg, DWLP_MSGRESULT, TRUE);
                return TRUE;
            }
            break;
        case WM_COMMAND:
            if (LOWORD(wp) == IDC_ABOUT_LINK && HIWORD(wp) == STN_CLICKED) {
                ShellExecuteA(dlg, "open", "https://24seven.fm/", nullptr, nullptr, SW_SHOWNORMAL);
                return TRUE;
            }
            break;
        case WM_DESTROY:
            if (g_linkFont) { DeleteObject(g_linkFont); g_linkFont = nullptr; }
            break;
    }
    return FALSE;
}

struct ConfigDialogState {
    HWND options = nullptr;
    HWND about = nullptr;
    int selected = 0;
};

static void selectConfigPage(ConfigDialogState* state, int selected) {
    if (!state || selected < 0 || selected > 1 || selected == state->selected) return;
    HWND outgoing = state->selected == 0 ? state->options : state->about;
    HWND incoming = selected == 0 ? state->options : state->about;
    state->selected = selected;
    childfade::replace(outgoing, incoming);
}

static INT_PTR CALLBACK ConfigDlgProc(HWND dlg, UINT msg, WPARAM wp, LPARAM lp) {
    ConfigDialogState* state =
        reinterpret_cast<ConfigDialogState*>(GetWindowLongPtrA(dlg, GWLP_USERDATA));
    switch (msg) {
        case WM_INITDIALOG: {
            state = new ConfigDialogState();
            SetWindowLongPtrA(dlg, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(state));
            HWND tab = GetDlgItem(dlg, IDC_TAB);
            TCITEMA ti = {}; ti.mask = TCIF_TEXT;
            ti.pszText = (char*)"Options"; TabCtrl_InsertItem(tab, 0, &ti);
            ti.pszText = (char*)"About";   TabCtrl_InsertItem(tab, 1, &ti);
            state->options = CreateDialogA(g_hInst, MAKEINTRESOURCEA(IDD_PREFS_SCROLL_HOST),
                                           dlg, OptionsScrollHostProc);
            state->about = CreateDialogA(g_hInst, MAKEINTRESOURCEA(IDD_TAB_ABOUT),
                                         dlg, AboutTabProc);
            placePage(dlg, tab, state->options);
            placePage(dlg, tab, state->about);
            ShowWindow(state->options, SW_SHOWNA);
            ShowWindow(state->about, SW_HIDE);

            // Owned windows normally follow the owner's z-order, but explicitly join
            // the topmost band when our owner is the dedicated fullscreen canvas.
            const HWND owner = GetWindow(dlg, GW_OWNER);
            if (owner && (GetWindowLongPtrA(owner, GWL_EXSTYLE) & WS_EX_TOPMOST))
                SetWindowPos(dlg, HWND_TOPMOST, 0, 0, 0, 0,
                             SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            return TRUE;
        }
        case WM_NOTIFY:
            if (reinterpret_cast<LPNMHDR>(lp)->idFrom == IDC_TAB &&
                reinterpret_cast<LPNMHDR>(lp)->code == TCN_SELCHANGE) {
                selectConfigPage(state, TabCtrl_GetCurSel(GetDlgItem(dlg, IDC_TAB)));
                return TRUE;
            }
            break;
        case WM_COMMAND:
            if (LOWORD(wp) == IDOK || LOWORD(wp) == IDCANCEL) { // Close (or Esc)
                EndDialog(dlg, LOWORD(wp));
                return TRUE;
            }
            break;
        case WM_DESTROY:
            delete state;
            SetWindowLongPtrA(dlg, GWLP_USERDATA, 0);
            break;
    }
    return FALSE;
}

// Winamp Preferences-tree page: the shared options page, hosted by Winamp in the
// prefs content pane. The tree has no per-page OK button, so it applies live -
// every control change is read into engine.settings, persisted, and repainted
// (the same live-preview model the desktop viewer's Apply uses).
static INT_PTR CALLBACK PrefsPageProc(HWND dlg, UINT msg, WPARAM wp, LPARAM lp) {
    auto commit = [&]() {
        optpanel::read(dlg, eng().settings);
        saveSettings();
        eng().repaint(); // also re-resolves media when provider/key options changed
    };
    switch (msg) {
        case WM_INITDIALOG:
            optpanel::init(dlg, eng().settings);
            return TRUE;
        case WM_HSCROLL: // duration slider dragged
            optpanel::onHScroll(dlg);
            commit();
            return TRUE;
        case WM_COMMAND:
            // Any control click (checkbox / radio group) may change dependent enabling.
            optpanel::onCommand(dlg, LOWORD(wp));
            optpanel::updateEnabled(dlg);
            commit(); // live-apply
            return TRUE;
        case WM_NOTIFY:
            if (optpanel::onNotify(dlg, reinterpret_cast<LPNMHDR>(lp))) {
                commit();
                return TRUE;
            }
            break;
        case WM_MOUSEWHEEL:
            // The outer host owns vertical scrolling; keep the list view's own wheel
            // behaviour intact, but forward wheel input over the page background.
            return SendMessageA(GetParent(dlg), msg, wp, lp);
    }
    return FALSE;
}

struct OptionsScrollState {
    HWND page = nullptr;
    int contentWidth = 0;
    int contentHeight = 0;
    int position = 0;
};

static void layoutOptionsScrollHost(HWND dlg, OptionsScrollState* state) {
    if (!state || !state->page) return;
    RECT client = {};
    GetClientRect(dlg, &client);
    SCROLLINFO info = { sizeof(info), SIF_RANGE | SIF_PAGE | SIF_POS };
    info.nMin = 0;
    info.nMax = std::max(0, state->contentHeight - 1);
    info.nPage = static_cast<UINT>(std::max(0L, client.bottom - client.top));
    info.nPos = state->position;
    SetScrollInfo(dlg, SB_VERT, &info, TRUE);
    info.fMask = SIF_POS;
    GetScrollInfo(dlg, SB_VERT, &info);
    state->position = info.nPos;
    SetWindowPos(state->page, nullptr, 0, -state->position,
                 std::max(state->contentWidth, static_cast<int>(client.right - client.left)),
                 state->contentHeight, SWP_NOZORDER | SWP_NOACTIVATE);
}

static void scrollOptionsHost(HWND dlg, OptionsScrollState* state, int target) {
    if (!state) return;
    state->position = std::max(0, target);
    layoutOptionsScrollHost(dlg, state);
}

static INT_PTR CALLBACK OptionsScrollHostProc(HWND dlg, UINT msg, WPARAM wp, LPARAM) {
    OptionsScrollState* state =
        reinterpret_cast<OptionsScrollState*>(GetWindowLongPtrA(dlg, GWLP_USERDATA));
    switch (msg) {
        case WM_INITDIALOG: {
            state = new OptionsScrollState();
            SetWindowLongPtrA(dlg, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(state));
            state->page = CreateDialogA(g_hInst, MAKEINTRESOURCEA(IDD_OPTIONS_PAGE),
                                        dlg, PrefsPageProc);
            if (state->page) {
                RECT content = {};
                GetWindowRect(state->page, &content);
                state->contentWidth = content.right - content.left;
                state->contentHeight = content.bottom - content.top;
                ShowWindow(state->page, SW_SHOWNA);
                layoutOptionsScrollHost(dlg, state);
            }
            return TRUE;
        }
        case WM_SIZE:
            layoutOptionsScrollHost(dlg, state);
            return TRUE;
        case WM_VSCROLL: {
            if (!state) return TRUE;
            SCROLLINFO info = { sizeof(info), SIF_ALL };
            GetScrollInfo(dlg, SB_VERT, &info);
            int target = state->position;
            switch (LOWORD(wp)) {
                case SB_LINEUP:      target -= 20; break;
                case SB_LINEDOWN:    target += 20; break;
                case SB_PAGEUP:      target -= static_cast<int>(info.nPage); break;
                case SB_PAGEDOWN:    target += static_cast<int>(info.nPage); break;
                case SB_THUMBTRACK:
                case SB_THUMBPOSITION: target = info.nTrackPos; break;
                case SB_TOP:         target = 0; break;
                case SB_BOTTOM:      target = state->contentHeight; break;
                default: return TRUE;
            }
            scrollOptionsHost(dlg, state, target);
            return TRUE;
        }
        case WM_MOUSEWHEEL:
            scrollOptionsHost(dlg, state,
                state ? state->position - GET_WHEEL_DELTA_WPARAM(wp) / WHEEL_DELTA * 40 : 0);
            return TRUE;
        case WM_DESTROY:
            delete state;
            SetWindowLongPtrA(dlg, GWLP_USERDATA, 0);
            break;
    }
    return FALSE;
}

static void showOwnOptions(HWND owner) {
    INITCOMMONCONTROLSEX icc = {
        sizeof(icc), ICC_TAB_CLASSES | ICC_BAR_CLASSES | ICC_LISTVIEW_CLASSES
    };
    InitCommonControlsEx(&icc);
    DialogBoxParamA(g_hInst, MAKEINTRESOURCEA(IDD_CONFIG), owner ? owner : g_winamp,
                    ConfigDlgProc, 0);
}

static void config() {
    showOwnOptions(g_winamp);
}

static void quit() {
    if (g_winamp) SendMessageA(g_winamp, WM_WA_IPC, (WPARAM)&g_prefsRec, IPC_REMOVE_PREFS_DLG);
    eng().stop();
    eng().setWindow(nullptr); // also kills the engine's repaint heartbeat
    if (g_hwnd) KillTimer(g_hwnd, kGateTimer);
    saveWindowPosIfMoved(); // BEFORE the frame goes away - afterwards there is no rect to read
    if (g_embedFrame) DestroyWindow(g_embedFrame);
    else if (g_hwnd)  DestroyWindow(g_hwnd);
    g_hwnd = nullptr;
    g_embedFrame = nullptr;
    UnregisterClassA(kWndClass, g_hInst);
    d2d::shutdown();
}

// --- Winamp general-purpose plugin export ----------------------------------
extern "C" __declspec(dllexport) winampGeneralPurposePlugin* winampGetGeneralPurposePlugin() {
    return &g_plugin;
}
