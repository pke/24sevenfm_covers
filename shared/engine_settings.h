#pragma once
#include <string>

// Field, persisted Windows key, default, minimum, maximum, UI label, group.
// These declarations feed both the settings object and its static description.
#define SSC_BOOL_SETTINGS(X) \
    X(showRemaining, "showRemaining", false, "Show countdown", "countdown") \
    X(comingNext, "comingNext", false, "Coming Next", "countdown") \
    X(rollDigits, "roll", false, "Rolling digits", "countdown") \
    X(backdrops, "backdrops", false, "SST backdrops", "artwork") \
    X(titleLogos, "titleLogos", false, "SST title logos", "artwork") \
    X(ratings, "ratings", false, "SST age ratings", "ratings") \
    X(hideCoverWithBackdrop, "hideCoverWithBackdrop", true, "Hide cover over backdrops", "artwork") \
    X(ratingDE, "ratingDE", true, "Germany (DE)", "ratings") \
    X(ratingUS, "ratingUS", true, "United States (US)", "ratings")
#define SSC_INT_SETTINGS(X) \
    X(remainingSize, "remainingSize", 0, 0, 2, "Countdown size", "countdown") \
    X(transition, "transition", 1, 0, 3, "Transition", "artwork") \
    X(fadeMs, "fadeMs", 1000, 500, 2000, "Transition duration", "artwork") \
    X(layout, "layout", 0, 0, 1, "Layout", "display") \
    X(posterBlur, "posterBlur", 24, 0, 200, "Poster blur", "display") \
    X(borderRadius, "borderRadius", 45, 0, 500, "Corner radius", "display")

namespace ssccfg {
constexpr const char* defaultProviders = "fanart,tmdb,tvmaze,steamgriddb";
constexpr int fanartKeyMaxLength = 128;

// No platform headers, windows, rendering resources, or storage access.
struct EngineSettings {
#define SSC_DECLARE_BOOL(field, key, value, label, group) bool field = value;
    SSC_BOOL_SETTINGS(SSC_DECLARE_BOOL)
#undef SSC_DECLARE_BOOL
#define SSC_DECLARE_INT(field, key, value, lo, hi, label, group) int field = value;
    SSC_INT_SETTINGS(SSC_DECLARE_INT)
#undef SSC_DECLARE_INT
    int station = 0; // in-memory index; persisted/exported as a stable station id
    std::string mediaProviders = defaultProviders;
    std::string fanartClientKey;
    unsigned long long fanartClientKeyVerifiedAt = 0; // derived Unix milliseconds
};
} // namespace ssccfg
