#pragma once
// Small, bounded session history shared by transports and the stage overlay.
// Never keep request credentials or arbitrary non-JSON response bodies.
#include "http_client.h"
#include "mini_json.h"
#include "utc_time.h"
#include <chrono>
#include <cmath>
#include <clocale>
#include <cstdio>
#include <mutex>

namespace ssc {
inline JsonValue diagnosticObject() { JsonValue v; v.type = JsonValue::Object; return v; }
inline JsonValue diagnosticArray() { JsonValue v; v.type = JsonValue::Array; return v; }
inline JsonValue diagnosticString(const std::string& s) { JsonValue v; v.type = JsonValue::String; v.string = s; return v; }
inline JsonValue diagnosticNumber(double n) { JsonValue v; if (std::isfinite(n)) { v.type = JsonValue::Number; v.number = n; } return v; }
inline JsonValue diagnosticBool(bool b) { JsonValue v; v.type = JsonValue::Boolean; v.boolean = b; return v; }
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
inline std::string diagnosticSafeText(std::string text) {
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
    if (text.size() > 4096) text = text.substr(0, 4096) + "[truncated]";
    return text;
}
inline JsonValue diagnosticSanitize(const JsonValue& value, unsigned depth = 0) {
    if (depth > 12) return diagnosticString("[depth limit]");
    JsonValue out = value;
    if (out.type == JsonValue::String) out.string = diagnosticSafeText(out.string);
    if (out.type == JsonValue::Array) {
        if (out.array.size() > 100) out.array.resize(100);
        for (auto& item : out.array) item = diagnosticSanitize(item, depth + 1);
    }
    if (out.type == JsonValue::Object)
        for (auto& item : out.object) item.second = diagnosticSecret(item.first)
            ? diagnosticString("[redacted]") : diagnosticSanitize(item.second, depth + 1);
    return out;
}
inline std::string diagnosticFormatNumber(double value, bool fixed) {
    // A finite double needs at most 309 integer digits, plus sign and decimals.
    // Reuse printf support already linked by the native hosts; retain C++11.
    char text[512];
    const int length = std::snprintf(text, sizeof(text), fixed ? "%.2f" : "%.6g", value);
    if (length < 0 || static_cast<size_t>(length) >= sizeof(text)) return "null";
    std::string out(text, static_cast<size_t>(length));
    // JSON and reports use a dot even when the host's C locale uses a comma.
    // Do not change the host's process or thread locale just to format a number.
    const char* decimal = std::localeconv()->decimal_point;
    if (*decimal && (decimal[0] != '.' || decimal[1] != '\0')) {
        const auto pos = out.find(decimal);
        if (pos != std::string::npos) out.replace(pos, std::char_traits<char>::length(decimal), ".");
    }
    return out;
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
class DiagnosticLog {
public:
    static DiagnosticLog& instance() { static DiagnosticLog log; return log; }
    void request(const std::string& url, const HttpResponse& response, double totalMs) {
        JsonValue entry = diagnosticObject();
        auto& p = entry.object;
        p["at"] = diagnosticString(diagnosticTimestamp());
        p["url"] = diagnosticString(diagnosticSafeText(url));
        p["status"] = diagnosticNumber(response.status);
        p["headersMs"] = response.headersMs < 0 ? JsonValue() : diagnosticNumber(response.headersMs);
        p["downloadMs"] = diagnosticNumber(totalMs);
        p["totalMs"] = diagnosticNumber(totalMs);
        p["responseBytes"] = diagnosticNumber(static_cast<double>(response.body.size()));
        p["httpCache"] = diagnosticString(response.cacheStatus.empty() ? "unknown" : response.cacheStatus);
        p["cacheControl"] = diagnosticString(response.cacheControl);
        p["ageSeconds"] = diagnosticString(response.age);
        p["error"] = diagnosticString(diagnosticSafeText(response.error));
        const auto parseStart = std::chrono::steady_clock::now();
        JsonValue body;
        if (response.body.size() <= 65536 && parseJson(response.body, body))
            p["response"] = diagnosticSanitize(body);
        else p["response"] = diagnosticString(response.body.size() > 65536 ? "[body truncated]" : "[non-JSON body omitted]");
        p["diagnosticParseMs"] = diagnosticNumber(diagnosticMilliseconds(parseStart));
        std::lock_guard<std::mutex> lock(mutex_);
        requests_.push_back(entry); if (requests_.size() > 30) requests_.erase(requests_.begin());
    }
    void event(const std::string& name, JsonValue details = JsonValue()) {
        JsonValue entry = diagnosticObject(); entry.object["at"] = diagnosticString(diagnosticTimestamp());
        entry.object["name"] = diagnosticString(name); entry.object["details"] = diagnosticSanitize(details);
        std::lock_guard<std::mutex> lock(mutex_);
        events_.push_back(entry); if (events_.size() > 30) events_.erase(events_.begin());
    }
    JsonValue snapshot() {
        std::lock_guard<std::mutex> lock(mutex_);
        JsonValue out = diagnosticObject();
        out.object["capturedAt"] = diagnosticString(diagnosticTimestamp());
        out.object["schemaVersion"] = diagnosticNumber(1);
        out.object["requests"] = diagnosticArray(); out.object["requests"].array = requests_;
        out.object["events"] = diagnosticArray(); out.object["events"].array = events_;
        return out;
    }
private:
    std::mutex mutex_;
    std::vector<JsonValue> requests_, events_;
};
}
