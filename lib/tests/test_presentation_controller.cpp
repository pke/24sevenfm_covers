#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include "../../shared/presentation_controller.h"
using namespace ssc;
namespace {
ImageReference image(const char* key) { return std::make_shared<const std::string>(key); }
float contribution(const std::vector<ImageLayer>& layers, const std::string& key) {
    float result = 0;
    for (const auto& layer : layers) result = result * (1-layer.opacity) + (*layer.image == key ? layer.opacity : 0);
    return result;
}
}
TEST_CASE("artwork interrupts at the visible mixture and releases retired resources") {
    PresentationTime now = 0; PresentationController view([&] { return now; });
    auto a = image("a"); std::weak_ptr<const std::string> weak = a;
    auto token = view.trackChanged("a"); view.assetReady(token, a); a.reset();
    now = 1000; view.advance();
    token = view.trackChanged("b"); view.assetReady(token, image("b"));
    now = 1400; auto before = view.advance().cover;
    token = view.trackChanged("c"); view.assetReady(token, image("c"));
    const auto after = view.advance().cover;
    CHECK(contribution(before, "a") == doctest::Approx(contribution(after, "a")));
    CHECK(contribution(before, "b") == doctest::Approx(contribution(after, "b")));
    CHECK_FALSE(weak.expired()); before.clear();
    now = 2400; CHECK(view.advance().cover.size() == 1);
    // A retained FrameState deliberately owns its resources until its reader retires.
    CHECK_FALSE(weak.expired());
}
TEST_CASE("late operations never replace current track and backdrop does not restart cover or countdown") {
    PresentationTime now = 100; PresentationController view([&] { return now; });
    PresentationSettings settings; settings.countdown = true; settings.rolling = true; view.settingsChanged(settings);
    auto a = view.trackChanged("station-a/track"); view.assetReady(a, image("a"));
    auto b = view.trackChanged("station-b/track"); view.assetReady(b, image("b"));
    CHECK_FALSE(view.assetReady(a, image("stale")));
    CHECK_FALSE(view.resolverCompleted(a, L"stale", L"", L"", L"", true));
    view.remainingChanged(120); now = 1100; view.advance();
    view.remainingChanged(119); view.advance(); now = 1250;
    const auto before = view.advance(); view.assetReady(b, image("late backdrop"), true); view.setLogo("logo", L"b");
    const auto after = view.advance(); CHECK(after.cover.size() == 1);
    CHECK(before.countdown.columns.back().layers.back().offset == after.countdown.columns.back().layers.back().offset);
    auto options = view.newOperation(); CHECK_FALSE(view.assetReady(b, image("obsolete options"), true));
    CHECK(view.assetReady(options, {}, true));
}
TEST_CASE("interruptions preserve partial entry opacity and flip shading") {
    ArtworkPresentation art;
    art.set(image("a"),0,1000); const auto entering=art.sample(250);
    art.set(image("b"),250,1000);
    CHECK(contribution(art.sample(250),"a")==doctest::Approx(contribution(entering,"a")));
    art.sample(1250); art.set(image("c"),1250,1000,2);
    const auto flip=art.sample(1500); REQUIRE(flip.size()==1);
    art.set(image("d"),1500,1000,2); const auto interrupted=art.sample(1500);
    CHECK(interrupted[0].scaleX==flip[0].scaleX);
    CHECK(interrupted[0].opacity==doctest::Approx(flip[0].opacity));
}
TEST_CASE("settings changes preserve current artwork and measured geometry; reduced motion finishes all channels") {
    PresentationTime now = 0; PresentationController view([&] { return now; });
    view.setArtwork(image("a")); now = 1000; view.advance(); view.setArtwork(image("b"));
    now = 1400; auto before = view.advance();
    PresentationSettings settings; settings.fadeMs = 2000; settings.poster = true; view.settingsChanged(settings);
    CHECK(contribution(view.advance().cover, "b") == doctest::Approx(contribution(before.cover, "b")));
    view.measured(VisualChannel::InfoWidth, 200); view.measured(VisualChannel::InfoWidth, 400);
    now += 175; CHECK(view.advance().infoWidth == doctest::Approx(300));
    view.measured(VisualChannel::InfoWidth, 100); CHECK(view.advance().infoWidth == doctest::Approx(300));
    settings.reducedMotion = true; settings.countdown = true; view.settingsChanged(settings); view.remainingChanged(60);
    view.measured(VisualChannel::InfoWidth, 100);
    const auto frame = view.advance(); CHECK(frame.cover.size() == 1); CHECK(frame.infoWidth == 100);
    CHECK(frame.countdown.opacity == 1); CHECK(frame.poster == 1);
}
TEST_CASE("each view owns independent timing and monotone clocks tolerate a backwards provider") {
    PresentationTime now = 0; PresentationController first([&] { return now; }), second([&] { return now; });
    first.setArtwork(image("a")); now = 500; auto before = first.advance();
    CHECK(second.advance().cover.empty()); now = 100;
    CHECK(first.advance().cover[0].opacity == before.cover[0].opacity);
}
TEST_CASE("countdown interruption retains digit offsets and unchanged columns do not roll") {
    CountdownPresentation countdown; countdown.set(185, true, 0, 350); countdown.sample(0);
    countdown.set(184, true, 10, 350); auto frame = countdown.sample(185);
    CHECK(frame.columns[0].layers.size() == 1); CHECK(frame.columns[0].layers[0].offset == 0);
    const auto before = frame.columns.back().layers;
    countdown.set(183, true, 185, 350); frame = countdown.sample(185);
    REQUIRE(frame.columns.back().layers.size() >= before.size());
    CHECK(frame.columns.back().layers[0].offset == before[0].offset);
    CHECK(frame.columns.back().layers[0].opacity == before[0].opacity);
}
TEST_CASE("resource references expire after completed exit and no retained reader") {
    PresentationTime now = 0; PresentationController view([&] { return now; });
    auto resource = image("a"); std::weak_ptr<const std::string> weak = resource;
    view.setArtwork(resource); resource.reset(); now = 1000; view.advance();
    view.setArtwork({}); CHECK_FALSE(weak.expired()); now = 2000; view.advance(); CHECK(weak.expired());
}

