#pragma once
#include <fstream>
#include <iterator>
#include <string>

inline std::string ratingFixturePng() {
    const std::string source = __FILE__;
    const auto path = source.substr(0, source.find_last_of("/\\") + 1)
        + "../../shared/rating_assets/de_fsk_12.png";
    std::ifstream file(path, std::ios::binary);
    return std::string(std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>());
}
