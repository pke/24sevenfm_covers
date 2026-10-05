#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include <atlbase.h>
#include <atlapp.h>
#include <atlwin.h>
#include <atlcrack.h>
#include "../../foobar2000/foo_24sevenfm_covers/preferences_click_map.h"
#include "../../shared/child_fade.cpp"
#include "../../shared/options_panel.cpp"
#include "../../winamp/gen_resource.h"
#include "../../shared/about_links.h"
#include "../../shared/config.h"
#include "../../desktop/windows_theme.cpp"
#include "../../shared/station_logos.h"
#include <map>

TEST_CASE("verification dates preserve UTC days and reject invalid persisted timestamps") {
    CHECK(optpanel::verificationDate(0).empty());
    CHECK(optpanel::verificationDate(1) == "1970-01-01");
    CHECK(optpanel::verificationDate(1709251199999ULL) == "2024-02-29");
    CHECK(optpanel::verificationDate(1709251200000ULL) == "2024-03-01");
    CHECK(optpanel::verificationDate(32535215999999ULL) == "3000-12-31");
    CHECK(optpanel::verificationDate(32535216000000ULL).empty());
    CHECK(optpanel::verificationDate(~0ULL).empty());
}

namespace {
struct Dialogs {
    HWND parent = nullptr, options = nullptr, about = nullptr;
    unsigned clicks = 0;
    SscPreferencesClickMap clickMap;
    Dialogs() : clickMap([this](int id) {
        ++clicks;
        optpanel::onCommand(options, id);
    }) {
        INITCOMMONCONTROLSEX controls = {sizeof(controls), ICC_LISTVIEW_CLASSES | ICC_BAR_CLASSES | ICC_TAB_CLASSES};
        InitCommonControlsEx(&controls);
        // Only our own off-screen test windows; no active user app is touched.
        parent = CreateWindowExW(WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, L"STATIC", L"Native dialog test",
            WS_POPUP | WS_VISIBLE, -32000, -32000, 600, 800, nullptr, nullptr, nullptr, nullptr);
        options = CreateDialogParamW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(IDD_OPTIONS_PAGE),
                                     parent, proc, reinterpret_cast<LPARAM>(this));
        about = CreateDialogW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(IDD_TAB_ABOUT), parent, nullptr);
        RECT r = {}; GetClientRect(options, &r);
        SetWindowPos(about, nullptr, 0, 0, r.right, r.bottom, SWP_NOZORDER | SWP_NOACTIVATE);
        CoverEngine::Settings settings; settings.backdrops = true; settings.ratings = true;
        optpanel::init(options, settings);
        ShowWindow(options, SW_SHOWNA);
    }
    ~Dialogs() { if (parent) DestroyWindow(parent); }
    static INT_PTR CALLBACK proc(HWND dlg, UINT msg, WPARAM wp, LPARAM lp) {
        if (msg == WM_INITDIALOG) SetWindowLongPtrW(dlg, DWLP_USER, lp);
        auto* self = reinterpret_cast<Dialogs*>(GetWindowLongPtrW(dlg, DWLP_USER));
        if (!self) return FALSE;
        LRESULT result = 0;
        if (self->clickMap.ProcessWindowMessage(dlg, msg, wp, lp, result)) return TRUE;
        if (msg == WM_NOTIFY) optpanel::onNotify(dlg, reinterpret_cast<NMHDR*>(lp));
        return FALSE;
    }
    void select(int row) {
        HWND list = GetDlgItem(options, IDC_OPT_PROVIDERS);
        ListView_SetItemState(list, -1, 0, LVIS_SELECTED | LVIS_FOCUSED);
        ListView_SetItemState(list, row, LVIS_SELECTED | LVIS_FOCUSED, LVIS_SELECTED | LVIS_FOCUSED);
    }
    std::string providers() {
        CoverEngine::Settings values; optpanel::read(options, values); return values.mediaProviders;
    }
};
}

