#pragma once
#import <AppKit/AppKit.h>
#include "../../shared/player_follow.h"
NSURL* SSCPlayerEventURL(const ssc::PlayerEvent& event);
bool SSCParsePlayerEventURL(NSURL* url, ssc::PlayerEvent& event);
// Launches for a recognized start only; other events go only to an existing viewer.
void SSCSendPlayerEvent(const ssc::PlayerEvent& event, void (^completion)(NSError*));
int SSCPlayerEventCommand(int argc, const char* argv[]);
