#pragma once
#include <algorithm>
#include <cmath>
namespace ssc {
enum class CountdownSizing { Fixed, ViewportRelative };
inline float countdownFontSize(float width, float height, float dpi, bool poster,
        int size, CountdownSizing sizing) {
    size = (std::max)(0, (std::min)(2, size));
    if (sizing == CountdownSizing::Fixed) {
        static const float points[] = {20, 32, 48};
        return points[size] * dpi;
    }
    // Existing Windows size choices, in the renderer's physical pixel space.
    // Poster uses the proposed cover side, not its animated/fitted rectangle.
    static const float fractions[] = {.048f, .062f, .080f};
    const float basis = poster ? (std::max)(1.f, (std::min)(height * .58f, width * .86f)) : height;
    return (std::max)(poster ? 12.f : 10.f, basis * fractions[size]);
}
struct PosterTypography { float coverSide, title, artist, track, padX, padY, lineGap; };
inline PosterTypography posterTypography(float width, float height) {
    const float side = (std::max)(1.0f, (std::min)(height * .58f, width * .86f));
    const float title = (std::max)(16.0f, side * .072f);
    const float artist = (std::max)(13.0f, side * .058f);
    return {side, title, artist, title * .88f, (std::max)(12.0f, side * .052f),
        (std::max)(8.0f, side * .035f), artist * .35f};
}
struct NextTypography { float label, album, artist, cover, gap, padX, padY; };
inline NextTypography nextTypography(float width, float dpi = 1) {
    const float album = (std::max)(13.6f * dpi, (std::min)(width * .02f, 16.8f * dpi));
    return {album * .76f, album, album * .9f, 56 * dpi, 10 * dpi, 13.6f * dpi, 10.4f * dpi};
}
struct NextCardSize { float width, height, textWidth; };
// Adapters measure complete, untrimmed lines with the same native layout they
// draw. Only the half-window limit may shrink that content; keep subpixel glyph
// rounding from introducing an ellipsis into a line that otherwise fits.
inline NextCardSize nextCardSize(float stageWidth, const NextTypography& font,
        float naturalTextWidth, float textHeight, float coverFraction = 1, float dpi = 1) {
    const float cover = font.cover * coverFraction;
    const float column = (font.cover + font.gap) * coverFraction;
    const float extra = font.padX * 2 + column;
    const float width = (std::min)((std::max)(1.0f, stageWidth * .5f),
        std::ceil((std::max)(0.0f, naturalTextWidth)) + 2 * dpi + extra);
    return {width, font.padY * 2 + (std::max)(cover, textHeight),
        (std::max)(1.0f, width - extra)};
}
struct TextTint { float red, green, blue; };
inline TextTint readableCoverTint(float r, float g, float b) {
    const float maximum = (std::max)(r, (std::max)(g, b));
    if (maximum < .02f) return {1, 1, 1};
    return {.35f + .65f * r / maximum, .35f + .65f * g / maximum, .35f + .65f * b / maximum};
}
// Position against the logical end edge; native adapters choose their coordinate origin.
inline float comingNextLeft(float stageWidth, float cardWidth, float margin, bool rtl) {
    return rtl ? margin : (std::max)(margin, stageWidth - margin - cardWidth);
}
}
