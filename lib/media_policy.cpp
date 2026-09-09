#include "media_policy.h"

namespace ssc {

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
