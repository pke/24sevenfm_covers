#pragma once
#include <windows.h>
#include <windowsx.h>

namespace dv {
// DefWindowProc's initial caption drag detection blocks painting while the
// button is held still. Detect that threshold through ordinary messages, then
// hand the actual move back to Windows (snap, drag-to-restore, Escape, etc.).
class CaptionDrag {
public:
    bool onMessage(HWND window, UINT message, WPARAM wp, LPARAM lp) {
        switch (message) {
        case WM_NCLBUTTONDOWN:
            if (wp != HTCAPTION) break;
            if (IsWindowVisible(window) && GetForegroundWindow() != window)
                SetForegroundWindow(window);
            origin_ = {GET_X_LPARAM(lp), GET_Y_LPARAM(lp)};
            pending_ = true;
            SetCapture(window);
            return true;
        case WM_MOUSEMOVE:
            if (!pending_) break;
            if (!(wp & MK_LBUTTON)) { cancel(window); return true; }
            {
                POINT point = {GET_X_LPARAM(lp), GET_Y_LPARAM(lp)};
                ClientToScreen(window, &point);
                const int dx = point.x - origin_.x, dy = point.y - origin_.y;
                if (dx <= -GetSystemMetrics(SM_CXDRAG) || dx >= GetSystemMetrics(SM_CXDRAG)
                        || dy <= -GetSystemMetrics(SM_CYDRAG) || dy >= GetSystemMetrics(SM_CYDRAG)) {
                    const LPARAM start = MAKELPARAM(origin_.x, origin_.y);
                    cancel(window);
                    SendMessageW(window, WM_SYSCOMMAND, SC_MOVE | HTCAPTION, start);
                }
            }
            return true;
        case WM_LBUTTONUP:
            if (!pending_) break;
            cancel(window);
            return true;
        case WM_KEYDOWN:
            if (!pending_ || wp != VK_ESCAPE) break;
            cancel(window);
            return true;
        case WM_CAPTURECHANGED:
            pending_ = false;
            break;
        case WM_CANCELMODE:
        case WM_NCLBUTTONDBLCLK:
        case WM_DESTROY:
            cancel(window);
            break;
        }
        return false;
    }
private:
    void cancel(HWND window) {
        if (!pending_) return;
        pending_ = false;
        if (GetCapture() == window) ReleaseCapture();
    }
    bool pending_ = false;
    POINT origin_ = {};
};
} // namespace dv