TEST_CASE("coming next is independent of the countdown and persists through the shared schema") {
    Dialogs dialogs;
    CoverEngine::Settings settings;
    REQUIRE_FALSE(settings.comingNext);
    optpanel::setValues(dialogs.options, settings);
    CHECK(IsWindowEnabled(GetDlgItem(dialogs.options, IDC_OPT_COMINGNEXT)));
    CHECK(IsDlgButtonChecked(dialogs.options, IDC_OPT_COMINGNEXT) == BST_UNCHECKED);
    const unsigned clicks = dialogs.clicks;
    SendDlgItemMessageW(dialogs.options, IDC_OPT_COMINGNEXT, BM_CLICK, 0, 0);
    CHECK(dialogs.clicks == clicks + 1); // real foobar WTL routing
    optpanel::read(dialogs.options, settings);
    CHECK(settings.comingNext);
    CHECK_FALSE(settings.showRemaining);
    CHECK_FALSE(settings.backdrops);

    struct Store : ssccfg::ConfigStore {
        std::map<std::string, int> values;
        int readInt(const char* key, int fallback) override {
            auto item = values.find(key); return item == values.end() ? fallback : item->second;
        }
        void writeInt(const char* key, int value) override { values[key] = value; }
        std::string readStr(const char*, const char* fallback) override { return fallback; }
        void writeStr(const char*, const char*) override {}
    } store;
    CoverEngine::Settings loaded;
    ssccfg::load(loaded, store);
    CHECK_FALSE(loaded.comingNext); // existing INIs have no key
    ssccfg::save(settings, store);
    ssccfg::load(loaded, store);
    CHECK(loaded.comingNext);
    optpanel::setValues(dialogs.options, loaded);
    CHECK(IsDlgButtonChecked(dialogs.options, IDC_OPT_COMINGNEXT) == BST_CHECKED);
    SendDlgItemMessageW(dialogs.options, IDC_OPT_COMINGNEXT, BM_CLICK, 0, 0);
    optpanel::read(dialogs.options, loaded);
    ssccfg::save(loaded, store);
    ssccfg::load(settings, store);
    CHECK_FALSE(settings.comingNext);
}

TEST_CASE("native title-logo option defaults off and follows the backdrop dependency") {
    Dialogs dialogs;
    CoverEngine::Settings settings;
    CHECK_FALSE(settings.titleLogos);
    settings.backdrops = true;
    optpanel::setValues(dialogs.options, settings);
    CHECK(IsDlgButtonChecked(dialogs.options, IDC_OPT_TITLELOGOS) == BST_UNCHECKED);
    SendDlgItemMessageW(dialogs.options, IDC_OPT_TITLELOGOS, BM_CLICK, 0, 0);
    optpanel::read(dialogs.options, settings);
    CHECK(settings.titleLogos);
    SendDlgItemMessageW(dialogs.options, IDC_OPT_BACKDROPS, BM_CLICK, 0, 0);
    CHECK_FALSE(IsWindowEnabled(GetDlgItem(dialogs.options, IDC_OPT_TITLELOGOS)));
    optpanel::read(dialogs.options, settings);
    CHECK(settings.titleLogos); // parent switch retains the preference
}

