// d2d_renderer.cpp - Direct2D/WIC/DirectWrite implementation. See header.
#include "d2d_renderer.h"
#include "d2d_rolldigits.h" // rolling countdown overlay

#include <d2d1.h>
#include <d2d1helper.h>
#include <wincodec.h>
#include <dwrite.h>
#include <string>

#pragma comment(lib, "d2d1.lib")
#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "dwrite.lib")
#pragma comment(lib, "ole32.lib")

namespace d2d {
namespace {

template <class T> void SafeRelease(T*& p) { if (p) { p->Release(); p = nullptr; } }

// Factories (device-independent, created once).
ID2D1Factory*        g_factory = nullptr;
IWICImagingFactory*  g_wic = nullptr;
IDWriteFactory*      g_dwrite = nullptr;
bool                 g_comInited = false;

// Per-window device-dependent resources (recreated on device loss).
ID2D1HwndRenderTarget* g_rt = nullptr;
ID2D1SolidColorBrush*  g_bgBrush = nullptr;
ID2D1SolidColorBrush*  g_fgBrush = nullptr;

// Cover state: raw JPEG bytes (device-independent) + their decoded D2D bitmaps
// (device-dependent; recreated lazily from the bytes after device loss).
std::string     g_curBytes, g_prevBytes;
ID2D1Bitmap*    g_curBmp = nullptr;
ID2D1Bitmap*    g_prevBmp = nullptr;

// A legible tint derived from the current cover's average colour, used for the
// countdown text so it reads as part of the artwork.
D2D1_COLOR_F    g_curTint = D2D1::ColorF(1, 1, 1, 1);

void discardDeviceResources() {
    SafeRelease(g_curBmp);
    SafeRelease(g_prevBmp);
    SafeRelease(g_bgBrush);
    SafeRelease(g_fgBrush);
    SafeRelease(g_rt);
}

// The cover's average colour, brightened + slightly desaturated so it stays
// legible as text on the dark badge while still clearly matching the artwork.
D2D1_COLOR_F overlayTintFrom(IWICBitmapSource* src) {
    D2D1_COLOR_F white = D2D1::ColorF(1, 1, 1, 1);
    if (!g_wic || !src) return white;
    // Scale to 1x1 (Fant = area average) and read that single pixel.
    IWICBitmapScaler* scaler = nullptr;
    if (FAILED(g_wic->CreateBitmapScaler(&scaler)))
        return white;
    BYTE px[4] = {0};
    D2D1_COLOR_F out = white;
    if (SUCCEEDED(scaler->Initialize(src, 1, 1, WICBitmapInterpolationModeFant))) {
        WICRect r = {0, 0, 1, 1};
        if (SUCCEEDED(scaler->CopyPixels(&r, 4, 4, px))) {
            // PBGRA; JPEGs are opaque (a=255) so this is straight BGRA.
            float b = px[0] / 255.0f, g = px[1] / 255.0f, r2 = px[2] / 255.0f;
            const float m = r2 > g ? (r2 > b ? r2 : b) : (g > b ? g : b);
            if (m < 0.02f) {
                out = white; // near-black cover -> white text
            } else {
                const float s = 1.0f / m;      // push brightest channel to 1 (keep hue)
                r2 *= s; g *= s; b *= s;
                const float k = 0.35f;         // blend toward white for readability
                out = D2D1::ColorF(r2 + (1 - r2) * k, g + (1 - g) * k, b + (1 - b) * k, 1);
            }
        }
    }
    SafeRelease(scaler);
    return out;
}

// Decodes JPEG bytes into a D2D bitmap tied to the current render target. When
// isCurrent, also refreshes g_curTint from the decoded pixels.
ID2D1Bitmap* createBitmap(const std::string& bytes, bool isCurrent) {
    if (!g_rt || !g_wic || bytes.empty())
        return nullptr;
    IWICStream* stream = nullptr;
    IWICBitmapDecoder* decoder = nullptr;
    IWICBitmapFrameDecode* frame = nullptr;
    IWICFormatConverter* conv = nullptr;
    ID2D1Bitmap* bmp = nullptr;

    if (SUCCEEDED(g_wic->CreateStream(&stream)) &&
        SUCCEEDED(stream->InitializeFromMemory((BYTE*)bytes.data(), (DWORD)bytes.size())) &&
        SUCCEEDED(g_wic->CreateDecoderFromStream(stream, nullptr, WICDecodeMetadataCacheOnLoad, &decoder)) &&
        SUCCEEDED(decoder->GetFrame(0, &frame)) &&
        SUCCEEDED(g_wic->CreateFormatConverter(&conv)) &&
        SUCCEEDED(conv->Initialize(frame, GUID_WICPixelFormat32bppPBGRA,
                                   WICBitmapDitherTypeNone, nullptr, 0.0, WICBitmapPaletteTypeMedianCut))) {
        g_rt->CreateBitmapFromWicBitmap(conv, nullptr, &bmp);
        if (isCurrent)
            g_curTint = overlayTintFrom(conv);
    }
    SafeRelease(conv);
    SafeRelease(frame);
    SafeRelease(decoder);
    SafeRelease(stream);
    return bmp;
}

// Small status badge, bottom-right (e.g. "Loading cover...").
void drawStatus(const wchar_t* text, float cw, float ch) {
    if (!text || !*text || !g_dwrite || !g_bgBrush || !g_fgBrush) return;
    float fontSize = ch / 26.0f;
    if (fontSize < 11.0f) fontSize = 11.0f;
    IDWriteTextFormat* fmt = nullptr;
    if (FAILED(g_dwrite->CreateTextFormat(L"Segoe UI", nullptr, DWRITE_FONT_WEIGHT_NORMAL,
                                          DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL,
                                          fontSize, L"", &fmt)))
        return;
    IDWriteTextLayout* layout = nullptr;
    if (SUCCEEDED(g_dwrite->CreateTextLayout(text, (UINT32)lstrlenW(text), fmt, 10000, 10000, &layout))) {
        DWRITE_TEXT_METRICS m = {}; layout->GetMetrics(&m);
        const float padX = fontSize * 0.5f, padY = fontSize * 0.25f;
        const float boxW = m.width + padX * 2, boxH = m.height + padY * 2;
        const float margin = fontSize * 0.4f;
        const float boxX = cw - boxW - margin;
        const float boxY = ch - boxH - margin; // bottom-right
        g_rt->FillRectangle(D2D1::RectF(boxX, boxY, boxX + boxW, boxY + boxH), g_bgBrush);
        g_rt->DrawTextLayout(D2D1::Point2F(boxX + padX, boxY + padY), layout, g_fgBrush);
        SafeRelease(layout);
    }
    SafeRelease(fmt);
}

} // namespace

bool init() {
    if (g_factory)
        return true; // already initialised
    HRESULT hrCom = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    g_comInited = (hrCom == S_OK || hrCom == S_FALSE); // RPC_E_CHANGED_MODE = already up, don't balance

    if (FAILED(D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, &g_factory)))
        g_factory = nullptr;
    if (g_factory)
        CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&g_wic));
    if (g_wic)
        DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory),
                            reinterpret_cast<IUnknown**>(&g_dwrite));

    if (!(g_factory && g_wic && g_dwrite)) {
        shutdown();
        return false;
    }
    return true;
}

