// d2d_transitions.cpp - see header. All drawing goes through the render target the
// renderer hands us; no device resources are owned here.
#include "d2d_transitions.h"

#include <d2d1.h>
#include <d2d1helper.h>

namespace d2d {
namespace {

// The aspect-fit + centred rectangle for a bitmap inside the dest rect (x,y,w,h).
D2D1_RECT_F fitRect(ID2D1Bitmap* bmp, float x, float y, float w, float h) {
    const D2D1_SIZE_F sz = bmp->GetSize();
    if (sz.width <= 0 || sz.height <= 0)
        return D2D1::RectF(x, y, x + w, y + h);
    const float s = (w / sz.width < h / sz.height) ? w / sz.width : h / sz.height;
    const float bw = sz.width * s, bh = sz.height * s;
    const float bx = x + (w - bw) / 2, by = y + (h - bh) / 2;
    return D2D1::RectF(bx, by, bx + bw, by + bh);
}

// Draws a fitted bitmap scaled about the dest-rect centre (sx/sy on each axis) at
// the given opacity, then restores the identity transform.
void drawScaled(ID2D1RenderTarget* rt, ID2D1Bitmap* bmp, float x, float y, float w, float h,
                float sx, float sy, float opacity) {
    if (!bmp) return;
    rt->SetTransform(D2D1::Matrix3x2F::Scale(sx, sy, D2D1::Point2F(x + w / 2.0f, y + h / 2.0f)));
    rt->DrawBitmap(bmp, fitRect(bmp, x, y, w, h), opacity, D2D1_BITMAP_INTERPOLATION_MODE_LINEAR);
    rt->SetTransform(D2D1::Matrix3x2F::Identity());
}

// A card flip: the outgoing cover shrinks to an edge-on line on the flip axis
// (progress 0 -> 0.5), then the incoming cover grows back from the line (0.5 -> 1),
// dimming toward the edge-on moment so the "turn" reads as 3D. Direct2D 1.0 only
// has affine transforms, so this scale-based flip approximates perspective.
void drawFlip(ID2D1RenderTarget* rt, bool horizontal, ID2D1Bitmap* prev, ID2D1Bitmap* cur,
              float x, float y, float w, float h, float p) {
    const bool showIncoming = p >= 0.5f;
    // f: 1 at a full face, 0 edge-on.
    const float f = showIncoming ? (p * 2.0f - 1.0f) : (1.0f - p * 2.0f);
    const float shade = 0.45f + 0.55f * f; // dim toward the edge-on seam
    ID2D1Bitmap* face = showIncoming ? cur : prev;
    if (!face) // nothing on this side (e.g. first cover) - let the background show
        return;
    drawScaled(rt, face, x, y, w, h, horizontal ? f : 1.0f, horizontal ? 1.0f : f, shade);
}

} // namespace

void drawTransition(ID2D1RenderTarget* rt, Transition type,
                    ID2D1Bitmap* prev, ID2D1Bitmap* cur,
                    float x, float y, float w, float h, float p) {
    if (!rt) return;
    if (p < 0.0f) p = 0.0f;
    if (p > 1.0f) p = 1.0f;

    // No outgoing cover (first image, or settled) -> just show the incoming one.
    if (!prev) {
        drawScaled(rt, cur, x, y, w, h, 1.0f, 1.0f, 1.0f);
        return;
    }

    switch (type) {
        case Transition::FlipHorizontal: drawFlip(rt, true,  prev, cur, x, y, w, h, p); break;
        case Transition::FlipVertical:   drawFlip(rt, false, prev, cur, x, y, w, h, p); break;
        case Transition::Crossfade:
        default:
            drawScaled(rt, prev, x, y, w, h, 1.0f, 1.0f, 1.0f); // outgoing underneath
            drawScaled(rt, cur,  x, y, w, h, 1.0f, 1.0f, p);    // incoming fades in
            break;
    }
}

} // namespace d2d
