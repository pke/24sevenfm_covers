// foobar_settings.cpp - see header. cfg_int-backed persistence for the engine's
// options, mirroring the Winamp INI keys.
#include <SDK/foobar2000.h>

#include "cover_engine.h"
#include "foobar_settings.h"

namespace {
// One GUID per setting (persisted in foobar's config).
static const GUID g_guid_overlay = { 0x3a1b2c3d, 0x4e5f, 0x6789, { 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x01 } };
static const GUID g_guid_size    = { 0x3a1b2c3d, 0x4e5f, 0x6789, { 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x02 } };
static const GUID g_guid_roll    = { 0x3a1b2c3d, 0x4e5f, 0x6789, { 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x03 } };
static const GUID g_guid_trans   = { 0x3a1b2c3d, 0x4e5f, 0x6789, { 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x04 } };
static const GUID g_guid_fade    = { 0x3a1b2c3d, 0x4e5f, 0x6789, { 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x05 } };

static cfg_int cfg_overlay(g_guid_overlay, 0);
static cfg_int cfg_size(g_guid_size, 2);
static cfg_int cfg_roll(g_guid_roll, 0);
static cfg_int cfg_trans(g_guid_trans, 1);
static cfg_int cfg_fade(g_guid_fade, 500);

static int clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }
} // namespace

namespace ssccfg {

void loadIntoEngine() {
    CoverEngine::Settings& s = CoverEngine::instance().settings;
    s.showOverlay = (int)cfg_overlay != 0;
    s.overlaySize = clampi((int)cfg_size, 0, 2);
    s.rollDigits  = (int)cfg_roll != 0;
    s.transition  = clampi((int)cfg_trans, 0, 3);
    s.fadeMs      = clampi((int)cfg_fade, 500, 2000);
}

void saveFromEngine() {
    const CoverEngine::Settings& s = CoverEngine::instance().settings;
    cfg_overlay = s.showOverlay ? 1 : 0;
    cfg_size    = s.overlaySize;
    cfg_roll    = s.rollDigits ? 1 : 0;
    cfg_trans   = s.transition;
    cfg_fade    = s.fadeMs;
}

} // namespace ssccfg
