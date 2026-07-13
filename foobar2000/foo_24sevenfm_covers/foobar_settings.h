// foobar_settings.h - bridges the shared CoverEngine::Settings to foobar2000's
// persistent cfg_var storage (the equivalent of the Winamp plugin's INI).
#pragma once

#include <guiddef.h>

namespace ssccfg {
void loadIntoEngine(); // cfg_var values -> CoverEngine::instance().settings
void saveFromEngine(); // CoverEngine::instance().settings -> cfg_var values
}

// The preferences page's GUID (defined in preferences.cpp), exposed so the UI
// element's right-click "Options..." can open Preferences straight to that page.
extern const GUID g_ssc_prefs_guid;
