// Unit tests for the pure logic in the coverfetch library: cover-URL parsing/sizing,
// the minimal JSON extractor, chunked-HTTP decode, and the ISO-time -> countdown math.
//
// Those helpers live in ANONYMOUS namespaces inside the .cpp files (not exported), so
// we compile the sources straight into this test translation unit to reach them - and
// therefore do NOT also link the coverfetch library (that would duplicate symbols).
#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"

#include "../http_client.cpp" // ssc:: dechunk, toLower  (+ httpRequest, unused here)
#include "../coverfetch.cpp"  // ssc:: parseAsin, sizedCoverUrl, jsonString, isoToUnixTime
#include "../../shared/stations.h" // ssc:: station table + stream-URL detection (auto-follow)

using namespace ssc; // anonymous-namespace helpers are reachable as ssc:: in this TU

// --- parseAsin: cover filename -> product id --------------------------------
TEST_CASE("parseAsin strips directory and extension") {
    CHECK(parseAsin("https://x/images/cover/B00LR1YTT4.jpg") == "B00LR1YTT4");
    CHECK(parseAsin("cover/500/B000001546.jpg")              == "B000001546");
    CHECK(parseAsin("noslash.png")                           == "noslash");
    CHECK(parseAsin("bareid")                                == "bareid");
    CHECK(parseAsin("dir/trailingslash/")                    == ""); // nothing after last '/'
}

// --- sizedCoverUrl: insert the /<size>/ segment -----------------------------
TEST_CASE("sizedCoverUrl inserts the size after /cover/") {
    CHECK(sizedCoverUrl("https://s/images/cover/ID.jpg", 500) == "https://s/images/cover/500/ID.jpg");
    CHECK(sizedCoverUrl("https://s/images/cover/ID.jpg", 40)  == "https://s/images/cover/40/ID.jpg");
}
TEST_CASE("sizedCoverUrl returns the original when size<=0 or no /cover/") {
    CHECK(sizedCoverUrl("https://s/images/cover/ID.jpg", 0)  == "https://s/images/cover/ID.jpg");
    CHECK(sizedCoverUrl("https://s/images/cover/ID.jpg", -1) == "https://s/images/cover/ID.jpg");
    CHECK(sizedCoverUrl("https://s/other/ID.jpg", 500)       == "https://s/other/ID.jpg");
}

// --- jsonString: the minimal flat-object string extractor -------------------
TEST_CASE("jsonString extracts a flat string value") {
    std::string out;
    CHECK(jsonString("{\"Artist\":\"Pink Floyd\",\"Track\":\"Time\"}", "Artist", out));
    CHECK(out == "Pink Floyd");
    CHECK(jsonString("{\"Track\":\"Time\"}", "Track", out));
    CHECK(out == "Time");
    CHECK(jsonString("{\"Length\":\"150572\"}", "Length", out)); // numeric field is still a quoted string
    CHECK(out == "150572");
}
TEST_CASE("jsonString decodes the escapes the feed uses") {
    std::string out;
    CHECK(jsonString("{\"CoverLink\":\"http:\\/\\/x\\/a.jpg\"}", "CoverLink", out));
    CHECK(out == "http://x/a.jpg"); // \/ -> /
    CHECK(jsonString("{\"T\":\"A\\u0026B\"}", "T", out));
    CHECK(out == "A&B");            // & -> &
}
TEST_CASE("jsonString returns false for a missing key") {
    std::string out;
    CHECK(jsonString("{\"A\":\"1\"}", "B", out) == false);
}
TEST_CASE("jsonString handles whitespace, control escapes, and non-string values") {
    std::string out;
    CHECK(jsonString("{ \"A\" : \"x\\ny\\tz\" }", "A", out)); // whitespace around ':' + \n \t
    CHECK(out == "x\ny\tz");
    CHECK(jsonString("{\"A\":123}", "A", out) == false);            // unquoted (number) value
    CHECK(jsonString("{\"A\":\"unterminated", "A", out) == false);  // no closing quote
    // Must match the KEY, not an earlier value that equals the key name.
    CHECK(jsonString("{\"Track\":\"Artist\",\"Artist\":\"Floyd\"}", "Artist", out));
    CHECK(out == "Floyd");
}

