// cover_menu.h - the shared right-click context menu for the cover window, used by
// the desktop viewer AND both plugins. It owns the common items (Poster mode,
// Options...) and their behaviour against the shared CoverEngine; each host supplies
// only what differs: how "Options..." opens, how to persist, and - viewer only - how
// to toggle fullscreen. The viewer prepends its station list; the plugins do not
// (they auto-follow the tuned stream, so there is no station to pick).
#ifndef SSC_COVER_MENU_H
#define SSC_COVER_MENU_H

#include <windows.h>
#include <functional>

#include "cover_engine.h"

namespace covermenu {

// Shared command IDs - all three hosts use these, so onCommand() is one code path.
// Kept equal to the viewer's original IDM_* values so nothing else has to change.
enum {
    kFullscreen = 0x2001, // viewer only (a docked plugin window can't go fullscreen)
    kOptions    = 0x2002,
    kPoster     = 0x2003,
};

// Host-specific actions. openOptions/persist are always supplied; toggleFullscreen is
// the viewer's alone (the plugins leave it empty and omit the Fullscreen item).
struct Actions {
    std::function<void()> openOptions;
    std::function<void()> persist;
    std::function<void()> toggleFullscreen;
};

// Append the shared items (optional Fullscreen, Poster mode, separator, Options...) to
// an existing popup. The viewer calls this right after adding its station entries.
void appendItems(HMENU m, const CoverEngine::Settings& s,
                 bool includeFullscreen, bool fullscreenOn);

// Handle a menu command id. Returns true iff it was one of ours (so the caller can
// stop). Poster toggles the layout, persists, and repaints; the rest defer to Actions.
bool onCommand(UINT cmd, CoverEngine& eng, const Actions& a);

// Convenience for the plugins (no station list): build the popup, track it with
// TPM_RETURNCMD, and dispatch inline - the host window needs no WM_COMMAND routing.
// includeFullscreen adds the Fullscreen item (Winamp supplies a toggleFullscreen
// action; foobar leaves it off since an embedded element can't go fullscreen).
void showPopup(HWND hwnd, POINT pt, CoverEngine& eng, const Actions& a,
               bool includeFullscreen = false, bool fullscreenOn = false);

} // namespace covermenu

#endif // SSC_COVER_MENU_H
