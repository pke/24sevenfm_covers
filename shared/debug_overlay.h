#pragma once
#include <windows.h>
#include <commctrl.h>
#include <richedit.h>
#include <algorithm>
#include <functional>
#include <string>
#pragma comment(lib, "comctl32.lib")

namespace ssc {
// Owned layered popup: works inside hosts without a Windows-8 child-layer manifest.
// All three native hosts acquire the same keyboard/dismiss behavior via setWindow.
class DebugOverlay {
public:
    enum { kText = 101, kCopy = 102, kFreeze = 103, kClose = 104 };
    ~DebugOverlay() { attach(nullptr, {}); if (font_) DeleteObject(font_); if (brush_) DeleteObject(brush_); }
    HWND window() const { return panel_; }
    bool isOpen() const { return open_; }
    void attach(HWND parent, std::function<std::string()> snapshot) {
        if (parent_ == parent) { snapshot_ = snapshot; return; }
        if (parent_ && IsWindow(parent_)) RemoveWindowSubclass(parent_, parentProc, subclassId());
        parent_ = nullptr; open_ = false;
        if (panel_) DestroyWindow(panel_);
        panel_ = nullptr; text_ = nullptr;
        parent_ = parent; snapshot_ = snapshot;
        if (parent_) SetWindowSubclass(parent_, parentProc, subclassId(), reinterpret_cast<DWORD_PTR>(this));
    }
    void advance(DWORD now) {
        if (!panel_) return;
        const float progress = !animations() ? 1.0f : (std::min)(1.0f, (now - started_) / 180.0f);
        alpha_ = fromAlpha_ + (targetAlpha_ - fromAlpha_) * progress;
        SetLayeredWindowAttributes(panel_, 0, static_cast<BYTE>(alpha_), LWA_ALPHA);
        if (!open_ && progress >= 1) { ShowWindow(panel_, SW_HIDE); KillTimer(panel_, 1); return; }
        if (open_ && now - refreshed_ >= 1000) { refresh(false); refreshed_ = now; }
        if (open_) position(now);
    }
private:
    HWND parent_ = nullptr, panel_ = nullptr, text_ = nullptr, previousFocus_ = nullptr;
    HFONT font_ = nullptr; HBRUSH brush_ = nullptr;
    bool open_ = false, frozen_ = false;
    float alpha_ = 0, fromAlpha_ = 0, targetAlpha_ = 0;
    DWORD started_ = 0, refreshed_ = 0, geometryStarted_ = 0, copiedAt_ = 0;
    RECT geometry_ = {}, fromGeometry_ = {}, targetGeometry_ = {};
    std::function<std::string()> snapshot_;
    std::wstring displayed_;
    UINT_PTR subclassId() const { return reinterpret_cast<UINT_PTR>(this); }
    static bool animations() {
        BOOL enabled = TRUE;
        return !SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &enabled, 0) || enabled;
    }
    static std::wstring wide(const std::string& value) {
        const int size = MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0);
        std::wstring out(size, L'\0');
        if (size) MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), &out[0], size);
        return out;
    }
    void refresh(bool force) {
        if (!text_ || !snapshot_ || (frozen_ && !force)) return;
        CHARRANGE selection = {}; SendMessageW(text_, EM_EXGETSEL, 0, reinterpret_cast<LPARAM>(&selection));
        if (!force && selection.cpMin != selection.cpMax) return;
        POINT scroll = {}; SendMessageW(text_, EM_GETSCROLLPOS, 0, reinterpret_cast<LPARAM>(&scroll));
        displayed_ = wide(snapshot_());
        SendMessageW(text_, WM_SETREDRAW, FALSE, 0);
        SetWindowTextW(text_, displayed_.c_str());
        SendMessageW(text_, EM_EXSETSEL, 0, reinterpret_cast<LPARAM>(&selection));
        SendMessageW(text_, EM_SETSCROLLPOS, 0, reinterpret_cast<LPARAM>(&scroll));
        SendMessageW(text_, WM_SETREDRAW, TRUE, 0); InvalidateRect(text_, nullptr, FALSE);
    }
    void setOpen(bool value, bool restoreFocus = true) {
        if (!parent_) return;
        if (value && !panel_ && !create()) return;
        open_ = value; fromAlpha_ = alpha_; targetAlpha_ = value ? 235.0f : 0.0f; started_ = GetTickCount();
        if (value) {
            previousFocus_ = GetFocus(); frozen_ = false; SetDlgItemTextW(panel_, kFreeze, L"Freeze");
            refresh(true); position(started_, true);
            SetLayeredWindowAttributes(panel_, 0, static_cast<BYTE>(alpha_), LWA_ALPHA);
            ShowWindow(panel_, SW_SHOWNOACTIVATE); SetFocus(text_);
        } else if (restoreFocus && (GetFocus() == panel_ || IsChild(panel_, GetFocus()))) {
            SetFocus(previousFocus_ && IsWindow(previousFocus_) ? previousFocus_ : parent_);
        }
        SetTimer(panel_, 1, 16, nullptr); advance(started_);
    }
    void position(DWORD now, bool immediate = false) {
        RECT client = {}; if (!GetClientRect(parent_, &client)) return;
        POINT origin = { 14, 14 }; ClientToScreen(parent_, &origin);
        RECT next = { origin.x, origin.y, origin.x + (std::min)(740L, (std::max)(1L, client.right - 28)),
            origin.y + (std::min)(620L, (std::max)(1L, client.bottom - 28)) };
        if (immediate || !EqualRect(&targetGeometry_, &next)) {
            fromGeometry_ = immediate ? next : geometry_; targetGeometry_ = next; geometryStarted_ = now;
        }
        const float t = immediate || !animations() ? 1.0f : (std::min)(1.0f, (now - geometryStarted_) / 180.0f);
        auto lerp = [t](LONG a, LONG b) { return static_cast<LONG>(a + (b - a) * t); };
        geometry_ = { lerp(fromGeometry_.left, next.left), lerp(fromGeometry_.top, next.top),
            lerp(fromGeometry_.right, next.right), lerp(fromGeometry_.bottom, next.bottom) };
        SetWindowPos(panel_, HWND_TOP, geometry_.left, geometry_.top,
            geometry_.right - geometry_.left, geometry_.bottom - geometry_.top, SWP_NOACTIVATE);
        if (copiedAt_ && now - copiedAt_ > 2000) { SetDlgItemTextW(panel_, kCopy, L"Copy snapshot"); copiedAt_ = 0; }
    }
    bool create() {
        static const wchar_t name[] = L"24seven.fm.DebugOverlay";
        HINSTANCE module = nullptr;
        GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCWSTR>(&proc), &module);
        WNDCLASSW wc = {}; wc.lpfnWndProc = proc; wc.hInstance = module; wc.lpszClassName = name;
        wc.hCursor = LoadCursor(nullptr, IDC_ARROW); RegisterClassW(&wc);
        if (!brush_) brush_ = CreateSolidBrush(RGB(14, 20, 30));
        if (!font_) font_ = CreateFontW(-14, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, FIXED_PITCH, L"Consolas");
        static HMODULE richEdit = LoadLibraryW(L"Msftedit.dll");
        if (!richEdit) return false;
        panel_ = CreateWindowExW(WS_EX_LAYERED | WS_EX_TOOLWINDOW, name, L"Player diagnostics", WS_POPUP,
            0, 0, 1, 1, parent_, nullptr, module, this);
        if (!panel_) return false;
        auto child = [&](const wchar_t* kind, const wchar_t* label, int id, DWORD style) {
            HWND h = CreateWindowExW(0, kind, label, WS_CHILD | WS_VISIBLE | style, 0, 0, 1, 1,
                panel_, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), module, nullptr);
            SendMessageW(h, WM_SETFONT, reinterpret_cast<WPARAM>(font_), TRUE);
            SetWindowSubclass(h, controlProc, subclassId(), reinterpret_cast<DWORD_PTR>(this));
            return h;
        };
        child(L"BUTTON", L"Copy snapshot", kCopy, WS_TABSTOP);
        child(L"BUTTON", L"Freeze", kFreeze, WS_TABSTOP);
        child(L"BUTTON", L"Close", kClose, WS_TABSTOP);
        text_ = child(L"RICHEDIT50W", L"", kText, ES_MULTILINE | ES_READONLY | WS_VSCROLL | WS_TABSTOP);
        if (!text_) { DestroyWindow(panel_); panel_ = nullptr; return false; }
        SendMessageW(text_, EM_EXLIMITTEXT, 0, 4 * 1024 * 1024);
        SendMessageW(text_, EM_SETBKGNDCOLOR, 0, RGB(14, 20, 30));
        CHARFORMAT2W format = {}; format.cbSize = sizeof(format); format.dwMask = CFM_COLOR;
        format.crTextColor = RGB(229, 235, 246);
        SendMessageW(text_, EM_SETCHARFORMAT, SCF_ALL, reinterpret_cast<LPARAM>(&format));
        return true;
    }
    void copy() {
        HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, (displayed_.size() + 1) * sizeof(wchar_t));
        if (!memory) return;
        void* buffer = GlobalLock(memory);
        if (!buffer) { GlobalFree(memory); return; }
        memcpy(buffer, displayed_.c_str(), (displayed_.size() + 1) * sizeof(wchar_t)); GlobalUnlock(memory);
        bool copied = false;
        if (OpenClipboard(panel_)) {
            EmptyClipboard(); copied = SetClipboardData(CF_UNICODETEXT, memory) != nullptr; CloseClipboard();
        }
        if (!copied) GlobalFree(memory);
        SetDlgItemTextW(panel_, kCopy, copied ? L"Copied" : L"Copy failed"); copiedAt_ = GetTickCount();
    }
    bool key(WPARAM key, LPARAM flags) {
        if (key == VK_ESCAPE && open_) { setOpen(false); return true; }
        if (key == 'D' && !(flags & (1LL << 30)) && !(GetKeyState(VK_CONTROL) & 0x8000)
                && !(GetKeyState(VK_MENU) & 0x8000) && !(GetKeyState(VK_LWIN) & 0x8000)
                && !(GetKeyState(VK_RWIN) & 0x8000)) { setOpen(!open_); return true; }
        return false;
    }
    static LRESULT CALLBACK parentProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp, UINT_PTR id, DWORD_PTR data) {
        auto* self = reinterpret_cast<DebugOverlay*>(data);
        if (msg == WM_KEYDOWN && self->key(wp, lp)) return 0;
        if ((msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN || msg == WM_MBUTTONDOWN) && self->open_) {
            self->setOpen(false); return 0;
        }
        if (msg == WM_LBUTTONDOWN) SetFocus(hwnd);
        if (msg == WM_NCDESTROY) { self->attach(nullptr, {}); }
        return DefSubclassProc(hwnd, msg, wp, lp);
    }
    static LRESULT CALLBACK controlProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp, UINT_PTR id, DWORD_PTR data) {
        auto* self = reinterpret_cast<DebugOverlay*>(data);
        if (msg == WM_KEYDOWN && self->key(wp, lp)) return 0;
        if (msg == WM_KEYDOWN && wp == VK_TAB) {
            HWND next = GetNextDlgTabItem(self->panel_, hwnd, (GetKeyState(VK_SHIFT) & 0x8000) != 0);
            if (next) SetFocus(next);
            return 0;
        }
        if (msg == WM_NCDESTROY) RemoveWindowSubclass(hwnd, controlProc, id);
        return DefSubclassProc(hwnd, msg, wp, lp);
    }
    static LRESULT CALLBACK proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
        auto* self = reinterpret_cast<DebugOverlay*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
        if (msg == WM_NCCREATE) {
            self = static_cast<DebugOverlay*>(reinterpret_cast<CREATESTRUCTW*>(lp)->lpCreateParams);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
        }
        if (!self) return DefWindowProcW(hwnd, msg, wp, lp);
        switch (msg) {
        case WM_NCDESTROY: self->panel_ = nullptr; self->text_ = nullptr; break;
        case WM_ERASEBKGND: { RECT r; GetClientRect(hwnd, &r); FillRect(reinterpret_cast<HDC>(wp), &r, self->brush_); return 1; }
        case WM_PAINT: {
            PAINTSTRUCT paint; HDC dc = BeginPaint(hwnd, &paint); RECT r; GetClientRect(hwnd, &r);
            FillRect(dc, &r, self->brush_); SetBkMode(dc, TRANSPARENT); SetTextColor(dc, RGB(190, 205, 225));
            SelectObject(dc, self->font_); r.left = 12; r.top = 48;
            DrawTextW(dc, L"Diagnostics | D / Esc closes | select text to pause", -1, &r, DT_SINGLELINE | DT_END_ELLIPSIS);
            EndPaint(hwnd, &paint); return 0;
        }
        case WM_SIZE: {
            const int w = LOWORD(lp), h = HIWORD(lp);
            MoveWindow(GetDlgItem(hwnd, kCopy), 12, 12, (std::min)(125, w / 3), 28, TRUE);
            MoveWindow(GetDlgItem(hwnd, kFreeze), (std::min)(145, w / 3 + 18), 12, (std::min)(90, w / 4), 28, TRUE);
            MoveWindow(GetDlgItem(hwnd, kClose), (std::max)(1, w - 78), 12, 66, 28, TRUE);
            MoveWindow(self->text_, 12, 74, (std::max)(1, w - 24), (std::max)(1, h - 86), TRUE); return 0;
        }
        case WM_TIMER: self->advance(GetTickCount()); return 0;
        case WM_KEYDOWN: if (self->key(wp, lp)) return 0; break;
        case WM_ACTIVATE: if (LOWORD(wp) == WA_INACTIVE && self->open_) self->setOpen(false, false); break;
        case WM_CLOSE: self->setOpen(false); return 0;
        case WM_COMMAND:
            if (LOWORD(wp) == kClose) self->setOpen(false);
            if (LOWORD(wp) == kCopy) self->copy();
            if (LOWORD(wp) == kFreeze) {
                self->frozen_ = !self->frozen_;
                SetDlgItemTextW(hwnd, kFreeze, self->frozen_ ? L"Resume" : L"Freeze");
                if (!self->frozen_) self->refresh(false);
            }
            return 0;
        }
        return DefWindowProcW(hwnd, msg, wp, lp);
    }
};
}
