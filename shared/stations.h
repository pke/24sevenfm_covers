// stations.h - the 24seven.FM family of stations. Every station runs the SAME
// now-playing JSON endpoint (/soap/FM24sevenJSON.php?action=GetCurrentlyPlaying)
// and serves its covers on its own host (https://<host>/images/cover/<ASIN>.jpg),
// so switching stations is just pointing ssc::Config::host at the chosen host.
//
// Header-only (everything inline) so the engine, both plugins, and the viewer can
// share this list without adding a separate .cpp to each of the three build systems.
#ifndef SSC_STATIONS_H
#define SSC_STATIONS_H

#include <cctype>
#include <cstddef>
#include <cstring>
#include <string>

namespace ssc {

struct StationInfo {
    const char* id;          // stable key for persistence (never shown to the user)
    const char* displayName; // label in the viewer's station picker
    const char* host;        // JSON + cover host, e.g. "death.fm"
    const char* logoUrl;     // trusted ident fallback when current-playing has no cover
    const char* desc;        // one-line genre blurb (viewer picker)
};

// Index 0 is the default (Streaming Soundtracks, the original station).
static const StationInfo kStations[] = {
    { "sst",       "StreamingSoundtracks", "streamingsoundtracks.com", "https://streamingsoundtracks.com/images/logos/logo-sst-v200x200.png", "Movie scores, TV themes, anime & game music" },
    { "1980s",     "1980s.FM",             "1980s.fm",                 "https://1980s.fm/images/logos/1980s_logo-200x200.png",                  "1980s pop, rock & new wave"                  },
    { "adagio",    "Adagio.FM",            "adagio.fm",                "https://adagio.fm/images/logos/logo-afm-200x200.png",                  "Classical & ambient"                         },
    { "death",     "Death.FM",             "death.fm",                 "https://death.fm/images/logos/logo-dfm-200x200.png",                   "Extreme & underground metal"                 },
    { "entranced", "Entranced.FM",         "entranced.fm",             "https://entranced.fm/images/logos/logo-efm-g200x200.png",              "Trance, ambient & electronic"                },
};
static const int kStationCount = (int)(sizeof(kStations) / sizeof(kStations[0]));

// Clamp an index to a real station; out-of-range -> 0 (SST).
inline int validStationIndex(int i) {
    return (i >= 0 && i < kStationCount) ? i : 0;
}

// Safe accessor: always returns a valid station.
inline const StationInfo& station(int i) { return kStations[validStationIndex(i)]; }

// Presentation-only label for a confirmed station ident. Keep feed metadata raw
// and preserve genuine album names on unregistered tracks that also lack a cover.
inline std::string stationIdentAlbumLabel(const std::string& album, int stationIndex) {
    const size_t first = album.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return album;
    std::string marker = album.substr(first, album.find_last_not_of(" \t\r\n") - first + 1);
    for (char& c : marker) c = (char)std::tolower((unsigned char)c);
    return marker == "stationid" || marker == "station id"
        ? station(stationIndex).displayName : album;
}

// Case-insensitive substring test.
inline bool ci_contains(const std::string& hay, const char* needle) {
    if (!needle || !*needle) return false;
    std::string h(hay), n(needle);
    for (char& c : h) c = (char)std::tolower((unsigned char)c);
    for (char& c : n) c = (char)std::tolower((unsigned char)c);
    return h.find(n) != std::string::npos;
}

// Identify the station a stream URL or ICY title belongs to, by its host - e.g.
// "http://hi5.death.fm/" -> Death.FM. Returns -1 if it is not a family stream.
// No station host is a substring of another, so the first match is unambiguous.
inline int stationIndexForText(const char* text) {
    if (!text || !*text) return -1;
    const std::string s(text);
    for (int i = 0; i < kStationCount; ++i)
        if (ci_contains(s, kStations[i].host)) return i;
    // SST's host is "streamingsoundtracks.com", but a bare title/URL may say just
    // "streamingsoundtracks" (no TLD) - still SST.
    if (ci_contains(s, "streamingsoundtracks")) return 0;
    return -1;
}

// Lookup by persisted id; -1 if unknown.
inline int stationIndexForId(const char* id) {
    if (!id) return -1;
    for (int i = 0; i < kStationCount; ++i)
        if (std::strcmp(id, kStations[i].id) == 0) return i;
    return -1;
}

} // namespace ssc

#endif // SSC_STATIONS_H
