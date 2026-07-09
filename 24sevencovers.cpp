// 24sevencovers - desktop viewer for the Streaming Soundtracks "now playing"
// cover art. Networking, JSON parsing and refresh timing now live in the
// cross-platform library under lib/ (ssc::CoverMonitor); this file only renders
// the cover in an SFML window and downloads the image the library points at.

// NOMINMAX keeps <windows.h> from defining min/max macros that clash with SFML.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>   // OutputDebugStringA - timing goes to the VS Output window

#include <SFML/Graphics.hpp>

#include "lib/coverfetch.h"    // ssc::CoverMonitor - the "now playing" watcher
#include "lib/http_client.h"   // ssc::httpRequest  - reused to fetch the image

#include <atomic>
#include <chrono>
#include <fstream>
#include <iterator>
#include <mutex>
#include <string>

#pragma comment(lib, "ws2_32")
#pragma comment(lib, "opengl32")
#pragma comment(lib, "winmm")
#ifdef DEBUG
    #pragma comment(lib, "sfml-main-d")
#else
    #pragma comment(lib, "sfml-main")
#endif

// Local cache of the last cover, so the window shows something instantly on the
// next launch instead of staying blank during the initial network fetch.
static const char* kCoverCacheFile = "cover.jpg";

// Image bytes handed from the monitor's background thread to the render thread.
static std::mutex g_coverMutex;
static std::string g_pendingImage;
static bool g_hasPending = false;

// --- Timing / logging --------------------------------------------------------
using Clock = std::chrono::steady_clock;
static Clock::time_point g_appStart;
static std::mutex g_logMutex;
static bool g_firstLiveShown = false; // main thread only

// Runtime cover-size toggle (press T): 500 = large art, 0 = medium CoverLink.
static std::atomic<int> g_coverSize{500};
static std::string g_lastOriginalCover; // raw CoverLink of current track; guarded by g_coverMutex

static long msSince(Clock::time_point t) {
    return static_cast<long>(
        std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t).count());
}

// Writes a line to the VS Output window (OutputDebugString) and to timing.log.
static void logLine(const std::string& msg) {
    std::lock_guard<std::mutex> lock(g_logMutex);
    OutputDebugStringA(("[24sevencovers] " + msg + "\n").c_str());
    std::ofstream f("timing.log", std::ios::app);
    f << msg << "\n";
}

static std::string readFile(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in)
        return std::string();
    return std::string(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
}

static void writeFile(const std::string& path, const std::string& data) {
    std::ofstream out(path, std::ios::binary);
    out.write(data.data(), static_cast<std::streamsize>(data.size()));
}

// Rewrites a CoverLink to a specific pixel size: ".../cover/ID.jpg" ->
// ".../cover/<size>/ID.jpg". size <= 0 leaves the (medium) CoverLink as-is.
static std::string sizedUrl(const std::string& original, int size) {
    if (size <= 0)
        return original;
    const std::string marker = "/cover/";
    const auto pos = original.find(marker);
    if (pos == std::string::npos)
        return original;
    std::string result = original;
    result.replace(pos, marker.size(), "/cover/" + std::to_string(size) + "/");
    return result;
}

static const char* sizeLabel(int size) { return size <= 0 ? "medium" : "large-500"; }

// Downloads a cover image over plain HTTP. The library gives us an https:// URL,
// but the server also serves the images on port 80, and our socket client has no
// TLS - so we strip the scheme and always connect on port 80.
static std::string downloadCover(const std::string& url) {
    std::string rest = url;
    const auto scheme = rest.find("://");
    if (scheme != std::string::npos)
        rest = rest.substr(scheme + 3);

    const auto slash = rest.find('/');
    const std::string host = (slash == std::string::npos) ? rest : rest.substr(0, slash);
    const std::string path = (slash == std::string::npos) ? "/" : rest.substr(slash);

    ssc::HttpResponse res = ssc::httpRequest(host, 80, path, "GET");
    if (!res.ok())
        return std::string();
    return res.body;
}

// Loads JPEG/PNG bytes into the texture and scales the sprite to the window.
// Must run on the render thread (owns the GL context).
static void showCover(sf::Texture& texture, sf::Sprite& sprite,
                      const std::string& bytes, unsigned windowSize, const char* source) {
    if (bytes.empty())
        return;
    const auto t0 = Clock::now();
    if (!texture.loadFromMemory(bytes.data(), bytes.size())) {
        logLine(std::string("[render] ") + source + " decode FAILED ("
                + std::to_string(bytes.size()) + " bytes)");
        return;
    }
    sprite.setTexture(texture, true);
    const auto size = texture.getSize();
    if (size.x && size.y) {
        sprite.setScale(static_cast<float>(windowSize) / size.x,
                        static_cast<float>(windowSize) / size.y);
    }
    logLine(std::string("[render] ") + source + " decode+upload=" + std::to_string(msSince(t0))
            + "ms  image=" + std::to_string(size.x) + "x" + std::to_string(size.y)
            + "  bytes=" + std::to_string(bytes.size()));
}

