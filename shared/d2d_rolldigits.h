// d2d_rolldigits.h - the "rolling"/odometer countdown overlay, kept out of the
// main renderer. Draws the remaining time as "m:ss" in a badge, and when the value
// changes each digit that changed rolls over: the old digit slides up and out of a
// clipped window while the new digit slides in from below. Only changed positions
// animate, so a plain seconds tick rolls only the seconds, while a minute rollover
// rolls those digits too.
#ifndef SSC_D2D_ROLLDIGITS_H
#define SSC_D2D_ROLLDIGITS_H

struct ID2D1RenderTarget;
struct ID2D1SolidColorBrush;
struct IDWriteFactory;

namespace d2d {

// Draws remainingSeconds as an "m:ss" badge in the top-right of the cw x ch client
// area. fontFrac is the font height as a fraction of ch. When `animate` is true a
// changed value rolls (odometer); when false the value updates instantly. Returns
// true while a roll animation is in progress, so the caller can keep repainting at
// ~60fps. The brushes/factory are the renderer's device-dependent resources.
bool drawRollingTime(ID2D1RenderTarget* rt, IDWriteFactory* dwrite,
                     ID2D1SolidColorBrush* bgBrush, ID2D1SolidColorBrush* fgBrush,
                     int remainingSeconds, float cw, float ch, float fontFrac,
                     bool animate);

// Forgets the last value so the next draw shows instantly (no roll from a stale
// value). Call while the overlay is hidden (remaining unknown / overlay off).
void resetRollingTime();

// Releases cached DirectWrite resources (call from the renderer's shutdown).
void shutdownRollingTime();

} // namespace d2d

#endif // SSC_D2D_ROLLDIGITS_H
