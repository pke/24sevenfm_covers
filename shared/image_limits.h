// image_limits.h - guard rails for decoding UNTRUSTED cover images.
//
// A hostile/compromised station could serve a perfectly valid image file whose
// header declares enormous dimensions (e.g. 65500x65500) - a decompression bomb
// that forces a multi-gigapixel decode + allocation on the player's UI thread
// from one poll. Real covers are ~500px, so we cap the accepted size well above
// any legitimate art but far below a bomb, checking the header-reported size
// (cheap - no pixel decode) before handing the frame to the decoder.
//
// Header-only and dependency-free so the Direct2D renderer and the unit tests
// share the EXACT same policy (the test feeds a crafted oversized image through
// real WIC and asserts this function rejects it).
#ifndef SSC_IMAGE_LIMITS_H
#define SSC_IMAGE_LIMITS_H

namespace ssc {

// Largest cover dimension, per axis, we are willing to decode.
static const unsigned kMaxCoverDim = 4096;

// True if an image of width x height pixels is safe to decode. Rejects empty
// frames and anything larger than kMaxCoverDim on either axis (which also bounds
// the total pixel count to kMaxCoverDim^2, no multiply/overflow needed).
inline bool coverDimsOk(unsigned width, unsigned height) {
    return width > 0 && height > 0 && width <= kMaxCoverDim && height <= kMaxCoverDim;
}

} // namespace ssc

#endif // SSC_IMAGE_LIMITS_H
