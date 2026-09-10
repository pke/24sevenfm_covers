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
