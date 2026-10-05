// Portable settings persistence and the optional native INI adapter.
#ifndef SSC_CONFIG_H
#define SSC_CONFIG_H

#include <string>
#include <set>
#include <utility>
#include <cstdlib>
#include <cstdio>

#include "config_store.h" // ssccfg::ConfigStore + clampInt (Win32-free, so tests can fake it)
#include "settings_schema.h"
#ifdef _WIN32
#include <windows.h>
#endif
#include "stations.h"     // station id <-> index
#include "../lib/platform_text.h"

namespace ssccfg {

inline bool validProviderList(const std::string& csv) {
    std::set<std::string> seen;
    size_t begin = 0;
    while (begin <= csv.size()) {
        const size_t end = csv.find(',', begin);
        const std::string id = csv.substr(begin,
            end == std::string::npos ? std::string::npos : end - begin);
        bool known = false;
        for (const auto& choice : findSetting("mediaProviders")->choices)
            if (choice.value == id) { known = true; break; }
        if (!known) return false;
        if (!seen.insert(id).second) return false;
        if (end == std::string::npos) break;
        begin = end + 1;
    }
    return !seen.empty();
}

inline std::string cleanFanartClientKey(std::string value) {
    const size_t first = ssc::platform::firstNotOf(value, " \t\r\n");
    if (first == std::string::npos) return std::string();
    const size_t last = ssc::platform::lastNotOf(value, " \t\r\n");
    value = value.substr(first, last - first + 1);
    if (value.size() > fanartKeyMaxLength) return std::string();
    for (unsigned char c : value) if (c < 0x20 || c == 0x7f) return std::string();
    return value;
}

inline unsigned long long cleanVerificationTime(const std::string& value) {
    if (value.empty()) return 0;
    char* end = nullptr;
    const unsigned long long parsed = std::strtoull(value.c_str(), &end, 10);
    return end && *end == '\0' && parsed <= 8640000000000000ULL ? parsed : 0;
}

// Load every option into `s`, clamped to its valid range. Returns true if a station
// was stored (false = first run, so the viewer can prompt for one).
inline bool load(EngineSettings& s, ConfigStore& store) {
#define SSC_LOAD_BOOL(field, key, value, label, group) s.field = store.readInt(key, value) != 0;
    SSC_BOOL_SETTINGS(SSC_LOAD_BOOL)
#undef SSC_LOAD_BOOL
#define SSC_LOAD_INT(field, key, value, lo, hi, label, group) s.field = clampInt(store.readInt(key, value), lo, hi);
    SSC_INT_SETTINGS(SSC_LOAD_INT)
#undef SSC_LOAD_INT
    if (!s.ratingDE && !s.ratingUS) s.ratingDE = true;
    const std::string providers = store.readStr("mediaProviders", defaultProviders);
    // Resolver validation remains the final boundary. This cheap persistence guard
    // prevents arbitrary/empty values from disabling every provider after an INI edit.
    s.mediaProviders = validProviderList(providers)
        ? providers : defaultProviders;
    s.fanartClientKey = cleanFanartClientKey(store.readStr("fanartClientKey", ""));
    s.fanartClientKeyVerifiedAt = s.fanartClientKey.empty() ? 0
        : cleanVerificationTime(store.readStr("fanartClientKeyVerifiedAt", "0"));
    const std::string stationId = store.readStr("station", "");
    s.station = ssc::validStationIndex(ssc::stationIndexForId(stationId.c_str()));
    return !stationId.empty();
}

inline void save(const EngineSettings& s, ConfigStore& store) {
#define SSC_SAVE_BOOL(field, key, value, label, group) store.writeInt(key, s.field ? 1 : 0);
    SSC_BOOL_SETTINGS(SSC_SAVE_BOOL)
#undef SSC_SAVE_BOOL
#define SSC_SAVE_INT(field, key, value, lo, hi, label, group) store.writeInt(key, s.field);
    SSC_INT_SETTINGS(SSC_SAVE_INT)
#undef SSC_SAVE_INT
    store.writeStr("mediaProviders", s.mediaProviders.c_str());
    const std::string fanartKey = cleanFanartClientKey(s.fanartClientKey);
    store.writeStr("fanartClientKey", fanartKey.c_str());
    const std::string verifiedAt = ssc::platform::unsignedText(
        fanartKey.empty() ? 0ULL : s.fanartClientKeyVerifiedAt);
    store.writeStr("fanartClientKeyVerifiedAt", verifiedAt.c_str());
    store.writeStr("station",       ssc::station(s.station).id);
}

// INI-file adapter used by the Winamp plugin and the desktop viewer: everything in
// the [options] section of the given .ini path.
#ifdef _WIN32
struct IniConfigStore : ConfigStore {
    std::string path;
    explicit IniConfigStore(std::string iniPath) : path(std::move(iniPath)) {}
    int readInt(const char* key, int def) override {
        return (int)GetPrivateProfileIntA("options", key, def, path.c_str());
    }
    void writeInt(const char* key, int value) override {
        char buf[16]; wsprintfA(buf, "%d", value);
        WritePrivateProfileStringA("options", key, buf, path.c_str());
    }
    std::string readStr(const char* key, const char* def) override {
        char buf[512] = {0};
        GetPrivateProfileStringA("options", key, def, buf, (DWORD)sizeof(buf), path.c_str());
        return buf;
    }
    void writeStr(const char* key, const char* value) override {
        WritePrivateProfileStringA("options", key, value, path.c_str());
    }
};

#endif // _WIN32

} // namespace ssccfg

#endif // SSC_CONFIG_H
