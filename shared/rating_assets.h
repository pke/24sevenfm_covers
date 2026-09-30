#pragma once

#include "../lib/media_resolver.h"
#include "../lib/rating_asset_paths.h"
#include <map>
#include <mutex>

namespace ssc {

// UI reads copy only memory-cached bytes. Disk/network I/O belongs to the media
// worker; the finite certification whitelist bounds this cache to 17 entries.
class RatingAssetCache {
public:
    explicit RatingAssetCache(std::wstring directory = defaultDirectory());
    static std::wstring defaultDirectory();
    std::string find(const Certification& certification) const;
    bool load(const Certification& certification, const MediaResolver& resolver,
              const std::atomic<bool>* cancel = nullptr);
private:
    std::wstring directory_;
    mutable std::mutex mutex_;
    std::map<std::string, std::string> pngs_;
};
RatingAssetCache& ratingAssets();

} // namespace ssc
