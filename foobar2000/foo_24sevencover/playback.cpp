// playback.cpp - foobar2000 playback glue. Drives the shared engine off real
// playback events (the foobar equivalent of the Winamp plugin's IPC title polling):
//   - on_playback_dynamic_info_track: ICY stream title changed -> engine advances
//     the cover (the engine filters placeholders and only reacts to real changes).
//   - new track / stop: track whether we're tuned to the station so local playback
//     doesn't drive the station cover.
#include <SDK/foobar2000.h>

#include <algorithm>
#include <string>

#include "cover_engine.h"

namespace {

static bool pathIsStation(const metadb_handle_ptr& track) {
    if (track.is_empty()) return false;
    const char* p = track->get_path();
    if (!p) return false;
    std::string s(p);
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c){ return (char)std::tolower(c); });
    return s.find("streamingsoundtracks") != std::string::npos;
}

class ssc_play_callback : public play_callback_static {
public:
    unsigned get_flags() override {
        return flag_on_playback_new_track | flag_on_playback_stop |
               flag_on_playback_dynamic_info_track;
    }

    void on_playback_new_track(metadb_handle_ptr track) override {
        m_tuned = pathIsStation(track);
        if (!m_tuned) CoverEngine::instance().resetTitle();
    }
    void on_playback_stop(play_control::t_stop_reason) override {
        m_tuned = false;
        CoverEngine::instance().resetTitle();
    }
    void on_playback_dynamic_info_track(const file_info& info) override {
        if (!m_tuned) return;
        const t_size i = info.meta_find("TITLE"); // case-insensitive
        if (i == pfc_infinite || info.meta_enum_value_count(i) == 0) return;
        const char* t = info.meta_enum_value(i, 0);
        if (t && *t) CoverEngine::instance().onTitleChanged(t);
    }

    // Unused play_callback methods (all pure virtual - must be defined).
    void on_playback_starting(play_control::t_track_command, bool) override {}
    void on_playback_seek(double) override {}
    void on_playback_pause(bool) override {}
    void on_playback_edited(metadb_handle_ptr) override {}
    void on_playback_dynamic_info(const file_info&) override {}
    void on_playback_time(double) override {}
    void on_volume_change(float) override {}

private:
    bool m_tuned = false;
};

static play_callback_static_factory_t<ssc_play_callback> g_ssc_play_callback;

} // namespace
