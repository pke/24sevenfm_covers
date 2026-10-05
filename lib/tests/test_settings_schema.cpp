#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include "../../shared/config.h"
#include "../../shared/settings_schema_json.h"
#include "../mini_json.h"
#include <map>
#include <set>

namespace {
struct Store : ssccfg::ConfigStore {
    std::map<std::string, int> ints;
    std::map<std::string, std::string> strings;
    int readInt(const char* k, int d) override { return ints.count(k) ? ints.at(k) : d; }
    std::string readStr(const char* k, const char* d) override { return strings.count(k) ? strings.at(k) : d; }
    void writeInt(const char* k, int v) override { ints[k] = v; }
    void writeStr(const char* k, const char* v) override { strings[k] = v; }
};
const ssccfg::SettingDescriptor& setting(const char* key, ssccfg::Profile p = ssccfg::Profile::Windows) {
    const auto* value = ssccfg::findSetting(key, p);
    REQUIRE(value); return *value;
}
}

TEST_CASE("every persisted engine option is described with its actual default") {
    Store saved, empty;
    ssccfg::EngineSettings defaults, loaded;
    ssccfg::save(defaults, saved);
    CHECK_FALSE(ssccfg::load(loaded, empty));
    Store loadedSaved; ssccfg::save(loaded, loadedSaved);
    CHECK(saved.ints == loadedSaved.ints); CHECK(saved.strings == loadedSaved.strings);
    size_t count = 0;
    for (const auto& d : ssccfg::settingsSchema()) {
        if (d.hostOwned) continue;
        ++count;
        if (d.stringValue) { REQUIRE(saved.strings.count(d.storageKey)); CHECK(saved.strings.at(d.storageKey) == d.defaultText); }
        else { REQUIRE(saved.ints.count(d.storageKey)); CHECK(saved.ints.at(d.storageKey) == d.defaultInt); }
    }
    CHECK(count == saved.ints.size() + saved.strings.size());
    CHECK(count == 19);
}

TEST_CASE("schema covers the native UI inventory with resolvable dependency keys") {
    const std::set<std::string> ui = {"station", "layout", "showRemaining", "remainingSize", "rollDigits", "comingNext", "transition", "fadeMs", "backdrops", "titleLogos", "hideCoverWithBackdrop", "ratings", "ratingDE", "ratingUS", "mediaProviders", "fanartClientKey", "alwaysOnTop", "reducedMotion"};
    for (auto p : {ssccfg::Profile::Windows, ssccfg::Profile::MacOS, ssccfg::Profile::Linux}) {
        std::set<std::string> keys, storage, actual;
        for (const auto& d : ssccfg::settingsSchema(p)) {
            CHECK(keys.insert(d.key).second); CHECK(storage.insert(d.storageKey).second);
            if (d.ui) actual.insert(d.key);
            for (const auto& dependencies : {d.enabledWhen, d.appliesWhen})
                for (const auto& rule : dependencies) CHECK(ssccfg::findSetting(rule.key, p));
        }
        auto expected=ui;
        if(p==ssccfg::Profile::Linux)expected.insert("renderer");
        CHECK(actual == expected);
    }
    CHECK(ssccfg::findSetting("not-an-option") == nullptr);
}

TEST_CASE("profile aliases retain native storage and defaults match Windows") {
    using P = ssccfg::Profile;
    for (auto profile : {P::MacOS, P::Linux})
        for (const auto& reference : ssccfg::settingsSchema(P::Windows)) {
            const auto& actual = setting(reference.key.c_str(), profile);
            CHECK(actual.defaultInt == reference.defaultInt);
            CHECK(actual.defaultText == reference.defaultText);
            CHECK(actual.stringValue == reference.stringValue);
        }
    CHECK(setting("layout").defaultInt == 0);
    CHECK(setting("layout", P::MacOS).defaultInt == 0);
    CHECK(setting("layout", P::MacOS).storageKey == "poster");
    CHECK(setting("showRemaining", P::MacOS).storageKey == "countdown");
    CHECK(setting("showRemaining", P::MacOS).defaultInt == 0);
    CHECK(setting("rollDigits").storageKey == "roll");
    CHECK(setting("rollDigits", P::MacOS).storageKey == "rollDigits");
    CHECK(setting("mediaProviders", P::MacOS).storageKey == "providers");
    CHECK(setting("fanartClientKeyVerifiedAt", P::MacOS).storageKey == "fanartKeyVerifiedAt");
    CHECK(setting("fadeMs").step == 100); CHECK(setting("fadeMs", P::MacOS).step == 250);
    CHECK_FALSE(setting("alwaysOnTop").supported);
    CHECK(setting("alwaysOnTop", P::MacOS).hostOwned);
    CHECK(setting("remainingSize", P::Linux).defaultInt == 0);
    CHECK(setting("rollDigits", P::Linux).storageKey == "rolling");
    CHECK(setting("comingNext", P::Linux).defaultInt == 0);
    CHECK_FALSE(setting("fadeMs", P::Linux).supported);
    CHECK(setting("reducedMotion", P::Linux).supported);
    CHECK(ssccfg::findSetting("renderer", P::Windows)==nullptr);
    CHECK(ssccfg::findSetting("renderer", P::MacOS)==nullptr);
    CHECK(setting("renderer", P::Linux).defaultText=="raster");
    CHECK(setting("renderer", P::Linux).hostOwned);
}

