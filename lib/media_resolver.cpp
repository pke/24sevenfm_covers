#include "media_resolver.h"

#include "mini_json.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <set>
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

bool cleanText(const JsonValue* value, std::string& out, size_t maxLength) {
    if (!value || value->type != JsonValue::String || value->string.empty()
            || !cleanRequestText(value->string, maxLength, true)) return false;
    out = value->string;
    return true;
}

bool cleanOptionalText(const JsonValue* value, std::string& out, size_t maxLength) {
    if (!value || value->type != JsonValue::String
            || !cleanRequestText(value->string, maxLength, false))
        return false;
    out = value->string;
    return true;
}

bool splitHttps(const std::string& url, std::string& host, std::string& path) {
    host.clear(); path.clear();
    if (url.compare(0, 8, "https://") != 0) return false;
    for (unsigned char c : url) if (c < 0x20 || c == 0x7F) return false;
    const size_t authority = 8;
    const size_t end = url.find_first_of("/?#", authority);
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
    std::set<std::string> seen;
    size_t begin = 0;
    while (begin <= csv.size()) {
        const size_t end = csv.find(',', begin);
        const std::string id = csv.substr(begin,
            end == std::string::npos ? std::string::npos : end - begin);
        if (id != "fanart" && id != "tmdb" && id != "tvmaze" && id != "steamgriddb")
            return false;
        if (!seen.insert(id).second) return false;
        if (end == std::string::npos) break;
        begin = end + 1;
    }
    return !seen.empty();
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

std::vector<std::string> cleanDescriptors(const JsonValue* value, const std::string& rating) {
    const char* allowed[4] = {nullptr, nullptr, nullptr, nullptr};
    size_t allowedCount = 0;
    if (rating == "TV-Y7" || rating == "TV-Y7-FV") {
        allowed[allowedCount++] = "FV";
    } else if (rating == "TV-PG" || rating == "TV-14") {
        allowed[allowedCount++] = "D"; allowed[allowedCount++] = "L";
        allowed[allowedCount++] = "S"; allowed[allowedCount++] = "V";
    } else if (rating == "TV-MA") {
        allowed[allowedCount++] = "L"; allowed[allowedCount++] = "S";
        allowed[allowedCount++] = "V";
    }
    std::set<std::string> supplied;
    if (value && value->type == JsonValue::Array) {
        for (const JsonValue& item : value->array) {
            if (item.type != JsonValue::String) continue;
            std::string code = item.string;
            for (char& c : code) c = static_cast<char>(
                std::toupper(static_cast<unsigned char>(c)));
            supplied.insert(code);
        }
    }
    if (rating == "TV-Y7-FV") supplied.insert("FV");
    std::vector<std::string> out;
    for (size_t i = 0; i < allowedCount; ++i)
        if (supplied.count(allowed[i])) out.push_back(allowed[i]);
    return out;
}

bool parseResponse(const std::string& body, MediaResult& out) {
    JsonValue root;
    if (!parseJson(body, root, &out.error) || root.type != JsonValue::Object) {
        if (out.error.empty()) out.error = "invalid resolver JSON";
        return false;
    }

    const JsonValue* media = root.get("media");
    if (media && media->type == JsonValue::Object) {
        cleanText(media->get("title"), out.mediaTitle, 180);
        cleanText(media->get("type"), out.mediaType, 16);
        if (out.mediaType != "movie" && out.mediaType != "tv" && out.mediaType != "game")
            out.mediaType.clear();
    } else if (media && media->type != JsonValue::Null) {
        out.error = "invalid media result";
        return false;
    }

    const JsonValue* metadata = root.get("metadata");
    if (metadata && metadata->type == JsonValue::Object) {
        std::string album, track, artist;
        if (!cleanText(metadata->get("album"), album, 180)
                || !cleanOptionalText(metadata->get("track"), track, 300)
                || !cleanOptionalText(metadata->get("artist"), artist, 180)) {
            out.error = "invalid normalized metadata";
            return false;
        }
        out.album = album; out.track = track; out.artist = artist;
        out.hasMetadata = true;
    } else if (metadata) {
        out.error = "invalid normalized metadata";
        return false;
    }

    const JsonValue* backdrop = root.get("backdrop");
    const JsonValue* source = root.get("source");
    if (backdrop && backdrop->type == JsonValue::String) out.backdropUrl = backdrop->string;
    else if (backdrop && backdrop->type != JsonValue::Null) {
        out.error = "invalid backdrop result"; return false;
    }
    if (source && source->type == JsonValue::String) out.source = source->string;
    else if (source && source->type != JsonValue::Null) {
        out.error = "invalid backdrop source"; return false;
    }
    if (!out.backdropUrl.empty() && !trustedBackdropUrl(out.backdropUrl, out.source)) {
        out.error = "untrusted backdrop URL"; return false;
    }

    const JsonValue* tint = root.get("tint");
    if (tint && tint->type == JsonValue::Array && tint->array.size() == 3) {
        bool valid = true;
        for (size_t i = 0; i < 3; ++i) {
            const JsonValue& v = tint->array[i];
            if (v.type != JsonValue::Number || v.number < 0 || v.number > 255) valid = false;
            else out.tint[i] = static_cast<int>(std::floor(v.number + 0.5));
        }
        out.hasTint = valid;
    }

    const JsonValue* certs = root.get("certifications");
    std::set<std::string> countries;
    if (certs && certs->type != JsonValue::Array) {
        out.error = "invalid certifications result"; return false;
    }
    if (certs) for (const JsonValue& raw : certs->array) {
        if (raw.type != JsonValue::Object) continue;
        Certification cert;
        if (!cleanText(raw.get("country"), cert.country, 2)
                || !cleanText(raw.get("system"), cert.system, 40)
                || !cleanText(raw.get("rating"), cert.rating, 32)
                || !cleanText(raw.get("label"), cert.label, 40)
                || countries.count(cert.country)
                || !knownCertification(cert.country, cert.system, cert.rating)) continue;
        if (cert.system == "TV Parental Guidelines")
            cert.descriptors = cleanDescriptors(raw.get("descriptors"), cert.rating);
        countries.insert(cert.country);
        out.certifications.push_back(std::move(cert));
    }

    out.status = (!out.backdropUrl.empty() || !out.certifications.empty())
        ? MediaResult::Hit : MediaResult::Miss;
    return true;
}

} // namespace

