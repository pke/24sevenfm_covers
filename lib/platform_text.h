// Bounded text helpers for shared code. Keep floating-point formatting on the
// small existing libc backend; charconv's full-range tables increased DLL size.
#pragma once
#include <cstdint>
#include <string>
#include <cmath>
#include <cstdio>
#include <clocale>
#include <limits>

namespace ssc { namespace platform {
inline std::string unsignedText(std::uint64_t value, unsigned minimumDigits = 1) {
    char text[32];
    char* end = text + sizeof(text);
    char* begin = end;
    do { *--begin = static_cast<char>('0' + value % 10); value /= 10; } while (value);
    if (minimumDigits > sizeof(text)) minimumDigits = sizeof(text);
    while (static_cast<unsigned>(end - begin) < minimumDigits) *--begin = '0';
    return std::string(begin, end);
}
inline std::string signedText(std::int64_t value) {
    if (value >= 0) return unsignedText(static_cast<std::uint64_t>(value));
    // Unsigned subtraction also handles INT64_MIN without signed overflow.
    return "-" + unsignedText(std::uint64_t(0) - static_cast<std::uint64_t>(value));
}
template<class Integer> inline std::string integerText(Integer value) {
    static_assert(std::numeric_limits<Integer>::is_integer, "integerText requires an integer");
    return std::numeric_limits<Integer>::is_signed
        ? signedText(static_cast<std::int64_t>(value))
        : unsignedText(static_cast<std::uint64_t>(value));
}
inline std::string numberText(double value, bool fixed) {
    if (!std::isfinite(value)) return "null";
    char text[512]; // finite double: at most 309 integer digits, sign and decimals
    const int length = std::snprintf(text, sizeof(text), fixed ? "%.2f" : "%.6g", value);
    if (length < 0 || static_cast<size_t>(length) >= sizeof(text)) return "null";
    std::string out(text, static_cast<size_t>(length));
    const char* decimal = std::localeconv()->decimal_point;
    if (*decimal && (decimal[0] != '.' || decimal[1] != '\0')) {
        const auto pos = out.find(decimal);
        if (pos != std::string::npos) out.replace(pos, std::char_traits<char>::length(decimal), ".");
    }
    return out;
}
// These byte scans preserve std::string's exact charset semantics (including
// UTF-8 bytes). Small protocol strings do not need the STL's SIMD dispatch code.
inline bool containsByte(const char* set, char value) {
    for (; *set; ++set) if (*set == value) return true;
    return false;
}
inline size_t firstOf(const std::string& text, const char* set, size_t start = 0) {
    for (size_t i = start; i < text.size(); ++i) if (containsByte(set, text[i])) return i;
    return std::string::npos;
}
inline size_t firstNotOf(const std::string& text, const char* set, size_t start = 0) {
    for (size_t i = start; i < text.size(); ++i) if (!containsByte(set, text[i])) return i;
    return std::string::npos;
}
inline size_t lastNotOf(const std::string& text, const char* set) {
    for (size_t i = text.size(); i > 0; --i) if (!containsByte(set, text[i - 1])) return i - 1;
    return std::string::npos;
}
} }
