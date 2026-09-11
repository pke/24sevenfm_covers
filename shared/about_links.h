#pragma once

#include <windows.h>
#include <shellapi.h>

#include <cstring>
#include <initializer_list>

// The desktop viewer and Winamp host the same About links. Keep their styling,
// cursor and destinations in one place so URL-looking text never behaves like a
// plain label in one host. The copyright label is promoted to a link at runtime,
// which keeps the existing resource files and their encoding untouched.
namespace ssclinks {

inline const char* aboutUrl(int controlId) {
    if (controlId == IDC_ABOUT_LINK) return "https://24seven.fm/";
    if (controlId == IDC_ABOUT_DUDESOFT) return SSC_WEB;
    return nullptr;
}

inline HWND findCopyrightLabel(HWND dlg) {
    HWND child = nullptr;
    while ((child = FindWindowExA(dlg, child, "Static", nullptr)) != nullptr) {
        char text[256] = {};
        GetWindowTextA(child, text, static_cast<int>(sizeof(text)));
        if (std::strcmp(text, SSC_COPYRIGHT) == 0) return child;
    }
    return nullptr;
}

inline bool isAboutLink(HWND dlg, HWND control) {
    return control && GetParent(control) == dlg
        && aboutUrl(GetDlgCtrlID(control)) != nullptr;
}

inline void initAboutLinks(HWND dlg, HFONT& linkFont) {
    if (HWND copyright = findCopyrightLabel(dlg)) {
        SetWindowLongPtrA(copyright, GWLP_ID, IDC_ABOUT_DUDESOFT);
        SetWindowLongPtrA(copyright, GWL_STYLE,
            GetWindowLongPtrA(copyright, GWL_STYLE) | SS_NOTIFY);
    }

    HFONT base = reinterpret_cast<HFONT>(SendMessageA(dlg, WM_GETFONT, 0, 0));
    LOGFONTA font = {};
    if (!base || !GetObjectA(base, sizeof(font), &font)) return;
    font.lfUnderline = TRUE;
    if (linkFont) DeleteObject(linkFont);
    linkFont = CreateFontIndirectA(&font);
    if (!linkFont) return;
    for (int id : {IDC_ABOUT_LINK, IDC_ABOUT_DUDESOFT})
        SendDlgItemMessageA(dlg, id, WM_SETFONT,
                            reinterpret_cast<WPARAM>(linkFont), TRUE);
}

inline INT_PTR colorAboutLink(HWND dlg, WPARAM dc, LPARAM control) {
    if (!isAboutLink(dlg, reinterpret_cast<HWND>(control))) return 0;
    SetTextColor(reinterpret_cast<HDC>(dc), RGB(0, 0, 238));
    SetBkMode(reinterpret_cast<HDC>(dc), TRANSPARENT);
    return reinterpret_cast<INT_PTR>(GetStockObject(NULL_BRUSH));
}

inline bool setAboutLinkCursor(HWND dlg, WPARAM control) {
    if (!isAboutLink(dlg, reinterpret_cast<HWND>(control))) return false;
    SetCursor(LoadCursor(nullptr, IDC_HAND));
    return true;
}

inline bool openAboutLink(HWND dlg, WPARAM command) {
    if (HIWORD(command) != STN_CLICKED) return false;
    const char* url = aboutUrl(LOWORD(command));
    if (!url) return false;
    ShellExecuteA(dlg, "open", url, nullptr, nullptr, SW_SHOWNORMAL);
    return true;
}

} // namespace ssclinks
