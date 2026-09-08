// mini_json.h - small strict JSON value parser used by native API clients.
// Dependency-free, bounded-depth, UTF-8 preserving, and intentionally read-only.
#pragma once

#include <map>
#include <string>
#include <vector>

namespace ssc {

struct JsonValue {
    enum Type { Null, Boolean, Number, String, Array, Object } type = Null;
    bool boolean = false;
    double number = 0.0;
    std::string string;
    std::vector<JsonValue> array;
    std::map<std::string, JsonValue> object;

    const JsonValue* get(const char* key) const {
        if (type != Object || !key) return nullptr;
        const auto it = object.find(key);
        return it == object.end() ? nullptr : &it->second;
    }
};

bool parseJson(const std::string& text, JsonValue& out, std::string* error = nullptr);

} // namespace ssc