int main() {
    g_appStart = Clock::now();
    { std::ofstream clear("timing.log", std::ios::trunc); } // fresh log each run
    logLine("[startup] app start");
    logLine("[keys] R = refresh now,  T = toggle cover size (large-500 <-> medium)");

    const unsigned kWindowSize = 500;

    sf::Texture coverTexture;
    sf::Sprite cover;
    cover.setPosition(0, 0);

    // The monitor calls this on its own thread every time the cover changes.
    // We only download here and stash the bytes; the GL upload happens on the
    // render thread below.
    ssc::CoverMonitor monitor([](const std::string&, const ssc::TrackInfo& info) {
        const int size = g_coverSize.load();
        const std::string url = sizedUrl(info.originalCover, size);
        {
            std::lock_guard<std::mutex> lock(g_coverMutex);
            g_lastOriginalCover = info.originalCover; // let the T-toggle re-size this cover
        }
        const auto t0 = Clock::now();
        std::string image = downloadCover(url);
        const long dlMs = msSince(t0);
        logLine("[fetch] size=" + std::string(sizeLabel(size)) + "  image-download=" + std::to_string(dlMs)
                + "ms  bytes=" + std::to_string(image.size()) + "  url=" + url);
        if (image.empty())
            return;
        writeFile(kCoverCacheFile, image); // cache for an instant next startup
        std::lock_guard<std::mutex> lock(g_coverMutex);
        g_pendingImage.swap(image);
        g_hasPending = true;
    });
    logLine("[startup] monitor.start() at +" + std::to_string(msSince(g_appStart)) + "ms");
    monitor.start();

    sf::RenderWindow window(sf::VideoMode(kWindowSize, kWindowSize),
                            "Streaming Soundtracks Cover");
    logLine("[startup] window created at +" + std::to_string(msSince(g_appStart)) + "ms");

    // Show the last cover immediately so the window isn't blank while the first
    // live fetch is in flight; it's replaced as soon as that fetch completes.
    showCover(coverTexture, cover, readFile(kCoverCacheFile), kWindowSize, "cache");

    while (window.isOpen()) {
        // Pick up a newly downloaded cover from the monitor thread.
        std::string fresh;
        {
            std::lock_guard<std::mutex> lock(g_coverMutex);
            if (g_hasPending) {
                fresh.swap(g_pendingImage);
                g_hasPending = false;
            }
        }
        if (!fresh.empty()) {
            showCover(coverTexture, cover, fresh, kWindowSize, "live");
            if (!g_firstLiveShown) {
                g_firstLiveShown = true;
                logLine("[startup] TIME-TO-FIRST-LIVE-COVER=" + std::to_string(msSince(g_appStart)) + "ms");
            }
        }

        window.clear();
        window.draw(cover);
        window.display();

        sf::Event event;
        while (window.pollEvent(event)) {
            if (event.type == sf::Event::Closed) {
                window.close();
            }
            else if (event.type == sf::Event::KeyPressed &&
                     event.key.code == sf::Keyboard::Key::R) {
                // Manual refresh: fetch once synchronously on this (render) thread.
                ssc::TrackInfo info;
                if (monitor.pollOnce(info)) {
                    const int size = g_coverSize.load();
                    const std::string url = sizedUrl(info.originalCover, size);
                    {
                        std::lock_guard<std::mutex> lock(g_coverMutex);
                        g_lastOriginalCover = info.originalCover;
                    }
                    const auto t0 = Clock::now();
                    std::string image = downloadCover(url);
                    logLine("[refresh] size=" + std::string(sizeLabel(size)) + "  image-download="
                            + std::to_string(msSince(t0)) + "ms  bytes=" + std::to_string(image.size()));
                    showCover(coverTexture, cover, image, kWindowSize, "refresh");
                }
            }
            else if (event.type == sf::Event::KeyPressed &&
                     event.key.code == sf::Keyboard::Key::T) {
                // Toggle cover size (500 <-> medium) and re-render the current
                // cover at the new size so you can compare quality and download time.
                const int size = (g_coverSize.load() <= 0) ? 500 : 0;
                g_coverSize = size;
                std::string original;
                {
                    std::lock_guard<std::mutex> lock(g_coverMutex);
                    original = g_lastOriginalCover;
                }
                logLine(std::string("[toggle] cover size -> ") + sizeLabel(size));
                if (!original.empty()) {
                    const std::string url = sizedUrl(original, size);
                    const auto t0 = Clock::now();
                    std::string image = downloadCover(url);
                    logLine("[toggle] size=" + std::string(sizeLabel(size)) + "  image-download="
                            + std::to_string(msSince(t0)) + "ms  bytes=" + std::to_string(image.size())
                            + "  url=" + url);
                    if (!image.empty()) {
                        writeFile(kCoverCacheFile, image);
                        showCover(coverTexture, cover, image, kWindowSize, "toggle");
                    }
                }
            }
        }
    }

    monitor.stop();
    return 0;
}
