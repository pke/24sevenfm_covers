#include "coverfetch.h"

#include "http_client.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>

namespace ssc {
namespace {

// Parses an ISO-8601 timestamp ("2026-07-08T05:24:57") into a Unix time_t.
// Hand-rolled fixed-layout parse: std::get_time would pull in the (large) C++
// <locale> machinery and MSVC deprecates sscanf (C4996). Both timestamps we
// compare come from the same (server) clock, so the absolute UTC offset
// cancels out in the difference.
time_t isoToUnixTime(const std::string& value) {
    if (value.size() < 19 || value[4] != '-' || value[7] != '-' ||
        value[10] != 'T' || value[13] != ':' || value[16] != ':')
        return 0;
    const auto num = [&value](int pos, int len) -> int {
        int v = 0;
        for (int i = 0; i < len; ++i) {
            const char c = value[pos + i];
            if (c < '0' || c > '9') return -1;
            v = v * 10 + (c - '0');
        }
        return v;
    };
    const int y = num(0, 4), mo = num(5, 2), d = num(8, 2);
    const int h = num(11, 2), mi = num(14, 2), s = num(17, 2);
    if (y < 0 || mo < 0 || d < 0 || h < 0 || mi < 0 || s < 0)
        return 0;
    std::tm tm;
    std::memset(&tm, 0, sizeof(tm));
    tm.tm_year = y - 1900;
    tm.tm_mon  = mo - 1;
    tm.tm_mday = d;
    tm.tm_hour = h;
    tm.tm_min  = mi;
    tm.tm_sec  = s;
    tm.tm_isdst = -1;
#if defined(_WIN32)
    return _mkgmtime(&tm);
#else
    return timegm(&tm);
#endif
}

// Seconds remaining in the current track: full length minus elapsed play time.
// lengthMs is the raw feed value (MILLISECONDS - the JSON feed's "Length" unit);
// elapsed = |systemTime - playStart|, both from the server clock. A 0 timestamp
// means "unknown" (e.g. joined mid-track with no timing) so elapsed is treated as 0.
// Never returns negative.
int computeRemainingSeconds(long long lengthMs, time_t playStart, time_t systemTime) {
    const int lengthSec = static_cast<int>(lengthMs / 1000);
    int elapsed = 0;
    if (playStart != 0 && systemTime != 0)
        elapsed = static_cast<int>(std::llabs(static_cast<long long>(systemTime) -
                                              static_cast<long long>(playStart)));
    const int remaining = lengthSec - elapsed;
    return remaining < 0 ? 0 : remaining;
}

// Product id = the cover filename without directory or extension
// (".../images/cover/B00LR1YTT4.jpg" -> "B00LR1YTT4").
std::string parseAsin(const std::string& uri) {
    size_t lastSlash = uri.find_last_of('/');
    size_t start = (lastSlash == std::string::npos) ? 0 : lastSlash + 1;
    size_t dot = uri.find_last_of('.');
    if (dot == std::string::npos || dot < start)
        dot = uri.size();
    return uri.substr(start, dot - start);
}

// Rewrites ".../cover/ID.jpg" into ".../cover/<size>/ID.jpg". The server exposes
// several sizes (500 = large, 040 = thumbnail); the bare CoverLink is a medium
// image. Returns the original when size <= 0 or there is no "/cover/" segment.
std::string sizedCoverUrl(const std::string& original, int size) {
    if (size <= 0)
        return original;
    const std::string marker = "/cover/";
    size_t pos = original.find(marker);
    if (pos == std::string::npos)
        return original;
    std::string result = original;
    result.replace(pos, marker.size(), "/cover/" + std::to_string(size) + "/");
    return result;
}

// Minimal extractor for a string value of a top-level key in a flat JSON object.
// Handles the JSON string escapes present in the feed (\/ \" \\ \n \t \r \uXXXX).
// The GetCurrentlyPlaying payload is a flat object of quoted values, including
// numeric ones ("Length":"150572"), so this covers every field we read.
bool jsonString(const std::string& json, const char* key, std::string& out) {
    std::string needle = "\"";
    needle += key;
    needle += "\"";

    size_t pos = 0;
    while ((pos = json.find(needle, pos)) != std::string::npos) {
        size_t i = pos + needle.size();
        auto skipWs = [&]() {
            while (i < json.size() && (json[i] == ' ' || json[i] == '\t' ||
                                       json[i] == '\n' || json[i] == '\r'))
                ++i;
        };
        skipWs();
        if (i >= json.size() || json[i] != ':') { pos = i; continue; }
        ++i;
        skipWs();
        if (i >= json.size() || json[i] != '"') { pos = i; continue; }
        ++i;

        std::string result;
        while (i < json.size()) {
            char c = json[i++];
            if (c == '"') {
                out.swap(result);
                return true;
            }
            if (c != '\\') { result += c; continue; }
            if (i >= json.size()) break;
            char e = json[i++];
            switch (e) {
                case 'n': result += '\n'; break;
                case 't': result += '\t'; break;
                case 'r': result += '\r'; break;
                case 'b': result += '\b'; break;
                case 'f': result += '\f'; break;
                case '/': result += '/'; break;
                case '\\': result += '\\'; break;
                case '"': result += '"'; break;
                case 'u': {
                    if (i + 4 <= json.size()) {
                        int cp = static_cast<int>(std::strtol(json.substr(i, 4).c_str(), nullptr, 16));
                        i += 4;
                        if (cp < 0x80) {
                            result += static_cast<char>(cp);
                        } else if (cp < 0x800) {
                            result += static_cast<char>(0xC0 | (cp >> 6));
                            result += static_cast<char>(0x80 | (cp & 0x3F));
                        } else {
                            result += static_cast<char>(0xE0 | (cp >> 12));
                            result += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
                            result += static_cast<char>(0x80 | (cp & 0x3F));
                        }
                    }
                    break;
                }
                default: result += e; break;
            }
        }
        return false; // unterminated string
    }
    return false;
}

// Appends a Unicode code point to `out` as UTF-8.
void appendUtf8(std::string& out, unsigned cp) {
    if (cp < 0x80) {
        out += static_cast<char>(cp);
    } else if (cp < 0x800) {
        out += static_cast<char>(0xC0 | (cp >> 6));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
        out += static_cast<char>(0xE0 | (cp >> 12));
        out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    } else {
        out += static_cast<char>(0xF0 | (cp >> 18));
        out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
        out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    }
}

// Decodes the HTML entities the station stores its track text with (e.g.
// "Rock &#039;n&#039; Roll", "R&amp;B") into UTF-8. Handles the named entities the
// feed uses plus decimal/hex numeric references; unknown entities are left as-is.
std::string htmlDecode(const std::string& in) {
    std::string out;
    out.reserve(in.size());
    for (size_t i = 0; i < in.size();) {
        if (in[i] != '&') { out += in[i++]; continue; }
        const size_t semi = in.find(';', i + 1);
        if (semi == std::string::npos || semi - i > 12) { out += in[i++]; continue; }
        const std::string ent = in.substr(i + 1, semi - i - 1);
        if (!ent.empty() && ent[0] == '#') { // numeric: &#NN; or &#xHH;
            unsigned cp = 0; bool ok = false;
            const bool hex = ent.size() > 1 && (ent[1] == 'x' || ent[1] == 'X');
            for (size_t k = hex ? 2 : 1; k < ent.size(); ++k) {
                const char c = ent[k]; int d;
                if (c >= '0' && c <= '9')                d = c - '0';
                else if (hex && c >= 'a' && c <= 'f')    d = c - 'a' + 10;
                else if (hex && c >= 'A' && c <= 'F')    d = c - 'A' + 10;
                else { ok = false; break; }
                cp = cp * (hex ? 16u : 10u) + static_cast<unsigned>(d);
                if (cp > 0x10FFFF) { ok = false; break; } // stop before the accumulator overflows
                ok = true;
            }
            // Reject 0 and the UTF-16 surrogate range (would encode as invalid UTF-8).
            if (ok && cp > 0 && !(cp >= 0xD800 && cp <= 0xDFFF)) { appendUtf8(out, cp); i = semi + 1; continue; }
        } else {
            const char* rep = nullptr;
            if      (ent == "amp")  rep = "&";
            else if (ent == "lt")   rep = "<";
            else if (ent == "gt")   rep = ">";
            else if (ent == "quot") rep = "\"";
            else if (ent == "apos") rep = "'";
            else if (ent == "nbsp") rep = " ";
            if (rep) { out += rep; i = semi + 1; continue; }
        }
        out += in[i++]; // unrecognized -> keep the '&' literally
    }
    return out;
}

// Dispatch a GET through the Config's injected transport if it has one, else the
// built-in networking. Keeps pollOnce/nextCoverUrl agnostic of where bytes come from
// (the seam the unit tests use to feed canned responses without a socket).
HttpResponse fetch(const Config& cfg, const std::string& path) {
    if (cfg.transport)
        return cfg.transport(cfg.host, cfg.port, path, "GET", std::string(), std::string(),
                             cfg.requestTimeoutSeconds);
    return httpRequest(cfg.host, cfg.port, path, "GET", std::string(), std::string(),
                       cfg.requestTimeoutSeconds);
}

// Rejects a cover URL a hostile server/MITM could weaponize, BEFORE we ever fetch it:
//  - any control byte (CR/LF/NUL/TAB/...) -> HTTP request-line/header injection when the
//    URL's path is spliced into "GET <path> HTTP/1.1\r\n";
//  - a host outside the station's own domain -> SSRF to internal/LAN/localhost services.
// stationHost is Config::host; the URL host must equal it or be a subdomain of it.
bool isTrustedCoverUrl(const std::string& url, const std::string& stationHost) {
    if (url.empty() || stationHost.empty()) return false;
    for (unsigned char c : url)
        if (c < 0x20 || c == 0x7F) return false; // control chars incl. CR, LF, NUL, TAB

    auto lower = [](std::string s) {
        for (char& c : s) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + 32);
        return s;
    };
    // Extract the host: strip scheme, then path, then userinfo (user@), then :port.
    std::string rest = url;
    const size_t scheme = rest.find("://");
    if (scheme != std::string::npos) rest = rest.substr(scheme + 3);
    const size_t slash = rest.find('/');
    std::string host = (slash == std::string::npos) ? rest : rest.substr(0, slash);
    const size_t at = host.rfind('@');
    if (at != std::string::npos) host = host.substr(at + 1);      // drop "user:pass@" trickery
    const size_t colon = host.find(':');
    if (colon != std::string::npos) host = host.substr(0, colon); // drop ":port"
    host = lower(host);
    const std::string base = lower(stationHost);
    return host == base ||                                        // exact station host, or
           (host.size() > base.size() + 1 &&                      // a subdomain "*.<base>"
            host.compare(host.size() - base.size() - 1, base.size() + 1, "." + base) == 0);
}

} // namespace

