// d2d_renderer.cpp - Direct2D/WIC/DirectWrite implementation. See header.
#include "d2d_renderer.h"
#include "d2d_rolldigits.h" // rolling countdown overlay
#include "image_limits.h"   // coverDimsOk - reject decompression-bomb covers
#include "image_alpha_bounds.h"
#include "media_policy.h"   // DPI-aware rating geometry shared with tests
#include "title_logo_presentation.h"
#include "presentation_style.h"

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
#include <string_view>
#include <vector>
#include <list>
#include <map>
#include <set>
#include <memory>
#include <cstring>
#ifdef SSC_RENDERER_DIAGNOSTICS
#include <chrono>
#endif

#pragma comment(lib, "d2d1.lib")
#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "dwrite.lib")
#pragma comment(lib, "ole32.lib")

namespace d2d {
namespace {

#ifdef SSC_RENDERER_DIAGNOSTICS
RendererDiagnostics g_diagnostics;
struct DiagnosticTimer {
    double& total;
    std::chrono::steady_clock::time_point start = std::chrono::steady_clock::now();
    explicit DiagnosticTimer(double& value) : total(value) {}
    ~DiagnosticTimer() {
        total += std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - start).count();
    }
};
#define SSC_TIME(name, field) DiagnosticTimer name(g_diagnostics.field)
#define SSC_COUNT(field) (++g_diagnostics.field)
#else
#define SSC_TIME(name, field) ((void)0)
#define SSC_COUNT(field) ((void)0)
#endif

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

// Cover state: encoded bytes plus target-dependent D2D bitmaps. Decoded CPU
// pixels below survive target recreation; D2D bitmaps cannot cross HWND targets.
std::string     g_curBytes, g_prevBytes;
ID2D1Bitmap*    g_curBmp = nullptr;
ID2D1Bitmap*    g_prevBmp = nullptr;
ID2D1Bitmap*    g_blurBmp = nullptr; // tiny downscaled current cover, upscaled as the poster background
ID2D1Bitmap*    g_nextBmp = nullptr;
std::shared_ptr<const std::string> g_nextBytes;

struct DecodedImage {
    std::string bytes;
    bool trimAlpha = false;
    float horizontalAnchor = .5f;
    UINT width = 0, height = 0;
    std::vector<BYTE> pixels; // tightly packed, premultiplied BGRA
    bool hasTint = false;
    D2D1_COLOR_F tint = D2D1::ColorF(1, 1, 1, 1);
    size_t cost() const { return bytes.size() + pixels.size(); }
};
// Only images actually rendered are decoded here, never the entire queue. Two
// 4K orientations plus covers/logos fit without retaining unbounded track history.
const size_t kDecodedCacheBudget = 128 * 1024 * 1024;
const size_t kDecodedCacheEntries = 16;
std::list<std::shared_ptr<DecodedImage>> g_decodedImages; // MRU first
size_t g_decodedBytes = 0;
const UINT kBlurSize = 240;
std::vector<BYTE> g_blurPixels; // current cover/strength only; independent of HWND

// Media artwork never replaces the square cover state: foobar's album-art
// fallback must continue to receive g_curBytes, and a failed hero can fade away
// independently. Ratings use the same double-buffered visibility transaction.
std::string     g_backdropCurBytes, g_backdropPrevBytes;
bool g_backdropLoading = false;
float g_backdropNavigationOpacity = 0;
ID2D1Bitmap*    g_backdropCurBmp = nullptr;
ID2D1Bitmap*    g_backdropPrevBmp = nullptr;
D2D1_COLOR_F    g_backdropCurTint = D2D1::ColorF(1, 1, 1, 1);
D2D1_COLOR_F    g_backdropPrevTint = D2D1::ColorF(1, 1, 1, 1);
bool            g_backdropCurHasTint = false;
bool            g_backdropPrevHasTint = false;
std::vector<RatingBadge> g_ratingsCur, g_ratingsPrev;
struct RatingBitmap { std::wstring key; ID2D1Bitmap* bitmap = nullptr; };
std::vector<RatingBitmap> g_ratingBitmaps;
std::map<std::string, ID2D1Bitmap*> g_frameBitmaps, g_frameBlurs;
std::map<std::string, std::vector<BYTE>> g_frameBlurPixels;
std::map<std::string, std::vector<RatingBadge>> g_ratingSets;
const ssc::FrameState* g_frame = nullptr; // borrowed only for one synchronous draw
ssc::TitleLogoPresentation g_titleLogo;
ssc::TitleLogoLayout g_titleLogoLayout;
ID2D1Bitmap* g_titleLogoBmp = nullptr;
float g_titleLogoAnchor = .5f;
std::string g_titleLogoDecodedBytes;
D2D1_RECT_F g_albumHitRect = {}, g_logoHitRect = {};
HWND g_albumHitWindow = nullptr;
bool g_albumHitVisible = false;
D2D1_RECT_F g_fanartHintHitRect = {};
HWND g_fanartHintHitWindow = nullptr;

// A legible tint derived from the current cover's average colour, used for the poster
// info box's title/artist and the countdown text so they read as part of the artwork.
D2D1_COLOR_F    g_curTint = D2D1::ColorF(1, 1, 1, 1);

void discardDeviceResources() {
    for (auto& entry : g_frameBitmaps) SafeRelease(entry.second); g_frameBitmaps.clear();
    for (auto& entry : g_frameBlurs) SafeRelease(entry.second); g_frameBlurs.clear();
    SafeRelease(g_curBmp);
    SafeRelease(g_prevBmp);
    SafeRelease(g_blurBmp);
    SafeRelease(g_nextBmp);
    SafeRelease(g_backdropCurBmp);
    SafeRelease(g_backdropPrevBmp);
    SafeRelease(g_titleLogoBmp);
    g_titleLogoDecodedBytes.clear();
    g_albumHitVisible = false;
    g_fanartHintHitRect = {};
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
            const auto tint = ssc::readableCoverTint(r2, g, b);
            out = D2D1::ColorF(tint.red, tint.green, tint.blue, 1);
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

std::shared_ptr<DecodedImage> decodedImage(const std::string& bytes, bool trimAlpha) {
    for (auto it = g_decodedImages.begin(); it != g_decodedImages.end(); ++it) {
        if ((*it)->trimAlpha == trimAlpha && (*it)->bytes == bytes) {
            auto image = *it;
            g_decodedImages.splice(g_decodedImages.begin(), g_decodedImages, it);
            SSC_COUNT(cacheHits);
            return image;
        }
    }
    SSC_COUNT(decodes);
    IWICStream* stream = nullptr;
    IWICBitmapDecoder* decoder = nullptr;
    IWICBitmapFrameDecode* frame = nullptr;
    IWICFormatConverter* conv = nullptr;
    auto image = std::make_shared<DecodedImage>();

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
        IWICBitmapScaler* scaler = nullptr;
        IWICBitmapSource* source = conv;
        const float scale = (float)ssc::kLogoScanMaximum / (fw > fh ? fw : fh);
        bool ready = true;
        // Match the web's bounded alpha scan; provider padding is not artwork.
        if (trimAlpha && scale < 1) {
            fw = static_cast<UINT>(fw * scale); fh = static_cast<UINT>(fh * scale);
            if (!fw) fw = 1; if (!fh) fh = 1;
            ready = SUCCEEDED(g_wic->CreateBitmapScaler(&scaler))
                && SUCCEEDED(scaler->Initialize(conv, fw, fh, WICBitmapInterpolationModeFant));
            if (ready) source = scaler;
        }
        if (ready) {
            image->pixels.resize(static_cast<size_t>(fw) * fh * 4);
            ready = SUCCEEDED(source->CopyPixels(nullptr, fw * 4,
                static_cast<UINT>(image->pixels.size()), image->pixels.data()));
        }
        if (ready) {
            image->width = fw; image->height = fh;
            if (trimAlpha) {
                const auto bounds = ssc::visibleAlphaBounds(image->pixels.data(), fw, fh, fw * 4);
                image->horizontalAnchor = ssc::titleLogoHorizontalAnchor(image->pixels.data(), fw, fh, fw * 4, bounds);
                const UINT left = bounds.left, top = bounds.top, right = bounds.right, bottom = bounds.bottom;
                if (right > left && bottom > top) {
                    image->width = right - left; image->height = bottom - top;
                    const UINT stride = image->width * 4;
                    std::vector<BYTE> cropped(static_cast<size_t>(stride) * image->height);
                    for (UINT y = 0; y < image->height; ++y)
                        std::memcpy(cropped.data() + static_cast<size_t>(y) * stride,
                            image->pixels.data() + (static_cast<size_t>(top + y) * fw + left) * 4,
                            stride);
                    image->pixels.swap(cropped);
                } else image->width = image->height = 0;
            }
        }
        SafeRelease(scaler);
    }
    SafeRelease(conv);
    SafeRelease(frame);
    SafeRelease(decoder);
    SafeRelease(stream);
    if (!image->width || !image->height) return nullptr;
    image->bytes = bytes;
    image->trimAlpha = trimAlpha;
    const size_t cost = image->cost();
    if (cost <= kDecodedCacheBudget) {
        while (!g_decodedImages.empty() && (g_decodedImages.size() >= kDecodedCacheEntries
                || g_decodedBytes > kDecodedCacheBudget - cost)) {
            g_decodedBytes -= g_decodedImages.back()->cost();
            g_decodedImages.pop_back();
            SSC_COUNT(cacheEvictions);
        }
        g_decodedBytes += cost;
        g_decodedImages.push_front(image);
    }
    return image;
}

D2D1_COLOR_F decodedTint(const std::shared_ptr<DecodedImage>& image) {
    if (!image->hasTint) {
        IWICBitmap* source = nullptr;
        if (SUCCEEDED(g_wic->CreateBitmapFromMemory(image->width, image->height,
                GUID_WICPixelFormat32bppPBGRA, image->width * 4,
                static_cast<UINT>(image->pixels.size()), image->pixels.data(), &source))) {
            image->tint = overlayTintFrom(source);
            image->hasTint = true;
        }
        SafeRelease(source);
    }
    return image->tint;
}

// Upload to this target's resource domain, reusing CPU pixels and cover tint
// across window changes/device loss. Cropped logos have a distinct cache key.
ID2D1Bitmap* decodeBitmap(ID2D1RenderTarget* rt, const std::string& bytes, D2D1_COLOR_F* tintOut,
                         bool trimAlpha = false, float* horizontalAnchor = nullptr) {
    if (!rt || !g_wic || bytes.empty()) return nullptr;
    SSC_TIME(imageTimer, imageMs);
    const auto image = decodedImage(bytes, trimAlpha);
    if (!image) return nullptr;
    if (horizontalAnchor) *horizontalAnchor = image->horizontalAnchor;
    ID2D1Bitmap* bmp = nullptr;
    if (SUCCEEDED(rt->CreateBitmap(D2D1::SizeU(image->width, image->height),
            image->pixels.data(), image->width * 4,
            D2D1::BitmapProperties(D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM,
                D2D1_ALPHA_MODE_PREMULTIPLIED)), &bmp)) && tintOut) {
        *tintOut = decodedTint(image);
    }
    return bmp;
}

