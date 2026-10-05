#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#include "../../lib/coverfetch.h"
#include "../../lib/image_probe.h"
#include "../../lib/media_resolver.h"
#include "../../lib/media_policy.h"
#include "../../shared/presentation_pipeline.h"
#include "../../shared/presentation_style.h"
#include "../../shared/presentation_controller.h"
#include <set>
#include "../../shared/image_alpha_bounds.h"
#include "../../shared/stations.h"
#include "../../shared/settings_schema.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <memory>

static NSString* text(const std::string& s) { return [NSString stringWithUTF8String:s.c_str()] ?: @""; }
static NSUserDefaults* preferences() {
    static NSUserDefaults* store;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        if (NSProcessInfo.processInfo.environment[@"SSC_UI_CHECK_DIR"].length) {
            NSString* suite = @"app.dudesoft.24sevenfm.covers.ui-check";
            store = [[NSUserDefaults alloc] initWithSuiteName:suite];
            [store removePersistentDomainForName:suite];
        } else store = NSUserDefaults.standardUserDefaults;
    });
    return store;
}
static double now() { return CACurrentMediaTime(); }
static double duration() { return NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion ? 0.0 : 0.45; }
static double nextDuration() { return NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion ? 0.0 : ssc::kComingNextTransitionMs / 1000.0; }
static double ratingDuration() { return NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion ? 0.0 : ssc::kRatingVisibilityFadeMs / 1000.0; }
static double progress(double start, double seconds) {
    if (seconds <= 0) return 1;
    double t = std::clamp((now() - start) / seconds, 0.0, 1.0);
    return t * t * (3 - 2 * t);
}
static NSImage* decode(const std::string& bytes) {
    if (!ssc::decodableImage(bytes)) return nil;
    return [[NSImage alloc] initWithData:[NSData dataWithBytes:bytes.data() length:bytes.size()]];
}
static NSImage* downloadCover(const std::string& address, int station, const std::atomic<bool>* cancel) {
    NSURL* url = [NSURL URLWithString:text(address)];
    if (!url || ![url.host isEqualToString:text(ssc::station(station).host)] || url.user || url.password) return nil;
    // Covers and station logos use the same pinned station host and native TLS.
    NSString* path = url.path;
    if (url.query.length) path = [path stringByAppendingFormat:@"?%@", url.query];
    auto response = ssc::httpRequest(ssc::station(station).host, 443, path.UTF8String, "GET", "", "", 12, cancel);
    return response.ok() ? decode(response.body) : nil;
}
@interface SSCTitleLogoImage : NSImage
@property(nonatomic) float horizontalAnchor;
@end
@implementation SSCTitleLogoImage
@end
static float logoHorizontalAnchor(NSImage* image) {
    return [image isKindOfClass:SSCTitleLogoImage.class] ? ((SSCTitleLogoImage*)image).horizontalAnchor : .5f;
}
static NSImage* decodeLogo(const std::string& bytes) {
    NSImage* original = decode(bytes); if (!original) return nil;
    CGImageRef source = [original CGImageForProposedRect:nil context:nil hints:nil];
    if (!source) return nil;
    unsigned width = (unsigned)CGImageGetWidth(source), height = (unsigned)CGImageGetHeight(source);
    double scale = std::min(1.0, (double)ssc::kLogoScanMaximum / std::max(width, height));
    width = std::max(1u, (unsigned)(width * scale)); height = std::max(1u, (unsigned)(height * scale));
    std::vector<unsigned char> pixels((size_t)width * height * 4);
    CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(pixels.data(), width, height, 8, width * 4, color,
        kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    CGColorSpaceRelease(color); if (!context) return nil;
    CGContextDrawImage(context, CGRectMake(0, 0, width, height), source);
    auto bounds = ssc::visibleAlphaBounds(pixels.data(), width, height, width * 4);
    NSImage* result = nil;
    if (bounds.right > bounds.left && bounds.bottom > bounds.top) {
        CGImageRef bitmap = CGBitmapContextCreateImage(context);
        CGImageRef cropped = CGImageCreateWithImageInRect(bitmap, CGRectMake(bounds.left, bounds.top,
            bounds.right - bounds.left, bounds.bottom - bounds.top));
        if (cropped) {
            SSCTitleLogoImage* logo = [[SSCTitleLogoImage alloc] initWithCGImage:cropped
                size:NSMakeSize(bounds.right - bounds.left, bounds.bottom - bounds.top)];
            logo.horizontalAnchor = ssc::titleLogoHorizontalAnchor(pixels.data(), width, height, width * 4, bounds);
            result = logo; CGImageRelease(cropped);
        }
        CGImageRelease(bitmap);
    }
    CGContextRelease(context); return result;
}

@interface SSCStationCell : NSButtonCell
@end
@implementation SSCStationCell
- (void)drawInteriorWithFrame:(NSRect)frame inView:(NSView*)view {
    [super drawInteriorWithFrame:NSInsetRect(frame, 12, 0) inView:view];
}
@end

@interface SSCStationButton : NSButton
@end
@implementation SSCStationButton
+ (Class)cellClass { return SSCStationCell.class; }
- (void)updateSelectionAppearance {
    self.wantsLayer = YES; self.layer.cornerRadius = 8;
    BOOL selected = self.state == NSControlStateValueOn;
    NSColor* color = selected ? NSColor.selectedContentBackgroundColor : NSColor.clearColor;
    CGColorRef previous = ((CALayer*)self.layer.presentationLayer).backgroundColor ?: self.layer.backgroundColor;
    if (previous && duration() > 0) {
        CABasicAnimation* fade = [CABasicAnimation animationWithKeyPath:@"backgroundColor"];
        fade.fromValue = (__bridge id)previous; fade.toValue = (__bridge id)color.CGColor; fade.duration = duration();
        [self.layer addAnimation:fade forKey:@"selection"];
    }
    self.layer.backgroundColor = color.CGColor;
    self.contentTintColor = selected ? NSColor.alternateSelectedControlTextColor : NSColor.labelColor;
}
- (void)setState:(NSControlStateValue)state { [super setState:state]; [self updateSelectionAppearance]; }
- (void)viewDidChangeEffectiveAppearance { [super viewDidChangeEffectiveAppearance]; [self updateSelectionAppearance]; }
@end

@interface SSCScene : NSObject {
@public
    std::string identity, coverKey, backdropKey, logoKey;
}
@property(strong) NSImage* cover;
@property(strong) NSImage* blurredCover;
@property(strong) NSImage* backdrop;
@property(strong) NSImage* logo;
@property(copy) NSString* album;
@property(copy) NSString* artist;
@property(copy) NSString* track;
@property(copy) NSString* station;
@property(strong) NSArray<NSImage*>* ratings;
@property(strong) NSColor* tint;
@end
@implementation SSCScene
@end

static NSImage* blurCover(NSImage* image) {
    if (!image) return nil;
    CIImage* input = [CIImage imageWithData:image.TIFFRepresentation];
    if (!input) return nil;
    // Direct2D blurs source pixels first, then caches a 240 px result.
    CGFloat scale = 240.0 / std::max(input.extent.size.width, input.extent.size.height);
    CIImage* blurred = [[input imageByClampingToExtent] imageByApplyingFilter:@"CIGaussianBlur"
        withInputParameters:@{kCIInputRadiusKey:@24}];
    blurred = [[blurred imageByCroppingToRect:input.extent] imageByApplyingTransform:CGAffineTransformMakeScale(scale, scale)];
    CGImageRef rendered = [[CIContext contextWithOptions:nil] createCGImage:blurred fromRect:blurred.extent];
    if (!rendered) return nil;
    NSImage* result = [[NSImage alloc] initWithCGImage:rendered size:image.size];
    CGImageRelease(rendered); return result;
}
static NSColor* coverTint(NSImage* image) {
    if (!image) return NSColor.whiteColor;
    CIImage* input = [CIImage imageWithData:image.TIFFRepresentation];
    if (!input) return NSColor.whiteColor;
    CIImage* average = [input imageByApplyingFilter:@"CIAreaAverage"
        withInputParameters:@{kCIInputExtentKey:[CIVector vectorWithCGRect:input.extent]}];
    unsigned char pixel[4] = {};
    CGColorSpaceRef colorSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    [[CIContext contextWithOptions:nil] render:average toBitmap:pixel rowBytes:4 bounds:CGRectMake(0,0,1,1)
        format:kCIFormatRGBA8 colorSpace:colorSpace];
    CGColorSpaceRelease(colorSpace);
    const auto tint = ssc::readableCoverTint(pixel[0] / 255.0f, pixel[1] / 255.0f, pixel[2] / 255.0f);
    return [NSColor colorWithSRGBRed:tint.red green:tint.green blue:tint.blue alpha:1];
}

static void drawImage(NSImage* image, NSRect rect, bool fill, CGFloat alpha) {
    if (!image || rect.size.width <= 0 || rect.size.height <= 0 || alpha <= 0) return;
    NSSize size = image.size;
    if (size.width <= 0 || size.height <= 0) return;
    CGFloat scale = fill ? std::max(rect.size.width / size.width, rect.size.height / size.height)
                         : std::min(rect.size.width / size.width, rect.size.height / size.height);
    NSRect target = NSMakeRect(NSMidX(rect) - size.width * scale / 2, NSMidY(rect) - size.height * scale / 2,
                              size.width * scale, size.height * scale);
    [NSGraphicsContext saveGraphicsState];
    NSRectClip(rect);
    [image drawInRect:target fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:alpha];
    [NSGraphicsContext restoreGraphicsState];
}
static void drawText(NSString* value, NSRect rect, CGFloat size, NSFontWeight weight, CGFloat alpha, NSColor* tint = nil,
        NSTextAlignment alignment = NSTextAlignmentCenter, NSLineBreakMode lineBreak = NSLineBreakByWordWrapping) {
    if (!value.length || alpha <= 0) return;
    NSMutableParagraphStyle* style = [NSMutableParagraphStyle new];
    style.alignment = alignment;
    style.lineBreakMode = lineBreak;
    [value drawInRect:rect withAttributes:@{NSFontAttributeName:[NSFont systemFontOfSize:size weight:weight],
        NSForegroundColorAttributeName:[(tint ?: NSColor.whiteColor) colorWithAlphaComponent:alpha], NSParagraphStyleAttributeName:style}];
}
static NSArray<NSTextFieldCell*>* nextTextCells(SSCScene* scene, const ssc::NextTypography& font, bool rtl = false) {
    NSArray<NSString*>* lines = @[@"COMING NEXT", scene.album ?: @"", scene.artist ?: @""];
    const CGFloat sizes[] = {font.label, font.album, font.artist};
    const NSFontWeight weights[] = {NSFontWeightBold, NSFontWeightSemibold, NSFontWeightRegular};
    NSMutableArray<NSTextFieldCell*>* cells = [NSMutableArray array];
    for (NSUInteger i = 0; i < lines.count; ++i) {
        NSTextFieldCell* cell = [[NSTextFieldCell alloc] initTextCell:lines[i]];
        cell.font = [NSFont systemFontOfSize:sizes[i] weight:weights[i]];
        cell.bordered = NO; cell.bezeled = NO; cell.drawsBackground = NO;
        cell.usesSingleLineMode = YES; cell.lineBreakMode = NSLineBreakByTruncatingTail;
        cell.alignment = rtl ? NSTextAlignmentRight : NSTextAlignmentLeft;
        [cells addObject:cell];
    }
    return cells;
}
static NSSize nextTextSize(NSArray<NSTextFieldCell*>* cells) {
    NSSize size = NSZeroSize;
    for (NSUInteger i = 0; i < cells.count; ++i) {
        if (!cells[i].stringValue.length) continue;
        size.width = std::max(size.width, cells[i].cellSize.width);
        size.height += std::ceil(cells[i].cellSize.height) + (i == 0 ? 3.0 : 1.3);
    }
    return size;
}
// Pixel comparison for the opt-in native UI check, at Retina resolution.
static NSData* nextTextPixels(NSTextFieldCell* original, CGFloat width, NSLineBreakMode lineBreak) {
    const CGFloat height = std::ceil(original.cellSize.height);
    NSBitmapImageRep* bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:nil
        pixelsWide:std::ceil(width * 2) pixelsHigh:std::ceil(height * 2) bitsPerSample:8 samplesPerPixel:4
        hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
    if (!bitmap) return nil;
    std::memset(bitmap.bitmapData, 0, bitmap.bytesPerRow * bitmap.pixelsHigh);
    [NSGraphicsContext saveGraphicsState];
    NSGraphicsContext.currentContext = [NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
    NSAffineTransform* transform = [NSAffineTransform transform]; [transform scaleBy:2]; [transform concat];
    NSTextFieldCell* cell = [original copy]; cell.textColor = NSColor.whiteColor; cell.lineBreakMode = lineBreak;
    NSRect frame = NSMakeRect(0, 0, width, height);
    NSView* canvas = [[NSView alloc] initWithFrame:frame];
    [cell drawInteriorWithFrame:frame inView:canvas];
    [NSGraphicsContext.currentContext flushGraphics];
    [NSGraphicsContext restoreGraphicsState];
    return [NSData dataWithBytes:bitmap.bitmapData length:bitmap.bytesPerRow * bitmap.pixelsHigh];
}
static CGFloat textHeight(NSString* value, CGFloat width, CGFloat size, NSFontWeight weight) {
    if (!value.length) return 0;
    NSMutableParagraphStyle* style = [NSMutableParagraphStyle new]; style.lineBreakMode = NSLineBreakByWordWrapping;
    return std::ceil([value boundingRectWithSize:NSMakeSize(std::max(1.0, width), CGFLOAT_MAX)
        options:NSStringDrawingUsesLineFragmentOrigin | NSStringDrawingUsesFontLeading
        attributes:@{NSFontAttributeName:[NSFont systemFontOfSize:size weight:weight], NSParagraphStyleAttributeName:style}].size.height);
}
static void drawDigit(NSString* value, NSRect rect, CGFloat size, CGFloat alpha, NSColor* tint = nil) {
    if (!value.length || alpha <= 0) return;
    NSMutableParagraphStyle* style = [NSMutableParagraphStyle new]; style.alignment = NSTextAlignmentCenter;
    [value drawInRect:rect withAttributes:@{NSFontAttributeName:[NSFont monospacedDigitSystemFontOfSize:size weight:NSFontWeightMedium],
        NSForegroundColorAttributeName:[(tint ?: NSColor.whiteColor) colorWithAlphaComponent:alpha], NSParagraphStyleAttributeName:style}];
}

#include "stage.mm.inc"

struct Session {
    std::atomic<bool> cancelled{false};
    std::atomic<unsigned long long> revision{0};
    int station = 0;
    bool backdrops = false, logos = false;
    bool ratings = false, comingNext = false;
    std::string providers, fanartKey, ratingCountries;
    int width = 0, height = 0;
    ssc::platform::Mutex mediaMutex;
    ssc::MediaRequest mediaOptions;
    std::unique_ptr<ssc::CoverMonitor> monitor;
    std::unique_ptr<ssc::PresentationPipeline> pipeline;
};

@interface SSCApp : NSObject <NSApplicationDelegate, NSWindowDelegate, NSTextFieldDelegate, NSTableViewDataSource, NSTableViewDelegate> {
    NSWindow* _window;
    NSPanel* _settings;
    SSCStage* _stage;
    NSStackView* _stationButtons;
    std::shared_ptr<Session> _session;
    dispatch_queue_t _artworkQueue;
    BOOL _checkingUI;
    BOOL _quitting;
    NSMenuItem* _topMenu;
    NSMutableDictionary<NSString*, NSControl*>* _controls;
    NSTableView* _providerTable;
    NSMutableArray<NSString*>* _providerOrder;
    NSSecureTextField* _fanartKey;
    NSTextField* _keyStatus;
    NSTextField* _durationLabel;
    NSView* _settingsDocument;
    ssc::PresentationPipeline::Frame _currentFrame;
    std::map<std::string, std::vector<ssc::PreparedRating>> _ratingCache;
    std::shared_ptr<std::atomic<bool>> _ratingCancel;
    NSTableView* _settingsSidebar;
    NSArray<NSScrollView*>* _settingsPages;
    NSInteger _settingsPageIndex;
    NSTimer* _viewportTimer;
}
@end

@implementation SSCApp
- (void)captureView:(NSView*)view name:(NSString*)name {
    NSString* directory = NSProcessInfo.processInfo.environment[@"SSC_UI_CHECK_DIR"];
    [[NSFileManager defaultManager] createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:nil];
    NSBitmapImageRep* bitmap = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
    [view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap];
    NSData* data = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    if (![data writeToFile:[directory stringByAppendingPathComponent:name] atomically:YES]) NSLog(@"UI capture failed: %@", name);
}
- (void)checkUI {
    if (_checkingUI || !NSProcessInfo.processInfo.environment[@"SSC_UI_CHECK_DIR"].length) return;
    _checkingUI = YES;
    SSCStage* probe = [[SSCStage alloc] initWithFrame:NSMakeRect(0, 0, 100, 80)];
    if (![probe verifyBackgroundBlend]) { NSLog(@"FAIL: backdrop crossfade pixel regression"); exit(25); }
    NSLog(@"PASS: shared backdrop blend pixels and rapid reversal");
    NSBitmapImageRep* logoFixture = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:nil
        pixelsWide:240 pixelsHigh:80 bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES
        isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:960 bitsPerPixel:32];
    std::memset(logoFixture.bitmapData, 0, logoFixture.bytesPerRow * 80);
    for (int y=10; y<70; ++y) for (int x=20; x<220; ++x) {
        if (x>=180 && (y<38 || y>=42)) continue;
        std::memset(logoFixture.bitmapData+y*logoFixture.bytesPerRow+x*4,255,4);
    }
    NSData* logoPng = [logoFixture representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    NSImage* alignedLogo = decodeLogo(std::string((const char*)logoPng.bytes,logoPng.length));
    if (!alignedLogo || std::abs(logoHorizontalAnchor(alignedLogo)-.4f)>.00001f
        || alignedLogo.size.width!=200 || alignedLogo.size.height!=60) {
        NSLog(@"FAIL: title logo anchor or decorative tail was lost in native decoding"); exit(31);
    }
    NSLog(@"PASS: title logo lettering anchor and complete decorative tail");
    const ssccfg::EngineSettings reference;
    if (_stage.poster != (reference.layout != 0) || _stage.showCountdown != reference.showRemaining
            || _stage.countdownSize != reference.remainingSize || _stage.rollDigits != reference.rollDigits
            || _stage.comingNext != reference.comingNext) {
        NSLog(@"FAIL: first-run settings differ from Windows reference"); exit(30);
    }
    NSLog(@"PASS: first-run settings match Windows reference");
    _stage.poster = YES; // explicit fixture; first-run default is Fill on every host
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        [self captureView:_stage name:@"poster.png"];
        _stage.poster = NO;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            [self captureView:_stage name:@"fill.png"];
            [self showSettings:nil];
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
                [self captureView:_settings.contentView name:@"settings.png"];
                [self captureView:_settingsDocument name:@"settings-full.png"];
                for (NSUInteger i = 0; i < _settingsPages.count; ++i) {
                    _settingsPages[i].hidden = NO;
                    [_settingsPages[i] layoutSubtreeIfNeeded];
                    if (i == 3) [_providerTable reloadData];
                    [self captureView:_settingsPages[i].documentView name:[NSString stringWithFormat:@"settings-page-%lu.png", (unsigned long)i]];
                    _settingsPages[i].hidden = i != 0;
                }
                for (NSString* key in @[@"poster.0", @"poster.1", @"countdown", @"remainingSize.0", @"remainingSize.1", @"remainingSize.2",
                        @"rollDigits", @"comingNext", @"transition.0", @"transition.1", @"transition.2", @"transition.3", @"fadeMs",
                        @"backdrops", @"hideCover", @"logos", @"ratings", @"ratingDE", @"ratingUS", @"alwaysOnTop", @"checkKey"])
                    if (!_controls[key]) { NSLog(@"FAIL: missing setting %@", key); exit(10); }
                if (_providerTable.numberOfRows != 4 || !_fanartKey) { NSLog(@"FAIL: provider settings"); exit(11); }
                auto priorSession = _session; auto priorFrame = _currentFrame;
                auto priorGeneration = _session->pipeline->generation();
                ((NSButton*)_controls[@"ratings"]).state = NSControlStateValueOn;
                [self changeControl:_controls[@"ratings"]];
                if (_session != priorSession || _currentFrame != priorFrame || _session->pipeline->generation() != priorGeneration) {
                    NSLog(@"FAIL: ratings toggle restarted artwork"); exit(21);
                }
                [self toggleOnTop:nil];
                if (_window.level != NSFloatingWindowLevel || _settings.level != (NSApp.active ? _window.level + 1 : NSNormalWindowLevel) || !_settings.hidesOnDeactivate
                    || _topMenu.state != NSControlStateValueOn) { NSLog(@"FAIL: pinned window ordering"); exit(12); }
                [self applicationDidResignActive:nil];
                if (_settings.level != NSNormalWindowLevel) { NSLog(@"FAIL: settings remain globally pinned"); exit(13); }
                [self toggleOnTop:nil]; [self applyWindowLevels];
                if (_window.level != NSNormalWindowLevel || _topMenu.state != NSControlStateValueOff) { NSLog(@"FAIL: unpinned window ordering"); exit(14); }
                [self checkOdometer];
            });
        });
    });
}
- (NSData*)countdownPrefixPixels {
    CGFloat size = 32, digit = size * 0.68, height = size * 1.4;
    NSRect countdown = [_stage countdownRect];
    CGFloat centering = _stage.poster ? (countdown.size.width - 4 * digit) * .5 : 0;
    NSRect rect = NSMakeRect(NSMaxX(countdown) - 4 * digit - centering, countdown.origin.y, digit * 2, height);
    NSBitmapImageRep* image = [_stage bitmapImageRepForCachingDisplayInRect:rect];
    [_stage cacheDisplayInRect:rect toBitmapImageRep:image];
    return [image representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
}
- (void)checkOdometer {
    _stage.showCountdown = YES; // explicit fixture, independent of first-run defaults
    _stage.countdownSize = 1; _stage.rollDigits = YES; [_stage remaining:185];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        [self captureView:_stage name:@"odometer-idle.png"];
        NSData* before = [self countdownPrefixPixels];
        [_stage remaining:184];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 150 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
            [self captureView:_stage name:@"odometer-rolling.png"];
            if (![before isEqualToData:[self countdownPrefixPixels]]) { NSLog(@"FAIL: unchanged odometer digits shifted at animation start"); exit(15); }
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
                if (![before isEqualToData:[self countdownPrefixPixels]]) { NSLog(@"FAIL: odometer width changed after animation"); exit(16); }
                [self checkPresentation];
            });
        });
    });
}
- (void)checkPresentation {
    _stage.poster = YES; _stage.comingNext = YES; _stage.showCountdown = YES;
    SSCScene* wrapping = [SSCScene new];
    wrapping.album = @"A long album title that must wrap naturally instead of ending in an ellipsis";
    wrapping.artist = @"The Composer"; wrapping.track = @"A longer track name on its own row";
    wrapping.cover = NSApp.applicationIconImage; wrapping.blurredCover = blurCover(wrapping.cover); wrapping.tint = coverTint(wrapping.cover);
    [_stage present:wrapping];
    SSCScene* next = [SSCScene new]; next.album = @"A long upcoming album title that needs multiple lines";
    next.artist = @"The next composer with a longer name";
    next.cover = NSApp.applicationIconImage;
    [_stage setNextScene:next]; [_stage remaining:9]; [_stage mouseEntered:nil];
    const NSRect nextEntryRect = [_stage nextRect];
    const NSSize nextEntrySize = nextEntryRect.size;
    const double nextEntryTime = now();
    if (duration() > 0 && NSMaxX(nextEntryRect) <= NSMaxX(_stage.bounds)) {
        NSLog(@"FAIL: next card entry started inside the viewport"); exit(17);
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 150 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
        if (!NSEqualSizes(nextEntrySize, [_stage nextRect].size)) {
            NSLog(@"FAIL: next card changed size during entry"); exit(28);
        }
        // A dispatch_after callback may arrive after the 250 ms animation has
        // completed (observed at 313 ms). Verify actual motion from an offscreen
        // start; deterministic controller tests cover intermediate timing.
        if (duration() > 0 && [_stage nextRect].origin.x >= nextEntryRect.origin.x) {
            NSLog(@"FAIL: next card does not slide in (elapsed %.3f s, right %.2f, viewport %.2f)", now() - nextEntryTime, NSMaxX([_stage nextRect]), NSMaxX(_stage.bounds)); exit(17);
        }
        [self captureView:_stage name:@"coming-next-entering.png"];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            if (!NSEqualSizes(nextEntrySize, [_stage nextRect].size)) {
                NSLog(@"FAIL: next card kept resizing after entry"); exit(29);
            }
            [self captureView:_stage name:@"coming-next-poster.png"];
            if (!NSContainsRect([_stage infoRect], [_stage countdownRect]) || _stage.settingsButton.alphaValue < .99) {
                NSLog(@"FAIL: infobox countdown or mouse controls (info %@, countdown %@, controls %.3f)", NSStringFromRect([_stage infoRect]), NSStringFromRect([_stage countdownRect]), _stage.settingsButton.alphaValue); exit(18);
            }
            const auto nextFont = ssc::nextTypography(_stage.bounds.size.width);
            if (std::abs([_stage nextRect].size.width - _stage.bounds.size.width * .5) > .1
                || [_stage nextRect].size.height > nextFont.cover + nextFont.padY * 2 + 10) {
                NSLog(@"FAIL: next card does not grow to half width with single-line text"); exit(20);
            }
            for (BOOL rtl : {NO, YES}) for (BOOL cover : {NO, YES}) {
                for (NSString* title in @[@"Super 8", @"Die Hard 2: Die Harder", @"Star Trek: First Contact", @"Ångström: gjpqy", @"الأمل"]) {
                    SSCScene* probe = [SSCScene new]; probe.album = title; probe.artist = @"John Williams";
                    NSArray<NSTextFieldCell*>* cells = nextTextCells(probe, nextFont, rtl);
                    NSSize text = nextTextSize(cells);
                    const auto card = ssc::nextCardSize(_stage.bounds.size.width, nextFont, text.width, text.height, cover ? 1 : 0);
                    if (card.textWidth < text.width) { NSLog(@"FAIL: fitting next text did not get its full width: %@", title); exit(25); }
                    for (NSTextFieldCell* cell in cells) {
                        NSData* actual = nextTextPixels(cell, card.textWidth, NSLineBreakByTruncatingTail);
                        NSData* complete = nextTextPixels(cell, card.textWidth, NSLineBreakByClipping);
                        if (!actual || ![actual isEqualToData:complete]) { NSLog(@"FAIL: premature next-text ellipsis: %@", cell.stringValue); exit(26); }
                    }
                }
                SSCScene* longText = [SSCScene new]; longText.album = [@"W" stringByPaddingToLength:200 withString:@"W" startingAtIndex:0];
                NSArray<NSTextFieldCell*>* cells = nextTextCells(longText, nextFont, rtl);
                NSSize text = nextTextSize(cells);
                const auto card = ssc::nextCardSize(_stage.bounds.size.width, nextFont, text.width, text.height, cover ? 1 : 0);
                if (card.width != _stage.bounds.size.width * .5
                    || [nextTextPixels(cells[1], card.textWidth, NSLineBreakByTruncatingTail)
                        isEqualToData:nextTextPixels(cells[1], card.textWidth, NSLineBreakByClipping)]) {
                    NSLog(@"FAIL: overlong next text lacks an ellipsis at half width"); exit(27);
                }
            }
            SSCScene* fitted = [SSCScene new]; fitted.album = @"Star Trek: First Contact";
            fitted.artist = @"Jerry Goldsmith"; fitted.cover = NSApp.applicationIconImage;
            [_stage setNextScene:fitted];
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
                [self captureView:_stage name:@"coming-next-text-fit.png"];
                if (_stage.settingsButton.alphaValue > .01) { NSLog(@"FAIL: idle settings did not fade"); exit(19); }
                [self captureView:_stage name:@"controls-idle.png"];
                [self showAbout:nil];
                for (NSWindow* window in NSApp.windows) if (window != _window && window != _settings && window.isVisible)
                    [self captureView:window.contentView name:@"about.png"];
                NSSize original = _stage.bounds.size;
                [_window setContentSize:NSMakeSize(980, 560)];
                if (NSEqualSizes(original, _stage.bounds.size) || _stage.bounds.size.width != 980) {
                    NSLog(@"FAIL: canvas did not resize"); exit(22);
                }
                [self captureView:_stage name:@"resized-landscape.png"];
                for (NSButton* station in _stationButtons.arrangedSubviews)
                    if (!station.image) { NSLog(@"FAIL: missing station logo"); exit(23); }
                auto connectedSession = _session; auto displayedFrame = _currentFrame;
                SSCScene* displayedScene = [_stage valueForKey:@"current"];
                NSString* moved = _providerOrder[0]; [self moveProviderAt:0 to:3];
                if (![_providerOrder[3] isEqualToString:moved]
                    || ![[[preferences() stringForKey:@"providers"] componentsSeparatedByString:@","] lastObject]
                        || ![[[[preferences() stringForKey:@"providers"] componentsSeparatedByString:@","] lastObject] isEqualToString:moved]) {
                    NSLog(@"FAIL: provider order not saved"); exit(24);
                }
                if (_session != connectedSession || _currentFrame != displayedFrame || [_stage valueForKey:@"current"] != displayedScene) {
                    NSLog(@"FAIL: provider reorder replaced the connected presentation"); exit(26);
                }
                NSButton* provider = [NSButton new]; provider.identifier = moved; provider.state = NSControlStateValueOff;
                auto providerGeneration = _session->pipeline->generation();
                [self providerEnabled:provider];
                if (_session != connectedSession || _currentFrame != displayedFrame || [_stage valueForKey:@"current"] != displayedScene
                    || _session->pipeline->generation() == providerGeneration) {
                    NSLog(@"FAIL: provider toggle did not silently reprepare the artwork"); exit(26);
                }
                [self captureView:_stage name:@"provider-toggle.png"];
                NSLog(@"PASS: live cover, layouts, settings, window levels, odometer, next slide, next text fitting pixels, infobox countdown, idle controls, resize, station logos, silent provider toggle and reorder");
                [NSApp terminate:nil];
            });
        });
    });
}
- (NSButton*)button:(NSString*)title type:(NSButtonType)type action:(SEL)action {
    NSButton* button = [NSButton buttonWithTitle:title target:self action:action];
    [button setButtonType:type]; return button;
}
- (void)menu {
    NSMenu* bar = [NSMenu new];
    NSMenuItem* appItem = [NSMenuItem new]; [bar addItem:appItem];
    NSMenu* app = [[NSMenu alloc] initWithTitle:@"24seven.fm Covers"];
    NSMenuItem* about = [app addItemWithTitle:@"About 24seven.fm Covers" action:@selector(showAbout:) keyEquivalent:@""];
    about.target = self;
    [app addItem:NSMenuItem.separatorItem];
    NSMenuItem* settings = [app addItemWithTitle:@"Settings…" action:@selector(showSettings:) keyEquivalent:@","];
    settings.target = self;
    [app addItem:NSMenuItem.separatorItem];
    [app addItemWithTitle:@"Hide 24seven.fm Covers" action:@selector(hide:) keyEquivalent:@"h"];
    [app addItemWithTitle:@"Quit 24seven.fm Covers" action:@selector(terminate:) keyEquivalent:@"q"];
    appItem.submenu = app;
    NSMenuItem* viewItem = [NSMenuItem new]; [bar addItem:viewItem];
    NSMenu* view = [[NSMenu alloc] initWithTitle:@"View"];
    NSMenuItem* refresh = [view addItemWithTitle:@"Refresh" action:@selector(refresh:) keyEquivalent:@"r"]; refresh.target = self;
    _topMenu = [view addItemWithTitle:@"Keep Window on Top" action:@selector(toggleOnTop:) keyEquivalent:@"t"];
    _topMenu.target = self;
    NSMenuItem* full = [view addItemWithTitle:@"Toggle Full Screen" action:@selector(fullscreen:) keyEquivalent:@"f"];
    full.keyEquivalentModifierMask = NSEventModifierFlagControl | NSEventModifierFlagCommand; full.target = self;
    [view addItemWithTitle:@"Minimize" action:@selector(performMiniaturize:) keyEquivalent:@"m"];
    viewItem.submenu = view;
    NSMenuItem* helpItem = [NSMenuItem new]; [bar addItem:helpItem];
    NSMenu* help = [[NSMenu alloc] initWithTitle:@"Help"];
    NSMenuItem* station = [help addItemWithTitle:@"Open Station Website" action:@selector(openStation:) keyEquivalent:@""]; station.target = self;
    helpItem.submenu = help; NSApp.mainMenu = bar;
}
- (void)showAbout:(id)sender {
    [NSApp orderFrontStandardAboutPanelWithOptions:@{NSAboutPanelOptionApplicationIcon:NSApp.applicationIconImage}];
}
- (void)applicationDidFinishLaunching:(NSNotification*)note {
    // Also initialize the Dock icon when launched directly over SSH or for QA,
    // where Launch Services has not supplied the bundle icon yet.
    NSString* iconPath = [NSBundle.mainBundle pathForResource:@"AppIcon" ofType:@"icns"];
    NSImage* icon = iconPath ? [[NSImage alloc] initWithContentsOfFile:iconPath] : nil;
    if (icon) NSApp.applicationIconImage = icon;
    NSMutableDictionary* defaults = [NSMutableDictionary dictionary];
    for (const auto& setting : ssccfg::settingsSchema(ssccfg::Profile::MacOS)) {
        if (!setting.supported || !setting.ui) continue;
        defaults[text(setting.storageKey)] = setting.stringValue
            ? (id)text(setting.defaultText) : (id)@(setting.defaultInt);
    }
    [preferences() registerDefaults:defaults];
    if (NSProcessInfo.processInfo.environment[@"SSC_UI_CHECK_DIR"].length) {
        [preferences() setBool:YES forKey:@"backdrops"]; [preferences() setBool:YES forKey:@"logos"];
    }
    _artworkQueue = dispatch_queue_create("app.dudesoft.covers.artwork", DISPATCH_QUEUE_SERIAL);
    [self menu];
    _window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 680, 760)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    _window.title = @"24seven.fm Covers"; _window.releasedWhenClosed = NO;
    _window.contentMinSize = NSMakeSize(360, 420); _window.delegate = self;
    _window.collectionBehavior = NSWindowCollectionBehaviorFullScreenPrimary;
    [_window center]; if (!NSProcessInfo.processInfo.environment[@"SSC_UI_CHECK_DIR"].length) [_window setFrameAutosaveName:@"ViewerWindow"];
    _stage = [[SSCStage alloc] initWithFrame:((NSView*)_window.contentView).bounds];
    _stage.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    __weak SSCApp* weak = self;
    _stage.doubleClick = ^{ [weak fullscreen:nil]; };
    _stage.poster = [preferences() boolForKey:@"poster"];
    _stage.showCountdown = [preferences() boolForKey:@"countdown"];
    [self applyDisplaySettings];
    _window.contentView = _stage;
    NSButton* settings = [NSButton buttonWithTitle:@"Settings" target:self action:@selector(showSettings:)];
    settings.frame = NSMakeRect(14, _stage.bounds.size.height - 40, 85, 26);
    settings.autoresizingMask = NSViewMinYMargin; [_stage addSubview:settings];
    _stage.settingsButton = settings; settings.alphaValue = 0; settings.enabled = NO;
    _window.acceptsMouseMovedEvents = YES;
    [self applyWindowLevels];
    _window.alphaValue = 0; [_window makeKeyAndOrderFront:nil]; [NSApp activateIgnoringOtherApps:YES];
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext* context) {
        context.duration = duration(); _window.animator.alphaValue = 1;
    } completionHandler:nil];
    [self startStation];
}
- (void)stopSession {
    if (_ratingCancel) _ratingCancel->store(true);
    _currentFrame.reset();
    auto previous = _session; _session.reset();
    if (previous) {
        previous->cancelled.store(true);
        previous->pipeline->cancel();
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{ previous->monitor->stop(); previous->pipeline->stop(); });
    }
}
- (void)startStation {
    [self stopSession];
    NSUserDefaults* defaults = preferences();
    auto session = std::make_shared<Session>();
    session->station = ssc::validStationIndex(ssc::stationIndexForId([defaults stringForKey:@"station"].UTF8String));
    session->backdrops = [defaults boolForKey:@"backdrops"];
    session->logos = [defaults boolForKey:@"logos"];
    session->ratings = [defaults boolForKey:@"ratings"];
    session->comingNext = [defaults boolForKey:@"comingNext"];
    session->providers = [defaults stringForKey:@"providers"].UTF8String ?: "tmdb";
    session->fanartKey = [defaults stringForKey:@"fanartClientKey"].UTF8String ?: "";
    if ([defaults boolForKey:@"ratingDE"]) session->ratingCountries = "DE";
    if ([defaults boolForKey:@"ratingUS"]) session->ratingCountries += session->ratingCountries.empty() ? "US" : ",US";
    NSSize pixels = [_stage convertSizeToBacking:_stage.bounds.size];
    session->width = pixels.width; session->height = pixels.height;
    ssc::MediaPreferences mediaPreferences;
    mediaPreferences.station = session->station; mediaPreferences.backdrops = session->backdrops;
    mediaPreferences.logos = session->logos; mediaPreferences.ratings = session->ratings;
    mediaPreferences.providers = session->providers; mediaPreferences.fanartKey = session->fanartKey;
    mediaPreferences.ratingCountries = session->ratingCountries;
    session->mediaOptions = ssc::mediaOptions(mediaPreferences, session->width, session->height);
    _session = session;
    const int station = session->station;
    _window.title = [NSString stringWithFormat:@"%@ — 24seven.fm Covers", text(ssc::station(station).displayName)];
    SSCScene* loading = [SSCScene new]; loading.album = @"Connecting…";
    loading.station = text(ssc::station(station).displayName); [_stage present:loading];
    __weak SSCApp* weakSelf = self;
    std::weak_ptr<Session> weakSession = session;
    ssc::Config config; config.host = ssc::station(station).host;
    config.errorRetrySeconds = 8; config.cycleErrorRetryAfterCap = true;
    session->pipeline.reset(new ssc::PresentationPipeline(
        [weakSession](const ssc::TrackInfo& track, const ssc::MediaRequest& request, const std::atomic<bool>* cancel) {
            auto state = weakSession.lock();
            if (!state || state->cancelled.load()) return ssc::PresentationPipeline::Frame();
            return ssc::PresentationPipeline::Frame(std::make_shared<ssc::PreparedPresentation>(
                ssc::preparePresentation(track, request, state->station, cancel)));
        },
        [weakSession](const std::atomic<bool>* cancel) {
            auto state = weakSession.lock();
            return state && !state->cancelled.load() ? ssc::stationQueue(state->station, cancel) : std::vector<ssc::TrackInfo>();
        },
        [weakSelf, weakSession](ssc::PresentationPipeline::Frame frame, bool queued, bool cached, unsigned long long generation) {
            @autoreleasepool {
                auto state = weakSession.lock(); if (!state || state->cancelled.load()) return;
                SSCScene* scene = [SSCScene new];
                scene->identity = ssc::trackIdentity(frame->track, state->station);
                scene->coverKey = "cover:" + frame->cover;
                scene->backdropKey = frame->backdrop.empty() ? "blur:" + frame->cover : "backdrop:" + frame->backdrop;
                scene->logoKey = frame->logo;
                scene.cover = decode(frame->cover); scene.blurredCover = blurCover(scene.cover);
                scene.backdrop = decode(frame->backdrop); scene.logo = decodeLogo(frame->logo);
                scene.tint = frame->media.hasTint && scene.backdrop
                    ? [NSColor colorWithSRGBRed:frame->media.tint[0] / 255.0 green:frame->media.tint[1] / 255.0 blue:frame->media.tint[2] / 255.0 alpha:1]
                    : coverTint(scene.cover);
                NSMutableArray<NSImage*>* ratings = [NSMutableArray array];
                for (const auto& rating : frame->ratings) { NSImage* image = decode(rating.bytes); if (image) [ratings addObject:image]; }
                scene.ratings = ratings;
                const auto metadata = ssc::presentationText(frame->track, frame->media, state->station);
                scene.album = text(metadata.album); scene.artist = text(metadata.artist); scene.track = text(metadata.track);
                scene.station = text(ssc::station(state->station).displayName);
                NSLog(@"Presentation %@ %@: %@ (backdrop=%lu bytes, status=%d, error=%@)", queued ? @"prefetched" : @"current",
                    cached ? @"cache-hit" : @"prepared", scene.album, (unsigned long)frame->backdrop.size(), frame->media.status, text(frame->media.error));
                dispatch_async(dispatch_get_main_queue(), ^{
                    SSCApp* app = weakSelf;
                    if (!app || app->_session != state || state->pipeline->generation() != generation || app->_checkingUI) return;
                    if (queued) [app->_stage setNextScene:scene];
                    else {
                        app->_currentFrame = frame;
                        [app->_stage present:scene];
                        [app refreshRatings];
                        if (frame->media.fanartKeyRejected) {
                            [preferences() removeObjectForKey:@"fanartKeyVerifiedAt"];
                            [app keyStatus:@"Key rejected — using the shared artwork service."];
                        }
                        if (scene.cover) [app checkUI];
                    }
                });
            }
        }));
    session->pipeline->viewport(session->width, session->height);
    session->monitor.reset(new ssc::CoverMonitor([weakSelf, weakSession](const std::string&, const ssc::TrackInfo& track) {
        auto state = weakSession.lock(); if (!state || state->cancelled.load()) return;
        const std::string identity = ssc::trackIdentity(track, state->station);
        dispatch_async(dispatch_get_main_queue(), ^{
            SSCApp* app=weakSelf;
            if (app && app->_session==state && !app->_checkingUI) [app->_stage trackChanged:identity];
        });
        ssc::platform::LockGuard lock(state->mediaMutex);
        auto request = ssc::requestForTrack(track, state->mediaOptions);
        state->revision.store(state->pipeline->current(track, request));
    }, config));

    session->monitor->setTickCallback([weakSelf, weakSession](const ssc::TrackInfo& info) {
        auto state = weakSession.lock(); if (!state || state->cancelled.load()) return;
        int remaining = info.remainingSeconds;
        const std::string identity = ssc::trackIdentity(info, state->station);
        dispatch_async(dispatch_get_main_queue(), ^{
            SSCApp* app = weakSelf;
            if (app && app->_session == state && !app->_checkingUI) [app->_stage remaining:remaining identity:identity];
        });
    });
    session->monitor->setErrorCallback([weakSelf, weakSession](const std::string& error) {
        auto state = weakSession.lock(); if (!state || state->cancelled.load()) return;
        NSLog(@"Station request: %@", text(error));
        dispatch_async(dispatch_get_main_queue(), ^{
            SSCApp* app = weakSelf; if (!app || app->_session != state) return;
            if (state->revision == 0) {
                SSCScene* scene = [SSCScene new]; scene.album = @"Connection interrupted";
                scene.artist = @"Retrying automatically…"; scene.station = text(ssc::station(state->station).displayName);
                [app->_stage present:scene];
            }
        });
    });
    session->monitor->start();
}
- (NSButton*)checkbox:(NSString*)title key:(NSString*)key {
    NSButton* button = [self button:title type:NSButtonTypeSwitch action:@selector(changeControl:)];
    button.identifier = key; button.state = [preferences() boolForKey:key];
    _controls[key] = button; return button;
}
- (NSStackView*)choices:(NSArray<NSString*>*)titles key:(NSString*)key {
    NSMutableArray* buttons = [NSMutableArray array];
    NSInteger selected = [preferences() integerForKey:key];
    for (NSUInteger i = 0; i < titles.count; ++i) {
        NSButton* button = [self button:titles[i] type:NSButtonTypeRadio action:@selector(changeControl:)];
        button.identifier = [@"choice:" stringByAppendingString:key]; button.tag = i; button.state = selected == (NSInteger)i;
        [buttons addObject:button]; _controls[[NSString stringWithFormat:@"%@.%lu", key, (unsigned long)i]] = button;
    }
    NSStackView* row = [NSStackView stackViewWithViews:buttons]; row.spacing = 16; return row;
}
- (void)heading:(NSString*)title in:(NSStackView*)root {
    NSTextField* label = [NSTextField labelWithString:title]; label.font = [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold];
    label.identifier = [@"section:" stringByAppendingString:title];
    [root addArrangedSubview:label];
}
- (void)showSettings:(id)sender {
    if (!_settings) {
        _controls = [NSMutableDictionary dictionary];
        _settings = [[NSPanel alloc] initWithContentRect:NSMakeRect(0, 0, 760, 600)
            styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable
            backing:NSBackingStoreBuffered defer:NO];
        _settings.title = @"Settings"; _settings.releasedWhenClosed = NO; _settings.delegate = self;
        _settings.hidesOnDeactivate = YES; _settings.floatingPanel = NO;
        _settings.collectionBehavior = NSWindowCollectionBehaviorFullScreenAuxiliary;
        _settings.contentMinSize = NSMakeSize(760, 540);
        NSScrollView* scroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(0, 0, 580, 740)];
        scroll.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable; scroll.hasVerticalScroller = YES;
        scroll.drawsBackground = YES; scroll.backgroundColor = NSColor.windowBackgroundColor;
        NSStackView* root = [NSStackView new];
        root.orientation = NSUserInterfaceLayoutOrientationVertical; root.alignment = NSLayoutAttributeLeading;
        root.spacing = 12; root.edgeInsets = NSEdgeInsetsMake(24, 24, 24, 24);
        root.wantsLayer = YES; root.layer.backgroundColor = NSColor.windowBackgroundColor.CGColor;
        _settingsDocument = root;
        [self heading:@"Station" in:root];
        _stationButtons = [NSStackView new]; _stationButtons.orientation = NSUserInterfaceLayoutOrientationVertical;
        _stationButtons.alignment = NSLayoutAttributeLeading; _stationButtons.spacing = 8;
        for (int i = 0; i < ssc::kStationCount; ++i) {
            NSButton* button = [SSCStationButton buttonWithTitle:text(ssc::station(i).displayName) target:self action:@selector(selectStation:)];
            [button setButtonType:NSButtonTypeRadio];
            NSImage* logo = [[NSImage alloc] initWithContentsOfFile:[NSBundle.mainBundle pathForResource:text(ssc::station(i).id)
                ofType:@"png" inDirectory:@"Stations"]];
            logo.size = NSMakeSize(56, 56); button.image = logo; button.alternateImage = logo;
            button.imagePosition = NSImageLeft; button.imageScaling = NSImageScaleProportionallyDown;
            button.bordered = NO; button.alignment = NSTextAlignmentLeft;
            [button.widthAnchor constraintEqualToConstant:488].active = YES;
            [button.heightAnchor constraintEqualToConstant:64].active = YES;
            button.tag = i; button.toolTip = text(ssc::station(i).desc); [_stationButtons addArrangedSubview:button];
        }
        [root addArrangedSubview:_stationButtons];
        [self heading:@"Layout & window" in:root];
        [root addArrangedSubview:[self choices:@[@"Fill window", @"Poster"] key:@"poster"]];
        [root addArrangedSubview:[self checkbox:@"Keep cover window on top  (⌘T)" key:@"alwaysOnTop"]];
        [self heading:@"Remaining time" in:root];
        [root addArrangedSubview:[self checkbox:@"Show remaining time" key:@"countdown"]];
        [root addArrangedSubview:[self choices:@[@"Small", @"Medium", @"Large"] key:@"remainingSize"]];
        [root addArrangedSubview:[self checkbox:@"Animate countdown digits (rolling)" key:@"rollDigits"]];
        [root addArrangedSubview:[self checkbox:@"Show coming next (last 10 seconds)" key:@"comingNext"]];
        [self heading:@"Cover transition" in:root];
        [root addArrangedSubview:[self choices:@[@"None", @"Crossfade", @"Flip H", @"Flip V"] key:@"transition"]];
        _controls[@"transition.0"].toolTip = @"No spatial effect; a short fade keeps changes gentle.";
        const auto& durationSetting = *ssccfg::findSetting("fadeMs", ssccfg::Profile::MacOS);
        NSSlider* slider = [NSSlider sliderWithValue:[preferences() integerForKey:@"fadeMs"]
            minValue:durationSetting.minimum maxValue:durationSetting.maximum target:self action:@selector(changeControl:)];
        slider.identifier = @"fadeMs"; slider.numberOfTickMarks = 1 + (durationSetting.maximum - durationSetting.minimum) / durationSetting.step; slider.allowsTickMarkValuesOnly = YES;
        [slider.widthAnchor constraintEqualToConstant:320].active = YES;
        _controls[@"fadeMs"] = slider;
        _durationLabel = [NSTextField labelWithString:[NSString stringWithFormat:@"%ld ms", slider.integerValue]];
        [root addArrangedSubview:[NSStackView stackViewWithViews:@[slider, _durationLabel]]];
        [self heading:@"StreamingSoundtracks media" in:root];
        [root addArrangedSubview:[self checkbox:@"Show movie, TV & game backdrops" key:@"backdrops"]];
        [root addArrangedSubview:[self checkbox:@"Hide square cover when a backdrop is shown" key:@"hideCover"]];
        [root addArrangedSubview:[self checkbox:@"Replace album title with logo" key:@"logos"]];
        [self heading:@"Age ratings" in:root];
        [root addArrangedSubview:[self checkbox:@"Show age ratings" key:@"ratings"]];
        NSStackView* countries = [NSStackView stackViewWithViews:@[
            [self checkbox:@"Germany (FSK)" key:@"ratingDE"],
            [self checkbox:@"United States (MPA / TV)" key:@"ratingUS"]]];
        countries.orientation = NSUserInterfaceLayoutOrientationVertical;
        countries.alignment = NSLayoutAttributeLeading; countries.spacing = 8;
        countries.edgeInsets = NSEdgeInsetsMake(0, 20, 0, 0);
        [root addArrangedSubview:countries];
        [self heading:@"Artwork providers (top first)" in:root];
        _providerOrder = [NSMutableArray array];
        NSArray* saved = [[preferences() stringForKey:@"providers"] componentsSeparatedByString:@","];
        for (NSString* key in saved) if ([@[@"fanart", @"tmdb", @"tvmaze", @"steamgriddb"] containsObject:key]
            && ![_providerOrder containsObject:key]) [_providerOrder addObject:key];
        for (NSString* key in @[@"fanart", @"tmdb", @"tvmaze", @"steamgriddb"]) if (![_providerOrder containsObject:key]) [_providerOrder addObject:key];
        _providerTable = [NSTableView new]; _providerTable.headerView = nil; _providerTable.rowHeight = 38;
        _providerTable.backgroundColor = NSColor.clearColor; _providerTable.style = NSTableViewStylePlain;
        _providerTable.dataSource = self; _providerTable.delegate = self;
        NSTableColumn* providerColumn = [[NSTableColumn alloc] initWithIdentifier:@"provider"]; providerColumn.width = 478;
        [_providerTable addTableColumn:providerColumn];
        [_providerTable registerForDraggedTypes:@[@"app.dudesoft.covers.provider"]];
        [_providerTable setDraggingSourceOperationMask:NSDragOperationMove forLocal:YES];
        NSScrollView* providerScroll = [NSScrollView new]; providerScroll.drawsBackground = NO;
        providerScroll.documentView = _providerTable;
        [root addArrangedSubview:providerScroll];
        [providerScroll.widthAnchor constraintEqualToConstant:488].active = YES;
        [providerScroll.heightAnchor constraintEqualToConstant:160].active = YES;
        [_providerTable reloadData];
        [self heading:@"fanart.tv personal client key" in:root];
        _fanartKey = [NSSecureTextField new]; _fanartKey.placeholderString = @"Optional personal client key";
        _fanartKey.stringValue = [preferences() stringForKey:@"fanartClientKey"];
        _fanartKey.delegate = self; [_fanartKey.widthAnchor constraintEqualToConstant:390].active = YES;
        NSButton* check = [NSButton buttonWithTitle:@"Check" target:self action:@selector(checkKey:)]; _controls[@"checkKey"] = check;
        [root addArrangedSubview:[NSStackView stackViewWithViews:@[_fanartKey, check]]];
        _keyStatus = [NSTextField labelWithString:[preferences() doubleForKey:@"fanartKeyVerifiedAt"] > 0 ? @"Key verified" : @"Uses shared access unless a personal key is provided."];
        _keyStatus.font = [NSFont systemFontOfSize:11]; [root addArrangedSubview:_keyStatus];
        NSButton* why = [NSButton buttonWithTitle:@"Why a personal key?" target:self action:@selector(providerLink:)];
        why.identifier = @"https://fanart.tv/personal-api-keys/";
        NSButton* get = [NSButton buttonWithTitle:@"Get a key" target:self action:@selector(providerLink:)];
        get.identifier = @"https://fanart.tv/get-an-api-key/";
        [root addArrangedSubview:[NSStackView stackViewWithViews:@[why, get]]];
        NSTextField* attribution = [NSTextField wrappingLabelWithString:@"Artwork by fanart.tv. This product uses the TMDB API but is not endorsed or certified by TMDB. TV data & artwork by TVmaze. GameArt by SteamGridDB.\n\nPreferences are saved automatically. macOS Reduce Motion is respected."];
        attribution.font = [NSFont systemFontOfSize:11]; attribution.textColor = NSColor.secondaryLabelColor;
        [attribution.widthAnchor constraintEqualToConstant:460].active = YES; [root addArrangedSubview:attribution];
        [self buildSettingsPages:root];
        [_settings center];
    }
    [self updateStationButtons];
    [self dependencies]; [self applyWindowLevels];
    if (!_settings.visible) _settings.alphaValue = 0;
    [_settings makeKeyAndOrderFront:nil];
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext* c) { c.duration = duration(); _settings.animator.alphaValue = 1; } completionHandler:nil];
}
- (void)buildSettingsPages:(NSStackView*)original {
    NSMutableArray<NSStackView*>* pages = [NSMutableArray array];
    for (NSInteger i = 0; i < 4; ++i) {
        NSStackView* page = [NSStackView new]; page.orientation = NSUserInterfaceLayoutOrientationVertical;
        page.alignment = NSLayoutAttributeLeading; page.spacing = 18; page.edgeInsets = NSEdgeInsetsMake(24, 24, 24, 24);
        [pages addObject:page];
    }
    NSInteger category = 0;
    NSMutableArray<NSStackView*>* groups = [NSMutableArray array];
    NSMutableArray<NSNumber*>* categories = [NSMutableArray array];
    NSStackView* group = nil;
    for (NSView* view in [original.arrangedSubviews copy]) {
        [original removeArrangedSubview:view]; [view removeFromSuperview];
        if ([view.identifier hasPrefix:@"section:"]) {
            NSString* name = [view.identifier substringFromIndex:8];
            if ([name isEqualToString:@"Layout & window"]) category = 1;
            if ([name isEqualToString:@"StreamingSoundtracks media"]) category = 2;
            if ([name isEqualToString:@"Artwork providers (top first)"]) category = 3;
            group = [NSStackView new]; group.orientation = NSUserInterfaceLayoutOrientationVertical;
            group.alignment = NSLayoutAttributeLeading; group.spacing = 12;
            group.edgeInsets = NSEdgeInsetsMake(16, 16, 16, 16);
            [groups addObject:group]; [categories addObject:@(category)];
            if ([name isEqualToString:@"Station"]) continue; // already named in the sidebar
        }
        [group addArrangedSubview:view];
    }
    for (NSUInteger i = 0; i < groups.count; ++i) {
        NSStackView* content = groups[i];
        if (categories[i].integerValue == 0) {
            content.edgeInsets = NSEdgeInsetsMake(0, 0, 0, 0);
            [pages[0] addArrangedSubview:content]; continue;
        }
        NSBox* box = [NSBox new]; box.boxType = NSBoxCustom; box.titlePosition = NSNoTitle;
        box.borderColor = NSColor.separatorColor; box.borderWidth = .5; box.cornerRadius = 10;
        box.fillColor = NSColor.controlBackgroundColor; box.contentViewMargins = NSZeroSize;
        box.contentView = content;
        [box.widthAnchor constraintEqualToConstant:520].active = YES;
        [box.heightAnchor constraintEqualToConstant:content.fittingSize.height].active = YES;
        [pages[categories[i].integerValue] addArrangedSubview:box];
    }
    NSVisualEffectView* sidebar = [[NSVisualEffectView alloc] initWithFrame:NSMakeRect(0, 0, 176, 600)];
    sidebar.material = NSVisualEffectMaterialSidebar; sidebar.blendingMode = NSVisualEffectBlendingModeBehindWindow;
    sidebar.autoresizingMask = NSViewHeightSizable; [_settings.contentView addSubview:sidebar];
    NSScrollView* navigation = [[NSScrollView alloc] initWithFrame:NSInsetRect(sidebar.bounds, 8, 16)];
    navigation.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable; navigation.drawsBackground = NO;
    _settingsSidebar = [[NSTableView alloc] initWithFrame:navigation.bounds]; _settingsSidebar.headerView = nil;
    _settingsSidebar.backgroundColor = NSColor.clearColor; _settingsSidebar.rowHeight = 36;
    _settingsSidebar.style = NSTableViewStyleSourceList; _settingsSidebar.dataSource = self; _settingsSidebar.delegate = self;
    NSTableColumn* column = [[NSTableColumn alloc] initWithIdentifier:@"category"]; column.width = 160;
    [_settingsSidebar addTableColumn:column]; navigation.documentView = _settingsSidebar; [sidebar addSubview:navigation];
    NSMutableArray* scrolls = [NSMutableArray array];
    for (NSUInteger i = 0; i < pages.count; ++i) {
        NSScrollView* scroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(176, 0, 584, 600)];
        scroll.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable; scroll.hasVerticalScroller = YES;
        scroll.drawsBackground = YES; scroll.backgroundColor = NSColor.windowBackgroundColor;
        NSStackView* page = pages[i];
        CGFloat height = std::max(600.0, page.fittingSize.height);
        page.frame = NSMakeRect(0, 0, 568, height); scroll.documentView = page;
        [scroll.contentView scrollToPoint:NSMakePoint(0, height - scroll.contentSize.height)];
        [scroll reflectScrolledClipView:scroll.contentView];
        scroll.hidden = i != 0; [_settings.contentView addSubview:scroll]; [scrolls addObject:scroll];
    }
    _settingsPages = scrolls; _settingsPageIndex = 0; _settingsDocument = pages[0];
    [_settingsSidebar selectRowIndexes:[NSIndexSet indexSetWithIndex:0] byExtendingSelection:NO];
}
- (NSInteger)numberOfRowsInTableView:(NSTableView*)tableView { return tableView == _providerTable ? _providerOrder.count : 4; }
- (NSView*)tableView:(NSTableView*)tableView viewForTableColumn:(NSTableColumn*)column row:(NSInteger)row {
    if (tableView == _providerTable) return [self providerRow:row];
    NSArray* titles = @[@"Station", @"Display", @"Artwork", @"Providers"];
    NSArray* symbols = @[@"antenna.radiowaves.left.and.right", @"display", @"photo", @"network"];
    NSImageView* icon = [NSImageView imageViewWithImage:[NSImage imageWithSystemSymbolName:symbols[row] accessibilityDescription:nil]];
    [icon.widthAnchor constraintEqualToConstant:20].active = YES;
    NSTextField* label = [NSTextField labelWithString:titles[row]]; label.font = [NSFont systemFontOfSize:13];
    NSStackView* cell = [NSStackView stackViewWithViews:@[icon, label]]; cell.spacing = 8; return cell;
}
- (void)tableViewSelectionDidChange:(NSNotification*)notification {
    if (notification.object != _settingsSidebar) return;
    NSInteger selected = _settingsSidebar.selectedRow;
    if (selected < 0 || selected == _settingsPageIndex || !_settingsPages.count) return;
    NSScrollView* outgoing = _settingsPages[_settingsPageIndex];
    NSScrollView* incoming = _settingsPages[selected]; _settingsPageIndex = selected;
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext* c) { c.duration = duration() / 2; outgoing.animator.alphaValue = 0; }
        completionHandler:^{
            outgoing.hidden = YES; incoming.hidden = NO; incoming.alphaValue = 0; _settingsDocument = incoming.documentView;
            [NSAnimationContext runAnimationGroup:^(NSAnimationContext* c) { c.duration = duration() / 2; incoming.animator.alphaValue = 1; } completionHandler:nil];
        }];
}
- (void)applyWindowLevels {
    BOOL top = [preferences() boolForKey:@"alwaysOnTop"];
    _window.level = top ? NSFloatingWindowLevel : NSNormalWindowLevel;
    _topMenu.state = top ? NSControlStateValueOn : NSControlStateValueOff;
    ((NSButton*)_controls[@"alwaysOnTop"]).state = _topMenu.state;
    // Settings are an app-local inspector, not another globally pinned cover.
    // Their independent level stays above the cover while this app is active;
    // hidesOnDeactivate removes the inspector when switching to another app.
    _settings.level = NSApp.active ? _window.level + 1 : NSNormalWindowLevel;
    if (_settings.visible && NSApp.active) [_settings orderFront:nil];
}
- (void)applicationDidBecomeActive:(NSNotification*)note { [self applyWindowLevels]; }
- (void)updateArtworkViewport {
    if (!_session || !_session->pipeline) return;
    NSSize pixels = [_stage convertSizeToBacking:_stage.bounds.size];
    _session->pipeline->viewport((int)pixels.width, (int)pixels.height);
}
- (void)windowDidResize:(NSNotification*)note {
    if (note.object != _window) return;
    [_stage animate];
    [_viewportTimer invalidate];
    if (!_stage.inLiveResize) { [self updateArtworkViewport]; return; }
    __weak SSCApp* weak = self;
    _viewportTimer = [NSTimer timerWithTimeInterval:.25 repeats:NO block:^(NSTimer* timer) { [weak updateArtworkViewport]; }];
    [NSRunLoop.mainRunLoop addTimer:_viewportTimer forMode:NSRunLoopCommonModes];
}
- (void)windowDidEndLiveResize:(NSNotification*)note {
    if (note.object == _window) { [_viewportTimer invalidate]; [self updateArtworkViewport]; }
}
- (void)windowDidChangeBackingProperties:(NSNotification*)note {
    if (note.object == _window) [self updateArtworkViewport];
}
- (void)applicationDidResignActive:(NSNotification*)note { _settings.level = NSNormalWindowLevel; }
- (void)toggleOnTop:(id)sender {
    NSUserDefaults* defaults = preferences();
    [defaults setBool:![defaults boolForKey:@"alwaysOnTop"] forKey:@"alwaysOnTop"];
    [self applyWindowLevels];
}
- (void)applyDisplaySettings {
    NSUserDefaults* d = preferences();
    _stage.poster = [d boolForKey:@"poster"]; _stage.showCountdown = [d boolForKey:@"countdown"];
    _stage.countdownSize = [d integerForKey:@"remainingSize"]; _stage.rollDigits = [d boolForKey:@"rollDigits"];
    _stage.comingNext = [d boolForKey:@"comingNext"]; _stage.transition = [d integerForKey:@"transition"];
    _stage.fadeMs = [d integerForKey:@"fadeMs"]; _stage.hideCoverWithBackdrop = [d boolForKey:@"hideCover"];
    _stage.ratingsEnabled = [d boolForKey:@"ratings"];
    [_stage animate];
}
- (void)dependencies {
    NSUserDefaults* d = preferences();
    for (NSString* key in @[@"remainingSize.0", @"remainingSize.1", @"remainingSize.2", @"rollDigits"])
        _controls[key].enabled = [d boolForKey:@"countdown"];
    BOOL media = _session && _session->station == 0;
    _controls[@"backdrops"].enabled = media; _controls[@"ratings"].enabled = media;
    _controls[@"hideCover"].enabled = media && [d boolForKey:@"backdrops"];
    _controls[@"logos"].enabled = media && [d boolForKey:@"backdrops"];
    _controls[@"ratingDE"].enabled = media && [d boolForKey:@"ratings"];
    _controls[@"ratingUS"].enabled = media && [d boolForKey:@"ratings"];
    _controls[@"fadeMs"].enabled = [d integerForKey:@"transition"] != 0;
}
- (void)selectStation:(NSButton*)sender {
    [preferences() setObject:text(ssc::station((int)sender.tag).id) forKey:@"station"];
    [self startStation]; [self updateStationButtons]; [self dependencies];
}
- (void)updateStationButtons {
    for (NSButton* button in _stationButtons.arrangedSubviews) {
        BOOL selected = _session && button.tag == _session->station;
        button.state = selected ? NSControlStateValueOn : NSControlStateValueOff;
        button.title = [NSString stringWithFormat:@"   %@%@", text(ssc::station((int)button.tag).displayName), selected ? @"   ✓" : @""];
        button.contentTintColor = selected ? NSColor.alternateSelectedControlTextColor : NSColor.labelColor;
        button.font = [NSFont systemFontOfSize:13 weight:selected ? NSFontWeightSemibold : NSFontWeightRegular];
    }
}
- (void)changeControl:(NSControl*)sender {
    NSString* key = sender.identifier; NSUserDefaults* defaults = preferences();
    if ([key hasPrefix:@"choice:"]) {
        key = [key substringFromIndex:7]; [defaults setInteger:sender.tag forKey:key];
        for (NSView* view in sender.superview.subviews) if ([view isKindOfClass:NSButton.class]) ((NSButton*)view).state = view == sender;
    } else if ([key isEqualToString:@"fadeMs"]) {
        [defaults setInteger:sender.integerValue forKey:key]; _durationLabel.stringValue = [NSString stringWithFormat:@"%ld ms", sender.integerValue];
    } else [defaults setBool:((NSButton*)sender).state == NSControlStateValueOn forKey:key];
    [self applyDisplaySettings]; [self applyWindowLevels]; [self dependencies];
    if ([@[@"ratings", @"ratingDE", @"ratingUS"] containsObject:key]) [self refreshRatings];
    else if ([@[@"backdrops", @"logos"] containsObject:key]) [self startStation];
}
- (void)refreshRatings {
    if (_ratingCancel) _ratingCancel->store(true);
    if (!_currentFrame || !_session || _session->station != 0 || ![preferences() boolForKey:@"ratings"]) return;
    ssc::MediaRequest request; request.includeArt = false; request.includeRatings = true;
    request.ratingCountries = [preferences() boolForKey:@"ratingDE"] ? "DE" : "";
    if ([preferences() boolForKey:@"ratingUS"]) request.ratingCountries += request.ratingCountries.empty() ? "US" : ",US";
    if (request.ratingCountries.empty()) { _stage.ratingsEnabled = NO; return; }
    auto frame = _currentFrame;
    const auto key = ssc::mediaCacheKey(frame->track, request);
    if (_session->ratings && _session->ratingCountries == request.ratingCountries)
        _ratingCache[key] = frame->ratings;
    auto cached = _ratingCache.find(key);
    if (cached != _ratingCache.end()) { [self applyRatingAssets:cached->second]; return; }
    auto cancel = std::make_shared<std::atomic<bool>>(false); _ratingCancel = cancel;
    __weak SSCApp* weak = self;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        const auto assets = ssc::prepareRatings(frame->track, request, cancel.get());
        dispatch_async(dispatch_get_main_queue(), ^{
            SSCApp* app = weak;
            if (!app || cancel->load() || app->_currentFrame != frame) return;
            if (app->_ratingCache.size() >= ssc::kQueuedTrackStoreLimit) app->_ratingCache.erase(app->_ratingCache.begin());
            if (!assets.empty()) app->_ratingCache[key] = assets;
            [app applyRatingAssets:assets];
        });
    });
}
- (void)applyRatingAssets:(const std::vector<ssc::PreparedRating>&)assets {
    NSMutableArray<NSImage*>* images = [NSMutableArray array];
    for (const auto& asset : assets) { NSImage* image = decode(asset.bytes); if (image) [images addObject:image]; }
    [_stage setRatingImages:images];
}
- (NSView*)providerRow:(NSInteger)i {
    NSDictionary* names = @{@"fanart":@"fanart.tv", @"tmdb":@"TMDB", @"tvmaze":@"TVmaze", @"steamgriddb":@"SteamGridDB"};
    NSDictionary* links = @{@"fanart":@"https://fanart.tv/", @"tmdb":@"https://www.themoviedb.org/", @"tvmaze":@"https://www.tvmaze.com/", @"steamgriddb":@"https://www.steamgriddb.com/"};
    NSArray* enabled = [[preferences() stringForKey:@"providers"] componentsSeparatedByString:@","];
        NSString* key = _providerOrder[i];
        NSButton* check = [self button:names[key] type:NSButtonTypeSwitch action:@selector(providerEnabled:)];
        check.identifier = key; check.state = [enabled containsObject:key]; [check.widthAnchor constraintEqualToConstant:160].active = YES;
        NSButton* up = [NSButton buttonWithTitle:@"↑" target:self action:@selector(moveProvider:)]; up.identifier = key; up.tag = -1; up.enabled = i > 0; up.toolTip = @"Move provider up";
        NSButton* down = [NSButton buttonWithTitle:@"↓" target:self action:@selector(moveProvider:)]; down.identifier = key; down.tag = 1; down.enabled = i + 1 < _providerOrder.count; down.toolTip = @"Move provider down";
        NSButton* site = [NSButton buttonWithTitle:@"Website ↗" target:self action:@selector(providerLink:)]; site.identifier = links[key];
        NSImageView* grip = [NSImageView imageViewWithImage:[NSImage imageWithSystemSymbolName:@"line.3.horizontal" accessibilityDescription:@"Drag to reorder"]];
        grip.contentTintColor = NSColor.tertiaryLabelColor; [grip.widthAnchor constraintEqualToConstant:20].active = YES;
        NSStackView* row = [NSStackView stackViewWithViews:@[grip, check, up, down, site]]; row.spacing = 8;
        return row;
}
- (void)providerEnabled:(NSButton*)sender {
    NSMutableArray* enabled = [NSMutableArray array];
    NSArray* previous = [[preferences() stringForKey:@"providers"] componentsSeparatedByString:@","];
    for (NSString* key in _providerOrder)
        if ([key isEqualToString:sender.identifier] ? sender.state == NSControlStateValueOn : [previous containsObject:key]) [enabled addObject:key];
    // Same fallback as the Windows options: keep at least TMDB as the base provider.
    if (!enabled.count) [enabled addObject:@"tmdb"];
    [preferences() setObject:[enabled componentsJoinedByString:@","] forKey:@"providers"];
    [self fadeProviderRows]; [self refreshArtworkProviders];
}
- (void)refreshArtworkProviders {
    auto state = _session;
    if (!state || state->cancelled.load()) return;
    ssc::platform::LockGuard lock(state->mediaMutex);
    state->mediaOptions.providers = [preferences() stringForKey:@"providers"].UTF8String ?: "tmdb";
    state->mediaOptions.fanartClientKey = [preferences() stringForKey:@"fanartClientKey"].UTF8String ?: "";
    state->revision.store(state->pipeline->options(state->mediaOptions));
}
- (void)fadeProviderRows {
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext* c) { c.duration = duration() / 2; _providerTable.animator.alphaValue = 0; }
        completionHandler:^{ [_providerTable reloadData]; [NSAnimationContext runAnimationGroup:^(NSAnimationContext* c) {
            c.duration = duration() / 2; _providerTable.animator.alphaValue = 1;
        } completionHandler:nil]; }];
}
- (void)moveProvider:(NSButton*)sender {
    NSInteger index = [_providerOrder indexOfObject:sender.identifier], next = index + sender.tag;
    if (index == NSNotFound || next < 0 || next >= (NSInteger)_providerOrder.count) return;
    [self moveProviderAt:index to:next];
}
- (void)moveProviderAt:(NSInteger)index to:(NSInteger)next {
    NSString* key = _providerOrder[index]; [_providerOrder removeObjectAtIndex:index]; [_providerOrder insertObject:key atIndex:next];
    NSArray* enabled = [[preferences() stringForKey:@"providers"] componentsSeparatedByString:@","];
    NSMutableArray* ordered = [NSMutableArray array];
    for (NSString* key in _providerOrder) if ([enabled containsObject:key]) [ordered addObject:key];
    [preferences() setObject:[ordered componentsJoinedByString:@","] forKey:@"providers"];
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext* context) {
        context.duration = duration(); [_providerTable moveRowAtIndex:index toIndex:next];
    } completionHandler:^{ [_providerTable reloadData]; }];
    [_providerTable selectRowIndexes:[NSIndexSet indexSetWithIndex:next] byExtendingSelection:NO];
    [self refreshArtworkProviders];
}
- (id<NSPasteboardWriting>)tableView:(NSTableView*)tableView pasteboardWriterForRow:(NSInteger)row {
    if (tableView != _providerTable) return nil;
    NSPasteboardItem* item = [NSPasteboardItem new]; [item setString:_providerOrder[row] forType:@"app.dudesoft.covers.provider"]; return item;
}
- (NSDragOperation)tableView:(NSTableView*)tableView validateDrop:(id<NSDraggingInfo>)info proposedRow:(NSInteger)row proposedDropOperation:(NSTableViewDropOperation)operation {
    if (tableView != _providerTable || info.draggingSource != _providerTable || row < 0 || row > (NSInteger)_providerOrder.count) return NSDragOperationNone;
    [tableView setDropRow:row dropOperation:NSTableViewDropAbove]; return NSDragOperationMove;
}
- (BOOL)tableView:(NSTableView*)tableView acceptDrop:(id<NSDraggingInfo>)info row:(NSInteger)row dropOperation:(NSTableViewDropOperation)operation {
    if (tableView != _providerTable || info.draggingSource != _providerTable || row < 0 || row > (NSInteger)_providerOrder.count) return NO;
    NSString* key = [info.draggingPasteboard stringForType:@"app.dudesoft.covers.provider"];
    NSInteger index = [_providerOrder indexOfObject:key]; if (index == NSNotFound) return NO;
    NSInteger next = row > index ? row - 1 : row;
    if (next != index) [self moveProviderAt:index to:next]; return YES;
}
- (void)providerLink:(NSButton*)sender { [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:sender.identifier]]; }
- (void)keyStatus:(NSString*)message {
    if (!_keyStatus) return;
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext* c) { c.duration = duration() / 2; _keyStatus.animator.alphaValue = 0; }
        completionHandler:^{ _keyStatus.stringValue = message; [NSAnimationContext runAnimationGroup:^(NSAnimationContext* c) {
            c.duration = duration() / 2; _keyStatus.animator.alphaValue = 1;
        } completionHandler:nil]; }];
}
- (void)controlTextDidEndEditing:(NSNotification*)note {
    if (note.object != _fanartKey) return;
    NSUserDefaults* defaults = preferences();
    if ([_fanartKey.stringValue isEqualToString:[defaults stringForKey:@"fanartClientKey"]]) return;
    [defaults setObject:_fanartKey.stringValue forKey:@"fanartClientKey"];
    [defaults removeObjectForKey:@"fanartKeyVerifiedAt"]; [self keyStatus:@"Not checked"];
    [self refreshArtworkProviders];
}
- (void)checkKey:(NSButton*)sender {
    NSString* key = [_fanartKey.stringValue copy];
    [preferences() setObject:key forKey:@"fanartClientKey"];
    [preferences() removeObjectForKey:@"fanartKeyVerifiedAt"];
    sender.enabled = NO; [self keyStatus:@"Checking…"];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        @autoreleasepool {
            auto result = ssc::MediaResolver().checkFanartClientKey(key.UTF8String);
            dispatch_async(dispatch_get_main_queue(), ^{
                sender.enabled = YES;
                if (![_fanartKey.stringValue isEqualToString:key]) return;
                using Status = ssc::FanartKeyCheckStatus;
                if (result.status == Status::Accepted) {
                    [preferences() setDouble:NSDate.date.timeIntervalSince1970 * 1000 forKey:@"fanartKeyVerifiedAt"];
                    [self keyStatus:@"Key verified"]; [self refreshArtworkProviders];
                } else [self keyStatus:result.status == Status::Rejected ? @"Key rejected" : result.status == Status::Invalid ? @"Enter a valid personal client key" : @"Check failed — please retry"];
            });
        }
    });
}

