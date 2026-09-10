// foobar_settings.cpp - see header. Adapts CoverEngine's option schema (shared/config.h)
// to foobar2000's GUID-keyed cfg_var storage. The keys, defaults and clamping live in
// the shared load()/save(); this file only maps each logical key to its cfg_int - the
// foobar-specific "where it's stored" detail.
#include <SDK/foobar2000.h>

#include <cstring>

#include "cover_engine.h"
#include "config.h"
#include "foobar_settings.h"

namespace {
// One GUID per persisted setting (foobar's equivalent of the Winamp INI keys). The
// cfg_int defaults mirror the shared schema defaults in shared/config.h.
static const GUID g_guid_overlay = { 0x3a1b2c3d, 0x4e5f, 0x6789, { 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x01 } };
static const GUID g_guid_size    = { 0x3a1b2c3d, 0x4e5f, 0x6789, { 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x02 } };
static const GUID g_guid_roll    = { 0x3a1b2c3d, 0x4e5f, 0x6789, { 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x03 } };
static const GUID g_guid_trans   = { 0x3a1b2c3d, 0x4e5f, 0x6789, { 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x04 } };
static const GUID g_guid_fade    = { 0x3a1b2c3d, 0x4e5f, 0x6789, { 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x05 } };
static const GUID g_guid_layout  = { 0x3a1b2c3d, 0x4e5f, 0x6789, { 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x06 } };
static const GUID g_guid_pblur   = { 0x3a1b2c3d, 0x4e5f, 0x6789, { 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x07 } };
static const GUID g_guid_radius  = { 0x3a1b2c3d, 0x4e5f, 0x6789, { 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x08 } };
static const GUID g_guid_backdrop= { 0x3a1b2c3d, 0x4e5f, 0x6789, { 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x09 } };
static const GUID g_guid_ratings = { 0x3a1b2c3d, 0x4e5f, 0x6789, { 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x0a } };
static const GUID g_guid_hidecover={0x3a1b2c3d, 0x4e5f, 0x6789, { 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x0b } };
static const GUID g_guid_ratingde= { 0x3a1b2c3d, 0x4e5f, 0x6789, { 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x0c } };
static const GUID g_guid_ratingus= { 0x3a1b2c3d, 0x4e5f, 0x6789, { 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x0d } };
static const GUID g_guid_providers={0x3a1b2c3d, 0x4e5f, 0x6789, { 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x0e } };
static const GUID g_guid_fanartkey={0x3a1b2c3d, 0x4e5f, 0x6789, { 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x0f } };
static const GUID g_guid_fanartverified={0x3a1b2c3d, 0x4e5f, 0x6789, { 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x10 } };

static cfg_int cfg_overlay(g_guid_overlay, 0);
static cfg_int cfg_size(g_guid_size, 0);
static cfg_int cfg_roll(g_guid_roll, 0);
static cfg_int cfg_trans(g_guid_trans, 1);
static cfg_int cfg_fade(g_guid_fade, 1000);
static cfg_int cfg_layout(g_guid_layout, 0);
static cfg_int cfg_pblur(g_guid_pblur, 24);
static cfg_int cfg_radius(g_guid_radius, 45);
static cfg_int cfg_backdrop(g_guid_backdrop, 0);
static const GUID g_guid_titlelogos = { 0x3a1b2c3d, 0x4e5f, 0x6789, { 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x11 } };
static cfg_int cfg_titlelogos(g_guid_titlelogos, 0);
static cfg_int cfg_ratings(g_guid_ratings, 0);
static cfg_int cfg_hidecover(g_guid_hidecover, 1);
static cfg_int cfg_ratingde(g_guid_ratingde, 1);
static cfg_int cfg_ratingus(g_guid_ratingus, 1);
static cfg_string cfg_providers(g_guid_providers, "fanart,tmdb,tvmaze,steamgriddb");
static cfg_string cfg_fanartkey(g_guid_fanartkey, "");
static cfg_string cfg_fanartverified(g_guid_fanartverified, "0");

// Maps a shared config key -> its cfg_int. foobar auto-follows the tuned stream, so it
// does not persist the station: readStr/writeStr are inert (the engine's auto-follow
// sets settings.station at runtime).
struct FoobarStore : ssccfg::ConfigStore {
    int readInt(const char* key, int def) override {
        cfg_int* c = var(key);
        return c ? (int)*c : def;
    }
    void writeInt(const char* key, int value) override {
        if (cfg_int* c = var(key)) *c = value;
    }
    std::string readStr(const char* key, const char* def) override {
        if (!std::strcmp(key, "mediaProviders")) return cfg_providers.get().c_str();
        if (!std::strcmp(key, "fanartClientKey")) return cfg_fanartkey.get().c_str();
        if (!std::strcmp(key, "fanartClientKeyVerifiedAt")) return cfg_fanartverified.get().c_str();
        return def ? def : "";
    }
    void writeStr(const char* key, const char* value) override {
        if (!std::strcmp(key, "mediaProviders")) cfg_providers = value ? value : "";
        else if (!std::strcmp(key, "fanartClientKey")) cfg_fanartkey = value ? value : "";
        else if (!std::strcmp(key, "fanartClientKeyVerifiedAt")) cfg_fanartverified = value ? value : "0";
    }

private:
    static cfg_int* var(const char* key) {
        if (!std::strcmp(key, "showRemaining")) return &cfg_overlay;
        if (!std::strcmp(key, "remainingSize")) return &cfg_size;
        if (!std::strcmp(key, "roll"))          return &cfg_roll;
        if (!std::strcmp(key, "transition"))    return &cfg_trans;
        if (!std::strcmp(key, "fadeMs"))        return &cfg_fade;
        if (!std::strcmp(key, "layout"))        return &cfg_layout;
        if (!std::strcmp(key, "posterBlur"))    return &cfg_pblur;
        if (!std::strcmp(key, "borderRadius"))  return &cfg_radius;
        if (!std::strcmp(key, "backdrops"))     return &cfg_backdrop;
        if (!std::strcmp(key, "titleLogos"))    return &cfg_titlelogos;
        if (!std::strcmp(key, "ratings"))       return &cfg_ratings;
        if (!std::strcmp(key, "hideCoverWithBackdrop")) return &cfg_hidecover;
        if (!std::strcmp(key, "ratingDE"))      return &cfg_ratingde;
        if (!std::strcmp(key, "ratingUS"))      return &cfg_ratingus;
        return nullptr;
    }
};
} // namespace

namespace ssccfg {
void loadIntoEngine() { FoobarStore store; load(CoverEngine::instance().settings, store); }
void saveFromEngine() { FoobarStore store; save(CoverEngine::instance().settings, store); }
}
