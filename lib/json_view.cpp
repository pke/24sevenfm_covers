#include "json_view.h"
#include <cmath>
#include <cstdint>
#if defined(_MSVC_LANG) && _MSVC_LANG >= 201703L
#include <charconv>
#else
#include <cerrno>
#include <cstdlib>
#endif

namespace ssc {
namespace {
void ws(const char*& p, const char* end) {
    while (p != end && (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n')) ++p;
}
int hex(char c) {
    return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10
        : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
}
bool hex4(const char*& p, const char* end, unsigned& n) {
    if (end - p < 4) return false;
    n = 0;
    for (unsigned i = 0; i != 4; ++i) {
        int h = hex(*p++); if (h < 0) return false;
        n = (n << 4) | static_cast<unsigned>(h);
    }
    return true;
}
bool stringToken(const char*& p, const char* end, std::string* out, size_t limit) {
    if (p == end || *p++ != '"') return false;
    size_t bytes = 0;
    while (p != end) {
        unsigned cp = static_cast<unsigned char>(*p++);
        if (cp == '"') return true;
        if (cp < 32) return false;
        if (cp == '\\') {
            if (p == end) return false;
            switch (*p++) {
            case '"': cp = '"'; break; case '\\': cp = '\\'; break; case '/': cp = '/'; break;
            case 'b': cp = 8; break; case 'f': cp = 12; break;
            case 'n': cp = 10; break; case 'r': cp = 13; break; case 't': cp = 9; break;
            case 'u': {
                if (!hex4(p, end, cp)) return false;
                if (cp >= 0xD800 && cp <= 0xDBFF) {
                    if (end - p < 6 || p[0] != '\\' || p[1] != 'u') return false;
                    p += 2; unsigned low;
                    if (!hex4(p, end, low) || low < 0xDC00 || low > 0xDFFF) return false;
                    cp = 0x10000 + ((cp - 0xD800) << 10) + low - 0xDC00;
                } else if (cp >= 0xDC00 && cp <= 0xDFFF) return false;
                break;
            }
            default: return false;
            }
        } else if (cp >= 128) {
            unsigned count, minimum;
            if (cp >= 0xC2 && cp <= 0xDF) { count = 1; minimum = 128; cp &= 31; }
            else if (cp >= 0xE0 && cp <= 0xEF) { count = 2; minimum = 2048; cp &= 15; }
            else if (cp >= 0xF0 && cp <= 0xF4) { count = 3; minimum = 65536; cp &= 7; }
            else return false;
            if (static_cast<size_t>(end - p) < count) return false;
            for (unsigned i = 0; i != count; ++i) {
                const unsigned c = static_cast<unsigned char>(*p++);
                if ((c & 192) != 128) return false;
                cp = (cp << 6) | (c & 63);
            }
            if (cp < minimum || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return false;
        }
        const size_t width = cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;
        if (width > limit - bytes) return false;
        bytes += width;
        if (!out) continue;
        if (width == 1) *out += static_cast<char>(cp);
        else {
            if (width == 2) *out += static_cast<char>(192 | (cp >> 6));
            else if (width == 3) *out += static_cast<char>(224 | (cp >> 12));
            else { *out += static_cast<char>(240 | (cp >> 18)); *out += static_cast<char>(128 | ((cp >> 12) & 63)); }
            if (width >= 3) *out += static_cast<char>(128 | ((cp >> 6) & 63));
            *out += static_cast<char>(128 | (cp & 63));
        }
    }
    return false;
}
// The floating conversion templates are large. Share one conversion path for
// document validation and selected numeric fields, including under MSVC LTCG.
#ifdef _MSC_VER
__declspec(noinline)
#else
__attribute__((noinline))
#endif
bool numeric(const char* begin, const char* end, double& n) {
#if defined(_MSVC_LANG) && _MSVC_LANG >= 201703L
    const auto converted = std::from_chars(begin, end, n);
    return converted.ec == std::errc() && converted.ptr == end && std::isfinite(n);
#else
    const std::string token(begin, end);
    errno = 0; char* last = nullptr; n = std::strtod(token.c_str(), &last);
    return errno != ERANGE && last == token.c_str() + token.size() && std::isfinite(n);
#endif
}
JsonView::Type kind(char c) {
    return c == '{' ? JsonView::Object : c == '[' ? JsonView::Array : c == '"' ? JsonView::String
        : c == 'n' ? JsonView::Null : c == 't' || c == 'f' ? JsonView::Boolean : JsonView::Number;
}
bool validate(const char*& p, const char* end, unsigned depth) {
    ws(p, end);
    if (p == end || depth > 24) return false;
    const char c = *p;
    if (c == '"') return stringToken(p, end, nullptr, 65536);
    if (c == '{' || c == '[') {
        const bool object = c == '{'; const char close = object ? '}' : ']'; ++p;
        struct Key { const char* begin; const char* end; std::uint64_t hash; } keys[128];
        unsigned count = 0;
        ws(p, end); if (p != end && *p == close) { ++p; return true; }
        do {
            if (++count > (object ? 128u : 1024u)) return false;
            if (object) {
                ws(p, end); const char* begin = p; std::string key;
                if (!stringToken(p, end, &key, 256)) return false;
                std::uint64_t hash = 14695981039346656037ull;
                for (unsigned char b : key) hash = (hash ^ b) * 1099511628211ull;
                for (unsigned i = 0; i + 1 < count; ++i) if (keys[i].hash == hash) {
                    std::string previous; const char* q = keys[i].begin;
                    if (!stringToken(q, keys[i].end, &previous, 256) || key == previous) return false;
                }
                keys[count - 1] = {begin, p, hash};
                ws(p, end); if (p == end || *p++ != ':') return false;
            }
            if (!validate(p, end, depth + 1)) return false;
            ws(p, end); if (p == end) return false;
            if (*p == close) { ++p; return true; }
            if (*p++ != ',') return false;
        } while (true);
    }
    if (c == '-' || (c >= '0' && c <= '9')) {
        const char* begin = p;
        if (*p == '-') ++p;
        if (p == end) return false;
        if (*p == '0') ++p;
        else {
            if (*p < '1' || *p > '9') return false;
            do { ++p; } while (p != end && *p >= '0' && *p <= '9');
        }
        if (p != end && *p == '.') {
            const char* digits = ++p;
            while (p != end && *p >= '0' && *p <= '9') ++p;
            if (p == digits) return false;
        }
        if (p != end && (*p == 'e' || *p == 'E')) {
            ++p; if (p != end && (*p == '+' || *p == '-')) ++p;
            const char* digits = p;
            while (p != end && *p >= '0' && *p <= '9') ++p;
            if (p == digits) return false;
        }
        double n; return numeric(begin, p, n);
    }
    const char* literal = c == 'n' ? "null" : c == 't' ? "true" : c == 'f' ? "false" : "";
    if (!*literal) return false;
    while (*literal) if (p == end || *p++ != *literal++) return false;
    return true;
}
// The document has already been validated. Traversal only finds token ends;
// it does not allocate, decode unused strings, or revalidate subtrees.
void tokenEnd(const char*& p, const char* end) {
    unsigned depth = 0; bool quoted = false;
    while (p != end) {
        const char c = *p;
        if (quoted) {
            ++p;
            if (c == '\\') { if (p != end) ++p; }
            else if (c == '"') { quoted = false; if (!depth) return; }
        } else if (c == '"') { quoted = true; ++p; }
        else if (c == '[' || c == '{') { ++depth; ++p; }
        else if (c == ']' || c == '}') { if (!depth) return; ++p; if (!--depth) return; }
        else if (!depth && (c == ',' || c == ' ' || c == '\r' || c == '\n' || c == '\t')) return;
        else ++p;
    }
}
}
bool readJsonView(const std::string& text, JsonView& out, std::string* error) {
    const char* p = text.data(); const char* end = p + text.size(); ws(p, end);
    const char* first = p;
    if (text.size() > kJsonResponseBytes || !validate(p, end, 0)) {
        if (error) *error = "invalid or oversized JSON response"; return false;
    }
    const char* last = p; ws(p, end);
    if (p != end) { if (error) *error = "trailing JSON data"; return false; }
    JsonView value; value.type = kind(*first); value.first_ = first; value.last_ = last; out = value;
    return true;
}
JsonItems::JsonItems(const JsonView& value) {
    if (value.type == JsonView::Array || value.type == JsonView::Object) {
        next_ = value.first_ + 1; end_ = value.last_ - 1; object_ = value.type == JsonView::Object;
    }
}
bool JsonItems::next(JsonView& value, std::string* key) {
    if (!next_) return false;
    ws(next_, end_); if (next_ == end_) return false;
    if (object_) {
        if (key) { key->clear(); if (!stringToken(next_, end_, key, 256)) return false; }
        else tokenEnd(next_, end_);
        ws(next_, end_); if (next_ == end_) return false; ++next_; ws(next_, end_);
    }
    value.first_ = next_; value.type = kind(*next_); tokenEnd(next_, end_); value.last_ = next_;
    ws(next_, end_); if (next_ != end_) ++next_;
    return true;
}
JsonView JsonView::get(const char* wanted) const {
    if (type != Object) return JsonView();
    JsonItems items(*this); JsonView value; std::string key;
    while (items.next(value, &key)) if (key == wanted) return value;
    return JsonView();
}
bool JsonView::text(std::string& out, size_t maxBytes) const {
    if (type != String) return false;
    std::string value; const char* p = first_;
    if (!stringToken(p, last_, &value, maxBytes)) return false;
    out.swap(value); return true;
}
bool JsonView::scalarText(std::string& out, size_t maxBytes) const {
    if (type == String) return text(out, maxBytes);
    if (type == Null) { out.clear(); return true; }
    if ((type != Boolean && type != Number) || static_cast<size_t>(last_ - first_) > maxBytes) return false;
    out.assign(first_, last_); return true;
}
bool JsonView::number(double& out) const { return type == Number && numeric(first_, last_, out); }
}
