#pragma once
#include "diagnostics.h"

namespace ssc {
inline const JsonValue& debugValue(const JsonValue& value, const char* key) {
    static const JsonValue empty;
    const auto* found = value.get(key); return found ? *found : empty;
}
inline double diagnosticEpochMs() {
    return std::chrono::duration<double, std::milli>(std::chrono::system_clock::now().time_since_epoch()).count();
}
// Observations are made by the scheduler, independently of the overlay. The
// owner holds its worker lock; this model neither reads nor copies image bytes.
class DiagnosticTimeline {
public:
    explicit DiagnosticTimeline(size_t limit = 40) : limit_(limit) {}
    void observe(const std::string& station, const JsonValue& track, double now = diagnosticEpochMs()) {
        if (station != station_) { station_ = station; past_.clear(); current_ = JsonValue(); }
        if (debugValue(track, "album").string.empty() && debugValue(track, "track").string.empty()) return;
        if (current_.type != JsonValue::Null && identity(current_) == identity(track)) {
            for (const auto& field : track.object) current_.object[field.first] = field.second;
            return;
        }
        if (current_.type != JsonValue::Null) {
            past_.push_back(current_); if (past_.size() > limit_) past_.erase(past_.begin());
        }
        current_ = track;
        current_.object["id"] = diagnosticString("play-" + std::to_string(++serial_));
        current_.object["observedAt"] = diagnosticNumber(now);
    }
    JsonValue entries(const std::vector<JsonValue>& queue, double remaining, double now = diagnosticEpochMs()) const {
        JsonValue result = diagnosticArray();
        if (current_.type == JsonValue::Null) return result;
        for (auto item : past_) {
            item.object["phase"] = diagnosticString("past");
            item.object["timeKind"] = diagnosticString("observed");
            item.object["relativeSeconds"] = diagnosticNumber((debugValue(item, "observedAt").number - now) / 1000);
            result.array.push_back(item);
        }
        auto current = current_;
        current.object["phase"] = diagnosticString("current");
        current.object["timeKind"] = diagnosticString("current");
        current.object["relativeSeconds"] = diagnosticNumber(0); result.array.push_back(current);
        double offset = remaining;
        for (size_t i = 0; i < queue.size() && i < 40; ++i) {
            auto item = queue[i];
            item.object["id"] = diagnosticString("queue-" + identity(item) + "-" + std::to_string(i));
            item.object["phase"] = diagnosticString("future");
            item.object["timeKind"] = diagnosticString("estimated");
            item.object["relativeSeconds"] = offset >= 0 ? diagnosticNumber(offset) : JsonValue();
            const double length = debugValue(item, "lengthSeconds").number;
            offset = offset >= 0 && length > 0 ? offset + length : -1;
            result.array.push_back(item);
        }
        return result;
    }
private:
    static std::string identity(const JsonValue& item) {
        return debugValue(item, "album").string + "\n" + debugValue(item, "track").string
            + "\n" + debugValue(item, "occurrence").string;
    }
    size_t limit_; unsigned serial_ = 0;
    std::string station_; JsonValue current_; std::vector<JsonValue> past_;
};
}
