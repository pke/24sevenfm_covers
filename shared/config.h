// config.h - one place that owns the option schema: the keys, defaults, valid
// ranges (clamping) and the load/save order for CoverEngine::Settings. WHERE the
// values live is hidden behind the ConfigStore adapter - an INI file for the Winamp
// plugin and the desktop viewer, GUID-keyed cfg_vars for foobar2000 - so that INI vs
// GUID is an implementation detail, not something each host re-implements.
#ifndef SSC_CONFIG_H
#define SSC_CONFIG_H

#include <string>
#include <utility>

#include "cover_engine.h" // CoverEngine::Settings (pulls <windows.h>)
#include "stations.h"     // station id <-> index

namespace ssccfg {

// Storage adapter: read/write a named value. The shared load()/save() below own the
// keys, defaults and clamping; an implementation only has to persist a key/value pair
// however it likes (INI entry, cfg_var, registry, ...).
struct ConfigStore {
    virtual ~ConfigStore() {}
    virtual int         readInt (const char* key, int def) = 0;
    virtual void        writeInt(const char* key, int value) = 0;
    virtual std::string readStr (const char* key, const char* def) = 0;
    virtual void        writeStr(const char* key, const char* value) = 0;
};

inline int clampInt(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

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
        char buf[128] = {0};
        GetPrivateProfileStringA("options", key, def, buf, (DWORD)sizeof(buf), path.c_str());
        return buf;
    }
    void writeStr(const char* key, const char* value) override {
        WritePrivateProfileStringA("options", key, value, path.c_str());
    }
};

} // namespace ssccfg

#endif // SSC_CONFIG_H
