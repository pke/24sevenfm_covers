// coverfetch.h - cross-platform (Windows / iOS / Android) library that watches
// the "currently playing" cover art on Streaming Soundtracks (24seven.fm).
//
// Usage:
//     ssc::CoverMonitor monitor([](const std::string& url, const ssc::TrackInfo& t) {
//         // Called on a background thread whenever the cover changes.
//         // `url` is the new cover image URL to load in your UI.
//     });
//     monitor.start();
//     ...
//     monitor.stop();   // (also called by the destructor)
//
// The monitor polls the station's JSON "now playing" endpoint, and re-polls
// exactly when the current track is expected to end, mirroring the timing logic
// of the reference desktop app (remaining = Length - |SystemTime - PlayStart|).
#pragma once

#include <atomic>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <string>
#include <thread>

#include "http_client.h" // HttpResponse (used by the injectable transport)

namespace ssc {

// Everything known about the track that is currently playing.
struct TrackInfo {
    std::string album;
    std::string artist;
    std::string track;
    std::string coverUrl;       // cover image URL handed to the callback (sized, see Config::coverSize)
    std::string originalCover;   // the raw CoverLink value from the server
    std::string asin;            // product id parsed from the cover filename
    int lengthSeconds = 0;       // total track length
    int remainingSeconds = 0;    // seconds left until the track ends (drives the next poll)
};

// Fired whenever the cover changes (and once for the first track seen).
// Invoked on the monitor's background thread.
using CoverChangedCallback = std::function<void(const std::string& coverUrl, const TrackInfo& info)>;

// Fired about once per second while a track is playing. info.remainingSeconds
// counts down each tick, so consumers get a live countdown for free without
// doing their own timing. Invoked on the monitor's background thread.
using TickCallback = std::function<void(const TrackInfo& info)>;

// Optional error/log hook, also invoked on the background thread.
using ErrorCallback = std::function<void(const std::string& message)>;

// Injectable HTTP transport. When a Config leaves this empty (the default) the monitor
// uses the built-in ssc::httpRequest. Set it to return canned responses and the monitor
// never touches the network - the seam used by the unit tests. Same signature as
// httpRequest, so `cfg.transport = ssc::httpRequest;` is also valid.
using HttpTransport = std::function<HttpResponse(
    const std::string& host, unsigned short port, const std::string& path,
    const std::string& method, const std::string& body,
    const std::string& contentType, int timeoutSeconds)>;

struct Config {
    // Use the bare host, NOT www.*: www.streamingsoundtracks.com issues a 301
    // redirect. The endpoint is served over both HTTP:80 and HTTPS:443. The old
    // SOAP endpoint (FM24seven.php) is dead (HTTP 500); this JSON one
    // (FM24sevenJSON.php) is what the site's own player uses.
    std::string host = "streamingsoundtracks.com";
    std::string path = "/soap/FM24sevenJSON.php";
    std::string action = "GetCurrentlyPlaying"; // query: ?action=<action>&_t=<cachebuster>
#if defined(_WIN32)
    unsigned short port = 443; // Windows: HTTPS via WinHTTP (native TLS + cert validation)
#else
    unsigned short port = 80;  // other platforms: plain-socket path until a TLS lib is wired in
#endif

    // Requested cover pixel size. The bare CoverLink is a medium image; 500 is
    // the large art (the reference app used 500), 40 the thumbnail. Set to 0 to
    // hand back the server's CoverLink untouched.
    int coverSize = 500;

    // Clamps on the computed poll delay, in seconds, so we never hammer the
    // server nor sleep forever on a bad/negative value.
    int minPollSeconds = 5;
    int maxPollSeconds = 3600;

    // How long to wait before retrying after a failed fetch.
    int errorRetrySeconds = 30;

    // Socket timeout for a single request.
    int requestTimeoutSeconds = 20;

    // When true (default) the monitor re-polls on its own at each track boundary
    // (follows the station's live clock). When false it polls once at start and
    // then only when refresh() is called - let the host decide when covers change
    // (e.g. drive it off the player's own track-change events). The per-second
    // tick still fires either way.
    bool autoAdvance = true;

    // Injected HTTP transport; empty -> real network (see HttpTransport above).
    HttpTransport transport;
};

class CoverMonitor {
public:
    explicit CoverMonitor(CoverChangedCallback onCoverChanged, Config config = Config());
    ~CoverMonitor();

    CoverMonitor(const CoverMonitor&) = delete;
    CoverMonitor& operator=(const CoverMonitor&) = delete;

    // Optional: receive error messages instead of them being silently ignored.
    void setErrorCallback(ErrorCallback cb);

    // Optional: receive a TrackInfo about once per second with a live
    // (decrementing) remainingSeconds. Set before start().
    void setTickCallback(TickCallback cb);

    // Starts the background polling thread. Safe to call once.
    void start();

    // Stops the background thread and blocks until it has finished. Idempotent.
    void stop();

    // Forces an immediate re-poll and re-fires the cover-changed callback even if
    // the cover is unchanged (e.g. call this when playback starts). Thread-safe.
    void refresh();

    bool isRunning() const { return running_.load(); }

    // True from the moment stop() begins until the next start(). Long-running work
    // invoked from the monitor's callbacks (e.g. a host downloading covers with
    // retries) should poll this and abort promptly - otherwise stop()'s join blocks
    // for the full remaining request timeout(s), freezing the caller's thread.
    bool cancelled() const { return cancelled_.load(); }

    // Performs a single synchronous fetch+parse without touching the background
    // thread. Useful for a one-shot query or for driving your own scheduler.
    // Returns true on success and fills `out`; on failure returns false and, if
    // provided, writes a message to `error`.
    bool pollOnce(TrackInfo& out, std::string* error = nullptr) const;

    // Fetches the upcoming queue and returns the NEXT track's cover URL (sized per
    // Config::coverSize), so a host can preload it. If lengthSeconds is non-null it
    // also receives that track's total length in seconds (0 if unknown), letting a
    // host prime a countdown the instant it swaps to the preloaded cover. Returns
    // false on error.
    bool nextCoverUrl(std::string& out, int* lengthSeconds = nullptr) const;

private:
    void run();
    void emitError(const std::string& message) const;

    Config config_;
    CoverChangedCallback onCoverChanged_;
    ErrorCallback onError_;
    TickCallback onTick_;

    std::thread thread_;
    std::atomic<bool> running_{false};
    std::atomic<bool> cancelled_{false}; // set by stop() so in-flight callbacks can bail
    mutable std::mutex mutex_;
    std::condition_variable cv_;
    bool stopRequested_ = false;
    bool refreshRequested_ = false;
    std::string lastCoverUrl_;
};

} // namespace ssc
