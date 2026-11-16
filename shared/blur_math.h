// blur_math.h - inputs for the poster background blur. Pure logic, Win32-free
// (like window_rect.h), so it is unit-tested.
//
// The poster blur is a 240 x 240 image. It used to upload the full-resolution
// cover to an offscreen D2D device and blur it under a scale transform; D2D
// evaluates the Gaussian's standard deviation in *source* pixels there, so the
// visible blur at 240 px was sigma * 240 / sourceSize. The cover is now averaged
// down to 240 x 240 first (one linear pass over the cached pixels) and blurred
// with that equivalent working sigma: the same look at a fraction of the cost.
#ifndef SSC_BLUR_MATH_H
#define SSC_BLUR_MATH_H

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>
#if defined(_M_X64) || defined(_M_IX86) || defined(__SSE2__)
#include <emmintrin.h>
#define SSC_BLUR_SSE2 1
#endif

namespace ssc {

namespace detail {
// rowSum[i] += line[i] for i < count (16-bit lanes; a band holds at most 257 rows).
inline void addRow(std::uint16_t* rowSum, const std::uint8_t* line, std::size_t count) {
    std::size_t i = 0;
#if defined(SSC_BLUR_SSE2)
    const __m128i zero = _mm_setzero_si128();
    for (; i + 16 <= count; i += 16) {
        const __m128i v = _mm_loadu_si128(reinterpret_cast<const __m128i*>(line + i));
        __m128i* lo = reinterpret_cast<__m128i*>(rowSum + i);
        __m128i* hi = reinterpret_cast<__m128i*>(rowSum + i + 8);
        _mm_storeu_si128(lo, _mm_add_epi16(_mm_loadu_si128(lo), _mm_unpacklo_epi8(v, zero)));
        _mm_storeu_si128(hi, _mm_add_epi16(_mm_loadu_si128(hi), _mm_unpackhi_epi8(v, zero)));
    }
#endif
    for (; i < count; ++i) rowSum[i] = std::uint16_t(rowSum[i] + line[i]);
}
} // namespace detail

// Sigma at the working size that reproduces `sourceSigma` applied to a
// width x height source scaled to `working` x `working`.
inline float workingBlurSigma(float sourceSigma, unsigned width, unsigned height, unsigned working) {
    if (!width || !height || !working) return sourceSigma;
    const float scale = float(working) / std::sqrt(float(width) * float(height));
    return sourceSigma * scale;
}

// Box (area) average of tightly packed 4-channel pixels down to size x size.
// Every source pixel contributes to exactly one destination pixel. Requires
// width >= size and height >= size (callers upscale small covers differently).
inline std::vector<std::uint8_t> boxDownscale4(const std::uint8_t* pixels, unsigned width, unsigned height,
                                               unsigned size) {
    std::vector<std::uint8_t> out(std::size_t(size) * size * 4);
    if (!pixels || !size || width < size || height < size || height / size >= 257) return out;
    // Destination column c averages source columns [columnStart[c], columnStart[c + 1]).
    std::vector<unsigned> columnStart(size + 1);
    for (unsigned c = 0; c <= size; ++c) columnStart[c] = unsigned(std::uint64_t(c) * width / size);
    // Pass 1 sums the band's rows (long contiguous runs); pass 2 reduces each column.
    std::vector<std::uint16_t> rowSum(std::size_t(width) * 4);
    unsigned y = 0;
    for (unsigned row = 0; row < size; ++row) {
        const unsigned end = unsigned(std::uint64_t(row + 1) * height / size);
        const unsigned rows = end - y;
        std::fill(rowSum.begin(), rowSum.end(), std::uint16_t(0));
        for (; y < end; ++y) detail::addRow(rowSum.data(), pixels + std::size_t(y) * width * 4, rowSum.size());
        std::uint8_t* target = out.data() + std::size_t(row) * size * 4;
        for (unsigned c = 0; c < size; ++c) {
            std::uint32_t sum[4] = {0, 0, 0, 0};
            for (unsigned x = columnStart[c]; x < columnStart[c + 1]; ++x)
                for (int channel = 0; channel < 4; ++channel) sum[channel] += rowSum[std::size_t(x) * 4 + channel];
            const std::uint32_t count = (columnStart[c + 1] - columnStart[c]) * rows;
            for (int channel = 0; channel < 4; ++channel)
                target[c * 4 + channel] = std::uint8_t((sum[channel] + count / 2) / count);
        }
    }
    return out;
}

} // namespace ssc

#endif // SSC_BLUR_MATH_H
