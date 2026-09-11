#include "windows_theme.h"

#include <algorithm>
#include <commctrl.h>
#include <cwchar>
#include <uxtheme.h>
#include <vssym32.h>

#pragma comment(lib, "uxtheme.lib")

namespace dvtheme {
namespace {

// Keep the numeric values local so the viewer can still be built with an older
// Windows SDK. DwmSetWindowAttribute rejects unknown attributes on older Windows.
constexpr DWORD kUseImmersiveDarkModeBefore20H1 = 19;
constexpr DWORD kUseImmersiveDarkMode = 20;
constexpr DWORD kWindowCornerPreference = 33;
constexpr DWORD kSystemBackdropType = 38;
constexpr int kRoundCorners = 2;
constexpr int kMainWindowBackdrop = 2;
constexpr int kTransientWindowBackdrop = 3;
constexpr UINT_PTR kThemeSubclass = 0x24711;
constexpr UINT_PTR kTabSubclass = 0x24712;
constexpr UINT_PTR kButtonSubclass = 0x24713;

// Win32 exposes the user's light/dark choice, but not the immersive dark
// control palette through GetSysColor/GetThemeSysColor. These are the neutral
// Windows dark-dialog surfaces; High Contrast bypasses them entirely below.
constexpr COLORREF kDarkBackground = RGB(32, 32, 32);
constexpr COLORREF kDarkControl = RGB(45, 45, 48);
constexpr COLORREF kDarkBorder = RGB(82, 82, 86);
constexpr COLORREF kDarkText = RGB(240, 240, 240);
constexpr COLORREF kDarkDisabledText = RGB(145, 145, 145);

using DwmSetWindowAttributeFn = HRESULT(WINAPI*)(HWND, DWORD, LPCVOID, DWORD);
using SetWindowThemeFn = HRESULT(WINAPI*)(HWND, LPCWSTR, LPCWSTR);
using AllowDarkModeForWindowFn = bool(WINAPI*)(HWND, bool);
using SetPreferredAppModeFn = int(WINAPI*)(int);
using FlushMenuThemesFn = void(WINAPI*)();
using RegGetValueWFn = LSTATUS(WINAPI*)(HKEY, LPCWSTR, LPCWSTR, DWORD,
                                       LPDWORD, PVOID, LPDWORD);

struct APIs {
    HMODULE dwm = nullptr;
    HMODULE theme = nullptr;
    HMODULE registry = nullptr;
    DwmSetWindowAttributeFn setDwmAttribute = nullptr;
    SetWindowThemeFn setWindowTheme = nullptr;
    AllowDarkModeForWindowFn allowDarkModeForWindow = nullptr;
    SetPreferredAppModeFn setPreferredAppMode = nullptr;
    FlushMenuThemesFn flushMenuThemes = nullptr;
    RegGetValueWFn getRegistryValue = nullptr;

