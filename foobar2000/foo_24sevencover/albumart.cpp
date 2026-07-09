// albumart.cpp - feeds the station cover into foobar2000's OWN album-art system, so
// the native Album Art UI element, the taskbar thumbnail, and now-playing popups all
// show it (not just our panel). album_art_fallback is called when no other source has
// art for the item; for the station stream we return the cover the engine currently
// has. Because the engine preloads the next cover and swaps it in on the title change,
// currentCover() is usually the right image the instant foobar re-queries on a track
// change.
//
// Caveat: foobar caches now-playing art and reloads it on track change; if it happens
// to query before our own play_callback swaps the cover in, the native art can lag by
// one track. Our own panel is always exact.
#include <SDK/foobar2000.h>
#include <SDK/album_art.h>
#include <SDK/album_art_helpers.h>

#include <algorithm>
#include <string>

#include "cover_engine.h"

namespace {

static bool isStationPath(const char* p) {
    if (!p) return false;
    std::string s(p);
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c){ return (char)std::tolower(c); });
    return s.find("streamingsoundtracks") != std::string::npos;
}

// The extractor instance foobar queries for the actual bytes.
class ssc_art_instance : public album_art_extractor_instance_v2 {
public:
    explicit ssc_art_instance(album_art_data::ptr d) : m_data(d) {}
    album_art_data_ptr query(const GUID& what, abort_callback&) override {
        if (what == album_art_ids::cover_front && m_data.is_valid()) return m_data;
        throw exception_album_art_not_found();
    }
    album_art_path_list::ptr query_paths(const GUID&, abort_callback&) override {
        return new service_impl_t<album_art_path_list_dummy>(); // art came from the network, no file path
    }
private:
    album_art_data::ptr m_data;
};

// Path-based extractor: consulted per playlist item (before fallbacks), so it
// covers consumers the fallback misses - e.g. a playlist album-art column showing
// the SELECTED station row. We claim the stream path and return the current cover.
class ssc_art_extractor : public album_art_extractor {
public:
    bool is_our_path(const char* p_path, const char* /*p_extension*/) override {
        return isStationPath(p_path);
    }
    album_art_extractor_instance_ptr open(file_ptr, const char* p_path, abort_callback&) override {
        if (!isStationPath(p_path)) throw exception_album_art_not_found();
        std::string bytes;
        if (!CoverEngine::instance().currentCover(bytes) || bytes.empty())
            throw exception_album_art_not_found();
        album_art_data::ptr data = album_art_data_impl::g_create(bytes.data(), bytes.size());
        return new service_impl_t<ssc_art_instance>(data);
    }
};
static service_factory_single_t<ssc_art_extractor> g_ssc_art_extractor;

class ssc_art_fallback : public album_art_fallback {
public:
    album_art_extractor_instance_v2::ptr open(metadb_handle_list_cref items,
                                              pfc::list_base_const_t<GUID> const& ids,
                                              abort_callback&) override {
        bool station = false;
        for (t_size i = 0; i < items.get_count(); ++i)
            if (isStationPath(items[i]->get_path())) { station = true; break; }
        if (!station) throw exception_album_art_not_found();

        bool wantFront = false;
        for (t_size i = 0; i < ids.get_count(); ++i)
            if (ids[i] == album_art_ids::cover_front) { wantFront = true; break; }
        if (!wantFront) throw exception_album_art_not_found();

        std::string bytes;
        if (!CoverEngine::instance().currentCover(bytes) || bytes.empty())
            throw exception_album_art_not_found();

        album_art_data::ptr data = album_art_data_impl::g_create(bytes.data(), bytes.size());
        return new service_impl_t<ssc_art_instance>(data);
    }
};

static service_factory_single_t<ssc_art_fallback> g_ssc_art_fallback;

} // namespace
