// demo.h - screenshot/demo cover source. When the folder %TEMP%\24seven.fm-covers-demo\
// exists with at least one image, the CoverEngine runs in "demo mode": it plays that
// folder's covers (a filename-sorted sequence) instead of fetching from a station, so
// screenshots/videos can use chosen covers + metadata + a countdown. Delete the folder
// to return to live (checked once at start()).
//
// Folder contents:
//   *.jpg / *.png  - the cover sequence, shown in filename order (name them 01.jpg, ...)
//   demo.txt       - optional; one line per cover (same order):  Album | Track | Artist | Seconds
//                    Seconds seeds the countdown AND the auto-advance duration; 0 = static.
//
// This is a drop-in: the engine swaps the CoverMonitor for a Demo when the sentinel is
// present. Everything downstream (decode, crossfade, poster, countdown, fullscreen) is
// the unchanged real engine. See CoverEngine::start() / demoNext() / showDemoFrame().
#ifndef SSC_DEMO_H
#define SSC_DEMO_H

#include <string>
#include <vector>

namespace ssc {

struct DemoFrame {
    std::string bytes;                 // raw image (jpg/png)
    std::string album, track, artist;  // poster-mode overlay text
    int seconds = 0;                   // countdown seed + auto-advance duration; 0 = static
};

class Demo {
public:
    static bool active();              // the sentinel: demo folder exists with >=1 image
    bool load();                       // read the sequence + demo.txt; false if no images
    int  count() const { return (int)frames_.size(); }
    const DemoFrame& current() const { return frames_[index_]; }
    void advance() { if (!frames_.empty()) index_ = (index_ + 1) % (int)frames_.size(); }

private:
    std::vector<DemoFrame> frames_;
    int index_ = 0;
};

} // namespace ssc

#endif // SSC_DEMO_H
