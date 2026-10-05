#pragma once
#include <cstddef>
#include <vector>
namespace ssc {
constexpr unsigned kLogoScanMaximum = 1600;
struct AlphaBounds { unsigned left, top, right, bottom; };
// RGBA and BGRA share the same alpha position. Faint provider padding is not
// part of the visible title logo; both host decoders use the same threshold.
inline AlphaBounds visibleAlphaBounds(const unsigned char* pixels, unsigned width,
    unsigned height, std::size_t stride) {
    AlphaBounds bounds{width, height, 0, 0};
    if (!pixels) return bounds;
    for (unsigned y = 0; y < height; ++y) for (unsigned x = 0; x < width; ++x) {
        if (pixels[y * stride + x * 4 + 3] < 16) continue;
        if (x < bounds.left) bounds.left = x;
        if (x + 1 > bounds.right) bounds.right = x + 1;
        if (y < bounds.top) bounds.top = y;
        if (y + 1 > bounds.bottom) bounds.bottom = y + 1;
    }
    return bounds;
}
// Centre the substantial lettering rather than a thin decorative flare (e.g.
// the line extending to the right of Dune: Part Two). The complete alpha bounds
// are still decoded/drawn: this is an anchor inside that crop, not a new crop.
inline float titleLogoHorizontalAnchor(const unsigned char* pixels, unsigned width,
    unsigned height, std::size_t stride, const AlphaBounds& bounds) {
    if (!pixels || bounds.right <= bounds.left || bounds.bottom <= bounds.top
        || bounds.right > width || bounds.bottom > height) return .5f;
    std::vector<unsigned> columns(bounds.right - bounds.left, 0);
    unsigned maximum = 0;
    for (unsigned x = bounds.left; x < bounds.right; ++x) {
        unsigned count = 0;
        for (unsigned y = bounds.top; y < bounds.bottom; ++y)
            if (pixels[y * stride + x * 4 + 3] >= 16) ++count;
        columns[x - bounds.left] = count;
        if (count > maximum) maximum = count;
    }
    if (!maximum) return .5f;
    const unsigned minimum = (maximum * 15 + 99) / 100;
    unsigned left = 0, right = static_cast<unsigned>(columns.size());
    while (left < right && columns[left] < minimum) ++left;
    while (right > left && columns[right - 1] < minimum) --right;
    // Do not let a small isolated emblem displace an otherwise wide logo.
    if ((right - left) * 2 < columns.size()) return .5f;
    float anchor = (left + right) * .5f / columns.size();
    if (anchor > .48f && anchor < .52f) return .5f;
    // The 72%-of-stage logo width leaves enough room for this bounded shift.
    return anchor < .375f ? .375f : anchor > .625f ? .625f : anchor;
}
}
