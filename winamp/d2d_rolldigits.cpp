// d2d_rolldigits.cpp - see header. Renders each character in its own fixed-width
// cell (digits are equal-advance in Segoe UI) so a changed digit can roll within a
// clipped window without disturbing its neighbours. All drawing goes through the
// render target the renderer hands us; only device-independent DirectWrite text
// formats/layouts are cached here.
#include "d2d_rolldigits.h"

#include <windows.h>
#include <d2d1.h>
#include <d2d1helper.h>
#include <dwrite.h>
#include <string>

namespace d2d {
namespace {

const UINT kRollMs = 350; // duration of one digit roll

template <class T> void Rel(T*& p) { if (p) { p->Release(); p = nullptr; } }

// Cached, keyed by font size (device-independent, survive device loss).
IDWriteTextFormat*  g_fmt = nullptr;
float               g_fmtSize = 0.0f;
IDWriteTextLayout*  g_glyph[11] = {nullptr}; // '0'..'9' at 0..9, ':' at 10
float               g_digitW = 0.0f, g_colonW = 0.0f, g_cellH = 0.0f;

// Animation state (single overlay).
int         s_lastValue = 0x7fffffff; // sentinel: no previous value yet
std::string s_from, s_to;             // "m:ss" strings for the last transition
DWORD       s_animStart = 0;
bool        s_anim = false;

int   glyphIndex(char c) { return (c >= '0' && c <= '9') ? c - '0' : (c == ':' ? 10 : -1); }
float cellWidthFor(char c) { return c == ':' ? g_colonW : g_digitW; }

std::string formatTime(int secs) {
    if (secs < 0) secs = 0;
    char buf[16];
    wsprintfA(buf, "%d:%02d", secs / 60, secs % 60);
    return buf;
}

float measure(IDWriteFactory* dw, IDWriteTextFormat* fmt, const wchar_t* s, bool height) {
    IDWriteTextLayout* l = nullptr;
    if (FAILED(dw->CreateTextLayout(s, (UINT32)lstrlenW(s), fmt, 100000.0f, 100000.0f, &l)))
        return 0.0f;
    DWRITE_TEXT_METRICS m = {};
    l->GetMetrics(&m);
    Rel(l);
    return height ? m.height : m.widthIncludingTrailingWhitespace;
}

void releaseGlyphs() {
    for (int i = 0; i < 11; ++i) Rel(g_glyph[i]);
}

// (Re)builds the cached format + per-glyph layouts for a given font size.
bool ensureFormat(IDWriteFactory* dw, float fontSize) {
    if (g_fmt && g_fmtSize == fontSize && g_digitW > 0.0f)
        return true;
    releaseGlyphs();
    Rel(g_fmt);
    g_fmtSize = 0.0f;

    if (FAILED(dw->CreateTextFormat(L"Segoe UI", nullptr, DWRITE_FONT_WEIGHT_BOLD,
                                    DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL,
                                    fontSize, L"", &g_fmt)))
        return false;
    g_fmt->SetTextAlignment(DWRITE_TEXT_ALIGNMENT_CENTER);      // centre glyph in its cell
    g_fmt->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);

    // Digit advance = width of ten '0's / 10; colon advance = "0:0" minus two digits.
    g_digitW = measure(dw, g_fmt, L"0000000000", false) / 10.0f;
    g_colonW = measure(dw, g_fmt, L"0:0", false) - 2.0f * g_digitW;
    if (g_colonW < g_digitW * 0.3f) g_colonW = g_digitW * 0.5f; // sanity guard
    g_cellH = measure(dw, g_fmt, L"0", true);
    if (g_digitW <= 0.0f || g_cellH <= 0.0f) { Rel(g_fmt); return false; }

    // One layout per glyph, each a (cellWidth x cellH) box; centre alignment then
    // places the glyph in the middle of that cell.
    const wchar_t chars[11] = {L'0',L'1',L'2',L'3',L'4',L'5',L'6',L'7',L'8',L'9',L':'};
    for (int i = 0; i < 11; ++i) {
        const float w = (i == 10) ? g_colonW : g_digitW;
        wchar_t s[2] = { chars[i], 0 };
        dw->CreateTextLayout(s, 1, g_fmt, w, g_cellH, &g_glyph[i]);
    }
    g_fmtSize = fontSize;
    return true;
}

// Draws one glyph cell at (x, y) top-left. y is offset for the rolling slide.
void drawGlyph(ID2D1RenderTarget* rt, char c, float x, float y, ID2D1SolidColorBrush* fg) {
    const int gi = glyphIndex(c);
    if (gi < 0 || !g_glyph[gi]) return; // space / unknown -> nothing
    rt->DrawTextLayout(D2D1::Point2F(x, y), g_glyph[gi], fg, D2D1_DRAW_TEXT_OPTIONS_NONE);
}

} // namespace

