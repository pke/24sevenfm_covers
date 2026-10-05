#import "hover_titlebar.h"
@interface SSCHoverTitlebar : NSVisualEffectView
@end
@implementation SSCHoverTitlebar
// Native traffic lights and the native drag region stay in charge of input.
- (NSView*)hitTest:(NSPoint)point {return nil;}
@end

@implementation SSCViewerWindow {
    SSCHoverTitlebar* _hoverTitlebar;
    NSTextField* _hoverTitle;
    NSTimer* _hoverTimer;
    BOOL _pointerInside;
    BOOL _fullscreen;
    BOOL _hoverAnimating;
    unsigned _hoverRevision;
}
- (instancetype)initWithContentRect:(NSRect)rect styleMask:(NSWindowStyleMask)style
    backing:(NSBackingStoreType)backing defer:(BOOL)defer {
    self=[super initWithContentRect:rect styleMask:style|NSWindowStyleMaskFullSizeContentView backing:backing defer:defer];
    if(self) {
        self.titlebarAppearsTransparent=YES;self.titleVisibility=NSWindowTitleHidden;
        self.movableByWindowBackground=YES;self.hoverTrackingEnabled=YES;
    }
    return self;
}
- (NSView*)hoverTitlebarView {return _hoverTitlebar;}
- (void)setTitle:(NSString*)title { [super setTitle:title];_hoverTitle.stringValue=title ?: @""; }
- (NSTimeInterval)titlebarAnimationDuration {
    return NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion?0:.25;
}
- (void)installHoverTitlebar {
    if(_hoverTitlebar)return;
    NSView* content=self.contentView;
    _hoverTitlebar=[[SSCHoverTitlebar alloc] initWithFrame:NSMakeRect(0,content.bounds.size.height-32,content.bounds.size.width,32)];
    _hoverTitlebar.autoresizingMask=NSViewWidthSizable|NSViewMinYMargin;
    _hoverTitlebar.material=NSVisualEffectMaterialHUDWindow;
    _hoverTitlebar.blendingMode=NSVisualEffectBlendingModeWithinWindow;
    _hoverTitlebar.state=NSVisualEffectStateActive;
    _hoverTitlebar.appearance=[NSAppearance appearanceNamed:NSAppearanceNameVibrantDark];
    _hoverTitlebar.wantsLayer=YES;
    _hoverTitle=[NSTextField labelWithString:self.title ?: @""];
    _hoverTitle.frame=NSMakeRect(90,8,MAX(1,content.bounds.size.width-180),16);
    _hoverTitle.autoresizingMask=NSViewWidthSizable;
    _hoverTitle.alignment=NSTextAlignmentCenter;
    _hoverTitle.font=[NSFont systemFontOfSize:13 weight:NSFontWeightMedium];
    _hoverTitle.textColor=NSColor.whiteColor;_hoverTitle.lineBreakMode=NSLineBreakByTruncatingMiddle;
    [_hoverTitlebar addSubview:_hoverTitle];[content addSubview:_hoverTitlebar];
    _hoverTitlebar.alphaValue=0;_hoverTitlebar.hidden=YES;
    for(NSNumber* type in @[@(NSWindowCloseButton),@(NSWindowMiniaturizeButton),@(NSWindowZoomButton)]) {
        NSButton* button=[self standardWindowButton:(NSWindowButton)type.integerValue];button.alphaValue=0;
    }
    // Window bounds include the native titlebar/traffic lights. Tracking only the
    // canvas would incorrectly hide chrome while crossing into those controls.
    __weak SSCViewerWindow* weak=self;
    _hoverTimer=[NSTimer scheduledTimerWithTimeInterval:.1 repeats:YES block:^(NSTimer* timer){
        SSCViewerWindow* window=weak;if(!window){[timer invalidate];return;}
        if(!window.hoverTrackingEnabled)return;
        NSPoint point=NSEvent.mouseLocation;
        BOOL inside=window.visible && !window.miniaturized && NSPointInRect(point,window.frame)
            && [NSWindow windowNumberAtPoint:point belowWindowWithWindowNumber:0]==window.windowNumber;
        [window setPointerInsideWindow:inside];
    }];
    [NSRunLoop.mainRunLoop addTimer:_hoverTimer forMode:NSRunLoopCommonModes];
}
- (void)setPointerInsideWindow:(BOOL)inside {
    BOOL fullscreen=(self.styleMask&NSWindowStyleMaskFullScreen)!=0;
    inside=inside && !fullscreen;
    if(!_hoverTitlebar)return;
    if(_pointerInside==inside && _fullscreen==fullscreen) {
        if(!_hoverAnimating)for(NSNumber* type in @[@(NSWindowCloseButton),@(NSWindowMiniaturizeButton),@(NSWindowZoomButton)])
            [self standardWindowButton:(NSWindowButton)type.integerValue].alphaValue=(inside||fullscreen)?1:0;
        return;
    }
    _pointerInside=inside;_fullscreen=fullscreen;unsigned revision=++_hoverRevision;
    _hoverAnimating=YES;
    if(inside)_hoverTitlebar.hidden=NO;
    NSArray* types=@[@(NSWindowCloseButton),@(NSWindowMiniaturizeButton),@(NSWindowZoomButton)];
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext* context){
        context.duration=[self titlebarAnimationDuration];
        _hoverTitlebar.animator.alphaValue=inside?1:0;
        // Keep the native buttons present so Cmd-W/Cmd-M still work while their
        // pixels are faded out. AppKit owns their visibility in fullscreen.
        for(NSNumber* type in types)[self standardWindowButton:(NSWindowButton)type.integerValue].animator.alphaValue=(inside||fullscreen)?1:0;
    } completionHandler:^{
        if(revision!=_hoverRevision)return;
        _hoverAnimating=NO;
        for(NSNumber* type in types)[self standardWindowButton:(NSWindowButton)type.integerValue].alphaValue=(inside||fullscreen)?1:0;
        if(!inside) {
            _hoverTitlebar.hidden=YES;
        }
    }];
}
- (void)close { [_hoverTimer invalidate];_hoverTimer=nil;[super close]; }
- (void)performClose:(id)sender {
    // AppKit's simulated button click can reject an invisible close button.
    // Preserve the viewer delegate's fade/termination path for Cmd-W as well.
    if(!(self.styleMask&NSWindowStyleMaskClosable)){[super performClose:sender];return;}
    id<NSWindowDelegate> delegate=self.delegate;
    if([delegate respondsToSelector:@selector(windowShouldClose:)] && ![delegate windowShouldClose:self])return;
    [self close];
}
- (void)performMiniaturize:(id)sender {
    if(self.styleMask&NSWindowStyleMaskMiniaturizable)[self miniaturize:sender];
    else [super performMiniaturize:sender];
}
- (void)dealloc { [_hoverTimer invalidate]; }
@end
