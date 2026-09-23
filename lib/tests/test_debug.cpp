#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include "../diagnostics.h"
#include "../../shared/debug_overlay.h"

TEST_CASE("debug history is bounded and redacts credentials in nested JSON and URLs") {
    ssc::DiagnosticLog log;
    ssc::HttpResponse response; response.status = 200;
    response.body = R"({"metadata":{"album":"Film"},"client_key":"private-key","nested":{"url":"https://example.test/?api_key=secret&album=Film"}})";
    for (int i = 0; i < 40; ++i)
        log.request("https://example.test/api/media?client_key=private-key&album=Film", response, 12);
    const auto snapshot = log.snapshot();
    CHECK(snapshot.get("requests")->array.size() == 30);
    const auto json = ssc::diagnosticJson(snapshot);
    CHECK(json.find("private-key") == std::string::npos);
    CHECK(json.find("api_key=secret") == std::string::npos);
    CHECK(json.find("Film") != std::string::npos);
    CHECK(json.find("headersMs") != std::string::npos);
    response.body = "not JSON: private-key";
    log.request("https://example.test/api/media?client_key=private-key", response, 1);
    CHECK(ssc::diagnosticJson(log.snapshot()).find("private-key") == std::string::npos);
}

TEST_CASE("native debug overlay toggles, retains outgoing content and dismisses on outside click") {
    HWND parent = CreateWindowExW(0, L"STATIC", L"debug fixture", WS_OVERLAPPEDWINDOW,
        0, 0, 640, 480, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    REQUIRE(parent != nullptr);
    ssc::DebugOverlay overlay;
    overlay.attach(parent, [] { return std::string("{\"album\":\"Debug Album\"}"); });
    SendMessageW(parent, WM_KEYDOWN, 'D', 0);
    REQUIRE(overlay.isOpen());
    REQUIRE(IsWindowVisible(overlay.window()));
    CHECK((GetWindowLongPtrW(overlay.window(), GWL_EXSTYLE) & WS_EX_LAYERED) != 0);
    HWND text = GetDlgItem(overlay.window(), ssc::DebugOverlay::kText);
    REQUIRE(text != nullptr);
    CHECK(GetWindowTextLengthW(text) > 0);
    overlay.advance(GetTickCount() + 180);
    SendMessageW(parent, WM_KEYDOWN, VK_ESCAPE, 0);
    CHECK_FALSE(overlay.isOpen());
    // Force a deterministic animation finish without waiting on the system clock.
    overlay.advance(GetTickCount() + 1000);
    CHECK_FALSE(IsWindowVisible(overlay.window()));
    SendMessageW(parent, WM_KEYDOWN, 'D', 0);
    REQUIRE(overlay.isOpen());
    SendMessageW(parent, WM_LBUTTONDOWN, 0, 0);
    CHECK_FALSE(overlay.isOpen());
    overlay.attach(nullptr, {});
    DestroyWindow(parent);
}

TEST_CASE("native debug freeze retains the displayed snapshot and resumes updates") {
    HWND parent = CreateWindowExW(0, L"STATIC", L"debug fixture", WS_OVERLAPPEDWINDOW,
        0, 0, 640, 480, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    REQUIRE(parent != nullptr);
    std::string value = "{\"album\":\"Before\"}";
    ssc::DebugOverlay overlay; overlay.attach(parent, [&] { return value; });
    SendMessageW(parent, WM_KEYDOWN, 'D', 0);
    REQUIRE(overlay.isOpen());
    HWND text = GetDlgItem(overlay.window(), ssc::DebugOverlay::kText);
    SendMessageW(overlay.window(), WM_COMMAND, ssc::DebugOverlay::kFreeze, 0);
    value = "{\"album\":\"After\"}";
    overlay.advance(GetTickCount() + 1200);
    wchar_t buffer[128] = {}; GetWindowTextW(text, buffer, 128);
    CHECK(std::wstring(buffer).find(L"Before") != std::wstring::npos);
    SendMessageW(overlay.window(), WM_COMMAND, ssc::DebugOverlay::kFreeze, 0);
    GetWindowTextW(text, buffer, 128);
    CHECK(std::wstring(buffer).find(L"After") != std::wstring::npos);
    overlay.attach(nullptr, {}); DestroyWindow(parent);
}
