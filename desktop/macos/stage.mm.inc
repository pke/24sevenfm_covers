// AppKit adapter: decoding and measuring remain native. Every presentation
// transition is sampled by the shared controller before AppKit draws a frame.
static std::wstring presentationWide(NSString* value) {
    NSData* data = [value dataUsingEncoding:NSUTF32LittleEndianStringEncoding];
    return data.length ? std::wstring((const wchar_t*)data.bytes, data.length / sizeof(wchar_t)) : std::wstring();
}
static NSString* native(const std::wstring& value) {
    return [[NSString alloc] initWithBytes:value.data() length:value.size()*sizeof(wchar_t)
        encoding:NSUTF32LittleEndianStringEncoding] ?: @"";
}

@interface SSCStage : NSView {
    ssc::PresentationController _presentation;
    ssc::FrameState _frame;
    std::map<std::string, NSImage*> _images;
    SSCScene* _current;
    SSCScene* _nextScene;
    std::map<std::string, NSArray<NSImage*>*> _ratingSets;
    NSTimer* _animation;
    NSTimer* _visibilityTimer;
    NSTrackingArea* _tracking;
    BOOL _pointerInside;
    int _remainingSeconds;
    std::string _trackIdentity;
}
@property(nonatomic) BOOL poster;
@property(nonatomic) BOOL showCountdown;
@property(copy) void (^doubleClick)(void);
@property(nonatomic) NSInteger countdownSize;
@property(nonatomic) BOOL rollDigits;
@property(nonatomic) BOOL comingNext;
@property(nonatomic) NSInteger transition;
@property(nonatomic) NSInteger fadeMs;
@property(nonatomic) BOOL hideCoverWithBackdrop;
@property(nonatomic) BOOL ratingsEnabled;
@property(strong) NSButton* settingsButton;
- (void)setNextScene:(SSCScene*)scene;
- (void)present:(SSCScene*)scene;
- (void)trackChanged:(const std::string&)identity;
- (void)remaining:(int)seconds identity:(const std::string&)identity;
- (void)remaining:(int)seconds;
- (NSRect)nextRect;
- (void)setRatingImages:(NSArray<NSImage*>*)images;
@end

