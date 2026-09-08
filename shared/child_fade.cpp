#include "child_fade.h"
#include <commctrl.h>
#include <memory>
#include <initializer_list>

#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "msimg32.lib")

namespace childfade {
namespace {
const wchar_t kSurface[] = L"24seven.fm.childFade";
const UINT_PTR kTimer = 1;
const DWORD kDuration = 150;

struct Bitmap {
    HDC dc = nullptr;
    HBITMAP bitmap = nullptr;
    HGDIOBJ previous = nullptr;
    int width = 0, height = 0;
    ~Bitmap() {
        if (previous) SelectObject(dc, previous);
        if (bitmap) DeleteObject(bitmap);
        if (dc) DeleteDC(dc);
    }
    bool init(HWND window, int w, int h) {
        if (w <= 0 || h <= 0 || static_cast<unsigned long long>(w) * h > 16000000) return false;
        HDC screen = GetDC(window);
        if (!screen) return false;
        dc = CreateCompatibleDC(screen);
        bitmap = CreateCompatibleBitmap(screen, w, h);
        ReleaseDC(window, screen);
        if (!dc || !bitmap) return false;
        previous = SelectObject(dc, bitmap);
        if (!previous || previous == HGDI_ERROR) { previous = nullptr; return false; }
        width = w; height = h;
        RECT bounds = {0, 0, w, h};
        FillRect(dc, &bounds, GetSysColorBrush(COLOR_3DFACE));
        return true;
    }
    void capture(HWND window) {
        if (window)
            SendMessageW(window, WM_PRINT, reinterpret_cast<WPARAM>(dc),
                         PRF_CLIENT | PRF_NONCLIENT | PRF_ERASEBKGND | PRF_CHILDREN);
    }
};

struct Fade {
    Bitmap from, to, frame;
    HWND parent = nullptr;
    DWORD start = 0;
    bool ready = false;
    bool paint(HDC target) {
        const DWORD elapsed = ready ? GetTickCount() - start : 0;
        const BYTE alpha = elapsed >= kDuration ? 255 : static_cast<BYTE>(elapsed * 255 / kDuration);
        const int w = frame.width, h = frame.height;
        BLENDFUNCTION blend = {AC_SRC_OVER, 0, alpha, 0};
        return BitBlt(frame.dc, 0, 0, w, h, from.dc, 0, 0, SRCCOPY)
            && AlphaBlend(frame.dc, 0, 0, w, h, to.dc, 0, 0, w, h, blend)
            && BitBlt(target, 0, 0, w, h, frame.dc, 0, 0, SRCCOPY);
    }
};

bool animationsEnabled() {
    BOOL enabled = TRUE;
    return !SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &enabled, 0) || enabled;
}

LRESULT CALLBACK surfaceProc(HWND window, UINT msg, WPARAM wp, LPARAM lp,
                             UINT_PTR id, DWORD_PTR data) {
    Fade* fade = reinterpret_cast<Fade*>(data);
    switch (msg) {
    case WM_ERASEBKGND: return TRUE;
    case WM_PRINT:
    case WM_PRINTCLIENT:
        fade->paint(reinterpret_cast<HDC>(wp));
        return 0;
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(window, &ps);
        const bool ok = fade->paint(dc);
        EndPaint(window, &ps);
        if (!ok) DestroyWindow(window); // the real, visible page is underneath
        return 0;
    }
    case WM_TIMER:
        if (wp == kTimer) {
            if (GetTickCount() - fade->start >= kDuration || !animationsEnabled())
                DestroyWindow(window);
            else InvalidateRect(window, nullptr, FALSE);
            return 0;
        }
        break;
    case WM_NCDESTROY:
        KillTimer(window, kTimer);
        if (GetPropW(fade->parent, kSurface) == window) RemovePropW(fade->parent, kSurface);
        RemoveWindowSubclass(window, surfaceProc, id);
        delete fade;
        break;
    }
    return DefSubclassProc(window, msg, wp, lp);
}
} // namespace

bool replace(HWND outgoing, HWND incoming, bool animate, const std::function<void()>& update) {
    const HWND parent = GetParent(incoming);
    HWND previous = parent ? reinterpret_cast<HWND>(GetPropW(parent, kSurface)) : nullptr;
    RECT rect = {}, oldRect = {};
    GetWindowRect(incoming, &rect);
    GetWindowRect(outgoing, &oldRect);
    const int width = rect.right - rect.left, height = rect.bottom - rect.top;
    const bool sameBounds = !outgoing || EqualRect(&rect, &oldRect);
    HWND surface = nullptr;
    Fade* state = nullptr;
    if (animate && animationsEnabled() && parent && IsWindowVisible(parent)
            && (GetWindowLongPtrW(incoming, GWL_STYLE) & WS_CHILD)
            && (!outgoing || GetParent(outgoing) == parent) && sameBounds) {
        std::unique_ptr<Fade> fade(new Fade());
        fade->parent = parent;
        if (fade->from.init(parent, width, height) && fade->to.init(parent, width, height)
                && fade->frame.init(parent, width, height)) {
            // Rapid selections start at the currently blended pixels. Capturing
            // a password edit includes only its masked rendering, not its text.
            fade->from.capture(previous ? previous : IsWindowVisible(outgoing) ? outgoing : nullptr);
            MapWindowPoints(HWND_DESKTOP, parent, reinterpret_cast<POINT*>(&rect), 2);
            surface = CreateWindowExW(0, L"STATIC", L"", WS_CHILD | WS_CLIPSIBLINGS,
                rect.left, rect.top, width, height, parent, nullptr, nullptr, nullptr);
            if (surface && !SetWindowSubclass(surface, surfaceProc, 1, reinterpret_cast<DWORD_PTR>(fade.get()))) {
                DestroyWindow(surface);
                surface = nullptr;
            }
            if (surface) state = fade.release(); // owned by WM_NCDESTROY from here
        }
    }
    if (surface) {
        // Sibling clipping must be enabled on the REAL pages too: an edit/control
        // repaint underneath must not draw through the snapshot surface.
        for (HWND page : {outgoing, incoming})
            if (page) SetWindowLongPtrW(page, GWL_STYLE,
                GetWindowLongPtrW(page, GWL_STYLE) | WS_CLIPSIBLINGS);
        SetWindowPos(surface, HWND_TOP, 0, 0, 0, 0,
                     SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        UpdateWindow(surface); // outgoing snapshot covers the synchronous update
        if (!IsWindow(surface)) surface = nullptr;
    }
    if (previous) DestroyWindow(previous);
    if (outgoing && outgoing != incoming) ShowWindow(outgoing, SW_HIDE);
    if (update) update();
    if (incoming) ShowWindow(incoming, SW_SHOWNA); // unconditional functional fallback
    if (!surface) return false;
    state->to.capture(incoming);
    state->start = GetTickCount();
    state->ready = true;
    SetWindowPos(surface, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    if (!SetPropW(parent, kSurface, surface) || !SetTimer(surface, kTimer, 15, nullptr)) {
        DestroyWindow(surface);
        return false;
    }
    return true;
}
} // namespace childfade