// --- dechunk: HTTP/1.1 chunked transfer decode ------------------------------
TEST_CASE("dechunk joins chunks and stops at the 0 chunk") {
    CHECK(dechunk("4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n") == "Wikipedia");
    CHECK(dechunk("3\r\nabc\r\n0\r\n\r\n")                == "abc");
}
TEST_CASE("dechunk strips chunk extensions and clamps an oversized size") {
    CHECK(dechunk("4;name=v\r\nWiki\r\n0\r\n\r\n") == "Wiki"); // ';' extension ignored
    CHECK(dechunk("a\r\nshort") == "short");                   // size 0xA > body -> clamp to remainder
}

// --- toLower ----------------------------------------------------------------
TEST_CASE("toLower lowercases ASCII, leaves the rest") {
    CHECK(toLower("HeLLo WORLD 42") == "hello world 42");
}

// --- isoToUnixTime: drives the remaining-time countdown ---------------------
TEST_CASE("isoToUnixTime parses UTC timestamps") {
    CHECK(isoToUnixTime("1970-01-01T00:00:00") == (time_t)0);
    CHECK(isoToUnixTime("2000-01-01T00:00:00") == (time_t)946684800);
}
TEST_CASE("isoToUnixTime difference gives elapsed seconds") {
    // remaining = Length - |SystemTime - PlayStart|; here the two stamps are 2:30 apart.
    const time_t playStart  = isoToUnixTime("2026-07-08T05:24:57");
    const time_t systemTime = isoToUnixTime("2026-07-08T05:27:27");
    CHECK((systemTime - playStart) == (time_t)150);
}
TEST_CASE("isoToUnixTime returns 0 for malformed input") {
    CHECK(isoToUnixTime("not-a-date") == (time_t)0);
    CHECK(isoToUnixTime("")           == (time_t)0);
}

// --- computeRemainingSeconds: the shipped countdown formula -----------------
TEST_CASE("computeRemainingSeconds: Length(ms) minus elapsed, clamped >= 0") {
    // Length 150572 ms = 150 s; 60 s elapsed -> 90 s left.
    CHECK(computeRemainingSeconds(150572, (time_t)1000, (time_t)1060) == 90);
    // Just started (systemTime == playStart) -> full length.
    CHECK(computeRemainingSeconds(150572, (time_t)1000, (time_t)1000) == 150);
    // |diff| is used, so order does not matter.
    CHECK(computeRemainingSeconds(150572, (time_t)1060, (time_t)1000) == 90);
    // Past the end -> clamp to 0, never negative.
    CHECK(computeRemainingSeconds(150572, (time_t)1000, (time_t)9999) == 0);
    // Unknown timing (0 timestamps, e.g. joined mid-track) -> elapsed 0 -> full length.
    CHECK(computeRemainingSeconds(150572, 0, 0) == 150);
    // ms -> s truncates (1999 ms -> 1 s).
    CHECK(computeRemainingSeconds(1999, (time_t)1000, (time_t)1000) == 1);
}

// --- Network paths via an injected transport (no real sockets) --------------
// Config::transport lets the monitor return canned HTTP responses, so pollOnce /
// nextCoverUrl - the JSON->TrackInfo mapping and error handling - are testable offline.
static const auto kNoop = [](const std::string&, const TrackInfo&) {};

TEST_CASE("pollOnce maps a GetCurrentlyPlaying response to TrackInfo") {
    Config cfg; // coverSize defaults to 500
    cfg.host = "s"; // the canned CoverLinks below use host "s" as the station
    std::string seenPath;
    cfg.transport = [&](const std::string&, unsigned short, const std::string& path,
                        const std::string&, const std::string&, const std::string&, int) {
        seenPath = path;
        HttpResponse r;
        r.status = 200;
        r.body = R"JSON({"Album":"Meddle","Artist":"Pink Floyd","Track":"Echoes",
                         "Length":"150572","PlayStart":"2026-07-08T05:24:57",
                         "SystemTime":"2026-07-08T05:25:57",
                         "CoverLink":"https:\/\/s\/images\/cover\/B00LR1YTT4.jpg"})JSON";
        return r;
    };
    CoverMonitor mon(kNoop, cfg);

    TrackInfo info;
    std::string err;
    REQUIRE(mon.pollOnce(info, &err));
    CHECK(info.album  == "Meddle");
    CHECK(info.artist == "Pink Floyd");
    CHECK(info.track  == "Echoes");
    CHECK(info.originalCover == "https://s/images/cover/B00LR1YTT4.jpg");
    CHECK(info.coverUrl      == "https://s/images/cover/500/B00LR1YTT4.jpg"); // sized to 500
    CHECK(info.asin          == "B00LR1YTT4");
    CHECK(info.lengthSeconds == 150);   // 150572 ms -> 150 s
    CHECK(info.remainingSeconds == 90); // 150 - |05:25:57 - 05:24:57| = 150 - 60
    CHECK(seenPath.find("action=GetCurrentlyPlaying") != std::string::npos);
}

