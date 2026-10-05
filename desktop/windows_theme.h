#pragma once

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

namespace dvtheme {

enum class Surface {
    mainWindow,
    settingsWindow,
    settingsPage,
};

// Call before creating the first HWND. This lets Windows choose the correct
// initial non-client colours and native menu theme without a light first frame.
void initialize();

// Adds Windows 11 frame styling and, for settings surfaces, system dark-mode
// colours. Every newer API is resolved at runtime; unsupported systems retain
// the ordinary Win32 appearance.
void install(HWND window, Surface surface);
// Native radio semantics, with the system selection palette behind the row.
void highlightSelection(HWND radio);
// The control owns the decoded resource and keeps native radio keyboard behavior.
bool setStationLogo(HWND radio, HINSTANCE resourceOwner, UINT resourceId);

} // namespace dvtheme
