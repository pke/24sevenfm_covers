#pragma once
#import <AppKit/AppKit.h>
// Overlay chrome keeps the full-size artwork canvas fixed during hover changes.
@interface SSCViewerWindow : NSWindow
@property(nonatomic) BOOL hoverTrackingEnabled;
@property(readonly) NSView* hoverTitlebarView;
- (void)installHoverTitlebar;
- (void)setPointerInsideWindow:(BOOL)inside;
- (NSTimeInterval)titlebarAnimationDuration;
@end
