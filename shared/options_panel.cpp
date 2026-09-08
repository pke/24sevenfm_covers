// options_panel.cpp - see header. All A-variant Win32 calls so the same code drives
// both the Winamp (ANSI) dialog and the foobar2000 (Unicode/WTL) dialog; the message
// thunks convert as needed.
#include "options_panel.h"

#include "config.h"
#include "child_fade.h"
#include "media_resolver.h"

#include <commctrl.h>
#include <shellapi.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <ctime>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

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

const char* const kProviderIds[] = { "fanart", "tmdb", "tvmaze", "steamgriddb" };
const char* const kProviderNames[] = { "fanart.tv", "TMDB", "TVmaze", "SteamGridDB" };
const char* const kProviderLinks[] = {
    "https://fanart.tv/", "https://www.themoviedb.org/",
    "https://www.tvmaze.com/", "https://www.steamgriddb.com/"
};
const char* const kUpdatingProviders = "24sevenfm.options.updatingProviders";
const char* const kPanelState = "24sevenfm.options.panelState";
const UINT kFanartCheckDone = WM_APP + 0x247;
const UINT_PTR kOptionsSubclass = 0x247;
const UINT_PTR kLinkSubclass = 0x248;

bool isLinkControl(int id) {
    return id == IDC_OPT_PROVIDER_LINK || id == IDC_OPT_FANART_KEY_WHY
        || id == IDC_OPT_FANART_KEY_GET;
}

struct PanelState {
    HWND parent = nullptr;
    HWND details = nullptr;
    HWND hoveredLink = nullptr;
    HFONT linkFont = nullptr;
    int provider = -1;
    bool updatingKey = false;
    bool checking = false;
    unsigned generation = 0;
    unsigned completedGeneration = 0;
    unsigned long long verifiedAt = 0;
    unsigned long long previousVerifiedAt = 0;
    std::shared_ptr<std::atomic<bool> > cancel;
    std::thread worker;
    std::mutex resultMutex;
    ssc::FanartKeyCheckResult result;
};

PanelState* stateFor(HWND dlg) {
    return reinterpret_cast<PanelState*>(GetPropA(dlg, kPanelState));
}

HWND detailControl(PanelState* state, int id) {
    return state && state->details ? GetDlgItem(state->details, id) : nullptr;
}

std::string editKey(PanelState* state) {
    char value[129] = {0};
    if (state && state->details)
        GetDlgItemTextA(state->details, IDC_OPT_FANART_KEY, value, (int)sizeof(value));
    return ssccfg::cleanFanartClientKey(value);
}

std::string verificationDate(unsigned long long epochMs) {
    if (!epochMs) return std::string();
    const std::time_t seconds = static_cast<std::time_t>(epochMs / 1000ULL);
    std::tm utc = {};
    if (gmtime_s(&utc, &seconds) != 0) return std::string();
    char text[32] = {0};
    std::strftime(text, sizeof(text), "%Y-%m-%d", &utc);
    return text;
}

void refreshKeyButton(PanelState* state) {
    if (!state || !state->details) return;
    const bool hasKey = !editKey(state).empty();
    SetDlgItemTextA(state->details, IDC_OPT_FANART_KEY_CHECK,
        state->checking ? "Checking..." : (hasKey && state->verifiedAt ? "Checked" : "Check"));
    EnableWindow(detailControl(state, IDC_OPT_FANART_KEY_CHECK),
        hasKey && !state->checking);
}

