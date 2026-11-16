// blur_math.h - sigma math for the poster background blur. Pure, Win32-free,
// unit-tested.
//
// generateBlur used to feed the FULL-RESOLUTION cover into the Gaussian effect
// and only scale the result down to the working resolution afterwards - paying
// for a blur over 500x500 (or WARP/CPU on machines without hardware D2D) when
// only a 240x240 background is ever shown. The input is now pre-scaled to the
// working resolution first. Gaussian blur commutes with scaling when the sigma
// is scaled by the same factor - blur(sigma) then scale-by-k looks like
// scale-by-k then blur(sigma*k) - so this keeps the shipped look identical.
#ifndef SSC_BLUR_MATH_H
#define SSC_BLUR_MATH_H

namespace d2d {

// The sigma to pass to the Gaussian effect when its input was pre-scaled from
// srcSide px (the cover's width) down to workingRes px. `configured` is the raw
// INI "posterBlur" value, clamped to the renderer's historical 0..200 range.
// Degenerate sizes (unknown source/working res) fall back to the clamped value.
inline float blurSigmaForScaledInput(int configured, float srcSide, unsigned workingRes) {
    float dev = static_cast<float>(configured);
    if (dev < 0.0f) dev = 0.0f;
    else if (dev > 200.0f) dev = 200.0f;
    if (srcSide <= 0.0f || workingRes == 0) return dev;
    return dev * (static_cast<float>(workingRes) / srcSide);
}

} // namespace d2d

#endif // SSC_BLUR_MATH_H
