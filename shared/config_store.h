// config_store.h - the storage adapter, split out from config.h so units that only need
// "somewhere to put a key/value pair" don't have to drag in the whole option schema (and
// through it cover_engine.h -> windows.h -> Direct2D). That keeps window_rect.h, and its
// unit tests, free of Win32.
#ifndef SSC_CONFIG_STORE_H
#define SSC_CONFIG_STORE_H

#include <string>

namespace ssccfg {

// Read/write a named value. The schema in config.h owns the keys, defaults and clamping;
// an implementation only has to persist a key/value pair however it likes (INI entry,
// cfg_var, registry, an in-memory map in a test, ...).
struct ConfigStore {
    virtual ~ConfigStore() {}
    virtual int         readInt (const char* key, int def) = 0;
    virtual void        writeInt(const char* key, int value) = 0;
    virtual std::string readStr (const char* key, const char* def) = 0;
    virtual void        writeStr(const char* key, const char* value) = 0;
};

inline int clampInt(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

} // namespace ssccfg

#endif // SSC_CONFIG_STORE_H
