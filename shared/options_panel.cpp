// options_panel.cpp - see header. All A-variant Win32 calls so the same code drives
// both the Winamp (ANSI) dialog and the foobar2000 (Unicode/WTL) dialog; the message
// thunks convert as needed.
#include "options_panel.h"

#include <commctrl.h>

namespace optpanel {
namespace {

int clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

void updateFadeLabel(HWND dlg) {
    const int pos = (int)SendDlgItemMessageA(dlg, IDC_OPT_FADE, TBM_GETPOS, 0, 0);
    char buf[32]; wsprintfA(buf, "%d ms", pos);
    SetDlgItemTextA(dlg, IDC_OPT_FADEVAL, buf);
}

// Radio-button group helpers (base id = first radio, +i for the rest).
void setRadio(HWND dlg, int base, int count, int val) {
    CheckRadioButton(dlg, base, base + count - 1, base + clampi(val, 0, count - 1));
}
int getRadio(HWND dlg, int base, int count) {
    for (int i = 0; i < count; ++i)
        if (IsDlgButtonChecked(dlg, base + i) == BST_CHECKED) return i;
    return 0;
}
void enableRadios(HWND dlg, int base, int count, BOOL en) {
    for (int i = 0; i < count; ++i) EnableWindow(GetDlgItem(dlg, base + i), en);
}

} // namespace

void init(HWND dlg, const CoverEngine::Settings& s) {
    // The radio labels are static in the .rc; only the slider needs setup here.
    SendDlgItemMessageA(dlg, IDC_OPT_FADE, TBM_SETRANGE, TRUE, MAKELONG(500, 2000));
    SendDlgItemMessageA(dlg, IDC_OPT_FADE, TBM_SETLINESIZE, 0, 100);
    SendDlgItemMessageA(dlg, IDC_OPT_FADE, TBM_SETPAGESIZE, 0, 100);
    SendDlgItemMessageA(dlg, IDC_OPT_FADE, TBM_SETTICFREQ, 100, 0);
    setValues(dlg, s);
}

void setValues(HWND dlg, const CoverEngine::Settings& s) {
    setRadio(dlg, IDC_OPT_LAYOUT, 2, s.layout);
    CheckDlgButton(dlg, IDC_OPT_OVERLAY, s.showRemaining ? BST_CHECKED : BST_UNCHECKED);
    setRadio(dlg, IDC_OPT_SIZE, 3, s.remainingSize);
    CheckDlgButton(dlg, IDC_OPT_ROLL, s.rollDigits ? BST_CHECKED : BST_UNCHECKED);
    setRadio(dlg, IDC_OPT_TRANS, 4, s.transition);
    SendDlgItemMessageA(dlg, IDC_OPT_FADE, TBM_SETPOS, TRUE, clampi(s.fadeMs, 500, 2000));
    updateFadeLabel(dlg);
    updateEnabled(dlg);
}

void read(HWND dlg, CoverEngine::Settings& s) {
    s.layout      = getRadio(dlg, IDC_OPT_LAYOUT, 2);
    s.showRemaining = IsDlgButtonChecked(dlg, IDC_OPT_OVERLAY) == BST_CHECKED;
    s.remainingSize = getRadio(dlg, IDC_OPT_SIZE, 3);
    s.rollDigits  = IsDlgButtonChecked(dlg, IDC_OPT_ROLL) == BST_CHECKED;
    s.transition  = getRadio(dlg, IDC_OPT_TRANS, 4);
    const int fade = (int)SendDlgItemMessageA(dlg, IDC_OPT_FADE, TBM_GETPOS, 0, 0);
    s.fadeMs = clampi(((fade + 50) / 100) * 100, 500, 2000); // snap to 100 ms
}

void updateEnabled(HWND dlg) {
    // All options apply to both layouts (poster draws the countdown on the cover), so
    // enabling only follows the usual dependencies: size/roll need the overlay on, and
    // the transition duration needs a transition other than None.
    const BOOL overlay = IsDlgButtonChecked(dlg, IDC_OPT_OVERLAY) == BST_CHECKED;
    enableRadios(dlg, IDC_OPT_SIZE, 3, overlay);
    EnableWindow(GetDlgItem(dlg, IDC_OPT_ROLL), overlay);
    const BOOL animated = getRadio(dlg, IDC_OPT_TRANS, 4) != 0;
    EnableWindow(GetDlgItem(dlg, IDC_OPT_FADE), animated);
    EnableWindow(GetDlgItem(dlg, IDC_OPT_FADEVAL), animated);
}

void onHScroll(HWND dlg) {
    const int pos = (int)SendDlgItemMessageA(dlg, IDC_OPT_FADE, TBM_GETPOS, 0, 0);
    const int snapped = ((pos + 50) / 100) * 100;
    if (snapped != pos)
        SendDlgItemMessageA(dlg, IDC_OPT_FADE, TBM_SETPOS, TRUE, snapped);
    updateFadeLabel(dlg);
}

} // namespace optpanel
