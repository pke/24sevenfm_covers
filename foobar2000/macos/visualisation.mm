#include <SDK/foobar2000.h>
#define SSC_IN_FOOBAR 1
#include "../../desktop/macos/stage-kit.mm.inc"
#include "../../desktop/macos/session.h"
#include "visualisation.h"

@class SSC24sevenVisualisation;
static NSHashTable<SSC24sevenVisualisation*>* views;
static NSWindow* popup;
static unsigned popupRevision=0;
static ssc::PlayerEvent latest;
static bool playing=false;
static bool paused=false;
static __weak SSC24sevenVisualisation* statusView;

@interface SSC24sevenVisualisation : NSViewController <NSWindowDelegate> {
    SSCStage* _stage;
    ssc::PlayerFollow _follow;
    std::shared_ptr<Session> _session;
    unsigned _frames;
    BOOL _cover;
    SSCScene* _lastScene;
    std::string _title;
}
- (void)event:(const ssc::PlayerEvent&)event;
- (void)stop;
- (void)applySettings;
- (void)openSettings:(id)sender;
- (NSDictionary*)status;
#ifdef SSC_PLAYER_E2E
- (BOOL)captureTest;
#endif
@end

static void writeStatus() {
    NSString* directory=NSProcessInfo.processInfo.environment[@"SSC_FOOBAR_TEST_DIR"];
    if(!directory.length)return;
    SSC24sevenVisualisation* view=[views containsObject:statusView]?statusView:views.allObjects.lastObject;
    NSMutableDictionary* status=[NSMutableDictionary dictionaryWithDictionary:view.status ?: @{}];
    status[@"views"]=@(views.allObjects.count);status[@"pid"]=@(NSProcessInfo.processInfo.processIdentifier);
    NSData* data=[NSJSONSerialization dataWithJSONObject:status options:0 error:nil];
    [data writeToFile:[directory stringByAppendingPathComponent:@"visualisation.json"] atomically:YES];
}

