#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include "../diagnostics.h"
#include "../../shared/debug_overlay.h"
#include "../diagnostic_timeline.h"
#include "../../shared/debug_report.h"

TEST_CASE("native timeline separates history, current and repeated future tracks with unknown ETAs") {
    ssc::DiagnosticTimeline timeline(2);
    ssc::JsonValue a = ssc::diagnosticObject(), b = ssc::diagnosticObject();
    a.object["album"] = ssc::diagnosticString("A"); b.object["album"] = ssc::diagnosticString("B");
    timeline.observe("sst", a, 100000);
    a.object["artist"] = ssc::diagnosticString("Corrected");
    timeline.observe("sst", a, 110000);
    CHECK(timeline.entries({}, 20, 120000).array.size() == 1);
    timeline.observe("sst", b, 120000);
    auto entries = timeline.entries({a, a}, 30, 120000);
    REQUIRE(entries.array.size() == 4);
    CHECK(entries.array[0].get("phase")->string == "past");
    CHECK(entries.array[1].get("phase")->string == "current");
    CHECK(entries.array[2].get("phase")->string == "future");
    CHECK(entries.array[2].get("id")->string != entries.array[3].get("id")->string);
    CHECK(entries.array[0].get("relativeSeconds")->number == -20);
    CHECK(entries.array[2].get("relativeSeconds")->number == 30);
    CHECK(entries.array[3].get("relativeSeconds")->type == ssc::JsonValue::Null);
    timeline.observe("other", a, 130000);
    CHECK(timeline.entries({}, 20, 130000).array.size() == 1);
}

TEST_CASE("native report presents labelled fields rather than raw JSON") {
    ssc::JsonValue snapshot;
    REQUIRE(ssc::parseJson(R"({"track":{"album":"Film","track":"Cue"},"display":{"width":900},"requests":[{"status":200,"totalMs":12.5}]})", snapshot));
    const auto report = ssc::debugReport(snapshot);
    CHECK(report.find("Selected track") != std::string::npos);
    CHECK(report.find("Album") != std::string::npos);
    CHECK(report.find("Film") != std::string::npos);
    CHECK(report.find("12.5 ms") != std::string::npos);
    CHECK(report.find("{\"track\"") == std::string::npos);
}

