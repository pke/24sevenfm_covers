// decoded_pixels.h - hands pixels decoded during validation to the renderer.
//
// Every downloaded image is validated by fully decoding it on a worker thread
// (image_probe.cpp), because truncated data must never reach the UI. The renderer
// then decoded the very same bytes again, synchronously inside WM_PAINT: ~200 ms on
// the UI thread for a 4K backdrop. Validation now deposits its premultiplied BGRA
// pixels here and the renderer takes them on its next cache miss. Bounded and
// thread-safe; anything evicted or never deposited simply decodes as before.
// Header-only (function-local statics are shared program-wide), so every host
// build picks it up without new translation units.
#ifndef SSC_DECODED_PIXELS_H
#define SSC_DECODED_PIXELS_H

#include "../shared/image_key.h"
#include <cstddef>
#include <list>
#include <mutex>
#include <vector>

namespace ssc {

struct DecodedPixels {
    ImageKey key;
    unsigned width = 0, height = 0;
    std::vector<unsigned char> bgra; // tightly packed, premultiplied BGRA
};

namespace detail {
struct DecodedPixelStore {
    // One 4K image plus a few covers/logos: prefetched queue artwork must not grow
    // a 32-bit host's address space without bound.
    static const std::size_t kBudget = 48u * 1024u * 1024u;
    static const std::size_t kEntries = 6;
    std::mutex mutex;
    std::list<DecodedPixels> entries; // most recent first
    std::size_t bytes = 0;
};
inline DecodedPixelStore& decodedPixelStore() { static DecodedPixelStore store; return store; }
} // namespace detail

inline void depositDecodedPixels(DecodedPixels pixels) {
    auto& store = detail::decodedPixelStore();
    const std::size_t cost = pixels.bgra.size();
    if (pixels.key.empty() || !cost || cost > store.kBudget) return;
    std::lock_guard<std::mutex> lock(store.mutex);
    for (auto it = store.entries.begin(); it != store.entries.end(); ++it)
        if (it->key == pixels.key) { store.bytes -= it->bgra.size(); store.entries.erase(it); break; }
    while (!store.entries.empty() && (store.entries.size() >= store.kEntries || store.bytes + cost > store.kBudget)) {
        store.bytes -= store.entries.back().bgra.size();
        store.entries.pop_back();
    }
    store.bytes += cost;
    store.entries.push_front(std::move(pixels));
}

// Moves the pixels for `key` out of the store; false if none were deposited.
inline bool takeDecodedPixels(const ImageKey& key, DecodedPixels& out) {
    auto& store = detail::decodedPixelStore();
    std::lock_guard<std::mutex> lock(store.mutex);
    for (auto it = store.entries.begin(); it != store.entries.end(); ++it) {
        if (it->key != key) continue;
        store.bytes -= it->bgra.size();
        out = std::move(*it);
        store.entries.erase(it);
        return true;
    }
    return false;
}

inline std::size_t decodedPixelStoreBytes() {
    auto& store = detail::decodedPixelStore();
    std::lock_guard<std::mutex> lock(store.mutex);
    return store.bytes;
}

} // namespace ssc

#endif // SSC_DECODED_PIXELS_H
