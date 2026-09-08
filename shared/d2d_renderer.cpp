// d2d_renderer.cpp - Direct2D/WIC/DirectWrite implementation. See header.
#include "d2d_renderer.h"
#include "d2d_rolldigits.h" // rolling countdown overlay
#include "image_limits.h"   // coverDimsOk - reject decompression-bomb covers
#include "media_policy.h"   // DPI-aware rating geometry shared with tests
#include "rating_assets.h"  // compiled-in PNG logos; no native SVG/network dependency

#include <d2d1.h>
#include <d2d1_1.h>       // ID2D1Device/DeviceContext + effects (real Gaussian blur)
#include <d2d1_1helper.h> // D2D1::BitmapProperties1
#include <d2d1effects.h>  // CLSID_D2D1GaussianBlur
#include <d2d1helper.h>
#include <d3d11.h>        // D3D11CreateDevice for the offscreen blur device
#include <dxgi1_2.h>
#include <wincodec.h>
#include <dwrite.h>
#include <string>
#include <vector>

#pragma comment(lib, "d2d1.lib")
#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "dwrite.lib")
#pragma comment(lib, "ole32.lib")

namespace d2d {
namespace {

template <class T> void SafeRelease(T*& p) { if (p) { p->Release(); p = nullptr; } }

// CLSID_D2D1GaussianBlur - defined inline; the header's symbol isn't exported by any
// linked lib (would LNK2001), and d2d1effects.h is still needed for the prop enums.
static const GUID kGaussianBlurCLSID =
    { 0x1feb6d69, 0x2fe6, 0x4ac9, { 0x8c, 0x58, 0x1d, 0x7f, 0x93, 0xe7, 0xa6, 0xa5 } };

// Factories (device-independent, created once). Factory1 so we can spin up an
// ID2D1Device for the offscreen Gaussian-blur generator below.
ID2D1Factory1*       g_factory = nullptr;
IWICImagingFactory*  g_wic = nullptr;
IDWriteFactory*      g_dwrite = nullptr;
bool                 g_comInited = false;

// Offscreen blur generator: a self-contained D2D 1.1 device that renders the cover
// through the real Gaussian-blur effect, reads the result back, and hands it to the
// main HwndRenderTarget as a plain bitmap (g_blurBmp). Kept separate so the proven
// 1.0 render path (fill mode + the plugins' embedded windows) is untouched.
ID3D11Device*        g_blurD3D = nullptr;
ID2D1Device*         g_blurDevice = nullptr;
ID2D1DeviceContext*  g_blurCtx = nullptr;
ID2D1Effect*         g_blurEffect = nullptr;
int                  g_posterBlur = 24; // Gaussian stddev at the blur working res (INI "posterBlur")
int                  g_coverRadius = 45; // poster cover corner radius, per mille of its side (INI "borderRadius")

// Per-window device-dependent resources (recreated on device loss).
ID2D1HwndRenderTarget* g_rt = nullptr;
ID2D1SolidColorBrush*  g_bgBrush = nullptr;
ID2D1SolidColorBrush*  g_fgBrush = nullptr;
ID2D1SolidColorBrush*  g_boxBrush = nullptr;   // translucent poster info-box backdrop
ID2D1SolidColorBrush*  g_scrimBrush = nullptr; // subtle darken over the blurred poster background
ID2D1Layer*            g_layer = nullptr;      // reused for the poster cover's rounded-corner clip

// Cover state: raw JPEG bytes (device-independent) + their decoded D2D bitmaps
// (device-dependent; recreated lazily from the bytes after device loss).
std::string     g_curBytes, g_prevBytes;
ID2D1Bitmap*    g_curBmp = nullptr;
ID2D1Bitmap*    g_prevBmp = nullptr;
ID2D1Bitmap*    g_blurBmp = nullptr; // tiny downscaled current cover, upscaled as the poster background

// Media artwork never replaces the square cover state: foobar's album-art
// fallback must continue to receive g_curBytes, and a failed hero can fade away
// independently. Ratings use the same double-buffered visibility transaction.
std::string     g_backdropCurBytes, g_backdropPrevBytes;
ID2D1Bitmap*    g_backdropCurBmp = nullptr;
ID2D1Bitmap*    g_backdropPrevBmp = nullptr;
D2D1_COLOR_F    g_backdropCurTint = D2D1::ColorF(1, 1, 1, 1);
D2D1_COLOR_F    g_backdropPrevTint = D2D1::ColorF(1, 1, 1, 1);
bool            g_backdropCurHasTint = false;
bool            g_backdropPrevHasTint = false;
std::vector<RatingBadge> g_ratingsCur, g_ratingsPrev;
struct RatingBitmap { std::wstring key; ID2D1Bitmap* bitmap = nullptr; };
std::vector<RatingBitmap> g_ratingBitmaps;

// A legible tint derived from the current cover's average colour, used for the poster
// info box's title/artist and the countdown text so they read as part of the artwork.
D2D1_COLOR_F    g_curTint = D2D1::ColorF(1, 1, 1, 1);

void discardDeviceResources() {
    SafeRelease(g_curBmp);
    SafeRelease(g_prevBmp);
    SafeRelease(g_blurBmp);
    SafeRelease(g_backdropCurBmp);
    SafeRelease(g_backdropPrevBmp);
    for (size_t i = 0; i < g_ratingBitmaps.size(); ++i) SafeRelease(g_ratingBitmaps[i].bitmap);
    g_ratingBitmaps.clear();
    SafeRelease(g_bgBrush);
    SafeRelease(g_fgBrush);
    SafeRelease(g_boxBrush);
    SafeRelease(g_scrimBrush);
    SafeRelease(g_layer);
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

D2D1_COLOR_F playerTint(float mediaProgress) {
    if (mediaProgress < 0.0f) mediaProgress = 0.0f;
    if (mediaProgress > 1.0f) mediaProgress = 1.0f;
    const D2D1_COLOR_F from = g_backdropPrevHasTint ? g_backdropPrevTint : g_curTint;
    const D2D1_COLOR_F to = g_backdropCurHasTint ? g_backdropCurTint : g_curTint;
    return D2D1::ColorF(from.r + (to.r - from.r) * mediaProgress,
                        from.g + (to.g - from.g) * mediaProgress,
                        from.b + (to.b - from.b) * mediaProgress, 1.0f);
}

// Decodes JPEG bytes into a D2D bitmap tied to `rt`. If tintOut is non-null, also
// writes the cover's average-colour tint there.
ID2D1Bitmap* decodeBitmap(ID2D1RenderTarget* rt, const std::string& bytes, D2D1_COLOR_F* tintOut) {
    if (!rt || !g_wic || bytes.empty())
        return nullptr;
    IWICStream* stream = nullptr;
    IWICBitmapDecoder* decoder = nullptr;
    IWICBitmapFrameDecode* frame = nullptr;
    IWICFormatConverter* conv = nullptr;
    ID2D1Bitmap* bmp = nullptr;

    // GetSize reports the frame's declared dimensions from the header WITHOUT
    // decoding pixels, so gating on it here rejects a decompression-bomb cover
    // (untrusted input) before the format converter or the D2D bitmap ever pull
    // the pixels through. See image_limits.h.
    UINT fw = 0, fh = 0;
    if (SUCCEEDED(g_wic->CreateStream(&stream)) &&
        SUCCEEDED(stream->InitializeFromMemory((BYTE*)bytes.data(), (DWORD)bytes.size())) &&
        SUCCEEDED(g_wic->CreateDecoderFromStream(stream, nullptr, WICDecodeMetadataCacheOnLoad, &decoder)) &&
        SUCCEEDED(decoder->GetFrame(0, &frame)) &&
        SUCCEEDED(frame->GetSize(&fw, &fh)) && ssc::coverDimsOk(fw, fh) &&
        SUCCEEDED(g_wic->CreateFormatConverter(&conv)) &&
        SUCCEEDED(conv->Initialize(frame, GUID_WICPixelFormat32bppPBGRA,
                                   WICBitmapDitherTypeNone, nullptr, 0.0, WICBitmapPaletteTypeMedianCut))) {
        // Only tint once the bitmap actually decoded - a failed CreateBitmap must
        // not leave the full-res image being dragged through overlayTintFrom.
        if (SUCCEEDED(rt->CreateBitmapFromWicBitmap(conv, nullptr, &bmp)) && bmp && tintOut)
            *tintOut = overlayTintFrom(conv);
    }
    SafeRelease(conv);
    SafeRelease(frame);
    SafeRelease(decoder);
    SafeRelease(stream);
    return bmp;
}

// Decodes into the main render target; refreshes g_curTint when isCurrent.
ID2D1Bitmap* createBitmap(const std::string& bytes, bool isCurrent) {
    return decodeBitmap(g_rt, bytes, isCurrent ? &g_curTint : nullptr);
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

// --- poster layout ----------------------------------------------------------

// A centered Segoe UI text format. Caller releases.
IDWriteTextFormat* makeFormat(float size, DWRITE_FONT_WEIGHT weight, bool center) {
    IDWriteTextFormat* fmt = nullptr;
    if (SUCCEEDED(g_dwrite->CreateTextFormat(L"Segoe UI", nullptr, weight, DWRITE_FONT_STYLE_NORMAL,
                                             DWRITE_FONT_STRETCH_NORMAL, size, L"", &fmt)) &&
        center) {
        fmt->SetTextAlignment(DWRITE_TEXT_ALIGNMENT_CENTER);
    }
    return fmt;
}

// Lazily create the offscreen D2D 1.1 device + Gaussian-blur effect (hardware, WARP
// fallback). Independent of the main HwndRenderTarget's device.
bool createBlurGen() {
    if (g_blurEffect) return true; // fully built (the effect is the last resource created)
    // Release any partial state from a prior failed attempt so this retry starts clean
    // (otherwise the D3D/D2D device pointers below would be overwritten and leaked).
    SafeRelease(g_blurCtx);
    SafeRelease(g_blurDevice);
    SafeRelease(g_blurD3D);
    UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags,
                                   nullptr, 0, D3D11_SDK_VERSION, &g_blurD3D, nullptr, nullptr);
    if (FAILED(hr))
        hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, flags,
                               nullptr, 0, D3D11_SDK_VERSION, &g_blurD3D, nullptr, nullptr);
    if (FAILED(hr)) return false;
    IDXGIDevice* dxgi = nullptr;
    if (FAILED(g_blurD3D->QueryInterface(IID_PPV_ARGS(&dxgi)))) return false;
    hr = g_factory->CreateDevice(dxgi, &g_blurDevice);
    SafeRelease(dxgi);
    if (FAILED(hr)) return false;
    if (FAILED(g_blurDevice->CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE, &g_blurCtx)))
        return false;
    if (FAILED(g_blurCtx->CreateEffect(kGaussianBlurCLSID, &g_blurEffect)))
        return false;
    return true;
}

// Renders the current cover through the real Gaussian-blur effect at a small working
// resolution, reads it back, and uploads it to the main render target as g_blurBmp
// (cached until the cover changes).
void generateBlur() {
    if (g_blurBmp || g_curBytes.empty() || !g_rt || !createBlurGen()) return;
    ID2D1Bitmap* src = decodeBitmap(g_blurCtx, g_curBytes, nullptr);
    if (!src) return;
    const D2D1_SIZE_F ss = src->GetSize();
    const UINT S = 240; // blur working resolution (square)

    ID2D1Bitmap1* target = nullptr;
    D2D1_BITMAP_PROPERTIES1 tp = D2D1::BitmapProperties1(
        D2D1_BITMAP_OPTIONS_TARGET,
        D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_PREMULTIPLIED));
    if (SUCCEEDED(g_blurCtx->CreateBitmap(D2D1::SizeU(S, S), nullptr, 0, tp, &target))) {
        float dev = (float)g_posterBlur; // configurable via the INI "posterBlur"
        if (dev < 0.0f) dev = 0.0f; else if (dev > 200.0f) dev = 200.0f;
        g_blurEffect->SetInput(0, src);
        g_blurEffect->SetValue(D2D1_GAUSSIANBLUR_PROP_STANDARD_DEVIATION, (FLOAT)dev);
        g_blurEffect->SetValue(D2D1_GAUSSIANBLUR_PROP_BORDER_MODE, D2D1_BORDER_MODE_HARD);
        g_blurCtx->SetTarget(target);
        g_blurCtx->BeginDraw();
        g_blurCtx->Clear(D2D1::ColorF(D2D1::ColorF::Black));
        if (ss.width > 0 && ss.height > 0)
            g_blurCtx->SetTransform(D2D1::Matrix3x2F::Scale(S / ss.width, S / ss.height));
        g_blurCtx->DrawImage(g_blurEffect, D2D1_INTERPOLATION_MODE_LINEAR);
        g_blurCtx->SetTransform(D2D1::Matrix3x2F::Identity());
        g_blurCtx->EndDraw();
        g_blurCtx->SetTarget(nullptr);

        // Read the blurred result back to CPU, then upload it to the HwndRenderTarget.
        ID2D1Bitmap1* cpu = nullptr;
        D2D1_BITMAP_PROPERTIES1 cprops = D2D1::BitmapProperties1(
            D2D1_BITMAP_OPTIONS_CPU_READ | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
            D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_PREMULTIPLIED));
        if (SUCCEEDED(g_blurCtx->CreateBitmap(D2D1::SizeU(S, S), nullptr, 0, cprops, &cpu))) {
            D2D1_POINT_2U dst = {0, 0};
            D2D1_RECT_U srcRect = {0, 0, S, S};
            if (SUCCEEDED(cpu->CopyFromBitmap(&dst, target, &srcRect))) {
                D2D1_MAPPED_RECT mapped = {};
                if (SUCCEEDED(cpu->Map(D2D1_MAP_OPTIONS_READ, &mapped))) {
                    D2D1_BITMAP_PROPERTIES bp = D2D1::BitmapProperties(
                        D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_PREMULTIPLIED));
                    g_rt->CreateBitmap(D2D1::SizeU(S, S), mapped.bits, mapped.pitch, bp, &g_blurBmp);
                    cpu->Unmap();
                }
            }
            SafeRelease(cpu);
        }
        SafeRelease(target);
    }
    SafeRelease(src);
}

