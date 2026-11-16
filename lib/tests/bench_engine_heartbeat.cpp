// End-to-end heartbeat benchmark (not a CTest case): a real window, the engine's
// own timer and a message loop, a decoded cover in poster layout and a visible
// countdown. Reports paints per second and UI-thread CPU for a settled stage.
//   engine_heartbeat_bench [seconds]
#include "../../shared/cover_engine.cpp"
#include <cstdio>
#include <cstdlib>
#include <wincodec.h>
#include <wrl/client.h>

struct CoverEngineTestAccess {
    CoverEngine engine;
    static unsigned paints;
    static CoverEngineTestAccess* self;
    static LRESULT CALLBACK proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
        switch (msg) {
        case WM_TIMER: self->engine.onTimer(hwnd, wp); return 0;
        case WM_PAINT: { PAINTSTRUCT ps; BeginPaint(hwnd, &ps); self->engine.onPaint(hwnd); EndPaint(hwnd, &ps); ++paints; return 0; }
        case SSC_WM_NEWCOVER: self->engine.onNewCover(hwnd); return 0;
        case SSC_WM_NEWMEDIA: self->engine.onNewMedia(hwnd); return 0;
        }
        return DefWindowProcW(hwnd, msg, wp, lp);
    }
    static std::string jpeg(UINT size) {
        using Microsoft::WRL::ComPtr;
        ComPtr<IWICImagingFactory> f; CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(f.GetAddressOf()));
        ComPtr<IStream> s; CreateStreamOnHGlobal(nullptr, TRUE, &s);
        ComPtr<IWICBitmapEncoder> e; f->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, &e); e->Initialize(s.Get(), WICBitmapEncoderNoCache);
        ComPtr<IWICBitmapFrameEncode> fr; e->CreateNewFrame(&fr, nullptr); fr->Initialize(nullptr); fr->SetSize(size, size);
        WICPixelFormatGUID fmt = GUID_WICPixelFormat24bppBGR; fr->SetPixelFormat(&fmt);
        std::vector<BYTE> px(size_t(size) * size * 3);
        for (size_t i = 0; i < px.size(); ++i) px[i] = BYTE((i * 7) ^ (i >> 9));
        fr->WritePixels(size, size * 3, UINT(px.size()), px.data()); fr->Commit(); e->Commit();
        STATSTG st = {}; s->Stat(&st, STATFLAG_NONAME); std::string b(size_t(st.cbSize.QuadPart), '\0');
        LARGE_INTEGER z = {}; s->Seek(z, STREAM_SEEK_SET, nullptr); ULONG r = 0; s->Read(&b[0], ULONG(b.size()), &r); return b;
    }
    static double cpuMs() {
        FILETIME c, x, k, u; GetThreadTimes(GetCurrentThread(), &c, &x, &k, &u);
        ULARGE_INTEGER a, b; a.LowPart = k.dwLowDateTime; a.HighPart = k.dwHighDateTime; b.LowPart = u.dwLowDateTime; b.HighPart = u.dwHighDateTime;
        return (a.QuadPart + b.QuadPart) / 10000.0;
    }
    int run(int seconds) {
        self = this;
        d2d::init();
        WNDCLASSW wc = {}; wc.lpfnWndProc = proc; wc.hInstance = GetModuleHandleW(nullptr); wc.lpszClassName = L"SSCHeartbeatBench";
        RegisterClassW(&wc);
        HWND hwnd = CreateWindowExW(WS_EX_NOACTIVATE, wc.lpszClassName, L"bench", WS_POPUP, 0, 0, 1280, 720,
            nullptr, nullptr, wc.hInstance, nullptr);
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        engine.settings.layout = 1; engine.settings.showRemaining = true; engine.settings.rollDigits = true;
        engine.settings.transition = 1;
        engine.setWindow(hwnd);
        { ssc::platform::LockGuard lock(engine.mutex_); engine.coverBytes_ = jpeg(1200); engine.dirty_ = true; }
        engine.decodePending(hwnd); engine.updatePresentation(hwnd);
        engine.setRemaining(300);
        const auto pump = [&](DWORD ms) {
            const DWORD end = GetTickCount() + ms; MSG msg;
            while ((LONG)(end - GetTickCount()) > 0) {
                MsgWaitForMultipleObjects(0, nullptr, FALSE, end - GetTickCount(), QS_ALLINPUT);
                while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) DispatchMessageW(&msg);
            }
        };
        pump(2500); // initial fade and entrance animations settle
        paints = 0;
        const double cpu0 = cpuMs();
        pump(DWORD(seconds) * 1000);
        const double cpu = cpuMs() - cpu0;
        std::printf("HEARTBEAT settled poster, visible countdown, %ds: %.1f paints/s, %.1f ms UI CPU/s\n",
            seconds, paints / double(seconds), cpu / seconds);
        engine.setWindow(nullptr); DestroyWindow(hwnd); d2d::shutdown();
        return 0;
    }
};
unsigned CoverEngineTestAccess::paints = 0;
CoverEngineTestAccess* CoverEngineTestAccess::self = nullptr;

int main(int argc, char** argv) {
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    CoverEngineTestAccess bench;
    return bench.run(argc > 1 ? std::atoi(argv[1]) : 5);
}
