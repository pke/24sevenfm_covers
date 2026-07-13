// cover_menu.cpp - see cover_menu.h. Plain Win32 so it works identically from the
// viewer's raw window proc, the Winamp child window, and the foobar2000 WTL element.
#include "cover_menu.h"

namespace covermenu {

void appendItems(HMENU m, const CoverEngine::Settings& s,
                 bool includeFullscreen, bool fullscreenOn) {
    if (includeFullscreen)
        AppendMenuA(m, MF_STRING | (fullscreenOn ? MF_CHECKED : MF_UNCHECKED), kFullscreen, "&Fullscreen");
    AppendMenuA(m, MF_STRING | (s.layout == 1 ? MF_CHECKED : MF_UNCHECKED), kPoster, "&Poster mode");
    AppendMenuA(m, MF_SEPARATOR, 0, nullptr);
    AppendMenuA(m, MF_STRING, kOptions, "&Options...");
}

bool onCommand(UINT cmd, CoverEngine& eng, const Actions& a) {
    switch (cmd) {
        case kFullscreen:
            if (a.toggleFullscreen) a.toggleFullscreen();
            return true;
        case kPoster:
            eng.settings.layout = (eng.settings.layout == 1) ? 0 : 1; // Fill <-> Poster
            if (a.persist) a.persist();
            eng.repaint();
            return true;
        case kOptions:
            if (a.openOptions) a.openOptions();
            return true;
    }
    return false;
}

void showPopup(HWND hwnd, POINT pt, CoverEngine& eng, const Actions& a) {
    HMENU m = CreatePopupMenu();
    appendItems(m, eng.settings, /*includeFullscreen*/ false, false);
    // Foreground trick: without it a popup owned by a background/child window won't
    // dismiss on click-away. TPM_RETURNCMD hands us the id directly (no WM_COMMAND).
    SetForegroundWindow(hwnd);
    const UINT cmd = (UINT)TrackPopupMenu(m, TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY,
                                          pt.x, pt.y, 0, hwnd, nullptr);
    DestroyMenu(m);
    if (cmd) onCommand(cmd, eng, a);
}

} // namespace covermenu