void setProviderDetail(HWND dlg, int provider, bool animate) {
    PanelState* state = stateFor(dlg);
    if (!state || !state->details || provider < 0 || provider >= 4) return;
    if (state->provider == provider && IsWindowVisible(state->details)) return;

    childfade::replace(state->details, state->details, animate, [state, provider] {
        state->provider = provider;
        SetDlgItemTextA(state->details, IDC_OPT_PROVIDER_LINK, kProviderLinks[provider]);
        SetDlgItemTextA(state->details, IDC_OPT_PROVIDER_ATTRIBUTION,
            provider == 1
                ? "This product uses the TMDB API but is not endorsed or certified by TMDB."
            : provider == 2 ? "TV data & artwork by TVmaze."
            : provider == 3 ? "GameArt by SteamGridDB."
            : "");

        const int fanartControls[] = { IDC_OPT_FANART_KEY_LABEL, IDC_OPT_FANART_KEY,
            IDC_OPT_FANART_KEY_CHECK, IDC_OPT_FANART_KEY_STATUS,
            IDC_OPT_FANART_KEY_WHY, IDC_OPT_FANART_KEY_GET };
        for (int id : fanartControls)
            ShowWindow(detailControl(state, id), provider == 0 ? SW_SHOW : SW_HIDE);
        ShowWindow(detailControl(state, IDC_OPT_PROVIDER_ATTRIBUTION),
            provider == 0 ? SW_HIDE : SW_SHOW);
        refreshKeyButton(state);
    });
}

int selectedProvider(HWND dlg) {
    HWND list = GetDlgItem(dlg, IDC_OPT_PROVIDERS);
    const int row = ListView_GetNextItem(list, -1, LVNI_SELECTED);
    if (row < 0) return -1;
    LVITEMA item = {}; item.mask = LVIF_PARAM; item.iItem = row;
    return SendMessageA(list, LVM_GETITEMA, 0, (LPARAM)&item) ? (int)item.lParam : -1;
}

void finishFanartCheck(PanelState* state, unsigned generation) {
    if (!state) return;
    if (state->worker.joinable()) state->worker.join();
    state->checking = false;
    if (generation != state->generation || generation != state->completedGeneration) {
        refreshKeyButton(state);
        return;
    }
    ssc::FanartKeyCheckResult result;
    {
        std::lock_guard<std::mutex> lock(state->resultMutex);
        result = state->result;
    }
    if (result.status == ssc::FanartKeyCheckStatus::Accepted) {
        state->verifiedAt = static_cast<unsigned long long>(
            std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()).count());
        const std::string date = verificationDate(state->verifiedAt);
        SetDlgItemTextA(state->details, IDC_OPT_FANART_KEY_STATUS,
            date.empty() ? "Personal key accepted."
                : ("Personal key accepted on " + date + ".").c_str());
    } else if (result.status == ssc::FanartKeyCheckStatus::Rejected) {
        state->verifiedAt = 0;
        SetDlgItemTextA(state->details, IDC_OPT_FANART_KEY_STATUS,
            "Personal key not accepted.");
    } else if (result.status == ssc::FanartKeyCheckStatus::Invalid) {
        state->verifiedAt = 0;
        SetDlgItemTextA(state->details, IDC_OPT_FANART_KEY_STATUS,
            "Enter a valid personal key.");
    } else {
        state->verifiedAt = state->previousVerifiedAt;
        SetDlgItemTextA(state->details, IDC_OPT_FANART_KEY_STATUS,
            "Could not check the personal key right now.");
    }
    refreshKeyButton(state);
    SendMessageA(state->parent, WM_COMMAND,
        MAKEWPARAM(IDC_OPT_FANART_KEY_VERIFIED, BN_CLICKED), 0);
}

void beginFanartCheck(PanelState* state) {
    if (!state || state->checking || state->worker.joinable()) return;
    const std::string key = editKey(state);
    if (key.empty()) {
        state->verifiedAt = 0;
        SetDlgItemTextA(state->details, IDC_OPT_FANART_KEY_STATUS,
            "Enter a personal key first.");
        refreshKeyButton(state);
        return;
    }
    state->checking = true;
    state->previousVerifiedAt = state->verifiedAt;
    const unsigned generation = ++state->generation;
    state->cancel = std::make_shared<std::atomic<bool> >(false);
    SetDlgItemTextA(state->details, IDC_OPT_FANART_KEY_STATUS, "");
    refreshKeyButton(state);
    state->worker = std::thread([state, key, generation] {
        ssc::MediaResolverConfig config;
        config.timeoutSeconds = 10;
        const ssc::FanartKeyCheckResult result =
            ssc::MediaResolver(config).checkFanartClientKey(key, state->cancel.get());
        {
            std::lock_guard<std::mutex> lock(state->resultMutex);
            state->result = result;
            state->completedGeneration = generation;
        }
        PostMessageA(state->parent, kFanartCheckDone, generation, 0);
    });
}

