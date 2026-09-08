#pragma once
#include <windows.h>
#include <functional>

namespace childfade {
// UI thread only. Same-sized sibling pages (or one page with new content).
// update runs synchronously; outgoing pixels remain in a temporary child surface
// until its opacity crossfade completes. No host manifest requirements.
// Returns whether a fade started; failure/reduced motion still shows incoming.
bool replace(HWND outgoing, HWND incoming, bool animate = true,
             const std::function<void()>& update = std::function<void()>());
}