TEST_CASE("desktop disabled provider list retains the dark surface when backdrops are switched off") {
    Dialogs dialogs;
    HWND list = GetDlgItem(dialogs.options, IDC_OPT_PROVIDERS);
    const bool previous = dvtheme::g_dark;
    dvtheme::g_dark = true; // deterministic without changing the user's system theme
    dvtheme::themeControl(list);
    RECT rect{}; GetClientRect(list, &rect);
    HDC screen = GetDC(list), dc = CreateCompatibleDC(screen);
    HBITMAP bitmap = CreateCompatibleBitmap(screen, rect.right, rect.bottom);
    HGDIOBJ oldBitmap = SelectObject(dc, bitmap);
    for (bool enabled : {false, true, false}) {
        EnableWindow(list, enabled);
        SendMessageW(list, WM_PRINT, reinterpret_cast<WPARAM>(dc), PRF_CLIENT | PRF_ERASEBKGND);
        CHECK(GetPixel(dc, rect.right - 8, rect.bottom - 8) == dvtheme::kDarkControl);
        RECT row{}; ListView_GetItemRect(list, 0, &row, LVIR_BOUNDS);
        if (!enabled) {
            CHECK(GetPixel(dc, rect.right - 8, (row.top + row.bottom) / 2) == dvtheme::kDarkControl);
            unsigned mutedPixels = 0;
            for (int y = row.top; y < row.bottom; ++y)
                for (int x = row.left; x < (std::min)(row.right, rect.right); ++x)
                    if (GetPixel(dc, x, y) == dvtheme::kDarkDisabledText) ++mutedPixels;
            CHECK(mutedPixels > 10); // text and checked glyph remain legible
        }
        CHECK(!!IsWindowEnabled(list) == enabled);
        CHECK(ListView_GetCheckState(list, 0));
        CHECK(ListView_GetItemCount(list) == 4);
    }
    SelectObject(dc, oldBitmap); DeleteObject(bitmap); DeleteDC(dc); ReleaseDC(list, screen);
    dvtheme::g_dark = false; // light/high-contrast paths return to native painting
    dvtheme::themeControl(list);
    DWORD_PTR data = 0;
    CHECK_FALSE(GetWindowSubclass(list, dvtheme::listSubclassProc, dvtheme::kListSubclass, &data));
    CHECK(ListView_GetBkColor(list) == CLR_DEFAULT);
    dvtheme::g_dark = previous;
}

TEST_CASE("station selection uses system highlight colours in light and dark settings") {
    Dialogs dialogs;
    HWND radio = CreateWindowExW(0, L"BUTTON", L"Station", WS_CHILD | BS_AUTORADIOBUTTON,
        0, 0, 240, 28, dialogs.parent, nullptr, GetModuleHandleW(nullptr), nullptr);
    REQUIRE(radio != nullptr);
    dvtheme::highlightSelection(radio);
    HDC screen = GetDC(radio), dc = CreateCompatibleDC(screen);
    HBITMAP bitmap = CreateCompatibleBitmap(screen, 240, 28);
    HGDIOBJ old = SelectObject(dc, bitmap);
    const bool previous = dvtheme::g_dark;
    for (bool dark : {false, true}) {
        dvtheme::g_dark = dark; dvtheme::themeControl(radio);
        for (int checked : {BST_CHECKED, BST_UNCHECKED}) {
            SendMessageW(radio, BM_SETCHECK, checked, 0);
            REQUIRE(dvtheme::selection(radio) != nullptr);
            dvtheme::selection(radio)->started = GetTickCount() - 300;
            SendMessageW(radio, WM_PRINTCLIENT, reinterpret_cast<WPARAM>(dc), PRF_CLIENT);
            CHECK(GetPixel(dc, 230, 14) == (checked == BST_CHECKED ? GetSysColor(COLOR_HIGHLIGHT)
                : dark ? dvtheme::kDarkBackground : GetSysColor(COLOR_BTNFACE)));
            CHECK(SendMessageW(radio, BM_GETCHECK, 0, 0) == checked);
        }
    }
    dvtheme::g_dark = previous;
    SelectObject(dc, old); DeleteObject(bitmap); DeleteDC(dc); ReleaseDC(radio, screen); DestroyWindow(radio);
}
TEST_CASE("station buttons decode all bundled logos and keep a padded background") {
    Dialogs dialogs;
    HWND radio = CreateWindowExW(0, L"BUTTON", L"Station", WS_CHILD | BS_AUTORADIOBUTTON,
        0, 0, 300, 64, dialogs.parent, nullptr, GetModuleHandleW(nullptr), nullptr);
    REQUIRE(radio != nullptr);
    HDC screen = GetDC(radio), dc = CreateCompatibleDC(screen);
    HBITMAP bitmap = CreateCompatibleBitmap(screen, 300, 64);
    HGDIOBJ old = SelectObject(dc, bitmap);
    for (int index = 0; index < 5; ++index) {
        CAPTURE(index);
        REQUIRE(dvtheme::setStationLogo(radio, GetModuleHandleW(nullptr), IDR_STATION_LOGO_FIRST + index));
        SendMessageW(radio, BM_SETCHECK, BST_CHECKED, 0);
        dvtheme::selection(radio)->started = GetTickCount() - 300;
        SendMessageW(radio, WM_PRINTCLIENT, reinterpret_cast<WPARAM>(dc), PRF_CLIENT);
        CHECK(GetPixel(dc, 2, 32) == GetSysColor(COLOR_HIGHLIGHT));
        CHECK(dvtheme::selection(radio)->logoWidth == 200);
        CHECK(dvtheme::selection(radio)->logoHeight == 200);
        CHECK(SendMessageW(radio, BM_GETCHECK, 0, 0) == BST_CHECKED);
    }
    SelectObject(dc, old); DeleteObject(bitmap); DeleteDC(dc); ReleaseDC(radio, screen); DestroyWindow(radio);
}

