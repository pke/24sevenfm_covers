// 24sevencovers - desktop viewer for the Streaming Soundtracks (24seven.fm) "now
// playing" cover art. It is now a thin native-Win32 host around the SAME shared
// engine the Winamp and foobar2000 plugins use: the cross-platform CoverMonitor
// (lib/), the Direct2D renderer (shared/d2d_*) and CoverEngine (shared/) - so the
// viewer gets the identical cover preload, crossfade/flip transitions and
// remaining-time countdown for free.
//
// Unlike the plugins there is no media player to source track changes from, so the
// engine runs in autoAdvance mode: the monitor follows the station's live clock on
// its own. Options (overlay, transition, rolling countdown, ...) are the shared
// options page, reached from the window's system menu -> "Options...".

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <windowsx.h>   // GET_X_LPARAM / GET_Y_LPARAM
#include <commctrl.h>   // trackbar (duration slider), property sheet
#include <shellapi.h>   // ShellExecute (About link)
#include <shlobj.h>     // SHGetFolderPath (per-user %APPDATA%)
#include <shobjidl.h>   // SetCurrentProcessExplicitAppUserModelID (taskbar identity / pinning)
#pragma comment(lib, "shell32.lib")

#include <string>

#include "d2d_renderer.h"   // d2d::init/shutdown (rendering itself lives in the engine)
#include "cover_engine.h"   // shared cover/preload/animation engine
#include "cover_menu.h"        // shared right-click context menu (Fullscreen / Poster / Options)
#include "fullscreen_window.h" // shared dedicated per-monitor fullscreen window
#include "options_panel.h"  // shared options page (dialog + control logic)
#include "stations.h"       // 24seven.fm station table (viewer station picker)
#include "config.h"         // shared option schema + INI adapter
#include "window_rect.h"    // remember the window's position/size across runs
#include "viewer_resource.h"

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "d2d1.lib")
#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "dwrite.lib")
#pragma comment(lib, "ole32.lib")

static const char* kWndClass = "SST24CoverViewerWnd";
static const UINT   SC_OPTIONS     = 0x1000; // system-menu command id (must be < 0xF000, low nibble 0)
// Station / Fullscreen / Options / Poster menu ids all live in covermenu:: now.

static HINSTANCE g_hInst    = nullptr;
static HWND      g_hwnd     = nullptr;
static bool      g_d2dReady = false;
static bool      g_firstRun = false; // no INI yet -> prompt for a station on first launch

// Borderless-fullscreen state (double-click / context menu / Esc toggle it).
static ssc::FullscreenWindow g_fsWin; // dedicated per-monitor fullscreen window

static CoverEngine& eng() { return CoverEngine::instance(); }

// --- settings (INI <-> engine.settings) -------------------------------------
static const char kIniName[] = "24seven.fm-covers.ini";
static const char kAppDataSubdir[] = "24seven.fm Covers";

