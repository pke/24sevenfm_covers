#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include "taskbar_preview.h"
#include <vector>
#include <string>

namespace {
struct Shell : ITaskbarList3 {
    ULONG refs = 1;
    int creations = 0, registrations = 0, removals = 0;
    HWND source = nullptr, host = nullptr, active = nullptr;
    bool failCreate = false, failInit = false, failRegister = false, failOrder = false;
    std::vector<std::string> events;
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, void**) override { return E_NOINTERFACE; }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
    ULONG STDMETHODCALLTYPE Release() override { return --refs; }
    HRESULT STDMETHODCALLTYPE HrInit() override { return failInit ? E_FAIL : S_OK; }
    HRESULT STDMETHODCALLTYPE AddTab(HWND) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE DeleteTab(HWND) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE ActivateTab(HWND) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE SetActiveAlt(HWND) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE MarkFullscreenWindow(HWND, BOOL) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE SetProgressValue(HWND, ULONGLONG, ULONGLONG) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE SetProgressState(HWND, TBPFLAG) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE RegisterTab(HWND tab, HWND owner) override {
        ++registrations;
        events.push_back("register");
        if (failRegister) return E_FAIL;
        source = tab; host = owner;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE UnregisterTab(HWND tab) override {
        ++removals;
        CHECK(IsWindow(tab)); // never hand the shell a destroyed popup
        CHECK(tab == source);
        source = active = nullptr;
        events.push_back("unregister");
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE SetTabOrder(HWND tab, HWND before) override {
        CHECK(tab == source);
        CHECK(before == nullptr);
        events.push_back("order");
        return failOrder ? E_FAIL : S_OK;
    }
    HRESULT STDMETHODCALLTYPE SetTabActive(HWND tab, HWND owner, DWORD) override {
        CHECK(tab == source);
        CHECK(owner == host);
        active = tab;
        events.push_back("active");
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE ThumbBarAddButtons(HWND, UINT, LPTHUMBBUTTON) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE ThumbBarUpdateButtons(HWND, UINT, LPTHUMBBUTTON) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE ThumbBarSetImageList(HWND, HIMAGELIST) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE SetOverlayIcon(HWND, HICON, LPCWSTR) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE SetThumbnailTooltip(HWND, LPCWSTR) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE SetThumbnailClip(HWND, RECT*) override { return E_NOTIMPL; }
};
Shell* current = nullptr;
HRESULT createShell(ITaskbarList3** out) {
    ++current->creations;
    if (current->failCreate) return E_FAIL;
    *out = current; current->AddRef();
    return S_OK;
}

struct Fixture {
    Shell shell;
    dv::TaskbarPreview preview{createShell};
    HWND host = nullptr, fullscreen = nullptr;
    Fixture() {
        current = &shell;
        INITCOMMONCONTROLSEX controls = { sizeof(controls), ICC_STANDARD_CLASSES };
        InitCommonControlsEx(&controls);
        host = CreateWindowExW(0, L"STATIC", L"24seven.fm Covers", WS_OVERLAPPEDWINDOW,
            0, 0, 600, 900, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
        fullscreen = CreateWindowExW(WS_EX_TOOLWINDOW, L"STATIC", L"", WS_POPUP,
            0, 0, 1920, 1080, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
        REQUIRE(host != nullptr);
        REQUIRE(fullscreen != nullptr);
        SendMessageW(host, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(LoadIcon(nullptr, IDI_APPLICATION)));
        preview.attach(host);
    }
    ~Fixture() {
        preview.detach();
        DestroyWindow(fullscreen);
        DestroyWindow(host);
        CHECK(shell.refs == 1);
        current = nullptr;
    }
    void ready() { REQUIRE(preview.onMessage(dv::TaskbarPreview::buttonCreatedMessage())); }
};
}

TEST_CASE("DV fullscreen preview follows the active surface and restores the host on destruction") {
    Fixture test;
    CHECK_FALSE(test.preview.onMessage(WM_PAINT));
    test.preview.setFullscreen(test.fullscreen);
    CHECK(test.shell.registrations == 0); // no shell calls before TaskbarButtonCreated
    test.ready();
    CHECK(test.shell.source == test.fullscreen);
    CHECK(test.shell.host == test.host);
    CHECK(test.shell.active == test.fullscreen);
    CHECK(test.shell.events == std::vector<std::string>{"register", "order", "active"});
    wchar_t title[64] = {};
    GetWindowTextW(test.fullscreen, title, 64);
    CHECK(std::wstring(title) == L"24seven.fm Covers");
    CHECK(SendMessageW(test.fullscreen, WM_GETICON, ICON_SMALL, 0)
        == SendMessageW(test.host, WM_GETICON, ICON_SMALL, 0));
    test.preview.setFullscreen(test.fullscreen);
    CHECK(test.shell.registrations == 1);
    // Real subclass lifecycle, as used by Esc/double-click/menu/WM_CLOSE.
    DestroyWindow(test.fullscreen);
    test.fullscreen = nullptr;
    CHECK(test.shell.source == nullptr);
    CHECK(test.shell.removals == 1);
    test.preview.setFullscreen(nullptr);
    CHECK(test.shell.removals == 1);
}

TEST_CASE("DV preview handles rapid replacement and Explorer recreation") {
    Fixture test;
    test.ready();
    CHECK(test.shell.creations == 0); // normal window uses the automatic preview
    test.preview.setFullscreen(test.fullscreen);
    test.preview.setFullscreen(nullptr);
    test.preview.setFullscreen(test.fullscreen);
    CHECK(test.shell.registrations == 2);
    CHECK(test.shell.removals == 1);
    test.shell.source = test.shell.active = nullptr; // Explorer lost its registration
    test.ready();
    CHECK(test.shell.creations == 2);
    CHECK(test.shell.source == test.fullscreen);
    CHECK(test.shell.active == test.fullscreen);
    CHECK(test.shell.refs == 2);
    test.preview.detach();
    CHECK(test.shell.source == nullptr);
    CHECK(test.shell.refs == 1);
    DestroyWindow(test.fullscreen); // detached subclass must no longer call the shell
    test.fullscreen = nullptr;
    CHECK(test.shell.removals == 2);
}

TEST_CASE("DV shell failures keep the normal preview and retry on activation") {
    Fixture test;
    SUBCASE("COM creation") { test.shell.failCreate = true; }
    SUBCASE("shell initialization") { test.shell.failInit = true; }
    SUBCASE("registration") { test.shell.failRegister = true; }
    SUBCASE("ordering after registration") { test.shell.failOrder = true; }
    test.ready();
    test.preview.setFullscreen(test.fullscreen);
    CHECK(test.shell.source == nullptr);
    CHECK(test.shell.active == nullptr);
    test.shell.failCreate = test.shell.failInit = test.shell.failRegister = test.shell.failOrder = false;
    SendMessageW(test.fullscreen, WM_ACTIVATE, WA_ACTIVE, 0);
    CHECK(test.shell.source == test.fullscreen);
    CHECK(test.shell.active == test.fullscreen);
}