void resetRollingTime() {
    s_lastValue = 0x7fffffff;
    s_anim = false;
}

void shutdownRollingTime() {
    releaseGlyphs();
    Rel(g_fmt);
    g_fmtSize = 0.0f;
    g_digitW = g_colonW = g_cellH = 0.0f;
}

bool drawRollingTime(ID2D1RenderTarget* rt, IDWriteFactory* dw,
                     ID2D1SolidColorBrush* bg, ID2D1SolidColorBrush* fg,
                     int remainingSeconds, float cw, float ch, float fontFrac,
                     bool animate) {
    if (!rt || !dw || !bg || !fg) return false;
    float fontSize = ch * fontFrac;
    if (fontSize < 10.0f) fontSize = 10.0f;
    if (!ensureFormat(dw, fontSize)) return false;

    // Detect a value change and (re)start the roll. With animation off, or on the
    // first appearance, the value just snaps in with no roll.
    if (remainingSeconds != s_lastValue) {
        const std::string now = formatTime(remainingSeconds);
        if (!animate || s_lastValue == 0x7fffffff) {
            s_from = s_to = now;
            s_anim = false;
        } else {
            s_from = formatTime(s_lastValue);
            s_to = now;
            s_animStart = GetTickCount();
            s_anim = (s_from != s_to);
        }
        s_lastValue = remainingSeconds;
    }
    if (!animate) s_anim = false; // stop any roll in progress when toggled off

    float t = 1.0f; // roll progress [0,1]
    if (s_anim) {
        const DWORD el = GetTickCount() - s_animStart;
        if (el >= kRollMs) s_anim = false;
        else t = (float)el / (float)kRollMs;
    }

    // Layout strings. While animating, right-align from/to to a common length so a
    // minute-rollover (e.g. "10:00" -> "9:59") still lines up column-for-column.
    std::string from, to;
    if (s_anim) {
        from = s_from; to = s_to;
        const size_t L = from.size() > to.size() ? from.size() : to.size();
        while (from.size() < L) from.insert(from.begin(), ' ');
        while (to.size() < L)   to.insert(to.begin(), ' ');
    } else {
        from = to = s_to; // settled: just the current value, no padding
    }
    const size_t L = to.size();

    // Total content width from the (equal-width) cells.
    float totalW = 0.0f;
    for (size_t i = 0; i < L; ++i) {
        const char wc = (to[i] != ' ') ? to[i] : from[i];
        totalW += cellWidthFor(wc);
    }

    // Badge box, top-right (matches the old static overlay's placement).
    const float padX = fontSize * 0.5f, padY = fontSize * 0.25f;
    const float boxW = totalW + padX * 2.0f, boxH = g_cellH + padY * 2.0f;
    const float margin = fontSize * 0.4f;
    const float boxX = cw - boxW - margin;
    const float boxY = margin;
    rt->FillRectangle(D2D1::RectF(boxX, boxY, boxX + boxW, boxY + boxH), bg);

    // Draw each cell; changed cells roll (old up / new in from below), clipped to
    // the cell so the moving glyphs vanish at the top and bottom edges.
    float x = boxX + padX;
    const float top = boxY + padY;
    for (size_t i = 0; i < L; ++i) {
        const char fc = from[i], tc = to[i];
        const char wc = (tc != ' ') ? tc : fc;
        const float cwid = cellWidthFor(wc);
        if (s_anim && fc != tc) {
            rt->PushAxisAlignedClip(D2D1::RectF(x, top, x + cwid, top + g_cellH),
                                    D2D1_ANTIALIAS_MODE_ALIASED);
            drawGlyph(rt, fc, x, top - t * g_cellH, fg);            // old slides up
            drawGlyph(rt, tc, x, top + (1.0f - t) * g_cellH, fg);  // new rises from below
            rt->PopAxisAlignedClip();
        } else {
            drawGlyph(rt, tc, x, top, fg);
        }
        x += cwid;
    }
    return s_anim;
}

} // namespace d2d
