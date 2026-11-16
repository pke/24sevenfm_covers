// d2d_renderer.cpp - Direct2D/WIC/DirectWrite implementation. See header.
#include "d2d_renderer.h"
#include "d2d_rolldigits.h"  // rolling countdown overlay
#include "image_limits.h"    // coverDimsOk - reject decompression-bomb covers
#include "blur_math.h"       // blurSigmaForScaledInput - sigma parity for the pre-scaled blur
#include "text_layout_key.h" // TextLayoutKey - rebuild text layouts only on change

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
int                  g_posterBlur = 24; // Gaussian stddev at the cover's source res (INI "posterBlur");
                                        // the pre-scaled blur path scales it for visual parity (blur_math.h)
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

// The current cover decoded ONCE into system memory (device-independent). All
// consumers - the render-target bitmap, the average-colour tint, and the poster
// blur input - read from this instead of each re-decoding the JPEG (previously
// three full decodes per cover). ~1 MB for a 500px cover; also survives device
// loss, so a target rebuild needs no re-decode either.
IWICBitmap*     g_curWic = nullptr;

// Cached DirectWrite layouts (device-independent; survive device loss). Rebuilt
// only when their TextLayoutKey reports a change - a track change or a resize -
// instead of per frame (renderPoster/drawStatus used to create format + layout
// objects on every heartbeat paint).
struct CachedLayout {
    TextLayoutKey      key;
    IDWriteTextLayout* layout = nullptr;
    float              height = 0.0f;
    void release() { SafeRelease(layout); key = TextLayoutKey(); height = 0.0f; }
};
CachedLayout g_titleLayout, g_artistLayout, g_statusLayout;

// Cached rounded-corner clip geometry for the poster cover (device-independent).
// Recreated only when the cover rect or radius changes, not per frame.
ID2D1RoundedRectangleGeometry* g_coverGeo = nullptr;
D2D1_RECT_F g_coverGeoRect   = {};
float       g_coverGeoRadius = -1.0f;

// A legible tint derived from the current cover's average colour, used for the poster
// info box's title/artist and the countdown text so they read as part of the artwork.
D2D1_COLOR_F    g_curTint = D2D1::ColorF(1, 1, 1, 1);

