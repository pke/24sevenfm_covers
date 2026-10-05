#import "player_bridge.h"
#include <cstring>
static NSString* nativeText(const std::string& value) { return [NSString stringWithUTF8String:value.c_str()]; }
static NSString* activityName(ssc::PlayerActivity activity) {
    switch(activity) {
        case ssc::PlayerActivity::Start:return @"start";case ssc::PlayerActivity::Update:return @"update";
        case ssc::PlayerActivity::Pause:return @"pause";case ssc::PlayerActivity::Stop:return @"stop";
    }
    return nil;
}
static bool activityValue(NSString* name, ssc::PlayerActivity& activity) {
    if([name isEqual:@"start"]) activity=ssc::PlayerActivity::Start;
    else if([name isEqual:@"update"]) activity=ssc::PlayerActivity::Update;
    else if([name isEqual:@"pause"]) activity=ssc::PlayerActivity::Pause;
    else if([name isEqual:@"stop"]) activity=ssc::PlayerActivity::Stop;
    else return false;
    return true;
}
static bool sequenceValue(NSString* value, uint64_t& sequence) {
    if(!value.length || value.length>16 || [value rangeOfCharacterFromSet:NSCharacterSet.decimalDigitCharacterSet.invertedSet].location!=NSNotFound) return false;
    const char* ascii=[value cStringUsingEncoding:NSASCIIStringEncoding]; if(!ascii) return false;
    sequence=strtoull(ascii,nullptr,10);return sequence>0 && sequence<=9007199254740991ULL;
}
NSURL* SSCPlayerEventURL(const ssc::PlayerEvent& e) {
    if(!ssc::validPlayerEvent(e)) return nil;
    if(!nativeText(e.player) || !nativeText(e.session) || !nativeText(e.url) || !nativeText(e.title)) return nil;
    NSURLComponents* parts=[NSURLComponents new];parts.scheme=@"x24sevenfm-covers";parts.host=@"follow";
    NSArray* values=@[nativeText(e.player) ?: @"",nativeText(e.session) ?: @"",[NSString stringWithFormat:@"%llu",(unsigned long long)e.sequence],activityName(e.activity) ?: @"",nativeText(e.url) ?: @"",nativeText(e.title) ?: @""];
    NSArray* names=@[@"player",@"session",@"seq",@"state",@"url",@"title"];
    NSMutableArray* query=[NSMutableArray array];for(NSUInteger i=0;i<names.count;++i) [query addObject:[NSURLQueryItem queryItemWithName:names[i] value:values[i]]];
    parts.queryItems=query;return parts.URL;
}
bool SSCParsePlayerEventURL(NSURL* url, ssc::PlayerEvent& event) {
    if(url.absoluteString.length>32768) return false;
    NSURLComponents* parts=[NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO];
    if(![parts.scheme isEqual:@"x24sevenfm-covers"] || ![parts.host isEqual:@"follow"] || parts.user || parts.password || parts.port || parts.fragment || parts.path.length) return false;
    NSMutableDictionary* fields=[NSMutableDictionary dictionary];
    for(NSURLQueryItem* item in parts.queryItems) {
        if(fields[item.name] || !item.value || !item.value.UTF8String || [item.value lengthOfBytesUsingEncoding:NSUTF8StringEncoding]!=strlen(item.value.UTF8String)) return false;
        fields[item.name]=item.value;
    }
    if(fields.count!=6) return false;
    ssc::PlayerEvent parsed;
    for(NSString* key in @[@"player",@"session",@"seq",@"state",@"url",@"title"]) if(!fields[key]) return false;
    parsed.player=[fields[@"player"] UTF8String] ?: "";parsed.session=[fields[@"session"] UTF8String] ?: "";
    parsed.url=[fields[@"url"] UTF8String] ?: "";parsed.title=[fields[@"title"] UTF8String] ?: "";
    if(!sequenceValue(fields[@"seq"],parsed.sequence) || !activityValue(fields[@"state"],parsed.activity) || !ssc::validPlayerEvent(parsed)) return false;
    event=std::move(parsed);return true;
}
void SSCSendPlayerEvent(const ssc::PlayerEvent& event, void (^completion)(NSError*)) {
    NSURL* url=SSCPlayerEventURL(event);
    if(!url) {completion([NSError errorWithDomain:@"24seven.fm Covers" code:1 userInfo:@{NSLocalizedDescriptionKey:@"Invalid player event"}]);return;}
    NSArray<NSRunningApplication*>* running=[NSRunningApplication runningApplicationsWithBundleIdentifier:@"app.dudesoft.24sevenfm.covers"];
    BOOL mayLaunch=event.activity==ssc::PlayerActivity::Start && ssc::playerStation(event.url)>=0;
    if(!mayLaunch && !running.count) {completion(nil);return;}
    NSString* override=NSProcessInfo.processInfo.environment[@"SSC_PLAYER_VIEWER_APP"];
    NSURL* app=override.length ? [NSURL fileURLWithPath:override] : running.firstObject.bundleURL;
    if(!app) {
        NSString* path=[NSHomeDirectory() stringByAppendingPathComponent:@"Applications/24seven.fm Covers.app"];
        if([NSFileManager.defaultManager fileExistsAtPath:path]) app=[NSURL fileURLWithPath:path];
        else app=[NSWorkspace.sharedWorkspace URLForApplicationWithBundleIdentifier:@"app.dudesoft.24sevenfm.covers"];
    }
    if(!app) {completion([NSError errorWithDomain:@"24seven.fm Covers" code:2 userInfo:@{NSLocalizedDescriptionKey:@"Install 24seven.fm Covers in Applications first"}]);return;}
    NSWorkspaceOpenConfiguration* config=NSWorkspaceOpenConfiguration.configuration;
    config.activates=NO;config.addsToRecentItems=NO;config.arguments=@[@"--follow-player"];
    // Explicitly isolated settings for cold-launch E2E runs; absent in normal use.
    NSString* testDirectory=NSProcessInfo.processInfo.environment[@"SSC_PLAYER_TEST_DIR"];
    if(testDirectory.length) config.environment=@{@"SSC_PLAYER_TEST_DIR":testDirectory};
    [NSWorkspace.sharedWorkspace openURLs:@[url] withApplicationAtURL:app configuration:config completionHandler:^(NSRunningApplication* application,NSError* error){completion(error);}];
}
int SSCPlayerEventCommand(int argc, const char* argv[]) {
    if(argc!=8) {fprintf(stderr,"Usage: --player-event player session sequence start|update|pause|stop url title\n");return 1;}
    ssc::PlayerEvent event;event.player=argv[2];event.session=argv[3];event.url=argv[6];event.title=argv[7];
    if(!sequenceValue(nativeText(argv[4]),event.sequence) || !activityValue(nativeText(argv[5]),event.activity) || !ssc::validPlayerEvent(event)) return 1;
    __block BOOL finished=NO;__block int result=0;
    SSCSendPlayerEvent(event,^(NSError* error){if(error){fprintf(stderr,"%s\n",error.localizedDescription.UTF8String);result=2;}finished=YES;});
    NSDate* limit=[NSDate dateWithTimeIntervalSinceNow:10];
    while(!finished && limit.timeIntervalSinceNow>0) [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.01]];
    return finished ? result : 3;
}