TEST_CASE("numeric metadata governs persistence limits without snapping stored durations") {
    for (const auto& d : ssccfg::settingsSchema()) {
        if (d.type != ssccfg::SettingType::Integer && !(d.type == ssccfg::SettingType::Choice && !d.stringValue)) continue;
        for (int invalid : {-99999, 99999}) {
            Store store; store.ints[d.storageKey] = invalid;
            ssccfg::EngineSettings loaded; ssccfg::load(loaded, store);
            Store saved; ssccfg::save(loaded, saved);
            CHECK(saved.ints.at(d.storageKey) == (invalid < 0 ? d.minimum : d.maximum));
        }
    }
    Store store; store.ints["fadeMs"] = 1234;
    ssccfg::EngineSettings loaded; ssccfg::load(loaded, store); CHECK(loaded.fadeMs == 1234);
    CHECK(ssccfg::snapDuration(1234) == 1200);
    CHECK(ssccfg::snapDuration(1234, ssccfg::Profile::MacOS) == 1250);
}

TEST_CASE("legacy persistence keeps station fallback providers and secret normalization") {
    Store store; store.strings["station"] = "death";
    store.strings["mediaProviders"] = "tmdb,fanart";
    store.strings["fanartClientKey"] = "  listener-key\r\n";
    store.strings["fanartClientKeyVerifiedAt"] = "1709251200000";
    store.ints["ratingDE"] = store.ints["ratingUS"] = 0;
    ssccfg::EngineSettings loaded; REQUIRE(ssccfg::load(loaded, store));
    CHECK(loaded.station == 3); CHECK(loaded.ratingDE); CHECK_FALSE(loaded.ratingUS);
    CHECK(loaded.mediaProviders == "tmdb,fanart"); CHECK(loaded.fanartClientKey == "listener-key");
    CHECK(loaded.fanartClientKeyVerifiedAt == 1709251200000ULL);
    store.strings["station"] = "unknown"; store.strings["mediaProviders"] = "tmdb,tmdb";
    store.strings["fanartClientKey"] = std::string(129, 'x');
    ssccfg::load(loaded, store);
    CHECK(loaded.station == 0); CHECK(loaded.mediaProviders == ssccfg::defaultProviders);
    CHECK(loaded.fanartClientKey.empty()); CHECK(loaded.fanartClientKeyVerifiedAt == 0);
}

TEST_CASE("static JSON export is deterministic parseable and contains no runtime settings") {
    for (auto p : {ssccfg::Profile::Windows, ssccfg::Profile::MacOS, ssccfg::Profile::Linux}) {
        const auto json = ssccfg::settingsSchemaJson(p);
        CHECK(json == ssccfg::settingsSchemaJson(p));
        ssc::JsonValue value; std::string error; REQUIRE(ssc::parseJson(json, value, &error));
        REQUIRE(value.get("schemaVersion")); CHECK(value.get("schemaVersion")->number == 1);
        REQUIRE(value.get("settings")); CHECK(value.get("settings")->array.size() == (p==ssccfg::Profile::Linux?22:21));
        for (const auto& d : value.get("settings")->array) {
            REQUIRE(d.get("key")); REQUIRE(d.get("default"));
            if (d.get("key")->string == "fanartClientKey") {
                CHECK(d.get("default")->string.empty()); CHECK(d.get("sensitive")->boolean);
            }
        }
    }
    ssc::JsonValue escaped;
    REQUIRE(ssc::parseJson(ssccfg::schema_detail::quote("a\n\"b\\c\t"), escaped));
    CHECK(escaped.string == "a\n\"b\\c\t");
}
