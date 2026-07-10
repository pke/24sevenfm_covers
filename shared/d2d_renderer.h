// d2d_renderer.h - optional Direct2D (GPU-accelerated) render path for the cover
// window. Decodes JPEGs with WIC, draws with Direct2D (hardware bilinear scaling
// + per-bitmap opacity for the crossfade), and renders the countdown overlay with
// DirectWrite. All calls must happen on the window's thread (Winamp UI thread).
#ifndef SSC_D2D_RENDERER_H
#define SSC_D2D_RENDERER_H

#include <windows.h>
#include <cstddef>

#include "d2d_transitions.h" // Transition enum

namespace d2d {

// Creates the Direct2D / WIC / DirectWrite factories. Returns false if Direct2D
// is unavailable (very old Windows) - caller should then stay on GDI+.
bool init();
void shutdown();

// Discards the cached render target (but keeps the decoded cover bytes) so the
// next render() rebuilds it. Call when the target HWND changes - e.g. the host
// destroyed and recreated its window (foobar can recreate a UI element).
void resetTarget();

// Sets the current cover from JPEG bytes. If fadeFromCurrent and a cover is
// already shown, the current one becomes the outgoing image for a crossfade.
void setCover(const void* data, size_t len, bool fadeFromCurrent);

// Drops the outgoing cover once a crossfade has finished.
void endFade();

// Poster-background Gaussian blur strength (standard deviation, in the blur's ~240px
// working resolution). Persisted in the INI as "posterBlur" but not exposed in the UI.
// Changing it invalidates the cached blur so it regenerates on the next poster render.
void setPosterBlur(int standardDeviation);

// Renders hwnd's client area. `progress` in [0,1] drives the active transition
// between the outgoing and incoming covers (1 = settled on the incoming one);
// `transition` selects which effect. remainingSeconds < 0 hides the countdown
// overlay; overlayFontFrac is the overlay font height as a fraction of the client
// height (e.g. 1/12 large, 1/16 medium, 1/22 small). rollDigits animates the
// countdown (rolling digits) vs. an instant update. statusText (if
// non-null/non-empty) is drawn as a small badge bottom-right. Returns true while
// the countdown's rolling animation is in progress (keep repainting at ~60fps).
//
// layout: 0 = fill (cover fills the window + countdown overlay, transitions animate);
// 1 = poster (a heavily blurred cover fills the background, the sharp cover is drawn
// centered with margins, and a rounded info box below shows title + artist + the
// status). In poster mode `title`/`artist` are the info-box text (may be empty) and
// the countdown/transition are not used.
bool render(HWND hwnd, float progress, Transition transition, int remainingSeconds,
            float overlayFontFrac, bool rollDigits, const wchar_t* statusText,
            int layout, const wchar_t* title, const wchar_t* artist);

} // namespace d2d

#endif // SSC_D2D_RENDERER_H
