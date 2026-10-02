#pragma once
#include "../lib/debug_features.h"
#if SSC_ENABLE_DEBUG_OVERLAY
#include "../lib/platform_text.h"
#include "../lib/diagnostic_timeline.h"
#include <cctype>

namespace ssc {
inline std::string debugLabel(const std::string& key) {
    std::string result;
    for (size_t i = 0; i < key.size(); ++i) {
        const unsigned char c = key[i];
        if (c == '_' || c == '-') result += ' ';
        else { if (i && std::isupper(c) && std::islower(static_cast<unsigned char>(key[i-1]))) result += ' ';
            result += i == 0 ? static_cast<char>(std::toupper(c)) : static_cast<char>(c); }
    }
    return result;
}
inline std::string debugDisplayValue(const JsonValue& value, const std::string& key = "") {
    if (value.type == JsonValue::Null) return "Unknown";
    if (value.type == JsonValue::Boolean) return value.boolean ? "Yes" : "No";
    if (value.type == JsonValue::String) return value.string.empty() ? "--" : value.string;
    if (key == "observedAt") {
        const double seconds = value.number / 1000;
        if (!std::isfinite(seconds) || seconds < 0 || seconds >= 32535216000.) return "Unknown";
        const auto text = formatUtcTime(static_cast<std::int64_t>(seconds), UtcFormat::Display);
        return text.empty() ? "Unknown" : text;
    }
    std::string out = diagnosticFormatNumber(value.number, false);
    if (key.size() >= 2 && key.substr(key.size()-2) == "Ms") out += " ms";
    else if (key.find("Bytes") != std::string::npos || key == "bytes") out += " bytes";
    else if (key.find("Seconds") != std::string::npos) out += " s";
    return out;
}
inline void debugReportFields(std::string& out, const JsonValue& value, unsigned depth = 0) {
    if (depth > 10) return;
    const std::string indent(depth * 2, ' ');
    if (value.type == JsonValue::Object) for (const auto& field : value.object) {
        if (field.second.type == JsonValue::Object || field.second.type == JsonValue::Array) {
            out += indent + debugLabel(field.first) + "\r\n";
            debugReportFields(out, field.second, depth + 1);
        } else out += indent + debugLabel(field.first) + "\t" + debugDisplayValue(field.second, field.first) + "\r\n";
    }
    else if (value.type == JsonValue::Array) {
        if (value.array.empty()) out += indent + "None\r\n";
        for (size_t i = 0; i < value.array.size(); ++i) {
            out += indent + "#" + ssc::platform::integerText(i+1) + "\r\n";
            debugReportFields(out, value.array[i], depth + 1);
        }
    } else out += indent + debugDisplayValue(value) + "\r\n";
}
inline std::string debugReport(const JsonValue& snapshot) {
    std::string out;
    const std::pair<const char*, const char*> sections[] = {
        {"track", "Selected track"}, {"selected", "Selected timeline entry"}, {"resolved", "Artwork"}, {"playback", "Playback position"},
        {"requests", "Requests and timings"}, {"localCache", "Cache"}, {"display", "Display"},
        {"settings", "Settings"}, {"events", "Recent events"} };
    for (const auto& section : sections) if (const auto* value = snapshot.get(section.first)) {
        out += std::string(section.second) + "\r\n";
        debugReportFields(out, *value); out += "\r\n";
    }
    return out;
}
}

#endif // SSC_ENABLE_DEBUG_OVERLAY