// Decodes into the main render target; refreshes g_curTint when isCurrent.
ID2D1Bitmap* createBitmap(const std::string& bytes, bool isCurrent) {
    // The presentation layers and legacy readiness/tint state share one upload
    // in the main target's resource domain. Each owner retains its own COM ref.
    // Never share these with the separate blur device's decodeBitmap() uploads.
    ID2D1Bitmap* existing = nullptr;
    const auto found = g_frameBitmaps.find(bytes);
    if (found != g_frameBitmaps.end()) existing = found->second;
    if (!existing && g_curBmp && bytes == g_curBytes) existing = g_curBmp;
    if (!existing && g_prevBmp && bytes == g_prevBytes) existing = g_prevBmp;
    if (!existing && g_backdropCurBmp && bytes == g_backdropCurBytes) existing = g_backdropCurBmp;
    if (!existing && g_backdropPrevBmp && bytes == g_backdropPrevBytes) existing = g_backdropPrevBmp;
    if (existing) {
        existing->AddRef();
        if (isCurrent) {
            const auto image = decodedImage(bytes, false);
            if (image) g_curTint = decodedTint(image);
        }
        return existing;
    }
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

void drawFanartHint(float cw, float ch, float dpi, float opacity) {
    if (opacity <= 0.0f || !g_dwrite || !g_bgBrush || !g_fgBrush) return;
    const wchar_t* text = L"fanart.tv key rejected\nCheck provider settings";
    const float margin = 11.2f * dpi, pad = 8.0f * dpi;
    IDWriteTextFormat* format = makeFormat(12.0f * dpi, DWRITE_FONT_WEIGHT_NORMAL, false);
    if (!format) return;
    IDWriteTextLayout* layout = nullptr;
    const float width = (std::max)(1.0f, (std::min)(250.0f * dpi, cw * .45f - pad * 2));
    if (SUCCEEDED(g_dwrite->CreateTextLayout(text, (UINT32)lstrlenW(text), format,
            width, (std::max)(1.0f, ch - margin * 2 - pad * 2), &layout))) {
        DWRITE_TEXT_METRICS metrics = {}; layout->GetMetrics(&metrics);
        const auto bgColor = g_bgBrush->GetColor(), fgColor = g_fgBrush->GetColor();
        const float bgOpacity = g_bgBrush->GetOpacity(), fgOpacity = g_fgBrush->GetOpacity();
        g_bgBrush->SetColor(D2D1::ColorF(0, 0, 0, .62f));
        g_bgBrush->SetOpacity(opacity);
        g_fanartHintHitRect = D2D1::RectF(margin, margin,
            margin + metrics.width + pad * 2, margin + metrics.height + pad * 2);
        g_rt->FillRoundedRectangle(D2D1::RoundedRect(g_fanartHintHitRect, 8 * dpi, 8 * dpi), g_bgBrush);
        g_fgBrush->SetColor(D2D1::ColorF(1, .86f, .62f));
        g_fgBrush->SetOpacity(opacity);
        g_rt->DrawTextLayout(D2D1::Point2F(margin + pad, margin + pad), layout, g_fgBrush, D2D1_DRAW_TEXT_OPTIONS_CLIP);
        g_bgBrush->SetColor(bgColor); g_bgBrush->SetOpacity(bgOpacity);
        g_fgBrush->SetColor(fgColor); g_fgBrush->SetOpacity(fgOpacity);
        SafeRelease(layout);
    }
    SafeRelease(format);
}

void drawComingNext(float cw, float ch, float dpi, float top, bool rtl,
                    const ssc::ComingNextFrame* frame) {
    if (!frame || frame->opacity <= 0.0f || frame->album.empty()
            || !g_dwrite || !g_bgBrush || !g_fgBrush) return;
    const auto typography = ssc::nextTypography(cw, dpi);
    const float margin = 11.2f * dpi, padX = typography.padX, padY = typography.padY;
    if (g_nextBytes != frame->cover) { SafeRelease(g_nextBmp); g_nextBytes = frame->cover; }
    if (!g_nextBmp && g_nextBytes) g_nextBmp = decodeBitmap(g_rt, *g_nextBytes, nullptr);
    const float coverSize = typography.cover;
    const float coverLayout = g_frame ? g_frame->nextCoverLayout : frame->coverOpacity;
    const float coverColumn = g_nextBmp ? (coverSize + typography.gap) * coverLayout : 0;
    const float sizes[] = {typography.label, typography.album, typography.artist};
    const std::wstring lines[] = {L"COMING NEXT", frame->album, frame->artist};
    IDWriteTextLayout* layouts[3] = {};
    float width = 0.0f, heights[3] = {};
    float textHeight = 0.0f;
    for (int i = 0; i < 3; ++i) {
        if (lines[i].empty()) continue;
        IDWriteTextFormat* format = makeFormat(sizes[i],
            i == 0 ? DWRITE_FONT_WEIGHT_BOLD : i == 1 ? DWRITE_FONT_WEIGHT_SEMI_BOLD
                                                   : DWRITE_FONT_WEIGHT_NORMAL, false);
        if (!format) continue;
        format->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
        format->SetReadingDirection(rtl ? DWRITE_READING_DIRECTION_RIGHT_TO_LEFT : DWRITE_READING_DIRECTION_LEFT_TO_RIGHT);
        if (SUCCEEDED(g_dwrite->CreateTextLayout(lines[i].c_str(), (UINT32)lines[i].size(),
                format, 100000, 100000, &layouts[i]))) {
            DWRITE_TEXT_METRICS metrics = {};
            layouts[i]->GetMetrics(&metrics);
            width = (std::max)(width, metrics.widthIncludingTrailingWhitespace);
            heights[i] = std::ceil(metrics.height) + (i == 0 ? 3.0f * dpi : 1.3f * dpi);
            textHeight += heights[i];
        }
        SafeRelease(format);
    }
    const auto card = ssc::nextCardSize(cw, typography, width, textHeight,
        g_nextBmp ? frame->coverOpacity : 0, dpi);
    const float cardWidth = g_frame ? g_frame->nextRect.width : card.width, height = g_frame ? g_frame->nextRect.height : card.height;
    for (auto* layout : layouts) {
        if (!layout) continue;
        layout->SetMaxWidth(g_frame ? (std::max)(1.f,cardWidth-padX*2-coverColumn) : card.textWidth);
        IDWriteInlineObject* ellipsis = nullptr;
        if (SUCCEEDED(g_dwrite->CreateEllipsisTrimmingSign(layout, &ellipsis))) {
            const DWRITE_TRIMMING trim = {DWRITE_TRIMMING_GRANULARITY_CHARACTER, 0, 0};
            layout->SetTrimming(&trim, ellipsis);
            SafeRelease(ellipsis);
        }
    }
    const float restingLeft = ssc::comingNextLeft(cw, cardWidth, margin, rtl);
    // Match .coming-next: translateX(calc(100% + .7rem)) -> translateX(0).
    // The render target clips the outgoing card at the right stage edge.
    const float offset = (1.0f - frame->opacity) * (cardWidth + margin) * (rtl ? -1 : 1);
    const float left = g_frame ? g_frame->nextRect.x : restingLeft + offset, right = left + cardWidth;
    const float y = g_frame ? g_frame->nextRect.y : (std::max)(0.0f, (std::min)(top, ch - margin - height));
    const auto bounds = D2D1::RoundedRect(D2D1::RectF(left, y, right, y + height),
                                         10.4f * dpi, 10.4f * dpi);
#ifdef SSC_RENDERER_DIAGNOSTICS
    g_diagnostics.comingNextLeft = left;
    g_diagnostics.comingNextRight = right;
    g_diagnostics.comingNextNaturalTextWidth = width;
    g_diagnostics.comingNextTextWidth = card.textWidth;
    g_diagnostics.comingNextTrimmedLines = 0;
    for (auto* layout : layouts) {
        if (!layout) continue;
        DWRITE_LINE_METRICS line{}; UINT32 count = 0;
        if (SUCCEEDED(layout->GetLineMetrics(&line, 1, &count)) && line.isTrimmed)
            ++g_diagnostics.comingNextTrimmedLines;
    }
#endif
    const auto bgColor = g_bgBrush->GetColor(), fgColor = g_fgBrush->GetColor();
    const float bgOpacity = g_bgBrush->GetOpacity(), fgOpacity = g_fgBrush->GetOpacity();
    g_bgBrush->SetColor(D2D1::ColorF(0, 0, 0, .62f));
    g_bgBrush->SetOpacity(frame->opacity);
    g_rt->FillRoundedRectangle(bounds, g_bgBrush);
    g_fgBrush->SetColor(D2D1::ColorF(1, 1, 1, .16f));
    g_fgBrush->SetOpacity(frame->opacity);
    g_rt->DrawRoundedRectangle(bounds, g_fgBrush, dpi);
    if (g_nextBmp) {
        const float side = coverSize * coverLayout;
        const float x = rtl ? right - padX - side : left + padX;
        const float cy = y + (height - side) * .5f;
        g_rt->DrawBitmap(g_nextBmp, D2D1::RectF(x, cy, x + side, cy + side),
            frame->opacity * frame->coverOpacity, D2D1_BITMAP_INTERPOLATION_MODE_LINEAR);
    }
    float lineY = y + padY;
    for (int i = 0; i < 3; ++i) {
        if (!layouts[i]) continue;
        g_fgBrush->SetColor(D2D1::ColorF(1, 1, 1, i == 0 ? .72f : i == 1 ? 1.0f : .82f));
        g_rt->DrawTextLayout(D2D1::Point2F(left + padX + (rtl ? 0 : coverColumn), lineY), layouts[i], g_fgBrush,
                             D2D1_DRAW_TEXT_OPTIONS_NONE);
        lineY += heights[i];
        SafeRelease(layouts[i]);
    }
    g_bgBrush->SetColor(bgColor); g_bgBrush->SetOpacity(bgOpacity);
    g_fgBrush->SetColor(fgColor); g_fgBrush->SetOpacity(fgOpacity);
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
void generateBlurFor(const std::string& bytes, std::vector<BYTE>& pixels, ID2D1Bitmap*& bitmap) {
    if (bitmap || bytes.empty() || !g_rt) return;
    SSC_TIME(blurTimer, blurMs);
    const D2D1_BITMAP_PROPERTIES bp = D2D1::BitmapProperties(
        D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_PREMULTIPLIED));
    if (!pixels.empty()) {
        g_rt->CreateBitmap(D2D1::SizeU(kBlurSize, kBlurSize), pixels.data(),
            kBlurSize * 4, bp, &bitmap);
        return;
    }
    if (!createBlurGen()) return;
    SSC_COUNT(blurGenerations);
    ID2D1Bitmap* src = decodeBitmap(g_blurCtx, bytes, nullptr);
    if (!src) return;
    const D2D1_SIZE_F ss = src->GetSize();
    const UINT S = kBlurSize;

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
        const HRESULT drawn = g_blurCtx->EndDraw();
        g_blurCtx->SetTarget(nullptr);
        g_blurEffect->SetInput(0, nullptr); // do not retain another full-resolution cover

        // Read the blurred result back to CPU, then upload it to the HwndRenderTarget.
        ID2D1Bitmap1* cpu = nullptr;
        D2D1_BITMAP_PROPERTIES1 cprops = D2D1::BitmapProperties1(
            D2D1_BITMAP_OPTIONS_CPU_READ | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
            D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_PREMULTIPLIED));
        if (SUCCEEDED(drawn) && SUCCEEDED(g_blurCtx->CreateBitmap(D2D1::SizeU(S, S), nullptr, 0, cprops, &cpu))) {
            D2D1_POINT_2U dst = {0, 0};
            D2D1_RECT_U srcRect = {0, 0, S, S};
            if (SUCCEEDED(cpu->CopyFromBitmap(&dst, target, &srcRect))) {
                D2D1_MAPPED_RECT mapped = {};
                if (SUCCEEDED(cpu->Map(D2D1_MAP_OPTIONS_READ, &mapped))) {
                    pixels.resize(static_cast<size_t>(S) * S * 4);
                    for (UINT y = 0; y < S; ++y)
                        std::memcpy(pixels.data() + static_cast<size_t>(y) * S * 4,
                            mapped.bits + static_cast<size_t>(y) * mapped.pitch, S * 4);
                    cpu->Unmap();
                    g_rt->CreateBitmap(D2D1::SizeU(S, S), pixels.data(), S * 4, bp, &bitmap);
                }
            }
            SafeRelease(cpu);
        }
        SafeRelease(target);
    }
    SafeRelease(src);
}

