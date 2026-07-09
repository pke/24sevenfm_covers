// Console demo: prints the cover URL every time the playing track changes.
#include "coverfetch.h"

#include <chrono>
#include <cstdio>
#include <thread>

int main() {
    ssc::CoverMonitor monitor([](const std::string& url, const ssc::TrackInfo& t) {
        std::printf("Now playing: %s - %s\n", t.artist.c_str(), t.track.c_str());
        std::printf("  cover:     %s\n", url.c_str());
        std::printf("  next poll: in %d s\n\n", t.remainingSeconds);
        std::fflush(stdout);
    });

    monitor.setErrorCallback([](const std::string& msg) {
        std::fprintf(stderr, "[error] %s\n", msg.c_str());
        std::fflush(stderr);
    });

    monitor.start();
    std::printf("Watching Streaming Soundtracks... (Ctrl+C to quit)\n\n");
    std::fflush(stdout);

    // Keep the main thread alive; the monitor does its work in the background.
    for (;;)
        std::this_thread::sleep_for(std::chrono::seconds(60));
}
