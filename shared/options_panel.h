// options_panel.h - shared logic for the options page (IDD_OPTIONS_PAGE). Plain
// Win32 operating on the dialog HWND + CoverEngine::Settings, so it works the same
// from the Winamp raw DLGPROC and the foobar2000 WTL preferences dialog. The host
// owns the dialog window; this owns what the controls do.
#ifndef SSC_OPTIONS_PANEL_H
#define SSC_OPTIONS_PANEL_H

#include <windows.h>

#include "options_ids.h"
#include "cover_engine.h"

namespace optpanel {

// WM_INITDIALOG convenience: fill combos + slider range, set control values from s,
// and grey dependent controls.
void init(HWND dlg, const CoverEngine::Settings& s);

// Set control values from s (without re-populating the combos) + refresh enabled
// state. Use for a "reset to defaults" that runs after init().
void setValues(HWND dlg, const CoverEngine::Settings& s);

// Read the controls back into s (fade snapped to 100 ms).
void read(HWND dlg, CoverEngine::Settings& s);

// Grey the overlay-dependent controls / the duration slider to match the current
// overlay + transition selections.
void updateEnabled(HWND dlg);

// Handle a WM_HSCROLL from the duration slider: snap to 100 ms and update the label.
void onHScroll(HWND dlg);

} // namespace optpanel

#endif // SSC_OPTIONS_PANEL_H
