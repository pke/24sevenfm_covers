#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include "../diagnostics.h"
#include "../../shared/debug_overlay.h"
#include "../diagnostic_timeline.h"
#include "../../shared/debug_report.h"
#include <regex>
#include <iomanip>
#include <sstream>
#include <limits>
#include <cstring>
#include <cstdint>
#include <ctime>

TEST_CASE("native UTC formatting matches CRT across date boundaries") {
    const struct { std::int64_t seconds; const char* iso; } cases[] = {
        {0, "1970-01-01T00:00:00Z"},
        {951782400, "2000-02-29T00:00:00Z"},
        {1709251199, "2024-02-29T23:59:59Z"},
        {1709251200, "2024-03-01T00:00:00Z"},
        {1767225599, "2025-12-31T23:59:59Z"},
        {1767225600, "2026-01-01T00:00:00Z"},
        {2147483647, "2038-01-19T03:14:07Z"},
        {2147483648, "2038-01-19T03:14:08Z"},
        {32535215999LL, "3000-12-31T23:59:59Z"}
    };
    for (const auto& item : cases) {
        CAPTURE(item.seconds);
        CHECK(ssc::formatUtcTime(item.seconds, ssc::UtcFormat::Iso8601) == item.iso);
        CHECK(ssc::formatUtcTime(item.seconds, ssc::UtcFormat::Date) == std::string(item.iso, 10));
    }
    std::uint64_t state = 0x24f00d;
    for (unsigned sample = 0; sample < 2000; ++sample) {
        state = state * 6364136223846793005ULL + 1442695040888963407ULL;
        const auto seconds = static_cast<std::time_t>(state % 32535216000ULL);
        std::tm utc = {};
        REQUIRE(gmtime_s(&utc, &seconds) == 0);
        const char* patterns[] = {"%Y-%m-%d", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d %H:%M:%S UTC"};
        const ssc::UtcFormat formats[] = {ssc::UtcFormat::Date, ssc::UtcFormat::Iso8601, ssc::UtcFormat::Display};
        for (unsigned i = 0; i < 3; ++i) {
            char expected[32]; REQUIRE(std::strftime(expected, sizeof(expected), patterns[i], &utc) != 0);
            CHECK(ssc::formatUtcTime(seconds, formats[i]) == expected);
        }
    }
    const auto before = std::time(nullptr);
    const auto timestamp = ssc::diagnosticTimestamp();
    const auto after = std::time(nullptr);
    CHECK((timestamp == ssc::formatUtcTime(before, ssc::UtcFormat::Iso8601) ||
        timestamp == ssc::formatUtcTime(after, ssc::UtcFormat::Iso8601)));
    CHECK(ssc::debugDisplayValue(ssc::diagnosticNumber(1709251199999.), "observedAt") == "2024-02-29 23:59:59 UTC");
}

TEST_CASE("native UTC formatting rejects invalid epochs before conversion") {
    for (auto seconds : {-1LL, 32535216000LL, (std::numeric_limits<long long>::max)()})
        CHECK(ssc::formatUtcTime(seconds, ssc::UtcFormat::Date).empty());
    for (double milliseconds : {-1., 32535216000000., (std::numeric_limits<double>::max)()})
        CHECK(ssc::debugDisplayValue(ssc::diagnosticNumber(milliseconds), "observedAt") == "Unknown");
}

// Retain the old stream serializer here only, to compare exact output.
static std::string streamJson(const ssc::JsonValue& value, unsigned depth = 0) {
    using ssc::JsonValue;
    std::ostringstream out; out.imbue(std::locale::classic());
    switch (value.type) {
    case JsonValue::Null: return "null";
    case JsonValue::Boolean: return value.boolean ? "true" : "false";
    case JsonValue::Number: out << std::fixed << std::setprecision(2) << value.number; return out.str();
    case JsonValue::String:
        out << '"';
        for (unsigned char c : value.string) {
            if (c == '"' || c == '\\') out << '\\' << c;
            else if (c < 32) out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << unsigned(c);
            else out << c;
        }
        out << '"'; return out.str();
    default: break;
    }
    const bool object = value.type == JsonValue::Object;
    out << (object ? '{' : '[');
    size_t count = 0;
    if (object) for (const auto& pair : value.object) {
        out << (count++ ? ",\n" : "\n") << std::string((depth + 1) * 2, ' ')
            << streamJson(ssc::diagnosticString(pair.first)) << ": " << streamJson(pair.second, depth + 1);
    }
    else for (const auto& item : value.array)
        out << (count++ ? ",\n" : "\n") << std::string((depth + 1) * 2, ' ') << streamJson(item, depth + 1);
    if (count) out << '\n' << std::string(depth * 2, ' ');
    out << (object ? '}' : ']'); return out.str();
}

TEST_CASE("diagnostic JSON preserves stream escaping and indentation") {
    std::string text;
    for (unsigned c = 0; c < 32; ++c) text += static_cast<char>(c);
    text += "\"\\ UTF-8: \xc3\xa9 \xf0\x9f\x8e\xb5";
    auto object = ssc::diagnosticObject();
    object.object[text] = ssc::diagnosticString(text);
    object.object["array"] = ssc::diagnosticArray();
    object.object["array"].array = {ssc::diagnosticBool(true), ssc::diagnosticBool(false),
        ssc::JsonValue(), ssc::diagnosticNumber(-12.125), ssc::diagnosticObject(), ssc::diagnosticArray()};
    for (unsigned depth : {0u, 1u, 4u})
        CHECK(ssc::diagnosticJson(object, depth) == streamJson(object, depth));
    CHECK(ssc::diagnosticJson(ssc::diagnosticString("")) == "\"\"");
}

TEST_CASE("diagnostic numeric formatting matches streams across finite doubles") {
    const auto check = [](double number) {
        CAPTURE(number);
        const auto value = ssc::diagnosticNumber(number);
        CHECK(ssc::diagnosticJson(value) == streamJson(value));
        std::ostringstream report; report.imbue(std::locale::classic());
        report << std::setprecision(6) << number;
        CHECK(ssc::debugDisplayValue(value) == report.str());
    };
    for (double number : {0., -0., 0.005, -0.005, 12.125, 12.375, 999999.5, 0.00009999995,
            1e20, -1e20, (std::numeric_limits<double>::max)(), (std::numeric_limits<double>::lowest)(),
            (std::numeric_limits<double>::min)(), std::numeric_limits<double>::denorm_min()}) check(number);
    std::uint64_t state = 0x24f00d;
    for (unsigned sample = 0; sample < 2000; ++sample) {
        state = state * 6364136223846793005ULL + 1442695040888963407ULL;
        double number; std::memcpy(&number, &state, sizeof(number));
        if (std::isfinite(number)) check(number);
    }
    CHECK(ssc::diagnosticJson(ssc::diagnosticNumber(std::numeric_limits<double>::infinity())) == "null");
    CHECK(ssc::diagnosticJson(ssc::diagnosticNumber(std::numeric_limits<double>::quiet_NaN())) == "null");
    CHECK(ssc::debugDisplayValue(ssc::diagnosticNumber(12.5), "totalMs") == "12.5 ms");
    CHECK(ssc::debugDisplayValue(ssc::diagnosticNumber(1024), "responseBytes") == "1024 bytes");
    CHECK(ssc::debugDisplayValue(ssc::diagnosticNumber(1.25), "remainingSeconds") == "1.25 s");
}

TEST_CASE("diagnostic formatting stays locale independent without changing the host locale") {
    struct RestoreLocale {
        std::string original = std::setlocale(LC_NUMERIC, nullptr);
        ~RestoreLocale() { std::setlocale(LC_NUMERIC, original.c_str()); }
    } restore;
    REQUIRE(std::setlocale(LC_NUMERIC, "German_Germany.1252") != nullptr);
    REQUIRE(std::string(std::localeconv()->decimal_point) == ",");
    CHECK(ssc::diagnosticJson(ssc::diagnosticNumber(12.5)) == "12.50");
    CHECK(ssc::debugDisplayValue(ssc::diagnosticNumber(12.5), "totalMs") == "12.5 ms");
    CHECK(std::string(std::localeconv()->decimal_point) == ",");
}

TEST_CASE("diagnostic redaction preserves delimiters, casing and URL authority boundaries") {
    const struct { const char* input; const char* expected; } cases[] = {
        {"", ""},
        {"album=Film&key=public", "album=Film&key=public"},
        {"API_KEY=private&Client-Key=other", "API_KEY=[redacted]&Client-Key=[redacted]"},
        {"apikey=&clientkey=abc", "apikey=[redacted]&clientkey=[redacted]"},
        {"prefixTOKEN=private", "prefixTOKEN=[redacted]"},
        {"password=a=b&album=Film", "password=[redacted]&album=Film"},
        {"secret=a\ttoken=b\r\n", "secret=[redacted]\ttoken=[redacted]\r\n"},
        {"token=a\vpassword=b\fsecret=c", "token=[redacted]\vpassword=[redacted]\fsecret=[redacted]"},
        {"authorization=a\"<token=b>", "authorization=[redacted]\"<token=[redacted]>"},
        {"https://user:pass@host/path", "https://host/path"},
        {"HTTP://a@b@host/?album=Film", "HTTP://host/?album=Film"},
        {"https://host/path@name?q=x@y#z@w", "https://host/path@name?q=x@y#z@w"},
        {"https://host?x@y https://host#x@y", "https://host?x@y https://host#x@y"},
        {"https://host user@elsewhere", "https://host user@elsewhere"},
        {"https://u:p@host/?token=private", "https://host/?token=[redacted]"},
        {"http://@one https://u@two", "http://one https://two"},
    };
    for (const auto& item : cases) {
        CAPTURE(item.input);
        CHECK(ssc::diagnosticSafeText(item.input) == item.expected);
    }
    CHECK(ssc::diagnosticSafeText(std::string(4097, 'x')) == std::string(4096, 'x') + "[truncated]");
    CHECK(ssc::diagnosticSafeText("token=" + std::string(5000, 'x')) == "token=[redacted]");
    CHECK(ssc::diagnosticSecret("nestedClient_KEY"));
    CHECK(ssc::diagnosticSecret("CREDENTIALS"));
    CHECK_FALSE(ssc::diagnosticSecret("album"));
}

TEST_CASE("diagnostic scanners match the previous regex redaction") {
    // Keep the old implementation only in the test executable as a regression oracle.
    const std::regex secret("key|token|password|secret|authorization|credential", std::regex::icase);
    const std::regex query("((?:api[_-]?key|client[_-]?key|token|password|secret|authorization)=)[^&\\s\"<>]*", std::regex::icase);
    const std::regex userinfo("(https?://)[^/?#\\s]*@", std::regex::icase);
    const std::string pieces[] = {
        "api_key=", "API-KEY=", "apikey=", "client_key=", "Client-Key=", "clientkey=",
        "token=", "PASSWORD=", "secret=", "authorization=", "credential", "key=",
        "https://", "HtTp://", "user:pass@", "a@b@", "host", "Film", "&", "?", "#", "/",
        " ", "\t", "\n", "\r", "\v", "\f", "\"", "<", ">", "=", "@", "\xc3\xa9", std::string(1, '\0')
    };
    unsigned state = 0x24f00d;
    for (unsigned sample = 0; sample < 2000; ++sample) {
        std::string input;
        for (unsigned part = 0; part < 16; ++part) {
            state = state * 1664525u + 1013904223u;
            input += pieces[(state >> 16) % (sizeof(pieces) / sizeof(pieces[0]))];
        }
        CAPTURE(sample);
        auto expected = std::regex_replace(input, query, "$1[redacted]");
        expected = std::regex_replace(expected, userinfo, "$1");
        CHECK(ssc::diagnosticSafeText(input) == expected);
        CHECK(ssc::diagnosticSecret(input) == std::regex_search(input, secret));
    }
}

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
