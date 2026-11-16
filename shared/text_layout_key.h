// text_layout_key.h - cache key for a DirectWrite text layout. Pure logic,
// Win32-free, unit-tested.
//
// renderPoster/drawStatus used to create IDWriteTextFormat + IDWriteTextLayout
// objects on EVERY frame (at the heartbeat rate while the countdown or the
// loading badge was visible). A layout only depends on its text, wrap width and
// font size, so the renderer keeps the layout and rebuilds it only when this
// key reports a change - which happens on a track change or a window resize,
// not per frame.
#ifndef SSC_TEXT_LAYOUT_KEY_H
#define SSC_TEXT_LAYOUT_KEY_H

#include <string>

namespace d2d {

struct TextLayoutKey {
    std::wstring text;
    float width = -1.0f; // -1: never assigned -> differs() is true for any input
    float size  = -1.0f;

    // True when a layout built for this key would not match (text, w, s).
    bool differs(const wchar_t* t, float w, float s) const {
        return size != s || width != w || text.compare(t ? t : L"") != 0;
    }
    void assign(const wchar_t* t, float w, float s) {
        text = t ? t : L"";
        width = w;
        size = s;
    }
};

} // namespace d2d

#endif // SSC_TEXT_LAYOUT_KEY_H