@implementation SSC24sevenVisualisation
- (void)loadView {
    NSMutableDictionary* defaults=[NSMutableDictionary dictionary];
    for(const auto& setting:ssccfg::settingsSchema(ssccfg::Profile::MacOS)) {
        if(setting.supported && setting.ui) defaults[text(setting.storageKey)]=setting.stringValue?(id)text(setting.defaultText):(id)@(setting.defaultInt);
    }
    [preferences() registerDefaults:defaults];
    _stage=[[SSCStage alloc] initWithFrame:NSMakeRect(0,0,680,760)];
    _stage.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;self.view=_stage;
    [self applySettings];
    NSMenu* context=[NSMenu new];NSMenuItem* settings=[context addItemWithTitle:@"24seven.fm Covers Settings…" action:@selector(openSettings:) keyEquivalent:@""];settings.target=self;_stage.menu=context;
    __weak SSC24sevenVisualisation* weak=self;
    _stage.doubleClick=^{[weak.view.window toggleFullScreen:nil];};
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(resized:) name:NSViewFrameDidChangeNotification object:_stage];
    _stage.postsFrameChangedNotifications=YES;
    if(!views)views=[NSHashTable weakObjectsHashTable];[views addObject:self];statusView=self;
    [self idle];
    [self restorePlayback];
    writeStatus();
}
- (void)openSettings:(id)sender { SSCCoversShowSettings(); }
- (void)applySettings {
    _stage.poster=[preferences() boolForKey:@"poster"];
    _stage.showCountdown=[preferences() boolForKey:@"countdown"];
    _stage.countdownSize=[preferences() integerForKey:@"remainingSize"];
    _stage.rollDigits=[preferences() boolForKey:@"rollDigits"];
    _stage.comingNext=[preferences() boolForKey:@"comingNext"];
    _stage.ratingsEnabled=[preferences() boolForKey:@"ratings"];
    _stage.transition=[preferences() integerForKey:@"transition"];
    _stage.fadeMs=[preferences() integerForKey:@"fadeMs"];
    _stage.hideCoverWithBackdrop=[preferences() boolForKey:@"hideCover"];
    [_stage setNeedsDisplay:YES];
    if(_session)[self start];
}
- (void)idle {
    SSCScene* scene=[SSCScene new];scene.album=@"24seven.fm Covers";scene.artist=@"Play a 24seven.fm station";scene.tint=NSColor.whiteColor;
    [_stage present:scene];_cover=NO;_lastScene=nil;
}
- (void)restorePlayback {
    if(!playing)return;
    ssc::PlayerEvent start=latest;start.activity=ssc::PlayerActivity::Start;
    if(!paused){[self event:start];return;}
    // A paused snapshot consumes no future sequence number and starts no network job.
    --start.sequence;_follow.apply(start);
    auto pause=latest;pause.activity=ssc::PlayerActivity::Pause;_follow.apply(pause);
    for(SSC24sevenVisualisation* view in views.allObjects) {
        if(view!=self && view->_follow.station()==_follow.station() && view->_lastScene) {
            _lastScene=view->_lastScene;[_stage present:_lastScene];_cover=_lastScene.cover!=nil;break;
        }
    }
    writeStatus();
}
- (void)viewWillDisappear {
    [super viewWillDisappear];[self stop];_follow=ssc::PlayerFollow();[views removeObject:self];writeStatus();
}
- (void)viewWillAppear {
    [super viewWillAppear];
    if(![views containsObject:self]) {
        [views addObject:self];statusView=self;
        [self restorePlayback];
    }
}
- (NSDictionary*)status {
    return @{@"station":@(_follow.station()),@"paused":@(_follow.paused()),@"monitor":@(_session!=nullptr),
        @"frames":@(_frames),@"cover":@(_cover),@"width":@(_stage.bounds.size.width),@"height":@(_stage.bounds.size.height)};
}
- (void)resized:(NSNotification*)note {
    if(_session) {
        NSSize pixels=[_stage convertSizeToBacking:_stage.bounds.size];
        ssc::platform::LockGuard lock(_session->mediaMutex);
        _session->mediaOptions.width=std::max(1,(int)pixels.width);_session->mediaOptions.height=std::max(1,(int)pixels.height);
        _session->pipeline->viewport(pixels.width,pixels.height);
    }
    writeStatus();
}
- (void)stop {
    auto previous=_session;_session.reset();
    if(previous) {
        previous->cancelled.store(true);previous->pipeline->cancel();
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY,0),^{previous->monitor->stop();previous->pipeline->stop();});
    }
}
- (void)dealloc {
    [NSNotificationCenter.defaultCenter removeObserver:self];[self stop];
    dispatch_async(dispatch_get_main_queue(),^{writeStatus();});
}
- (void)event:(const ssc::PlayerEvent&)event {
    auto change=_follow.apply(event);
    if(change==ssc::PlayerFollow::Change::Show) { _title=event.title;[self start]; }
    else if(change==ssc::PlayerFollow::Change::Pause) [self stop];
    else if(change==ssc::PlayerFollow::Change::Hide) { [self stop];[self idle]; }
    else if(change==ssc::PlayerFollow::Change::Update) {
        if(_session && !event.title.empty() && event.title!=_title) _session->monitor->refresh();
        _title=event.title;
    }
    writeStatus();
}
- (void)start {
    [self stop];_frames=0;
    auto session=std::make_shared<Session>();session->station=_follow.station();
    ssc::MediaPreferences prefs;prefs.station=session->station;
    prefs.backdrops=[preferences() boolForKey:@"backdrops"];prefs.logos=[preferences() boolForKey:@"logos"];prefs.ratings=[preferences() boolForKey:@"ratings"];
    prefs.providers=[preferences() stringForKey:@"providers"].UTF8String ?: "tmdb";
    prefs.fanartKey=[preferences() stringForKey:@"fanartClientKey"].UTF8String ?: "";
    if([preferences() boolForKey:@"ratingDE"])prefs.ratingCountries="DE";
    if([preferences() boolForKey:@"ratingUS"])prefs.ratingCountries+=prefs.ratingCountries.empty()?"US":",US";
    NSSize pixels=[_stage convertSizeToBacking:_stage.bounds.size];
    session->mediaOptions=ssc::mediaOptions(prefs,pixels.width,pixels.height);_session=session;
    if(!_lastScene){SSCScene* loading=[SSCScene new];loading.album=@"Connecting…";loading.artist=text(ssc::station(session->station).displayName);[_stage present:loading];}
    __weak SSC24sevenVisualisation* weak=self;std::weak_ptr<Session> weakSession=session;
    session->pipeline=std::make_unique<ssc::PresentationPipeline>(
        [weakSession](const ssc::TrackInfo& track,const ssc::MediaRequest& request,const std::atomic<bool>* cancel){
            auto state=weakSession.lock();if(!state || state->cancelled.load())return ssc::PresentationPipeline::Frame();
            return ssc::PresentationPipeline::Frame(std::make_shared<ssc::PreparedPresentation>(ssc::preparePresentation(track,request,state->station,cancel)));
        },
        [weakSession](const std::atomic<bool>* cancel){auto state=weakSession.lock();return state&&!state->cancelled.load()?ssc::stationQueue(state->station,cancel):std::vector<ssc::TrackInfo>();},
        [weak,weakSession](ssc::PresentationPipeline::Frame frame,bool queued,bool cached,unsigned long long generation){
            @autoreleasepool {
                auto state=weakSession.lock();if(!state || state->cancelled.load())return;
                SSCScene* scene=[SSCScene new];scene->identity=ssc::trackIdentity(frame->track,state->station);
                scene->coverKey="cover:"+frame->cover;scene->backdropKey=frame->backdrop.empty()?"blur:"+frame->cover:"backdrop:"+frame->backdrop;scene->logoKey=frame->logo;
                scene.cover=decode(frame->cover);scene.blurredCover=blurCover(scene.cover);scene.backdrop=decode(frame->backdrop);scene.logo=decodeLogo(frame->logo);
                scene.tint=frame->media.hasTint && scene.backdrop?[NSColor colorWithSRGBRed:frame->media.tint[0]/255.0 green:frame->media.tint[1]/255.0 blue:frame->media.tint[2]/255.0 alpha:1]:coverTint(scene.cover);
                NSMutableArray* ratings=[NSMutableArray array];for(const auto& rating:frame->ratings){NSImage* image=decode(rating.bytes);if(image)[ratings addObject:image];}scene.ratings=ratings;
                const auto metadata=ssc::presentationText(frame->track,frame->media,state->station);scene.album=text(metadata.album);scene.artist=text(metadata.artist);scene.track=text(metadata.track);scene.station=text(ssc::station(state->station).displayName);
                dispatch_async(dispatch_get_main_queue(),^{
                    SSC24sevenVisualisation* view=weak;
                    if(!view || view->_session!=state || state->pipeline->generation()!=generation)return;
                    if(queued)[view->_stage setNextScene:scene];
                    else { view->_lastScene=scene;[view->_stage present:scene];view->_cover=scene.cover!=nil;++view->_frames;writeStatus(); }
                });
            }
        });
    session->pipeline->viewport(pixels.width,pixels.height);
    ssc::Config config;config.host=ssc::station(session->station).host;config.errorRetrySeconds=8;config.cycleErrorRetryAfterCap=true;
    session->monitor=std::make_unique<ssc::CoverMonitor>([weak,weakSession](const std::string&,const ssc::TrackInfo& track){
        auto state=weakSession.lock();if(!state || state->cancelled.load())return;
        const std::string identity=ssc::trackIdentity(track,state->station);
        dispatch_async(dispatch_get_main_queue(),^{SSC24sevenVisualisation* view=weak;if(view && view->_session==state)[view->_stage trackChanged:identity];});
        ssc::platform::LockGuard lock(state->mediaMutex);state->revision.store(state->pipeline->current(track,ssc::requestForTrack(track,state->mediaOptions)));
    },config);
    session->monitor->setTickCallback([weak,weakSession](const ssc::TrackInfo& info){
        auto state=weakSession.lock();if(!state || state->cancelled.load())return;int remaining=info.remainingSeconds;auto identity=ssc::trackIdentity(info,state->station);
        dispatch_async(dispatch_get_main_queue(),^{SSC24sevenVisualisation* view=weak;if(view && view->_session==state)[view->_stage remaining:remaining identity:identity];});
    });
    session->monitor->setErrorCallback([weak,weakSession](const std::string& error){
        auto state=weakSession.lock();if(!state || state->cancelled.load())return;
        dispatch_async(dispatch_get_main_queue(),^{SSC24sevenVisualisation* view=weak;if(!view || view->_session!=state || state->revision.load()>0)return;
            SSCScene* scene=[SSCScene new];scene.album=@"Connection interrupted";scene.artist=@"Retrying automatically…";[view->_stage present:scene];});
    });
    session->monitor->start();
}
- (BOOL)windowShouldClose:(NSWindow*)window {
    unsigned revision=++popupRevision;
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext* context){context.duration=duration();window.animator.alphaValue=0;}
        completionHandler:^{if(revision!=popupRevision)return;window.delegate=nil;[window close];if(popup==window)popup=nil;dispatch_async(dispatch_get_main_queue(),^{writeStatus();});}];
    return NO;
}
#ifdef SSC_PLAYER_E2E
- (BOOL)captureTest {
    if(!_cover)return NO;
    [_stage displayIfNeeded];
    NSBitmapImageRep* bitmap=[_stage bitmapImageRepForCachingDisplayInRect:_stage.bounds];
    [_stage cacheDisplayInRect:_stage.bounds toBitmapImageRep:bitmap];
    if(!bitmap)return NO;
    std::set<unsigned> colors;
    // Sample the artwork region, excluding caption text and window chrome.
    for(NSInteger y=bitmap.pixelsHigh/3;y<bitmap.pixelsHigh*2/3;y+=7) {
        for(NSInteger x=bitmap.pixelsWide/4;x<bitmap.pixelsWide*3/4;x+=7) {
            NSColor* color=[[bitmap colorAtX:x y:y] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
            unsigned r=color.redComponent*255,g=color.greenComponent*255,b=color.blueComponent*255;
            colors.insert((r<<16)|(g<<8)|b);
        }
    }
    NSString* directory=NSProcessInfo.processInfo.environment[@"SSC_FOOBAR_TEST_DIR"];
    NSString* name=[NSString stringWithFormat:@"cover-%lu-%.0fx%.0f.png",(unsigned long)views.allObjects.count,_stage.bounds.size.width,_stage.bounds.size.height];
    BOOL saved=[[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:[directory stringByAppendingPathComponent:name] atomically:YES];
    return saved && colors.size()>32;
}
#endif
@end

void SSCVisualisationEvent(const ssc::PlayerEvent& event) {
    latest=event;
    if(event.activity==ssc::PlayerActivity::Start){playing=ssc::playerStation(event.url)>=0;paused=false;}
    else if(event.activity==ssc::PlayerActivity::Pause)paused=true;
    else if(event.activity==ssc::PlayerActivity::Stop){playing=false;paused=false;}
    for(SSC24sevenVisualisation* view in views.allObjects)[view event:event];
}
void SSCVisualisationShutdown() {for(SSC24sevenVisualisation* view in views.allObjects)[view stop];popup=nil;playing=false;}
void SSCVisualisationSettingsChanged(){for(SSC24sevenVisualisation* view in views.allObjects)[view applySettings];}

namespace {
// Unique identity shared by popup command and Mac layout element.
const GUID visualID={0xef49a629,0x52a6,0x46e5,{0xbb,0x68,0x7c,0x8b,0xbd,0x1a,0x03,0x77}};
class Element : public ui_element_mac {
public:
    service_ptr instantiate(service_ptr arg) override {auto view=[SSC24sevenVisualisation new];(void)view.view;return fb2k::wrapNSObject(view);}
    bool match_name(const char* name) override {return name && !strcmp(name,"24sevenfm-covers");}
    fb2k::stringRef get_name() override {return fb2k::makeString("24seven.fm Covers");}
    GUID get_guid() override {return visualID;}
};
FB2K_SERVICE_FACTORY(Element);
class Menu : public mainmenu_commands {
public:
    t_uint32 get_command_count() override {return 1;}
    GUID get_command(t_uint32) override {return visualID;}
    void get_name(t_uint32,pfc::string_base& out) override {out="24seven.fm Covers";}
    bool get_description(t_uint32,pfc::string_base& out) override {out="Show live station cover artwork inside foobar2000.";return true;}
    GUID get_parent() override {return mainmenu_groups::view_visualisations;}
    void execute(t_uint32,service_ptr) override {
        ++popupRevision;
        if(!popup) {
            popup=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,680,760) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskMiniaturizable|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
            popup.title=@"24seven.fm Covers";popup.releasedWhenClosed=NO;popup.contentMinSize=NSMakeSize(200,200);
            auto controller=[SSC24sevenVisualisation new];popup.contentViewController=controller;popup.delegate=controller;
            popup.collectionBehavior=NSWindowCollectionBehaviorFullScreenPrimary;[popup center];[popup setFrameAutosaveName:@"24sevenfmVisualisation"];
            popup.alphaValue=0;
        }
        [popup makeKeyAndOrderFront:nil];
        [NSAnimationContext runAnimationGroup:^(NSAnimationContext* context){context.duration=duration();popup.animator.alphaValue=1;} completionHandler:nil];
        writeStatus();
    }
};
mainmenu_commands_factory_t<Menu> menu;
}
#ifdef SSC_PLAYER_E2E
bool SSCVisualisationCaptureTest() {
    SSC24sevenVisualisation* view=[views containsObject:statusView]?statusView:views.allObjects.lastObject;
    return [view captureTest];
}
#endif
