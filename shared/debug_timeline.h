#pragma once
#include <windows.h>
#include <windowsx.h>
#include <functional>
#include "debug_report.h"
#pragma comment(lib, "msimg32.lib")

namespace ssc {
class DebugTimeline {
public:
    HWND window = nullptr;
    std::function<void(const JsonValue&)> selected;
    std::function<void()> activated;
    std::function<bool(WPARAM, LPARAM)> key;
    bool create(HWND parent, int id, HFONT font) {
        font_ = font;
        HINSTANCE module = nullptr;
        GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCWSTR>(&proc), &module);
        WNDCLASSW wc = {}; wc.lpfnWndProc = proc; wc.hInstance = module;
        wc.lpszClassName = L"24seven.fm.DebugTimeline"; wc.hCursor = LoadCursor(nullptr, IDC_HAND);
        RegisterClassW(&wc);
        window = CreateWindowExW(0, wc.lpszClassName, L"Playback timeline", WS_CHILD | WS_VISIBLE | WS_HSCROLL | WS_TABSTOP,
            0, 0, 1, 1, parent, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), module, this);
        return window != nullptr;
    }
    void setItems(const JsonValue& value, bool opening = false) {
        if (!window) return;
        std::string identity;
        for (const auto& item : value.array) identity += debugValue(item, "id").string + debugValue(item, "phase").string;
        const bool changed = identity != identity_;
        std::string anchor;
        const int anchorIndex = scroll_ / kStep, anchorOffset = scroll_ % kStep;
        if (anchorIndex >= 0 && anchorIndex < static_cast<int>(items_.size())) anchor = debugValue(items_[anchorIndex], "id").string;
        if (changed) { previous_ = items_; previousScroll_ = scroll_; started_ = GetTickCount(); }
        identity_ = identity; items_ = value.array;
        if (changed && !follow_) for (size_t i = 0; i < items_.size(); ++i)
            if (debugValue(items_[i], "id").string == anchor) scroll_ = static_cast<int>(i) * kStep + anchorOffset;
        updateScroll();
        if (opening || (follow_ && changed)) current();
        else {
            bool found = false;
            for (const auto& item : items_) if (debugValue(item, "id").string == selectedId_) { if (selected) selected(item); found = true; break; }
            if (!found) selectCurrent();
        }
        if (changed && animations()) SetTimer(window, 1, 16, nullptr);
        InvalidateRect(window, nullptr, FALSE);
    }
    void current() {
        RECT r = {}; GetClientRect(window, &r);
        for (size_t i = 0; i < items_.size(); ++i) if (debugValue(items_[i], "phase").string == "current") {
            scroll_ = static_cast<int>(i) * kStep - (r.right - kWidth) / 2;
            follow_ = true; updateScroll(); choose(i); break;
        }
    }