    APIs() {
        dwm = LoadLibraryW(L"dwmapi.dll");
        if (dwm)
            setDwmAttribute = reinterpret_cast<DwmSetWindowAttributeFn>(
                GetProcAddress(dwm, "DwmSetWindowAttribute"));
        theme = LoadLibraryW(L"uxtheme.dll");
        if (theme)
            setWindowTheme = reinterpret_cast<SetWindowThemeFn>(
                GetProcAddress(theme, "SetWindowTheme"));
        if (theme) {
            // Windows 10 1903+ exports these by ordinal. Older builds either do
            // not expose them or accept the same one-integer ABI used by the
            // earlier AllowDarkModeForApp implementation.
            OSVERSIONINFOW version = { sizeof(version) };
            using RtlGetVersionFn = LONG(WINAPI*)(OSVERSIONINFOW*);
            const auto rtlGetVersion = reinterpret_cast<RtlGetVersionFn>(
                GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion"));
            if (rtlGetVersion && rtlGetVersion(&version) == 0
                    && version.dwBuildNumber >= 17763) {
                allowDarkModeForWindow = reinterpret_cast<AllowDarkModeForWindowFn>(
                    GetProcAddress(theme, MAKEINTRESOURCEA(133)));
                setPreferredAppMode = reinterpret_cast<SetPreferredAppModeFn>(
                    GetProcAddress(theme, MAKEINTRESOURCEA(135)));
                flushMenuThemes = reinterpret_cast<FlushMenuThemesFn>(
                    GetProcAddress(theme, MAKEINTRESOURCEA(136)));
            }
        }
        registry = LoadLibraryW(L"advapi32.dll");
        if (registry)
            getRegistryValue = reinterpret_cast<RegGetValueWFn>(
                GetProcAddress(registry, "RegGetValueW"));
    }

    ~APIs() {
        if (registry) FreeLibrary(registry);
        if (theme) FreeLibrary(theme);
        if (dwm) FreeLibrary(dwm);
    }
};

APIs& apis() {
    static APIs instance;
    return instance;
}

bool g_dark = false;
thread_local bool g_applying = false;

bool systemUsesDarkApps() {
    if (!apis().getRegistryValue) return false;
    DWORD light = 1;
    DWORD bytes = sizeof(light);
    const LSTATUS result = apis().getRegistryValue(HKEY_CURRENT_USER,
        L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
        L"AppsUseLightTheme", RRF_RT_REG_DWORD, nullptr, &light, &bytes);
    return result == ERROR_SUCCESS && light == 0;
}

bool highContrastEnabled() {
    HIGHCONTRASTW contrast = { sizeof(contrast) };
    return SystemParametersInfoW(SPI_GETHIGHCONTRAST, sizeof(contrast),
                                 &contrast, 0)
        && (contrast.dwFlags & HCF_HIGHCONTRASTON) != 0;
}

HBRUSH darkBackgroundBrush() {
    static HBRUSH brush = CreateSolidBrush(kDarkBackground);
    return brush;
}

HBRUSH darkControlBrush() {
    static HBRUSH brush = CreateSolidBrush(kDarkControl);
    return brush;
}

HBRUSH darkBorderBrush() {
    static HBRUSH brush = CreateSolidBrush(kDarkBorder);
    return brush;
}

void applyFrame(HWND window, Surface surface) {
    if (!window) return;
    APIs& api = apis();
    if (!api.setDwmAttribute) return;

    const BOOL dark = g_dark ? TRUE : FALSE;
    if (FAILED(api.setDwmAttribute(window, kUseImmersiveDarkMode,
                                   &dark, sizeof(dark))))
        api.setDwmAttribute(window, kUseImmersiveDarkModeBefore20H1,
                            &dark, sizeof(dark));

    const int corners = kRoundCorners;
    api.setDwmAttribute(window, kWindowCornerPreference,
                        &corners, sizeof(corners));

    if (surface != Surface::settingsPage) {
        const int backdrop = surface == Surface::mainWindow
            ? kMainWindowBackdrop : kTransientWindowBackdrop;
        api.setDwmAttribute(window, kSystemBackdropType,
                            &backdrop, sizeof(backdrop));
    }
}

LRESULT CALLBACK themeSubclassProc(HWND window, UINT message, WPARAM wp, LPARAM lp,
                                   UINT_PTR id, DWORD_PTR data);
LRESULT CALLBACK tabSubclassProc(HWND window, UINT message, WPARAM wp, LPARAM lp,
                                 UINT_PTR id, DWORD_PTR data);
LRESULT CALLBACK buttonSubclassProc(HWND window, UINT message, WPARAM wp, LPARAM lp,
                                    UINT_PTR id, DWORD_PTR data);

bool classIs(HWND window, const wchar_t* expected) {
    wchar_t actual[64] = {};
    return GetClassNameW(window, actual, ARRAYSIZE(actual))
        && _wcsicmp(actual, expected) == 0;
}

void paintDarkTabs(HWND tabs, HDC target) {
    RECT client = {};
    GetClientRect(tabs, &client);
    FillRect(target, &client, darkBackgroundBrush());

    const int count = TabCtrl_GetItemCount(tabs);
    const int selected = TabCtrl_GetCurSel(tabs);
    HFONT font = reinterpret_cast<HFONT>(SendMessageW(tabs, WM_GETFONT, 0, 0));
    if (!font) font = reinterpret_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
    const HGDIOBJ oldFont = SelectObject(target, font);
    const int oldBkMode = SetBkMode(target, TRANSPARENT);
    const COLORREF oldText = SetTextColor(target,
        IsWindowEnabled(tabs) ? kDarkText : kDarkDisabledText);

    HPEN border = CreatePen(PS_SOLID, 1, kDarkBorder);
    const HGDIOBJ oldPen = SelectObject(target, border);
    for (int index = 0; index < count; ++index) {
        RECT item = {};
        if (!TabCtrl_GetItemRect(tabs, index, &item)) continue;
        const bool active = index == selected;
        FillRect(target, &item, active ? darkBackgroundBrush() : darkControlBrush());
        MoveToEx(target, item.left, item.bottom - 1, nullptr);
        LineTo(target, item.left, item.top);
        LineTo(target, item.right - 1, item.top);
        LineTo(target, item.right - 1, item.bottom);
        if (!active) {
            MoveToEx(target, item.left, item.bottom - 1, nullptr);
            LineTo(target, item.right, item.bottom - 1);
        }

        wchar_t label[128] = {};
        TCITEMW tab = {};
        tab.mask = TCIF_TEXT;
        tab.pszText = label;
        tab.cchTextMax = ARRAYSIZE(label);
        if (TabCtrl_GetItem(tabs, index, &tab)) {
            RECT text = item;
            DrawTextW(target, label, -1, &text,
                      DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
        }
        if (active && GetFocus() == tabs) {
            RECT focus = item;
            InflateRect(&focus, -3, -3);
            DrawFocusRect(target, &focus);
        }
    }
    RECT pageFrame = client;
    TabCtrl_AdjustRect(tabs, FALSE, &pageFrame);
    InflateRect(&pageFrame, 2, 2);
    RECT activeTab = {};
    const bool haveActiveTab = selected >= 0
        && TabCtrl_GetItemRect(tabs, selected, &activeTab);
    FrameRect(target, &pageFrame, darkBorderBrush());
    if (haveActiveTab) {
        // The selected tab and page are one visual surface. Erase only the
        // interior of the page's top edge; preserving both tab-edge pixels
        // keeps the page side connected when the first tab is selected.
        RECT gap = {
            (std::max)(pageFrame.left + 1, activeTab.left + 1),
            pageFrame.top,
            (std::min)(pageFrame.right - 1, activeTab.right - 1),
            pageFrame.top + 1,
        };
        if (gap.left < gap.right)
            FillRect(target, &gap, darkBackgroundBrush());
    }
    SelectObject(target, oldPen);
    DeleteObject(border);
    SetTextColor(target, oldText);
    SetBkMode(target, oldBkMode);
    SelectObject(target, oldFont);
}

bool customDarkButton(HWND window) {
    if (!classIs(window, WC_BUTTONW)) return false;
    const LONG_PTR type = GetWindowLongPtrW(window, GWL_STYLE) & BS_TYPEMASK;
    return type == BS_GROUPBOX || type == BS_CHECKBOX || type == BS_AUTOCHECKBOX
        || type == BS_RADIOBUTTON || type == BS_AUTORADIOBUTTON
        || type == BS_3STATE || type == BS_AUTO3STATE;
}

void paintDarkGroupBox(HWND window, HDC target, const RECT& client) {
    wchar_t label[256] = {};
    GetWindowTextW(window, label, ARRAYSIZE(label));
    HFONT font = reinterpret_cast<HFONT>(SendMessageW(window, WM_GETFONT, 0, 0));
    if (!font) font = reinterpret_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
    const HGDIOBJ oldFont = SelectObject(target, font);
    const int oldMode = SetBkMode(target, TRANSPARENT);
    const COLORREF oldText = SetTextColor(target,
        IsWindowEnabled(window) ? kDarkText : kDarkDisabledText);

    RECT text = { client.left + 8, client.top, client.right - 8, client.bottom };
    RECT measured = text;
    DrawTextW(target, label, -1, &measured,
              DT_LEFT | DT_SINGLELINE | DT_CALCRECT | DT_HIDEPREFIX);
    const int lineY = client.top + (measured.bottom - measured.top) / 2;
    HPEN border = CreatePen(PS_SOLID, 1, kDarkBorder);
    const HGDIOBJ oldPen = SelectObject(target, border);
    MoveToEx(target, client.left, lineY, nullptr);
    LineTo(target, measured.left - 4, lineY);
    MoveToEx(target, measured.right + 4, lineY, nullptr);
    LineTo(target, client.right - 1, lineY);
    LineTo(target, client.right - 1, client.bottom - 1);
    LineTo(target, client.left, client.bottom - 1);
    LineTo(target, client.left, lineY);
    DrawTextW(target, label, -1, &text,
              DT_LEFT | DT_TOP | DT_SINGLELINE | DT_HIDEPREFIX);

    SelectObject(target, oldPen);
    DeleteObject(border);
    SetTextColor(target, oldText);
    SetBkMode(target, oldMode);
    SelectObject(target, oldFont);
}

void paintDarkCheckOrRadio(HWND window, HDC target, const RECT& client) {
    const LONG_PTR type = GetWindowLongPtrW(window, GWL_STYLE) & BS_TYPEMASK;
    const bool radio = type == BS_RADIOBUTTON || type == BS_AUTORADIOBUTTON;
    const int part = radio ? BP_RADIOBUTTON : BP_CHECKBOX;
    const LRESULT buttonState = SendMessageW(window, BM_GETSTATE, 0, 0);
    const int checkState = static_cast<int>(buttonState & 3);
    const int stateOffset = !IsWindowEnabled(window) ? 3
        : (buttonState & BST_PUSHED) ? 2 : (buttonState & BST_HOT) ? 1 : 0;
    int themeState = 0;
    if (radio)
        themeState = (checkState == BST_CHECKED ? RBS_CHECKEDNORMAL
                                                : RBS_UNCHECKEDNORMAL) + stateOffset;
    else if (checkState == BST_INDETERMINATE)
        themeState = CBS_MIXEDNORMAL + stateOffset;
    else
        themeState = (checkState == BST_CHECKED ? CBS_CHECKEDNORMAL
                                                : CBS_UNCHECKEDNORMAL) + stateOffset;

    SIZE glyph = { 13, 13 };
    HTHEME theme = OpenThemeData(window, L"Button");
    if (theme)
        GetThemePartSize(theme, target, part, themeState, nullptr, TS_TRUE, &glyph);
    RECT glyphRect = { client.left, client.top + (client.bottom - client.top - glyph.cy) / 2,
                       client.left + glyph.cx,
                       client.top + (client.bottom - client.top - glyph.cy) / 2 + glyph.cy };
    if (theme) {
        DrawThemeBackground(theme, target, part, themeState, &glyphRect, nullptr);
        CloseThemeData(theme);
    } else {
        UINT flags = radio ? DFCS_BUTTONRADIO : DFCS_BUTTONCHECK;
        if (checkState != BST_UNCHECKED) flags |= DFCS_CHECKED;
        if (!IsWindowEnabled(window)) flags |= DFCS_INACTIVE;
        if (buttonState & BST_PUSHED) flags |= DFCS_PUSHED;
        DrawFrameControl(target, &glyphRect, DFC_BUTTON, flags);
    }

    wchar_t label[512] = {};
    GetWindowTextW(window, label, ARRAYSIZE(label));
    HFONT font = reinterpret_cast<HFONT>(SendMessageW(window, WM_GETFONT, 0, 0));
    if (!font) font = reinterpret_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
    const HGDIOBJ oldFont = SelectObject(target, font);
    const int oldMode = SetBkMode(target, TRANSPARENT);
    const COLORREF oldText = SetTextColor(target,
        IsWindowEnabled(window) ? kDarkText : kDarkDisabledText);
    RECT text = client;
    text.left = glyphRect.right + 4;
    UINT format = DT_LEFT | DT_VCENTER | DT_SINGLELINE;
    if (SendMessageW(window, WM_QUERYUISTATE, 0, 0) & UISF_HIDEACCEL)
        format |= DT_HIDEPREFIX;
    DrawTextW(target, label, -1, &text, format);
    if ((buttonState & BST_FOCUS)
            && !(SendMessageW(window, WM_QUERYUISTATE, 0, 0) & UISF_HIDEFOCUS)) {
        RECT focus = text;
        DrawTextW(target, label, -1, &focus,
                  DT_LEFT | DT_SINGLELINE | DT_CALCRECT | DT_HIDEPREFIX);
        OffsetRect(&focus, 0, (client.bottom - client.top
                  - (focus.bottom - focus.top)) / 2);
        InflateRect(&focus, 1, 1);
        DrawFocusRect(target, &focus);
    }
    SetTextColor(target, oldText);
    SetBkMode(target, oldMode);
    SelectObject(target, oldFont);
}

void paintDarkButton(HWND window, HDC target) {
    RECT client = {};
    GetClientRect(window, &client);
    FillRect(target, &client, darkBackgroundBrush());
    const LONG_PTR type = GetWindowLongPtrW(window, GWL_STYLE) & BS_TYPEMASK;
    if (type == BS_GROUPBOX) paintDarkGroupBox(window, target, client);
    else paintDarkCheckOrRadio(window, target, client);
}

void themeControl(HWND window) {
    if (!window) return;
    APIs& api = apis();
    if (api.allowDarkModeForWindow)
        api.allowDarkModeForWindow(window, g_dark);
    if (g_dark)
        SetPropW(window, L"UseImmersiveDarkModeColors",
                 reinterpret_cast<HANDLE>(static_cast<INT_PTR>(TRUE)));
    else
        RemovePropW(window, L"UseImmersiveDarkModeColors");

    const bool themedButton = customDarkButton(window);
    if (themedButton) {
        if (g_dark)
            SetWindowSubclass(window, buttonSubclassProc, kButtonSubclass, 0);
        else
            RemoveWindowSubclass(window, buttonSubclassProc, kButtonSubclass);
        if (api.setWindowTheme)
            api.setWindowTheme(window, g_dark ? L"DarkMode_Explorer" : nullptr, nullptr);
    } else if (classIs(window, WC_TABCONTROLW)) {
        if (g_dark)
            SetWindowSubclass(window, tabSubclassProc, kTabSubclass, 0);
        else
            RemoveWindowSubclass(window, tabSubclassProc, kTabSubclass);
        if (api.setWindowTheme)
            api.setWindowTheme(window, g_dark ? L"DarkMode_Explorer" : nullptr, nullptr);
    } else if (api.setWindowTheme) {
        const wchar_t* darkTheme = (classIs(window, WC_EDITW)
                                  || classIs(window, WC_COMBOBOXW))
            ? L"DarkMode_CFD" : L"DarkMode_Explorer";
        api.setWindowTheme(window, g_dark ? darkTheme : nullptr, nullptr);
    }

    if (classIs(window, WC_LISTVIEWW)) {
        ListView_SetBkColor(window, g_dark ? kDarkControl : CLR_DEFAULT);
        ListView_SetTextBkColor(window, g_dark ? kDarkControl : CLR_DEFAULT);
        ListView_SetTextColor(window, g_dark ? kDarkText : CLR_DEFAULT);
    }
    InvalidateRect(window, nullptr, TRUE);
}

BOOL CALLBACK themeChild(HWND child, LPARAM) {
    themeControl(child);
    wchar_t className[32] = {};
    if (GetClassNameW(child, className, ARRAYSIZE(className))
            && lstrcmpW(className, L"#32770") == 0)
        SetWindowSubclass(child, themeSubclassProc, kThemeSubclass,
                          static_cast<DWORD_PTR>(Surface::settingsPage));
    return TRUE;
}

void apply(HWND window, Surface surface) {
    if (g_applying) return;
    struct ApplyingGuard {
        ApplyingGuard() { g_applying = true; }
        ~ApplyingGuard() { g_applying = false; }
    } guard;
    g_dark = apis().allowDarkModeForWindow && !highContrastEnabled()
        && systemUsesDarkApps();
    applyFrame(window, surface);
    if (surface == Surface::mainWindow) return;
    themeControl(window);
    EnumChildWindows(window, themeChild, 0);
    RedrawWindow(window, nullptr, nullptr,
                 RDW_INVALIDATE | RDW_ERASE | RDW_FRAME | RDW_ALLCHILDREN);
}

LRESULT darkControlColour(UINT message, WPARAM wp, LPARAM lp) {
    if (!g_dark) return 0;
    HDC dc = reinterpret_cast<HDC>(wp);
    const HWND control = reinterpret_cast<HWND>(lp);
    SetTextColor(dc, IsWindowEnabled(control)
        ? kDarkText : kDarkDisabledText);
    if (message == WM_CTLCOLORSTATIC) {
        const LONG_PTR style = GetWindowLongPtrW(control, GWL_STYLE);
        if ((style & SS_NOTIFY) != 0)
            SetTextColor(dc, RGB(100, 170, 255));
        SetBkMode(dc, TRANSPARENT);
        return reinterpret_cast<LRESULT>(darkBackgroundBrush());
    }
    if (message == WM_CTLCOLORBTN) {
        const LONG_PTR type = GetWindowLongPtrW(control, GWL_STYLE) & BS_TYPEMASK;
        if (type == BS_GROUPBOX || type == BS_CHECKBOX || type == BS_AUTOCHECKBOX
                || type == BS_RADIOBUTTON || type == BS_AUTORADIOBUTTON
                || type == BS_3STATE || type == BS_AUTO3STATE) {
            SetBkMode(dc, TRANSPARENT);
            return reinterpret_cast<LRESULT>(darkBackgroundBrush());
        }
    }
    SetBkColor(dc, kDarkControl);
    return reinterpret_cast<LRESULT>(darkControlBrush());
}

LRESULT CALLBACK tabSubclassProc(HWND window, UINT message, WPARAM wp, LPARAM lp,
                                 UINT_PTR id, DWORD_PTR) {
    switch (message) {
    case WM_ERASEBKGND:
        if (g_dark) {
            paintDarkTabs(window, reinterpret_cast<HDC>(wp));
            return TRUE;
        }
        break;
    case WM_PAINT:
        if (g_dark) {
            PAINTSTRUCT paint = {};
            HDC dc = BeginPaint(window, &paint);
            paintDarkTabs(window, dc);
            EndPaint(window, &paint);
            return 0;
        }
        break;
    case WM_PRINTCLIENT:
        if (g_dark) {
            paintDarkTabs(window, reinterpret_cast<HDC>(wp));
            return 0;
        }
        break;
    case WM_NCDESTROY:
        RemoveWindowSubclass(window, tabSubclassProc, id);
        break;
    }
    return DefSubclassProc(window, message, wp, lp);
}

LRESULT CALLBACK buttonSubclassProc(HWND window, UINT message, WPARAM wp, LPARAM lp,
                                    UINT_PTR id, DWORD_PTR) {
    switch (message) {
    case WM_ERASEBKGND:
        if (g_dark) {
            RECT client = {};
            GetClientRect(window, &client);
            FillRect(reinterpret_cast<HDC>(wp), &client, darkBackgroundBrush());
            return TRUE;
        }
        break;
    case WM_PAINT:
        if (g_dark) {
            PAINTSTRUCT paint = {};
            HDC dc = BeginPaint(window, &paint);
            paintDarkButton(window, dc);
            EndPaint(window, &paint);
            return 0;
        }
        break;
    case WM_PRINTCLIENT:
        if (g_dark) {
            paintDarkButton(window, reinterpret_cast<HDC>(wp));
            return 0;
        }
        break;
    case WM_SETTEXT:
    case WM_ENABLE:
    case WM_SETFOCUS:
    case WM_KILLFOCUS:
    case WM_UPDATEUISTATE: {
        const LRESULT result = DefSubclassProc(window, message, wp, lp);
        if (g_dark) InvalidateRect(window, nullptr, TRUE);
        return result;
    }
    case WM_NCDESTROY:
        RemoveWindowSubclass(window, buttonSubclassProc, id);
        break;
    }
    return DefSubclassProc(window, message, wp, lp);
}

LRESULT CALLBACK themeSubclassProc(HWND window, UINT message, WPARAM wp, LPARAM lp,
                                   UINT_PTR id, DWORD_PTR data) {
    const Surface surface = static_cast<Surface>(data);
    switch (message) {
    case WM_SETTINGCHANGE:
    case WM_SYSCOLORCHANGE:
    case WM_THEMECHANGED:
        if (!g_applying) {
            if (apis().setPreferredAppMode) apis().setPreferredAppMode(1); // AllowDark
            if (apis().flushMenuThemes) apis().flushMenuThemes();
            apply(window, surface);
        }
        break;
    case WM_ERASEBKGND:
        if (surface != Surface::mainWindow && g_dark) {
            RECT client = {};
            GetClientRect(window, &client);
            FillRect(reinterpret_cast<HDC>(wp), &client, darkBackgroundBrush());
            return TRUE;
        }
        break;
    case WM_PRINTCLIENT:
        if (surface != Surface::mainWindow && g_dark) {
            RECT client = {};
            GetClientRect(window, &client);
            FillRect(reinterpret_cast<HDC>(wp), &client, darkBackgroundBrush());
            return 0;
        }
        break;
    case WM_CTLCOLORDLG:
        if (surface != Surface::mainWindow && g_dark)
            return reinterpret_cast<LRESULT>(darkBackgroundBrush());
        break;
    case WM_CTLCOLORSTATIC:
    case WM_CTLCOLOREDIT:
    case WM_CTLCOLORLISTBOX:
    case WM_CTLCOLORBTN:
    case WM_CTLCOLORSCROLLBAR:
        if (surface != Surface::mainWindow) {
            const LRESULT colour = darkControlColour(message, wp, lp);
            if (colour) return colour;
        }
        break;
    case WM_NCDESTROY:
        RemoveWindowSubclass(window, themeSubclassProc, id);
        break;
    }
    return DefSubclassProc(window, message, wp, lp);
}

} // namespace

void initialize() {
    g_dark = apis().allowDarkModeForWindow && !highContrastEnabled()
        && systemUsesDarkApps();
    // AllowDark follows AppsUseLightTheme; it does not force dark mode when the
    // user selected the light Windows app theme.
    if (apis().setPreferredAppMode) apis().setPreferredAppMode(1);
    if (apis().flushMenuThemes) apis().flushMenuThemes();
}

void install(HWND window, Surface surface) {
    if (!window) return;
    SetWindowSubclass(window, themeSubclassProc, kThemeSubclass,
                      static_cast<DWORD_PTR>(surface));
    apply(window, surface);
}

} // namespace dvtheme