void cancelAndJoin(PanelState* state) {
    if (!state) return;
    ++state->generation;
    if (state->cancel) state->cancel->store(true);
    if (state->worker.joinable()) state->worker.join();
}

LRESULT CALLBACK OptionsSubclassProc(HWND dlg, UINT msg, WPARAM wp, LPARAM lp,
                                     UINT_PTR id, DWORD_PTR ref) {
    PanelState* state = reinterpret_cast<PanelState*>(ref);
    if (msg == kFanartCheckDone) {
        finishFanartCheck(state, (unsigned)wp);
        return 0;
    }
    if (msg == WM_NCDESTROY) {
        cancelAndJoin(state);
        RemovePropA(dlg, kPanelState);
        RemoveWindowSubclass(dlg, OptionsSubclassProc, id);
        const LRESULT result = DefSubclassProc(dlg, msg, wp, lp);
        if (state->linkFont) DeleteObject(state->linkFont);
        delete state;
        return result;
    }
    return DefSubclassProc(dlg, msg, wp, lp);
}

LRESULT CALLBACK LinkSubclassProc(HWND link, UINT msg, WPARAM wp, LPARAM lp,
                                  UINT_PTR id, DWORD_PTR ref) {
    PanelState* state = reinterpret_cast<PanelState*>(ref);
    if (msg == WM_SETCURSOR) {
        SetCursor(LoadCursor(nullptr, IDC_HAND));
        return TRUE;
    }
    if (msg == WM_MOUSEMOVE && state) {
        if (state->hoveredLink != link) {
            if (state->hoveredLink) InvalidateRect(state->hoveredLink, nullptr, TRUE);
            state->hoveredLink = link;
            InvalidateRect(link, nullptr, TRUE);
        }
        TRACKMOUSEEVENT tracking = { sizeof(tracking), TME_LEAVE, link, 0 };
        TrackMouseEvent(&tracking);
    } else if (msg == WM_MOUSELEAVE && state && state->hoveredLink == link) {
        state->hoveredLink = nullptr;
        InvalidateRect(link, nullptr, TRUE);
    } else if (msg == WM_NCDESTROY) {
        if (state && state->hoveredLink == link) state->hoveredLink = nullptr;
        RemoveWindowSubclass(link, LinkSubclassProc, id);
    }
    return DefSubclassProc(link, msg, wp, lp);
}

