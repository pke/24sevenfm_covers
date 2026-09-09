// media_resolver.h - native client for the shared /api/media and /api/credit
// contracts. Matching/provider credentials stay server-side; this client owns
// strict result validation and direct trusted-CDN image downloads.
#pragma once

#include <atomic>
#include <functional>
#include <string>
#include <vector>

#include "http_client.h"

namespace ssc {

struct Certification {
    std::string country;     // DE | US
    std::string system;      // FSK | MPA | TV Parental Guidelines
    std::string rating;
    std::string label;
    std::vector<std::string> descriptors;
};

struct MediaRequest {
    std::string album;
    std::string track;
    std::string artist;
    std::string providers = "fanart,tmdb,tvmaze,steamgriddb";
    std::string fanartClientKey;
    std::string ratingCountries = "DE,US";
    bool includeArt = true;
    bool includeRatings = true;
    bool portrait = false;
};

enum class FanartKeyCheckStatus { Accepted, Rejected, Invalid, Failure };

struct FanartKeyCheckResult {
    FanartKeyCheckStatus status = FanartKeyCheckStatus::Failure;
    std::string error;
};

struct MediaResult {
    enum Status { Hit, Miss, Failure } status = Failure;
    std::string mediaTitle;
    std::string mediaType;
    std::string backdropUrl;
    std::string source;
    std::string album;
    std::string track;
    std::string artist;
    int tint[3] = {255, 255, 255};
    bool hasTint = false;
    std::vector<Certification> certifications;
    std::string error;

    bool hasBackdrop() const { return status == Hit && !backdropUrl.empty(); }
};

struct MediaResolverConfig {
    std::string apiHost = "24covers-api.vercel.app";
    // First 12 SHA-256 hex chars of api/_lib/backdrop.js, matching the web
    // renderer's RESOLVER_V cache buster at the time this native build ships.
    std::string resolverVersion = "ee4c3ebe5a7e";
    unsigned short apiPort = 443;
    int timeoutSeconds = 20;
    using Transport = std::function<HttpResponse(
        const std::string&, unsigned short, const std::string&,
        const std::string&, const std::string&, const std::string&, int)>;
    Transport transport; // empty -> real WinHTTP transport
};

class MediaResolver {
public:
    explicit MediaResolver(MediaResolverConfig config = MediaResolverConfig());

    MediaResult resolve(const MediaRequest& request,
                        const std::atomic<bool>* cancel = nullptr) const;

    // Checks the listener-owned fanart.tv client_key against the same stable movie
    // used by the web player. This deliberately talks straight to fanart.tv once;
    // normal artwork requests continue to go through the project resolver.
    FanartKeyCheckResult checkFanartClientKey(
        const std::string& clientKey,
        const std::atomic<bool>* cancel = nullptr) const;

    // Best-effort queue-credit enrichment. Failure and an empty successful result
    // both return an empty string; callers keep those cache/retry states separate.
    std::string resolveCredit(const std::string& album, const std::string& albumUrl,
                              const std::string& stationHost, bool* requestSucceeded,
                              const std::atomic<bool>* cancel = nullptr) const;

    // Downloads only a URL accepted by the same source/host policy as resolve().
    bool downloadBackdrop(const MediaResult& media, std::string& bytes,
                          const std::atomic<bool>* cancel = nullptr) const;

private:
    HttpResponse get(const std::string& host, unsigned short port, const std::string& path,
                     const std::atomic<bool>* cancel) const;
    MediaResolverConfig config_;
};

std::string urlEncode(const std::string& utf8);
bool trustedBackdropUrl(const std::string& url, const std::string& source,
                        std::string* host = nullptr, std::string* path = nullptr);
bool trustedAlbumPageUrl(const std::string& url, const std::string& stationHost);

} // namespace ssc
