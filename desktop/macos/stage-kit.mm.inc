#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import "player_bridge.h"
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
#include <signal.h>

static NSString* text(const std::string& s) { return [NSString stringWithUTF8String:s.c_str()] ?: @""; }
#ifdef SSC_IN_FOOBAR
#include "../../foobar2000/macos/settings.h"
static id preferences() { return SSCCoversPreferences(); }
#else
static NSUserDefaults* preferences() {
    static NSUserDefaults* store;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        if (NSProcessInfo.processInfo.environment[@"SSC_UI_CHECK_DIR"].length || NSProcessInfo.processInfo.environment[@"SSC_PLAYER_TEST_DIR"].length) {
            NSString* suite = NSProcessInfo.processInfo.environment[@"SSC_PLAYER_TEST_DIR"].length
                ? @"app.dudesoft.24sevenfm.covers.player-check" : @"app.dudesoft.24sevenfm.covers.ui-check";
            store = [[NSUserDefaults alloc] initWithSuiteName:suite];
            [store removePersistentDomainForName:suite];
        } else {
            store = NSUserDefaults.standardUserDefaults;
        }
    });
    return store;
}
#endif
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
