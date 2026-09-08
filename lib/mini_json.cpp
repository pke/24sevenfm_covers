#include "mini_json.h"

#include <cerrno>
#include <cmath>
#include <cstdlib>

namespace ssc {
namespace {

void appendUtf8(std::string& out, unsigned cp) {
    if (cp == 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return;
    if (cp <= 0x7F) out += static_cast<char>(cp);
    else if (cp <= 0x7FF) {
        out += static_cast<char>(0xC0 | (cp >> 6));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    } else if (cp <= 0xFFFF) {
        out += static_cast<char>(0xE0 | (cp >> 12));
        out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    } else {
        out += static_cast<char>(0xF0 | (cp >> 18));
        out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
        out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    }
}

int hex(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return 10 + c - 'a';
    if (c >= 'A' && c <= 'F') return 10 + c - 'A';
    return -1;
}

class Parser {
public:
    explicit Parser(const std::string& text) : text_(text) {}

    bool parse(JsonValue& out) {
        skip();
        if (!value(out, 0)) return false;
        skip();
        if (pos_ != text_.size()) return fail("trailing JSON data");
        return true;
    }
    const std::string& error() const { return error_; }

private:
    bool fail(const char* message) {
        if (error_.empty()) error_ = message;
        return false;
    }
    void skip() {
        while (pos_ < text_.size() && (text_[pos_] == ' ' || text_[pos_] == '\t'
                || text_[pos_] == '\r' || text_[pos_] == '\n')) ++pos_;
    }
    bool consume(const char* token) {
        size_t i = 0;
        while (token[i] && pos_ + i < text_.size() && text_[pos_ + i] == token[i]) ++i;
        if (token[i]) return false;
        pos_ += i;
        return true;
    }
    bool string(std::string& out) {
        if (pos_ >= text_.size() || text_[pos_++] != '"') return fail("expected JSON string");
        out.clear();
        while (pos_ < text_.size()) {
            unsigned char c = static_cast<unsigned char>(text_[pos_++]);
            if (c == '"') return true;
            if (c < 0x20) return fail("control byte in JSON string");
            if (c != '\\') { out += static_cast<char>(c); continue; }
            if (pos_ >= text_.size()) return fail("unterminated JSON escape");
            const char e = text_[pos_++];
            switch (e) {
                case '"': out += '"'; break; case '\\': out += '\\'; break;
                case '/': out += '/'; break; case 'b': out += '\b'; break;
                case 'f': out += '\f'; break; case 'n': out += '\n'; break;
                case 'r': out += '\r'; break; case 't': out += '\t'; break;
                case 'u': {
                    if (pos_ + 4 > text_.size()) return fail("short JSON unicode escape");
                    unsigned cp = 0;
                    for (int i = 0; i < 4; ++i) {
                        const int h = hex(text_[pos_++]);
                        if (h < 0) return fail("invalid JSON unicode escape");
                        cp = (cp << 4) | static_cast<unsigned>(h);
                    }
                    if (cp >= 0xD800 && cp <= 0xDBFF) {
                        if (pos_ + 6 > text_.size() || text_[pos_] != '\\' || text_[pos_ + 1] != 'u')
                            return fail("unpaired JSON surrogate");
                        pos_ += 2;
                        unsigned lo = 0;
                        for (int i = 0; i < 4; ++i) {
                            const int h = hex(text_[pos_++]);
                            if (h < 0) return fail("invalid JSON surrogate");
                            lo = (lo << 4) | static_cast<unsigned>(h);
                        }
                        if (lo < 0xDC00 || lo > 0xDFFF) return fail("unpaired JSON surrogate");
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
                        return fail("unpaired JSON surrogate");
                    }
                    appendUtf8(out, cp);
                    break;
                }
                default: return fail("invalid JSON escape");
            }
        }
        return fail("unterminated JSON string");
    }
    bool number(JsonValue& out) {
        const size_t begin = pos_;
        if (pos_ < text_.size() && text_[pos_] == '-') ++pos_;
        if (pos_ >= text_.size()) return fail("invalid JSON number");
        if (text_[pos_] == '0') ++pos_;
        else {
            if (text_[pos_] < '1' || text_[pos_] > '9') return fail("invalid JSON number");
            while (pos_ < text_.size() && text_[pos_] >= '0' && text_[pos_] <= '9') ++pos_;
        }
        if (pos_ < text_.size() && text_[pos_] == '.') {
            ++pos_;
            const size_t digits = pos_;
            while (pos_ < text_.size() && text_[pos_] >= '0' && text_[pos_] <= '9') ++pos_;
            if (pos_ == digits) return fail("invalid JSON fraction");
        }
        if (pos_ < text_.size() && (text_[pos_] == 'e' || text_[pos_] == 'E')) {
            ++pos_;
            if (pos_ < text_.size() && (text_[pos_] == '+' || text_[pos_] == '-')) ++pos_;
            const size_t digits = pos_;
            while (pos_ < text_.size() && text_[pos_] >= '0' && text_[pos_] <= '9') ++pos_;
            if (pos_ == digits) return fail("invalid JSON exponent");
        }
        errno = 0;
        char* end = nullptr;
        const std::string raw = text_.substr(begin, pos_ - begin);
        const double n = std::strtod(raw.c_str(), &end);
        if (errno == ERANGE || !end || *end || !std::isfinite(n)) return fail("invalid JSON number");
        out.type = JsonValue::Number;
        out.number = n;
        return true;
    }
    bool value(JsonValue& out, int depth) {
        if (depth > 24) return fail("JSON nesting limit exceeded");
        skip();
        if (pos_ >= text_.size()) return fail("missing JSON value");
        const char c = text_[pos_];
        if (c == '"') { out.type = JsonValue::String; return string(out.string); }
        if (c == '{') return object(out, depth + 1);
        if (c == '[') return array(out, depth + 1);
        if (c == '-' || (c >= '0' && c <= '9')) return number(out);
        if (consume("null")) { out.type = JsonValue::Null; return true; }
        if (consume("true")) { out.type = JsonValue::Boolean; out.boolean = true; return true; }
        if (consume("false")) { out.type = JsonValue::Boolean; out.boolean = false; return true; }
        return fail("invalid JSON value");
    }
    bool array(JsonValue& out, int depth) {
        ++pos_;
        out.type = JsonValue::Array;
        out.array.clear();
        skip();
        if (pos_ < text_.size() && text_[pos_] == ']') { ++pos_; return true; }
        for (;;) {
            JsonValue item;
            if (!value(item, depth)) return false;
            out.array.push_back(std::move(item));
            skip();
            if (pos_ >= text_.size()) return fail("unterminated JSON array");
            if (text_[pos_] == ']') { ++pos_; return true; }
            if (text_[pos_++] != ',') return fail("expected JSON array comma");
        }
    }
    bool object(JsonValue& out, int depth) {
        ++pos_;
        out.type = JsonValue::Object;
        out.object.clear();
        skip();
        if (pos_ < text_.size() && text_[pos_] == '}') { ++pos_; return true; }
        for (;;) {
            skip();
            std::string key;
            if (!string(key)) return false;
            skip();
            if (pos_ >= text_.size() || text_[pos_++] != ':') return fail("expected JSON object colon");
            JsonValue item;
            if (!value(item, depth)) return false;
            if (!out.object.insert(std::make_pair(key, std::move(item))).second)
                return fail("duplicate JSON object key");
            skip();
            if (pos_ >= text_.size()) return fail("unterminated JSON object");
            if (text_[pos_] == '}') { ++pos_; return true; }
            if (text_[pos_++] != ',') return fail("expected JSON object comma");
        }
    }

    const std::string& text_;
    size_t pos_ = 0;
    std::string error_;
};

} // namespace

bool parseJson(const std::string& text, JsonValue& out, std::string* error) {
    Parser parser(text);
    if (parser.parse(out)) return true;
    if (error) *error = parser.error();
    return false;
}

} // namespace ssc