private:
    enum { kWidth = 188, kStep = 200 };
    HFONT font_ = nullptr;
    std::vector<JsonValue> items_, previous_;
    std::string selectedId_, identity_;
    int scroll_ = 0, previousScroll_ = 0;
    bool follow_ = true;
    DWORD started_ = 0;
    static bool animations() { BOOL enabled = TRUE; SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &enabled, 0); return enabled != FALSE; }
    static std::wstring wide(const std::string& text) {
        int n = MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0);
        std::wstring result(n, L'\0'); if (n) MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), &result[0], n);
        return result;
    }
    void selectCurrent() {
        for (size_t i = 0; i < items_.size(); ++i) if (debugValue(items_[i], "phase").string == "current") { choose(i); return; }
    }
    void choose(size_t index) {
        if (index >= items_.size()) return;
        selectedId_ = debugValue(items_[index], "id").string;
        if (selected) selected(items_[index]); InvalidateRect(window, nullptr, FALSE);
    }
    void updateScroll() {
        RECT r = {}; GetClientRect(window, &r);
        scroll_ = (std::max)(0, (std::min)(scroll_, static_cast<int>(items_.size()) * kStep - static_cast<int>(r.right)));
        SCROLLINFO info = {}; info.cbSize = sizeof(info); info.fMask = SIF_RANGE | SIF_PAGE | SIF_POS;
        info.nMax = (std::max)(0, static_cast<int>(items_.size()) * kStep - 1);
        info.nPage = (std::max)(0L, r.right); info.nPos = scroll_; SetScrollInfo(window, SB_HORZ, &info, TRUE);
    }
    void draw(HDC dc, RECT bounds, const std::vector<JsonValue>& items, int scroll) {
        HBRUSH background = CreateSolidBrush(RGB(14, 20, 30)); FillRect(dc, &bounds, background); DeleteObject(background);
        auto oldFont = SelectObject(dc, font_); SetBkMode(dc, TRANSPARENT);
        for (size_t i = 0; i < items.size(); ++i) {
            const int x = static_cast<int>(i) * kStep - scroll;
            if (x + kWidth < 0 || x > bounds.right) continue;
            const auto& item = items[i]; const auto phase = debugValue(item, "phase").string;
            const bool current = phase == "current", chosen = debugValue(item, "id").string == selectedId_;
            HBRUSH brush = CreateSolidBrush(current ? RGB(18, 51, 47) : RGB(24, 38, 56));
            HPEN pen = CreatePen(PS_SOLID, 1, chosen ? RGB(197, 224, 255) : current ? RGB(68, 154, 131) : RGB(51, 67, 86));
            auto oldBrush = SelectObject(dc, brush), oldPen = SelectObject(dc, pen);
            RoundRect(dc, x+1, 3, x+kWidth, 137, 14, 14);
            SelectObject(dc, oldBrush); SelectObject(dc, oldPen); DeleteObject(brush); DeleteObject(pen);
            auto line = [&](const std::string& text, int y, COLORREF color) {
                RECT r = { x+12, y, x+kWidth-12, y+22 }; SetTextColor(dc, color);
                const auto w = wide(text); DrawTextW(dc, w.c_str(), -1, &r, DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
            };
            line(current ? "CURRENT  /  Playing now" : phase == "past" ? "PAST  /  Observed" : "UPCOMING  /  Estimated", 12,
                current ? RGB(142,239,205) : RGB(153,171,192));
            line(debugValue(item, "album").string, 36, RGB(239,245,255));
            line(debugValue(item, "track").string, 57, RGB(185,202,221));
            const auto& seconds = debugValue(item, "relativeSeconds");
            std::string when = "Start unknown";
            if (current) when = "Now";
            else if (seconds.type == JsonValue::Number) {
                const int count = static_cast<int>(std::abs(seconds.number));
                when = (phase == "past" ? "-" : "~ +") + std::to_string(count/60) + ":" + (count%60<10 ? "0" : "") + std::to_string(count%60);
            }
            line(when, 81, RGB(172,191,216));
            const auto& cache = debugValue(item, "cache");
            std::string cached = std::string(debugValue(cache,"metadata").boolean ? "Metadata " : "")
                + (debugValue(cache,"artwork").boolean ? "Art " : "")
                + (debugValue(cache,"imageBytes").boolean ? "Image" : "");
            line("Cache: " + (cached.empty() ? "Not prepared" : cached), 106, RGB(164,202,184));
        }
        SelectObject(dc, oldFont);
    }
    void paint() {
        PAINTSTRUCT ps; HDC dc = BeginPaint(window, &ps); RECT r; GetClientRect(window, &r);
        if (r.right <= 0 || r.bottom <= 0) { EndPaint(window, &ps); return; }
        HDC buffer = CreateCompatibleDC(dc); HBITMAP bitmap = CreateCompatibleBitmap(dc, r.right, r.bottom);
        auto old = SelectObject(buffer, bitmap);
        const float progress = !animations() ? 1.f : (std::min)(1.f, (GetTickCount()-started_) / 180.f);
        if (progress < 1) {
            draw(buffer, r, previous_, previousScroll_);
            HDC incoming = CreateCompatibleDC(dc); HBITMAP next = CreateCompatibleBitmap(dc, r.right, r.bottom);
            auto before = SelectObject(incoming, next); draw(incoming, r, items_, scroll_);
            BLENDFUNCTION blend = { AC_SRC_OVER, 0, static_cast<BYTE>(255*progress), 0 };
            AlphaBlend(buffer, 0, 0, r.right, r.bottom, incoming, 0, 0, r.right, r.bottom, blend);
            SelectObject(incoming, before); DeleteObject(next); DeleteDC(incoming);
        } else draw(buffer, r, items_, scroll_);
        BitBlt(dc, 0, 0, r.right, r.bottom, buffer, 0, 0, SRCCOPY);
        SelectObject(buffer, old); DeleteObject(bitmap); DeleteDC(buffer); EndPaint(window, &ps);
    }
    static LRESULT CALLBACK proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
        auto* self = reinterpret_cast<DebugTimeline*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
        if (msg == WM_NCCREATE) { self = static_cast<DebugTimeline*>(reinterpret_cast<CREATESTRUCTW*>(lp)->lpCreateParams);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self)); }
        if (!self) return DefWindowProcW(hwnd, msg, wp, lp);
        switch (msg) {
        case WM_NCDESTROY: self->window = nullptr; break;
        case WM_ERASEBKGND: return 1;
        case WM_PAINT: self->paint(); return 0;
        case WM_SIZE: self->updateScroll(); return 0;
        case WM_TIMER:
            if (GetTickCount()-self->started_ >= 180) { KillTimer(hwnd, 1); self->previous_.clear(); }
            InvalidateRect(hwnd, nullptr, FALSE); return 0;
        case WM_LBUTTONDOWN:
            SetFocus(hwnd); self->follow_ = false;
            if (self->activated) self->activated();
            self->choose((GET_X_LPARAM(lp) + self->scroll_) / kStep); return 0;
        case WM_KEYDOWN:
            if (self->key && self->key(wp, lp)) return 0;
            if (wp == VK_TAB) { SetFocus(GetNextDlgTabItem(GetParent(hwnd), hwnd, (GetKeyState(VK_SHIFT)&0x8000)!=0)); return 0; }
            if (wp == VK_HOME || wp == VK_END || wp == VK_LEFT || wp == VK_RIGHT) {
                if (self->activated) self->activated();
                size_t index = 0;
                for (size_t i = 0; i < self->items_.size(); ++i) if (debugValue(self->items_[i],"id").string == self->selectedId_) index = i;
                if (wp == VK_HOME) index = 0;
                else if (wp == VK_END) index = self->items_.empty() ? 0 : self->items_.size()-1;
                else if (wp == VK_LEFT && index) --index;
                else if (wp == VK_RIGHT && index+1<self->items_.size()) ++index;
                self->follow_ = false; self->scroll_ = static_cast<int>(index)*kStep;
                self->updateScroll(); self->choose(index); return 0;
            } break;
        case WM_MOUSEWHEEL: case WM_MOUSEHWHEEL:
            self->follow_ = false; self->scroll_ += (msg == WM_MOUSEHWHEEL ? 1 : -1)*GET_WHEEL_DELTA_WPARAM(wp)/3;
            self->updateScroll(); InvalidateRect(hwnd, nullptr, FALSE); return 0;
        case WM_HSCROLL: {
            SCROLLINFO info = {}; info.cbSize = sizeof(info); info.fMask = SIF_ALL; GetScrollInfo(hwnd, SB_HORZ, &info);
            self->follow_ = false;
            switch (LOWORD(wp)) {
            case SB_LINELEFT: self->scroll_ -= 40; break; case SB_LINERIGHT: self->scroll_ += 40; break;
            case SB_PAGELEFT: self->scroll_ -= info.nPage; break; case SB_PAGERIGHT: self->scroll_ += info.nPage; break;
            case SB_THUMBTRACK: self->scroll_ = info.nTrackPos; break;
            }
            self->updateScroll(); InvalidateRect(hwnd, nullptr, FALSE); return 0;
        }
        }
        return DefWindowProcW(hwnd, msg, wp, lp);
    }
};
}