void drawBlurredBackground(float cw, float ch) {
    generateBlur();
    if (g_blurBmp) {
        const float side = cw > ch ? cw : ch; // cover-fit the square blur over the window
        const float dx = (cw - side) * 0.5f, dy = (ch - side) * 0.5f;
        g_rt->DrawBitmap(g_blurBmp, D2D1::RectF(dx, dy, dx + side, dy + side), 1.0f,
                         D2D1_BITMAP_INTERPOLATION_MODE_LINEAR);
    }
    if (g_scrimBrush) g_rt->FillRectangle(D2D1::RectF(0, 0, cw, ch), g_scrimBrush);
}

// Aspect-cover source crop. Backdrops are landscapes/portraits rather than square,
// so stretching or aspect-fit letterboxing would visibly diverge from the web stage.
void drawBackdropBitmap(ID2D1Bitmap* bmp, float cw, float ch, float opacity) {
    if (!bmp || opacity <= 0.0f) return;
    const D2D1_SIZE_F size = bmp->GetSize();
    if (size.width <= 0 || size.height <= 0) return;
    const float targetAspect = cw / ch;
    const float sourceAspect = size.width / size.height;
    D2D1_RECT_F source = D2D1::RectF(0, 0, size.width, size.height);
    if (sourceAspect > targetAspect) {
        const float wanted = size.height * targetAspect;
        source.left = (size.width - wanted) * 0.5f;
        source.right = source.left + wanted;
    } else if (sourceAspect < targetAspect) {
        const float wanted = size.width / targetAspect;
        source.top = (size.height - wanted) * 0.5f;
        source.bottom = source.top + wanted;
    }
    g_rt->DrawBitmap(bmp, D2D1::RectF(0, 0, cw, ch), opacity,
                     D2D1_BITMAP_INTERPOLATION_MODE_LINEAR, source);
}

