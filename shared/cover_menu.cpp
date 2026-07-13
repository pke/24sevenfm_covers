// cover_menu.cpp - see cover_menu.h. Plain Win32 so it works identically from the
// viewer's raw window proc, the Winamp child window, and the foobar2000 WTL element.
#include "cover_menu.h"

#include "stations.h" // station list (viewer picker) + validStationIndex

namespace covermenu {

void appendItems(HMENU m, const CoverEngine::Settings& s,
                 bool includeFullscreen, bool fullscreenOn, bool includeStations) {
    if (includeStations) { // viewer only: pick which station's cover to show
        const int cur = ssc::validStationIndex(s.station);
        for (int i = 0; i < ssc::kStationCount; ++i)
            AppendMenuA(m, MF_STRING | (i == cur ? MF_CHECKED : MF_UNCHECKED),
                        kStationBase + i, ssc::kStations[i].displayName);
        AppendMenuA(m, MF_SEPARATOR, 0, nullptr);
    }
    if (includeFullscreen)
        AppendMenuA(m, MF_STRING | (fullscreenOn ? MF_CHECKED : MF_UNCHECKED), kFullscreen, "&Fullscreen");
    AppendMenuA(m, MF_STRING | (s.layout == 1 ? MF_CHECKED : MF_UNCHECKED), kPoster, "&Poster mode");
    AppendMenuA(m, MF_SEPARATOR, 0, nullptr);
    AppendMenuA(m, MF_STRING, kOptions, "&Options...");
}

bool onCommand(UINT cmd, CoverEngine& eng, const Actions& a) {
    if (cmd >= kStationBase && cmd < kStationBase + (UINT)ssc::kStationCount) {
        eng.setStation((int)(cmd - kStationBase)); // switches + repaints live
        if (a.persist) a.persist();
        return true;
    }
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

void showPopup(HWND hwnd, POINT pt, CoverEngine& eng, const Actions& a,
               bool includeFullscreen, bool fullscreenOn, bool includeStations) {
    HMENU m = CreatePopupMenu();
    appendItems(m, eng.settings, includeFullscreen, fullscreenOn, includeStations);
    // Foreground trick: without it a popup owned by a background/child window won't
    // dismiss on click-away. TPM_RETURNCMD hands us the id directly (no WM_COMMAND).
    SetForegroundWindow(hwnd);
    const UINT cmd = (UINT)TrackPopupMenu(m, TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY,
                                          pt.x, pt.y, 0, hwnd, nullptr);
    DestroyMenu(m);
    if (cmd) onCommand(cmd, eng, a);
}

} // namespace covermenu
