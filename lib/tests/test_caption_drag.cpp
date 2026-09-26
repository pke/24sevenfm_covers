#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include "../../desktop/caption_drag.h"

namespace {
struct Window {
    dv::CaptionDrag drag;
    HWND value = nullptr;
    unsigned ticks = 0, paints = 0, moves = 0;
    LPARAM moveOrigin = 0;
    Window() {
        WNDCLASSW cls = {};
        cls.lpfnWndProc = proc;
        cls.lpszClassName = L"CaptionDragTest";
        cls.hInstance = GetModuleHandleW(nullptr);
        RegisterClassW(&cls);
        value = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, cls.lpszClassName, L"Caption test",
            WS_OVERLAPPEDWINDOW, -30000, -30000, 400, 400, nullptr, nullptr, cls.hInstance, this);
    }
    ~Window() { if (value) DestroyWindow(value); }
    static LRESULT CALLBACK proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
        if (msg == WM_NCCREATE) SetWindowLongPtrW(hwnd, GWLP_USERDATA,
            reinterpret_cast<LONG_PTR>(reinterpret_cast<CREATESTRUCTW*>(lp)->lpCreateParams));
        auto* self = reinterpret_cast<Window*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
        if (self) {
            if (self->drag.onMessage(hwnd, msg, wp, lp)) return 0;
            if (msg == WM_TIMER) {
                ++self->ticks;
                // Hidden test windows do not receive invalidation paints. Queue
                // one explicitly to exercise dispatch without showing a window.
                PostMessageW(hwnd, WM_PAINT, 0, 0);
                return 0;
            }
            if (msg == WM_PAINT) {
                PAINTSTRUCT paint; BeginPaint(hwnd, &paint); EndPaint(hwnd, &paint);
                ++self->paints; return 0;
            }
            // Observe the handoff without moving a real desktop window/cursor.
            if (msg == WM_SYSCOMMAND && (wp & 0xfff0) == SC_MOVE) {
                ++self->moves; self->moveOrigin = lp;
                CHECK(GetCapture() != hwnd);
                return 0;
            }
        }
        return DefWindowProcW(hwnd, msg, wp, lp);
    }
    LPARAM origin() const {
        RECT rect; GetWindowRect(value, &rect);
        return MAKELPARAM(rect.left + 100, rect.top + 10);
    }
    void press() { SendMessageW(value, WM_NCLBUTTONDOWN, HTCAPTION, origin()); }
    void move(int dx, int dy, WPARAM buttons = MK_LBUTTON) {
        POINT point = {GET_X_LPARAM(origin()) + dx, GET_Y_LPARAM(origin()) + dy};
        ScreenToClient(value, &point);
        SendMessageW(value, WM_MOUSEMOVE, buttons, MAKELPARAM(point.x, point.y));
    }
};
}

TEST_CASE("DV held caption continues timer and paint dispatch before drag begins") {
    Window window;
    REQUIRE(window.value);
    window.press();
    CHECK(GetCapture() == window.value);
    window.move(0, 0);
    SetTimer(window.value, 1, 10, nullptr);
    const DWORD start = GetTickCount();
    while (window.ticks < 3 && GetTickCount() - start < 2000) {
        MSG message;
        while (PeekMessageW(&message, window.value, 0, 0, PM_REMOVE)) DispatchMessageW(&message);
        Sleep(1);
    }
    KillTimer(window.value, 1);
    CHECK(window.ticks >= 3);
    CHECK(window.paints >= 2);
    CHECK(window.moves == 0);
    SendMessageW(window.value, WM_LBUTTONUP, 0, 0);
    CHECK(GetCapture() != window.value);
    CHECK(window.moves == 0);
}

TEST_CASE("DV caption drag hands the original signed coordinates to the Windows move loop") {
    Window window;
    REQUIRE(window.value);
    window.press();
    window.move(GetSystemMetrics(SM_CXDRAG) + 1, 0);
    CHECK(window.moves == 1);
    CHECK(window.moveOrigin == window.origin());
    window.move(30, 20);
    CHECK(window.moves == 1);
}

TEST_CASE("DV caption holds cancel cleanly without swallowing double clicks or frame buttons") {
    Window window;
    REQUIRE(window.value);
    for (UINT message : {WM_CANCELMODE, WM_KEYDOWN, WM_CAPTURECHANGED}) {
        window.press();
        if (message == WM_CAPTURECHANGED) ReleaseCapture();
        else SendMessageW(window.value, message, VK_ESCAPE, 0);
        CHECK(GetCapture() != window.value);
        window.move(30, 20);
        CHECK(window.moves == 0);
    }
    window.press();
    window.move(0, 0, 0); // missing button-up/capture cancellation
    CHECK(GetCapture() != window.value);
    window.press();
    CHECK_FALSE(window.drag.onMessage(window.value, WM_NCLBUTTONDBLCLK, HTCAPTION, window.origin()));
    CHECK(GetCapture() != window.value);
    for (int hit : {HTMINBUTTON, HTMAXBUTTON, HTCLOSE, HTLEFT, HTSYSMENU})
        CHECK_FALSE(window.drag.onMessage(window.value, WM_NCLBUTTONDOWN, hit, window.origin()));
}
