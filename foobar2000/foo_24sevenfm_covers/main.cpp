// main.cpp - foobar2000 component entry: version declaration + Direct2D lifetime.
//
// Companion to the Winamp gen_ plugin. Same job (show the cover art of the track
// playing on Streaming Soundtracks / 24seven.fm), same shared rendering + library
// code (../../shared/d2d_*.cpp, ../../lib), just wrapped in foobar2000's SDK: a
// dockable Default-UI element instead of a gen_ff frame, and playback callbacks
// instead of Winamp IPC.
#include <SDK/foobar2000.h>

#include "d2d_renderer.h"   // shared GPU renderer (from ../../shared)
#include "cover_engine.h"   // shared cover/preload/animation engine (from ../../shared)
#include "foobar_settings.h"
#include "foo_version.h"    // this module's version; SSC_COPYRIGHT via shared/version.h

DECLARE_COMPONENT_VERSION(
    "24seven.fm Covers",
    SSC_VER_STR,
    "Cover art for the Streaming Soundtracks (24seven.fm) stream, shown in a "
    "dockable, GPU-rendered foobar2000 UI element.\n\n"
    "Shares its rendering + cover-fetch code with the Winamp version.\n"
    SSC_COPYRIGHT);

// Prevents renaming the component around (troubleshooter) and double-loading.
VALIDATE_COMPONENT_FILENAME("foo_24sevenfm_covers.dll");

namespace {

// Direct2D + the cover engine keep process-global single-instance state, so set
// them up once at startup and tear them down at shutdown rather than per UI-element.
// The engine's CoverMonitor starts fetching immediately; the UI element (when the
// user's layout creates it) just hands the engine its HWND to draw into.
class ssc_initquit : public initquit {
public:
    void on_init() override {
        d2d::init();
        ssccfg::loadIntoEngine();
        CoverEngine::instance().start();
    }
    void on_quit() override {
        CoverEngine::instance().stop();
        d2d::shutdown();
    }
};
static initquit_factory_t<ssc_initquit> g_ssc_initquit;

} // namespace