INT_PTR CALLBACK ProviderDetailsProc(HWND details, UINT msg, WPARAM wp, LPARAM lp) {
    PanelState* state = reinterpret_cast<PanelState*>(GetWindowLongPtrA(details, DWLP_USER));
    if (msg == WM_INITDIALOG) {
        state = reinterpret_cast<PanelState*>(lp);
        SetWindowLongPtrA(details, DWLP_USER, reinterpret_cast<LONG_PTR>(state));
        SendDlgItemMessageA(details, IDC_OPT_FANART_KEY, EM_SETLIMITTEXT, 128, 0);
        HFONT base = (HFONT)SendMessageA(state->parent, WM_GETFONT, 0, 0);
        LOGFONTA font = {};
        if (base && GetObjectA(base, sizeof(font), &font)) {
            font.lfUnderline = TRUE;
            state->linkFont = CreateFontIndirectA(&font);
        }
        const int links[] = { IDC_OPT_PROVIDER_LINK, IDC_OPT_FANART_KEY_WHY,
                              IDC_OPT_FANART_KEY_GET };
        for (int id : links) {
            if (state->linkFont)
                SendDlgItemMessageA(details, id, WM_SETFONT, (WPARAM)state->linkFont, TRUE);
            SetWindowSubclass(GetDlgItem(details, id), LinkSubclassProc, kLinkSubclass,
                reinterpret_cast<DWORD_PTR>(state));
        }
        return TRUE;
    }
    if (!state) return FALSE;
    if (msg == WM_CTLCOLORSTATIC && isLinkControl(GetDlgCtrlID((HWND)lp))) {
        SetBkMode((HDC)wp, TRANSPARENT);
        SetTextColor((HDC)wp, state->hoveredLink == (HWND)lp
            ? RGB(51, 51, 255) : RGB(0, 0, 238));
        return reinterpret_cast<INT_PTR>(GetSysColorBrush(COLOR_3DFACE));
    }
    if (msg == WM_COMMAND) {
        const int id = LOWORD(wp), code = HIWORD(wp);
        if (code == STN_CLICKED && id == IDC_OPT_PROVIDER_LINK) {
            if (state->provider >= 0 && state->provider < 4)
                ShellExecuteA(details, "open", kProviderLinks[state->provider], nullptr, nullptr, SW_SHOWNORMAL);
            return TRUE;
        }
        if (code == STN_CLICKED && (id == IDC_OPT_FANART_KEY_WHY || id == IDC_OPT_FANART_KEY_GET)) {
            ShellExecuteA(details, "open", id == IDC_OPT_FANART_KEY_WHY
                ? "https://fanart.tv/personal-api-keys/"
                : "https://fanart.tv/get-an-api-key/", nullptr, nullptr, SW_SHOWNORMAL);
            return TRUE;
        }
        if (id == IDC_OPT_FANART_KEY_CHECK && code == BN_CLICKED) {
            beginFanartCheck(state);
            return TRUE;
        }
        if (id == IDC_OPT_FANART_KEY && code == EN_CHANGE && !state->updatingKey) {
            ++state->generation;
            if (state->cancel) state->cancel->store(true);
            state->verifiedAt = 0;
            SetDlgItemTextA(details, IDC_OPT_FANART_KEY_STATUS, "");
            refreshKeyButton(state);
            SendMessageA(state->parent, WM_COMMAND,
                MAKEWPARAM(IDC_OPT_FANART_KEY, EN_CHANGE), (LPARAM)GetDlgItem(details, id));
            return TRUE;
        }
    }
    return FALSE;
}

void createProviderDetails(HWND dlg) {
    HWND placeholder = GetDlgItem(dlg, IDC_OPT_PROVIDER_DETAILS);
    if (!placeholder) return;
    RECT rect = {}; GetWindowRect(placeholder, &rect);
    MapWindowPoints(HWND_DESKTOP, dlg, reinterpret_cast<POINT*>(&rect), 2);
    DestroyWindow(placeholder);

    PanelState* state = new PanelState();
    state->parent = dlg;
    SetPropA(dlg, kPanelState, state);
    SetWindowSubclass(dlg, OptionsSubclassProc, kOptionsSubclass,
        reinterpret_cast<DWORD_PTR>(state));
    const HINSTANCE instance = reinterpret_cast<HINSTANCE>(
        GetWindowLongPtrA(dlg, GWLP_HINSTANCE));
    state->details = CreateDialogParamA(instance,
        MAKEINTRESOURCEA(IDD_OPT_PROVIDER_DETAILS), dlg, ProviderDetailsProc,
        reinterpret_cast<LPARAM>(state));
    if (!state->details) return;
    SetWindowLongPtrA(state->details, GWLP_ID, IDC_OPT_PROVIDER_DETAILS);
    SetWindowPos(state->details, nullptr, rect.left, rect.top,
        rect.right - rect.left, rect.bottom - rect.top,
        SWP_NOZORDER | SWP_NOACTIVATE);
}