TEST_CASE("pollOnce honours coverSize=0 (leaves the CoverLink untouched)") {
    Config cfg;
    cfg.coverSize = 0;
    cfg.host = "s"; // canned CoverLink uses host "s" as the station
    cfg.transport = [](const std::string&, unsigned short, const std::string&,
                       const std::string&, const std::string&, const std::string&, int) {
        HttpResponse r; r.status = 200;
        r.body = R"JSON({"CoverLink":"https:\/\/s\/images\/cover\/ID.jpg","Length":"1000"})JSON";
        return r;
    };
    CoverMonitor mon(kNoop, cfg);
    TrackInfo info;
    REQUIRE(mon.pollOnce(info, nullptr));
    CHECK(info.coverUrl == "https://s/images/cover/ID.jpg"); // no /500/ inserted
}

TEST_CASE("pollOnce fails on HTTP error, transport failure, and missing CoverLink") {
    auto canned = [](int status, const char* body, const char* error) {
        Config cfg;
        std::string b = body ? body : "", e = error ? error : "";
        cfg.transport = [=](const std::string&, unsigned short, const std::string&,
                            const std::string&, const std::string&, const std::string&, int) {
            HttpResponse r; r.status = status; r.body = b; r.error = e; return r;
        };
        return cfg;
    };

    SUBCASE("HTTP 500 -> false, error mentions the status") {
        CoverMonitor mon(kNoop, canned(500, "", nullptr));
        TrackInfo info; std::string err;
        CHECK_FALSE(mon.pollOnce(info, &err));
        CHECK(err.find("500") != std::string::npos);
    }
    SUBCASE("transport/socket failure (status 0) -> false, error surfaced") {
        CoverMonitor mon(kNoop, canned(0, "", "connection refused"));
        TrackInfo info; std::string err;
        CHECK_FALSE(mon.pollOnce(info, &err));
        CHECK(err.find("connection refused") != std::string::npos);
    }
    SUBCASE("200 but no CoverLink -> false") {
        CoverMonitor mon(kNoop, canned(200, R"({"Artist":"x"})", nullptr));
        TrackInfo info; std::string err;
        CHECK_FALSE(mon.pollOnce(info, &err));
        CHECK(err.find("CoverLink") != std::string::npos);
    }
}

TEST_CASE("nextCoverUrl parses the queue's first cover + length") {
    Config cfg; // coverSize 500
    cfg.host = "s"; // canned CoverLinks use host "s" as the station
    std::string seenPath;
    cfg.transport = [&](const std::string&, unsigned short, const std::string& path,
                        const std::string&, const std::string&, const std::string&, int) {
        seenPath = path;
        HttpResponse r;
        r.status = 200;
        r.body = R"JSON([{"CoverLink":"https:\/\/s\/images\/cover\/B0009VQANG.jpg","Length":"121000"},
                         {"CoverLink":"https:\/\/s\/images\/cover\/OTHER.jpg","Length":"90000"}])JSON";
        return r;
    };
    CoverMonitor mon(kNoop, cfg);
    std::string url;
    int len = 0;
    REQUIRE(mon.nextCoverUrl(url, &len));
    CHECK(url == "https://s/images/cover/500/B0009VQANG.jpg"); // first entry, sized
    CHECK(len == 121);                                          // 121000 ms -> 121 s
    CHECK(seenPath.find("action=GetQueue") != std::string::npos);
}

