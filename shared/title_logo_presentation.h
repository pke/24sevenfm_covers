// Retain outgoing artwork through its exit; rapid toggles continue from current opacity.
#pragma once
#include <cstdint>
#include <string>

namespace ssc {
class TitleLogoPresentation {
public:
    const std::string& bytes() const { return bytes_; }
    const std::wstring& album() const { return album_; }
    bool animating() const { return phase_ == Entering || phase_ == Exiting; }

    void set(const std::string& bytes, const std::wstring& album, std::uint32_t now, int fadeMs) {
        const float alpha = advance(now, fadeMs);
        if (bytes == nextBytes_ && album == nextAlbum_) return;
        nextBytes_ = bytes; nextAlbum_ = album;
        if (bytes == bytes_ && album == album_) {
            phase_ = bytes.empty() ? Hidden : Entering;
            from_ = alpha; started_ = now;
        } else if (!bytes_.empty() && alpha > 0 && fadeMs > 0) {
            phase_ = Exiting; from_ = alpha; started_ = now;
        } else reveal(now, fadeMs);
    }

    float advance(std::uint32_t now, int fadeMs) {
        const auto elapsed = now - started_;
        const float progress = fadeMs > 0 && elapsed < static_cast<std::uint32_t>(fadeMs)
            ? static_cast<float>(elapsed) / fadeMs : 1.0f;
        if (phase_ == Exiting) {
            if (progress < 1) return from_ * (1 - progress);
            reveal(now, fadeMs);
            return phase_ == Entering ? 0.0f : phase_ == Visible ? 1.0f : 0.0f;
        }
        if (phase_ == Entering) {
            if (progress < 1) return from_ + (1 - from_) * progress;
            phase_ = Visible;
        }
        return phase_ == Visible ? 1.0f : 0.0f;
    }
private:
    enum Phase { Hidden, Entering, Visible, Exiting } phase_ = Hidden;
    void reveal(std::uint32_t now, int fadeMs) {
        bytes_ = nextBytes_; album_ = nextAlbum_; started_ = now; from_ = 0;
        phase_ = bytes_.empty() ? Hidden : fadeMs > 0 ? Entering : Visible;
    }
    std::string bytes_, nextBytes_;
    std::wstring album_, nextAlbum_;
    std::uint32_t started_ = 0;
    float from_ = 0;
};
}
