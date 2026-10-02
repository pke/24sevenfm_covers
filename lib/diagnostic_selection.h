#pragma once
#include "debug_features.h"
#if SSC_ENABLE_DEBUG_OVERLAY
#include "json_view.h"
#include <map>
#include "platform_text.h"
#include "diagnostic_timeline.h"
#include <set>

namespace ssc {
inline std::string diagnosticDecodeQuery(const std::string& value) {
    const auto hex = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    };
    std::string out;
    for (size_t i = 0; i < value.size(); ++i) {
        if (value[i] == '%' && i + 2 < value.size() && hex(value[i+1]) >= 0 && hex(value[i+2]) >= 0) {
            out += static_cast<char>(hex(value[i+1]) * 16 + hex(value[i+2])); i += 2;
        } else out += value[i] == '+' ? ' ' : value[i];
    }
    return out;
}
inline std::map<std::string, std::string> diagnosticQuery(const std::string& url) {
    std::map<std::string, std::string> params;
    const auto query = url.find('?'); if (query == std::string::npos) return params;
    size_t start = query + 1;
    while (start < url.size()) {
        const auto end = ssc::platform::firstOf(url, "&#", start);
        const auto part = url.substr(start, end == std::string::npos ? end : end - start);
        const auto equal = part.find('=');
        if (equal != std::string::npos)
            params[diagnosticDecodeQuery(part.substr(0, equal))] = diagnosticDecodeQuery(part.substr(equal + 1));
        if (end == std::string::npos || url[end] == '#') break;
        start = end + 1;
    }
    return params;
}
inline void diagnosticAssetUrls(const JsonValue& value, std::set<std::string>& urls) {
    if (value.type == JsonValue::String && (value.string.find("https://") == 0 || value.string.find("http://") == 0))
        urls.insert(value.string);
    for (const auto& field : value.object) diagnosticAssetUrls(field.second, urls);
    for (const auto& item : value.array) diagnosticAssetUrls(item, urls);
}
// Only identity- or asset-associated data may appear below the timeline or in
// its copied report. A cache miss is never a reason to use the playing track.
inline JsonValue diagnosticSelection(const JsonValue& snapshot, const JsonValue& item) {
    JsonValue out = diagnosticObject(), track = diagnosticObject(), playback = diagnosticObject();
    for (const auto* key : {"schemaVersion", "capturedAt", "station"}) out.object[key] = debugValue(snapshot, key);
    for (const auto* key : {"album", "track", "artist", "lengthSeconds"}) track.object[key] = debugValue(item, key);
    for (const auto* key : {"phase", "observedAt", "relativeSeconds", "timeKind"}) playback.object[key] = debugValue(item, key);
    const auto same = [&](const std::string& album, const std::string& title) {
        return (!album.empty() || !title.empty()) && album == debugValue(item, "album").string
            && title == debugValue(item, "track").string;
    };
    if (debugValue(item, "phase").string == "current" && same(debugValue(debugValue(snapshot, "track"), "album").string,
            debugValue(debugValue(snapshot, "track"), "track").string)) {
        track = debugValue(snapshot, "track");
        playback.object["remainingSeconds"] = debugValue(debugValue(snapshot, "display"), "remainingSeconds");
    }
    out.object["track"] = track; out.object["playback"] = playback;
    out.object["selected"] = diagnosticObject();
    out.object["selected"].object["id"] = debugValue(item, "id");
    out.object["selected"].object["phase"] = debugValue(item, "phase");
    for (const auto& pair : { std::make_pair("localCache", "cache"), std::make_pair("resolved", "artwork") }) {
        auto value = debugValue(item, pair.second);
        if (value.type == JsonValue::Null) {
            value = diagnosticObject(); diagnosticSetString(value.object, "status", "Not available for this track");
        }
        out.object[pair.first] = value;
    }
    std::set<std::string> urls;
    diagnosticAssetUrls(debugValue(item, "coverUrl"), urls);
    diagnosticAssetUrls(debugValue(item, "artwork"), urls);
    const auto matchesUrl = [&](const std::string& url) {
        if (url.empty()) return false;
        const auto params = diagnosticQuery(url);
        const auto album = params.find("album"), title = params.find("track"), asset = params.find("url");
        if (album != params.end()) return same(album->second, title == params.end() ? "" : title->second);
        if (asset != params.end()) return urls.count(asset->second) != 0;
        return urls.count(url) != 0;
    };
    auto requests = diagnosticArray(), events = diagnosticArray();
    for (const auto& request : debugValue(snapshot, "requests").array) {
        const auto& body = debugValue(request, "response");
        std::string album = debugValue(body, "Album").string, title = debugValue(body, "Track").string;
        // Only the explicitly opened debug view needs feed association. Logging
        // itself retains response text and never parses it.
        if (body.type == JsonValue::String) {
            JsonView feed;
            if (readJsonView(body.string, feed)) {
                feed.get("Album").scalarText(album); feed.get("Track").scalarText(title);
            }
        }
        if (matchesUrl(debugValue(request, "url").string)
                || same(album, title)) requests.array.push_back(request);
    }
    for (const auto& event : debugValue(snapshot, "events").array) {
        const auto& details = debugValue(event, "details");
        if (same(debugValue(details, "album").string, debugValue(details, "track").string)
                || matchesUrl(debugValue(details, "url").string)
                || (details.type == JsonValue::String && matchesUrl(details.string))) events.array.push_back(event);
    }
    out.object["requests"] = requests; out.object["events"] = events;
    return out;
}
}

#endif // SSC_ENABLE_DEBUG_OVERLAY