std::string urlEncode(const std::string& utf8) {
    std::string out;
    char hex[4];
    for (unsigned char c : utf8) {
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') {
            out += static_cast<char>(c);
        } else {
            std::snprintf(hex, sizeof(hex), "%%%02X", static_cast<unsigned>(c));
            out += hex;
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
    if (config_.transport)
        return config_.transport(host, port, path, "GET", "", "", config_.timeoutSeconds);
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
    if (!request.track.empty()) path += "&track=" + urlEncode(request.track);
    if (!request.artist.empty()) path += "&artist=" + urlEncode(request.artist);
    path += "&providers=" + urlEncode(request.includeArt ? request.providers : "tmdb");
    if (!request.includeArt) path += "&art=0";
    if (request.includeArt && request.width > 0 && request.height > 0)
        path += "&width=" + std::to_string(request.width) + "&height=" + std::to_string(request.height);
    if (useFanartClientKey)
        path += "&client_key=" + urlEncode(request.fanartClientKey);
    if (request.includeRatings) path += "&ratings=" + urlEncode(request.ratingCountries);

    const HttpResponse response = get(config_.apiHost, config_.apiPort, path, cancel);
    if (!response.ok()) {
        result.error = response.status == 0 ? response.error
            : ("resolver HTTP " + std::to_string(response.status));
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
            : ("fanart.tv HTTP " + std::to_string(response.status));
        return result;
    }
    JsonValue root;
    if (!parseJson(response.body, root) || root.type != JsonValue::Object) {
        result.error = "invalid fanart.tv response";
        return result;
    }
    const JsonValue* id = root.get("tmdb_id");
    const bool expected = id && ((id->type == JsonValue::String && id->string == "27205")
        || (id->type == JsonValue::Number && std::floor(id->number) == 27205.0));
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
    const std::string path = "/api/credit?album=" + urlEncode(album)
        + "&url=" + urlEncode(albumUrl);
    const HttpResponse response = get(config_.apiHost, config_.apiPort, path, cancel);
    if (!response.ok()) return std::string();
    JsonValue root;
    if (!parseJson(response.body, root) || root.type != JsonValue::Object) return std::string();
    std::string artist;
    if (!cleanText(root.get("artist"), artist, 180)) artist.clear();
    if (requestSucceeded) *requestSucceeded = true;
    return artist;
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