CoverMonitor::CoverMonitor(CoverChangedCallback onCoverChanged, Config config)
    : config_(std::move(config)), onCoverChanged_(std::move(onCoverChanged)) {}

CoverMonitor::~CoverMonitor() {
    stop();
}

void CoverMonitor::setErrorCallback(ErrorCallback cb) {
    onError_ = std::move(cb);
}

void CoverMonitor::setTickCallback(TickCallback cb) {
    onTick_ = std::move(cb);
}

void CoverMonitor::emitError(const std::string& message) const {
    if (onError_)
        onError_(message);
}

bool CoverMonitor::pollOnce(TrackInfo& out, std::string* error) const {
    // Cache-busting query parameter, exactly as the site's own player does
    // ("...&_t=<ms>"). A rolling counter keeps it unique within the same second.
    static std::atomic<unsigned long long> counter{0};
    unsigned long long cb =
        static_cast<unsigned long long>(std::time(nullptr)) * 1000ull + (counter++ % 1000ull);
    std::string requestPath =
        config_.path + "?action=" + config_.action + "&_t=" + std::to_string(cb);

    HttpResponse response = fetch(config_, requestPath);
    if (!response.ok()) {
        if (error) {
            *error = response.status == 0
                ? ("HTTP transport error: " + response.error)
                : ("HTTP status " + std::to_string(response.status));
        }
        return false;
    }

    // Capture local time as close to the response as possible.
    const time_t captureNow = std::time(nullptr);
    const std::string& body = response.body;

    std::string cover;
    if (!jsonString(body, "CoverLink", cover) || cover.empty()) {
        if (error) *error = "No CoverLink in response";
        return false;
    }
    if (!isTrustedCoverUrl(cover, config_.host)) {
        if (error) *error = "Rejected untrusted CoverLink (off-domain host or control chars)";
        return false;
    }

    TrackInfo info;
    jsonString(body, "Album", info.album);
    jsonString(body, "Artist", info.artist);
    jsonString(body, "Track", info.track);
    // The feed stores these HTML-encoded ("R&amp;B", "&#039;"); decode for display.
    info.album  = htmlDecode(info.album);
    info.artist = htmlDecode(info.artist);
    info.track  = htmlDecode(info.track);

    // remaining = Length - elapsed, where elapsed = |SystemTime - PlayStart|.
    // NOTE: the JSON feed reports Length in MILLISECONDS (e.g. "150572" = 2:30),
    // unlike the old SOAP field, so we convert to seconds.
    std::string lengthStr, playStartStr, systemTimeStr;
    jsonString(body, "Length", lengthStr);
    jsonString(body, "PlayStart", playStartStr);
    jsonString(body, "SystemTime", systemTimeStr);

    long long lengthMs = lengthStr.empty() ? 0 : std::atoll(lengthStr.c_str());
    info.lengthSeconds = static_cast<int>(lengthMs / 1000);

    int remaining = computeRemainingSeconds(lengthMs, isoToUnixTime(playStartStr),
                                            isoToUnixTime(systemTimeStr));

    // Correct for any time spent between capture and this computation.
    remaining -= static_cast<int>(std::time(nullptr) - captureNow);
    if (remaining < 0)
        remaining = 0;
    info.remainingSeconds = remaining;

    info.originalCover = cover;
    info.coverUrl = sizedCoverUrl(info.originalCover, config_.coverSize);
    info.asin = parseAsin(info.originalCover);

    out = std::move(info);
    return true;
}

