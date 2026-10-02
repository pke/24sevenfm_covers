#pragma once
#include "debug_features.h"
#if SSC_ENABLE_DEBUG_OVERLAY
// Small, bounded session history shared by transports and the stage overlay.
// Never keep request credentials or arbitrary non-JSON response bodies.
#include "http_client.h"
#include "mini_json.h"
#include "utc_time.h"
#include <chrono>
#include <cmath>
#include <clocale>
#include <cstdio>
#include "platform_concurrency.h"
#include "platform_text.h"

namespace ssc {
inline JsonValue diagnosticObject() { JsonValue v; v.type = JsonValue::Object; return v; }
inline JsonValue diagnosticArray() { JsonValue v; v.type = JsonValue::Array; return v; }
inline JsonValue diagnosticString(const std::string& s) { JsonValue v; v.type = JsonValue::String; v.string = s; return v; }
inline JsonValue diagnosticNumber(double n) { JsonValue v; if (std::isfinite(n)) { v.type = JsonValue::Number; v.number = n; } return v; }
inline JsonValue diagnosticBool(bool b) { JsonValue v; v.type = JsonValue::Boolean; v.boolean = b; return v; }
// Keep fixed-schema field writes shared across the native debug builders. Inlining
// map insertion and JsonValue construction at every field inflated engine code.
#ifdef _MSC_VER
#define SSC_DIAGNOSTIC_NOINLINE __declspec(noinline)
#else
#define SSC_DIAGNOSTIC_NOINLINE __attribute__((noinline))
#endif
SSC_DIAGNOSTIC_NOINLINE JsonValue& diagnosticSet(std::map<std::string, JsonValue>&, const char*, JsonValue);
SSC_DIAGNOSTIC_NOINLINE JsonValue& diagnosticSetString(std::map<std::string, JsonValue>&, const char*, const std::string&);
SSC_DIAGNOSTIC_NOINLINE JsonValue& diagnosticSetString(std::map<std::string, JsonValue>&, const char*, const char*);
SSC_DIAGNOSTIC_NOINLINE JsonValue& diagnosticSetNumber(std::map<std::string, JsonValue>&, const char*, double);
SSC_DIAGNOSTIC_NOINLINE JsonValue& diagnosticSetBool(std::map<std::string, JsonValue>&, const char*, bool);
#undef SSC_DIAGNOSTIC_NOINLINE
inline double diagnosticMilliseconds(std::chrono::steady_clock::time_point start) {
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
}
inline std::string diagnosticTimestamp() {
#ifdef _WIN32
    SYSTEMTIME utc = {};
    GetSystemTime(&utc);
    return formatUtcTime(utc, UtcFormat::Iso8601);
#else
    const auto now = std::chrono::system_clock::now();
    const auto time = std::chrono::system_clock::to_time_t(now);
    return formatUtcTime(time, UtcFormat::Iso8601);
#endif
}
// Credential names and URL schemes are ASCII. Avoid pulling the regex engine
// into every native release for these few fixed, case-insensitive patterns.
inline bool diagnosticMatches(const std::string& text, size_t pos, const char* pattern) {
    for (; *pattern; ++pattern, ++pos) {
        if (pos >= text.size()) return false;
        char c = text[pos];
        if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
        if (c != *pattern) return false;
    }
    return true;
}
inline bool diagnosticSpace(char c) {
    return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\f' || c == '\v';
}
inline bool diagnosticSecret(const std::string& key) {
    for (size_t pos = 0; pos < key.size(); ++pos)
        for (const char* name : {"key", "token", "password", "secret", "authorization", "credential"})
            if (diagnosticMatches(key, pos, name)) return true;
    return false;
}
inline std::string diagnosticSafeText(std::string text, size_t limit = 4096) {
    std::string safe;
    safe.reserve(text.size());
    for (size_t pos = 0; pos < text.size();) {
        size_t prefixLength = 0;
        for (const char* name : {"api_key=", "api-key=", "apikey=", "client_key=", "client-key=",
                "clientkey=", "token=", "password=", "secret=", "authorization="}) {
            if (diagnosticMatches(text, pos, name)) {
                prefixLength = std::char_traits<char>::length(name);
                break;
            }
        }
        if (!prefixLength) { safe += text[pos++]; continue; }
        safe.append(text, pos, prefixLength);
        safe += "[redacted]";
        pos += prefixLength;
        while (pos < text.size() && text[pos] != '&' && !diagnosticSpace(text[pos]) &&
                text[pos] != '"' && text[pos] != '<' && text[pos] != '>') ++pos;
    }
    text.swap(safe);
    safe.clear();
    // Strip through the last @ in each authority, preserving scheme spelling.
    // Run after query redaction to retain the original replacement ordering.
    for (size_t pos = 0; pos < text.size();) {
        const size_t schemeLength = diagnosticMatches(text, pos, "https://") ? 8 :
            diagnosticMatches(text, pos, "http://") ? 7 : 0;
        if (!schemeLength) { safe += text[pos++]; continue; }
        safe.append(text, pos, schemeLength);
        pos += schemeLength;
        size_t lastAt = std::string::npos;
        for (size_t end = pos; end < text.size() && text[end] != '/' && text[end] != '?' &&
                text[end] != '#' && !diagnosticSpace(text[end]); ++end)
            if (text[end] == '@') lastAt = end;
        if (lastAt != std::string::npos) pos = lastAt + 1;
    }
    text.swap(safe);
    if (text.size() > limit) text = text.substr(0, limit) + "[truncated]";
    return text;
}
inline void diagnosticSanitizeInPlace(JsonValue& out, unsigned depth = 0) {
    if (depth > 12) { out = diagnosticString("[depth limit]"); return; }
    if (out.type == JsonValue::String) out.string = diagnosticSafeText(out.string);
    if (out.type == JsonValue::Array) {
        if (out.array.size() > 100) out.array.resize(100);
        for (auto& item : out.array) diagnosticSanitizeInPlace(item, depth + 1);
    }
    if (out.type == JsonValue::Object)
        for (auto& item : out.object) {
            if (diagnosticSecret(item.first)) item.second = diagnosticString("[redacted]");
            // Response text was redacted at capture; keep its complete bounded
            // contents when exporting instead of applying the short UI limit.
            else if (item.first == "response" && item.second.type == JsonValue::String)
                item.second.string = diagnosticSafeText(item.second.string, 65536);
            else diagnosticSanitizeInPlace(item.second, depth + 1);
        }
}
inline JsonValue diagnosticSanitize(JsonValue value, unsigned depth = 0) {
    diagnosticSanitizeInPlace(value, depth); return value;
}
inline std::string diagnosticFormatNumber(double value, bool fixed) {
    return platform::numberText(value, fixed);
}
inline std::string diagnosticJson(const JsonValue& value, unsigned depth = 0) {
    std::string out;
    switch (value.type) {
    case JsonValue::Null: return "null";
    case JsonValue::Boolean: return value.boolean ? "true" : "false";
    case JsonValue::Number: return diagnosticFormatNumber(value.number, true);
    case JsonValue::String:
        out += '"';
        for (unsigned char c : value.string) {
            if (c == '"' || c == '\\') { out += '\\'; out += c; }
            else if (c < 32) {
                static const char hex[] = "0123456789abcdef";
                out += "\\u00"; out += hex[c >> 4]; out += hex[c & 15];
            }
            else out += c;
        }
        out += '"'; return out;
    default: break;
    }
    const bool object = value.type == JsonValue::Object;
    out += object ? '{' : '[';
    size_t count = 0;
    if (object) for (const auto& pair : value.object) {
        out += count++ ? ",\n" : "\n";
        out.append((depth + 1) * 2, ' ');
        out += diagnosticJson(diagnosticString(pair.first)); out += ": ";
        out += diagnosticJson(pair.second, depth + 1);
    }
    else for (const auto& item : value.array) {
        out += count++ ? ",\n" : "\n";
        out.append((depth + 1) * 2, ' ');
        out += diagnosticJson(item, depth + 1);
    }
    if (count) { out += '\n'; out.append(depth * 2, ' '); }
    out += object ? '}' : ']'; return out;
}
struct TrackInfo;
// Fixed track schema shared by the scheduler's typed history and event records.
struct DiagnosticTrack {
    std::string album, track, artist, coverUrl, occurrence;
    int lengthSeconds = 0;
};
DiagnosticTrack diagnosticTrackRecord(const TrackInfo& track);
JsonValue diagnosticTrack(const DiagnosticTrack& track);
class DiagnosticLog {
public:
    static DiagnosticLog& instance();
    void request(const std::string& url, const HttpResponse& response, double totalMs);
    void event(const std::string& name, const std::string& details);
    void event(const std::string& name, const TrackInfo& track);
    void image(const std::string& url, size_t bytes, unsigned width, unsigned height, double ms, bool valid);
    JsonValue snapshot(); // Generic display data is built only when requested.
private:
    struct Request {
        std::string at, url, response, cacheStatus, cacheControl, age, error;
        int status = 0; size_t bytes = 0;
        double headersMs = -1, totalMs = 0;
    };
    struct Event {
        enum Kind { Text, Track, Image } kind = Text;
        std::string at, name, text;
        DiagnosticTrack track;
        size_t bytes = 0; unsigned width = 0, height = 0;
        double ms = 0; bool valid = false;
    };
    void add(Event&& event);
    platform::Mutex mutex_;
    std::vector<Request> requests_;
    std::vector<Event> events_;
};
}

#endif // SSC_ENABLE_DEBUG_OVERLAY
