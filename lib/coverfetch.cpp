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
// Uses sscanf rather than std::get_time to avoid pulling in the (large) C++
// <locale> machinery. Both timestamps we compare come from the same (server)
// clock, so the absolute UTC offset cancels out in the difference.
time_t isoToUnixTime(const std::string& value) {
    int y, mo, d, h, mi, s;
    if (std::sscanf(value.c_str(), "%4d-%2d-%2dT%2d:%2d:%2d", &y, &mo, &d, &h, &mi, &s) != 6)
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

    HttpResponse response = httpRequest(config_.host, config_.port, requestPath,
                                        "GET", std::string(), std::string(),
                                        config_.requestTimeoutSeconds);
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

    TrackInfo info;
    jsonString(body, "Album", info.album);
    jsonString(body, "Artist", info.artist);
    jsonString(body, "Track", info.track);

    // remaining = Length - elapsed, where elapsed = |SystemTime - PlayStart|.
    // NOTE: the JSON feed reports Length in MILLISECONDS (e.g. "150572" = 2:30),
    // unlike the old SOAP field, so we convert to seconds.
    std::string lengthStr, playStartStr, systemTimeStr;
    jsonString(body, "Length", lengthStr);
    jsonString(body, "PlayStart", playStartStr);
    jsonString(body, "SystemTime", systemTimeStr);

    long long lengthMs = lengthStr.empty() ? 0 : std::atoll(lengthStr.c_str());
    info.lengthSeconds = static_cast<int>(lengthMs / 1000);

    time_t playStart = isoToUnixTime(playStartStr);
    time_t systemTime = isoToUnixTime(systemTimeStr);
    int elapsed = 0;
    if (playStart != 0 && systemTime != 0)
        elapsed = static_cast<int>(std::llabs(static_cast<long long>(systemTime) -
                                              static_cast<long long>(playStart)));
    int remaining = info.lengthSeconds - elapsed;

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
    HttpResponse response = httpRequest(config_.host, config_.port, requestPath,
                                        "GET", std::string(), std::string(),
                                        config_.requestTimeoutSeconds);
    if (!response.ok())
        return false;
    std::string cover;
    if (!jsonString(response.body, "CoverLink", cover) || cover.empty())
        return false;
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
