// image_key.h - content identity of encoded artwork, computed once per image.
// Pure logic, Win32-free (like window_rect.h), so it is unit-tested.
//
// Renderer caches used to be keyed by the complete encoded bytes, so every
// lookup of a settled frame compared megabytes (a 4K backdrop is 1-4 MB).
// ImageKey is a size + 64-bit hash: hashing runs once per ImageReference
// (ImageKeyCache remembers it by pointer identity), lookups are O(1).
// Artwork comes from the station feed and providers the client already trusts
// to supply the pictures it shows, so a non-cryptographic hash is sufficient.
#ifndef SSC_IMAGE_KEY_H
#define SSC_IMAGE_KEY_H

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <unordered_map>

namespace ssc {

struct ImageKey {
    std::uint64_t hash = 0;
    std::size_t size = 0;
    bool empty() const { return size == 0; }
    friend bool operator==(const ImageKey& a, const ImageKey& b) { return a.hash == b.hash && a.size == b.size; }
    friend bool operator!=(const ImageKey& a, const ImageKey& b) { return !(a == b); }
    friend bool operator<(const ImageKey& a, const ImageKey& b) {
        return a.hash < b.hash || (a.hash == b.hash && a.size < b.size);
    }
};

inline ImageKey imageKey(const char* data, std::size_t size) {
    std::uint64_t h = 0x9E3779B97F4A7C15ull ^ size;
    std::size_t i = 0;
    for (; i + 8 <= size; i += 8) {
        std::uint64_t word;
        std::memcpy(&word, data + i, 8);
        h ^= word;
        h *= 0xFF51AFD7ED558CCDull;
        h ^= h >> 33;
    }
    std::uint64_t tail = 0;
    if (i < size) std::memcpy(&tail, data + i, size - i);
    h ^= tail;
    h *= 0xC4CEB9FE1A85EC53ull;
    h ^= h >> 33;
    ImageKey key;
    key.hash = h;
    key.size = size;
    return key;
}
inline ImageKey imageKey(const std::string& bytes) { return imageKey(bytes.data(), bytes.size()); }

// Remembers the key of each live shared image. Identity is the control block:
// the cache holds a weak_ptr, so a recycled address can never alias an entry.
class ImageKeyCache {
public:
    using Reference = std::shared_ptr<const std::string>;
    ImageKey get(const Reference& image) {
        if (!image) return ImageKey();
        const auto found = entries_.find(image.get());
        if (found != entries_.end() && !found->second.owner.owner_before(image)
                && !image.owner_before(found->second.owner))
            return found->second.key;
        if (entries_.size() >= kPruneAt) prune();
        Entry entry;
        entry.owner = image;
        entry.key = imageKey(*image);
        ++hashes_;
        entries_[image.get()] = entry;
        return entry.key;
    }
    std::size_t hashes() const { return hashes_; } // number of full-content hashes performed
    std::size_t size() const { return entries_.size(); }
    void clear() { entries_.clear(); }
private:
    static const std::size_t kPruneAt = 256;
    struct Entry { std::weak_ptr<const std::string> owner; ImageKey key; };
    void prune() {
        for (auto it = entries_.begin(); it != entries_.end();)
            if (it->second.owner.expired()) it = entries_.erase(it); else ++it;
    }
    std::unordered_map<const std::string*, Entry> entries_;
    std::size_t hashes_ = 0;
};

} // namespace ssc

#endif // SSC_IMAGE_KEY_H