TEST_CASE("metadata duration changes are continuous and failures retain the outgoing title") {
    InfoPresentation info;
    info.begin("a",0,1000); info.settle(L"A",L"Artist",true,0,1000,L"A",L"Track");
    CHECK(info.advance(400,1000)==doctest::Approx(.4));
    CHECK(info.advance(400,2000)==doctest::Approx(.4));
    CHECK(info.advance(1400,2000)==doctest::Approx(.7));
    info.begin("failed",1400,2000);
    CHECK(info.title()==L"A");
    info.settle(L"",L"",false,1500,2000);
    CHECK(info.advance(2400,2000)==doctest::Approx(.35));
    CHECK(info.title()==L"A");
    CHECK(info.advance(3400,2000)==0); CHECK(info.title().empty());
}
TEST_CASE("ratings introductions and pointer visibility share one independent timeline") {
    PresentationTime now=0; PresentationController view([&]{return now;});
    PresentationSettings settings; settings.ratings=true; view.settingsChanged(settings);
    view.trackChanged("a"); view.ratingsChanged(true); view.advance();
    now=350; CHECK(view.advance().ratingOpacity==1);
    now=11000; view.advance(); now=11350; CHECK(view.advance().ratingOpacity==0);
    view.setLogo("late",L"a"); view.ratingsChanged(true); CHECK(view.advance().ratingOpacity==0);
    view.pointerChanged(true,true,true); view.advance(); now+=350; CHECK(view.advance().ratingOpacity==1);
    now+=2000; view.advance(); now+=350; CHECK(view.advance().ratingOpacity==0);
    view.pointerChanged(true,false,true); view.advance(); now+=350; CHECK(view.advance().ratingOpacity==1);
    view.pointerChanged(false,false,false); view.advance(); now+=350; CHECK(view.advance().ratingOpacity==0);
}
TEST_CASE("rating content interruptions retain every outgoing translucent layer") {
    ArtworkPresentation ratings(false);
    ratings.set(image("a"),0,350); ratings.sample(350);
    ratings.set(image("b"),350,350); const auto before=ratings.sample(525);
    ratings.set(image("c"),525,350); const auto after=ratings.sample(525);
    REQUIRE(before.size()==2); REQUIRE(after.size()>=2);
    CHECK(before[0].opacity==doctest::Approx(.5)); CHECK(before[1].opacity==doctest::Approx(.5));
    CHECK(after[0].opacity==before[0].opacity); CHECK(after[1].opacity==before[1].opacity);
    const auto settled=ratings.sample(875); REQUIRE(settled.size()==1); CHECK(*settled[0].image=="c");
}
TEST_CASE("shared geometry keeps countdown inside poster and queue at the logical trailing edge") {
    PresentationTime now=0; PresentationController view([&]{return now;});
    PresentationSettings settings; settings.poster=true; settings.countdown=true; settings.next=true; settings.reducedMotion=true;
    view.settingsChanged(settings); view.remainingChanged(9);
    view.comingNext.setQueue("b",L"Next",L"Artist");
    view.measured(VisualChannel::InfoWidth,280); view.measured(VisualChannel::InfoHeight,160);
    view.measured(VisualChannel::NextWidth,240); view.measured(VisualChannel::NextHeight,80);
    for (auto size : {std::pair<float,float>{440,640},{980,560},{3840,2160}}) {
        for (bool rtl:{false,true}) {
            view.viewportChanged(size.first,size.second,1,rtl); const auto f=view.advance();
            CHECK(f.coverRect.y+f.coverRect.height<=f.infoRect.y);
            CHECK(f.countdownRect.y>=f.infoRect.y);
            CHECK(f.countdownRect.y+f.countdownRect.height<=f.infoRect.y+f.infoRect.height);
            CHECK(f.nextRect.x==doctest::Approx(rtl?14:size.first-254));
        }
    }
}
TEST_CASE("late and disabled queue covers release after the exit while the countdown continues") {
    PresentationTime now=0; PresentationController view([&]{return now;});
    PresentationSettings settings; settings.next=true; settings.countdown=true; view.settingsChanged(settings);
    view.remainingChanged(9); view.comingNext.setQueue("a",L"Next",L"Artist"); view.advance(); now=250;
    CHECK(view.advance().next.opacity==1); view.comingNext.setCover("stale","wrong"); CHECK_FALSE(view.advance().next.cover);
    view.comingNext.setCover("a","right"); CHECK(view.advance().next.coverOpacity==0);
    now=500; auto resource=view.advance().next.cover; std::weak_ptr<const std::string> weak=resource; resource.reset();
    settings.next=false; view.settingsChanged(settings); CHECK(view.advance().next.cover);
    view.comingNext.setQueue("",L"",L""); now=750; const auto f=view.advance();
    CHECK_FALSE(f.next.cover); CHECK(weak.expired()); CHECK(f.countdown.seconds==9); CHECK(f.countdown.opacity==1);
}

