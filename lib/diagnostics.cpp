#include "debug_features.h"
#if SSC_ENABLE_DEBUG_OVERLAY
#include "diagnostics.h"
#include "coverfetch.h"
#include "diagnostic_timeline.h"
#include <utility>

namespace ssc {
JsonValue& diagnosticSet(std::map<std::string, JsonValue>& object, const char* key, JsonValue value) {
    auto& field = object[key]; field = std::move(value); return field;
}
JsonValue& diagnosticSetString(std::map<std::string, JsonValue>& object, const char* key, const std::string& text) {
    return diagnosticSet(object, key, diagnosticString(text));
}
JsonValue& diagnosticSetString(std::map<std::string, JsonValue>& object, const char* key, const char* text) {
    return diagnosticSetString(object, key, std::string(text));
}
JsonValue& diagnosticSetNumber(std::map<std::string, JsonValue>& object, const char* key, double number) {
    return diagnosticSet(object, key, diagnosticNumber(number));
}
JsonValue& diagnosticSetBool(std::map<std::string, JsonValue>& object, const char* key, bool boolean) {
    return diagnosticSet(object, key, diagnosticBool(boolean));
}
namespace {
size_t quotedEnd(const std::string& s, size_t p) {
    ++p;
    while (p < s.size()) {
        const char c = s[p++];
        if (c == '"') return p;
        if (c == '\\' && p < s.size()) ++p;
    }
    return p;
}
int digit(char c) {
    return c >= '0' && c <= '9' ? c-'0' : c >= 'a' && c <= 'f' ? c-'a'+10
        : c >= 'A' && c <= 'F' ? c-'A'+10 : -1;
}
std::string asciiToken(const std::string& s, size_t begin, size_t end) {
    // Decode ASCII escapes in a property name so "client_\u006bey" is
    // redacted too. This is a text redactor, not a JSON parser or value tree.
    std::string name;
    for (size_t p = begin + 1; p + 1 < end;) {
        unsigned char c = s[p++];
        if (c == '\\' && p + 1 < end) {
            c = s[p++];
            if (c == 'u' && end - p > 4) {
                unsigned cp = 0; bool valid = true;
                for (unsigned i = 0; i < 4; ++i) {
                    const int h = digit(s[p+i]); if (h < 0) { valid = false; break; }
                    cp = (cp << 4) | static_cast<unsigned>(h);
                }
                if (valid) { p += 4; c = cp < 128 ? static_cast<unsigned char>(cp) : '?'; }
            }
        }
        name += c;
    }
    return name;
}
size_t valueEnd(const std::string& s, size_t p) {
    unsigned depth = 0;
    while (p < s.size()) {
        const char c = s[p];
        if (c == '"') { p = quotedEnd(s, p); continue; }
        if (c == '[' || c == '{') ++depth;
        else if (c == ']' || c == '}') { if (!depth) break; --depth; }
        else if (c == ',' && !depth) break;
        ++p;
    }
    return p;
}
std::string responseText(const std::string& body) {
    if (body.size() > 65536) return "[body truncated]";
    size_t start = 0;
    while (start < body.size() && diagnosticSpace(body[start])) ++start;
    if (start == body.size() || (body[start] != '{' && body[start] != '[')) return "[non-JSON body omitted]";
    std::string safe;
    for (size_t p = 0; p < body.size();) {
        if (body[p] != '"') { safe += body[p++]; continue; }
        const size_t end = quotedEnd(body, p);
        size_t colon = end;
        while (colon < body.size() && diagnosticSpace(body[colon])) ++colon;
        if (colon < body.size() && body[colon] == ':' && diagnosticSecret(asciiToken(body, p, end))) {
            safe.append(body, p, end - p);
            safe.append(body, end, colon + 1 - end);
            safe += "\"[redacted]\"";
            p = valueEnd(body, colon + 1);
        } else {
            // Detect credentials hidden in escaped URL text without building a
            // response tree. Only a redacted string changes its original format.
            const auto text = asciiToken(body, p, end);
            if (diagnosticSafeText(text, 65536) != text) safe += "\"[redacted URL]\"";
            else safe.append(body, p, end - p);
            p = end;
        }
    }
    return diagnosticSafeText(std::move(safe), 65536);
}
}

DiagnosticTrack diagnosticTrackRecord(const TrackInfo& track) {
    DiagnosticTrack out;
    out.album = diagnosticSafeText(track.album); out.track = diagnosticSafeText(track.track);
    out.artist = diagnosticSafeText(track.artist); out.coverUrl = diagnosticSafeText(track.coverUrl);
    out.lengthSeconds = track.lengthSeconds; return out;
}
JsonValue diagnosticTrack(const DiagnosticTrack& track) {
    auto value = diagnosticObject();
    diagnosticSetString(value.object, "album", track.album);
    diagnosticSetString(value.object, "track", track.track);
    diagnosticSetString(value.object, "artist", track.artist);
    diagnosticSetString(value.object, "coverUrl", track.coverUrl);
    diagnosticSetNumber(value.object, "lengthSeconds", track.lengthSeconds);
    if (!track.occurrence.empty()) diagnosticSetString(value.object, "occurrence", track.occurrence);
    return value;
}
DiagnosticLog& DiagnosticLog::instance() { static DiagnosticLog log; return log; }
void DiagnosticLog::request(const std::string& url, const HttpResponse& response, double totalMs) {
    Request entry;
    entry.at = diagnosticTimestamp(); entry.url = diagnosticSafeText(url);
    entry.status = response.status; entry.headersMs = response.headersMs; entry.totalMs = totalMs;
    entry.bytes = response.body.size(); entry.response = responseText(response.body);
    entry.cacheStatus = diagnosticSafeText(response.cacheStatus.empty() ? "unknown" : response.cacheStatus);
    entry.cacheControl = diagnosticSafeText(response.cacheControl); entry.age = diagnosticSafeText(response.age);
    entry.error = diagnosticSafeText(response.error);
    platform::LockGuard lock(mutex_);
    requests_.push_back(std::move(entry)); if (requests_.size() > 30) requests_.erase(requests_.begin());
}
void DiagnosticLog::add(Event&& entry) {
    entry.at = diagnosticTimestamp();
    platform::LockGuard lock(mutex_);
    events_.push_back(std::move(entry)); if (events_.size() > 30) events_.erase(events_.begin());
}
void DiagnosticLog::event(const std::string& name, const std::string& details) {
    Event entry; entry.name = diagnosticSafeText(name); entry.text = diagnosticSafeText(details); add(std::move(entry));
}
void DiagnosticLog::event(const std::string& name, const TrackInfo& track) {
    Event entry; entry.kind = Event::Track; entry.name = diagnosticSafeText(name);
    entry.track = diagnosticTrackRecord(track); add(std::move(entry));
}
void DiagnosticLog::image(const std::string& url, size_t bytes, unsigned width, unsigned height, double ms, bool valid) {
    Event entry; entry.kind = Event::Image; entry.name = "image.decode"; entry.text = diagnosticSafeText(url);
    entry.bytes = bytes; entry.width = width; entry.height = height; entry.ms = ms; entry.valid = valid;
    add(std::move(entry));
}
JsonValue DiagnosticLog::snapshot() {
    platform::LockGuard lock(mutex_);
    auto out = diagnosticObject();
    diagnosticSetString(out.object, "capturedAt", diagnosticTimestamp());
    diagnosticSetNumber(out.object, "schemaVersion", 1);
    auto& requests = out.object["requests"] = diagnosticArray();
    for (const auto& request : requests_) {
        auto value = diagnosticObject(); auto& p = value.object;
        diagnosticSetString(p, "at", request.at); diagnosticSetString(p, "url", request.url);
        diagnosticSetNumber(p, "status", request.status);
        p["headersMs"] = request.headersMs < 0 ? JsonValue() : diagnosticNumber(request.headersMs);
        diagnosticSetNumber(p, "downloadMs", request.totalMs); diagnosticSetNumber(p, "totalMs", request.totalMs);
        diagnosticSetNumber(p, "responseBytes", static_cast<double>(request.bytes));
        diagnosticSetString(p, "httpCache", request.cacheStatus); diagnosticSetString(p, "cacheControl", request.cacheControl);
        diagnosticSetString(p, "ageSeconds", request.age); diagnosticSetString(p, "error", request.error);
        diagnosticSetString(p, "response", request.response);
        requests.array.push_back(std::move(value));
    }
    auto& events = out.object["events"] = diagnosticArray();
    for (const auto& event : events_) {
        auto value = diagnosticObject(); diagnosticSetString(value.object, "at", event.at);
        diagnosticSetString(value.object, "name", event.name);
        JsonValue details;
        if (event.kind == Event::Text) details = diagnosticString(event.text);
        else if (event.kind == Event::Track) details = diagnosticTrack(event.track);
        else {
            details = diagnosticObject(); auto& p = details.object;
            diagnosticSetString(p, "url", event.text); diagnosticSetNumber(p, "bytes", static_cast<double>(event.bytes));
            p["width"] = event.width ? diagnosticNumber(event.width) : JsonValue();
            p["height"] = event.height ? diagnosticNumber(event.height) : JsonValue();
            diagnosticSetNumber(p, "decodeMs", event.ms); diagnosticSetBool(p, "valid", event.valid);
        }
        value.object["details"] = std::move(details); events.array.push_back(std::move(value));
    }
    return out;
}
void DiagnosticTimeline::observe(const std::string& station, const DiagnosticTrack& track, double now) {
    if (station != station_) { station_ = station; past_.clear(); haveCurrent_ = false; }
    if (track.album.empty() && track.track.empty()) return;
    if (haveCurrent_ && current_.track.album == track.album && current_.track.track == track.track
            && current_.track.occurrence == track.occurrence) { current_.track = track; return; }
    if (haveCurrent_) {
        past_.push_back(std::move(current_)); if (past_.size() > limit_) past_.erase(past_.begin());
    }
    current_.track = track; current_.serial = ++serial_; current_.at = now; haveCurrent_ = true;
}
JsonValue DiagnosticTimeline::entries(const std::vector<TrackInfo>& queue, double remaining, double now) const {
    auto result = diagnosticArray();
    if (!haveCurrent_) return result;
    for (const auto& record : past_) {
        auto item = diagnosticTrack(record.track);
        diagnosticSetString(item.object, "id", "play-" + platform::integerText(record.serial));
        diagnosticSetNumber(item.object, "observedAt", record.at);
        diagnosticSetString(item.object, "phase", "past"); diagnosticSetString(item.object, "timeKind", "observed");
        diagnosticSetNumber(item.object, "relativeSeconds", (record.at - now) / 1000);
        result.array.push_back(std::move(item));
    }
    auto item = diagnosticTrack(current_.track);
    diagnosticSetString(item.object, "id", "play-" + platform::integerText(current_.serial));
    diagnosticSetNumber(item.object, "observedAt", current_.at);
    diagnosticSetString(item.object, "phase", "current"); diagnosticSetString(item.object, "timeKind", "current");
    diagnosticSetNumber(item.object, "relativeSeconds", 0); result.array.push_back(std::move(item));
    double offset = remaining;
    for (size_t i = 0; i < queue.size() && i < 40; ++i) {
        const auto track = diagnosticTrackRecord(queue[i]); item = diagnosticTrack(track);
        diagnosticSetString(item.object, "id", "queue-" + identity(track) + "-" + platform::integerText(i));
        diagnosticSetString(item.object, "phase", "future"); diagnosticSetString(item.object, "timeKind", "estimated");
        item.object["relativeSeconds"] = offset >= 0 ? diagnosticNumber(offset) : JsonValue();
        offset = offset >= 0 && track.lengthSeconds > 0 ? offset + track.lengthSeconds : -1;
        result.array.push_back(std::move(item));
    }
    return result;
}
}

#endif
