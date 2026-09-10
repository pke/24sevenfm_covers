// config.h - one place that owns the option schema: the keys, defaults, valid
// ranges (clamping) and the load/save order for CoverEngine::Settings. WHERE the
// values live is hidden behind the ConfigStore adapter - an INI file for the Winamp
// plugin and the desktop viewer, GUID-keyed cfg_vars for foobar2000 - so that INI vs
// GUID is an implementation detail, not something each host re-implements.
#ifndef SSC_CONFIG_H
#define SSC_CONFIG_H

#include <string>
#include <set>
#include <utility>
#include <cstdlib>
#include <cstdio>

#include "config_store.h" // ssccfg::ConfigStore + clampInt (Win32-free, so tests can fake it)
#include "cover_engine.h" // CoverEngine::Settings (pulls <windows.h>)
#include "stations.h"     // station id <-> index

namespace ssccfg {

inline bool validProviderList(const std::string& csv) {
    std::set<std::string> seen;
    size_t begin = 0;
    while (begin <= csv.size()) {
        const size_t end = csv.find(',', begin);
        const std::string id = csv.substr(begin,
            end == std::string::npos ? std::string::npos : end - begin);
        if (id != "fanart" && id != "tmdb" && id != "tvmaze" && id != "steamgriddb") return false;
        if (!seen.insert(id).second) return false;
        if (end == std::string::npos) break;
        begin = end + 1;
    }
    return !seen.empty();
}

inline std::string cleanFanartClientKey(std::string value) {
    const size_t first = value.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return std::string();
    const size_t last = value.find_last_not_of(" \t\r\n");
    value = value.substr(first, last - first + 1);
    if (value.size() > 128) return std::string();
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
inline bool load(CoverEngine::Settings& s, ConfigStore& store) {
    s.showRemaining = store.readInt("showRemaining", 0) != 0;
    s.remainingSize = clampInt(store.readInt("remainingSize", 0), 0, 2);
    s.rollDigits    = store.readInt("roll", 0) != 0;
    s.transition    = clampInt(store.readInt("transition", 1), 0, 3);
    s.fadeMs        = clampInt(store.readInt("fadeMs", 1000), 500, 2000);
    s.layout        = clampInt(store.readInt("layout", 0), 0, 1);
    s.posterBlur    = clampInt(store.readInt("posterBlur", 24), 0, 200);
    // Per mille of the cover's side, so 500 (half) is already a circle - clamping there
    // keeps a typo like 4500 from being silently treated as something meaningful.
    s.borderRadius  = clampInt(store.readInt("borderRadius", 45), 0, 500);
    s.backdrops     = store.readInt("backdrops", 0) != 0;
    s.titleLogos    = store.readInt("titleLogos", 0) != 0;
    s.ratings       = store.readInt("ratings", 0) != 0;
    s.hideCoverWithBackdrop = store.readInt("hideCoverWithBackdrop", 1) != 0;
    s.ratingDE      = store.readInt("ratingDE", 1) != 0;
    s.ratingUS      = store.readInt("ratingUS", 1) != 0;
    if (!s.ratingDE && !s.ratingUS) s.ratingDE = true;
    const std::string providers = store.readStr("mediaProviders", "fanart,tmdb,tvmaze,steamgriddb");
    // Resolver validation remains the final boundary. This cheap persistence guard
    // prevents arbitrary/empty values from disabling every provider after an INI edit.
    s.mediaProviders = validProviderList(providers)
        ? providers : "fanart,tmdb,tvmaze,steamgriddb";
    s.fanartClientKey = cleanFanartClientKey(store.readStr("fanartClientKey", ""));
    s.fanartClientKeyVerifiedAt = s.fanartClientKey.empty() ? 0
        : cleanVerificationTime(store.readStr("fanartClientKeyVerifiedAt", "0"));
    const std::string stationId = store.readStr("station", "");
    s.station = ssc::validStationIndex(ssc::stationIndexForId(stationId.c_str()));
    return !stationId.empty();
}

inline void save(const CoverEngine::Settings& s, ConfigStore& store) {
    store.writeInt("showRemaining", s.showRemaining ? 1 : 0);
    store.writeInt("remainingSize", s.remainingSize);
    store.writeInt("roll",          s.rollDigits ? 1 : 0);
    store.writeInt("transition",    s.transition);
    store.writeInt("fadeMs",        s.fadeMs);
    store.writeInt("layout",        s.layout);
    store.writeInt("posterBlur",    s.posterBlur);
    store.writeInt("borderRadius",  s.borderRadius);
    store.writeInt("backdrops",     s.backdrops ? 1 : 0);
    store.writeInt("titleLogos",    s.titleLogos ? 1 : 0);
    store.writeInt("ratings",       s.ratings ? 1 : 0);
    store.writeInt("hideCoverWithBackdrop", s.hideCoverWithBackdrop ? 1 : 0);
    store.writeInt("ratingDE",      s.ratingDE ? 1 : 0);
    store.writeInt("ratingUS",      s.ratingUS ? 1 : 0);
    store.writeStr("mediaProviders", s.mediaProviders.c_str());
    const std::string fanartKey = cleanFanartClientKey(s.fanartClientKey);
    store.writeStr("fanartClientKey", fanartKey.c_str());
    char verifiedAt[32] = {0};
    std::snprintf(verifiedAt, sizeof(verifiedAt), "%llu",
        fanartKey.empty() ? 0ULL : s.fanartClientKeyVerifiedAt);
    store.writeStr("fanartClientKeyVerifiedAt", verifiedAt);
    store.writeStr("station",       ssc::station(s.station).id);
}

// INI-file adapter used by the Winamp plugin and the desktop viewer: everything in
// the [options] section of the given .ini path.
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

} // namespace ssccfg

#endif // SSC_CONFIG_H