// True if we can create files in `dir` (probe file auto-deletes on close). A 64-bit
// process gets no UAC file virtualization, so this correctly reports false for
// Program Files - which is exactly the installed case we must redirect elsewhere.
static bool dirWritable(const std::string& dir) {
    const std::string probe = dir + "._sscprobe.tmp";
    HANDLE h = CreateFileA(probe.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                           FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    CloseHandle(h);
    return true;
}

// Portable use (zip in a writable folder) keeps the INI next to the exe so settings
// travel with it; an existing local INI is always honoured. Installed use (Program
// Files, not writable) falls back to per-user %APPDATA%\24seven.fm Covers\.
static std::string iniPath() {
    // Grow the buffer until the path fits: a fixed MAX_PATH buffer truncates on long
    // paths (and pre-Win10 does not null-terminate on truncation). n == size means the
    // API had to truncate - double and retry; n < size means it fit (n excludes the NUL).
    std::string exe(MAX_PATH, '\0');
    for (;;) {
        DWORD n = GetModuleFileNameA(nullptr, &exe[0], (DWORD)exe.size());
        if (n == 0) { exe.clear(); break; }             // API failure
        if (n < exe.size()) { exe.resize(n); break; }   // fit
        exe.resize(exe.size() * 2);                     // truncated: grow
    }
    std::string p = exe;
    const auto slash = p.find_last_of("\\/");
    const std::string exeDir = (slash == std::string::npos) ? std::string() : p.substr(0, slash + 1);
    const std::string localIni = exeDir + kIniName;

    if (GetFileAttributesA(localIni.c_str()) != INVALID_FILE_ATTRIBUTES) return localIni;
    if (!exeDir.empty() && dirWritable(exeDir)) return localIni;

    // SHGetFolderPath, not the APPDATA env var: it resolves per-user Roaming
    // regardless of the launching process's environment block.
    char appdata[MAX_PATH] = {0};
    if (SUCCEEDED(SHGetFolderPathA(nullptr, CSIDL_APPDATA, nullptr, SHGFP_TYPE_CURRENT, appdata))) {
        const std::string dir = std::string(appdata) + "\\" + kAppDataSubdir;
        CreateDirectoryA(dir.c_str(), nullptr); // harmless if it already exists
        return dir + "\\" + kIniName;
    }
    return localIni; // last resort
}
static void loadSettings() {
    ssccfg::IniConfigStore store(iniPath());
    g_firstRun = !ssccfg::load(eng().settings, store); // no station stored yet -> prompt on first run
}

// --- window geometry (see shared/window_rect.h) -----------------------------
static ssc::WindowRect g_savedRect; // last geometry written, so we only write on a change

// The window's RESTORED geometry plus whether it is maximized. rcNormalPosition, not
// GetWindowRect: a maximized window would otherwise save the screen-sized rect and lose
// the size to go back to.
static bool currentWindowRect(HWND hwnd, ssc::WindowRect& out) {
    if (!hwnd || !IsWindow(hwnd)) return false;
    WINDOWPLACEMENT wp = { sizeof(wp) };
    if (!GetWindowPlacement(hwnd, &wp)) return false;
    const RECT& r = wp.rcNormalPosition;
    out.x = r.left; out.y = r.top;
    out.w = r.right - r.left; out.h = r.bottom - r.top;
    out.maximized = (wp.showCmd == SW_SHOWMAXIMIZED);
    return out.w > 0 && out.h > 0;
}

// Called when a move/resize finishes and on shutdown. Writes only on an actual change.
static void saveWindowPosIfMoved(HWND hwnd) {
    ssc::WindowRect r;
    if (!currentWindowRect(hwnd, r)) return;
    if (ssc::sameRect(r, g_savedRect)) return;
    ssccfg::IniConfigStore store(iniPath());
    ssc::saveWindowRectIfMoved(store, r, g_savedRect);
}

// The saved rect, or a DPI-scaled default when nothing is stored or it would land
// off-screen (a monitor unplugged since last run must not strand the window).
static ssc::WindowRect startupRect(int dpi) {
    ssccfg::IniConfigStore store(iniPath());
    ssc::WindowRect r;
    if (ssc::loadWindowRect(store, r)) {
        const int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        const int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if (ssc::rectVisibleIn(r, vx, vy, vx + vw, vy + vh)) return r;
    }
    const int side = MulDiv(500, dpi, 96);
    RECT rc = { 0, 0, side, side };
    AdjustWindowRect(&rc, WS_OVERLAPPEDWINDOW, FALSE);
    ssc::WindowRect def;
    def.x = CW_USEDEFAULT; def.y = CW_USEDEFAULT;
    def.w = rc.right - rc.left; def.h = rc.bottom - rc.top;
    return def;
}
static void saveSettings() {
    ssccfg::IniConfigStore store(iniPath());
    ssccfg::save(eng().settings, store);
}

// --- Options: a property sheet hosting the shared options page --------------
// A property sheet gives standard OK / Cancel / Apply buttons with Windows' own
// padding. Apply (and OK) commit the controls into the engine settings, persist
// them, and repaint - so a change is visible live without closing the sheet. The
// page itself is the SHARED options page; its control logic is optpanel (the exact
// code the Winamp/foobar plugins use).
static INT_PTR CALLBACK OptionsPageProc(HWND dlg, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
        case WM_INITDIALOG:
            optpanel::init(dlg, eng().settings);
            return TRUE;
        case WM_HSCROLL:
            optpanel::onHScroll(dlg);
            PropSheet_Changed(GetParent(dlg), dlg); // dragging the slider -> enable Apply
            return TRUE;
        case WM_COMMAND:
            // Any control click (checkbox / radio group) may change dependent enabling.
            optpanel::updateEnabled(dlg);
            PropSheet_Changed(GetParent(dlg), dlg); // a setting changed -> enable Apply
            return TRUE;
        case WM_NOTIFY:
            if (reinterpret_cast<LPNMHDR>(lp)->code == PSN_APPLY) { // Apply or OK
                optpanel::read(dlg, eng().settings);
                saveSettings();
                eng().repaint(); // live preview
                SetWindowLongPtrA(dlg, DWLP_MSGRESULT, PSNRET_NOERROR);
                return TRUE;
            }
            break;
    }
    return FALSE;
}

