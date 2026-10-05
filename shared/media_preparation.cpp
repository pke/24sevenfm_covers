#include "media_preparation.h"
#include "../lib/image_probe.h"
#include <algorithm>

namespace ssc {
namespace { bool cancelled(const std::atomic<bool>* token) { return token && token->load(); } }
MediaRequest mediaOptions(const MediaPreferences& preferences, int width, int height) {
    MediaRequest request;
    request.providers = preferences.providers; request.fanartClientKey = preferences.fanartKey;
    request.includeArt = preferences.station == 0 && preferences.backdrops;
    request.includeTitleLogo = request.includeArt && preferences.logos;
    request.includeRatings = preferences.station == 0 && preferences.ratings && !preferences.ratingCountries.empty();
    request.ratingCountries = preferences.ratingCountries;
    request.width = std::max(0, std::min(8192, width));
    request.height = std::max(0, std::min(8192, height));
    return request;
}
MediaRequest requestForTrack(const TrackInfo& track, MediaRequest request) {
    request.album = track.album; request.artist = track.artist; request.track = track.track;
    return request;
}
std::string trackIdentity(const TrackInfo& track, int station) {
    return std::to_string(station) + "\n" + track.album + "\n" + track.artist + "\n" + track.track;
}
std::string queuedTrackIdentity(const TrackInfo& track) {
    // Credits may arrive after GetQueue; enrichment must not replace the row.
    return track.album + "\n" + track.track + "\n" + track.coverUrl + "\n" + track.albumUrl;
}
MediaText presentationText(const TrackInfo& track, const MediaResult& result, int station) {
    MediaText text;
    text.authoritative = result.hasMetadata;
    text.album = result.hasMetadata ? result.album : stationIdentAlbumLabel(track.album, station);
    text.artist = result.hasMetadata ? result.artist : track.artist;
    text.track = result.hasMetadata ? result.track : track.track;
    return text;
}
std::string effectiveFanartKey(const MediaRequest& request) {
    return request.includeArt && ("," + request.providers + ",").find(",fanart,") != std::string::npos
        ? request.fanartClientKey : std::string();
}
bool sameBackdropConfig(const MediaRequest& a, const MediaRequest& b) {
    return a.providers == b.providers && a.ratingCountries == b.ratingCountries
        && effectiveFanartKey(a) == effectiveFanartKey(b)
        && a.includeArt == b.includeArt && a.includeRatings == b.includeRatings
        && wantsPortraitArtwork(a) == wantsPortraitArtwork(b) && wants4kArtwork(a) == wants4kArtwork(b);
}
bool sameResolverConfig(const MediaRequest& a, const MediaRequest& b) {
    return sameBackdropConfig(a, b) && a.includeTitleLogo == b.includeTitleLogo;
}
MediaPreparation::MediaPreparation(MediaResolver resolver, Transport transport)
    : resolver_(std::move(resolver)), transport_(std::move(transport)) {}
TrackInfo MediaPreparation::enrichCredit(TrackInfo track, const std::string& host,
    const std::atomic<bool>* cancel) const {
    if (cancelled(cancel) || track.stationIdent || !track.artist.empty() || track.albumUrl.empty()) return track;
    bool ok = false;
    const auto credit = resolver_.resolveCredit(track.album, track.albumUrl, host, &ok, cancel);
    if (!cancelled(cancel) && ok && !credit.empty()) track.artist = credit;
    return track;
}
std::string MediaPreparation::cover(const std::string& requested, int stationIndex, int timeout,
    const std::atomic<bool>* cancel) const {
    if (cancelled(cancel)) return {};
    const auto& info = station(stationIndex);
    const std::string url = requested.empty() ? info.logoUrl : requested;
    const auto scheme = url.find("://");
    if (scheme == std::string::npos || (url.substr(0, scheme) != "http" && url.substr(0, scheme) != "https")) return {};
    const auto pathAt = url.find('/', scheme + 3);
    if (pathAt == std::string::npos || url.substr(scheme + 3, pathAt - scheme - 3) != info.host) return {};
    const auto response = transport_ ? transport_(info.host, 443, url.substr(pathAt), timeout, cancel)
        : httpRequest(info.host, 443, url.substr(pathAt), "GET", "", "", timeout, cancel);
    return !cancelled(cancel) && response.ok() && decodableImage(response.body, url) ? response.body : std::string();
}
std::string MediaPreparation::backdrop(const MediaResult& media, const std::atomic<bool>* cancel) const {
    std::string bytes;
    if (cancelled(cancel) || !resolver_.downloadBackdrop(media, bytes, cancel)
        || cancelled(cancel) || !decodableImage(bytes, media.backdropUrl)) return {};
    return bytes;
}
std::string MediaPreparation::logo(const MediaResult& media, const std::atomic<bool>* cancel) const {
    std::string bytes;
    if (cancelled(cancel) || !resolver_.downloadTitleLogo(media, bytes, cancel)
        || cancelled(cancel) || !decodableImage(bytes, media.titleLogoUrl)) return {};
    return bytes;
}
std::vector<PreparedRating> MediaPreparation::ratings(const MediaResult& media, const MediaRequest& request,
    const std::atomic<bool>* cancel) const {
    std::vector<PreparedRating> assets;
    if (!request.includeRatings) return assets;
    for (const auto& cert : media.certifications) {
        if (cancelled(cancel)) return {};
        if (("," + request.ratingCountries + ",").find("," + cert.country + ",") == std::string::npos) continue;
        std::string bytes;
        if (resolver_.downloadRatingAsset(cert, bytes, cancel) && !cancelled(cancel) && decodableImage(bytes)) {
            PreparedRating asset; asset.country = cert.country; asset.bytes = std::move(bytes); asset.certification = cert;
            assets.push_back(std::move(asset));
        }
    }
    return assets;
}
std::vector<TrackInfo> stationQueue(int stationIndex, const std::atomic<bool>* cancel) {
    if (cancelled(cancel)) return {};
    Config config; config.host = station(stationIndex).host;
    config.transport = [cancel](const std::string& host, unsigned short port, const std::string& path,
        const std::string& method, const std::string& body, const std::string& type, int timeout) {
        return httpRequest(host, port, path, method, body, type, timeout, cancel);
    };
    CoverMonitor probe([](const std::string&, const TrackInfo&) {}, config);
    std::vector<TrackInfo> queue; probe.queue(queue);
    return cancelled(cancel) ? std::vector<TrackInfo>() : queue;
}
} // namespace ssc