@implementation SSCStage
- (instancetype)initWithFrame:(NSRect)rect {
    if ((self = [super initWithFrame:rect])) {
        self.wantsLayer = YES;
        self.layerContentsRedrawPolicy = NSViewLayerContentsRedrawDuringViewResize;
        self.layer.backgroundColor = NSColor.blackColor.CGColor;
        self.accessibilityElement = YES; self.accessibilityRole = NSAccessibilityImageRole;
        _poster = YES; _fadeMs = 1000; _transition = 1; _hideCoverWithBackdrop = YES; _remainingSeconds = -1;
        __weak SSCStage* weak = self;
        _visibilityTimer = [NSTimer scheduledTimerWithTimeInterval:.2 repeats:YES block:^(NSTimer* timer) {
            SSCStage* stage = weak; if (!stage) { [timer invalidate]; return; }
            [stage updateVisibility];
        }];
    }
    return self;
}
- (BOOL)isOpaque { return YES; }
- (void)cacheScene:(SSCScene*)scene {
    if (!scene) return;
    // Synthetic native UI fixtures use object identity; prepared production frames
    // supply immutable byte keys so provider/viewport refreshes deduplicate covers.
    if (scene->identity.empty()) scene->identity = std::string((scene.station ?: @"").UTF8String) + "\n"
        + (scene.album ?: @"").UTF8String + "\n" + (scene.track ?: @"").UTF8String;
    if (scene->coverKey.empty()) scene->coverKey = "cover:" + std::to_string((uintptr_t)(__bridge void*)scene.cover);
    if (scene->backdropKey.empty()) scene->backdropKey = "background:" + std::to_string((uintptr_t)(__bridge void*)(scene.backdrop ?: scene.blurredCover ?: scene.cover));
    if (scene.cover) _images[scene->coverKey] = scene.cover;
    if (scene.backdrop || scene.blurredCover || scene.cover)
        _images[scene->backdropKey] = scene.backdrop ?: scene.blurredCover ?: scene.cover;
    if (scene.logo && !scene->logoKey.empty()) _images[scene->logoKey] = scene.logo;
}
- (ssc::TitleLogoSize)logoSize:(NSImage*)image {
    if (!image) return {0,0,0};
    NSImageRep* rep = image.representations.firstObject;
    const auto font = ssc::posterTypography(self.bounds.size.width, self.bounds.size.height);
    return ssc::titleLogoSize(rep.pixelsWide > 0 ? rep.pixelsWide : image.size.width,
        rep.pixelsHigh > 0 ? rep.pixelsHigh : image.size.height,
        self.bounds.size.width, self.bounds.size.height, font.title, 1);
}
- (NSImage*)imageForKey:(const std::string&)key {
    const auto found = _images.find(key); return found == _images.end() ? nil : found->second;
}
- (void)updateMeasurements {
    const auto font = ssc::posterTypography(self.bounds.size.width, self.bounds.size.height);
    const CGFloat maxWidth = std::max(1.0, self.bounds.size.width*.86-font.padX*2);
    NSString* album = native(_frame.album.empty() ? _frame.title : _frame.album);
    NSArray* strings = @[album, native(_frame.artist), native(_frame.track)];
    const CGFloat sizes[] = {font.title, font.artist, font.track};
    const NSFontWeight weights[] = {NSFontWeightSemibold, NSFontWeightRegular, NSFontWeightMedium};
    CGFloat width = 40;
    for (NSUInteger i=0; i<3; ++i) {
        NSRect measured = [strings[i] boundingRectWithSize:NSMakeSize(maxWidth,CGFLOAT_MAX)
            options:NSStringDrawingUsesLineFragmentOrigin | NSStringDrawingUsesFontLeading
            attributes:@{NSFontAttributeName:[NSFont systemFontOfSize:sizes[i] weight:weights[i]]}];
        width = std::max(width, std::ceil(measured.size.width)*(i == 0 ? 1-_frame.logoLayout : 1));
    }
    width = std::max(width, _frame.countdown.fontSize*4.5*_frame.countdown.opacity);
    const auto logo = [self logoSize:[self imageForKey:_frame.logo]];
    const CGFloat targetWidth = ssc::posterInfoWidth(self.bounds.size.width,width,font.padX,1,logo.width*_frame.logoLayout);
    _presentation.measured(ssc::VisualChannel::InfoWidth,targetWidth);
    const CGFloat textWidth = std::max(1.0,targetWidth-font.padX*2);
    const CGFloat albumHeight = textHeight(album,textWidth,font.title,NSFontWeightSemibold);
    const CGFloat row = albumHeight+(logo.rowHeight-albumHeight)*_frame.logoLayout;
    const CGFloat target = font.padY*2 + row + textHeight(strings[1],textWidth,font.artist,NSFontWeightRegular)
        + textHeight(strings[2],textWidth,font.track,NSFontWeightMedium) + font.lineGap + font.title*.12;
    _presentation.measured(ssc::VisualChannel::InfoHeight,target);
    SSCScene* next = [SSCScene new]; next.album = native(_frame.next.album); next.artist = native(_frame.next.artist);
    const auto nextFont = ssc::nextTypography(self.bounds.size.width);
    const auto textSize = nextTextSize(nextTextCells(next,nextFont));
    _presentation.measuredNext(textSize.width,textSize.height);
}
- (void)updateFrame {
    ssc::PresentationSettings settings;
    settings.poster = _poster; settings.countdown = _showCountdown; settings.countdownSize = (int)_countdownSize;
    settings.rolling = _rollDigits; settings.next = _comingNext; settings.ratings = _ratingsEnabled;
    settings.effect = (int)_transition; settings.fadeMs = (int)_fadeMs; settings.hideCover = _hideCoverWithBackdrop;
    settings.reducedMotion = NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
    _presentation.viewportChanged(self.bounds.size.width,self.bounds.size.height,1,self.userInterfaceLayoutDirection==NSUserInterfaceLayoutDirectionRightToLeft);
    _presentation.settingsChanged(settings); _presentation.remainingChanged(_remainingSeconds);
    _presentation.pointerChanged(_pointerInside,(self.window.styleMask & NSWindowStyleMaskFullScreen) != 0,false);
    _frame = _presentation.advance(); [self updateMeasurements]; _frame = _presentation.advance();
    self.settingsButton.alphaValue = _frame.controlsOpacity;
    self.settingsButton.enabled = _frame.controlsOpacity > .5;
    std::set<std::string> liveRatings;
    for (const auto& layer:_frame.ratings) liveRatings.insert(*layer.image);
    for (auto it=_ratingSets.begin();it!=_ratingSets.end();) {
        if (!liveRatings.count(it->first)) it=_ratingSets.erase(it); else ++it;
    }
    // Native resources live in this adapter's cache and survive every outgoing
    // layer. Release retired images only after the controller drops its references.
    std::set<std::string> live;
    for (const auto& layer : _frame.cover) live.insert(*layer.image);
    for (const auto& layer : _frame.backdrop) live.insert(*layer.image);
    live.insert(_frame.logo);
    if (_frame.next.cover) live.insert(*_frame.next.cover);
    for (SSCScene* scene in @[_current ?: [NSNull null], _nextScene ?: [NSNull null]]) {
        if ((id)scene == NSNull.null) continue;
        live.insert(scene->coverKey); live.insert(scene->backdropKey); live.insert(scene->logoKey);
    }
    for (auto it=_images.begin(); it!=_images.end();) {
        if (!live.count(it->first)) it=_images.erase(it); else ++it;
    }
    self.needsDisplay = YES;
}
- (void)animate {
    [self updateFrame];
    if (_animation || !_frame.animating) return;
    __weak SSCStage* weak = self;
    _animation = [NSTimer scheduledTimerWithTimeInterval:1.0/60 repeats:YES block:^(NSTimer* timer) {
        SSCStage* stage = weak; if (!stage) { [timer invalidate]; return; }
        [stage updateFrame];
        if (!stage->_frame.animating) { [timer invalidate]; stage->_animation = nil; }
    }];
    [NSRunLoop.mainRunLoop addTimer:_animation forMode:NSRunLoopCommonModes];
}
- (void)updateVisibility { [self animate]; }
- (void)trackChanged:(const std::string&)identity {
    if (_trackIdentity==identity) return;
    _trackIdentity=identity; _presentation.trackChanged(identity); _remainingSeconds=-1;
    [self setNextScene:nil]; [self animate];
}
- (void)remaining:(int)seconds identity:(const std::string&)identity {
    if (_trackIdentity!=identity) return;
    [self remaining:seconds];
}
- (void)present:(SSCScene*)scene {
    [self cacheScene:scene];
    const bool newTrack = !_current || _current->identity != scene->identity;
    _trackIdentity=scene->identity;
    const auto token = _presentation.trackChanged(scene->identity);
    _presentation.resolverCompleted(token,presentationWide(scene.album),presentationWide(scene.artist),presentationWide(scene.album),presentationWide(scene.track),true);
    _presentation.assetReady(token, scene.cover ? std::make_shared<const std::string>(scene->coverKey) : ssc::ImageReference());
    _presentation.assetReady(token, (scene.backdrop || scene.cover) ? std::make_shared<const std::string>(scene->backdropKey) : ssc::ImageReference(),true);
    _presentation.setLogo(scene->logoKey,presentationWide(scene.album)); _presentation.backdropChanged(scene.backdrop != nil);
    _current = scene; [self presentRatingImages:scene.ratings];
    if (newTrack) [self setNextScene:nil];
    self.accessibilityLabel = [NSString stringWithFormat:@"%@, %@, %@",scene.album ?: @"",scene.artist ?: @"",scene.track ?: @""];
    [self animate];
}
- (void)setNextScene:(SSCScene*)scene {
    _nextScene = scene; [self cacheScene:scene];
    _presentation.comingNext.setQueue(scene ? scene->identity : "",presentationWide(scene.album),presentationWide(scene.artist));
    if (scene.cover) _presentation.comingNext.setCover(scene->identity,scene->coverKey);
    [self animate];
}
- (void)presentRatingImages:(NSArray<NSImage*>*)images {
    std::string key;
    for (NSImage* image in images) key+=std::to_string((uintptr_t)(__bridge void*)image)+":";
    if (!key.empty()) _ratingSets[key]=images;
    _presentation.setRatingContent(key.empty()?ssc::ImageReference():std::make_shared<const std::string>(key));
}
- (void)setRatingImages:(NSArray<NSImage*>*)images {
    if ([_current.ratings isEqualToArray:images]) return;
    _current.ratings = images; [self presentRatingImages:images]; [self animate];
}
- (void)remaining:(int)seconds { _remainingSeconds=seconds; [self animate]; }
- (void)setPoster:(BOOL)value { _poster=value; [self animate]; }
- (void)setShowCountdown:(BOOL)value { _showCountdown=value; [self animate]; }
- (void)setCountdownSize:(NSInteger)value { _countdownSize=std::clamp((int)value,0,2); [self animate]; }
- (void)setRollDigits:(BOOL)value { _rollDigits=value; [self animate]; }
- (void)setComingNext:(BOOL)value { _comingNext=value; [self animate]; }
- (void)setRatingsEnabled:(BOOL)value { _ratingsEnabled=value; [self animate]; }
- (void)setHideCoverWithBackdrop:(BOOL)value { _hideCoverWithBackdrop=value; [self animate]; }
- (void)setFrameSize:(NSSize)size { [super setFrameSize:size]; [self animate]; }
- (void)viewDidEndLiveResize { [super viewDidEndLiveResize]; [self animate]; }
- (void)updateTrackingAreas {
    [super updateTrackingAreas]; if (_tracking) [self removeTrackingArea:_tracking];
    _tracking=[[NSTrackingArea alloc] initWithRect:NSZeroRect options:NSTrackingMouseEnteredAndExited | NSTrackingMouseMoved
        | NSTrackingActiveAlways | NSTrackingInVisibleRect owner:self userInfo:nil]; [self addTrackingArea:_tracking];
}
- (void)mouseEntered:(NSEvent*)event { _pointerInside=YES; [self mouseMoved:event]; }
- (void)mouseExited:(NSEvent*)event { _pointerInside=NO; [self animate]; }
- (void)mouseMoved:(NSEvent*)event {
    _presentation.pointerChanged(_pointerInside,(self.window.styleMask & NSWindowStyleMaskFullScreen)!=0,true); [self animate];
}
- (NSRect)nativeRect:(const ssc::PresentationRect&)rect {
    return NSMakeRect(rect.x,self.bounds.size.height-rect.y-rect.height,rect.width,rect.height);
}
- (NSRect)infoRect { return [self nativeRect:_frame.infoRect]; }
- (NSRect)countdownRect { return [self nativeRect:_frame.countdownRect]; }
- (NSRect)nextRect { return [self nativeRect:_frame.nextRect]; }
- (void)drawLayers:(const std::vector<ssc::ImageLayer>&)layers rect:(NSRect)rect fill:(BOOL)fill opacity:(float)opacity {
    for (const auto& layer : layers) {
        [NSGraphicsContext saveGraphicsState];
        NSAffineTransform* transform=[NSAffineTransform transform];
        [transform translateXBy:NSMidX(rect) yBy:NSMidY(rect)]; [transform scaleXBy:layer.scaleX yBy:layer.scaleY];
        [transform translateXBy:-NSMidX(rect) yBy:-NSMidY(rect)]; [transform concat];
        drawImage([self imageForKey:*layer.image],rect,fill,layer.opacity*opacity);
        [NSGraphicsContext restoreGraphicsState];
    }
}
- (void)drawRatingImages:(NSArray<NSImage*>*)images alpha:(CGFloat)alpha {
    CGFloat size=ssc::ratingLogoHeight(self.bounds.size.height,1),margin=size/2.35*.45,x=self.bounds.size.width-margin;
    for (NSImage* image in images.reverseObjectEnumerator) { x-=size; drawImage(image,NSMakeRect(x,margin,size,size),false,alpha); x-=margin*.7; }
}
- (void)drawRect:(NSRect)dirty {
    [NSColor.blackColor setFill]; NSRectFill(self.bounds);
    [self drawLayers:_frame.backdrop rect:self.bounds fill:YES opacity:1];
    [[NSColor.blackColor colorWithAlphaComponent:.18] setFill]; NSRectFillUsingOperation(self.bounds,NSCompositingOperationSourceOver);
    const auto b=self.bounds,info=[self infoRect]; const float p=_frame.poster;
    const NSRect cover=[self nativeRect:_frame.coverRect];
    const CGFloat side=cover.size.width;
    [NSGraphicsContext saveGraphicsState];
    [[NSBezierPath bezierPathWithRoundedRect:cover xRadius:side*_frame.radius/1000*p yRadius:side*_frame.radius/1000*p] addClip];
    [self drawLayers:_frame.cover rect:cover fill:NO opacity:_frame.coverOpacity]; [NSGraphicsContext restoreGraphicsState];
    const float alpha=_frame.infoOpacity;
    [[NSColor colorWithSRGBRed:10/255.0 green:12/255.0 blue:18/255.0 alpha:.55*alpha*p] setFill];
    [[NSBezierPath bezierPathWithRoundedRect:info xRadius:side*.045 yRadius:side*.045] fill];
    const auto font=ssc::posterTypography(b.size.width,b.size.height);
    const CGFloat width=std::max(1.0,info.size.width-font.padX*2),x=info.origin.x+font.padX;
    NSString* album=native(_frame.album.empty()?_frame.title:_frame.album);
    NSImage* logo=[self imageForKey:_frame.logo]; const auto logoSize=[self logoSize:logo];
    const CGFloat textRow=textHeight(album,width,font.title,NSFontWeightSemibold);
    const CGFloat row=textRow+(logoSize.rowHeight-textRow)*_frame.logoLayout;
    CGFloat top=NSMaxY(info)-font.padY-row;
    const float logoAlpha=_frame.logoAlbum==_frame.album?_frame.logoOpacity:0;
    drawText(album,NSMakeRect(x,top,width,textRow),font.title,NSFontWeightSemibold,alpha*(1-logoAlpha),_current.tint);
    const auto lr=ssc::titleLogoRect(NSMidX(info),NSMaxY(info),logoSize,logoHorizontalAnchor(logo));
    drawImage(logo,NSMakeRect(lr.left,lr.top,lr.right-lr.left,lr.bottom-lr.top),false,alpha*logoAlpha);
    const auto artist=native(_frame.artist),track=native(_frame.track);
    const CGFloat artistHeight=textHeight(artist,width,font.artist,NSFontWeightRegular); top-=artistHeight+font.lineGap;
    drawText(artist,NSMakeRect(x,top,width,artistHeight),font.artist,NSFontWeightRegular,alpha*.8,_current.tint);
    const CGFloat trackHeight=textHeight(track,width,font.track,NSFontWeightMedium); top-=trackHeight+font.title*.12;
    drawText(track,NSMakeRect(x,top,width,trackHeight),font.track,NSFontWeightMedium,alpha,_current.tint);
    for (const auto& layer:_frame.ratings) {
        auto found=_ratingSets.find(*layer.image);
        if (found!=_ratingSets.end()) [self drawRatingImages:found->second alpha:_frame.ratingOpacity*layer.opacity];
    }
    const NSRect r=[self countdownRect]; const CGFloat size=_frame.countdown.fontSize,height=size*1.4,digitWidth=size*.68;
    [NSGraphicsContext saveGraphicsState]; NSRectClip(r);
    const CGFloat total=digitWidth*_frame.countdown.columns.size();
    CGFloat left=NSMaxX(r)-total-(r.size.width-total)*.5*p;
    for (const auto& column:_frame.countdown.columns) {
        for (const auto& digit:column.layers) {
            NSString* value=[NSString stringWithFormat:@"%c",digit.digit];
            drawDigit(value,NSMakeRect(left,r.origin.y-digit.offset*height,digitWidth,height),size,digit.opacity*_frame.countdown.opacity,_current.tint);
        }
        left+=digitWidth;
    }
    [NSGraphicsContext restoreGraphicsState];
    if (_frame.next.opacity>0) {
        const auto font=ssc::nextTypography(b.size.width); const bool rtl=self.userInterfaceLayoutDirection==NSUserInterfaceLayoutDirectionRightToLeft;
        const auto card=[self nextRect]; const float a=_frame.next.opacity;
        [[NSColor.blackColor colorWithAlphaComponent:.62*a] setFill]; [[NSBezierPath bezierPathWithRoundedRect:card xRadius:12 yRadius:12] fill];
        const CGFloat coverSide=font.cover*_frame.nextCoverLayout;
        const CGFloat coverX=rtl?NSMaxX(card)-font.padX-coverSide:card.origin.x+font.padX;
        if (_frame.next.cover) drawImage([self imageForKey:*_frame.next.cover],NSMakeRect(coverX,NSMidY(card)-coverSide/2,coverSide,coverSide),false,a*_frame.next.coverOpacity);
        const CGFloat column=_frame.next.cover?(font.cover+font.gap)*_frame.nextCoverLayout:0;
        const CGFloat textWidth=std::max(1.0,card.size.width-font.padX*2-column),textX=card.origin.x+font.padX+(rtl?0:column);
        CGFloat y=NSMaxY(card)-font.padY;
        SSCScene* scene=[SSCScene new]; scene.album=native(_frame.next.album); scene.artist=native(_frame.next.artist);
        NSArray<NSTextFieldCell*>* cells=nextTextCells(scene,font,rtl);
        for (NSUInteger i=0;i<cells.count;++i) {
            NSTextFieldCell* cell=cells[i]; if (!cell.stringValue.length) continue;
            const CGFloat h=std::ceil(cell.cellSize.height); y-=h; cell.textColor=[NSColor.whiteColor colorWithAlphaComponent:a*(i==0?.72:i==1?1:.82)];
            [cell drawInteriorWithFrame:NSMakeRect(textX,y,textWidth,h) inView:self]; y-=i==0?3:1.3;
        }
    }
}
- (BOOL)verifyBackgroundBlend {
    ssc::PresentationTime tick=0; ssc::PresentationController test([&]{return tick;});
    auto red=std::make_shared<const std::string>("red"),blue=std::make_shared<const std::string>("blue");
    _images["red"]=[NSImage imageWithSize:self.bounds.size flipped:NO drawingHandler:^BOOL(NSRect rect){[NSColor.redColor setFill];NSRectFill(rect);return YES;}];
    _images["blue"]=[NSImage imageWithSize:self.bounds.size flipped:NO drawingHandler:^BOOL(NSRect rect){[NSColor.blueColor setFill];NSRectFill(rect);return YES;}];
    test.setArtwork(red,true); tick=1000; test.advance(); test.setArtwork(blue,true); tick=1500; _frame=test.advance();
    NSBitmapImageRep* bitmap=[self bitmapImageRepForCachingDisplayInRect:self.bounds]; [self cacheDisplayInRect:self.bounds toBitmapImageRep:bitmap];
    NSColor* pixel=[[bitmap colorAtX:1 y:1] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    if (pixel.redComponent<.3 || pixel.blueComponent<.3) return NO;
    test.setArtwork(red,true); _frame=test.advance();
    [self cacheDisplayInRect:self.bounds toBitmapImageRep:bitmap];
    NSColor* reversed=[[bitmap colorAtX:1 y:1] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    return std::abs(pixel.redComponent-reversed.redComponent)<.03 && std::abs(pixel.blueComponent-reversed.blueComponent)<.03;
}
- (void)mouseDown:(NSEvent*)event { if (event.clickCount==2 && self.doubleClick) self.doubleClick(); else [super mouseDown:event]; }
@end