void insertProvider(HWND list, int at, int provider, bool enabled) {
    LVITEMA item = {};
    item.mask = LVIF_TEXT | LVIF_PARAM;
    item.iItem = at < 0 ? ListView_GetItemCount(list) : at;
    item.pszText = const_cast<char*>(kProviderNames[provider]);
    item.lParam = provider;
    const int row = (int)SendMessageA(list, LVM_INSERTITEMA, 0, (LPARAM)&item);
    if (row >= 0) ListView_SetCheckState(list, row, enabled ? TRUE : FALSE);
}

void setProviders(HWND dlg, const std::string& csv) {
    HWND list = GetDlgItem(dlg, IDC_OPT_PROVIDERS);
    SetPropA(dlg, kUpdatingProviders, reinterpret_cast<HANDLE>(1));
    ListView_DeleteAllItems(list);
    bool added[4] = {false, false, false, false};
    size_t begin = 0;
    while (begin <= csv.size()) {
        const size_t end = csv.find(',', begin);
        const std::string id = csv.substr(begin,
            end == std::string::npos ? std::string::npos : end - begin);
        for (int i = 0; i < 4; ++i) if (!added[i] && id == kProviderIds[i]) {
            insertProvider(list, -1, i, true); added[i] = true; break;
        }
        if (end == std::string::npos) break;
        begin = end + 1;
    }
    for (int i = 0; i < 4; ++i) if (!added[i]) insertProvider(list, -1, i, false);
    ListView_SetItemState(list, 0, LVIS_SELECTED | LVIS_FOCUSED, LVIS_SELECTED | LVIS_FOCUSED);
    RemovePropA(dlg, kUpdatingProviders);
    setProviderDetail(dlg, selectedProvider(dlg), false);
}

std::string getProviders(HWND dlg) {
    HWND list = GetDlgItem(dlg, IDC_OPT_PROVIDERS);
    const int count = ListView_GetItemCount(list);
    std::string out;
    for (int i = 0; i < count; ++i) {
        LVITEMA item = {}; item.mask = LVIF_PARAM; item.iItem = i;
        SendMessageA(list, LVM_GETITEMA, 0, (LPARAM)&item);
        const int provider = (int)item.lParam;
        if (ListView_GetCheckState(list, i) && provider >= 0 && provider < 4) {
            if (!out.empty()) out += ',';
            out += kProviderIds[provider];
        }
    }
    // The master switch may stay checked while every row was toggled off. Keep a
    // valid request contract; TMDB is the resolver's conservative base provider.
    return out.empty() ? "tmdb" : out;
}

void moveProvider(HWND dlg, int delta) {
    HWND list = GetDlgItem(dlg, IDC_OPT_PROVIDERS);
    const int row = ListView_GetNextItem(list, -1, LVNI_SELECTED);
    const int count = ListView_GetItemCount(list);
    const int dest = row + delta;
    if (row < 0 || dest < 0 || dest >= count) return;
    LVITEMA item = {}; item.mask = LVIF_PARAM; item.iItem = row;
    SendMessageA(list, LVM_GETITEMA, 0, (LPARAM)&item);
    const bool checked = ListView_GetCheckState(list, row) != FALSE;
    SetPropA(dlg, kUpdatingProviders, reinterpret_cast<HANDLE>(1));
    ListView_DeleteItem(list, row);
    insertProvider(list, dest, (int)item.lParam, checked);
    ListView_SetItemState(list, dest, LVIS_SELECTED | LVIS_FOCUSED, LVIS_SELECTED | LVIS_FOCUSED);
    RemovePropA(dlg, kUpdatingProviders);
}

} // namespace