TEST_CASE("station logo downscaling preserves fine lines and transparent coverage") {
    bool transparent = false;
    SUBCASE("opaque fine lettering") {}
    SUBCASE("transparent fine lettering") { transparent = true; }
    Dialogs dialogs;
    HWND radio = CreateWindowExW(0, L"BUTTON", L"Station", WS_CHILD | BS_AUTORADIOBUTTON,
        0, 0, 300, 64, dialogs.parent, nullptr, GetModuleHandleW(nullptr), nullptr);
    REQUIRE(radio != nullptr);
    dvtheme::highlightSelection(radio);
    auto* station = dvtheme::selection(radio);
    REQUIRE(station != nullptr);
    BITMAPINFO info = {}; info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info.bmiHeader.biWidth = 112; info.bmiHeader.biHeight = -112;
    info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
    DWORD* pixels = nullptr;
    station->logo = CreateDIBSection(nullptr, &info, DIB_RGB_COLORS,
        reinterpret_cast<void**>(&pixels), nullptr, 0);
    REQUIRE(station->logo != nullptr);
    station->logoWidth = station->logoHeight = 112;
    // One-pixel strokes must cover half a pixel after the 2:1 reduction,
    // rather than disappearing or becoming solid white through point sampling.
    for (int y = 0; y < 112; ++y)
        for (int x = 0; x < 112; ++x)
            pixels[y * 112 + x] = x % 2 ? 0xffffffff : transparent ? 0 : 0xff000000;
    SendMessageW(radio, BM_SETCHECK, BST_CHECKED, 0);
    station->started = GetTickCount() - 300;
    HDC screen = GetDC(radio), dc = CreateCompatibleDC(screen);
    HBITMAP bitmap = CreateCompatibleBitmap(screen, 300, 64);
    HGDIOBJ old = SelectObject(dc, bitmap);
    SendMessageW(radio, WM_PRINTCLIENT, reinterpret_cast<WPARAM>(dc), PRF_CLIENT);
    const COLORREF background = GetSysColor(COLOR_HIGHLIGHT);
    for (int x : {24, 33, 47, 61}) {
        CAPTURE(transparent);
        CAPTURE(x);
        const COLORREF rendered = GetPixel(dc, x, 32);
        const int expectedR = transparent ? 128 + GetRValue(background) * 127 / 255 : 128;
        const int expectedG = transparent ? 128 + GetGValue(background) * 127 / 255 : 128;
        const int expectedB = transparent ? 128 + GetBValue(background) * 127 / 255 : 128;
        CHECK(std::abs(GetRValue(rendered) - expectedR) <= 2);
        CHECK(std::abs(GetGValue(rendered) - expectedG) <= 2);
        CHECK(std::abs(GetBValue(rendered) - expectedB) <= 2);
    }
    SelectObject(dc, old); DeleteObject(bitmap); DeleteDC(dc); ReleaseDC(radio, screen); DestroyWindow(radio);
}

