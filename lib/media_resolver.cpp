#include "platform_text.h"
#include "media_resolver.h"

#include "json_view.h"
#include "debug_features.h"
#if SSC_ENABLE_DEBUG_OVERLAY
#include "diagnostics.h"
#endif
#include "rating_asset_paths.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <utility>

namespace ssc {
namespace {

std::string lower(std::string value) {
    for (char& c : value) c = static_cast<char>(
        std::tolower(static_cast<unsigned char>(c)));
    return value;
}

// API/JS limits count UTF-16 code units, not UTF-8 bytes. Validate the encoding
// while counting so malformed/overlong UTF-8 cannot sneak through native inputs.
bool cleanRequestText(const std::string& value, size_t maxLength, bool required) {
    if (required && value.empty()) return false;
    size_t units = 0;
    for (size_t i = 0; i < value.size();) {
        unsigned cp = static_cast<unsigned char>(value[i++]);
        unsigned trailing = 0, minimum = 0;
        if (cp < 0x80) {
            if (cp < 0x20 || cp == 0x7F) return false;
        } else if (cp >= 0xC2 && cp <= 0xDF) { cp &= 0x1F; trailing = 1; minimum = 0x80; }
        else if (cp >= 0xE0 && cp <= 0xEF) { cp &= 0x0F; trailing = 2; minimum = 0x800; }
        else if (cp >= 0xF0 && cp <= 0xF4) { cp &= 7; trailing = 3; minimum = 0x10000; }
        else return false;
        if (value.size() - i < trailing) return false;
        for (unsigned j = 0; j < trailing; ++j) {
            const unsigned next = static_cast<unsigned char>(value[i++]);
            if ((next & 0xC0) != 0x80) return false;
            cp = (cp << 6) | (next & 0x3F);
        }
        if (cp < minimum || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return false;
        units += cp > 0xFFFF ? 2 : 1;
        if (units > maxLength) return false;
    }
    return true;
}

bool cleanOptionalText(JsonView value, std::string& out, size_t maxLength) {
    std::string text;
    if (!value.text(text, maxLength * 4) || !cleanRequestText(text, maxLength, false)) return false;
    out = std::move(text); return true;
}
bool cleanText(JsonView value, std::string& out, size_t maxLength) {
    std::string text;
    if (!cleanOptionalText(value, text, maxLength) || text.empty()) return false;
    out = std::move(text); return true;
}

bool splitHttps(const std::string& url, std::string& host, std::string& path) {
    host.clear(); path.clear();
    if (url.compare(0, 8, "https://") != 0) return false;
    for (unsigned char c : url) if (c < 0x20 || c == 0x7F) return false;
    const size_t authority = 8;
    const size_t end = ssc::platform::firstOf(url, "/?#", authority);
    std::string authorityText = url.substr(authority,
        end == std::string::npos ? std::string::npos : end - authority);
    if (authorityText.empty() || authorityText.find('@') != std::string::npos) return false;
    const size_t colon = authorityText.rfind(':');
    if (colon != std::string::npos) {
        if (authorityText.substr(colon + 1) != "443") return false;
        authorityText.resize(colon);
    }
    if (authorityText.empty() || authorityText.find(':') != std::string::npos) return false;
    if (end != std::string::npos && url[end] == '#') return false;
    if (url.find('#', end == std::string::npos ? url.size() : end) != std::string::npos) return false;
    host = lower(authorityText);
    path = end == std::string::npos ? "/" : url.substr(end);
    if (!path.empty() && path[0] == '?') path.insert(path.begin(), '/');
    return !path.empty() && path[0] == '/';
}

bool knownProviderList(const std::string& csv) {
    if (csv.empty() || csv.size() > 128) return false;
    unsigned seen = 0;
    size_t begin = 0;
    while (begin <= csv.size()) {
        const size_t end = csv.find(',', begin);
        const std::string id = csv.substr(begin,
            end == std::string::npos ? std::string::npos : end - begin);
        const unsigned bit = id == "fanart" ? 1 : id == "tmdb" ? 2
            : id == "tvmaze" ? 4 : id == "steamgriddb" ? 8 : 0;
        if (!bit || (seen & bit)) return false;
        seen |= bit;
        if (end == std::string::npos) break;
        begin = end + 1;
    }
    return seen != 0;
}

bool hasProvider(const std::string& csv, const char* wanted) {
    size_t begin = 0;
    while (begin <= csv.size()) {
        const size_t end = csv.find(',', begin);
        if (csv.substr(begin, end == std::string::npos
                ? std::string::npos : end - begin) == wanted) return true;
        if (end == std::string::npos) break;
        begin = end + 1;
    }
    return false;
}

bool knownCountries(const std::string& csv) {
    return csv == "DE" || csv == "US" || csv == "DE,US" || csv == "US,DE";
}

bool knownCertification(const std::string& country, const std::string& system,
                        const std::string& rating) {
    if (country == "DE" && system == "FSK")
        return rating == "0" || rating == "6" || rating == "12"
            || rating == "16" || rating == "18";
    if (country != "US") return false;
    if (system == "MPA")
        return rating == "G" || rating == "PG" || rating == "PG-13"
            || rating == "R" || rating == "NC-17";
    if (system == "TV Parental Guidelines")
        return rating == "TV-Y" || rating == "TV-Y7" || rating == "TV-Y7-FV"
            || rating == "TV-G" || rating == "TV-PG" || rating == "TV-14"
            || rating == "TV-MA";
    return false;
}

std::vector<std::string> cleanDescriptors(JsonView value, const std::string& rating) {
    const char* codes[] = {"FV", "D", "L", "S", "V"};
    unsigned allowed = rating == "TV-Y7" || rating == "TV-Y7-FV" ? 1
        : rating == "TV-PG" || rating == "TV-14" ? 30 : rating == "TV-MA" ? 28 : 0;
    unsigned supplied = rating == "TV-Y7-FV" ? 1 : 0;
    JsonItems items(value.type == JsonView::Array ? value : JsonView()); JsonView item;
    while (items.next(item)) {
        std::string code;
        if (!item.text(code, 2)) continue;
        for (char& c : code) if (c >= 'a' && c <= 'z') c -= 'a' - 'A';
        for (unsigned i = 0; i < 5; ++i) if (code == codes[i]) supplied |= 1u << i;
    }
    std::vector<std::string> out;
    for (unsigned i = 0; i < 5; ++i) if (allowed & supplied & (1u << i)) out.push_back(codes[i]);
    return out;
}

bool parseResponse(const std::string& body, MediaResult& out) {
    JsonView root;
    if (!readJsonView(body, root, &out.error) || root.type != JsonView::Object) {
        if (out.error.empty()) out.error = "invalid resolver JSON";
        return false;
    }
    const auto diagnostics = root.get("diagnostics");
    for (const char* phase : {"resolution", "logoResolution"}) {
        const auto values = diagnostics.get(phase).get("spans");
        JsonItems spans(values.type == JsonView::Array ? values : JsonView()); JsonView span;
        while (spans.next(span)) {
            std::string name; double status;
            if (span.get("name").text(name, 32) && name == "provider.fanart"
                    && span.get("status").number(status) && (status == 401 || status == 403))
                out.fanartKeyRejected = true;
        }
    }
    auto media = root.get("media");
    if (media.type == JsonView::Object) {
        cleanText(media.get("title"), out.mediaTitle, 180);
        cleanText(media.get("type"), out.mediaType, 16);
        if (out.mediaType != "movie" && out.mediaType != "tv" && out.mediaType != "game") out.mediaType.clear();
    } else if (media.exists() && media.type != JsonView::Null) {
        out.error = "invalid media result"; return false;
    }
    auto metadata = root.get("metadata");
    if (metadata.type == JsonView::Object) {
        std::string album, track, artist;
        if (!cleanText(metadata.get("album"), album, 180)
                || !cleanOptionalText(metadata.get("track"), track, 300)
                || !cleanOptionalText(metadata.get("artist"), artist, 180)) {
            out.error = "invalid normalized metadata"; return false;
        }
        out.album = std::move(album); out.track = std::move(track); out.artist = std::move(artist);
        out.hasMetadata = true;
    } else if (metadata.exists()) {
        out.error = "invalid normalized metadata"; return false;
    }
    auto backdrop = root.get("backdrop"), source = root.get("source");
    if (backdrop.exists() && backdrop.type != JsonView::Null && !backdrop.text(out.backdropUrl, 2048)) {
        out.error = "invalid backdrop result"; return false;
    }
    if (source.exists() && source.type != JsonView::Null && !source.text(out.source, 32)) {
        out.error = "invalid backdrop source"; return false;
    }
    if (!out.backdropUrl.empty() && !trustedBackdropUrl(out.backdropUrl, out.source)) {
        out.error = "untrusted backdrop URL"; return false;
    }
    if (!out.backdropUrl.empty()) {
        out.backdrops.push_back({out.backdropUrl, out.source});
        const auto values = root.get("backdrops");
        JsonItems alternatives(values.type == JsonView::Array ? values : JsonView()); JsonView candidate;
        while (out.backdrops.size() < 50 && alternatives.next(candidate)) {
            std::string url, provider;
            if (candidate.type != JsonView::Object || !cleanText(candidate.get("url"), url, 2048)
                    || !cleanText(candidate.get("source"), provider, 32) || !trustedBackdropUrl(url, provider)) continue;
            bool duplicate = false;
            for (const auto& known : out.backdrops) if (known.url == url) { duplicate = true; break; }
            if (!duplicate) out.backdrops.push_back({std::move(url), std::move(provider)});
        }
    }
    auto logo = root.get("logo"); std::string url, provider;
    if (logo.type == JsonView::Object && cleanText(logo.get("url"), url, 2048)
            && cleanText(logo.get("source"), provider, 32) && trustedBackdropUrl(url, provider)) {
        out.titleLogoUrl = std::move(url); out.titleLogoSource = std::move(provider);
    }
    auto tint = root.get("tint");
    if (tint.type == JsonView::Array) {
        JsonItems channels(tint); JsonView channel; unsigned count = 0; bool valid = true;
        while (channels.next(channel)) {
            double n;
            if (count >= 3 || !channel.number(n) || n < 0 || n > 255) valid = false;
            else out.tint[count] = static_cast<int>(std::floor(n + 0.5));
            ++count;
        }
        out.hasTint = valid && count == 3;
    }
    auto certs = root.get("certifications");
    if (certs.exists() && certs.type != JsonView::Array) {
        out.error = "invalid certifications result"; return false;
    }
    unsigned countries = 0; JsonItems certificates(certs); JsonView raw;
    while (certificates.next(raw)) {
        Certification cert;
        if (raw.type != JsonView::Object || !cleanText(raw.get("country"), cert.country, 2)
                || !cleanText(raw.get("system"), cert.system, 40)
                || !cleanText(raw.get("rating"), cert.rating, 32)
                || !cleanText(raw.get("label"), cert.label, 40)
                || !knownCertification(cert.country, cert.system, cert.rating)) continue;
        const unsigned country = cert.country == "DE" ? 1 : 2;
        if (countries & country) continue;
        countries |= country;
        if (cert.system == "TV Parental Guidelines") cert.descriptors = cleanDescriptors(raw.get("descriptors"), cert.rating);
        out.certifications.push_back(std::move(cert));
    }
    out.status = (!out.backdropUrl.empty() || !out.titleLogoUrl.empty() || !out.certifications.empty())
        ? MediaResult::Hit : MediaResult::Miss;
    return true;
}

} // namespace

std::string urlEncode(const std::string& utf8) {
    std::string out;
    static const char hex[] = "0123456789ABCDEF";
    for (unsigned char c : utf8) {
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') {
            out += static_cast<char>(c);
        } else {
            out += '%'; out += hex[c >> 4]; out += hex[c & 15];
        }
    }
    return out;
}

bool trustedBackdropUrl(const std::string& url, const std::string& source,
                        std::string* hostOut, std::string* pathOut) {
    std::string host, path;
    if (!splitHttps(url, host, path)) return false;
    const bool trusted = source == "tmdb" ? host == "image.tmdb.org"
        : source == "fanart" ? (host == "fanart.tv"
            || (host.size() > 10 && host.compare(host.size() - 10, 10, ".fanart.tv") == 0))
        : source == "tvmaze" ? host == "static.tvmaze.com"
        : source == "steamgriddb" ? host == "cdn2.steamgriddb.com" : false;
    if (!trusted) return false;
    if (hostOut) *hostOut = host;
    if (pathOut) *pathOut = path;
    return true;
}

bool trustedAlbumPageUrl(const std::string& url, const std::string& stationHost) {
    std::string host, path;
    if (!splitHttps(url, host, path) || host != lower(stationHost)) return false;
    if (path.compare(0, 13, "/modules.php?") != 0 || path.find('#') != std::string::npos) return false;
    return path.find("name=Album") != std::string::npos && path.find("asin=") != std::string::npos;
}

MediaResolver::MediaResolver(MediaResolverConfig config) : config_(std::move(config)) {}

HttpResponse MediaResolver::get(const std::string& host, unsigned short port,
                                const std::string& path,
                                const std::atomic<bool>* cancel) const {
    if (config_.transport) {
#if SSC_ENABLE_DEBUG_OVERLAY
        const auto start = std::chrono::steady_clock::now();
#endif
        auto response = config_.transport(host, port, path, "GET", "", "", config_.timeoutSeconds);
#if SSC_ENABLE_DEBUG_OVERLAY
        DiagnosticLog::instance().request("https://" + host + path, response, diagnosticMilliseconds(start));
#endif
        return response;
    }
    return httpRequest(host, port, path, "GET", "", "", config_.timeoutSeconds, cancel);
}

MediaResult MediaResolver::resolve(const MediaRequest& request,
                                   const std::atomic<bool>* cancel) const {
    MediaResult result;
    const bool useFanartClientKey = request.includeArt
        && hasProvider(request.providers, "fanart") && !request.fanartClientKey.empty();
    if (!cleanRequestText(request.album, 180, true)
            || !cleanRequestText(request.track, 300, false)
            || !cleanRequestText(request.artist, 180, false)
            || (useFanartClientKey && !cleanRequestText(request.fanartClientKey, 128, false))
            || (request.includeArt && !knownProviderList(request.providers))
            || (request.includeArt && (request.width != 0 || request.height != 0)
                && (request.width < 1 || request.height < 1 || request.width > 8192 || request.height > 8192))
            || (request.includeRatings && !knownCountries(request.ratingCountries))) {
        result.error = "invalid native media request";
        return result;
    }
    // The stream metadata is already useful display data. Keep it as a safe
    // fallback when the endpoint is unavailable or an older deployment omits
    // the normalized metadata object; a valid object below replaces it.
    result.album = request.album;
    result.track = request.track;
    result.artist = request.artist;
    std::string path = "/api/media?resolver_version=" + urlEncode(config_.resolverVersion)
        + "&album=" + urlEncode(request.album);
#if SSC_ENABLE_DEBUG_OVERLAY
    path += "&diagnostics=1";
#else
    // Provider rejection is also used by the personal-key status UI. Keep this
    // functional response information even when diagnostic capture is disabled.
    if (useFanartClientKey) path += "&diagnostics=1";
#endif
    if (request.includeArt) path += "&artwork_info=1&backdrops=1";
    if (!request.track.empty()) path += "&track=" + urlEncode(request.track);
    if (!request.artist.empty()) path += "&artist=" + urlEncode(request.artist);
    path += "&providers=" + urlEncode(request.includeArt ? request.providers : "tmdb");
    if (!request.includeArt) path += "&art=0";
    if (request.includeArt && request.includeTitleLogo) path += "&logos=1";
    if (request.includeArt && request.width > 0 && request.height > 0)
        path += "&width=" + ssc::platform::integerText(request.width) + "&height=" + ssc::platform::integerText(request.height);
    if (useFanartClientKey)
        path += "&client_key=" + urlEncode(request.fanartClientKey);
    if (request.includeRatings) path += "&ratings=" + urlEncode(request.ratingCountries);

    const HttpResponse response = get(config_.apiHost, config_.apiPort, path, cancel);
    if (!response.ok()) {
        result.error = response.status == 0 ? response.error
            : ("resolver HTTP " + ssc::platform::integerText(response.status));
        return result;
    }
    parseResponse(response.body, result);
    return result;
}

FanartKeyCheckResult MediaResolver::checkFanartClientKey(
        const std::string& clientKey, const std::atomic<bool>* cancel) const {
    FanartKeyCheckResult result;
    if (!cleanRequestText(clientKey, 128, true)) {
        result.status = FanartKeyCheckStatus::Invalid;
        result.error = "invalid fanart.tv client key";
        return result;
    }
    const HttpResponse response = get("webservice.fanart.tv", 443,
        "/v3/movies/27205?client_key=" + urlEncode(clientKey), cancel);
    if (response.status == 401 || response.status == 403) {
        result.status = FanartKeyCheckStatus::Rejected;
        result.error = "fanart.tv rejected the client key";
        return result;
    }
    if (!response.ok()) {
        result.status = FanartKeyCheckStatus::Failure;
        result.error = response.status == 0 ? response.error
            : ("fanart.tv HTTP " + ssc::platform::integerText(response.status));
        return result;
    }
    JsonView root;
    if (!readJsonView(response.body, root) || root.type != JsonView::Object) {
        result.error = "invalid fanart.tv response";
        return result;
    }
    const auto id = root.get("tmdb_id"); std::string text; double number;
    const bool expected = (id.text(text, 16) && text == "27205")
        || (id.number(number) && std::floor(number) == 27205.0);
    if (!expected) {
        result.error = "unexpected fanart.tv response";
        return result;
    }
    result.status = FanartKeyCheckStatus::Accepted;
    return result;
}

std::string MediaResolver::resolveCredit(const std::string& album, const std::string& albumUrl,
                                         const std::string& stationHost, bool* requestSucceeded,
                                         const std::atomic<bool>* cancel) const {
    if (requestSucceeded) *requestSucceeded = false;
    if (!cleanRequestText(album, 180, true)
            || !trustedAlbumPageUrl(albumUrl, stationHost)) return std::string();
    std::string path = "/api/credit?album=" + urlEncode(album)
        + "&url=" + urlEncode(albumUrl);
#if SSC_ENABLE_DEBUG_OVERLAY
    path += "&diagnostics=1";
#endif
    const HttpResponse response = get(config_.apiHost, config_.apiPort, path, cancel);
    if (!response.ok()) return std::string();
    JsonView root;
    if (!readJsonView(response.body, root) || root.type != JsonView::Object) return std::string();
    std::string artist;
    if (!cleanText(root.get("artist"), artist, 180)) artist.clear();
    if (requestSucceeded) *requestSucceeded = true;
    return artist;
}

bool MediaResolver::downloadRatingAsset(const Certification& certification, std::string& bytes,
                                        const std::atomic<bool>* cancel) const {
    bytes.clear();
    const auto path = ratingAssetPath(certification.country, certification.system, certification.rating);
    if (path.empty() || (cancel && cancel->load())) return false;
    // Only project-owned, versioned PNGs; no URLs supplied by provider metadata.
    const auto response = get(config_.apiHost, config_.apiPort, path, cancel);
    if (!response.ok() || response.body.empty() || response.body.size() > 65536
            || (cancel && cancel->load())) return false;
    bytes = response.body;
    return true;
}

bool MediaResolver::downloadTitleLogo(const MediaResult& media, std::string& bytes,
                                      const std::atomic<bool>* cancel) const {
    bytes.clear();
    std::string host, path;
    if (media.status != MediaResult::Hit
            || !trustedBackdropUrl(media.titleLogoUrl, media.titleLogoSource, &host, &path)) return false;
    const HttpResponse response = get(host, 443, path, cancel);
    if (!response.ok() || response.body.empty()) return false;
    bytes = response.body;
    return true;
}

bool MediaResolver::downloadBackdrop(const MediaResult& media, std::string& bytes,
                                     const std::atomic<bool>* cancel) const {
    bytes.clear();
    std::string host, path;
    if (!media.hasBackdrop() || !trustedBackdropUrl(media.backdropUrl, media.source, &host, &path))
        return false;
    const HttpResponse response = get(host, 443, path, cancel);
    if (!response.ok() || response.body.empty()) return false;
    bytes = response.body;
    return true;
}

} // namespace ssc
