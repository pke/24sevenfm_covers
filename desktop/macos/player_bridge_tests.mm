#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "../../lib/tests/doctest.h"
#import "player_bridge.h"
TEST_CASE("Mac bridge preserves literal Unicode metadata through a URL round trip") {
    @autoreleasepool {
        ssc::PlayerEvent e; e.player="foobar2000";e.session="foobar-test";e.sequence=123;e.activity=ssc::PlayerActivity::Start;
        e.url="https://hi5.death.fm/?a=b&c=d";e.title="Café — Cue & \"$(touch /tmp/no)\"";
        NSURL* url=SSCPlayerEventURL(e); REQUIRE(bool(url != nil));
        ssc::PlayerEvent parsed; REQUIRE(SSCParsePlayerEventURL(url,parsed));
        CHECK(parsed.url==e.url);CHECK(parsed.title==e.title);CHECK(parsed.sequence==123);CHECK(parsed.player==e.player);
    }
}
TEST_CASE("Mac bridge rejects malformed URLs without mutating the event") {
    @autoreleasepool {
        for(NSString* address in @[@"https://follow?player=iina", @"x24sevenfm-covers://wrong", @"x24sevenfm-covers://follow?player=iina&session=x&seq=1&state=start&url=&title=&seq=2", @"x24sevenfm-covers://follow?player=iina&session=x&seq=-1&state=start&url=&title=", @"x24sevenfm-covers://follow?player=iina&session=x&seq=1&state=bogus&url=&title="]) {
            ssc::PlayerEvent e;e.player="unchanged";CHECK_FALSE(SSCParsePlayerEventURL([NSURL URLWithString:address],e));CHECK(e.player=="unchanged");
        }
    }
}
TEST_CASE("Mac bridge rejects NUL fields and invalid UTF8 instead of truncating them") {
    @autoreleasepool {
        ssc::PlayerEvent e;
        CHECK_FALSE(SSCParsePlayerEventURL([NSURL URLWithString:@"x24sevenfm-covers://follow?player=iina&session=x&seq=1&state=start&url=https%3A%2F%2Fdeath.fm%2Flive&title=ok%00hidden"],e));
        e.player="iina";e.session="ok";e.sequence=1;e.activity=ssc::PlayerActivity::Start;e.title="\xff";
        CHECK(bool(SSCPlayerEventURL(e)==nil));
    }
}