bool CoverMonitor::nextCoverUrl(std::string& out, int* lengthSeconds) const {
    static std::atomic<unsigned long long> counter{0};
    unsigned long long cb =
        static_cast<unsigned long long>(std::time(nullptr)) * 1000ull + (counter++ % 1000ull);
    // GetQueue returns a JSON array of upcoming tracks; the first "CoverLink" and
    // "Length" are the next track's (jsonString finds the first occurrence).
    std::string requestPath = config_.path + "?action=GetQueue&_t=" + std::to_string(cb);
    HttpResponse response = fetch(config_, requestPath);
    if (!response.ok())
        return false;
    std::string cover;
    if (!jsonString(response.body, "CoverLink", cover) || cover.empty())
        return false;
    if (!isTrustedCoverUrl(cover, config_.host)) return false;
    out = sizedCoverUrl(cover, config_.coverSize);
    if (lengthSeconds) {
        std::string len;
        long ms = jsonString(response.body, "Length", len) ? std::atol(len.c_str()) : 0;
        *lengthSeconds = ms > 0 ? static_cast<int>(ms / 1000) : 0; // Length is in ms
    }
    return true;
}

void CoverMonitor::start() {
    if (running_.exchange(true))
        return; // already running
    {
        std::lock_guard<std::mutex> lock(mutex_);
        stopRequested_ = false;
    }
    thread_ = std::thread(&CoverMonitor::run, this);
}