// --- Security: CoverLink validation (request-injection + SSRF) ---------------
TEST_CASE("isTrustedCoverUrl accepts the station host and its subdomains") {
    const std::string h = "streamingsoundtracks.com";
    CHECK(isTrustedCoverUrl("http://streamingsoundtracks.com/images/cover/500/X.jpg", h));
    CHECK(isTrustedCoverUrl("https://streamingsoundtracks.com/a.jpg", h));
    CHECK(isTrustedCoverUrl("http://cdn.streamingsoundtracks.com/a.jpg", h)); // subdomain
    CHECK(isTrustedCoverUrl("http://streamingsoundtracks.com:80/a.jpg", h));  // explicit :port
}
TEST_CASE("isTrustedCoverUrl rejects control chars (HTTP request injection)") {
    const std::string h = "streamingsoundtracks.com";
    CHECK_FALSE(isTrustedCoverUrl("http://streamingsoundtracks.com/a\r\nEvil: 1", h)); // CRLF
    CHECK_FALSE(isTrustedCoverUrl("http://streamingsoundtracks.com/a\tb", h));         // TAB
    std::string nul = "http://streamingsoundtracks.com/a"; nul.push_back('\0'); nul += "b";
    CHECK_FALSE(isTrustedCoverUrl(nul, h));                                            // embedded NUL
}
TEST_CASE("isTrustedCoverUrl rejects off-domain hosts (SSRF)") {
    const std::string h = "streamingsoundtracks.com";
    CHECK_FALSE(isTrustedCoverUrl("http://169.254.169.254/latest/meta-data/", h)); // cloud metadata
    CHECK_FALSE(isTrustedCoverUrl("http://192.168.1.1/", h));                       // LAN
    CHECK_FALSE(isTrustedCoverUrl("http://evil.com/a.jpg", h));
    CHECK_FALSE(isTrustedCoverUrl("http://evilstreamingsoundtracks.com/a.jpg", h)); // suffix lookalike
    CHECK_FALSE(isTrustedCoverUrl("http://streamingsoundtracks.com.evil.com/a.jpg", h));
    CHECK_FALSE(isTrustedCoverUrl("http://streamingsoundtracks.com@evil.com/a.jpg", h)); // userinfo trick
    CHECK_FALSE(isTrustedCoverUrl("", h));
}
TEST_CASE("dechunk clamps a malicious oversized chunk size and terminates") {
    CHECK(dechunk("fffffff0\r\nabc") == "abc");        // huge size -> clamp to remainder, then stop
    CHECK(dechunk("ffffffffffffffff\r\nxy") == "xy");  // larger than any remaining bytes
}

// --- htmlDecode: the feed stores track text HTML-encoded --------------------
TEST_CASE("htmlDecode decodes the entities the station feed uses") {
    CHECK(htmlDecode("Rock &#039;n&#039; Roll") == "Rock 'n' Roll"); // decimal apostrophe
    CHECK(htmlDecode("R&amp;B")                 == "R&B");
    CHECK(htmlDecode("&quot;Quoted&quot;")      == "\"Quoted\"");
    CHECK(htmlDecode("&lt;tag&gt;")             == "<tag>");
    CHECK(htmlDecode("&#233;")                  == "\xC3\xA9"); // e-acute -> UTF-8
    CHECK(htmlDecode("&#xE9;")                  == "\xC3\xA9"); // hex form
    CHECK(htmlDecode("plain text")              == "plain text");
    CHECK(htmlDecode("A & B")                   == "A & B");      // bare '&' (no ';') untouched
    CHECK(htmlDecode("&bogus;")                 == "&bogus;");    // unknown entity kept
    CHECK(htmlDecode("&#xD800;")                == "&#xD800;");   // UTF-16 surrogate rejected -> literal
    CHECK(htmlDecode("&#4294967297;")           == "&#4294967297;"); // overflow rejected -> literal
}

// --- 24seven.fm station detection (plugin auto-follow) ----------------------
TEST_CASE("stationIndexForText identifies the family station from a stream URL") {
    CHECK(stationIndexForText("http://hi5.streamingsoundtracks.com/") == 0); // SST
    CHECK(stationIndexForText("http://hi.1980s.fm/")                  == 1);
    CHECK(stationIndexForText("https://adagio.fm/listen.pls")         == 2);
    CHECK(stationIndexForText("http://hi5.death.fm/")                 == 3);
    CHECK(stationIndexForText("http://hi.entranced.fm/")              == 4);
    CHECK(stationIndexForText("StreamingSoundtracks")                 == 0); // bare name, no TLD
    CHECK(stationIndexForText("DEATH.FM (extreme metal)")             == 3); // case-insensitive
}
TEST_CASE("stationIndexForText rejects non-family streams and local files") {
    CHECK(stationIndexForText("http://example.com/song.mp3") == -1);
    CHECK(stationIndexForText("C:\\music\\track.flac")       == -1);
    CHECK(stationIndexForText("")                            == -1);
    CHECK(stationIndexForText(nullptr)                       == -1);
}
TEST_CASE("station id lookup + index clamping are stable for persistence") {
    CHECK(stationIndexForId("sst")   == 0);
    CHECK(stationIndexForId("death") == 3);
    CHECK(stationIndexForId("nope")  == -1);
    CHECK(validStationIndex(-1)  == 0); // out of range -> default station
    CHECK(validStationIndex(999) == 0);
    CHECK(validStationIndex(3)   == 3);
}