TEST_CASE("native About URLs are rendered as interactive links") {
    Dialogs dialogs;
    REQUIRE(dialogs.about != nullptr);

    CHECK(std::string(ssclinks::aboutUrl(IDC_ABOUT_LINK)) == "https://24seven.fm/");
    CHECK(std::string(ssclinks::aboutUrl(IDC_ABOUT_DUDESOFT)) == SSC_WEB);

    HFONT linkFont = nullptr;
    ssclinks::initAboutLinks(dialogs.about, linkFont);
    REQUIRE(linkFont != nullptr);
    HWND station = GetDlgItem(dialogs.about, IDC_ABOUT_LINK);
    HWND developer = GetDlgItem(dialogs.about, IDC_ABOUT_DUDESOFT);
    REQUIRE(station != nullptr);
    REQUIRE(developer != nullptr);
    CHECK(ssclinks::isAboutLink(dialogs.about, station));
    CHECK(ssclinks::isAboutLink(dialogs.about, developer));
    CHECK((GetWindowLongPtrA(station, GWL_STYLE) & SS_NOTIFY) != 0);
    CHECK((GetWindowLongPtrA(developer, GWL_STYLE) & SS_NOTIFY) != 0);

    char copyright[256] = {};
    GetWindowTextA(developer, copyright, static_cast<int>(sizeof(copyright)));
    CHECK(std::string(copyright) == SSC_COPYRIGHT);
    LOGFONTA font = {};
    REQUIRE(GetObjectA(linkFont, sizeof(font), &font));
    CHECK(font.lfUnderline == TRUE);
    DeleteObject(linkFont);
}

TEST_CASE("foobar WTL clicks forward provider button IDs and enforce a rating country") {
    Dialogs d;
    REQUIRE(d.options != nullptr);
    REQUIRE(d.about != nullptr);
    d.select(1);
    SendDlgItemMessageW(d.options, IDC_OPT_PROVIDER_UP, BM_CLICK, 0, 0);
    CHECK(d.providers() == "tmdb,fanart,tvmaze,steamgriddb");
    SendDlgItemMessageW(d.options, IDC_OPT_PROVIDER_DOWN, BM_CLICK, 0, 0);
    CHECK(d.providers() == "fanart,tmdb,tvmaze,steamgriddb");
    SendDlgItemMessageW(d.options, IDC_OPT_RATING_DE, BM_CLICK, 0, 0);
    CHECK(IsDlgButtonChecked(d.options, IDC_OPT_RATING_DE) == BST_UNCHECKED);
    SendDlgItemMessageW(d.options, IDC_OPT_RATING_US, BM_CLICK, 0, 0);
    CHECK(IsDlgButtonChecked(d.options, IDC_OPT_RATING_DE) == BST_CHECKED);
    CHECK(IsDlgButtonChecked(d.options, IDC_OPT_RATING_US) == BST_UNCHECKED);
    const unsigned before = d.clicks;
    SendMessageW(d.options, WM_COMMAND, MAKEWPARAM(IDC_OPT_FANART_KEY, EN_CHANGE), 0);
    CHECK(d.clicks == before);
}

TEST_CASE("native provider selections keep details and the personal key controls reachable") {
    Dialogs d;
    REQUIRE(d.options != nullptr);
    HWND details = GetDlgItem(d.options, IDC_OPT_PROVIDER_DETAILS);
    REQUIRE(details != nullptr);
    for (int row : {1, 2, 3, 0}) {
        d.select(row);
        CHECK(IsWindowVisible(details));
        char link[160] = {};
        GetDlgItemTextA(details, IDC_OPT_PROVIDER_LINK, link, sizeof(link));
        CHECK(std::string(link) == optpanel::kProviderLinks[row]);
        CHECK(!!IsWindowVisible(GetDlgItem(details, IDC_OPT_FANART_KEY)) == (row == 0));
    }
    SetDlgItemTextA(details, IDC_OPT_FANART_KEY, "0123456789abcdef0123456789abcdef");
    d.select(1); d.select(0);
    CoverEngine::Settings settings; optpanel::read(d.options, settings);
    CHECK(settings.fanartClientKey == "0123456789abcdef0123456789abcdef");

    d.select(1);
    CHECK(IsWindowVisible(details));
    CHECK(GetPropW(d.options, childfade::kSurface) == nullptr);
    char link[160] = {};
    GetDlgItemTextA(details, IDC_OPT_PROVIDER_LINK, link, sizeof(link));
    CHECK(std::string(link) == optpanel::kProviderLinks[1]);
}

