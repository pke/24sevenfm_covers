#pragma once
#include "engine_settings.h"
#include "stations.h"
#include <algorithm>
#include <cstring>
#include <vector>

namespace ssccfg {
enum class Profile { Windows, MacOS, Linux };
enum class SettingType { Boolean, Integer, Choice, OrderedSelection, Secret, Timestamp };
struct Choice { std::string value, label; };
struct Requirement {
    std::string key, value; // AND of comparisons using canonical keys and values
    bool notEqual = false;
};
struct SettingDescriptor {
    std::string key, storageKey, label, group;
    SettingType type = SettingType::Boolean;
    int defaultInt = 0, minimum = 0, maximum = 1, step = 1, maxLength = 0;
    std::string defaultText, unit;
    bool ui = true, hostOwned = false, desktopOnly = false, supported = true;
    bool stringValue = false, secret = false, selectable = true;
    int minimumSelections = 0;
    std::vector<Choice> choices;
    std::vector<Requirement> enabledWhen;
    // Semantic applicability is distinct from whether a legacy UI disables a control.
    std::vector<Requirement> appliesWhen;
};

inline std::vector<SettingDescriptor> makeSchema(Profile profile) {
    std::vector<SettingDescriptor> result;
#define SSC_DESCRIBE_BOOL(field, persisted, value, title, section) \
    { SettingDescriptor d; d.key = #field; d.storageKey = persisted; \
      d.label = title; d.group = section; d.defaultInt = value; result.push_back(d); }
    SSC_BOOL_SETTINGS(SSC_DESCRIBE_BOOL)
#undef SSC_DESCRIBE_BOOL
#define SSC_DESCRIBE_INT(field, persisted, value, lo, hi, title, section) \
    { SettingDescriptor d; d.key = #field; d.storageKey = persisted; \
      d.label = title; d.group = section; d.type = SettingType::Integer; \
      d.defaultInt = value; d.minimum = lo; d.maximum = hi; result.push_back(d); }
    SSC_INT_SETTINGS(SSC_DESCRIBE_INT)
#undef SSC_DESCRIBE_INT
    auto add = [&](const char* key, const char* title, const char* group, SettingType type) -> SettingDescriptor& {
        SettingDescriptor d; d.key = d.storageKey = key; d.label = title; d.group = group; d.type = type;
        result.push_back(d); return result.back();
    };
    auto& station = add("station", "Station", "station", SettingType::Choice);
    station.desktopOnly = station.stringValue = true; station.defaultText = ssc::station(0).id;
    for (const auto& s : ssc::kStations) station.choices.push_back({s.id, s.displayName});
    auto& providers = add("mediaProviders", "Artwork lookup order", "providers", SettingType::OrderedSelection);
    providers.stringValue = true; providers.defaultText = defaultProviders; providers.minimumSelections = 1;
    providers.choices = {{"fanart", "fanart.tv"}, {"tmdb", "TMDB"}, {"tvmaze", "TVmaze"}, {"steamgriddb", "SteamGridDB"}};
    auto& key = add("fanartClientKey", "Personal fanart.tv key", "providers", SettingType::Secret);
    key.stringValue = key.secret = true; key.maxLength = fanartKeyMaxLength;
    auto& verified = add("fanartClientKeyVerifiedAt", "Key verification time", "providers", SettingType::Timestamp);
    verified.ui = false; verified.stringValue = true; verified.defaultText = "0"; verified.unit = "unix-ms";
    auto& top = add("alwaysOnTop", "Keep window on top", "window", SettingType::Boolean);
    top.hostOwned = top.desktopOnly = true; top.supported = profile != Profile::Windows;
    auto& motion = add("reducedMotion", "Reduce motion", "accessibility", SettingType::Boolean);
    motion.hostOwned = motion.desktopOnly = true; motion.supported = profile == Profile::Linux;
    if(profile == Profile::Linux) {
        auto& renderer = add("renderer", "Renderer", "rendering", SettingType::Choice);
        renderer.hostOwned = renderer.desktopOnly = renderer.stringValue = true;
        renderer.defaultText = "raster";
        renderer.choices = {{"raster", "QPainter / Raster"}, {"opengl-direct", "OpenGL"},
            {"opengl", "OpenGL (exact appearance)"}, {"rhi-opengl", "RHI / OpenGL"}, {"rhi-vulkan", "RHI / Vulkan"}};
    }

    for (auto& d : result) {
        const auto& k = d.key;
        if (k == "remainingSize") { d.type = SettingType::Choice; d.choices = {{"0", "Small"}, {"1", "Medium"}, {"2", "Large"}}; }
        if (k == "transition") { d.type = SettingType::Choice; d.choices = {{"0", "None"}, {"1", "Crossfade"}, {"2", "Flip horizontal"}, {"3", "Flip vertical"}}; }
        if (k == "layout") { d.type = SettingType::Choice; d.choices = {{"0", "Fill window"}, {"1", "Poster"}}; }
        if (k == "fadeMs") { d.step = profile == Profile::MacOS ? 250 : 100; d.unit = "ms"; }
        if (k == "borderRadius") d.unit = "per-mille";
        if (k == "posterBlur" || k == "borderRadius") { d.ui = false; d.supported = profile == Profile::Windows; }
        if (k == "remainingSize" || k == "rollDigits") d.appliesWhen = {{"showRemaining", "true"}};
        if (k == "fadeMs") d.appliesWhen = {{"transition", "0", true}};
        if (k == "backdrops" || k == "ratings" || k == "titleLogos" || k == "hideCoverWithBackdrop" || k == "ratingDE" || k == "ratingUS" || k == "mediaProviders")
            d.appliesWhen.push_back({"station", "sst"});
        if (k == "titleLogos" || k == "hideCoverWithBackdrop") d.appliesWhen.push_back({"backdrops", "true"});
        if (k == "ratingDE" || k == "ratingUS") d.appliesWhen.push_back({"ratings", "true"});
        if (profile == Profile::Windows) {
            if (k == "remainingSize" || k == "rollDigits" || k == "fadeMs") d.enabledWhen = d.appliesWhen;
            if (k == "hideCoverWithBackdrop" || k == "titleLogos" || k == "mediaProviders" || k == "fanartClientKey") d.enabledWhen = {{"backdrops", "true"}};
            if (k == "ratingDE" || k == "ratingUS") d.enabledWhen = {{"ratings", "true"}};
        } else {
            if (k == "layout") d.storageKey = "poster";
            if (k == "showRemaining") d.storageKey = "countdown";
            if (k == "titleLogos") d.storageKey = "logos";
            if (k == "hideCoverWithBackdrop") d.storageKey = "hideCover";
            if (k == "mediaProviders") d.storageKey = "providers";
            if (k == "rollDigits") d.storageKey = "rollDigits";
            if (profile == Profile::MacOS) {
                if (k != "mediaProviders") d.enabledWhen = d.appliesWhen;
                if (k == "fanartClientKeyVerifiedAt") d.storageKey = "fanartKeyVerifiedAt";
            } else {
                if (k == "remainingSize") { d.storageKey = "countdownSize"; }
                if (k == "rollDigits") { d.storageKey = "rolling"; }
                if (k == "comingNext") { d.storageKey = "next"; }
                if (k == "transition") { d.storageKey = "effect"; d.choices[0].label = "Fade only"; }
                if (k == "fanartClientKey") d.storageKey = "fanartKey";
                if (k == "fadeMs" || k == "fanartClientKeyVerifiedAt") d.supported = false;
                if (k == "mediaProviders") d.selectable = false; // current Linux UI only reorders
                if (k == "backdrops" || k == "titleLogos" || k == "ratings") d.enabledWhen = {{"station", "sst"}};
            }
        }
    }
    return result;
}

// Immutable, entirely static metadata. Calling this never initializes a viewer,
// accesses preferences, performs network I/O, or reads a listener's credentials.
inline const std::vector<SettingDescriptor>& settingsSchema(Profile profile = Profile::Windows) {
    static const auto windows = makeSchema(Profile::Windows);
    static const auto mac = makeSchema(Profile::MacOS);
    static const auto linuxSchema = makeSchema(Profile::Linux);
    return profile == Profile::MacOS ? mac : profile == Profile::Linux ? linuxSchema : windows;
}
inline const SettingDescriptor* findSetting(const std::string& key, Profile profile = Profile::Windows) {
    for (const auto& d : settingsSchema(profile)) if (d.key == key) return &d;
    return nullptr;
}
inline int clampSetting(const char* key, int value) {
    const auto* d = findSetting(key);
    return d ? (std::max)(d->minimum, (std::min)(d->maximum, value)) : value;
}
inline int snapDuration(int value, Profile profile = Profile::Windows) {
    const auto& d = *findSetting("fadeMs", profile);
    return clampSetting("fadeMs", ((value + d.step / 2) / d.step) * d.step);
}
} // namespace ssccfg
