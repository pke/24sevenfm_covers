#pragma once
#include <string>
#include <cstddef>

namespace ssc {
// Borrowed slices, not a JSON tree. Only fields consumed by a schema are decoded
// into owned strings. The response must outlive all views and iterators.
class JsonView {
public:
    enum Type { Missing, Null, Boolean, Number, String, Array, Object };
    Type type = Missing;
    JsonView get(const char* key) const;
    bool text(std::string& out, size_t maxBytes = 4096) const;
    bool scalarText(std::string& out, size_t maxBytes = 4096) const;
    bool number(double& out) const;
    bool exists() const { return type != Missing; }
private:
    const char* first_ = nullptr;
    const char* last_ = nullptr;
    friend class JsonItems;
    friend bool readJsonView(const std::string&, JsonView&, std::string*);
};
class JsonItems {
public:
    explicit JsonItems(const JsonView& container);
    bool next(JsonView& value, std::string* key = nullptr);
private:
    const char* next_ = nullptr;
    const char* end_ = nullptr;
    bool object_ = false;
};
// Bounds apply to every value, including unknown fields. Reject duplicate
// decoded keys, malformed UTF-8/escapes, non-finite numbers and trailing input.
// Output is unchanged on failure. No pointer arithmetic escapes the input span.
bool readJsonView(const std::string& text, JsonView& out, std::string* error = nullptr);
constexpr size_t kJsonResponseBytes = 256 * 1024;
}
