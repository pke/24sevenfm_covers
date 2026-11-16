// Tests for the shared render-policy logic behind the performance work: when the
// engine repaints, how fast its heartbeat ticks, visual parity of the pre-scaled
// poster blur, the demo-mode probe cache, and the DirectWrite layout cache key.
// All of it is Win32-free pure logic (same pattern as window_rect.h), compiled
// into the same test binary as test_coverfetch.cpp (which owns doctest's main).
#include "doctest.h"

#include "../../shared/repaint_policy.h"
#include "../../shared/blur_math.h"
#include "../../shared/text_layout_key.h"
#include "../../shared/demo.h"

// --- repaint policy: repaint only while something actually changes -----------
// The old heartbeat invalidated at ~30fps whenever the countdown was visible,
// re-rendering an unchanged frame ~28 times a second. The policy repaints only
// on real activity: a running fade, the rolling-digit animation, a countdown
// value that differs from the last painted one, or the loading state.

static ssc::RenderActivity idleActivity() {
    ssc::RenderActivity a;
    a.fading = false;
    a.loading = false;
    a.overlayRolling = false;
    a.countdownVisible = false;
    a.demoTimed = false;
    a.remaining = -1;
    a.lastPaintedRemaining = -1;
    return a;
}

TEST_CASE("a settled frame is not repainted and idles the heartbeat") {
    const ssc::RenderActivity a = idleActivity();
    CHECK_FALSE(ssc::needsRepaint(a));
    CHECK(ssc::heartbeatIntervalMs(a) == ssc::kHeartbeatIdleMs);
}

TEST_CASE("a running fade repaints at animation rate") {
    ssc::RenderActivity a = idleActivity();
    a.fading = true;
    CHECK(ssc::needsRepaint(a));
    CHECK(ssc::heartbeatIntervalMs(a) == ssc::kHeartbeatFastMs);
}

TEST_CASE("the rolling-digit animation repaints at animation rate") {
    ssc::RenderActivity a = idleActivity();
    a.countdownVisible = true;
    a.overlayRolling = true;     // last render reported the roll still in flight
    a.remaining = 90;
    a.lastPaintedRemaining = 90; // value already painted - the roll alone drives it
    CHECK(ssc::needsRepaint(a));
    CHECK(ssc::heartbeatIntervalMs(a) == ssc::kHeartbeatFastMs);
}

TEST_CASE("a visible countdown repaints only when the value changed") {
    ssc::RenderActivity a = idleActivity();
    a.countdownVisible = true;
    a.remaining = 90;
    a.lastPaintedRemaining = 90;
    CHECK_FALSE(ssc::needsRepaint(a));   // same second painted -> nothing to draw
    a.remaining = 89;
    CHECK(ssc::needsRepaint(a));         // the second ticked over -> one repaint
    // Between value changes the heartbeat only needs to watch for the next tick.
    CHECK(ssc::heartbeatIntervalMs(a) == ssc::kHeartbeatCountdownMs);
}

TEST_CASE("a hidden countdown never forces a repaint, whatever the clock says") {
    ssc::RenderActivity a = idleActivity();
    a.countdownVisible = false;
    a.remaining = 42;             // anchor is running but the overlay is off
    a.lastPaintedRemaining = -1;
    CHECK_FALSE(ssc::needsRepaint(a));
    CHECK(ssc::heartbeatIntervalMs(a) == ssc::kHeartbeatIdleMs);
}

TEST_CASE("loading keeps repainting at watch rate until the cover arrives") {
    ssc::RenderActivity a = idleActivity();
    a.loading = true;
    CHECK(ssc::needsRepaint(a));
    CHECK(ssc::heartbeatIntervalMs(a) == ssc::kHeartbeatCountdownMs);
}

TEST_CASE("timed demo frames keep the heartbeat at watch rate for auto-advance") {
    ssc::RenderActivity a = idleActivity();
    a.demoTimed = true;           // demo frame with seconds > 0: advance must fire on time
    CHECK_FALSE(ssc::needsRepaint(a));
    CHECK(ssc::heartbeatIntervalMs(a) == ssc::kHeartbeatCountdownMs);
}

TEST_CASE("animation rate wins over watch rate when both apply") {
    ssc::RenderActivity a = idleActivity();
    a.loading = true;
    a.fading = true;
    CHECK(ssc::heartbeatIntervalMs(a) == ssc::kHeartbeatFastMs);
}

