// foobar_settings.h - bridges the shared CoverEngine::Settings to foobar2000's
// persistent cfg_var storage (the equivalent of the Winamp plugin's INI).
#pragma once

namespace ssccfg {
void loadIntoEngine(); // cfg_var values -> CoverEngine::instance().settings
void saveFromEngine(); // CoverEngine::instance().settings -> cfg_var values
}
