// d2d_transitions.h - the cover-to-cover transition effects, kept out of the main
// renderer. Each transition is just "given the outgoing + incoming bitmaps and a
// progress in [0,1], draw the in-between frame into the render target". The
// renderer computes the progress (from the fade timer) and the overlays; this file
// owns only the animation between the two covers.
#ifndef SSC_D2D_TRANSITIONS_H
#define SSC_D2D_TRANSITIONS_H

struct ID2D1RenderTarget;
struct ID2D1Bitmap;

namespace d2d {

enum class Transition {
    Crossfade      = 0, // incoming fades in over the outgoing
    FlipHorizontal = 1, // card flip about the vertical axis (left/right)
    FlipVertical   = 2, // card flip about the horizontal axis (top/bottom)
};

// Draws one frame of a transition between `prev` (outgoing) and `cur` (incoming),
// aspect-fit + centred in the destination rect (x, y, w, h) - the whole client area
// in fill mode, or the centred cover rect in poster mode. progress in [0,1] (0 =
// fully showing prev, 1 = fully showing cur). Either bitmap may be null (e.g. the
// very first cover, or during device recreation). The caller has already cleared /
// painted the background and will draw overlays afterwards.
void drawTransition(ID2D1RenderTarget* rt, Transition type,
                    ID2D1Bitmap* prev, ID2D1Bitmap* cur,
                    float x, float y, float w, float h, float progress);

} // namespace d2d

#endif // SSC_D2D_TRANSITIONS_H