bool drawBackdrop(float cw, float ch, float progress) {
    if (progress < 0.0f) progress = 0.0f;
    if (progress > 1.0f) progress = 1.0f;
    drawBackdropBitmap(g_backdropPrevBmp, cw, ch, 1.0f - progress);
    drawBackdropBitmap(g_backdropCurBmp, cw, ch, progress);
    return g_backdropCurBmp || g_backdropPrevBmp;
}

void drawRatingSet(const std::vector<RatingBadge>& ratings, float cw, float ch,
                   float opacity, float dpiScale) {
    if (ratings.empty() || opacity <= 0.0f || !g_dwrite || !g_fgBrush || !g_bgBrush) return;
    const float logoHeight = ssc::ratingLogoHeight(ch, dpiScale);
    const float fontSize = logoHeight / 2.35f;
    IDWriteTextFormat* fmt = makeFormat(fontSize, DWRITE_FONT_WEIGHT_SEMI_BOLD, true);
    if (!fmt) return;
    g_fgBrush->SetOpacity(opacity);
    g_bgBrush->SetOpacity(0.76f * opacity);
    const float margin = fontSize * 0.45f, padX = fontSize * 0.48f, padY = fontSize * 0.26f;
    float cursor = cw - margin;
    // Web anchors the retained DE/US strip bottom-right. Walk backwards so US
    // remains the right-most badge while DE stays to its left.
    for (size_t remaining = ratings.size(); remaining > 0; --remaining) {
        const size_t i = remaining - 1;
        const std::wstring key = ratings[i].country + L"\n" + ratings[i].system + L"\n" + ratings[i].rating;
        ID2D1Bitmap* logo = nullptr;
        for (size_t b = 0; b < g_ratingBitmaps.size(); ++b)
            if (g_ratingBitmaps[b].key == key) { logo = g_ratingBitmaps[b].bitmap; break; }
        if (!logo) {
            std::string country, system, rating;
            for (size_t c = 0; c < ratings[i].country.size(); ++c)
                country += static_cast<char>(ratings[i].country[c] & 0x7f);
            for (size_t c = 0; c < ratings[i].system.size(); ++c)
                system += static_cast<char>(ratings[i].system[c] & 0x7f);
            for (size_t c = 0; c < ratings[i].rating.size(); ++c)
                rating += static_cast<char>(ratings[i].rating[c] & 0x7f);
            const void* data = nullptr; size_t size = 0;
            if (ssc::ratingAssetPng(country, system, rating, data, size)) {
                const std::string png(static_cast<const char*>(data), size);
                logo = decodeBitmap(g_rt, png, nullptr);
                if (logo) { RatingBitmap item; item.key = key; item.bitmap = logo; g_ratingBitmaps.push_back(item); }
            }
        }
        std::wstring text = ratings[i].label.empty() ? ratings[i].rating : ratings[i].label;
        if (logo) text = ratings[i].descriptors;
        else if (!ratings[i].descriptors.empty()) text += L" " + ratings[i].descriptors;
        IDWriteTextLayout* layout = nullptr;
        DWRITE_TEXT_METRICS metrics = {};
        if (!text.empty() && SUCCEEDED(g_dwrite->CreateTextLayout(
                text.c_str(), (UINT32)text.size(), fmt, cw, ch, &layout)))
            layout->GetMetrics(&metrics);

        float logoW = 0.0f, logoH = 0.0f;
        if (logo) {
            const D2D1_SIZE_F native = logo->GetSize();
            logoH = logoHeight;
            logoW = native.height > 0 ? logoH * native.width / native.height : logoH;
        }
        const float textW = layout ? metrics.width + padX * 2.0f : 0.0f;
        const float textH = layout ? metrics.height + padY * 2.0f : 0.0f;
        const float innerGap = logo && layout ? margin * 0.7f : 0.0f;
        const float groupW = logoW + innerGap + textW;
        const float x = cursor - groupW;
        if (logo) {
            const float y = ch - logoH - margin;
            g_rt->DrawBitmap(logo, D2D1::RectF(x, y, x + logoW, y + logoH), opacity,
                             D2D1_BITMAP_INTERPOLATION_MODE_LINEAR);
        }
        if (layout) {
            const float textX = x + logoW + innerGap;
            const float y = ch - textH - margin;
            g_rt->FillRoundedRectangle(D2D1::RoundedRect(
                D2D1::RectF(textX, y, textX + textW, y + textH),
                fontSize * 0.22f, fontSize * 0.22f), g_bgBrush);
            g_rt->DrawTextLayout(D2D1::Point2F(textX + padX, y + padY), layout, g_fgBrush);
        }
        SafeRelease(layout);
        cursor = x - margin * 0.7f;
    }
    g_fgBrush->SetOpacity(1.0f);
    g_bgBrush->SetOpacity(1.0f);
    SafeRelease(fmt);
}