// --- blur sigma parity: pre-scaling the blur input must not change the look --
// generateBlur used to feed the FULL-RES cover into the Gaussian effect and only
// scale afterwards; now the cover is downscaled to the working resolution first.
// blur(sigma) then scale-by-k looks like scale-by-k then blur(sigma*k), so the
// sigma must be scaled by the same factor as the image.

TEST_CASE("blurSigmaForScaledInput preserves the shipped look for a 500px cover") {
    // INI default 24 on a 500px cover, pre-scaled to the 240px working res.
    CHECK(d2d::blurSigmaForScaledInput(24, 500.0f, 240) == doctest::Approx(24.0f * 240.0f / 500.0f));
}

TEST_CASE("blurSigmaForScaledInput scales up for covers smaller than the working res") {
    CHECK(d2d::blurSigmaForScaledInput(10, 120.0f, 240) == doctest::Approx(20.0f));
}

TEST_CASE("blurSigmaForScaledInput clamps the configured value like the renderer did") {
    CHECK(d2d::blurSigmaForScaledInput(-5, 500.0f, 240) == doctest::Approx(0.0f));
    CHECK(d2d::blurSigmaForScaledInput(999, 240.0f, 240) == doctest::Approx(200.0f)); // cap at 200
}

TEST_CASE("blurSigmaForScaledInput survives degenerate sizes") {
    CHECK(d2d::blurSigmaForScaledInput(24, 0.0f, 240) == doctest::Approx(24.0f));  // unknown src
    CHECK(d2d::blurSigmaForScaledInput(24, -1.0f, 240) == doctest::Approx(24.0f));
    CHECK(d2d::blurSigmaForScaledInput(24, 500.0f, 0) == doctest::Approx(24.0f));  // unknown dst
}

// --- text layout cache key: rebuild a layout only when its inputs changed -----
// renderPoster/drawStatus used to create DirectWrite formats + layouts on every
// frame; the cache rebuilds only when text, wrap width or font size changes.

TEST_CASE("a fresh TextLayoutKey reports every input as changed") {
    d2d::TextLayoutKey k;
    CHECK(k.differs(L"Meddle - Echoes", 300.0f, 24.0f));
}

TEST_CASE("TextLayoutKey matches after assign and differs on any input change") {
    d2d::TextLayoutKey k;
    k.assign(L"Meddle - Echoes", 300.0f, 24.0f);
    CHECK_FALSE(k.differs(L"Meddle - Echoes", 300.0f, 24.0f)); // same frame -> reuse
    CHECK(k.differs(L"Other title",     300.0f, 24.0f));       // track changed
    CHECK(k.differs(L"Meddle - Echoes", 299.0f, 24.0f));       // window resized
    CHECK(k.differs(L"Meddle - Echoes", 300.0f, 25.0f));       // font size changed
}

TEST_CASE("TextLayoutKey treats a null text as empty") {
    d2d::TextLayoutKey k;
    k.assign(nullptr, 100.0f, 12.0f);
    CHECK_FALSE(k.differs(L"", 100.0f, 12.0f));
    CHECK_FALSE(k.differs(nullptr, 100.0f, 12.0f));
}

// --- demo probe cache: the folder is probed once per process ------------------
// Demo::active() is polled from the Winamp gate timer twice a second; the probe
// enumerates a %TEMP% directory on disk, so it must run once and be cached
// (demo.h documents "checked once at start()"), like the log sentinel.

namespace {
int g_probeCalls = 0;
bool probeTrue()  { ++g_probeCalls; return true; }
bool probeFalse() { ++g_probeCalls; return false; }
}

TEST_CASE("resolveActiveOnce calls the probe exactly once and serves the cache") {
    bool cached = false, resolved = false;
    g_probeCalls = 0;
    CHECK(ssc::Demo::resolveActiveOnce(&probeTrue, cached, resolved));
    CHECK(g_probeCalls == 1);
    // Later ticks: cached answer, no disk probe - even if the probe would now
    // say something else (the folder appearing mid-run needs a host restart).
    CHECK(ssc::Demo::resolveActiveOnce(&probeFalse, cached, resolved));
    CHECK(g_probeCalls == 1);
}

TEST_CASE("resolveActiveOnce caches a negative probe too") {
    bool cached = false, resolved = false;
    g_probeCalls = 0;
    CHECK_FALSE(ssc::Demo::resolveActiveOnce(&probeFalse, cached, resolved));
    CHECK_FALSE(ssc::Demo::resolveActiveOnce(&probeTrue, cached, resolved));
    CHECK(g_probeCalls == 1);
}