TEST_CASE("coming next enters with final geometry and never chases its cover opacity") {
    PresentationTime now = 0; PresentationController view([&] { return now; });
    PresentationSettings settings; settings.next = true;
    view.settingsChanged(settings); view.viewportChanged(1000, 700);
    view.remainingChanged(20); view.advance(); view.measuredNext(90, 30); view.advance();
    view.comingNext.setQueue("next", L"Album", L"Composer");
    view.comingNext.setCover("next", "pixels"); view.remainingChanged(10);
    view.advance(); view.measuredNext(240, 45);
    auto frame = view.advance(); const auto width = frame.nextRect.width, height = frame.nextRect.height;
    CHECK(width > 300); CHECK(height >= 76); CHECK(frame.nextCoverLayout == 1);
    CHECK(frame.next.opacity == 0); CHECK(frame.next.coverOpacity == 0);
    float previousX = frame.nextRect.x;
    for (now = 10; now <= 250; now += 10) {
        view.advance(); view.measuredNext(240, 45); frame = view.advance();
        CHECK(frame.nextRect.width == width); CHECK(frame.nextRect.height == height);
        CHECK(frame.nextCoverLayout == 1);
        CHECK(frame.nextRect.x <= previousX); previousX = frame.nextRect.x;
    }
    CHECK(frame.next.opacity == 1); CHECK(frame.next.coverOpacity == 1);
    CHECK_FALSE(view.channel(VisualChannel::NextWidth).active(now));
    CHECK_FALSE(view.channel(VisualChannel::NextHeight).active(now));
}

