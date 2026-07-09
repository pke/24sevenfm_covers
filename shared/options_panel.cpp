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

} // namespace

void init(HWND dlg, const CoverEngine::Settings& s) {
    SendDlgItemMessageA(dlg, IDC_OPT_SIZE, CB_ADDSTRING, 0, (LPARAM)"Small");
    SendDlgItemMessageA(dlg, IDC_OPT_SIZE, CB_ADDSTRING, 0, (LPARAM)"Medium");
    SendDlgItemMessageA(dlg, IDC_OPT_SIZE, CB_ADDSTRING, 0, (LPARAM)"Large");
    SendDlgItemMessageA(dlg, IDC_OPT_TRANS, CB_ADDSTRING, 0, (LPARAM)"None");
    SendDlgItemMessageA(dlg, IDC_OPT_TRANS, CB_ADDSTRING, 0, (LPARAM)"Crossfade");
    SendDlgItemMessageA(dlg, IDC_OPT_TRANS, CB_ADDSTRING, 0, (LPARAM)"Flip horizontal");
    SendDlgItemMessageA(dlg, IDC_OPT_TRANS, CB_ADDSTRING, 0, (LPARAM)"Flip vertical");
    SendDlgItemMessageA(dlg, IDC_OPT_FADE, TBM_SETRANGE, TRUE, MAKELONG(500, 2000));
    SendDlgItemMessageA(dlg, IDC_OPT_FADE, TBM_SETLINESIZE, 0, 100);
    SendDlgItemMessageA(dlg, IDC_OPT_FADE, TBM_SETPAGESIZE, 0, 100);
    SendDlgItemMessageA(dlg, IDC_OPT_FADE, TBM_SETTICFREQ, 100, 0);
    setValues(dlg, s);
}

void setValues(HWND dlg, const CoverEngine::Settings& s) {
    CheckDlgButton(dlg, IDC_OPT_OVERLAY, s.showOverlay ? BST_CHECKED : BST_UNCHECKED);
    SendDlgItemMessageA(dlg, IDC_OPT_SIZE, CB_SETCURSEL, clampi(s.overlaySize, 0, 2), 0);
    CheckDlgButton(dlg, IDC_OPT_ROLL, s.rollDigits ? BST_CHECKED : BST_UNCHECKED);
    SendDlgItemMessageA(dlg, IDC_OPT_TRANS, CB_SETCURSEL, clampi(s.transition, 0, 3), 0);
    SendDlgItemMessageA(dlg, IDC_OPT_FADE, TBM_SETPOS, TRUE, clampi(s.fadeMs, 500, 2000));
    updateFadeLabel(dlg);
    updateEnabled(dlg);
}

void read(HWND dlg, CoverEngine::Settings& s) {
    s.showOverlay = IsDlgButtonChecked(dlg, IDC_OPT_OVERLAY) == BST_CHECKED;
    s.overlaySize = clampi((int)SendDlgItemMessageA(dlg, IDC_OPT_SIZE, CB_GETCURSEL, 0, 0), 0, 2);
    s.rollDigits  = IsDlgButtonChecked(dlg, IDC_OPT_ROLL) == BST_CHECKED;
    s.transition  = clampi((int)SendDlgItemMessageA(dlg, IDC_OPT_TRANS, CB_GETCURSEL, 0, 0), 0, 3);
    const int fade = (int)SendDlgItemMessageA(dlg, IDC_OPT_FADE, TBM_GETPOS, 0, 0);
    s.fadeMs = clampi(((fade + 50) / 100) * 100, 500, 2000); // snap to 100 ms
}

void updateEnabled(HWND dlg) {
    const BOOL overlay = IsDlgButtonChecked(dlg, IDC_OPT_OVERLAY) == BST_CHECKED;
    EnableWindow(GetDlgItem(dlg, IDC_OPT_SIZE), overlay);
    EnableWindow(GetDlgItem(dlg, IDC_OPT_ROLL), overlay);
    const BOOL animated = SendDlgItemMessageA(dlg, IDC_OPT_TRANS, CB_GETCURSEL, 0, 0) != 0;
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