TEST_CASE("native selected diagnostics exclude other tracks and session data") {
    ssc::JsonValue snapshot, item;
    REQUIRE(ssc::parseJson(R"({"track":{"album":"Film & score","track":"Playing cue"},"display":{"remainingSeconds":999},"localCache":{"mediaEntries":99},"requests":[{"url":"https://api.test/api/media?album=Film+%26+score&track=Later+cue"},{"url":"https://api.test/api/media?album=Film+%26+score&track=Playing+cue"},{"url":"https://images.test/later.jpg"},{"url":"https://station.test/?action=GetQueue","response":[{"Album":"Film & score","Track":"Later cue"}]}],"events":[{"name":"image.loaded","details":{"url":"https://images.test/later.jpg"}},{"name":"cache.media.hit","details":{"album":"Film & score","track":"Later cue"}},{"name":"cache.media.hit","details":{"album":"Film & score","track":"Playing cue"}}]})", snapshot));
    REQUIRE(ssc::parseJson(R"({"id":"next","album":"Film & score","track":"Later cue","phase":"future","relativeSeconds":42,"cache":{"variants":1},"artwork":{"coverUrl":"https://images.test/later.jpg"}})", item));
    for (const auto* phase : {"future", "past"}) {
        item.object["phase"] = ssc::diagnosticString(phase);
        const auto details = ssc::diagnosticSelection(snapshot, item);
        CHECK(ssc::debugValue(ssc::debugValue(details, "track"), "track").string == "Later cue");
        CHECK(ssc::debugValue(ssc::debugValue(details, "playback"), "phase").string == phase);
        CHECK(ssc::debugValue(details, "requests").array.size() == 2);
        CHECK(ssc::debugValue(details, "events").array.size() == 2);
        const auto json = ssc::diagnosticJson(details);
        CHECK(json.find("Playing cue") == std::string::npos);
        CHECK(json.find("mediaEntries") == std::string::npos);
        CHECK(json.find("999") == std::string::npos);
    }
    item.object["album"] = ssc::diagnosticString("Unknown");
    item.object.erase("artwork"); item.object.erase("cache");
    const auto unknown = ssc::diagnosticSelection(snapshot, item);
    CHECK(ssc::debugValue(unknown, "requests").array.empty());
    CHECK(ssc::debugValue(unknown, "events").array.empty());
    CHECK(ssc::debugValue(ssc::debugValue(unknown, "resolved"), "status").string == "Not available for this track");
}

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
    overlay.attach(parent, [] { return std::string("{\"track\":{\"album\":\"Debug Album\"}}"); });
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
    std::string value = "{\"track\":{\"album\":\"Before\"}}";
    ssc::DebugOverlay overlay; overlay.attach(parent, [&] { return value; });
    SendMessageW(parent, WM_KEYDOWN, 'D', 0);
    REQUIRE(overlay.isOpen());
    HWND text = GetDlgItem(overlay.window(), ssc::DebugOverlay::kText);
    SendMessageW(overlay.window(), WM_COMMAND, ssc::DebugOverlay::kFreeze, 0);
    value = "{\"track\":{\"album\":\"After\"}}";
    overlay.advance(GetTickCount() + 1200);
    wchar_t buffer[128] = {}; GetWindowTextW(text, buffer, 128);
    CHECK(std::wstring(buffer).find(L"Before") != std::wstring::npos);
    SendMessageW(overlay.window(), WM_COMMAND, ssc::DebugOverlay::kFreeze, 0);
    GetWindowTextW(text, buffer, 128);
    CHECK(std::wstring(buffer).find(L"After") != std::wstring::npos);
    overlay.attach(nullptr, {}); DestroyWindow(parent);
}

TEST_CASE("native debug timeline scrolls to future cards and returns to the current selection") {
    HWND parent = CreateWindowExW(0, L"STATIC", L"debug fixture", WS_OVERLAPPEDWINDOW,
        0, 0, 640, 520, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    REQUIRE(parent != nullptr);
    auto snapshot = ssc::diagnosticObject(); snapshot.object["timeline"] = ssc::diagnosticArray();
    snapshot.object["track"] = ssc::diagnosticObject();
    snapshot.object["track"].object["album"] = ssc::diagnosticString("Current album");
    snapshot.object["resolved"] = ssc::diagnosticObject();
    snapshot.object["resolved"].object["backdropUrl"] = ssc::diagnosticString("https://images.test/current.jpg");
    for (int i = 0; i < 8; ++i) {
        auto item = ssc::diagnosticObject();
        item.object["id"] = ssc::diagnosticString(std::to_string(i));
        item.object["album"] = ssc::diagnosticString(i == 1 ? "Current album" : "Album " + std::to_string(i));
        item.object["phase"] = ssc::diagnosticString(i == 0 ? "past" : i == 1 ? "current" : "future");
        item.object["relativeSeconds"] = ssc::diagnosticNumber((i-1)*120);
        item.object["artwork"] = ssc::diagnosticObject();
        item.object["artwork"].object["coverUrl"] = ssc::diagnosticString("https://images.test/" + std::to_string(i) + ".jpg");
        snapshot.object["timeline"].array.push_back(item);
    }
    ssc::DebugOverlay overlay; overlay.attach(parent, [&] { return ssc::diagnosticJson(snapshot); });
    SendMessageW(parent, WM_KEYDOWN, 'D', 0);
    const HWND rail = GetDlgItem(overlay.window(), ssc::DebugOverlay::kTimeline);
    REQUIRE(rail != nullptr);
    SCROLLINFO info = {}; info.cbSize = sizeof(info); info.fMask = SIF_ALL;
    GetScrollInfo(rail, SB_HORZ, &info); CHECK(info.nMax > static_cast<int>(info.nPage));
    SendMessageW(rail, WM_KEYDOWN, VK_END, 0);
    overlay.advance(GetTickCount() + 200);
    wchar_t text[2048] = {}; GetDlgItemTextW(overlay.window(), ssc::DebugOverlay::kText, text, 2048);
    CHECK(std::wstring(text).find(L"Album 7") != std::wstring::npos);
    CHECK(std::wstring(text).find(L"\"album\"") == std::wstring::npos);
    SendDlgItemMessageW(overlay.window(), ssc::DebugOverlay::kView, CB_SETCURSEL, 1, 0);
    SendMessageW(overlay.window(), WM_COMMAND, MAKEWPARAM(ssc::DebugOverlay::kView, CBN_SELCHANGE), 0);
    overlay.advance(GetTickCount() + 200);
    GetDlgItemTextW(overlay.window(), ssc::DebugOverlay::kText, text, 2048);
    CHECK(std::wstring(text).find(L"https://images.test/7.jpg") != std::wstring::npos);
    CHECK(std::wstring(text).find(L"Current album") == std::wstring::npos);
    CHECK(std::wstring(text).find(L"current.jpg") == std::wstring::npos);
    SendMessageW(rail, WM_KEYDOWN, VK_LEFT, 0);
    overlay.advance(GetTickCount() + 200);
    CHECK(SendDlgItemMessageW(overlay.window(), ssc::DebugOverlay::kView, CB_GETCURSEL, 0, 0) == 1);
    GetDlgItemTextW(overlay.window(), ssc::DebugOverlay::kText, text, 2048);
    CHECK(std::wstring(text).find(L"https://images.test/6.jpg") != std::wstring::npos);
    SendDlgItemMessageW(overlay.window(), ssc::DebugOverlay::kView, CB_SETCURSEL, 0, 0);
    SendMessageW(overlay.window(), WM_COMMAND, ssc::DebugOverlay::kCurrent, 0);
    overlay.advance(GetTickCount() + 200);
    GetDlgItemTextW(overlay.window(), ssc::DebugOverlay::kText, text, 2048);
    CHECK(std::wstring(text).find(L"Current album") != std::wstring::npos);
    snapshot.object["timeline"] = ssc::diagnosticArray();
    snapshot.object["track"] = ssc::diagnosticObject();
    snapshot.object["track"].object["album"] = ssc::diagnosticString("Waiting for station");
    overlay.advance(GetTickCount() + 1200);
    GetDlgItemTextW(overlay.window(), ssc::DebugOverlay::kText, text, 2048);
    CHECK(std::wstring(text).find(L"Current album") == std::wstring::npos);
    CHECK(std::wstring(text).find(L"Waiting for station") != std::wstring::npos);
    overlay.attach(nullptr, {}); DestroyWindow(parent);
}