TEST_CASE("a late queue cover finishes one size transition while repeated measurements continue") {
    PresentationTime now = 0; PresentationController view([&] { return now; });
    PresentationSettings settings; settings.next = true;
    view.settingsChanged(settings); view.viewportChanged(1000, 700); view.remainingChanged(9);
    view.comingNext.setQueue("next", L"Album", L"Composer"); view.advance(); view.measuredNext(180, 40);
    now = 500; auto before = view.advance();
    view.comingNext.setCover("next", "pixels"); view.advance(); view.measuredNext(180, 40);
    CHECK(view.advance().nextWidth == before.nextWidth);
    const auto target = view.channel(VisualChannel::NextWidth).target();
    for (now = 510; now <= 750; now += 10) {
        view.advance(); view.measuredNext(180, 40); const auto frame = view.advance();
        const float fraction = float(now - 500) / 250;
        CHECK(frame.nextWidth == doctest::Approx(before.nextWidth + (target-before.nextWidth)*fraction));
        CHECK(frame.nextCoverLayout == doctest::Approx(fraction));
    }
    CHECK(view.frame().nextWidth == target);
    CHECK_FALSE(view.channel(VisualChannel::NextWidth).active(now));
    // Disabling still retains the complete outgoing card through the fade.
    settings.next = false; view.settingsChanged(settings); view.advance();
    now += 100; CHECK(view.advance().next.cover); CHECK(view.frame().nextWidth == target);
}

TEST_CASE("relative countdown sizes retain Windows fill and poster scaling through resize") {
    PresentationTime now = 0; PresentationController view([&] { return now; });
    PresentationSettings settings; settings.countdown = true;
    settings.countdownSizing = CountdownSizing::ViewportRelative;
    const float fractions[] = {.048f, .062f, .080f};
    for (auto viewport : {std::pair<float,float>{600,900}, {1920,1080}, {3840,2160}}) {
        for (bool poster : {false, true}) for (int size = 0; size < 3; ++size) {
            settings.poster = poster; settings.countdownSize = size;
            view.settingsChanged(settings); view.viewportChanged(viewport.first,viewport.second,2);
            now += 350; const auto frame = view.advance();
            const auto basis = poster ? std::min(viewport.second*.58f,viewport.first*.86f) : viewport.second;
            CHECK(frame.countdown.fontSize == doctest::Approx(std::max(poster?12.f:10.f,basis*fractions[size])));
            // Physical client pixels already contain the Windows DPI scaling.
            CHECK(frame.countdown.fontSize < basis*.1f);
        }
    }
    const float before = view.frame().countdown.fontSize;
    view.viewportChanged(1920,1080,1); CHECK(view.advance().countdown.fontSize == before);
    now += 175; CHECK(view.advance().countdown.fontSize == doctest::Approx(before*.75f));
    settings.reducedMotion = true; view.settingsChanged(settings);
    CHECK(view.advance().countdown.fontSize == doctest::Approx(before*.5f));
    settings.countdownSizing = CountdownSizing::Fixed; view.settingsChanged(settings);
    CHECK(view.advance().countdown.fontSize == 48); // existing AppKit logical-point option
}

TEST_CASE("hidden countdown ticks never request animation but its exit fade still does") {
    PresentationTime now=0; PresentationController view([&]{return now;});
    PresentationSettings settings; settings.countdown=false; settings.rolling=true;
    view.settingsChanged(settings); view.viewportChanged(680,820); view.remainingChanged(180);
    now=1000; view.advance();
    for(now=2000;now<7000;now+=16) {
        view.remainingChanged(180-int(now/1000));
        CHECK_FALSE(view.advance().animating);
        CHECK(view.frame().countdown.opacity==0);
    }
    settings.countdown=true;view.settingsChanged(settings);view.advance();
    now+=175;CHECK(view.advance().animating);CHECK(view.frame().countdown.opacity>0);
    now+=1000;view.advance();
    settings.countdown=false;view.settingsChanged(settings);view.advance();
    now+=175;CHECK(view.advance().animating);CHECK(view.frame().countdown.opacity>0);
    now+=1000;CHECK_FALSE(view.advance().animating);CHECK(view.frame().countdown.opacity==0);
    view.remainingChanged(42);CHECK_FALSE(view.advance().animating);
}
