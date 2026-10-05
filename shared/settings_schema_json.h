#pragma once
#include "settings_schema.h"
#include "../lib/platform_text.h"

namespace ssccfg {
namespace schema_detail {
inline std::string quote(const std::string& text) {
    std::string out = "\"";
    const char* hex = "0123456789abcdef";
    for (unsigned char c : text) {
        if (c == '"' || c == '\\') { out += '\\'; out += c; }
        else if (c < 32) { out += "\\u00"; out += hex[c >> 4]; out += hex[c & 15]; }
        else out += c;
    }
    return out + '"';
}
inline const char* boolean(bool value) { return value ? "true" : "false"; }
inline std::string number(int value) { return ssc::platform::signedText(value); }
inline const char* type(SettingType value) {
    switch (value) {
    case SettingType::Boolean: return "boolean";
    case SettingType::Integer: return "integer";
    case SettingType::Choice: return "choice";
    case SettingType::OrderedSelection: return "ordered-selection";
    case SettingType::Secret: return "secret";
    case SettingType::Timestamp: return "timestamp";
    }
    return "unknown";
}
inline std::string conditions(const std::vector<Requirement>& requirements) {
    std::string out = "[";
    for (const auto& r : requirements) {
        if (out.size() > 1) out += ',';
        out += "{\"key\":" + quote(r.key) + ",\"operator\":" + quote(r.notEqual ? "not-equal" : "equal") + ",\"value\":" + quote(r.value) + '}';
    }
    return out + ']';
}
} // namespace schema_detail

// A versioned metadata document, NOT a dump of current preferences. In particular
// the secret's default is always empty, and verification time is never read.
inline std::string settingsSchemaJson(Profile profile = Profile::Windows) {
    using namespace schema_detail;
    std::string out = "{\"schemaVersion\":1,\"profile\":";
    out += quote(profile == Profile::MacOS ? "macos" : profile == Profile::Linux ? "linux" : "windows");
    out += ",\"ratingCountryMinimumSelections\":" + number(profile == Profile::Windows ? 1 : 0);
    out += ",\"settings\":[";
    bool first = true;
    for (const auto& d : settingsSchema(profile)) {
        if (!first) out += ',';
        first = false;
        out += "\n{\"key\":" + quote(d.key) + ",\"storageKey\":" + quote(d.storageKey);
        out += ",\"label\":" + quote(d.label) + ",\"group\":" + quote(d.group) + ",\"type\":" + quote(type(d.type));
        out += ",\"default\":" + (d.stringValue ? quote(d.defaultText) : d.type == SettingType::Boolean ? std::string(boolean(d.defaultInt != 0)) : number(d.defaultInt));
        out += ",\"ui\":" + std::string(boolean(d.ui)) + ",\"supported\":" + boolean(d.supported);
        out += ",\"owner\":" + quote(d.hostOwned ? "host" : "engine") + ",\"desktopOnly\":" + boolean(d.desktopOnly);
        const char* control = !d.ui ? "none" : d.type == SettingType::Boolean ? "checkbox" : d.type == SettingType::Choice ? "radio-group" : d.type == SettingType::Integer ? "slider" : d.type == SettingType::OrderedSelection ? "ordered-checkbox-list" : "password";
        out += ",\"control\":" + quote(control);
        out += ",\"sensitive\":" + std::string(boolean(d.secret));
        if (d.type == SettingType::Integer || (d.type == SettingType::Choice && !d.stringValue))
            out += ",\"minimum\":" + number(d.minimum) + ",\"maximum\":" + number(d.maximum) + ",\"step\":" + number(d.step);
        if (d.maxLength) out += ",\"maxLength\":" + number(d.maxLength);
        if (!d.unit.empty()) out += ",\"unit\":" + quote(d.unit);
        if (d.type == SettingType::OrderedSelection) {
            out += ",\"encoding\":\"csv\",\"unique\":true,\"minimumSelections\":" + number(d.minimumSelections);
            out += ",\"selectable\":" + std::string(boolean(d.selectable));
        }
        out += ",\"choices\":[";
        bool firstChoice = true;
        for (const auto& c : d.choices) {
            if (!firstChoice) out += ',';
            firstChoice = false;
            out += "{\"value\":" + quote(c.value) + ",\"label\":" + quote(c.label) + '}';
        }
        out += "],\"enabledWhen\":" + conditions(d.enabledWhen) + ",\"appliesWhen\":" + conditions(d.appliesWhen) + '}';
    }
    return out + "\n]}\n";
}
} // namespace ssccfg