// "About" page: version (filled here so it stays in sync with version.h) + a
// clickable link to the station.
static HFONT g_linkFont = nullptr;
static INT_PTR CALLBACK AboutPageProc(HWND dlg, UINT msg, WPARAM wp, LPARAM lp) {
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
                SetWindowLongPtrA(dlg, DWLP_MSGRESULT, TRUE);
                return TRUE;
            }
            break;
        case WM_COMMAND:
            if (LOWORD(wp) == IDC_ABOUT_LINK && HIWORD(wp) == STN_CLICKED) {
                ShellExecuteA(dlg, "open", "https://24seven.fm/",
                              nullptr, nullptr, SW_SHOWNORMAL);
                return TRUE;
            }
            break;
        case WM_DESTROY:
            if (g_linkFont) { DeleteObject(g_linkFont); g_linkFont = nullptr; }
            break;
    }
    return FALSE;
}

// "Station" page (viewer only): pick which 24seven.fm station's now-playing cover
// to display. The viewer has no player, so unlike the plugins it can't auto-follow -
// the user chooses here. A vertical radio group (one station per line) built from
// ssc::kStations at runtime, so adding a station needs no resource edit. Applying
// rebuilds the engine's monitor for the new host (live), swapping the cover.
static INT_PTR CALLBACK StationPageProc(HWND dlg, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
        case WM_INITDIALOG: {
            HFONT font = (HFONT)SendMessageA(dlg, WM_GETFONT, 0, 0);
            const int cur = ssc::validStationIndex(eng().settings.station);
            for (int i = 0; i < ssc::kStationCount; ++i) {
                RECT r = { 14, 18 + i * 14, 14 + 176, 18 + i * 14 + 12 }; // dialog units
                MapDialogRect(dlg, &r);
                HWND rb = CreateWindowExA(
                    0, "BUTTON", ssc::kStations[i].displayName,
                    WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTORADIOBUTTON | (i == 0 ? WS_GROUP : 0),
                    r.left, r.top, r.right - r.left, r.bottom - r.top,
                    dlg, (HMENU)(INT_PTR)(IDC_VIEW_STATION_FIRST + i), g_hInst, nullptr);
                if (font) SendMessageA(rb, WM_SETFONT, (WPARAM)font, TRUE);
                if (i == cur) SendMessageA(rb, BM_SETCHECK, BST_CHECKED, 0);
            }
            SetDlgItemTextA(dlg, IDC_VIEW_STATION_DESC, ssc::kStations[cur].desc);
            return TRUE;
        }
        case WM_COMMAND: {
            const int id = LOWORD(wp);
            if (HIWORD(wp) == BN_CLICKED &&
                id >= IDC_VIEW_STATION_FIRST && id < IDC_VIEW_STATION_FIRST + ssc::kStationCount) {
                SetDlgItemTextA(dlg, IDC_VIEW_STATION_DESC, ssc::kStations[id - IDC_VIEW_STATION_FIRST].desc);
                PropSheet_Changed(GetParent(dlg), dlg); // enable Apply
                return TRUE;
            }
            break;
        }
        case WM_NOTIFY:
            if (reinterpret_cast<LPNMHDR>(lp)->code == PSN_APPLY) { // Apply or OK
                int idx = ssc::validStationIndex(eng().settings.station); // fallback: unchanged
                for (int i = 0; i < ssc::kStationCount; ++i)
                    if (IsDlgButtonChecked(dlg, IDC_VIEW_STATION_FIRST + i) == BST_CHECKED) { idx = i; break; }
                eng().setStation(idx); // live: rebuilds the monitor for the new host
                saveSettings();
                SetWindowLongPtrA(dlg, DWLP_MSGRESULT, PSNRET_NOERROR);
                return TRUE;
            }
            break;
    }
    return FALSE;
}

static PROPSHEETPAGEA makePage(WORD templateId, DLGPROC proc, const char* title) {
    PROPSHEETPAGEA p = { sizeof(p) };
    p.dwFlags     = PSP_USETITLE;
    p.hInstance   = g_hInst;
    p.pszTemplate = MAKEINTRESOURCEA(templateId);
    p.pfnDlgProc  = proc;
    p.pszTitle    = title;
    return p;
}

// Page indices in the property sheet below (also the startPage values for openOptions).
enum { kPageStation = 0, kPageOptions = 1, kPageAbout = 2 };