void drawRatings(float cw, float ch, float progress, float opacity, float dpiScale) {
    if (progress < 0.0f) progress = 0.0f;
    if (progress > 1.0f) progress = 1.0f;
    if (opacity < 0.0f) opacity = 0.0f;
    if (opacity > 1.0f) opacity = 1.0f;
    drawRatingSet(g_ratingsPrev, cw, ch, (1.0f - progress) * opacity, dpiScale);
    drawRatingSet(g_ratingsCur, cw, ch, progress * opacity, dpiScale);
}

float windowDpiScale(HWND hwnd) {
    typedef UINT (WINAPI *GetDpiForWindowFn)(HWND);
    GetDpiForWindowFn getDpiForWindow = nullptr;
    if (HMODULE user32 = GetModuleHandleA("user32.dll"))
        getDpiForWindow = reinterpret_cast<GetDpiForWindowFn>(
            GetProcAddress(user32, "GetDpiForWindow"));
    if (getDpiForWindow) {
        const UINT dpi = getDpiForWindow(hwnd);
        if (dpi) return static_cast<float>(dpi) / 96.0f;
    }
    HDC dc = GetDC(hwnd);
    const int dpi = dc ? GetDeviceCaps(dc, LOGPIXELSX) : 96;
    if (dc) ReleaseDC(hwnd, dc);
    return dpi > 0 ? static_cast<float>(dpi) / 96.0f : 1.0f;
}

