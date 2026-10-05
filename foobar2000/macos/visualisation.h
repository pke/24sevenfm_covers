#pragma once
#include "../../shared/player_follow.h"
// Main-thread playback publication; hosted views render without launching the DV.
void SSCVisualisationEvent(const ssc::PlayerEvent& event);
void SSCVisualisationShutdown();
void SSCVisualisationSettingsChanged();
#ifdef SSC_PLAYER_E2E
bool SSCVisualisationCaptureTest();
#endif
