#pragma once
#import <AppKit/AppKit.h>
// Backed by foobar2000's configStore; no desktop app or app preferences required.
id SSCCoversPreferences();
NSViewController* SSCCoversSettingsController();
void SSCCoversShowSettings();