- (void)refresh:(id)sender { if (_session) _session->monitor->refresh(); }
- (void)fullscreen:(id)sender { [_window toggleFullScreen:sender]; }
- (void)openStation:(id)sender {
    if (_session) [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:[NSString stringWithFormat:@"https://%s", ssc::station(_session->station).host]]];
}
- (BOOL)windowShouldClose:(NSWindow*)window {
    if (window == _window) { [NSApp terminate:nil]; return NO; }
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext* c) { c.duration = duration(); window.animator.alphaValue = 0; }
        completionHandler:^{ [window orderOut:nil]; }]; return NO;
}
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication*)sender {
    if (_quitting) return NSTerminateNow;
    _quitting = YES;
    [self stopSession];
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext* c) {
        c.duration = duration(); _window.animator.alphaValue = 0; _settings.animator.alphaValue = 0;
    } completionHandler:nil];
    // Complete the fade in the regular event loop, then re-enter termination.
    // NSTerminateLater's modal loop can starve layer completion callbacks.
    NSTimer* quitTimer = [NSTimer timerWithTimeInterval:std::max(0.05, duration()) repeats:NO block:^(NSTimer* timer) {
        [NSApp terminate:nil];
    }];
    [NSRunLoop.mainRunLoop addTimer:quitTimer forMode:NSRunLoopCommonModes];
    [NSRunLoop.mainRunLoop addTimer:quitTimer forMode:NSModalPanelRunLoopMode];
    return NSTerminateCancel;
}
@end