void drawBlurredBackground(float cw, float ch) {
    if (g_frame) {
        const float side=(std::max)(cw,ch), dx=(cw-side)*.5f, dy=(ch-side)*.5f;
        for (const auto& layer:g_frame->blurredCover) {
            auto& bitmap=g_frameBlurs[*layer.image];
            generateBlurFor(*layer.image,g_frameBlurPixels[*layer.image],bitmap);
            if (bitmap) g_rt->DrawBitmap(bitmap,D2D1::RectF(dx,dy,dx+side,dy+side),layer.opacity,D2D1_BITMAP_INTERPOLATION_MODE_LINEAR);
        }
        if (g_scrimBrush) g_rt->FillRectangle(D2D1::RectF(0,0,cw,ch),g_scrimBrush);
        return;
    }
    generateBlurFor(g_curBytes,g_blurPixels,g_blurBmp);
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

void drawImageLayers(const std::vector<ssc::ImageLayer>& layers, D2D1_RECT_F rect, bool fill, float opacity = 1) {
    for (const auto& layer : layers) {
        if (!layer.image || layer.opacity <= 0) continue;
        auto& bitmap = g_frameBitmaps[*layer.image];
        if (!bitmap) bitmap = createBitmap(*layer.image, false);
        if (!bitmap) continue;
        const auto size = bitmap->GetSize();
        const float w = rect.right - rect.left, h = rect.bottom - rect.top;
        const float sx = w / size.width, sy = h / size.height;
        const float scale = fill ? (std::max)(sx, sy) : (std::min)(sx, sy);
        const auto center = D2D1::Point2F((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
        const auto target = D2D1::RectF(center.x - size.width * scale / 2, center.y - size.height * scale / 2,
            center.x + size.width * scale / 2, center.y + size.height * scale / 2);
        g_rt->PushAxisAlignedClip(rect, D2D1_ANTIALIAS_MODE_PER_PRIMITIVE);
        g_rt->SetTransform(D2D1::Matrix3x2F::Scale(layer.scaleX, layer.scaleY, center));
        g_rt->DrawBitmap(bitmap, target, layer.opacity * opacity, D2D1_BITMAP_INTERPOLATION_MODE_LINEAR);
        g_rt->SetTransform(D2D1::Matrix3x2F::Identity()); g_rt->PopAxisAlignedClip();
    }
}

bool drawBackdrop(float cw, float ch, float progress) {
    if (g_frame) { drawImageLayers(g_frame->backdrop, D2D1::RectF(0,0,cw,ch), true); return !g_frame->backdrop.empty(); }
    if (progress < 0.0f) progress = 0.0f;
    if (progress > 1.0f) progress = 1.0f;
    // Keep an opaque outgoing image underneath the incoming fade. Fading both
    // layers exposes the blurred cover at the midpoint of source-over blending.
    drawBackdropBitmap(g_backdropPrevBmp, cw, ch, !g_backdropCurBytes.empty() ? 1.0f : 1.0f - progress);
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
        for (size_t b = 0; !ratings[i].png.empty() && b < g_ratingBitmaps.size(); ++b)
            if (g_ratingBitmaps[b].key == key) { logo = g_ratingBitmaps[b].bitmap; break; }
        if (!logo && !ratings[i].png.empty()) {
            logo = decodeBitmap(g_rt, ratings[i].png, nullptr);
            if (logo) { RatingBitmap item; item.key = key; item.bitmap = logo; g_ratingBitmaps.push_back(item); }
        }
        std::wstring text = ratings[i].label.empty() ? ratings[i].rating : ratings[i].label;
        if (logo) text = ratings[i].descriptors;
        else if (!ratings[i].descriptors.empty()) text += L" " + ratings[i].descriptors;
        IDWriteTextLayout* layout = nullptr;
        DWRITE_TEXT_METRICS metrics = {};
        if (!text.empty() && SUCCEEDED(g_dwrite->CreateTextLayout(
                text.c_str(), (UINT32)text.size(), fmt, cw, ch, &layout)))
            layout->GetMetrics(&metrics);

        float logoW = 0.0f, logoH = 0.0f, logoSlot = 0.0f;
        if (logo) {
            const D2D1_SIZE_U pixels = logo->GetPixelSize();
            const ssc::RatingLogoSize contained = ssc::containRatingLogo(
                static_cast<float>(pixels.width), static_cast<float>(pixels.height), logoHeight);
            logoW = contained.width;
            logoH = contained.height;
            logoSlot = logoHeight;
        }
        const float textW = layout ? metrics.width + padX * 2.0f : 0.0f;
        const float textH = layout ? metrics.height + padY * 2.0f : 0.0f;
        const float innerGap = logo && layout ? margin * 0.7f : 0.0f;
        const float groupW = logoSlot + innerGap + textW;
        const float x = cursor - groupW;
        if (logo) {
            const float slotY = ch - logoSlot - margin;
            const float logoX = x + (logoSlot - logoW) * 0.5f;
            const float logoY = slotY + (logoSlot - logoH) * 0.5f;
            g_rt->DrawBitmap(logo,
                             D2D1::RectF(logoX, logoY, logoX + logoW, logoY + logoH), opacity,
                             D2D1_BITMAP_INTERPOLATION_MODE_LINEAR);
        }
        if (layout) {
            const float textX = x + logoSlot + innerGap;
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
    if (g_frame) {
        for (const auto& layer:g_frame->ratings) {
            auto found=g_ratingSets.find(*layer.image);
            if (found!=g_ratingSets.end()) drawRatingSet(found->second,cw,ch,layer.opacity*opacity,dpiScale);
        }
        return;
    }
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
    SSC_COUNT(coverDraws);
    bool pushed = false;
    ID2D1RoundedRectangleGeometry* geo = nullptr;
    if (cornerRadius > 0.0f && g_layer && g_factory &&
        SUCCEEDED(g_factory->CreateRoundedRectangleGeometry(
            D2D1::RoundedRect(dest, cornerRadius, cornerRadius), &geo))) {
        g_rt->PushLayer(D2D1::LayerParameters(D2D1::InfiniteRect(), geo), g_layer);
        pushed = true;
    }
    if (g_frame) drawImageLayers(g_frame->cover, dest, false, g_frame->coverOpacity);
    else drawTransition(g_rt, transition, g_prevBmp, g_curBmp,
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
                  float mediaProgress, bool hideCoverWithBackdrop, float infoOpacity,
                  const wchar_t* album, const wchar_t* track, float logoAlpha,
                  float logoLayoutMix, float dpiScale) {
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
    const auto typography = ssc::posterTypography(cw, ch);
    const float baseSide = typography.coverSide;
    float coverS = baseSide;
    float boxW = cw * 0.86f;
    float boxX = (cw - boxW) * 0.5f;
    const bool showInfo = title && *title;
    if (infoOpacity < 0.0f) infoOpacity = 0.0f;
    if (infoOpacity > 1.0f) infoOpacity = 1.0f;

    // Measure the info text to size the box.
    const float padX = typography.padX, padY = typography.padY;
    const float textW = boxW > 2 * padX ? boxW - 2 * padX : 1.0f;
    const float titleSize = typography.title, artistSize = typography.artist;
    const wchar_t* albumText = album && *album ? album : title;
    const bool showLogo = g_titleLogoBmp && album && (g_frame ? g_frame->logoAlbum : g_titleLogo.album()) == album;
    const float logoMix = showLogo ? logoAlpha : 0;
    // Keep the reserved row metric after the image retires, while the independent
    // layout transition finishes expanding back to text.
    const D2D1_SIZE_F bitmapSize = showLogo ? g_titleLogoBmp->GetSize() : D2D1::SizeF(1, 1);
    const ssc::TitleLogoSize logoSize = ssc::titleLogoSize(bitmapSize.width, bitmapSize.height,
        cw, ch, titleSize, dpiScale);
    IDWriteTextFormat* tf = g_dwrite ? makeFormat(titleSize, DWRITE_FONT_WEIGHT_SEMI_BOLD, true) : nullptr;
    IDWriteTextFormat* cf = g_dwrite ? makeFormat(titleSize * .88f, DWRITE_FONT_WEIGHT_MEDIUM, true) : nullptr;
    IDWriteTextFormat* af = g_dwrite ? makeFormat(artistSize, DWRITE_FONT_WEIGHT_NORMAL, true) : nullptr;
    IDWriteTextLayout* tl = nullptr; float titleH = 0;
    IDWriteTextLayout* al = nullptr; float artistH = 0;
    IDWriteTextLayout* cl = nullptr; float trackH = 0;
    float albumW = 0, trackW = 0, artistW = 0;
    if (showInfo && tf &&
        SUCCEEDED(g_dwrite->CreateTextLayout(albumText, (UINT32)lstrlenW(albumText), tf, textW, 10000, &tl))) {
        DWRITE_TEXT_METRICS mt = {}; tl->GetMetrics(&mt); titleH = mt.height; albumW = mt.width;
    }
    if (showInfo && cf && track && *track &&
        SUCCEEDED(g_dwrite->CreateTextLayout(track, (UINT32)lstrlenW(track), cf, textW, 10000, &cl))) {
        DWRITE_TEXT_METRICS mt = {}; cl->GetMetrics(&mt); trackH = mt.height + titleSize * .12f; trackW = mt.width;
    }
    if (showInfo && af && artist && *artist &&
        SUCCEEDED(g_dwrite->CreateTextLayout(artist, (UINT32)lstrlenW(artist), af, textW, 10000, &al))) {
        DWRITE_TEXT_METRICS ma = {}; al->GetMetrics(&ma); artistH = ma.height; artistW = ma.width;
    }
    const float lineGap = artistSize * 0.35f;
    float cdFont = baseSide * overlayFontFrac;
    if (cdFont < 12.0f) cdFont = 12.0f;
    if (g_frame) cdFont = g_frame->countdown.fontSize;
    const float statusH = showInfo && remainingSeconds >= 0 ? (cdFont * 1.2f + 6.4f) * (g_frame ? g_frame->countdown.opacity : 1) : 0.0f;
    float contentW = trackW > artistW ? trackW : artistW;
    if (statusH > 0 && contentW < cdFont * 3.6f) contentW = cdFont * 3.6f;
    const float fullW = albumW > contentW ? albumW : contentW;
    const float measuredContentW = fullW + (contentW - fullW) * logoLayoutMix;
    boxW = ssc::posterInfoWidth(cw, measuredContentW, padX, dpiScale, logoSize.width * logoLayoutMix);
    boxX = (cw - boxW) * .5f;
    const float fittedTextW = boxW > 2 * padX ? boxW - 2 * padX : 1.0f;
    if (tl) tl->SetMaxWidth(fittedTextW);
    if (cl) cl->SetMaxWidth(fittedTextW);
    if (al) al->SetMaxWidth(fittedTextW);
    const float albumRowH = titleH + (logoSize.rowHeight - titleH) * logoLayoutMix;
    float boxH = showInfo ? padY + albumRowH + trackH + (artistH > 0 ? lineGap + artistH : 0)
                     + (statusH > 0 ? 6.4f + statusH : 0) + padY : 0.0f;

    const float bottomGap = m > 12.0f ? m : 12.0f;
    const float scaledGap = minSide * 0.016f;
    const float gap = scaledGap > 4.0f ? scaledGap : 4.0f;
    float boxY = ch - bottomGap, coverY = (ch - coverS) * 0.5f;
    if (showInfo && portrait) {
        boxY = ch - bottomGap - boxH;
        const ssc::PosterCoverFit fit = ssc::fitPortraitPosterCover(
            coverS, boxY, gap, bottomGap);
        coverS = fit.side;
        coverY = fit.top;
    } else if (showInfo) {
        // CSS grid row centres are 36% and 86%; the small cover shift is the
        // same balancing term used by sizeStage().
        boxY = ch * 0.86f - boxH * 0.5f;
        const float coverShift = ch * 0.07f - boxH * 0.25f;
        coverY = ch * 0.36f + coverShift - coverS * 0.5f;
        if (coverY + coverS + gap > boxY) coverY = boxY - gap - coverS;
        if (coverY < 0.0f) coverY = 0.0f;

        // A wrapped landscape title can make the 86%-centred box reach or cross
        // the client edge. Move the complete cover/info stack upward far enough
        // to retain a visible bottom margin. If that would cross the top edge,
        // shorten only the cover while preserving its bottom and the inter-row gap.
        const float minimumBottomGap = scaledGap > 12.0f ? scaledGap : 12.0f;
        const float boundedBoxY = ssc::clampPosterInfoTop(
            boxY, boxH, ch, minimumBottomGap);
        const float upwardShift = boxY - boundedBoxY;
        boxY = boundedBoxY;
        coverY -= upwardShift;
        if (coverY < 0.0f) {
            coverS += coverY;
            coverY = 0.0f;
            if (coverS < 1.0f) coverS = 1.0f;
        }
    }
    if (showInfo && infoOpacity < 1.0f) {
        const float hiddenY = (ch - baseSide) * 0.5f;
        coverY = hiddenY + (coverY - hiddenY) * infoOpacity;
        coverS = baseSide + (coverS - baseSide) * infoOpacity;
    }
    if (boxY < 0.0f) boxY = 0.0f;
    float coverX = (cw - coverS) * 0.5f;
    if (g_frame) {
        boxX=g_frame->infoRect.x; boxY=g_frame->infoRect.y; boxW=g_frame->infoRect.width; boxH=g_frame->infoRect.height;
        coverX=g_frame->coverRect.x; coverY=g_frame->coverRect.y; coverS=g_frame->coverRect.width;
    }

    // Cover (rounded), with the active transition. The radius is per mille of the cover's
    // side so it tracks the window size; 45 (4.5%) is the default look.
    if ((g_frame ? g_frame->coverOpacity > 0 : (!mediaVisible || !hideCoverWithBackdrop)) && !g_backdropLoading)
        drawCover(D2D1::RectF(coverX, coverY, coverX + coverS, coverY + (g_frame ? g_frame->coverRect.height : coverS)),
                  transition, progress, coverS * (g_coverRadius / 1000.0f));

    // Info box - same radius as the cover and always in the retained lower row.
    if (showInfo && infoOpacity > 0.0f && g_boxBrush) {
        const float br = coverS * (g_coverRadius / 1000.0f);
        g_boxBrush->SetOpacity(infoOpacity * (g_frame ? g_frame->poster : 1));
        g_rt->FillRoundedRectangle(
            D2D1::RoundedRect(D2D1::RectF(boxX, boxY, boxX + boxW, boxY + boxH), br, br), g_boxBrush);
        g_boxBrush->SetOpacity(1.0f);
    }
    const D2D1_COLOR_F tint = playerTint(mediaProgress);
    if (g_fgBrush) {
        g_fgBrush->SetColor(tint); // backdrop tint, falling back to cover tint
        g_fgBrush->SetOpacity(infoOpacity);
    }
    float ty = boxY + padY;
    g_albumHitVisible = showInfo && infoOpacity > .01f && album && *album;
    g_albumHitRect = D2D1::RectF(boxX + padX, ty, boxX + boxW - padX, ty + albumRowH);
    g_logoHitRect = D2D1::RectF(0, 0, 0, 0);
    if (tl && logoMix < 1) {
        g_fgBrush->SetOpacity(infoOpacity * (1 - logoMix));
        g_rt->PushAxisAlignedClip(D2D1::RectF(boxX + padX, ty,
            boxX + boxW - padX, ty + albumRowH), D2D1_ANTIALIAS_MODE_PER_PRIMITIVE);
        g_rt->DrawTextLayout(D2D1::Point2F(boxX + padX, ty), tl, g_fgBrush);
        g_rt->PopAxisAlignedClip();
    }
    if (showLogo && logoMix > 0) {
        const auto logoRect = ssc::titleLogoRect(cw * .5f, boxY, logoSize, g_titleLogoAnchor);
        g_logoHitRect = D2D1::RectF(logoRect.left, logoRect.top, logoRect.right, logoRect.bottom);
        g_rt->DrawBitmap(g_titleLogoBmp, g_logoHitRect, logoMix * infoOpacity,
            D2D1_BITMAP_INTERPOLATION_MODE_LINEAR);
    }
    ty += albumRowH;
    g_fgBrush->SetOpacity(infoOpacity);
    if (artistH > 0) ty += lineGap;
    if (al) {
        if (g_fgBrush) g_fgBrush->SetOpacity(0.8f * infoOpacity);
        g_rt->DrawTextLayout(D2D1::Point2F(boxX + padX, ty), al, g_fgBrush);
        ty += artistH;
        if (g_fgBrush) g_fgBrush->SetOpacity(infoOpacity);
    }
    if (cl) {
        g_rt->DrawTextLayout(D2D1::Point2F(boxX + padX, ty + titleSize * .12f), cl, g_fgBrush);
        ty += trackH;
    }
    if (g_fgBrush) {
        g_fgBrush->SetOpacity(1.0f);
        g_fgBrush->SetColor(D2D1::ColorF(1, 1, 1, 1));
    }
    SafeRelease(tl); SafeRelease(al); SafeRelease(cl); SafeRelease(tf); SafeRelease(af); SafeRelease(cf);

    // Bottom row of the box: "Loading..." while fetching, else the live countdown -
    // the SAME rolling widget the fill overlay uses, translated into the box (no
    // re-implemented formatting).
    bool overlayAnimating = false;
    if (status && *status) {
        drawStatus(status, cw, ch); // window bottom-right, only while loading
    } else if (showInfo && remainingSeconds >= 0 && g_dwrite && g_bgBrush && g_fgBrush) {
        // Same rolling widget as fill mode, centred like the web player's status row.
        g_fgBrush->SetColor(tint);
        g_fgBrush->SetOpacity(0.85f * infoOpacity);
        g_bgBrush->SetOpacity(infoOpacity);
        g_rt->SetTransform(D2D1::Matrix3x2F::Translation(g_frame ? g_frame->countdownRect.x : boxX, g_frame ? g_frame->countdownRect.y : boxY));
        overlayAnimating = drawRollingTime(g_rt, g_dwrite, g_bgBrush, g_fgBrush, remainingSeconds,
                                           g_frame ? g_frame->countdownRect.width : boxW, g_frame ? g_frame->countdownRect.height : boxH, g_frame ? g_frame->countdown.fontSize : cdFont, rollDigits, !g_frame, false, true, g_frame ? &g_frame->countdown : nullptr);
        g_rt->SetTransform(D2D1::Matrix3x2F::Identity());
        g_bgBrush->SetOpacity(1.0f);
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
    if (g_backdropLoading || (hideCoverWithBackdrop && (g_backdropCurBmp || g_backdropPrevBmp))) drawBlurredBackground(cw, ch);
    else drawCover(D2D1::RectF(0, 0, cw, ch), transition, progress, 0.0f);
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
                                           cw, ch, g_frame ? g_frame->countdown.fontSize : ch * overlayFontFrac, rollDigits, false, true, false, g_frame ? &g_frame->countdown : nullptr);
        if (g_fgBrush) g_fgBrush->SetColor(D2D1::ColorF(1, 1, 1, 1)); // status stays white
    } else {
        resetRollingTime(); // hidden -> don't roll from a stale value when it returns
    }
    drawStatus(status, cw, ch);
    return overlayAnimating;
}

} // namespace

void measurePresentation(HWND hwnd, ssc::PresentationController& presentation) {
    if (!g_dwrite) return;
    RECT rc{}; GetClientRect(hwnd,&rc);
    const float w=float((std::max)(1L,rc.right)), h=float((std::max)(1L,rc.bottom)), dpi=windowDpiScale(hwnd);
    presentation.viewportChanged(w,h,dpi,(GetWindowLongPtrW(hwnd,GWL_EXSTYLE)&WS_EX_LAYOUTRTL)!=0);
    const auto& frame=presentation.frame(); const auto font=ssc::posterTypography(w,h);
    auto measure=[&](const std::wstring& text,float size,DWRITE_FONT_WEIGHT weight,float width,bool wrap) {
        DWRITE_TEXT_METRICS metrics{};
        IDWriteTextFormat* format=makeFormat(size,weight,true); IDWriteTextLayout* layout=nullptr;
        if (format) {
            format->SetWordWrapping(wrap?DWRITE_WORD_WRAPPING_WRAP:DWRITE_WORD_WRAPPING_NO_WRAP);
            if (!text.empty() && SUCCEEDED(g_dwrite->CreateTextLayout(text.c_str(),(UINT32)text.size(),format,width,10000,&layout))) layout->GetMetrics(&metrics);
        }
        SafeRelease(layout); SafeRelease(format); return metrics;
    };
    const auto& album=frame.album.empty()?frame.title:frame.album;
    const float maxWidth=(std::max)(1.f,w*.86f-font.padX*2);
    auto a=measure(album,font.title,DWRITE_FONT_WEIGHT_SEMI_BOLD,maxWidth,true);
    auto b=measure(frame.artist,font.artist,DWRITE_FONT_WEIGHT_NORMAL,maxWidth,true);
    auto c=measure(frame.track,font.track,DWRITE_FONT_WEIGHT_MEDIUM,maxWidth,true);
    // WIC's bounded decoded cache provides dimensions without a render-target upload.
    auto logo=ssc::TitleLogoSize{0,0,0};
    if (!frame.logo.empty()) {
        const auto pixels=decodedImage(frame.logo, true);
        if (pixels) logo=ssc::titleLogoSize(float(pixels->width),float(pixels->height),w,h,font.title,dpi);
    }
    const float content=(std::max)((std::max)(b.width,c.width),
        (std::max)(a.width*(1-frame.logoLayout),frame.countdown.fontSize*4.5f*frame.countdown.opacity));
    const float width=ssc::posterInfoWidth(w,content,font.padX,dpi,logo.width*frame.logoLayout);
    presentation.measured(ssc::VisualChannel::InfoWidth,width);
    const float textWidth=(std::max)(1.f,width-font.padX*2);
    a=measure(album,font.title,DWRITE_FONT_WEIGHT_SEMI_BOLD,textWidth,true);
    b=measure(frame.artist,font.artist,DWRITE_FONT_WEIGHT_NORMAL,textWidth,true);
    c=measure(frame.track,font.track,DWRITE_FONT_WEIGHT_MEDIUM,textWidth,true);
    presentation.measured(ssc::VisualChannel::InfoHeight,font.padY*2+a.height+(logo.rowHeight-a.height)*frame.logoLayout
        +b.height+c.height+font.lineGap+font.title*.12f);
    const auto nf=ssc::nextTypography(w,dpi);
    const auto nl=measure(L"COMING NEXT",nf.label,DWRITE_FONT_WEIGHT_BOLD,100000,false);
    const auto na=measure(frame.next.album,nf.album,DWRITE_FONT_WEIGHT_SEMI_BOLD,100000,false);
    const auto nb=measure(frame.next.artist,nf.artist,DWRITE_FONT_WEIGHT_NORMAL,100000,false);
    presentation.measuredNext((std::max)(nl.widthIncludingTrailingWhitespace,
        (std::max)(na.widthIncludingTrailingWhitespace,nb.widthIncludingTrailingWhitespace)),
        std::ceil(nl.height)+std::ceil(na.height)+std::ceil(nb.height)+5.6f*dpi);
}

#if SSC_ENABLE_DEBUG_OVERLAY
LiveDiagnostics liveDiagnostics() {
    LiveDiagnostics stats;
    stats.cacheBytes = g_decodedBytes; stats.cacheEntries = g_decodedImages.size();
    stats.blurBytes = g_blurPixels.size();
    if (g_curBmp) { const auto size = g_curBmp->GetPixelSize(); stats.coverWidth = size.width; stats.coverHeight = size.height; }
    if (g_backdropCurBmp) { const auto size = g_backdropCurBmp->GetPixelSize(); stats.backdropWidth = size.width; stats.backdropHeight = size.height; }
    return stats;
}
#endif

#ifdef SSC_RENDERER_DIAGNOSTICS
RendererDiagnostics rendererDiagnostics() {
    g_diagnostics.logoHorizontalAnchor = g_titleLogoAnchor;
    auto stats = g_diagnostics;
    stats.cacheBytes = g_decodedBytes;
    stats.cacheEntries = g_decodedImages.size();
    stats.blurBytes = g_blurPixels.size();
    std::set<ID2D1Bitmap*> artwork;
    for (auto* bitmap : {g_curBmp, g_prevBmp, g_backdropCurBmp, g_backdropPrevBmp})
        if (bitmap) artwork.insert(bitmap);
    for (const auto& entry : g_frameBitmaps)
        if (entry.second) artwork.insert(entry.second);
    stats.artworkBitmapCount = artwork.size();
    for (auto* bitmap : artwork) {
        const auto size = bitmap->GetPixelSize();
        stats.artworkBitmapBytes += static_cast<size_t>(size.width) * size.height * 4;
    }
    return stats;
}
void resetRendererDiagnostics() { g_diagnostics = RendererDiagnostics(); }
#endif

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
    // Only GPU resources belong to the old target. Keep encoded and decoded
    // pixels, including the finished blur, for upload to the destination HWND.
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
    g_decodedImages.clear();
    g_frameBlurPixels.clear(); g_ratingSets.clear();
    g_decodedBytes = 0;
    std::vector<BYTE>().swap(g_blurPixels);
    g_curBytes.clear();
    g_prevBytes.clear();
    g_backdropCurBytes.clear();
    g_backdropPrevBytes.clear();
    g_titleLogo = ssc::TitleLogoPresentation();
    g_backdropLoading = false;
    g_backdropNavigationOpacity = 0;
    g_titleLogoLayout = ssc::TitleLogoLayout();
    g_backdropCurHasTint = g_backdropPrevHasTint = false;
    g_ratingsCur.clear();
    g_ratingsPrev.clear();
    SafeRelease(g_dwrite);
    SafeRelease(g_wic);
    SafeRelease(g_factory);
    if (g_comInited) { CoUninitialize(); g_comInited = false; }
}

void setCover(const void* data, size_t len, bool fadeFromCurrent) {
    if (g_curBytes.size() != len || (len && std::memcmp(g_curBytes.data(), data, len) != 0))
        g_blurPixels.clear();
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
        g_backdropPrevBmp = g_backdropCurBmp;
        g_backdropCurBmp = nullptr; // retain decoded outgoing pixels through the fade
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

bool backdropReady() { return g_backdropCurBytes.empty() || g_backdropCurBmp != nullptr; }
void setBackdropLoading(bool hideCover) { g_backdropLoading = hideCover; }
void setBackdropNavigationOpacity(float opacity) { g_backdropNavigationOpacity = opacity; }

int backdropNavigationHitTest(HWND hwnd, int x, int y) {
    RECT rc{};
    if (!GetClientRect(hwnd, &rc)) return 0;
    const float dpi = windowDpiScale(hwnd), size = 44 * dpi, margin = 12 * dpi;
    if (rc.right < 2 * (size + margin) || abs(y - rc.bottom / 2) > size / 2) return 0;
    if (x >= margin && x <= margin + size) return -1;
    if (x >= rc.right - margin - size && x <= rc.right - margin) return 1;
    return 0;
}

ssc::ImageReference setRatings(const std::vector<RatingBadge>& ratings, bool fadeFromCurrent) {
    if (fadeFromCurrent) g_ratingsPrev = g_ratingsCur;
    else g_ratingsPrev.clear();
    g_ratingsCur = ratings;
    if (ratings.empty()) return {};
    std::string key;
    for (const auto& badge:ratings) {
        for (const auto& field:{badge.country,badge.system,badge.rating,badge.label,badge.descriptors}) {
            const auto bytes=reinterpret_cast<const char*>(field.data());
            const size_t size=field.size()*sizeof(wchar_t);
            key+=std::to_string(size)+":"; key.append(bytes,size);
        }
        key+=std::to_string(badge.png.size())+":"+badge.png;
    }
    g_ratingSets[key]=ratings; return std::make_shared<const std::string>(std::move(key));
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
        for (auto& entry:g_frameBlurs) SafeRelease(entry.second); g_frameBlurs.clear(); g_frameBlurPixels.clear();
        g_blurPixels.clear();
        SafeRelease(g_blurBmp); // regenerate the cached blur at the new strength
    }
}

// Nothing cached to invalidate: the radius is applied per frame when the cover is clipped.
void setCoverRadius(int perMille) { g_coverRadius = perMille; }

void setTitleLogo(const std::string& bytes, const std::wstring& album, int fadeMs) {
    g_titleLogo.set(bytes, album, GetTickCount(), fadeMs);
}

bool titleLogoAnimating() { return g_titleLogo.animating() || g_titleLogoLayout.animating(); }

bool albumHitTest(HWND hwnd, int x, int y) {
    if (!g_albumHitVisible || hwnd != g_albumHitWindow) return false;
    const auto inside = [x, y](const D2D1_RECT_F& r) {
        return r.right > r.left && r.bottom > r.top
            && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    return inside(g_albumHitRect) || inside(g_logoHitRect);
}

bool fanartHintHitTest(HWND hwnd, int x, int y) {
    const auto& r = g_fanartHintHitRect;
    return hwnd == g_fanartHintHitWindow && r.right > r.left && r.bottom > r.top
        && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

bool render(HWND hwnd, float progress, Transition transition, int remainingSeconds,
            float overlayFontFrac, bool rollDigits, const wchar_t* statusText,
            int layout, const wchar_t* title, const wchar_t* artist,
            float mediaProgress, bool hideCoverWithBackdrop, float ratingProgress,
            float ratingOpacity, float infoOpacity, const wchar_t* album,
            const wchar_t* track, int logoFadeMs, const ssc::ComingNextFrame* comingNext,
            float fanartHintOpacity, const ssc::FrameState* frame) {
    g_frame = frame;
    if (frame) {
        // FrameState owns these bytes for this synchronous render. Avoid copying
        // every compressed image merely to retire resources on every paint.
        std::set<std::string_view> visible, blurred, ratingSets;
        for (const auto& layer:frame->ratings) ratingSets.insert(*layer.image);
        for (auto it=g_ratingSets.begin();it!=g_ratingSets.end();) {
            if (!ratingSets.count(it->first)) it=g_ratingSets.erase(it); else ++it;
        }
        for (const auto& layer:frame->cover) visible.insert(*layer.image);
        for (const auto& layer:frame->backdrop) visible.insert(*layer.image);
        for (const auto& layer:frame->blurredCover) blurred.insert(*layer.image);
        for (auto it=g_frameBitmaps.begin();it!=g_frameBitmaps.end();) {
            if (!visible.count(it->first)) { SafeRelease(it->second); it=g_frameBitmaps.erase(it); } else ++it;
        }
        for (auto it=g_frameBlurs.begin();it!=g_frameBlurs.end();) {
            if (!blurred.count(it->first)) { SafeRelease(it->second); g_frameBlurPixels.erase(it->first); it=g_frameBlurs.erase(it); } else ++it;
        }
        // Device loss can discard uploaded bitmaps before this retirement pass.
        // CPU blur entries must also retire when there is no upload left to visit.
        for (auto it=g_frameBlurPixels.begin();it!=g_frameBlurPixels.end();) {
            if (!blurred.count(it->first)) it=g_frameBlurPixels.erase(it); else ++it;
        }
    }
    SSC_TIME(frameTimer, frameMs);
    SSC_COUNT(frames);
    g_albumHitWindow = hwnd;
    g_albumHitVisible = false;
    g_fanartHintHitWindow = hwnd;
    g_fanartHintHitRect = {};
    if (!g_factory)
        return false;

    RECT rc;
    GetClientRect(hwnd, &rc);
    const UINT cw = rc.right > 0 ? (UINT)rc.right : 1;
    const UINT ch = rc.bottom > 0 ? (UINT)rc.bottom : 1;

    if (!g_rt) {
        SSC_TIME(targetTimer, targetMs);
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

    const DWORD logoNow = GetTickCount();
    const float logoAlpha = frame ? frame->logoOpacity : g_titleLogo.advance(logoNow, logoFadeMs);
    const auto& logoBytes = frame ? frame->logo : g_titleLogo.bytes();
    if (g_titleLogoDecodedBytes != logoBytes) {
        SafeRelease(g_titleLogoBmp);
        g_titleLogoDecodedBytes = logoBytes;
        g_titleLogoBmp = decodeBitmap(g_rt, g_titleLogoDecodedBytes, nullptr, true, &g_titleLogoAnchor);
    }
    const float logoLayoutMix = frame ? frame->logoLayout : g_titleLogoLayout.advance(layout == 1 && g_titleLogoBmp
        && album && (g_frame ? g_frame->logoAlbum : g_titleLogo.album()) == album && logoAlpha >= 1.0f, logoNow, logoFadeMs);
    g_rt->BeginDraw();
    g_rt->Clear(D2D1::ColorF(D2D1::ColorF::Black));
    bool overlayAnimating = false;
    if (g_frame || layout == 1) {
        overlayAnimating = renderPoster((float)cw, (float)ch, transition, progress,
                                        remainingSeconds, overlayFontFrac, rollDigits, title, artist,
                                        statusText, mediaProgress, hideCoverWithBackdrop, infoOpacity,
                                        album, track, logoAlpha, logoLayoutMix, windowDpiScale(hwnd));
    } else {
        overlayAnimating = renderCover((float)cw, (float)ch, transition, progress,
                                       remainingSeconds, overlayFontFrac, rollDigits, statusText,
                                       mediaProgress, hideCoverWithBackdrop);
    }
    drawRatings((float)cw, (float)ch, ratingProgress, ratingOpacity,
                windowDpiScale(hwnd));
    const float dpi = windowDpiScale(hwnd);
    // Fill mode owns a top-right countdown badge; keep the queue card below it.
    const float comingNextTop = layout == 0 && remainingSeconds >= 0
        ? ch * overlayFontFrac * 2.5f + 11.2f * dpi : 11.2f * dpi;
    drawComingNext((float)cw, (float)ch, dpi, comingNextTop,
        (GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_LAYOUTRTL) != 0, comingNext);
    drawFanartHint((float)cw, (float)ch, dpi, fanartHintOpacity);
    if (g_backdropNavigationOpacity > 0 && g_fgBrush && g_bgBrush && cw >= 112 * dpi) {
        const float alpha = g_backdropNavigationOpacity, half = 22 * dpi;
        for (int direction : {-1, 1}) {
            const float x = direction < 0 ? 34 * dpi : cw - 34 * dpi, y = ch * .5f;
            g_bgBrush->SetOpacity(alpha);
            g_rt->FillRoundedRectangle(D2D1::RoundedRect(D2D1::RectF(x - half, y - half, x + half, y + half), 8 * dpi, 8 * dpi), g_bgBrush);
            g_fgBrush->SetColor(D2D1::ColorF(1, 1, 1, alpha));
            g_rt->DrawLine(D2D1::Point2F(x - direction * 4 * dpi, y - 8 * dpi), D2D1::Point2F(x + direction * 4 * dpi, y), g_fgBrush, 2 * dpi);
            g_rt->DrawLine(D2D1::Point2F(x + direction * 4 * dpi, y), D2D1::Point2F(x - direction * 4 * dpi, y + 8 * dpi), g_fgBrush, 2 * dpi);
        }
        g_bgBrush->SetOpacity(1);
        g_fgBrush->SetColor(D2D1::ColorF(1, 1, 1, 1));
    }
    const HRESULT hr = g_rt->EndDraw();
    // Recreate on ANY failure, not just D2DERR_RECREATE_TARGET: a target left in a
    // non-recreate error state (e.g. after a bad resize) would otherwise render
    // black forever, since EndDraw keeps returning that stuck code and we'd never
    // rebuild. Discarding here self-heals on the next render.
    if (FAILED(hr)) {
        SSC_COUNT(failedFrames);
        discardDeviceResources();
    }
    return overlayAnimating;
}

} // namespace d2d
