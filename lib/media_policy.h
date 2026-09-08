// media_policy.h - small, platform-neutral pieces of the web/native parity
// contract.  Keeping cache identity and retry timings here makes the Windows
// engine and deterministic tests use the exact same rules.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

#include "coverfetch.h"
#include "media_resolver.h"

namespace ssc {

static const size_t kQueuedTrackStoreLimit = 64;
static const std::uint32_t kRatingTrackVisibleMs = 10000;
static const std::uint32_t kStageIdleMs = 2000;
static const std::uint32_t kRatingVisibilityFadeMs = 350;

// Native drawing coordinates are physical client pixels. Scale the web player's
// logical rating range by the target window DPI before deriving the logo height.
float ratingLogoHeight(float stageHeight, float dpiScale);

struct RatingLogoSize {
    float width;
    float height;
};

// Mirrors the web rating slot's `object-fit: contain`: preserve the bitmap's
// pixel aspect ratio inside one square slot instead of forcing every logo to the
// slot height (which made wide US MPA marks appear oversized beside FSK).
RatingLogoSize containRatingLogo(float pixelWidth, float pixelHeight, float slotSize);

// Keeps a measured poster info box inside the stage while preserving a minimum
// bottom margin. Inputs and output use the renderer's physical-pixel coordinate
// space; impossible fits (the box itself is taller than the stage) pin to zero.
float clampPosterInfoTop(float proposedTop, float infoHeight,
                         float stageHeight, float minimumBottomGap);

std::string mediaCacheKey(const TrackInfo& track, const MediaRequest& request);

// failure is one-based. A negative result means no automatic retry.
int coverRetryDelayMs(unsigned failure);
int backdropImageRetryDelayMs(unsigned failure);
int stationRetryDelayMs(unsigned failure);

// The first queued item is eligible immediately. Further items are admitted one
// per minute so provider traffic is bounded even when the feed returns a long queue.
long long queuePrefetchDelayMs(size_t queueIndex);

// Web parity: a new track's badges get a ten-second intro. Afterwards a windowed
// stage follows pointer hover, while fullscreen goes idle two seconds after the
// last movement. Unsigned subtraction intentionally keeps DWORD wraparound safe.
bool shouldShowRatings(std::uint32_t now, std::uint32_t introUntil,
                       bool pointerInside, bool fullscreenAutoHide,
                       std::uint32_t pointerVisibleUntil);

} // namespace ssc