static int smokeTest() {
    // Exercises the actual TLS transport, common parser and bounded ImageIO decoder.
    ssc::CoverMonitor monitor([](const std::string&, const ssc::TrackInfo&) {});
    ssc::TrackInfo track; std::string error;
    if (!monitor.pollOnce(track, &error)) { fprintf(stderr, "Feed failed: %s\n", error.c_str()); return 1; }
    NSImage* cover = downloadCover(track.coverUrl.empty() ? ssc::station(0).logoUrl : track.coverUrl, 0, nullptr);
    if (!cover) { fprintf(stderr, "Image download/decode failed\n"); return 2; }
    std::atomic<bool> cancelled{true};
    auto response = ssc::httpRequest(ssc::station(0).host, 443, "/", "GET", "", "", 10, &cancelled);
    if (response.ok() || response.error != "Cancelled") return 3;
    ssc::MediaRequest normalization;
    normalization.album = "Loving Vincent, The"; normalization.track = "Cue &#039;A&#039;";
    normalization.artist = "Caf&amp;eacute;"; normalization.includeArt = false; normalization.includeRatings = false;
    const auto canonical = ssc::MediaResolver().resolve(normalization);
    if (!canonical.hasMetadata || canonical.album != "The Loving Vincent" || canonical.track != "Cue 'A'"
        || canonical.artist != "Caf&eacute;") { fprintf(stderr, "Shared API metadata contract failed\n"); return 4; }
    printf("PASS: native TLS, feed, image decode, cancellation, shared API HTML/article normalization\n%s — %s\n", track.album.c_str(), track.track.c_str());
    return 0;
}
static int artworkTest() {
    ssc::CoverMonitor monitor([](const std::string&, const ssc::TrackInfo&) {});
    ssc::TrackInfo track; std::string error;
    if (!monitor.pollOnce(track, &error)) { fprintf(stderr, "%s\n", error.c_str()); return 1; }
    for (bool portrait : {true, false}) {
        ssc::MediaRequest request; request.width = portrait ? 984 : 1960; request.height = portrait ? 1490 : 1120;
        request.includeTitleLogo = true; request.includeRatings = false;
        auto frame = ssc::preparePresentation(track, request, 0);
        printf("Artwork %dx%d: %s; status=%d; backdrop=%zu; url=%s; error=%s\n", request.width, request.height,
            track.album.c_str(), frame.media.status, frame.backdrop.size(), frame.media.backdropUrl.c_str(), frame.media.error.c_str());
        if (frame.media.status == ssc::MediaResult::Failure || (frame.media.hasBackdrop() && frame.backdrop.empty())) return 2;
    }
    return 0;
}
int main(int argc, const char* argv[]) {
    @autoreleasepool {
        if (argc == 2 && std::string(argv[1]) == "--smoke-test") return smokeTest();
        if (argc == 2 && std::string(argv[1]) == "--artwork-test") return artworkTest();
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        SSCApp* delegate = [SSCApp new]; NSApp.delegate = delegate;
        [NSApp run];
    }
    return 0;
}
