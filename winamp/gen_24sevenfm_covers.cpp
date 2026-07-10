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
#include "options_panel.h"  // shared options page (dialog + control logic)
#include "stations.h"       // 24seven.fm station table + stream-URL detection

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
    const std::string p = iniPath();
    CoverEngine::Settings& s = eng().settings;
    s.showOverlay = GetPrivateProfileIntA("options", "overlay", 0, p.c_str()) != 0;
    s.overlaySize = GetPrivateProfileIntA("options", "overlaysize", 2, p.c_str());
    if (s.overlaySize < 0 || s.overlaySize > 2) s.overlaySize = 2;
    s.rollDigits  = GetPrivateProfileIntA("options", "roll", 0, p.c_str()) != 0;
    // "transition" superseded the old "crossfade" bool; fall back to it so an
    // existing INI keeps its on/off choice (on -> Crossfade, off -> None).
    const int legacyCf = GetPrivateProfileIntA("options", "crossfade", 1, p.c_str()) != 0 ? 1 : 0;
    s.transition  = GetPrivateProfileIntA("options", "transition", legacyCf, p.c_str());
    if (s.transition < 0 || s.transition > 3) s.transition = 1;
    s.fadeMs      = GetPrivateProfileIntA("options", "fadeMs", 500, p.c_str());
    if (s.fadeMs < 500)  s.fadeMs = 500;
    if (s.fadeMs > 2000) s.fadeMs = 2000;
}
static void saveSettings() {
    const std::string p = iniPath();
    const CoverEngine::Settings& s = eng().settings;
    WritePrivateProfileStringA("options", "overlay", s.showOverlay ? "1" : "0", p.c_str());
    char buf[16];
    wsprintfA(buf, "%d", s.overlaySize); WritePrivateProfileStringA("options", "overlaysize", buf, p.c_str());
    WritePrivateProfileStringA("options", "roll", s.rollDigits ? "1" : "0", p.c_str());
    wsprintfA(buf, "%d", s.transition);  WritePrivateProfileStringA("options", "transition", buf, p.c_str());
    wsprintfA(buf, "%d", s.fadeMs);      WritePrivateProfileStringA("options", "fadeMs", buf, p.c_str());
}

// Plugin entry points (defined below) and the descriptor Winamp fills in.
static int  init();
static void config();
static void quit();
static INT_PTR CALLBACK PrefsPageProc(HWND, UINT, WPARAM, LPARAM);
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

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
        case SSC_WM_NEWCOVER:
            eng().onNewCover(hwnd);
            return 0;
        case WM_TIMER: {
            if (wp != kGateTimer) { eng().onTimer(hwnd, wp); return 0; } // engine repaint heartbeat

            // Gating only. gen_ff owns the frame's geometry AND sizes our child to
            // the content area - we must not touch the child's position/size (doing
            // so paints over the frame's title bar and kills its drag).
            HWND top = g_embedFrame ? g_embedFrame : hwnd;
            const int stationIdx = tunedStationIndex();
            const bool tuned = stationIdx >= 0;

            // Auto-follow: point the engine at whichever family station Winamp is
            // tuned to, so its covers match what's playing (no-op if unchanged).
            if (tuned) eng().setStation(stationIdx);

            // Feed Winamp's current stream title (the ICY metadata it's decoding) to
            // the engine; it advances the cover off genuine title changes, so covers
            // track what Winamp is actually playing rather than the station's live
            // (buffered-ahead) clock. The engine filters placeholders + dedups.
            if (tuned && g_winamp) {
                const int pos = (int)SendMessageA(g_winamp, WM_WA_IPC, 0, IPC_GETLISTPOS);
                const char* t = (const char*)SendMessageA(g_winamp, WM_WA_IPC, pos, IPC_GETPLAYLISTTITLE);
                eng().onTitleChanged(t ? t : "");
            } else {
                eng().resetTitle(); // reset so the next tune-in reloads
            }

            const BOOL visible = IsWindowVisible(top);
            if (tuned && !visible) {
                ShowWindow(top, SW_SHOWNA);
                InvalidateRect(hwnd, nullptr, FALSE);
            } else if (!tuned && visible) {
                ShowWindow(top, SW_HIDE);
            }
            return 0;
        }
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

    g_d2dReady = d2d::init(); // hardware-accelerated render path (Windows 7+)

    WNDCLASSA wc = {};
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
            g_embedState.r.left = 200; g_embedState.r.top = 200;
            g_embedState.r.right = 700; g_embedState.r.bottom = 700;
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

    // Hand the window to the engine and start the cover monitor.
    eng().setLogName("24seven.fm-covers-winamp");
    eng().setWindow(g_hwnd);
    eng().start();

    // Add our options to Winamp's Preferences treeview (Plug-ins section). The page is
    // the shared options dialog and applies live - the prefs tree has no per-page OK
    // (Winamp owns the Close button). Removed in quit(). InitCommonControlsEx registers
    // the trackbar class so the duration slider exists when Winamp builds the page.
    INITCOMMONCONTROLSEX icc = { sizeof(icc), ICC_BAR_CLASSES };
    InitCommonControlsEx(&icc);
    g_prefsRec.hInst = g_hInst;
    g_prefsRec.dlgID = IDD_OPTIONS_PAGE;
    g_prefsRec.proc  = (void*)PrefsPageProc;
    g_prefsRec.name  = (char*)"24seven.fm Covers";
    g_prefsRec.where = 0; // General Preferences section
    if (g_winamp) SendMessageA(g_winamp, WM_WA_IPC, (WPARAM)&g_prefsRec, IPC_ADD_PREFS_DLG);
    return 0;
}

