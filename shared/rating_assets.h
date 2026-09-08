#pragma once

#include <cstddef>
#include <string>

namespace ssc {

// Returns a compiled-in, high-resolution PNG for every certification accepted by
// MediaResolver. False lets the renderer fall back to a text badge safely.
bool ratingAssetPng(const std::string& country, const std::string& system,
                    const std::string& rating, const void*& data, size_t& size);

} // namespace ssc