// Draws the cover (with the active transition between prev/cur) aspect-fit into
// `dest`, clipped to rounded corners when cornerRadius > 0. Shared by both layouts:
// fill mode passes the whole client area (square corners); poster mode passes the
// centered cover rect (rounded).
void drawCover(const D2D1_RECT_F& dest, Transition transition, float progress, float cornerRadius) {
    bool pushed = false;
    ID2D1RoundedRectangleGeometry* geo = nullptr;
    if (cornerRadius > 0.0f && g_layer && g_factory &&
        SUCCEEDED(g_factory->CreateRoundedRectangleGeometry(
            D2D1::RoundedRect(dest, cornerRadius, cornerRadius), &geo))) {
        g_rt->PushLayer(D2D1::LayerParameters(D2D1::InfiniteRect(), geo), g_layer);
        pushed = true;
    }
    drawTransition(g_rt, transition, g_prevBmp, g_curBmp,
                   dest.left, dest.top, dest.right - dest.left, dest.bottom - dest.top, progress);
    if (pushed) g_rt->PopLayer();
    SafeRelease(geo);
}

// Poster layout: a heavily blurred background, the sharp cover, then the info box
// below it in every aspect ratio. This mirrors the web player's 72%/28% grid rather
// than the old native wide-screen side-by-side layout.
bool renderPoster(float cw, float ch, Transition transition, float progress,
                  int remainingSeconds, float overlayFontFrac, bool rollDigits,
                  const wchar_t* title, const wchar_t* artist, const wchar_t* status,
                  float mediaProgress, bool hideCoverWithBackdrop) {
    drawBlurredBackground(cw, ch); // stable fallback remains underneath the fade
    const bool mediaVisible = g_backdropCurBmp || g_backdropPrevBmp;
    if (mediaVisible) {
        drawBackdrop(cw, ch, mediaProgress);
        if (g_scrimBrush) g_rt->FillRectangle(D2D1::RectF(0, 0, cw, ch), g_scrimBrush);
    }
    if (!g_curBmp) { drawStatus(status, cw, ch); return false; } // nothing decoded yet

    const bool portrait = ch > cw;
    const float minSide = cw < ch ? cw : ch;
    const float m = minSide * 0.08f;
    float baseSide = ch * 0.58f;
    if (baseSide > cw * 0.86f) baseSide = cw * 0.86f;
    if (baseSide < 1.0f) baseSide = 1.0f;
    float coverS = baseSide;
    const float boxW = baseSide;
    const float boxX = (cw - boxW) * 0.5f;

    // Measure the info text to size the box.
    float padX = baseSide * 0.052f, padY = baseSide * 0.035f;
    if (padX < 12.0f) padX = 12.0f;
    if (padY < 8.0f) padY = 8.0f;
    const float textW = boxW - 2 * padX;
    float titleSize = baseSide * 0.072f, artistSize = baseSide * 0.058f;
    if (titleSize < 16.0f) titleSize = 16.0f;
    if (artistSize < 13.0f) artistSize = 13.0f;
    IDWriteTextFormat* tf = g_dwrite ? makeFormat(titleSize, DWRITE_FONT_WEIGHT_SEMI_BOLD, true) : nullptr;
    IDWriteTextFormat* af = g_dwrite ? makeFormat(artistSize, DWRITE_FONT_WEIGHT_NORMAL, true) : nullptr;
    IDWriteTextLayout* tl = nullptr; float titleH = 0;
    IDWriteTextLayout* al = nullptr; float artistH = 0;
    if (tf && title && *title &&
        SUCCEEDED(g_dwrite->CreateTextLayout(title, (UINT32)lstrlenW(title), tf, textW, 10000, &tl))) {
        DWRITE_TEXT_METRICS mt = {}; tl->GetMetrics(&mt); titleH = mt.height;
    }
    if (af && artist && *artist &&
        SUCCEEDED(g_dwrite->CreateTextLayout(artist, (UINT32)lstrlenW(artist), af, textW, 10000, &al))) {
        DWRITE_TEXT_METRICS ma = {}; al->GetMetrics(&ma); artistH = ma.height;
    }
    const float lineGap = artistSize * 0.35f;
    float cdFont = baseSide * overlayFontFrac;
    if (cdFont < 12.0f) cdFont = 12.0f;
    const float statusH = remainingSeconds >= 0 ? cdFont * 1.2f + 6.4f : 0.0f;
    const float boxH = padY + titleH + (artistH > 0 ? lineGap + artistH : 0)
                     + (statusH > 0 ? 6.4f + statusH : 0) + padY;

    const float bottomGap = m > 12.0f ? m : 12.0f;
    const float scaledGap = minSide * 0.016f;
    const float gap = scaledGap > 4.0f ? scaledGap : 4.0f;
    float boxY, coverY;
    if (portrait) {
        boxY = ch - bottomGap - boxH;
        const float available = boxY - gap;
        if (coverS > available) coverS = available > 1.0f ? available : 1.0f;
        coverY = (available - coverS) * 0.5f;
        if (coverY < 0.0f) coverY = 0.0f;
    } else {
        // CSS grid row centres are 36% and 86%; the small cover shift is the
        // same balancing term used by sizeStage().
        boxY = ch * 0.86f - boxH * 0.5f;
        const float coverShift = ch * 0.07f - boxH * 0.25f;
        coverY = ch * 0.36f + coverShift - coverS * 0.5f;
        if (coverY + coverS + gap > boxY) coverY = boxY - gap - coverS;
        if (coverY < 0.0f) coverY = 0.0f;
    }
    if (boxY < 0.0f) boxY = 0.0f;
    const float coverX = (cw - coverS) * 0.5f;

    // Cover (rounded), with the active transition. The radius is per mille of the cover's
    // side so it tracks the window size; 45 (4.5%) is the default look.
    if (!mediaVisible || !hideCoverWithBackdrop)
        drawCover(D2D1::RectF(coverX, coverY, coverX + coverS, coverY + coverS),
                  transition, progress, coverS * (g_coverRadius / 1000.0f));

    // Info box - same radius as the cover and always in the retained lower row.
    if (g_boxBrush) {
        const float br = coverS * (g_coverRadius / 1000.0f);
        g_rt->FillRoundedRectangle(
            D2D1::RoundedRect(D2D1::RectF(boxX, boxY, boxX + boxW, boxY + boxH), br, br), g_boxBrush);
    }
    const D2D1_COLOR_F tint = playerTint(mediaProgress);
    if (g_fgBrush) g_fgBrush->SetColor(tint); // backdrop tint, falling back to cover tint
    float ty = boxY + padY;
    if (tl) { g_rt->DrawTextLayout(D2D1::Point2F(boxX + padX, ty), tl, g_fgBrush); ty += titleH + (artistH > 0 ? lineGap : 0); }
    if (al) {
        if (g_fgBrush) g_fgBrush->SetOpacity(0.8f);
        g_rt->DrawTextLayout(D2D1::Point2F(boxX + padX, ty), al, g_fgBrush);
        if (g_fgBrush) g_fgBrush->SetOpacity(1.0f);
    }
    if (g_fgBrush) g_fgBrush->SetColor(D2D1::ColorF(1, 1, 1, 1));
    SafeRelease(tl); SafeRelease(al); SafeRelease(tf); SafeRelease(af);

    // Bottom row of the box: "Loading..." while fetching, else the live countdown -
    // the SAME rolling widget the fill overlay uses, translated into the box (no
    // re-implemented formatting).
    bool overlayAnimating = false;
    if (status && *status) {
        drawStatus(status, cw, ch); // window bottom-right, only while loading
    } else if (remainingSeconds >= 0 && g_dwrite && g_bgBrush && g_fgBrush) {
        // Same rolling widget as fill mode, centred like the web player's status row.
        g_fgBrush->SetColor(tint);
        g_fgBrush->SetOpacity(0.85f);
        g_rt->SetTransform(D2D1::Matrix3x2F::Translation(boxX, boxY));
        overlayAnimating = drawRollingTime(g_rt, g_dwrite, g_bgBrush, g_fgBrush, remainingSeconds,
                                           boxW, boxH, cdFont, rollDigits, true, false, true);
        g_rt->SetTransform(D2D1::Matrix3x2F::Identity());
        g_fgBrush->SetOpacity(1.0f);
        g_fgBrush->SetColor(D2D1::ColorF(1, 1, 1, 1));
    } else {
        resetRollingTime();
    }
    return overlayAnimating;
}