TEST_CASE("native child pages crossfade with repaint clipping and clean up on rapid switches") {
    Dialogs d;
    REQUIRE(d.options != nullptr);
    REQUIRE(d.about != nullptr);
    const bool animated = childfade::replace(d.options, d.about);
    CHECK(IsWindowVisible(d.about));
    CHECK_FALSE(IsWindowVisible(d.options));
    if (childfade::animationsEnabled()) {
        REQUIRE(animated);
        HWND surface = reinterpret_cast<HWND>(GetPropW(d.parent, childfade::kSurface));
        REQUIRE(IsWindow(surface));
        CHECK((GetWindowLongPtrW(d.about, GWL_STYLE) & WS_CLIPSIBLINGS) != 0);
        RedrawWindow(d.about, nullptr, nullptr, RDW_INVALIDATE | RDW_ALLCHILDREN | RDW_UPDATENOW);
        CHECK(GetWindow(surface, GW_HWNDPREV) == nullptr); // still topmost sibling
        childfade::replace(d.about, d.options);
        CHECK_FALSE(IsWindow(surface));
        surface = reinterpret_cast<HWND>(GetPropW(d.parent, childfade::kSurface));
        REQUIRE(IsWindow(surface));
        DWORD_PTR ref = 0;
        REQUIRE(GetWindowSubclass(surface, childfade::surfaceProc, 1, &ref));
        auto* fade = reinterpret_cast<childfade::Fade*>(ref);
        fade->start = GetTickCount() - childfade::kDuration;
        SendMessageW(surface, WM_TIMER, childfade::kTimer, 0);
        CHECK_FALSE(IsWindow(surface));
        CHECK(GetPropW(d.parent, childfade::kSurface) == nullptr);
        CHECK(IsWindowVisible(d.options));
        childfade::replace(d.options, d.about);
        surface = reinterpret_cast<HWND>(GetPropW(d.parent, childfade::kSurface));
        DestroyWindow(d.parent); d.parent = nullptr;
        CHECK_FALSE(IsWindow(surface));
    } else CHECK_FALSE(animated);
}

TEST_CASE("native child fade uses real interpolated opacity and keeps outgoing pixels") {
    Dialogs d;
    childfade::Fade fade;
    childfade::Bitmap output;
    REQUIRE(fade.from.init(d.parent, 2, 2));
    REQUIRE(fade.to.init(d.parent, 2, 2));
    REQUIRE(fade.frame.init(d.parent, 2, 2));
    REQUIRE(output.init(d.parent, 2, 2));
    SetPixel(fade.from.dc, 0, 0, RGB(255, 0, 0));
    SetPixel(fade.to.dc, 0, 0, RGB(0, 0, 255));
    REQUIRE(fade.paint(output.dc));
    CHECK(GetPixel(output.dc, 0, 0) == RGB(255, 0, 0));
    fade.ready = true; fade.start = GetTickCount() - childfade::kDuration / 2;
    REQUIRE(fade.paint(output.dc));
    const COLORREF middle = GetPixel(output.dc, 0, 0);
    CHECK(GetRValue(middle) > 70);
    CHECK(GetBValue(middle) > 70);
    fade.start = GetTickCount() - childfade::kDuration;
    REQUIRE(fade.paint(output.dc));
    CHECK(GetPixel(output.dc, 0, 0) == RGB(0, 0, 255));
}

TEST_CASE("native child fade reduced motion and geometry fallback always reveal the target") {
    Dialogs d;
    REQUIRE(d.options != nullptr);
    CHECK_FALSE(childfade::replace(d.options, d.about, false));
    CHECK(IsWindowVisible(d.about));
    CHECK_FALSE(IsWindowVisible(d.options));
    CHECK(GetPropW(d.parent, childfade::kSurface) == nullptr);
    SetWindowPos(d.options, nullptr, 1, 1, 20, 20, SWP_NOZORDER | SWP_NOACTIVATE);
    CHECK_FALSE(childfade::replace(d.about, d.options));
    CHECK(IsWindowVisible(d.options));
    CHECK_FALSE(IsWindowVisible(d.about));
}
