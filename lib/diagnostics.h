#pragma once
// Small, bounded session history shared by transports and the stage overlay.
// Never keep request credentials or arbitrary non-JSON response bodies.
#include "http_client.h"
#include "mini_json.h"
#include <chrono>
#include <ctime>
#include <cmath>
#include <iomanip>
#include <locale>
#include <mutex>
#include <regex>
#include <sstream>

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
    const auto now = std::chrono::system_clock::now();
    const auto time = std::chrono::system_clock::to_time_t(now);
    std::tm utc = {};
#ifdef _WIN32
    gmtime_s(&utc, &time);
#else
    gmtime_r(&time, &utc);
#endif
    char text[40]; std::strftime(text, sizeof(text), "%Y-%m-%dT%H:%M:%SZ", &utc); return text;
}
inline bool diagnosticSecret(const std::string& key) {
    static const std::regex pattern("key|token|password|secret|authorization|credential", std::regex::icase);
    return std::regex_search(key, pattern);
}
inline std::string diagnosticSafeText(std::string text) {
    static const std::regex query("((?:api[_-]?key|client[_-]?key|token|password|secret|authorization)=)[^&\\s\"<>]*", std::regex::icase);
    static const std::regex userinfo("(https?://)[^/?#\\s]*@", std::regex::icase);
    text = std::regex_replace(text, query, "$1[redacted]");
    text = std::regex_replace(text, userinfo, "$1");
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
inline std::string diagnosticJson(const JsonValue& value, unsigned depth = 0) {
    std::ostringstream out; out.imbue(std::locale::classic());
    switch (value.type) {
    case JsonValue::Null: return "null";
    case JsonValue::Boolean: return value.boolean ? "true" : "false";
    case JsonValue::Number: out << std::fixed << std::setprecision(2) << value.number; return out.str();
    case JsonValue::String:
        out << '"';
        for (unsigned char c : value.string) {
            if (c == '"' || c == '\\') out << '\\' << c;
            else if (c < 32) out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << unsigned(c);
            else out << c;
        }
        out << '"'; return out.str();
    default: break;
    }
    const bool object = value.type == JsonValue::Object;
    out << (object ? '{' : '[');
    size_t count = 0;
    if (object) for (const auto& pair : value.object) {
        out << (count++ ? ",\n" : "\n") << std::string((depth + 1) * 2, ' ')
            << diagnosticJson(diagnosticString(pair.first)) << ": " << diagnosticJson(pair.second, depth + 1);
    }
    else for (const auto& item : value.array)
        out << (count++ ? ",\n" : "\n") << std::string((depth + 1) * 2, ' ') << diagnosticJson(item, depth + 1);
    if (count) out << '\n' << std::string(depth * 2, ' ');
    out << (object ? '}' : ']'); return out.str();
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
