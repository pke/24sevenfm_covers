// Resolver-gated, retained metadata handoff (ADR 0008). Caller owns the lock.
#pragma once
#include <cstdint>
#include <string>

namespace ssc {
class InfoPresentation {
public:
    const std::wstring& title() const { return title_; }
    const std::wstring& artist() const { return artist_; }
    bool animating() const { return phase_ == Exiting || phase_ == Entering; }
    bool canonical() const { return canonical_; }

    void begin(const std::string& identity, std::uint32_t now, int fadeMs) {
        if (identity == identity_) return; // artwork retries/layout do not reset metadata
        const float alpha = advance(now, fadeMs);
        identity_ = identity;
        canonical_ = false;
        settled_ = false;
        nextTitle_.clear(); nextArtist_.clear();
        exit(alpha, now, fadeMs);
    }

    void settle(const std::wstring& title, const std::wstring& artist, bool canonical,
                std::uint32_t now, int fadeMs) {
        if (title.empty() || (canonical_ && !canonical)) return;
        const float alpha = advance(now, fadeMs);
        canonical_ = canonical_ || canonical;
        nextTitle_ = title; nextArtist_ = artist; settled_ = true;
        if ((phase_ == Visible || phase_ == Entering)
                && (title_ != title || artist_ != artist)) exit(alpha, now, fadeMs);
        if (phase_ == Waiting) reveal(now, fadeMs);
    }

    float advance(std::uint32_t now, int fadeMs) {
        if (phase_ == Exiting) {
            const auto elapsed = now - started_;
            if (fadeMs > 0 && elapsed < static_cast<std::uint32_t>(fadeMs))
                return exitFrom_ * (1.0f - static_cast<float>(elapsed) / fadeMs);
            title_.clear(); artist_.clear(); phase_ = Waiting;
            if (settled_) reveal(now, fadeMs);
        }
        if (phase_ == Entering) {
            const auto elapsed = now - started_;
            if (fadeMs > 0 && elapsed < static_cast<std::uint32_t>(fadeMs))
                return static_cast<float>(elapsed) / fadeMs;
            phase_ = Visible;
        }
        return phase_ == Visible ? 1.0f : 0.0f;
    }

private:
    enum Phase { Waiting, Exiting, Entering, Visible } phase_ = Waiting;
    void exit(float alpha, std::uint32_t now, int fadeMs) {
        if (!title_.empty() && alpha > 0.0f && fadeMs > 0) {
            phase_ = Exiting; started_ = now; exitFrom_ = alpha;
        } else {
            title_.clear(); artist_.clear(); phase_ = Waiting;
        }
    }
    void reveal(std::uint32_t now, int fadeMs) {
        title_ = nextTitle_; artist_ = nextArtist_;
        started_ = now; phase_ = fadeMs > 0 ? Entering : Visible;
    }
    std::string identity_;
    std::wstring title_, artist_, nextTitle_, nextArtist_;
    bool canonical_ = false, settled_ = false;
    std::uint32_t started_ = 0;
    float exitFrom_ = 1.0f;
};
} // namespace ssc