// config() dialog: an About box. The options now live in Winamp's Preferences
// treeview (registered in init()), so double-clicking the plugin - or the
// Configure button - just shows version + a link, nothing to apply here.
static HFONT g_linkFont = nullptr;

static INT_PTR CALLBACK ConfigDlgProc(HWND dlg, UINT msg, WPARAM wp, LPARAM lp) {
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
            if (LOWORD(wp) == IDOK || LOWORD(wp) == IDCANCEL) {
                EndDialog(dlg, LOWORD(wp));
                return TRUE;
            }
            break;
        case WM_DESTROY:
            if (g_linkFont) { DeleteObject(g_linkFont); g_linkFont = nullptr; }
            break;
    }
    return FALSE;
}

// Winamp Preferences-tree page: the shared options page, hosted by Winamp in the
// prefs content pane. The tree has no per-page OK button, so it applies live -
// every control change is read into engine.settings, persisted, and repainted
// (the same live-preview model the desktop viewer's Apply uses).
static INT_PTR CALLBACK PrefsPageProc(HWND dlg, UINT msg, WPARAM wp, LPARAM) {
    auto commit = [&]() {
        optpanel::read(dlg, eng().settings);
        saveSettings();
        if (g_hwnd) InvalidateRect(g_hwnd, nullptr, FALSE);
    };
    switch (msg) {
        case WM_INITDIALOG:
            optpanel::init(dlg, eng().settings);
            return TRUE;
        case WM_HSCROLL: // duration slider dragged
            optpanel::onHScroll(dlg);
            commit();
            return TRUE;
        case WM_COMMAND: {
            const WORD id = LOWORD(wp), code = HIWORD(wp);
            if (id == IDC_OPT_OVERLAY || (id == IDC_OPT_TRANS && code == CBN_SELCHANGE))
                optpanel::updateEnabled(dlg);
            if (id == IDC_OPT_OVERLAY || id == IDC_OPT_ROLL ||
                ((id == IDC_OPT_SIZE || id == IDC_OPT_TRANS) && code == CBN_SELCHANGE))
                commit();
            return TRUE;
        }
    }
    return FALSE;
}

static void config() {
    // About box only - the options are in Winamp's Preferences tree (see init()).
    DialogBoxParamA(g_hInst, MAKEINTRESOURCEA(IDD_CONFIG), g_winamp, ConfigDlgProc, 0);
}

static void quit() {
    if (g_winamp) SendMessageA(g_winamp, WM_WA_IPC, (WPARAM)&g_prefsRec, IPC_REMOVE_PREFS_DLG);
    eng().stop();
    eng().setWindow(nullptr); // also kills the engine's repaint heartbeat
    if (g_hwnd) KillTimer(g_hwnd, kGateTimer);
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