void resetTarget() {
    // Keep g_curBytes/g_prevBytes (device-independent); drop only the target +
    // bitmaps so render() rebuilds them for the current HWND and re-decodes.
    discardDeviceResources();
}

void shutdown() {
    shutdownRollingTime();
    discardDeviceResources();
    g_curBytes.clear();
    g_prevBytes.clear();
    SafeRelease(g_dwrite);
    SafeRelease(g_wic);
    SafeRelease(g_factory);
    if (g_comInited) { CoUninitialize(); g_comInited = false; }
}

void setCover(const void* data, size_t len, bool fadeFromCurrent) {
    if (fadeFromCurrent && !g_curBytes.empty()) {
        g_prevBytes = g_curBytes;
        SafeRelease(g_prevBmp);
    } else {
        g_prevBytes.clear();
        SafeRelease(g_prevBmp);
    }
    g_curBytes.assign(static_cast<const char*>(data), len);
    SafeRelease(g_curBmp); // recreated from bytes on next render
}

void endFade() {
    g_prevBytes.clear();
    SafeRelease(g_prevBmp);
}

bool render(HWND hwnd, float progress, Transition transition, int remainingSeconds,
            float overlayFontFrac, bool rollDigits, const wchar_t* statusText) {
    if (!g_factory)
        return false;

    RECT rc;
    GetClientRect(hwnd, &rc);
    const UINT cw = rc.right > 0 ? (UINT)rc.right : 1;
    const UINT ch = rc.bottom > 0 ? (UINT)rc.bottom : 1;

    if (!g_rt) {
        if (FAILED(g_factory->CreateHwndRenderTarget(
                D2D1::RenderTargetProperties(),
                D2D1::HwndRenderTargetProperties(hwnd, D2D1::SizeU(cw, ch)), &g_rt)))
            return false;
        g_rt->CreateSolidColorBrush(D2D1::ColorF(0, 0, 0, 0.59f), &g_bgBrush); // overlay backdrop
        g_rt->CreateSolidColorBrush(D2D1::ColorF(1, 1, 1, 1), &g_fgBrush);     // overlay text
    } else {
        const D2D1_SIZE_U ps = g_rt->GetPixelSize();
        if (ps.width != cw || ps.height != ch)
            g_rt->Resize(D2D1::SizeU(cw, ch));
    }

    if (!g_curBmp && !g_curBytes.empty())   g_curBmp = createBitmap(g_curBytes, true);
    if (!g_prevBmp && !g_prevBytes.empty()) g_prevBmp = createBitmap(g_prevBytes, false);

    g_rt->BeginDraw();
    g_rt->Clear(D2D1::ColorF(D2D1::ColorF::Black));
    drawTransition(g_rt, transition, g_prevBmp, g_curBmp, (float)cw, (float)ch, progress);
    bool overlayAnimating = false;
    if (remainingSeconds >= 0) {
        if (g_fgBrush) g_fgBrush->SetColor(g_curTint); // tint the countdown to the cover
        overlayAnimating = drawRollingTime(g_rt, g_dwrite, g_bgBrush, g_fgBrush,
                                           remainingSeconds, (float)cw, (float)ch, overlayFontFrac, rollDigits);
        if (g_fgBrush) g_fgBrush->SetColor(D2D1::ColorF(1, 1, 1, 1)); // status stays white
    } else {
        resetRollingTime(); // hidden -> don't roll from a stale value when it returns
    }
    drawStatus(statusText, (float)cw, (float)ch);
    const HRESULT hr = g_rt->EndDraw();
    if (hr == D2DERR_RECREATE_TARGET)
        discardDeviceResources(); // device lost; rebuild on next render
    return overlayAnimating;
}

} // namespace d2d
