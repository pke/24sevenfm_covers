// Per-view presentation state. Call events and advance on the owning serial
// executor (or under the host's publication lock); drawing only reads FrameState.
// Native resources are addressed by shared immutable keys/bytes, never owned here.
#pragma once
#include "info_presentation.h"
#include "title_logo_presentation.h"
#include "coming_next.h"
#include "presentation_style.h"
#include <array>
#include <chrono>
#include <functional>
#include <vector>

namespace ssc {
using PresentationTime = std::uint64_t;
using ImageReference = std::shared_ptr<const std::string>;
inline float unit(float v) { return (std::max)(0.f, (std::min)(1.f, v)); }

class VisualTransition {
public:
    explicit VisualTransition(float value = 0) : from_(value), to_(value) {}
    float value(PresentationTime now) const {
        const float p = duration_ ? unit(float(now >= start_ ? now - start_ : 0) / duration_) : 1;
        if (p >= 1) return to_; // exact terminal value prevents a perpetual repaint from rounding
        return from_ + (to_ - from_) * p;
    }
    void set(float target, PresentationTime now, unsigned duration) {
        if (target == to_ && duration == duration_) return;
        from_ = value(now); to_ = target; start_ = now; duration_ = duration;
    }
    void reset(float value) { from_ = to_ = value; duration_ = 0; }
    bool active(PresentationTime now) const { return value(now) != to_; }
    float target() const { return to_; }
private:
    float from_, to_;
    PresentationTime start_ = 0;
    unsigned duration_ = 0;
};

struct ImageLayer {
    ImageReference image;
    float opacity = 0, scaleX = 1, scaleY = 1;
};

// Retains the complete visible mixture when interrupted. At the end, only the
// current reference remains. Opacities are converted to source-over at sampling.
class ArtworkPresentation {
public:
    explicit ArtworkPresentation(bool opaque = true) : opaque_(opaque) {}
    void set(ImageReference image, PresentationTime now, unsigned duration, int effect = 1, bool force = false) {
        if (!force && ((!image && !target_) || (image && target_ && *image == *target_))) return;
        sample(now);
        layers_ = sampled_;
        // Convert source-over opacity back to visible contribution.
        float transmission = 1;
        for (size_t i = opaque_ ? layers_.size() : 0; i-- > 0;) {
            const float alpha = layers_[i].opacity;
            layers_[i].opacity *= transmission; transmission *= 1 - alpha;
        }
        target_ = std::move(image); start_ = now; duration_ = duration;
        // Spatial interruption continues from the sampled transform, then gently
        // unfolds it; a fresh two-face flip would jump to an unrelated full face.
        effect_ = layers_.size() == 1 && layers_[0].scaleX == 1 && layers_[0].scaleY == 1 ? effect : 1;
        sample(now);
    }
    void retime(PresentationTime now, unsigned duration) {
        if (!active(now)) return;
        set(target_, now, duration, 1, true);
    }
    const std::vector<ImageLayer>& sample(PresentationTime now) {
        const float p = duration_ ? unit(float(now >= start_ ? now - start_ : 0) / duration_) : 1;
        sampled_.clear();
        if (p >= 1) {
            layers_.clear();
            if (target_) sampled_.push_back({target_, 1, 1, 1});
            return sampled_;
        }
        if ((effect_ == 2 || effect_ == 3) && !layers_.empty() && target_) {
            const float scale = std::abs(1 - p * 2);
            auto layer = p < .5f ? layers_.front() : ImageLayer{target_, 1, 1, 1};
            layer.opacity = .45f + .55f * scale;
            layer.scaleX = effect_ == 2 ? scale : 1;
            layer.scaleY = effect_ == 3 ? scale : 1;
            sampled_.push_back(layer); return sampled_;
        }
        float total = target_ ? p : 0;
        for (const auto& layer : layers_) total += layer.opacity*(1-p);
        float cumulative = 0;
        for (auto layer : layers_) {
            const float weight = layer.opacity * (1 - p);
            cumulative += weight;
            if (weight <= 0) continue;
            // Clearing fades the entire mixture; replacing keeps an opaque base.
            layer.opacity = opaque_ ? unit(weight / (std::max)(.000001f,1-total+cumulative)) : weight;
            layer.scaleX += (1 - layer.scaleX) * p;
            layer.scaleY += (1 - layer.scaleY) * p;
            sampled_.push_back(layer);
        }
        if (target_) sampled_.push_back({target_, p, 1, 1});
        return sampled_;
    }
    bool active(PresentationTime now) const { return duration_ && now - start_ < duration_; }
private:
    ImageReference target_;
    std::vector<ImageLayer> layers_, sampled_;
    PresentationTime start_ = 0;
    unsigned duration_ = 0;
    int effect_ = 1;
    bool opaque_;
};

struct DigitLayer { char digit = ' '; float opacity = 0, offset = 0; };
struct DigitColumn { std::vector<DigitLayer> layers; bool colon = false; };
struct CountdownFrame {
    std::vector<DigitColumn> columns;
    float opacity = 0, fontSize = 20;
    int seconds = -1;
};

class CountdownPresentation {
public:
    void set(int seconds, bool rolling, PresentationTime now, unsigned duration) {
        if (seconds < 0 || seconds == seconds_) return;
        sample(now);
        from_ = frame_.columns;
        seconds_ = seconds; start_ = now; duration_ = duration; rolling_ = rolling;
        to_ = std::to_string(seconds / 60) + ":" + (seconds % 60 < 10 ? "0" : "") + std::to_string(seconds % 60);
        const size_t count = (std::max)(from_.size(), to_.size());
        from_.insert(from_.begin(), count - from_.size(), DigitColumn{});
        to_.insert(to_.begin(), count - to_.size(), ' ');
        if (frame_.columns.empty()) duration_ = 0;
    }
    CountdownFrame sample(PresentationTime now) {
        const float p = duration_ ? unit(float(now >= start_ ? now - start_ : 0) / duration_) : 1;
        frame_.columns.clear(); frame_.seconds = seconds_;
        for (size_t i = 0; i < to_.size(); ++i) {
            DigitColumn column; column.colon = to_[i] == ':';
            if (p == 1 || (from_[i].layers.size() == 1 && from_[i].layers[0].digit == to_[i]
                    && from_[i].layers[0].offset == 0 && from_[i].layers[0].opacity == 1)) {
                column.layers.push_back({to_[i], 1, 0});
            } else {
                for (auto layer : from_[i].layers) {
                    layer.opacity *= 1 - p; if (rolling_) layer.offset -= p;
                    if (layer.opacity > 0) column.layers.push_back(layer);
                }
                column.layers.push_back({to_[i], p, rolling_ ? 1 - p : 0});
            }
            frame_.columns.push_back(std::move(column));
        }
        return frame_;
    }
    bool active(PresentationTime now) const { return duration_ && now - start_ < duration_; }
    void finish() { duration_ = 0; }
private:
    CountdownFrame frame_;
    std::vector<DigitColumn> from_;
    std::string to_;
    int seconds_ = -1;
    PresentationTime start_ = 0;
    unsigned duration_ = 0;
    bool rolling_ = false;
};

struct PresentationSettings {
    bool reducedMotion = false, poster = false, countdown = false, rolling = false;
    bool next = false, ratings = false, hideCover = true;
    int effect = 1, fadeMs = 1000, countdownSize = 0, blur = 24, radius = 45;
    CountdownSizing countdownSizing = CountdownSizing::Fixed;
};
struct PresentationRect { float x = 0, y = 0, width = 0, height = 0; };
enum class VisualChannel { Poster, CountdownOpacity, CountdownSize, CoverOpacity,
    RatingOpacity, RatingContent, Controls, InfoWidth, InfoHeight, NextWidth, NextHeight, NextCover, Count };
struct FrameState {
    std::vector<ImageLayer> cover, backdrop, blurredCover, ratings;
    std::wstring title, artist, album, track, logoAlbum;
    std::string logo;
    float infoOpacity = 0, logoOpacity = 0, logoLayout = 0;
    float poster = 0, coverOpacity = 1, ratingOpacity = 0, ratingContent = 1, controlsOpacity = 0;
    float infoWidth = 0, infoHeight = 0, nextWidth = 0, nextHeight = 0;
    float nextCoverLayout = 0;
    float blur = 24, radius = 45;
    CountdownFrame countdown;
    ComingNextFrame next;
    // All rectangles use a top-left origin. AppKit converts at the boundary.
    PresentationRect coverRect, infoRect, countdownRect, nextRect, clip;
    bool animating = false;
};

class PresentationController {
public:
    using Clock = std::function<PresentationTime()>;
    explicit PresentationController(Clock clock = [] {
        return PresentationTime(std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count());
    }) : clock_(std::move(clock)) {
        channel(VisualChannel::CoverOpacity).reset(1);
        channel(VisualChannel::CountdownSize).reset(20);
        channel(VisualChannel::RatingContent).reset(1);
    }
    // Compatibility ingress for resolver publishers already serialized by their
    // host. New adapters use trackChanged/resolverCompleted with operation tokens.
    InfoPresentation info;
    ComingNextPresentation comingNext;
    TitleLogoPresentation logo;
    PresentationTime time() { lastNow_ = (std::max)(lastNow_, clock_()); return lastNow_; }
    VisualTransition& channel(VisualChannel c) { return channels_[size_t(c)]; }
    const FrameState& frame() const { return frame_; }
    unsigned duration() const { return settings_.reducedMotion ? 0 : settings_.effect == 0 ? 120 : (std::max)(120, settings_.fadeMs); }
    unsigned motion(unsigned ms) const { return settings_.reducedMotion ? 0 : ms; }
    std::uint64_t trackChanged(const std::string& identity) {
        if (identity == identity_) return generation_;
        const auto now = time(); observeIdentity(identity);
        info.begin(identity, std::uint32_t(now), duration());
        return generation_;
    }
    void observeIdentity(const std::string& identity) {
        if (identity == identity_) return;
        identity_ = identity; ++generation_; introUntil_ = time() + kRatingTrackVisibleMs;
    }
    // An option/request change invalidates pending operations without changing
    // the track or its countdown/intro. Same-track replies must use this token.
    std::uint64_t newOperation() { return ++generation_; }
    bool accepts(std::uint64_t token) const { return token == generation_; }
    bool resolverCompleted(std::uint64_t token, const std::wstring& title, const std::wstring& artist,
            const std::wstring& album, const std::wstring& track, bool canonical) {
        if (!accepts(token)) return false;
        info.settle(title, artist, canonical, std::uint32_t(time()), duration(), album, track); return true;
    }
    bool assetReady(std::uint64_t token, ImageReference image, bool backdrop = false) {
        if (!accepts(token)) return false;
        setArtwork(std::move(image), backdrop);
        return true;
    }
    void setArtwork(ImageReference image, bool backdrop = false) {
        if (!backdrop) backgroundCover_.set(image, time(), duration(), 1);
        (backdrop ? backdrop_ : cover_).set(std::move(image), time(), duration(), backdrop ? 1 : settings_.effect);
    }
    void setLogo(const std::string& bytes, const std::wstring& album) {
        logo.set(bytes, album, std::uint32_t(time()), duration());
    }
    void settingsChanged(const PresentationSettings& settings) {
        const auto now = time(); const unsigned oldDuration = duration();
        const bool changedMotion = settings.reducedMotion != settings_.reducedMotion; settings_ = settings;
        if (duration() != oldDuration) { cover_.retime(now, duration()); backdrop_.retime(now, duration()); backgroundCover_.retime(now,duration()); }
        if (changedMotion) ratingContent_.retime(now,motion(kRatingVisibilityFadeMs));
        channel(VisualChannel::Poster).set(settings.poster ? 1.f : 0.f, now, motion(350));
        updateCountdownSize();
        if (settings.reducedMotion) countdown_.finish();
    }
    void remainingChanged(int remaining) { remaining_ = remaining; }
    void pointerChanged(bool inside, bool fullscreen, bool moved) {
        inside_ = inside; fullscreen_ = fullscreen;
        if (moved) pointerUntil_ = time() + kStageIdleMs;
    }
    void ratingsChanged(bool present, bool contentChanged = true) {
        hasRatings_ = present;
        if (contentChanged) { auto& c = channel(VisualChannel::RatingContent); c.reset(0); c.set(1, time(), motion(kRatingVisibilityFadeMs)); }
    }
    void setRatingContent(ImageReference content) {
        hasRatings_ = bool(content);
        ratingContent_.set(std::move(content), time(), motion(kRatingVisibilityFadeMs));
    }
    void backdropChanged(bool present) { hasBackdrop_ = present; }
    void measured(VisualChannel dimension, float target, unsigned ms = 350) {
        auto& c = channel(dimension);
        if (c.target() == 0) c.reset(target);
        else c.set(target, time(), motion(ms));
    }
    // Native adapters supply untrimmed text metrics only. Measure the final
    // content, never a sampled opacity: a moving target continually restarts the
    // size transition and makes the card chase its own cover fade.
    void measuredNext(float textWidth, float textHeight) {
        const auto card = nextCardSize(width_, nextTypography(width_, dpi_), textWidth,
            textHeight, frame_.next.cover ? 1.f : 0.f, dpi_);
        const auto now = time();
        const auto set = [&](VisualChannel dimension, float target) {
            auto& c = channel(dimension);
            // Prepare the complete geometry offscreen, before the first visible
            // frame. Late content changes while visible still animate once.
            if (frame_.next.opacity == 0) c.reset(target);
            else c.set(target, now, motion(kComingNextTransitionMs));
        };
        set(VisualChannel::NextWidth, card.width);
        set(VisualChannel::NextHeight, card.height);
        set(VisualChannel::NextCover, frame_.next.cover ? 1.f : 0.f);
    }
    void viewportChanged(float width, float height, float dpi = 1, bool rtl = false) {
        width_ = (std::max)(1.f, width); height_ = (std::max)(1.f, height); dpi_ = dpi; rtl_ = rtl;
        updateCountdownSize();
    }
    const FrameState& advance() {
        const auto now = time();
        frame_.cover = cover_.sample(now); frame_.backdrop = backdrop_.sample(now);
        frame_.blurredCover = backgroundCover_.sample(now);
        frame_.ratings = ratingContent_.sample(now);
        const auto tick = std::uint32_t(now);
        frame_.infoOpacity = info.advance(tick, duration());
        frame_.title = info.title(); frame_.artist = info.artist(); frame_.album = info.album(); frame_.track = info.track();
        frame_.logoOpacity = logo.advance(tick, duration()); frame_.logo = logo.bytes(); frame_.logoAlbum = logo.album();
        frame_.logoLayout = logoLayout_.advance(settings_.poster && !frame_.logo.empty()
            && frame_.logoAlbum == frame_.album && frame_.logoOpacity >= 1, tick, motion(350));
        frame_.next = comingNext.advance(settings_.next, remaining_, tick, motion(kComingNextTransitionMs));
        countdown_.set(remaining_, settings_.rolling, now, motion(350));
        channel(VisualChannel::CountdownOpacity).set(settings_.countdown && remaining_ >= 0 ? 1.f : 0.f, now, motion(350));
        channel(VisualChannel::CoverOpacity).set(hasBackdrop_ && settings_.hideCover ? 0.f : 1.f, now, motion(350));
        channel(VisualChannel::RatingOpacity).set(settings_.ratings && hasRatings_
            && (now < introUntil_ || (inside_ && (!fullscreen_ || now < pointerUntil_))) ? 1.f : 0.f, now, motion(kRatingVisibilityFadeMs));
        channel(VisualChannel::Controls).set(now < pointerUntil_ ? 1.f : 0.f, now, motion(kRatingVisibilityFadeMs));
        frame_.countdown = countdown_.sample(now);
        frame_.countdown.opacity = channel(VisualChannel::CountdownOpacity).value(now);
        frame_.countdown.fontSize = channel(VisualChannel::CountdownSize).value(now);
        frame_.poster = channel(VisualChannel::Poster).value(now);
        frame_.coverOpacity = channel(VisualChannel::CoverOpacity).value(now);
        frame_.ratingOpacity = channel(VisualChannel::RatingOpacity).value(now);
        frame_.ratingContent = channel(VisualChannel::RatingContent).value(now);
        frame_.controlsOpacity = channel(VisualChannel::Controls).value(now);
        frame_.infoWidth = channel(VisualChannel::InfoWidth).value(now); frame_.infoHeight = channel(VisualChannel::InfoHeight).value(now);
        frame_.nextWidth = channel(VisualChannel::NextWidth).value(now); frame_.nextHeight = channel(VisualChannel::NextHeight).value(now);
        frame_.nextCoverLayout = channel(VisualChannel::NextCover).value(now);
        frame_.blur = float(settings_.blur); frame_.radius = float(settings_.radius);
        layout();
        // Retain the countdown's time/state while hidden, but only visible
        // digit motion can invalidate the presentation. The opacity channel
        // below still drives the complete entrance/exit transition.
        frame_.animating = cover_.active(now) || backdrop_.active(now) || ratingContent_.active(now)
            || (frame_.countdown.opacity > 0 && countdown_.active(now))
            || info.animating() || logo.animating() || logoLayout_.animating() || comingNext.animating();
        for (const auto& c : channels_) frame_.animating = frame_.animating || c.active(now);
        return frame_;
    }
private:
    void updateCountdownSize() {
        channel(VisualChannel::CountdownSize).set(countdownFontSize(width_, height_, dpi_,
            settings_.poster, settings_.countdownSize, settings_.countdownSizing), time(), motion(350));
    }
    void layout() {
        const float p = frame_.poster, minSide = (std::min)(width_, height_);
        const auto font = posterTypography(width_,height_);
        const float margin = (std::max)(12.f*dpi_, minSide*.06f);
        const float gap = (std::max)(4.f*dpi_, minSide*.016f);
        const float countHeight = (frame_.countdown.fontSize*1.4f+8*dpi_)*frame_.countdown.opacity;
        const float boxH = frame_.infoHeight+countHeight;
        const float boxW = (std::min)(width_*.86f,frame_.infoWidth);
        const float boxY = (std::max)(0.f,height_-margin-boxH);
        frame_.infoRect = {(width_-boxW)*.5f,boxY,boxW,boxH};
        const auto fit = fitPortraitPosterCover(font.coverSide,boxY,gap,margin);
        frame_.coverRect = {(width_-fit.side)*.5f*p,fit.top*p,
            width_+(fit.side-width_)*p,height_+(fit.side-height_)*p};
        const float countW = frame_.countdown.fontSize*4.5f, countH = frame_.countdown.fontSize*1.4f;
        frame_.countdownRect = {(width_-countW-16*dpi_)*(1-p)+(width_-countW)*.5f*p,
            14*dpi_*(1-p)+(boxY+boxH-countH-12*dpi_)*p,countW,countH};
        const float top = 14*dpi_+(countH+16*dpi_)*(1-p)*frame_.countdown.opacity;
        const float offset = (1-frame_.next.opacity)*(frame_.nextWidth+14*dpi_)*(rtl_?-1:1);
        frame_.nextRect = {comingNextLeft(width_,frame_.nextWidth,14*dpi_,rtl_)+offset,
            top,frame_.nextWidth,frame_.nextHeight};
        frame_.clip = {0,0,width_,height_};
    }
    Clock clock_;
    PresentationTime lastNow_ = 0, introUntil_ = 0, pointerUntil_ = 0;
    std::uint64_t generation_ = 0;
    std::string identity_;
    PresentationSettings settings_;
    ArtworkPresentation cover_, backdrop_, backgroundCover_;
    ArtworkPresentation ratingContent_{false};
    CountdownPresentation countdown_;
    TitleLogoLayout logoLayout_;
    std::array<VisualTransition, size_t(VisualChannel::Count)> channels_;
    FrameState frame_;
    int remaining_ = -1;
    float width_ = 1, height_ = 1, dpi_ = 1;
    bool rtl_ = false;
    bool inside_ = false, fullscreen_ = false, hasRatings_ = false, hasBackdrop_ = false;
};
} // namespace ssc