// startPage picks the initially-selected tab: the "Options..." menu opens on Options;
// first-run opens on Station (kPageStation) to prompt for a station.
static void openOptions(int startPage = kPageOptions) {
    PROPSHEETPAGEA pages[] = {
        makePage(IDD_TAB_STATION,  StationPageProc, "Station"), // viewer-only station picker
        makePage(IDD_OPTIONS_PAGE, OptionsPageProc, "Options"), // shared options page
        makePage(IDD_TAB_ABOUT,    AboutPageProc,   "About"),
    };
    PROPSHEETHEADERA psh = { sizeof(psh) };
    psh.dwFlags    = PSH_PROPSHEETPAGE | PSH_NOCONTEXTHELP;
    psh.hwndParent = g_hwnd;
    psh.hInstance  = g_hInst;
    psh.pszCaption = "24seven.fm Covers";
    psh.nPages     = ARRAYSIZE(pages);
    psh.nStartPage = (UINT)startPage;
    psh.ppsp       = pages;
    PropertySheetA(&psh);
}

// Toggle fullscreen via the shared dedicated per-monitor window: it covers the monitor
// containing hwnd and the engine renders into it until dismissed (Esc / double-click /
// its own right-click menu), then hands rendering back to the main window.
static void toggleFullscreen(HWND hwnd) {
    covermenu::Actions act;
    act.openOptions = [] { openOptions(); };
    act.persist     = [] { saveSettings(); };
    g_fsWin.toggle(hwnd, act, [] {}, /*includeStations*/ true); // viewer keeps its station picker
}

// --- window -----------------------------------------------------------------
static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
        case SSC_WM_NEWCOVER:
            eng().onNewCover(hwnd);
            return 0;
        case WM_TIMER:
            eng().onTimer(hwnd, wp); // engine repaint heartbeat (fade + countdown)
            return 0;
        case WM_SIZE:
            InvalidateRect(hwnd, nullptr, FALSE);
            // Maximize/restore doesn't go through WM_EXITSIZEMOVE, so catch it here.
            if (wp == SIZE_MAXIMIZED || wp == SIZE_RESTORED) saveWindowPosIfMoved(hwnd);
            return 0;
        case WM_EXITSIZEMOVE:
            // Once, when the user lets go - not on every pixel of the drag.
            saveWindowPosIfMoved(hwnd);
            return 0;
        case WM_ERASEBKGND:
            return 1; // D2D paints the whole client area
        case WM_PAINT: {
            PAINTSTRUCT ps;
            BeginPaint(hwnd, &ps);
            if (g_d2dReady) eng().onPaint(hwnd);
            EndPaint(hwnd, &ps);
            return 0;
        }
        case WM_LBUTTONDBLCLK: // double-click the canvas -> toggle fullscreen
            toggleFullscreen(hwnd);
            return 0;
        case WM_KEYDOWN:
            if (wp == VK_ESCAPE && g_fsWin.active()) { toggleFullscreen(hwnd); return 0; }
            if (wp == 'N') { eng().demoNext(); return 0; } // demo mode: next cover (no-op otherwise)
            break;
        case WM_CONTEXTMENU: { // right-click the canvas -> popup menu
            POINT pt = { GET_X_LPARAM(lp), GET_Y_LPARAM(lp) };
            if (pt.x == -1 && pt.y == -1) { // keyboard-invoked (Menu key): use client centre
                RECT rc; GetClientRect(hwnd, &rc);
                pt.x = rc.right / 2; pt.y = rc.bottom / 2;
                ClientToScreen(hwnd, &pt);
            }
            HMENU m = CreatePopupMenu();
            covermenu::appendItems(m, eng().settings, /*includeFullscreen*/ true,
                                   g_fsWin.active(), /*includeStations*/ true);
            TrackPopupMenu(m, TPM_RIGHTBUTTON, pt.x, pt.y, 0, hwnd, nullptr);
            DestroyMenu(m);
            return 0;
        }
        case WM_COMMAND: {
            const UINT cmd = LOWORD(wp);
            covermenu::Actions act;
            act.openOptions      = []      { openOptions(); };
            act.persist          = []      { saveSettings(); };
            act.toggleFullscreen = [hwnd]  { toggleFullscreen(hwnd); };
            if (covermenu::onCommand(cmd, eng(), act)) return 0;
            break;
        }
        case WM_SYSCOMMAND:
            if ((wp & 0xFFF0) == SC_OPTIONS) { openOptions(); return 0; }
            break;
        case WM_DESTROY:
            saveWindowPosIfMoved(hwnd); // last chance, while the window still exists
            PostQuitMessage(0);
            return 0;
    }
    return DefWindowProcA(hwnd, msg, wp, lp);
}

