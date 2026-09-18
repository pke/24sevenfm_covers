// The queue supplies content; the playback clock alone decides visibility.
#pragma once
#include "info_presentation.h"

namespace ssc {
struct ComingNextFrame {
    std::wstring album, artist;
    float opacity = 0.0f;
    bool operator!=(const ComingNextFrame& other) const {
        return album != other.album || artist != other.artist || opacity != other.opacity;
    }
};

class ComingNextPresentation {
public:
    void setQueue(const std::string& identity, const std::wstring& album,
                  const std::wstring& artist) {
        if (identity == identity_) return; // keep already normalized queue metadata
        identity_ = identity; album_ = album; artist_ = artist; canonical_ = false;
    }
    void resolve(const std::string& identity, const std::wstring& album,
                 const std::wstring& artist, bool canonical) {
        if (identity.empty() || identity != identity_ || album.empty()
                || (canonical_ && !canonical)) return;
        album_ = album; artist_ = artist; canonical_ = canonical_ || canonical;
    }
    ComingNextFrame advance(bool enabled, int remaining, std::uint32_t now, int fadeMs) {
        const bool visible = enabled && remaining >= 0 && remaining <= 10
            && !identity_.empty() && !album_.empty();
        content_.begin(visible ? identity_ : "", now, fadeMs);
        if (visible) content_.settle(album_, artist_, canonical_, now, fadeMs);
        ComingNextFrame frame;
        frame.opacity = content_.advance(now, fadeMs);
        frame.album = content_.title(); frame.artist = content_.artist();
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
    InfoPresentation content_{webEase}; // retain outgoing text through its slide/fade
};
} // namespace ssc
