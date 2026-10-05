#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "../../lib/tests/doctest.h"
#import "hover_titlebar.h"
static void settle(double seconds=.35) {
    NSDate* until=[NSDate dateWithTimeIntervalSinceNow:seconds];
    while(until.timeIntervalSinceNow>0) [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.01]];
}
@interface AnimatedWindow : SSCViewerWindow
@end
@implementation AnimatedWindow
- (NSTimeInterval)titlebarAnimationDuration {return .25;}
@end
static SSCViewerWindow* window(Class type=AnimatedWindow.class) {
    [NSApplication sharedApplication];
    SSCViewerWindow* w=[[type alloc] initWithContentRect:NSMakeRect(0,0,680,760)
        styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskMiniaturizable|NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    w.releasedWhenClosed=NO;w.hoverTrackingEnabled=NO;
    w.title=@"Death.FM — 24seven.fm Covers";[w orderFront:nil];settle(.05);[w installHoverTitlebar];return w;
}
@interface ReducedMotionWindow : SSCViewerWindow
@end
@implementation ReducedMotionWindow
- (NSTimeInterval)titlebarAnimationDuration {return 0;}
@end
@interface CloseProbe : NSObject <NSWindowDelegate>
@property BOOL requested;
@end
@implementation CloseProbe
- (BOOL)windowShouldClose:(NSWindow*)window {self.requested=YES;return NO;}
@end
TEST_CASE("Mac hover titlebar starts hidden over a full-size fixed canvas") {
    @autoreleasepool {
        auto w=window();
        REQUIRE(bool(w.hoverTitlebarView!=nil));
        CHECK(w.titlebarAppearsTransparent);CHECK(w.titleVisibility==NSWindowTitleHidden);
        CHECK((w.styleMask&NSWindowStyleMaskFullSizeContentView)!=0);
        CHECK(w.hoverTitlebarView.hidden);CHECK(w.hoverTitlebarView.alphaValue==0);
        CHECK([w standardWindowButton:NSWindowCloseButton].alphaValue==0);
        NSRect frame=w.frame;NSRect canvas=((NSView*)w.contentView).frame;
        [w setPointerInsideWindow:YES];settle();
        CHECK_FALSE(w.hoverTitlebarView.hidden);CHECK(w.hoverTitlebarView.alphaValue==doctest::Approx(1));
        CHECK([w standardWindowButton:NSWindowCloseButton].alphaValue==doctest::Approx(1));
        CHECK(NSEqualRects(frame,w.frame));CHECK(NSEqualRects(canvas,((NSView*)w.contentView).frame));
        [w close];
    }
}
TEST_CASE("Mac hover titlebar retains outgoing chrome and cancels an old hide") {
    @autoreleasepool {
        auto w=window();REQUIRE(bool(w.hoverTitlebarView!=nil));
        [w setPointerInsideWindow:YES];settle();
        [w setPointerInsideWindow:NO];
        CHECK_FALSE(w.hoverTitlebarView.hidden);
        CHECK_FALSE([w standardWindowButton:NSWindowCloseButton].hidden);
        settle(.05);[w setPointerInsideWindow:YES];settle();
        CHECK_FALSE(w.hoverTitlebarView.hidden);CHECK(w.hoverTitlebarView.alphaValue==doctest::Approx(1));
        CHECK([w standardWindowButton:NSWindowCloseButton].alphaValue==doctest::Approx(1));
        [w setPointerInsideWindow:NO];settle();
        CHECK(w.hoverTitlebarView.hidden);CHECK([w standardWindowButton:NSWindowCloseButton].alphaValue==0);
        [w close];
    }
}
TEST_CASE("Mac hover titlebar respects reduced motion and native title changes") {
    @autoreleasepool {
        auto w=window(ReducedMotionWindow.class);REQUIRE(bool(w.hoverTitlebarView!=nil));
        [w setPointerInsideWindow:YES];settle(.02);
        CHECK(w.hoverTitlebarView.alphaValue==1);
        w.title=@"1980s.FM — 24seven.fm Covers";
        NSTextField* label=nil;
        for(NSView* view in w.hoverTitlebarView.subviews)if([view isKindOfClass:NSTextField.class])label=(NSTextField*)view;
        REQUIRE(bool(label!=nil));CHECK([label.stringValue isEqual:w.title]);
        [w setPointerInsideWindow:NO];settle(.02);CHECK(w.hoverTitlebarView.hidden);
        CloseProbe* close=[CloseProbe new];w.delegate=close;
        [w orderFront:nil];[w performClose:nil];CHECK(close.requested);[w close];
    }
}
