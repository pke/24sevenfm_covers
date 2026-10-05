// Native-independent input and asset preparation. No window or GPU types.
#pragma once
#include "../lib/media_policy.h"
#include "stations.h"

namespace ssc {
struct MediaPreferences {
    int station = 0;
    bool backdrops = false, logos = false, ratings = false;
    std::string providers = "fanart,tmdb,tvmaze,steamgriddb", fanartKey;
    std::string ratingCountries = "DE,US";
};
MediaRequest mediaOptions(const MediaPreferences&, int width = 0, int height = 0);
MediaRequest requestForTrack(const TrackInfo&, MediaRequest);
std::string trackIdentity(const TrackInfo&, int station);
std::string queuedTrackIdentity(const TrackInfo&);
struct MediaText {
    std::string album, artist, track;
    bool authoritative = false;
};
MediaText presentationText(const TrackInfo&, const MediaResult&, int station);
std::string effectiveFanartKey(const MediaRequest&);
bool sameBackdropConfig(const MediaRequest&, const MediaRequest&);
bool sameResolverConfig(const MediaRequest&, const MediaRequest&);

// Certification metadata stays available even while its image is loading.
struct PreparedRating {
    std::string country, bytes;
    Certification certification;
};

class MediaPreparation {
public:
    using Transport = std::function<HttpResponse(const std::string&, unsigned short,
        const std::string&, int, const std::atomic<bool>*)>;
    explicit MediaPreparation(MediaResolver resolver = MediaResolver(), Transport transport = {});
    TrackInfo enrichCredit(TrackInfo, const std::string& stationHost,
        const std::atomic<bool>* cancel = nullptr) const;
    std::string cover(const std::string& url, int station, int timeoutSeconds,
        const std::atomic<bool>* cancel = nullptr) const;
    std::string backdrop(const MediaResult&, const std::atomic<bool>* cancel = nullptr) const;
    std::string logo(const MediaResult&, const std::atomic<bool>* cancel = nullptr) const;
    std::vector<PreparedRating> ratings(const MediaResult&, const MediaRequest&,
        const std::atomic<bool>* cancel = nullptr) const;
private:
    MediaResolver resolver_;
    Transport transport_;
};
// Feed transport adapter, including cancellation, shared by native sessions.
std::vector<TrackInfo> stationQueue(int station, const std::atomic<bool>* cancel);
} // namespace ssc
