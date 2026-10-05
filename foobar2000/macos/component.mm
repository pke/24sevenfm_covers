#include <SDK/foobar2000.h>
#import <AppKit/AppKit.h>
#include "visualisation.h"

DECLARE_COMPONENT_VERSION("24seven.fm Covers", "1.0.0",
    "Native cover visualisation and layout element for all five 24seven.fm stations.\nCopyright 2026 DudeSoft.");
VALIDATE_COMPONENT_FILENAME("foo_24sevenfm_covers.component");

namespace {
ssc::PlayerEvent current;
bool tuned=false;
void publish(ssc::PlayerActivity activity) {
    current.activity=activity;++current.sequence;
    SSCVisualisationEvent(current);
}
void newTrack(metadb_handle_ptr track) {
    std::string url=track.is_empty()?"":track->get_path();
    if(ssc::playerStation(url)<0) {if(tuned){publish(ssc::PlayerActivity::Stop);tuned=false;}return;}
    tuned=true;current.url=url;current.title.clear();publish(ssc::PlayerActivity::Start);
    if(playback_control::get()->is_paused()) publish(ssc::PlayerActivity::Pause);
}
class Playback : public play_callback_static {
public:
    unsigned get_flags() override {return flag_on_playback_new_track|flag_on_playback_stop|flag_on_playback_pause|flag_on_playback_dynamic_info_track;}
    void on_playback_new_track(metadb_handle_ptr track) override {newTrack(track);}
    void on_playback_stop(play_control::t_stop_reason reason) override {
        // Starting another item causes a transitional stop; the new-track event owns the switch.
        if(reason==play_control::stop_reason_starting_another) return;
        if(tuned){publish(ssc::PlayerActivity::Stop);tuned=false;}
    }
    void on_playback_pause(bool paused) override {if(tuned)publish(paused?ssc::PlayerActivity::Pause:ssc::PlayerActivity::Start);}
    void on_playback_dynamic_info_track(const file_info& info) override {
        if(!tuned) return;
        const char* title=info.meta_get("TITLE",0);if(!title || current.title==title) return;
        current.title=title;publish(ssc::PlayerActivity::Update);
    }
    void on_playback_starting(play_control::t_track_command,bool) override {}
    void on_playback_seek(double) override {}
    void on_playback_edited(metadb_handle_ptr) override {}
    void on_playback_dynamic_info(const file_info&) override {}
    void on_playback_time(double) override {}
    void on_volume_change(float) override {}
};
play_callback_static_factory_t<Playback> callback;
class Lifetime : public initquit {
public:
    void on_init() override {
        current.player="foobar2000";current.session=NSUUID.UUID.UUIDString.UTF8String;
        NSLog(@"24seven.fm Covers: native visualisation loaded");
        metadb_handle_ptr track;if(playback_control::get()->get_now_playing(track)) newTrack(track);
    }
    void on_quit() override {if(tuned)publish(ssc::PlayerActivity::Stop);tuned=false;SSCVisualisationShutdown();}
};
initquit_factory_t<Lifetime> lifetime;
}
