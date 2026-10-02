#pragma once
#include "debug_features.h"
#if SSC_ENABLE_DEBUG_OVERLAY
#include "platform_text.h"
#include "diagnostics.h"
#include "platform_time.h"

namespace ssc {
inline const JsonValue& debugValue(const JsonValue& value, const char* key) {
    static const JsonValue empty;
    const auto* found = value.get(key); return found ? *found : empty;
}
inline double diagnosticEpochMs() {
    return platform::utcNowMillisecondsPrecise();
}
// Observations are made by the scheduler, independently of the overlay. The
// owner holds its worker lock; this model neither reads nor copies image bytes.
class DiagnosticTimeline {
public:
    explicit DiagnosticTimeline(size_t limit = 40) : limit_(limit) {}
    void observe(const std::string& station, const DiagnosticTrack& track, double now = diagnosticEpochMs());
    JsonValue entries(const std::vector<TrackInfo>& queue, double remaining, double now = diagnosticEpochMs()) const;
private:
    static std::string identity(const DiagnosticTrack& item) {
        return item.album + "\n" + item.track + "\n" + item.occurrence;
    }
    struct Record { DiagnosticTrack track; unsigned serial = 0; double at = 0; };
    size_t limit_; unsigned serial_ = 0;
    bool haveCurrent_ = false;
    std::string station_; Record current_; std::vector<Record> past_;
};
}

#endif // SSC_ENABLE_DEBUG_OVERLAY
