// The queue supplies content; the playback clock alone decides visibility.
#pragma once
#include "info_presentation.h"
#include "../lib/media_policy.h"
#include <memory>

namespace ssc {
struct ComingNextFrame {
    std::wstring album, artist;
    float opacity = 0.0f;
    std::shared_ptr<const std::string> cover;
    float coverOpacity = 0.0f;
    bool operator!=(const ComingNextFrame& other) const {
        return album != other.album || artist != other.artist || opacity != other.opacity
            || cover != other.cover || coverOpacity != other.coverOpacity;
    }
};

class ComingNextPresentation {
public:
    bool animating() const { return content_.animating() || coverAnimating_; }
    void setQueue(const std::string& identity, const std::wstring& album,
                  const std::wstring& artist) {
        if (identity == identity_) return; // keep already normalized queue metadata
        identity_ = identity; album_ = album; artist_ = artist; canonical_ = false; nextCover_.reset();
    }
    void setCover(const std::string& identity, const std::string& bytes) {
        if (identity != identity_ || bytes.empty() || (nextCover_ && *nextCover_ == bytes)) return;
        nextCover_ = std::make_shared<const std::string>(bytes);
    }
    void resolve(const std::string& identity, const std::wstring& album,
                 const std::wstring& artist, bool canonical) {
        if (identity.empty() || identity != identity_ || album.empty()
                || (canonical_ && !canonical)) return;
        album_ = album; artist_ = artist; canonical_ = canonical_ || canonical;
    }
    ComingNextFrame advance(bool enabled, int remaining, std::uint32_t now, int fadeMs) {
        const bool visible = enabled && remaining >= 0 && remaining <= kComingNextVisibleSeconds
            && !identity_.empty() && !album_.empty();
        content_.begin(visible ? identity_ : "", now, fadeMs);
        if (visible) content_.settle(album_, artist_, canonical_, now, fadeMs);
        ComingNextFrame frame;
        frame.opacity = content_.advance(now, fadeMs);
        frame.album = content_.title(); frame.artist = content_.artist();
        if (content_.displayedIdentity() == identity_ && visibleCover_ != nextCover_) {
            visibleCover_ = nextCover_; coverStarted_ = now;
        }
        frame.cover = visibleCover_;
        const auto elapsed = now - coverStarted_;
        frame.coverOpacity = fadeMs > 0 && elapsed < static_cast<std::uint32_t>(fadeMs)
            ? static_cast<float>(elapsed) / fadeMs : 1.0f;
        coverAnimating_ = frame.coverOpacity < 1 && bool(frame.cover);
        if (frame.opacity == 0 && !content_.animating() && frame.album.empty()) {
            visibleCover_.reset(); frame.cover.reset(); coverAnimating_ = false;
        }
        return frame;
    }
private:
    // CSS ease: cubic-bezier(.25, .1, .25, 1), shared by the web card's
    // opacity and horizontal translation. Solve x(t) before evaluating y(t).
    static float webEase(float progress) {
        if (progress <= 0.0f || progress >= 1.0f) return progress;
        float lo = 0.0f, hi = 1.0f;
        for (int i = 0; i < 18; ++i) {
            const float t = (lo + hi) * .5f, u = 1.0f - t;
            const float x = .75f * u * u * t + .75f * u * t * t + t * t * t;
            if (x < progress) lo = t; else hi = t;
        }
        const float t = (lo + hi) * .5f, u = 1.0f - t;
        return .3f * u * u * t + 3.0f * u * t * t + t * t * t;
    }
    std::string identity_;
    std::wstring album_, artist_;
    bool canonical_ = false;
    bool coverAnimating_ = false;
    std::shared_ptr<const std::string> nextCover_, visibleCover_;
    std::uint32_t coverStarted_ = 0;
    InfoPresentation content_{webEase}; // retain outgoing text through its slide/fade
};
} // namespace ssc