void init(HWND dlg, const CoverEngine::Settings& s) {
    // The radio labels are static in the .rc; only the slider needs setup here.
    SendDlgItemMessageA(dlg, IDC_OPT_FADE, TBM_SETRANGE, TRUE, MAKELONG(500, 2000));
    SendDlgItemMessageA(dlg, IDC_OPT_FADE, TBM_SETLINESIZE, 0, 100);
    SendDlgItemMessageA(dlg, IDC_OPT_FADE, TBM_SETPAGESIZE, 0, 100);
    SendDlgItemMessageA(dlg, IDC_OPT_FADE, TBM_SETTICFREQ, 100, 0);
    HWND list = GetDlgItem(dlg, IDC_OPT_PROVIDERS);
    ListView_SetUnicodeFormat(list, FALSE); // shared code supplies stable ASCII provider names
    ListView_SetExtendedListViewStyle(list,
        LVS_EX_CHECKBOXES | LVS_EX_FULLROWSELECT | LVS_EX_DOUBLEBUFFER);
    RECT listRect = {}; GetClientRect(list, &listRect);
    LVCOLUMNA column = {}; column.mask = LVCF_WIDTH;
    column.cx = listRect.right > 24 ? listRect.right - 4 : 140;
    SendMessageA(list, LVM_INSERTCOLUMNA, 0, (LPARAM)&column);
    createProviderDetails(dlg);
    setValues(dlg, s);
}

void setValues(HWND dlg, const CoverEngine::Settings& s) {
    setRadio(dlg, IDC_OPT_LAYOUT, 2, s.layout);
    CheckDlgButton(dlg, IDC_OPT_OVERLAY, s.showRemaining ? BST_CHECKED : BST_UNCHECKED);
    setRadio(dlg, IDC_OPT_SIZE, 3, s.remainingSize);
    CheckDlgButton(dlg, IDC_OPT_ROLL, s.rollDigits ? BST_CHECKED : BST_UNCHECKED);
    setRadio(dlg, IDC_OPT_TRANS, 4, s.transition);
    SendDlgItemMessageA(dlg, IDC_OPT_FADE, TBM_SETPOS, TRUE, clampi(s.fadeMs, 500, 2000));
    CheckDlgButton(dlg, IDC_OPT_BACKDROPS, s.backdrops ? BST_CHECKED : BST_UNCHECKED);
    CheckDlgButton(dlg, IDC_OPT_RATINGS, s.ratings ? BST_CHECKED : BST_UNCHECKED);
    CheckDlgButton(dlg, IDC_OPT_HIDECOVER, s.hideCoverWithBackdrop ? BST_CHECKED : BST_UNCHECKED);
    CheckDlgButton(dlg, IDC_OPT_RATING_DE, s.ratingDE ? BST_CHECKED : BST_UNCHECKED);
    CheckDlgButton(dlg, IDC_OPT_RATING_US, s.ratingUS ? BST_CHECKED : BST_UNCHECKED);
    if (PanelState* state = stateFor(dlg)) {
        state->updatingKey = true;
        SetDlgItemTextA(state->details, IDC_OPT_FANART_KEY, s.fanartClientKey.c_str());
        state->verifiedAt = s.fanartClientKey.empty() ? 0 : s.fanartClientKeyVerifiedAt;
        const std::string date = verificationDate(state->verifiedAt);
        SetDlgItemTextA(state->details, IDC_OPT_FANART_KEY_STATUS,
            date.empty() ? "" : ("Checked on " + date + ".").c_str());
        state->updatingKey = false;
        refreshKeyButton(state);
    }
    setProviders(dlg, s.mediaProviders);
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
    s.backdrops = IsDlgButtonChecked(dlg, IDC_OPT_BACKDROPS) == BST_CHECKED;
    s.ratings = IsDlgButtonChecked(dlg, IDC_OPT_RATINGS) == BST_CHECKED;
    s.hideCoverWithBackdrop = IsDlgButtonChecked(dlg, IDC_OPT_HIDECOVER) == BST_CHECKED;
    s.ratingDE = IsDlgButtonChecked(dlg, IDC_OPT_RATING_DE) == BST_CHECKED;
    s.ratingUS = IsDlgButtonChecked(dlg, IDC_OPT_RATING_US) == BST_CHECKED;
    if (!s.ratingDE && !s.ratingUS) s.ratingDE = true;
    s.mediaProviders = getProviders(dlg);
    if (PanelState* state = stateFor(dlg)) {
        s.fanartClientKey = editKey(state);
        s.fanartClientKeyVerifiedAt = s.fanartClientKey.empty() ? 0 : state->verifiedAt;
    }
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
    const BOOL backdrop = IsDlgButtonChecked(dlg, IDC_OPT_BACKDROPS) == BST_CHECKED;
    EnableWindow(GetDlgItem(dlg, IDC_OPT_HIDECOVER), backdrop);
    EnableWindow(GetDlgItem(dlg, IDC_OPT_PROVIDERS), backdrop);
    EnableWindow(GetDlgItem(dlg, IDC_OPT_PROVIDER_UP), backdrop);
    EnableWindow(GetDlgItem(dlg, IDC_OPT_PROVIDER_DOWN), backdrop);
    if (PanelState* state = stateFor(dlg)) {
        EnableWindow(state->details, backdrop);
        refreshKeyButton(state);
    }
    const BOOL ratings = IsDlgButtonChecked(dlg, IDC_OPT_RATINGS) == BST_CHECKED;
    EnableWindow(GetDlgItem(dlg, IDC_OPT_RATING_DE), ratings);
    EnableWindow(GetDlgItem(dlg, IDC_OPT_RATING_US), ratings);
}