// Fill layout: the cover fills the window with the active transition, plus the
// optional countdown overlay and status badge. Returns true while the countdown's
// rolling animation is running.
bool renderCover(float cw, float ch, Transition transition, float progress,
                 int remainingSeconds, float overlayFontFrac, bool rollDigits,
                 const wchar_t* status, float mediaProgress, bool hideCoverWithBackdrop) {
    // The square cover is the stable fallback under a hero fade. It therefore
    // remains rendered until a new backdrop is actually decoded and opaque.
    drawCover(D2D1::RectF(0, 0, cw, ch), transition, progress, 0.0f);
    const bool mediaVisible = drawBackdrop(cw, ch, mediaProgress);
    if (mediaVisible && !hideCoverWithBackdrop) {
        // Keep the backdrop legible while retaining the cover: a centered square
        // whose geometry scales continuously with the current client dimensions.
        const float side = (cw < ch ? cw : ch) * 0.58f;
        const float x = (cw - side) * 0.5f, y = (ch - side) * 0.5f;
        drawCover(D2D1::RectF(x, y, x + side, y + side), transition, progress,
                  side * (g_coverRadius / 1000.0f));
    }
    bool overlayAnimating = false;
    if (remainingSeconds >= 0) {
        if (g_fgBrush) g_fgBrush->SetColor(playerTint(mediaProgress));
        overlayAnimating = drawRollingTime(g_rt, g_dwrite, g_bgBrush, g_fgBrush, remainingSeconds,
                                           cw, ch, ch * overlayFontFrac, rollDigits, false, true);
        if (g_fgBrush) g_fgBrush->SetColor(D2D1::ColorF(1, 1, 1, 1)); // status stays white
    } else {
        resetRollingTime(); // hidden -> don't roll from a stale value when it returns
    }
    drawStatus(status, cw, ch);
    return overlayAnimating;
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

void releaseBlur() {
    // Free the offscreen Gaussian-blur generator (its own D3D11 + D2D1.1 device,
    // context and effect) - the heaviest GPU resource, and only poster mode ever
    // creates it. Rebuilt lazily on the next poster render. Call when the window is
    // hidden so a dismissed cover window holds no GPU device.
    SafeRelease(g_blurEffect); // the effect is the "fully built" sentinel (createBlurGen)
    SafeRelease(g_blurCtx);
    SafeRelease(g_blurDevice);
    SafeRelease(g_blurD3D);
}

void shutdown() {
    shutdownRollingTime();
    discardDeviceResources();
    releaseBlur();
    g_curBytes.clear();
    g_prevBytes.clear();
    g_backdropCurBytes.clear();
    g_backdropPrevBytes.clear();
    g_backdropCurHasTint = g_backdropPrevHasTint = false;
    g_ratingsCur.clear();
    g_ratingsPrev.clear();
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
    SafeRelease(g_curBmp);  // recreated from bytes on next render
    SafeRelease(g_blurBmp); // poster background is derived from the current cover
}

void endFade() {
    g_prevBytes.clear();
    SafeRelease(g_prevBmp);
}

void setBackdrop(const void* data, size_t len, bool fadeFromCurrent, const int* tintRgb) {
    if (fadeFromCurrent && !g_backdropCurBytes.empty()) {
        g_backdropPrevBytes = g_backdropCurBytes;
        g_backdropPrevTint = g_backdropCurTint;
        g_backdropPrevHasTint = g_backdropCurHasTint;
        SafeRelease(g_backdropPrevBmp);
    } else {
        g_backdropPrevBytes.clear();
        g_backdropPrevHasTint = false;
        SafeRelease(g_backdropPrevBmp);
    }
    g_backdropCurBytes.assign(static_cast<const char*>(data), len);
    g_backdropCurHasTint = tintRgb != nullptr;
    if (tintRgb) g_backdropCurTint = D2D1::ColorF(
        tintRgb[0] / 255.0f, tintRgb[1] / 255.0f, tintRgb[2] / 255.0f, 1.0f);
    SafeRelease(g_backdropCurBmp);
}

void clearBackdrop(bool fadeFromCurrent) {
    if (fadeFromCurrent && !g_backdropCurBytes.empty()) {
        g_backdropPrevBytes = g_backdropCurBytes;
        g_backdropPrevTint = g_backdropCurTint;
        g_backdropPrevHasTint = g_backdropCurHasTint;
        SafeRelease(g_backdropPrevBmp);
    } else {
        g_backdropPrevBytes.clear();
        g_backdropPrevHasTint = false;
        SafeRelease(g_backdropPrevBmp);
    }
    g_backdropCurBytes.clear();
    g_backdropCurHasTint = false;
    SafeRelease(g_backdropCurBmp);
}

void setRatings(const std::vector<RatingBadge>& ratings, bool fadeFromCurrent) {
    if (fadeFromCurrent) g_ratingsPrev = g_ratingsCur;
    else g_ratingsPrev.clear();
    g_ratingsCur = ratings;
}

void endMediaFade() {
    g_backdropPrevBytes.clear();
    g_backdropPrevHasTint = false;
    SafeRelease(g_backdropPrevBmp);
    g_ratingsPrev.clear();
}

void setPosterBlur(int standardDeviation) {
    if (standardDeviation != g_posterBlur) {
        g_posterBlur = standardDeviation;
        SafeRelease(g_blurBmp); // regenerate the cached blur at the new strength
    }
}

// Nothing cached to invalidate: the radius is applied per frame when the cover is clipped.
void setCoverRadius(int perMille) { g_coverRadius = perMille; }

bool render(HWND hwnd, float progress, Transition transition, int remainingSeconds,
            float overlayFontFrac, bool rollDigits, const wchar_t* statusText,
            int layout, const wchar_t* title, const wchar_t* artist,
            float mediaProgress, bool hideCoverWithBackdrop, float ratingProgress,
            float ratingOpacity) {
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
        g_rt->CreateSolidColorBrush(D2D1::ColorF(0, 0, 0, 0.59f), &g_bgBrush);    // overlay backdrop
        g_rt->CreateSolidColorBrush(D2D1::ColorF(1, 1, 1, 1), &g_fgBrush);        // overlay text
        g_rt->CreateSolidColorBrush(D2D1::ColorF(10 / 255.0f, 12 / 255.0f, 18 / 255.0f, 0.55f), &g_boxBrush);
        g_rt->CreateSolidColorBrush(D2D1::ColorF(0, 0, 0, 0.18f), &g_scrimBrush); // poster bg scrim
        g_rt->CreateLayer(nullptr, &g_layer);                                    // poster cover rounded clip
    } else {
        const D2D1_SIZE_U ps = g_rt->GetPixelSize();
        if (ps.width != cw || ps.height != ch) {
            // A failed Resize (seen when the gen_ff frame collapses to its title bar
            // or is hidden/reshown) leaves the target stuck in an error state where
            // every later draw is dropped - the window then stays black. Rebuild it.
            if (FAILED(g_rt->Resize(D2D1::SizeU(cw, ch)))) {
                discardDeviceResources();
                return false; // recreated cleanly on the next render
            }
        }
    }

    if (!g_curBmp && !g_curBytes.empty())   g_curBmp = createBitmap(g_curBytes, true);
    if (!g_prevBmp && !g_prevBytes.empty()) g_prevBmp = createBitmap(g_prevBytes, false);
    if (!g_backdropCurBmp && !g_backdropCurBytes.empty())
        g_backdropCurBmp = createBitmap(g_backdropCurBytes, false);
    if (!g_backdropPrevBmp && !g_backdropPrevBytes.empty())
        g_backdropPrevBmp = createBitmap(g_backdropPrevBytes, false);

    g_rt->BeginDraw();
    g_rt->Clear(D2D1::ColorF(D2D1::ColorF::Black));
    bool overlayAnimating = false;
    if (layout == 1) {
        overlayAnimating = renderPoster((float)cw, (float)ch, transition, progress,
                                        remainingSeconds, overlayFontFrac, rollDigits, title, artist,
                                        statusText, mediaProgress, hideCoverWithBackdrop);
    } else {
        overlayAnimating = renderCover((float)cw, (float)ch, transition, progress,
                                       remainingSeconds, overlayFontFrac, rollDigits, statusText,
                                       mediaProgress, hideCoverWithBackdrop);
    }
    drawRatings((float)cw, (float)ch, ratingProgress, ratingOpacity,
                windowDpiScale(hwnd));
    const HRESULT hr = g_rt->EndDraw();
    // Recreate on ANY failure, not just D2DERR_RECREATE_TARGET: a target left in a
    // non-recreate error state (e.g. after a bad resize) would otherwise render
    // black forever, since EndDraw keeps returning that stuck code and we'd never
    // rebuild. Discarding here self-heals on the next render.
    if (FAILED(hr))
        discardDeviceResources();
    return overlayAnimating;
}

} // namespace d2d