void discardDeviceResources() {
    SafeRelease(g_curBmp);
    SafeRelease(g_prevBmp);
    SafeRelease(g_blurBmp);
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

// Decodes the cover bytes ONCE into a system-memory WIC bitmap (CacheOnLoad pulls
// the pixels through immediately), with the same decompression-bomb gate as
// decodeBitmap. Device-independent: the render target, the tint and the blur all
// read from the cached pixels instead of re-decoding the JPEG.
IWICBitmap* decodeToWicBitmap(const std::string& bytes) {
    if (!g_wic || bytes.empty())
        return nullptr;
    IWICStream* stream = nullptr;
    IWICBitmapDecoder* decoder = nullptr;
    IWICBitmapFrameDecode* frame = nullptr;
    IWICFormatConverter* conv = nullptr;
    IWICBitmap* bmp = nullptr;
    UINT fw = 0, fh = 0;
    if (SUCCEEDED(g_wic->CreateStream(&stream)) &&
        SUCCEEDED(stream->InitializeFromMemory((BYTE*)bytes.data(), (DWORD)bytes.size())) &&
        SUCCEEDED(g_wic->CreateDecoderFromStream(stream, nullptr, WICDecodeMetadataCacheOnLoad, &decoder)) &&
        SUCCEEDED(decoder->GetFrame(0, &frame)) &&
        SUCCEEDED(frame->GetSize(&fw, &fh)) && ssc::coverDimsOk(fw, fh) &&
        SUCCEEDED(g_wic->CreateFormatConverter(&conv)) &&
        SUCCEEDED(conv->Initialize(frame, GUID_WICPixelFormat32bppPBGRA,
                                   WICBitmapDitherTypeNone, nullptr, 0.0, WICBitmapPaletteTypeMedianCut))) {
        g_wic->CreateBitmapFromSource(conv, WICBitmapCacheOnLoad, &bmp);
    }
    SafeRelease(conv);
    SafeRelease(frame);
    SafeRelease(decoder);
    SafeRelease(stream);
    return bmp;
}

// Creates the render-target bitmap for a cover. The CURRENT cover goes through the
// cached WIC bitmap (one JPEG decode per cover; tint + blur reuse the same pixels);
// the outgoing cover only needs its target bitmap, so it decodes directly.
ID2D1Bitmap* createBitmap(const std::string& bytes, bool isCurrent) {
    if (!isCurrent)
        return decodeBitmap(g_rt, bytes, nullptr);
    if (!g_rt) return nullptr;
    if (!g_curWic) g_curWic = decodeToWicBitmap(bytes);
    if (!g_curWic) return nullptr;
    ID2D1Bitmap* bmp = nullptr;
    // Only tint once the bitmap actually decoded (same rule decodeBitmap applies).
    if (SUCCEEDED(g_rt->CreateBitmapFromWicBitmap(g_curWic, nullptr, &bmp)) && bmp)
        g_curTint = overlayTintFrom(g_curWic);
    return bmp;
}

IDWriteTextFormat* makeFormat(float size, DWRITE_FONT_WEIGHT weight, bool center); // defined below

// (Re)builds a cached layout when its (text, width, size) key changed; true when a
// drawable layout is available. The weight/centering are fixed per cache slot.
bool ensureLayout(CachedLayout& c, const wchar_t* text, float width, float size,
                  DWRITE_FONT_WEIGHT weight, bool center) {
    if (!g_dwrite) return false;
    if (!c.key.differs(text, width, size))
        return c.layout != nullptr;
    c.release();
    if (text && *text) {
        IDWriteTextFormat* fmt = makeFormat(size, weight, center);
        if (fmt) {
            if (SUCCEEDED(g_dwrite->CreateTextLayout(text, (UINT32)lstrlenW(text), fmt,
                                                     width, 10000.0f, &c.layout)) && c.layout) {
                DWRITE_TEXT_METRICS m = {};
                c.layout->GetMetrics(&m);
                c.height = m.height;
            }
            SafeRelease(fmt);
        }
    }
    c.key.assign(text, width, size);
    return c.layout != nullptr;
}

// Small status badge, bottom-right (e.g. "Loading cover..."). The layout is cached
// (same text + size across frames while loading); only the box math runs per frame.
void drawStatus(const wchar_t* text, float cw, float ch) {
    if (!text || !*text || !g_dwrite || !g_bgBrush || !g_fgBrush) return;
    float fontSize = ch / 26.0f;
    if (fontSize < 11.0f) fontSize = 11.0f;
    if (!ensureLayout(g_statusLayout, text, 10000.0f, fontSize, DWRITE_FONT_WEIGHT_NORMAL, false))
        return;
    DWRITE_TEXT_METRICS m = {};
    g_statusLayout.layout->GetMetrics(&m); // metrics are computed once inside the layout
    const float padX = fontSize * 0.5f, padY = fontSize * 0.25f;
    const float boxW = m.width + padX * 2, boxH = m.height + padY * 2;
    const float margin = fontSize * 0.4f;
    const float boxX = cw - boxW - margin;
    const float boxY = ch - boxH - margin; // bottom-right
    g_rt->FillRectangle(D2D1::RectF(boxX, boxY, boxX + boxW, boxY + boxH), g_bgBrush);
    g_rt->DrawTextLayout(D2D1::Point2F(boxX + padX, boxY + padY), g_statusLayout.layout, g_fgBrush);
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
// (cached until the cover changes). The cover is pre-scaled to the working res on
// the CPU (WIC Fant, from the already-decoded g_curWic) so the GPU - or WARP, i.e.
// the CPU, on machines without hardware D2D - blurs SxS pixels instead of the
// full-res cover. blurSigmaForScaledInput (unit-tested) scales the sigma by the
// same factor, which keeps the result identical to the full-res blur.
void generateBlur() {
    if (g_blurBmp || g_curBytes.empty() || !g_rt || !createBlurGen()) return;
    if (!g_curWic) g_curWic = decodeToWicBitmap(g_curBytes);
    if (!g_curWic) return;
    const UINT S = 240; // blur working resolution (square)

    UINT sw = 0, sh = 0;
    g_curWic->GetSize(&sw, &sh);
    ID2D1Bitmap* src = nullptr; // the cover pre-scaled to SxS, uploaded to the blur device
    IWICBitmapScaler* scaler = nullptr;
    if (SUCCEEDED(g_wic->CreateBitmapScaler(&scaler))) {
        if (SUCCEEDED(scaler->Initialize(g_curWic, S, S, WICBitmapInterpolationModeFant)))
            g_blurCtx->CreateBitmapFromWicBitmap(scaler, nullptr, &src);
        SafeRelease(scaler);
    }
    if (!src) return;

    ID2D1Bitmap1* target = nullptr;
    D2D1_BITMAP_PROPERTIES1 tp = D2D1::BitmapProperties1(
        D2D1_BITMAP_OPTIONS_TARGET,
        D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_PREMULTIPLIED));
    if (SUCCEEDED(g_blurCtx->CreateBitmap(D2D1::SizeU(S, S), nullptr, 0, tp, &target))) {
        // INI "posterBlur", scaled to the pre-scaled input (visual parity with the
        // old full-res blur) - the old 0..200 clamp lives inside the helper.
        const float dev = blurSigmaForScaledInput(g_posterBlur, (float)sw, S);
        g_blurEffect->SetInput(0, src);
        g_blurEffect->SetValue(D2D1_GAUSSIANBLUR_PROP_STANDARD_DEVIATION, (FLOAT)dev);
        g_blurEffect->SetValue(D2D1_GAUSSIANBLUR_PROP_BORDER_MODE, D2D1_BORDER_MODE_HARD);
        g_blurCtx->SetTarget(target);
        g_blurCtx->BeginDraw();
        g_blurCtx->Clear(D2D1::ColorF(D2D1::ColorF::Black));
        g_blurCtx->DrawImage(g_blurEffect, D2D1_INTERPOLATION_MODE_LINEAR); // input is already SxS
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

// Draws the cover (with the active transition between prev/cur) aspect-fit into
// `dest`, clipped to rounded corners when cornerRadius > 0. Shared by both layouts:
// fill mode passes the whole client area (square corners); poster mode passes the
// centered cover rect (rounded).
void drawCover(const D2D1_RECT_F& dest, Transition transition, float progress, float cornerRadius) {
    bool pushed = false;
    if (cornerRadius > 0.0f && g_layer && g_factory) {
        // The clip geometry is cached and rebuilt only when the cover rect or the
        // radius changes (a resize / settings change), not on every frame.
        if (!g_coverGeo || g_coverGeoRadius != cornerRadius ||
            g_coverGeoRect.left != dest.left || g_coverGeoRect.top != dest.top ||
            g_coverGeoRect.right != dest.right || g_coverGeoRect.bottom != dest.bottom) {
            SafeRelease(g_coverGeo);
            g_factory->CreateRoundedRectangleGeometry(
                D2D1::RoundedRect(dest, cornerRadius, cornerRadius), &g_coverGeo);
            g_coverGeoRect = dest;
            g_coverGeoRadius = cornerRadius;
        }
        if (g_coverGeo) {
            g_rt->PushLayer(D2D1::LayerParameters(D2D1::InfiniteRect(), g_coverGeo), g_layer);
            pushed = true;
        }
    }
    drawTransition(g_rt, transition, g_prevBmp, g_curBmp,
                   dest.left, dest.top, dest.right - dest.left, dest.bottom - dest.top, progress);
    if (pushed) g_rt->PopLayer();
}

// Poster layout: a heavily blurred background, the sharp cover, and a rounded info
// box (title + composer + status, tinted to the cover). Portrait stacks the cover
// above the box; when the window is wider than tall, the cover goes to the left and
// the box to the right, both vertically centered.
bool renderPoster(float cw, float ch, Transition transition, float progress,
                  int remainingSeconds, float overlayFontFrac, bool rollDigits,
                  const wchar_t* title, const wchar_t* artist, const wchar_t* status) {
    drawBlurredBackground(cw, ch);
    if (!g_curBmp) { drawStatus(status, cw, ch); return false; } // nothing decoded yet

    const bool wide = cw > ch;
    const float m = (cw < ch ? cw : ch) * 0.08f;

    // Cover square + box column/row. In portrait the box Y is finalized after the
    // text is measured (so the cover+box group can be vertically centered).
    float coverS, coverX, coverY, boxX, boxW;
    if (wide) {
        coverS = ch - 2 * m;
        const float maxCover = (cw - 2 * m) * 0.55f;
        if (coverS > maxCover) coverS = maxCover;
        if (coverS < 1) coverS = 1;
        coverX = m;
        coverY = (ch - coverS) * 0.5f;
        boxX = coverX + coverS + m * 0.8f;
        boxW = cw - m - boxX;
    } else {
        coverS = cw - 2 * m;
        if (coverS > ch * 0.52f) coverS = ch * 0.52f;
        if (coverS < 1) coverS = 1;
        coverX = (cw - coverS) * 0.5f;
        coverY = 0; // finalized below
        boxX = coverX;
        boxW = coverS;
    }
    if (boxW < coverS * 0.5f) boxW = coverS * 0.5f;

    // Measure the info text to size the box. The layouts are cached and rebuilt only
    // when the text or the cover size changes (ensureLayout), not per frame.
    const float pad = coverS * 0.06f;
    const float textW = boxW - 2 * pad;
    const float titleSize = coverS * 0.072f, artistSize = coverS * 0.058f;
    const bool haveTitle  = ensureLayout(g_titleLayout, title, textW, titleSize,
                                         DWRITE_FONT_WEIGHT_SEMI_BOLD, true);
    const bool haveArtist = ensureLayout(g_artistLayout, artist, textW, artistSize,
                                         DWRITE_FONT_WEIGHT_NORMAL, true);
    const float titleH  = haveTitle  ? g_titleLayout.height  : 0;
    const float artistH = haveArtist ? g_artistLayout.height : 0;
    const float lineGap = artistSize * 0.35f;
    const float cdFont  = ch * overlayFontFrac;                          // countdown size (the size setting)
    const float statusH = (remainingSeconds >= 0) ? cdFont * 1.35f : 0.0f; // countdown row (0 = no countdown)
    const float boxH = pad + titleH + (artistH > 0 ? lineGap + artistH : 0)
                     + (statusH > 0 ? lineGap + statusH : 0) + pad;

    float boxY;
    if (wide) {
        boxY = (ch - boxH) * 0.5f;
    } else {
        const float gap = m * 0.6f;
        coverY = (ch - (coverS + gap + boxH)) * 0.5f;
        if (coverY < m) coverY = m;
        boxY = coverY + coverS + gap;
    }

    // Cover (rounded), with the active transition. The radius is per mille of the cover's
    // side so it tracks the window size; 45 (4.5%) is the default look.
    drawCover(D2D1::RectF(coverX, coverY, coverX + coverS, coverY + coverS),
              transition, progress, coverS * (g_coverRadius / 1000.0f));

    // Info box - same radius as the cover, so the two rounded shapes sitting side by side
    // (or stacked) match. Both are relative to coverS, so the box tracks the cover exactly.
    if (g_boxBrush) {
        const float br = coverS * (g_coverRadius / 1000.0f);
        g_rt->FillRoundedRectangle(
            D2D1::RoundedRect(D2D1::RectF(boxX, boxY, boxX + boxW, boxY + boxH), br, br), g_boxBrush);
    }
    if (g_fgBrush) g_fgBrush->SetColor(g_curTint); // cover-matched text
    float ty = boxY + pad;
    if (haveTitle) {
        g_rt->DrawTextLayout(D2D1::Point2F(boxX + pad, ty), g_titleLayout.layout, g_fgBrush);
        ty += titleH + (artistH > 0 ? lineGap : 0);
    }
    if (haveArtist) g_rt->DrawTextLayout(D2D1::Point2F(boxX + pad, ty), g_artistLayout.layout, g_fgBrush);
    if (g_fgBrush) g_fgBrush->SetColor(D2D1::ColorF(1, 1, 1, 1));

    // Bottom-right of the box: "Loading..." while fetching, else the live countdown -
    // the SAME rolling widget the fill overlay uses, translated into the box (no
    // re-implemented formatting).
    bool overlayAnimating = false;
    if (status && *status) {
        drawStatus(status, cw, ch); // window bottom-right, only while loading
    } else if (remainingSeconds >= 0 && g_dwrite && g_bgBrush && g_fgBrush) {
        // Same rolling widget as fill mode, in the box's bottom-right, honouring the
        // size + rolling settings - but no background box (the info box is the backdrop).
        g_fgBrush->SetColor(g_curTint);
        g_rt->SetTransform(D2D1::Matrix3x2F::Translation(boxX, boxY));
        overlayAnimating = drawRollingTime(g_rt, g_dwrite, g_bgBrush, g_fgBrush, remainingSeconds,
                                           boxW, boxH, cdFont, rollDigits, true, false);
        g_rt->SetTransform(D2D1::Matrix3x2F::Identity());
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
                 int remainingSeconds, float overlayFontFrac, bool rollDigits, const wchar_t* status) {
    drawCover(D2D1::RectF(0, 0, cw, ch), transition, progress, 0.0f);
    bool overlayAnimating = false;
    if (remainingSeconds >= 0) {
        if (g_fgBrush) g_fgBrush->SetColor(g_curTint); // tint the countdown to the cover
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
    SafeRelease(g_curWic);
    SafeRelease(g_coverGeo);
    g_coverGeoRadius = -1.0f;
    g_titleLayout.release();
    g_artistLayout.release();
    g_statusLayout.release();
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
    SafeRelease(g_curWic);  // decoded pixels belong to the old cover
    SafeRelease(g_blurBmp); // poster background is derived from the current cover
}

void endFade() {
    g_prevBytes.clear();
    SafeRelease(g_prevBmp);
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
            int layout, const wchar_t* title, const wchar_t* artist) {
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
        g_rt->CreateSolidColorBrush(D2D1::ColorF(0, 0, 0, 0.34f), &g_boxBrush);   // poster info box
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

    g_rt->BeginDraw();
    g_rt->Clear(D2D1::ColorF(D2D1::ColorF::Black));
    bool overlayAnimating = false;
    if (layout == 1) {
        overlayAnimating = renderPoster((float)cw, (float)ch, transition, progress,
                                        remainingSeconds, overlayFontFrac, rollDigits, title, artist, statusText);
    } else {
        overlayAnimating = renderCover((float)cw, (float)ch, transition, progress,
                                       remainingSeconds, overlayFontFrac, rollDigits, statusText);
    }
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