int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE, LPSTR, int nCmdShow) {
    g_hInst = hInstance;

    // A stable AppUserModelID gives the viewer its own taskbar identity - proper
    // window grouping and a reliable "Pin to taskbar" (Windows won't offer pinning
    // for a running app it can't identify). Note: apps launched from a network/mapped
    // drive still can't be pinned - that's a shell limitation, use the local install.
    SetCurrentProcessExplicitAppUserModelID(L"app.dudesoft.24sevenfmcovers.viewer");

    INITCOMMONCONTROLSEX icc = { sizeof(icc), ICC_BAR_CLASSES | ICC_STANDARD_CLASSES };
    InitCommonControlsEx(&icc); // trackbar (duration slider) + standard controls

    loadSettings();
    g_d2dReady = d2d::init(); // Direct2D/WIC/DirectWrite (also CoInitializes)

    HICON icon = LoadIconA(g_hInst, MAKEINTRESOURCEA(IDI_APPICON));
    WNDCLASSEXA wc = { sizeof(wc) };
    wc.style         = CS_DBLCLKS | CS_HREDRAW | CS_VREDRAW; // deliver double-clicks; redraw on resize
    wc.lpfnWndProc   = WndProc;
    wc.hInstance     = g_hInst;
    wc.lpszClassName = kWndClass;
    wc.hCursor       = LoadCursor(nullptr, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
    wc.hIcon         = icon;
    wc.hIconSm       = icon;
    RegisterClassExA(&wc);

    // Top-level resizable window with a 500x500 client area, scaled by the system DPI so
    // it isn't tiny on a high-DPI monitor now that we're per-monitor DPI aware.
    // GetDpiForSystem is Win10 1607+; fall back to 96 (100%) on older Windows.
    UINT dpi = 96;
    if (HMODULE u = GetModuleHandleA("user32.dll")) {
        typedef UINT (WINAPI *GetDpiForSystem_t)();
        if (auto p = (GetDpiForSystem_t)GetProcAddress(u, "GetDpiForSystem")) dpi = p();
    }
    // Reopen where the user left it (falls back to a DPI-scaled default).
    const ssc::WindowRect wr = startupRect(dpi);
    g_hwnd = CreateWindowExA(0, kWndClass, "24seven.fm Covers", WS_OVERLAPPEDWINDOW,
                             wr.x, wr.y, wr.w, wr.h,
                             nullptr, nullptr, g_hInst, nullptr);
    if (!g_hwnd) return 1;
    // Seed the comparison so the first save doesn't rewrite what we just restored. The
    // window is created un-maximized and maximized below (if it was), so carry that flag
    // over from what we loaded rather than reading it back off a not-yet-maximized window.
    currentWindowRect(g_hwnd, g_savedRect);
    g_savedRect.maximized = wr.maximized;

    // Add "Options..." to the window's system menu (right-click title bar / Alt+Space).
    if (HMENU sys = GetSystemMenu(g_hwnd, FALSE)) {
        AppendMenuA(sys, MF_SEPARATOR, 0, nullptr);
        AppendMenuA(sys, MF_STRING, SC_OPTIONS, "Options...");
    }

    // Reopen maximized if that's how it was left - unless the shell asked for something
    // specific (e.g. a shortcut set to "Minimized"), which takes precedence.
    const int show = nCmdShow ? nCmdShow : SW_SHOWNORMAL;
    ShowWindow(g_hwnd, (g_savedRect.maximized && show == SW_SHOWNORMAL) ? SW_SHOWMAXIMIZED : show);
    UpdateWindow(g_hwnd);

    // Hand the window to the engine and start the monitor in live/auto-advance mode.
    eng().setLogName("24seven.fm-covers-viewer");
    eng().setWindow(g_hwnd);
    eng().start(/*autoAdvance=*/true);

    // No station chosen yet (missing INI entry): the viewer has no player to auto-follow,
    // so ask which station to show - open on the Station tab. Saving afterwards writes the
    // station key so we don't prompt again even if they just close it.
    if (g_firstRun) {
        openOptions(kPageStation);
        saveSettings();
    }

    MSG m;
    while (GetMessage(&m, nullptr, 0, 0) > 0) {
        TranslateMessage(&m);
        DispatchMessage(&m);
    }

    eng().stop();
    eng().setWindow(nullptr); // also kills the engine's repaint heartbeat
    d2d::shutdown();
    UnregisterClassA(kWndClass, g_hInst);
    return (int)m.wParam;
}
