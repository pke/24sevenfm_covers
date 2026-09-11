#include "media_policy.h"

namespace ssc {

TitleLogoSize titleLogoSize(float pixelWidth, float pixelHeight, float stageWidth,
                           float stageHeight, float titleSize, float dpiScale) {
    if (dpiScale <= 0) dpiScale = 1;
    if (pixelWidth <= 0 || pixelHeight <= 0 || stageWidth <= 0 || stageHeight <= 0)
        return {0, 0, 0};
    float height = titleSize * 2.8f;
    if (height < 96 * dpiScale) height = 96 * dpiScale;
    if (height > 160 * dpiScale) height = 160 * dpiScale;
    if (height > stageHeight * .24f) height = stageHeight * .24f;
    float width = stageWidth * .72f;
    if (width > 512 * dpiScale) width = 512 * dpiScale;
    float scale = height / pixelHeight;
    if (scale > width / pixelWidth) scale = width / pixelWidth;
    if (scale > 1) scale = 1; // same intrinsic-size limit as the web canvas
    float row = titleSize * 1.3f;
    if (row < 40 * dpiScale) row = 40 * dpiScale;
    if (row > 72 * dpiScale) row = 72 * dpiScale;
    return {pixelWidth * scale, pixelHeight * scale, row};
}

float ratingLogoHeight(float stageHeight, float dpiScale) {
    if (dpiScale <= 0.0f) dpiScale = 1.0f;
    float fontSize = stageHeight / 24.0f;
    const float minimum = 12.0f * dpiScale;
    const float maximum = 30.0f * dpiScale;
    if (fontSize < minimum) fontSize = minimum;
    if (fontSize > maximum) fontSize = maximum;
    return fontSize * 2.35f;
}

RatingLogoSize containRatingLogo(float pixelWidth, float pixelHeight, float slotSize) {
    if (pixelWidth <= 0.0f || pixelHeight <= 0.0f || slotSize <= 0.0f)
        return {0.0f, 0.0f};
    const float scale = slotSize / (pixelWidth > pixelHeight ? pixelWidth : pixelHeight);
    return {pixelWidth * scale, pixelHeight * scale};
}

PosterCoverFit fitPortraitPosterCover(float proposedSide, float infoTop,
                                      float coverInfoGap, float minimumTopGap) {
    if (proposedSide < 1.0f) proposedSide = 1.0f;
    if (infoTop < 0.0f) infoTop = 0.0f;
    if (coverInfoGap < 0.0f) coverInfoGap = 0.0f;
    if (minimumTopGap < 0.0f) minimumTopGap = 0.0f;

    const float coverBottom = infoTop - coverInfoGap;
    const float available = coverBottom - minimumTopGap;
    if (available < 1.0f)
        return {1.0f, coverBottom > 1.0f ? coverBottom - 1.0f : 0.0f};

    const float side = proposedSide < available ? proposedSide : available;
    return {side, minimumTopGap + (available - side) * 0.5f};
}

float clampPosterInfoTop(float proposedTop, float infoHeight,
                         float stageHeight, float minimumBottomGap) {
    if (proposedTop < 0.0f) proposedTop = 0.0f;
    if (infoHeight < 0.0f) infoHeight = 0.0f;
    if (stageHeight < 0.0f) stageHeight = 0.0f;
    if (minimumBottomGap < 0.0f) minimumBottomGap = 0.0f;
    float maximumTop = stageHeight - minimumBottomGap - infoHeight;
    if (maximumTop < 0.0f) maximumTop = 0.0f;
    return proposedTop < maximumTop ? proposedTop : maximumTop;
}

namespace {
bool hasProvider(const std::string& csv, const char* wanted) {
    size_t begin = 0;
    while (begin <= csv.size()) {
        const size_t end = csv.find(',', begin);
        if (csv.substr(begin, end == std::string::npos
                ? std::string::npos : end - begin) == wanted) return true;
        if (end == std::string::npos) break;
        begin = end + 1;
    }
    return false;
}
} // namespace

std::string mediaCacheKey(const TrackInfo& track, const MediaRequest& request) {
    return track.album + "\n" + track.track + "\n" + track.artist + "\n"
        + request.providers + "\n" + request.ratingCountries + "\n"
        + (request.includeArt && hasProvider(request.providers, "fanart")
            ? request.fanartClientKey : std::string()) + "\n"
        + (request.includeArt ? "art" : "no-art") + "\n"
        + (request.includeArt && request.includeTitleLogo ? "logos" : "no-logos") + "\n"
        + (request.includeRatings ? "ratings" : "no-ratings") + "\n"
        + (wantsPortraitArtwork(request) ? "portrait" : "landscape") + "\n"
        + (wants4kArtwork(request) ? "4k" : "hd");
}

int coverRetryDelayMs(unsigned failure) {
    if (failure == 0) return 0;
    if (failure == 1) return 5000;
    if (failure == 2) return 10000;
    if (failure == 3) return 20000;
    return 300000;
}

int backdropImageRetryDelayMs(unsigned failure) {
    if (failure == 0) return 0;
    if (failure == 1) return 1000;
    if (failure == 2) return 2000;
    return -1;
}

int stationRetryDelayMs(unsigned failure) {
    // The web player restarts the short sequence after its one-minute attempt.
    switch ((failure ? failure - 1 : 0) % 4) {
    case 0: return 8000;
    case 1: return 16000;
    case 2: return 32000;
    default: return 60000;
    }
}

long long queuePrefetchDelayMs(size_t queueIndex) {
    return static_cast<long long>(queueIndex) * 60LL * 1000LL;
}

bool shouldShowRatings(std::uint32_t now, std::uint32_t introUntil,
                       bool pointerInside, bool fullscreenAutoHide,
                       std::uint32_t pointerVisibleUntil) {
    const bool intro = introUntil != 0
        && static_cast<std::int32_t>(now - introUntil) < 0;
    if (intro) return true;
    if (!pointerInside) return false;
    return !fullscreenAutoHide || (pointerVisibleUntil != 0
        && static_cast<std::int32_t>(now - pointerVisibleUntil) < 0);
}

} // namespace ssc
