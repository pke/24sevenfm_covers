#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include "../../shared/repaint_policy.h"

using ssc::HeartbeatState;

TEST_CASE("a settled frame is not repainted, even with a visible countdown") {
    HeartbeatState s; s.shownSeconds = 42; s.paintedSeconds = 42; s.msToNextSecond = 600;
    CHECK_FALSE(ssc::needsRepaint(s));
    s.shownSeconds = -1; s.paintedSeconds = -1; s.msToNextSecond = 0;
    CHECK_FALSE(ssc::needsRepaint(s));
}

TEST_CASE("animations and changed countdown values repaint") {
    HeartbeatState s; s.animating = true;
    CHECK(ssc::needsRepaint(s));
    s.animating = false; s.shownSeconds = 41; s.paintedSeconds = 42;
    CHECK(ssc::needsRepaint(s));
    s.shownSeconds = -1; // countdown hidden after it was shown
    CHECK(ssc::needsRepaint(s));
}

TEST_CASE("the heartbeat runs at animation rate only while animating") {
    HeartbeatState s; s.animating = true; s.msToNextSecond = 700;
    CHECK(ssc::heartbeatIntervalMs(s) == ssc::kHeartbeatAnimationMs);
    s.animating = false; s.msToNextSecond = 0;
    CHECK(ssc::heartbeatIntervalMs(s) == ssc::kHeartbeatWatchMs);
}

TEST_CASE("a running countdown wakes just after its next second boundary") {
    HeartbeatState s; s.msToNextSecond = 120;
    CHECK(ssc::heartbeatIntervalMs(s) == 122);
    s.msToNextSecond = 900; // farther than the watch interval
    CHECK(ssc::heartbeatIntervalMs(s) == ssc::kHeartbeatWatchMs);
    s.msToNextSecond = 1;
    CHECK(ssc::heartbeatIntervalMs(s) == ssc::kHeartbeatMinimumMs);
}

TEST_CASE("second boundaries follow the countdown anchor, across tick wrap-around") {
    CHECK(ssc::msUntilNextSecond(1000, 1000) == 1000);
    CHECK(ssc::msUntilNextSecond(1250, 1000) == 750);
    CHECK(ssc::msUntilNextSecond(1999, 1000) == 1);
    CHECK(ssc::msUntilNextSecond(100, 0xFFFFFF00u) == 1000 - (100 + 0x100) % 1000);
}

TEST_CASE("the settled end state of an animation is painted once") {
    HeartbeatState s; s.shownSeconds = 41; s.paintedSeconds = 41;
    s.paintedAnimating = true; // last paint was mid-roll; the roll has just finished
    CHECK(ssc::needsRepaint(s));
    s.paintedAnimating = false; // the end state is on screen
    CHECK_FALSE(ssc::needsRepaint(s));
}