void CoverMonitor::stop() {
    if (!running_.exchange(false)) {
        // Not running, but a thread object may still be joinable from a prior run.
        if (thread_.joinable())
            thread_.join();
        return;
    }
    {
        std::lock_guard<std::mutex> lock(mutex_);
        stopRequested_ = true;
    }
    cv_.notify_all();
    if (thread_.joinable())
        thread_.join();
}

void CoverMonitor::refresh() {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        refreshRequested_ = true;
    }
    cv_.notify_all();
}

void CoverMonitor::run() {
    int consecutiveErrors = 0;
    while (true) {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (stopRequested_)
                break;
            if (refreshRequested_) {
                refreshRequested_ = false;
                lastCoverUrl_.clear(); // force onCoverChanged to re-fire this poll
            }
        }

        TrackInfo info;
        std::string error;
        if (pollOnce(info, &error)) {
            consecutiveErrors = 0;
            if (info.coverUrl != lastCoverUrl_) {
                lastCoverUrl_ = info.coverUrl;
                if (onCoverChanged_)
                    onCoverChanged_(info.coverUrl, info);
            }

            // Re-poll when the track is expected to end (remaining, clamped),
            // and meanwhile emit a tick every second with a live, decrementing
            // remainingSeconds so consumers get a countdown for free.
            const int fetched = info.remainingSeconds;
            int repollDelay = fetched;
            if (repollDelay < config_.minPollSeconds) repollDelay = config_.minPollSeconds;
            if (repollDelay > config_.maxPollSeconds) repollDelay = config_.maxPollSeconds;

            const auto capture = std::chrono::steady_clock::now();
            bool stopped = false;
            for (;;) {
                const int elapsed = static_cast<int>(
                    std::chrono::duration_cast<std::chrono::seconds>(
                        std::chrono::steady_clock::now() - capture).count());
                if (onTick_) {
                    TrackInfo tick = info;
                    tick.remainingSeconds = fetched - elapsed < 0 ? 0 : fetched - elapsed;
                    onTick_(tick);
                }
                if (config_.autoAdvance && elapsed >= repollDelay)
                    break; // live-clock mode: re-poll at the track boundary
                std::unique_lock<std::mutex> lock(mutex_);
                cv_.wait_for(lock, std::chrono::seconds(1),
                             [this] { return stopRequested_ || refreshRequested_; });
                if (stopRequested_) { stopped = true; break; }
                if (refreshRequested_) break; // re-poll now (flag cleared at loop top)
            }
            if (stopped)
                break;
        } else {
            emitError(error);
            // Exponential backoff on consecutive failures so we don't pound a
            // struggling server: errorRetrySeconds * 2^(n-1), capped.
            if (consecutiveErrors < 30) ++consecutiveErrors;
            int shift = consecutiveErrors - 1;
            if (shift > 6) shift = 6; // cap the multiplier at 64x
            long long backoff = static_cast<long long>(config_.errorRetrySeconds) << shift;
            if (backoff > config_.maxPollSeconds) backoff = config_.maxPollSeconds;

            std::unique_lock<std::mutex> lock(mutex_);
            cv_.wait_for(lock, std::chrono::seconds(static_cast<int>(backoff)),
                         [this] { return stopRequested_ || refreshRequested_; });
            if (stopRequested_)
                break;
        }
    }
}

} // namespace ssc