void onHScroll(HWND dlg) {
    const int pos = (int)SendDlgItemMessageA(dlg, IDC_OPT_FADE, TBM_GETPOS, 0, 0);
    const int snapped = ((pos + 50) / 100) * 100;
    if (snapped != pos)
        SendDlgItemMessageA(dlg, IDC_OPT_FADE, TBM_SETPOS, TRUE, snapped);
    updateFadeLabel(dlg);
}

bool onCommand(HWND dlg, int controlId) {
    if (controlId == IDC_OPT_PROVIDER_UP) moveProvider(dlg, -1);
    else if (controlId == IDC_OPT_PROVIDER_DOWN) moveProvider(dlg, 1);
    else {
        if ((controlId == IDC_OPT_RATING_DE || controlId == IDC_OPT_RATING_US)
                && IsDlgButtonChecked(dlg, IDC_OPT_RATING_DE) != BST_CHECKED
                && IsDlgButtonChecked(dlg, IDC_OPT_RATING_US) != BST_CHECKED)
            CheckDlgButton(dlg, controlId == IDC_OPT_RATING_DE
                ? IDC_OPT_RATING_US : IDC_OPT_RATING_DE, BST_CHECKED);
        updateEnabled(dlg); return false;
    }
    updateEnabled(dlg);
    return true;
}

bool onNotify(HWND dlg, const NMHDR* header) {
    if (!header || header->idFrom != IDC_OPT_PROVIDERS || header->code != LVN_ITEMCHANGED)
        return false;
    const NMLISTVIEW* change = reinterpret_cast<const NMLISTVIEW*>(header);
    if (!(change->uChanged & LVIF_STATE)) return false;
    if (!GetPropA(dlg, kUpdatingProviders)
            && !(change->uOldState & LVIS_SELECTED)
            && (change->uNewState & LVIS_SELECTED))
        setProviderDetail(dlg, selectedProvider(dlg), true);
    if (GetPropA(dlg, kUpdatingProviders)) return false;
    const UINT oldCheck = change->uOldState & LVIS_STATEIMAGEMASK;
    const UINT newCheck = change->uNewState & LVIS_STATEIMAGEMASK;
    return oldCheck != newCheck && oldCheck != 0 && newCheck != 0;
}

} // namespace optpanel
