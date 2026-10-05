#include "../../shared/settings_schema_json.h"
#include <cstdio>
#include <cstring>

int main(int argc, char** argv) {
    ssccfg::Profile profile = ssccfg::Profile::Windows;
    if (argc > 2) { std::fputs("Usage: settings_schema_export [windows|macos|linux]\n", stderr); return 2; }
    if (argc == 2) {
        if (!std::strcmp(argv[1], "macos")) profile = ssccfg::Profile::MacOS;
        else if (!std::strcmp(argv[1], "linux")) profile = ssccfg::Profile::Linux;
        else if (std::strcmp(argv[1], "windows")) { std::fputs("Unknown settings profile\n", stderr); return 2; }
    }
    const std::string json = ssccfg::settingsSchemaJson(profile);
    return std::fwrite(json.data(), 1, json.size(), stdout) == json.size() ? 0 : 1;
}
