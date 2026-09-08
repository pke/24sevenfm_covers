#include "rating_assets.h"

#include <cstring>

namespace ssc {
namespace {

struct RatingAssetData {
    const char* country;
    const char* system;
    const char* rating;
    const unsigned char* bytes;
    size_t size;
};

#include "rating_assets.generated.inc"

} // namespace

bool ratingAssetPng(const std::string& country, const std::string& system,
                    const std::string& rating, const void*& data, size_t& size) {
    data = nullptr; size = 0;
    for (size_t i = 0; i < sizeof(kRatingAssets) / sizeof(kRatingAssets[0]); ++i) {
        const RatingAssetData& asset = kRatingAssets[i];
        if (country == asset.country && system == asset.system && rating == asset.rating) {
            data = asset.bytes; size = asset.size; return true;
        }
    }
    return false;
}

} // namespace ssc
