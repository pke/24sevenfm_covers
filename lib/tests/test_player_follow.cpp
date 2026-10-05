#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include "../../shared/player_follow.h"
using namespace ssc;
static PlayerEvent event(PlayerActivity activity, uint64_t seq, const char* url = "https://hi5.death.fm/") {
    PlayerEvent e; e.player = "iina"; e.session = "window-1"; e.sequence = seq; e.activity = activity; e.url = url; return e;
}
TEST_CASE("player integration recognizes all five stream hosts without matching local filenames") {
    CHECK(playerStation("https://hi5.streamingsoundtracks.com/") == 0);
    CHECK(playerStation("http://HI1.1980S.FM:80/stream") == 1);
    CHECK(playerStation("https://hi2.adagio.fm/") == 2);
    CHECK(playerStation("http://hi5.death.fm/") == 3);
    CHECK(playerStation("https://hi1.entranced.fm/") == 4);
    for (auto url : {"file:///tmp/death.fm.mp3", "https://death.fm.evil.test/", "https://evil.test/death.fm", "https://death.fm@evil.test/", "https://notdeath.fm/", "death.fm", "https://death.fm:bad/"}) CHECK(playerStation(url) == -1);
}
TEST_CASE("player integration starts switches pauses resumes and stops") {
    PlayerFollow f;
    CHECK(f.apply(event(PlayerActivity::Start, 1)) == PlayerFollow::Change::Show); CHECK(f.station() == 3);
    CHECK(f.apply(event(PlayerActivity::Pause, 2)) == PlayerFollow::Change::Pause); CHECK(f.paused());
    CHECK(f.apply(event(PlayerActivity::Start, 3)) == PlayerFollow::Change::Show); CHECK_FALSE(f.paused());
    CHECK(f.apply(event(PlayerActivity::Start, 4, "https://hi1.adagio.fm/")) == PlayerFollow::Change::Show); CHECK(f.station() == 2);
    CHECK(f.apply(event(PlayerActivity::Stop, 5)) == PlayerFollow::Change::Hide); CHECK(f.station() == -1);
}
TEST_CASE("player integration ignores stale duplicate and malformed events") {
    PlayerFollow f; f.apply(event(PlayerActivity::Start, 4));
    CHECK(f.apply(event(PlayerActivity::Stop, 3)) == PlayerFollow::Change::Ignore);
    CHECK(f.apply(event(PlayerActivity::Stop, 4)) == PlayerFollow::Change::Ignore);
    auto e = event(PlayerActivity::Stop, 5); e.player = "unknown"; CHECK_FALSE(validPlayerEvent(e));
    e.player = "iina"; e.session = "bad/session"; CHECK_FALSE(validPlayerEvent(e));
    e.session = "ok"; e.title = std::string(4097, 'a'); CHECK_FALSE(validPlayerEvent(e));
    CHECK(f.station() == 3);
}
TEST_CASE("player integration foreign streams stop only the owning player") {
    PlayerFollow f; f.apply(event(PlayerActivity::Start, 1));
    auto foreign = event(PlayerActivity::Start, 2, "https://example.org/radio"); foreign.player = "foobar2000";
    CHECK(f.apply(foreign) == PlayerFollow::Change::Ignore); CHECK(f.station() == 3);
    CHECK(f.apply(event(PlayerActivity::Start, 2, "https://example.org/radio")) == PlayerFollow::Change::Hide);
}
TEST_CASE("player integration old window metadata and stops cannot interrupt new owner") {
    PlayerFollow f; f.apply(event(PlayerActivity::Start, 1));
    auto second = event(PlayerActivity::Start, 1, "https://hi1.1980s.fm/"); second.session = "window-2";
    CHECK(f.apply(second) == PlayerFollow::Change::Show);
    CHECK(f.apply(event(PlayerActivity::Stop, 2)) == PlayerFollow::Change::Ignore);
    CHECK(f.apply(event(PlayerActivity::Update, 3)) == PlayerFollow::Change::Ignore); CHECK(f.station() == 1);
}
TEST_CASE("player integration metadata updates do not restart the station") {
    PlayerFollow f; f.apply(event(PlayerActivity::Start, 1));
    auto e = event(PlayerActivity::Update, 2); e.title = "Composer - Cue";
    CHECK(f.apply(e) == PlayerFollow::Change::Update);
    CHECK(f.apply(event(PlayerActivity::Start, 3)) == PlayerFollow::Change::Update);
    f.clear(); CHECK(f.apply(event(PlayerActivity::Update, 4)) == PlayerFollow::Change::Ignore);
}
TEST_CASE("player integration survives more than 64 sequential player windows") {
    PlayerFollow f;
    for(unsigned i=1;i<=80;++i) {
        auto e=event(PlayerActivity::Start,1);e.session="window-"+std::to_string(i);
        CHECK(f.apply(e)==PlayerFollow::Change::Show);
        CHECK(f.session()==e.session);
    }
    auto old=event(PlayerActivity::Stop,2);old.session="window-1";
    CHECK(f.apply(old)==PlayerFollow::Change::Ignore);CHECK(f.station()==3);
}
TEST_CASE("player integration rejects unknown activity and metadata from the previous station") {
    PlayerFollow f;f.apply(event(PlayerActivity::Start,1));
    auto invalid=event(static_cast<PlayerActivity>(77),2);CHECK_FALSE(validPlayerEvent(invalid));
    CHECK(f.apply(event(PlayerActivity::Update,3,"https://1980s.fm/live"))==PlayerFollow::Change::Ignore);CHECK(f.station()==3);
}
