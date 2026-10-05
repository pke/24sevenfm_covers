// Linked only in the E2E test component. Drives real foobar playback through its
// SDK on the main thread; no synthetic playback callbacks or UI automation.
#include <SDK/foobar2000.h>
#import <AppKit/AppKit.h>
#include "visualisation.h"
namespace {
class Driver : public initquit {
    NSTimer* timer_ = nil;
    NSString* directory_ = nil;
    NSUInteger sequence_ = 0;
    t_size playlist_ = pfc_infinite, previous_ = pfc_infinite;
    float volume_ = 0;
    NSWindow* layoutWindow_ = nil;
    NSViewController* layoutController_ = nil;
public:
    void on_init() override {
        directory_=NSProcessInfo.processInfo.environment[@"SSC_FOOBAR_TEST_DIR"];
        if(!directory_.length) return;
        [NSFileManager.defaultManager createDirectoryAtPath:directory_ withIntermediateDirectories:YES attributes:nil error:nil];
        auto manager=playlist_manager::get();previous_=manager->get_active_playlist();
        playlist_=manager->create_playlist("24seven.fm E2E",pfc_infinite,pfc_infinite);
        volume_=playback_control::get()->get_volume();playback_control::get()->set_volume(-100);
        [[NSData data] writeToFile:[directory_ stringByAppendingPathComponent:@"ready"] atomically:YES];
        timer_=[NSTimer scheduledTimerWithTimeInterval:.1 repeats:YES block:^(NSTimer* timer){tick();}];
    }
    void tick() {
        NSData* data=[NSData dataWithContentsOfFile:[directory_ stringByAppendingPathComponent:@"command.json"]];
        if(!data) return;
        NSDictionary* command=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        NSUInteger sequence=[command[@"sequence"] unsignedIntegerValue];if(sequence<=sequence_) return;sequence_=sequence;
        NSString* action=command[@"action"];auto playback=playback_control::get();
        NSString* error=nil;
        try {
            if([action isEqual:@"play"]) {
                const char* path=[command[@"url"] UTF8String];if(!path) return;
                auto manager=playlist_manager::get();manager->playlist_clear(playlist_);
                metadb_handle_list items;items.add_item(metadb::get()->handle_create(path,0));
                manager->playlist_add_items(playlist_,items,bit_array_true());manager->set_active_playlist(playlist_);
                manager->playlist_execute_default_action(playlist_,0);
            } else if([action isEqual:@"visual-open"]) {
                GUID id;if(!mainmenu_commands::g_find_by_name("24seven.fm Covers",id) || !mainmenu_commands::g_execute(id))
                    throw std::runtime_error("Covers visualisation menu command not registered");
            } else if([action isEqual:@"visual-layout"]) {
                service_ptr_t<ui_element_mac> element;service_enum_t<ui_element_mac> elements;
                while(elements.next(element)) if(element->match_name("24sevenfm-covers")) break;
                if(element.is_empty() || !element->match_name("24sevenfm-covers")) throw std::runtime_error("Covers layout element not registered");
                layoutController_=fb2k::unwrapNSObject(element->instantiate(fb2k::wrapNSObject(@{})));
                if(![layoutController_ isKindOfClass:NSViewController.class]) throw std::runtime_error("Layout element is not an NSViewController");
                layoutWindow_=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,480,560) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
                layoutWindow_.releasedWhenClosed=NO;layoutWindow_.contentViewController=layoutController_;
                [layoutWindow_ orderFront:nil];
            } else if([action isEqual:@"visual-resize"]) {
                [layoutWindow_ setContentSize:NSMakeSize(820,440)];
            } else if([action isEqual:@"visual-capture"]) {
                if(!SSCVisualisationCaptureTest())throw std::runtime_error("Live artwork pixel capture failed");
            } else if([action isEqual:@"visual-popup-close"]) {
                for(NSWindow* window in NSApp.windows)if([window.title isEqual:@"24seven.fm Covers"])[window performClose:nil];
            } else if([action isEqual:@"visual-close"]) {
                [layoutWindow_ close];layoutWindow_.contentViewController=nil;layoutWindow_=nil;layoutController_=nil;
            } else if([action isEqual:@"pause"]) playback->pause(true);
            else if([action isEqual:@"resume"]) playback->pause(false);
            else if([action isEqual:@"stop"]) playback->stop();
            else if([action isEqual:@"quit"]) [NSApp terminate:nil];
        } catch(const std::exception& e) {error=[NSString stringWithUTF8String:e.what()];NSLog(@"E2E driver: %@",error);}
        NSData* result=[NSJSONSerialization dataWithJSONObject:@{@"sequence":@(sequence_),@"error":error ?: @""} options:0 error:nil];
        [result writeToFile:[directory_ stringByAppendingPathComponent:@"result.json"] atomically:YES];
    }
    void on_quit() override {
        if(!directory_.length)return;
        [layoutWindow_ close];layoutWindow_.contentViewController=nil;layoutWindow_=nil;layoutController_=nil;
        [timer_ invalidate];playback_control::get()->set_volume(volume_);
        auto manager=playlist_manager::get();manager->remove_playlist(playlist_);
        if(previous_<manager->get_playlist_count())manager->set_active_playlist(previous_);
    }
};
initquit_factory_t<Driver> driver;
}
