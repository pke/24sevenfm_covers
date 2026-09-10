"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");

const CREDIT_CACHE_SECONDS = 60 * 60 * 24 * 30 * 6;
const CREDIT_MISS_CACHE_SECONDS = 15 * 60;
const CREDIT_TIMEOUT_MS = 3000;
const MUSICBRAINZ_TRACK_TIMEOUT_MS = 7500;
const MUSICBRAINZ_RETRY_MS = 1100;
const debugLogContext = new AsyncLocalStorage();
let debugRequestSequence = 0;
const MAX_ALBUM_PAGE_BYTES = 256 * 1024;
const MAX_ALBUM_URL_LENGTH = 512;
const AMAZON_ASIN = /^[A-Z0-9]{10}$/;
const MUSICBRAINZ_USER_AGENT =
    "24sevenfm-covers/1.0 (https://24sevenfm-covers.dudesoft.app)";
const DEFAULT_ORIGIN = "https://24sevenfm-covers.dudesoft.app";
const DEFAULT_ALBUM_HOSTS = Object.freeze([
    "streamingsoundtracks.com",
    "1980s.fm",
    "adagio.fm",
    "death.fm",
    "entranced.fm",
]);
const SAFE_ALBUM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function debugLoggingEnabled(env) {
    return /^(?:1|true|yes|on)$/i.test(String(env && env.BACKDROP_DEBUG_LOG || "").trim());
}

function debugRequestId() {
    debugRequestSequence = (debugRequestSequence + 1) % Number.MAX_SAFE_INTEGER;
    return process.pid + "-" + Date.now().toString(36) + "-credit-"
        + debugRequestSequence.toString(36);
}

function debugLog(level, event, details = {}) {
    const context = debugLogContext.getStore() || {};
    const env = context.env || process.env;
    // Production upstream failures must remain diagnosable without enabling the
    // verbose request log. Vercel supplies VERCEL=1 to deployed functions.
    if (!debugLoggingEnabled(env) && (level === "info" || String(env.VERCEL) !== "1")) return;
    const entry = {
        timestamp: new Date().toISOString(),
        event,
        request_id: context.requestId || null,
        ...details,
    };
    const writer = level === "error" ? console.error
        : level === "warn" ? console.warn : console.log;
    writer("[credit] " + JSON.stringify(entry));
}

class CreditError extends Error {
    constructor(code, status) {
        super(code);
        this.name = "CreditError";
        this.code = code;
        this.status = status;
    }
}

function cacheControl(seconds, staleSeconds) {
    return "public, max-age=" + seconds + ", s-maxage=" + seconds
        + ", stale-while-revalidate=" + staleSeconds;
}

function allowedOrigins(env) {
    return new Set(String(env.BACKDROP_ALLOWED_ORIGINS || DEFAULT_ORIGIN)
        .split(",").map((origin) => origin.trim()).filter(Boolean));
}

function allowedAlbumHosts(env) {
    return new Set(String(env.ALBUM_CREDIT_ALLOWED_HOSTS || DEFAULT_ALBUM_HOSTS.join(","))
        .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
}

function trustedAlbumUrl(raw, env = process.env) {
    if (typeof raw !== "string" || !raw || raw.length > MAX_ALBUM_URL_LENGTH
            || /[\u0000-\u001F\u007F]/.test(raw)) return "";
    try {
        const url = new URL(raw);
        const keys = Array.from(url.searchParams.keys());
        if (url.protocol !== "https:" || (url.port && url.port !== "443")
                || url.username || url.password || url.hash
                || !allowedAlbumHosts(env).has(url.hostname.toLowerCase())
                || url.pathname !== "/modules.php"
                || keys.length !== 2 || url.searchParams.getAll("name").length !== 1
                || url.searchParams.get("name") !== "Album"
                || url.searchParams.getAll("asin").length !== 1
                || !SAFE_ALBUM_ID.test(url.searchParams.get("asin") || "")) return "";
        return url.href;
    } catch (error) {
        return "";
    }
}

function decodeHtmlText(value) {
    return String(value || "").replace(
        /&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi,
        (entity, body) => {
            const key = body.toLowerCase();
            if (key === "amp") return "&";
            if (key === "quot") return '"';
            if (key === "apos") return "'";
            if (key === "lt") return "<";
            if (key === "gt") return ">";
            const point = key.startsWith("#x")
                ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
            try { return Number.isSafeInteger(point) ? String.fromCodePoint(point) : entity; }
            catch (error) { return entity; }
        });
}

function tagAttribute(tag, name) {
    const match = String(tag).match(new RegExp("\\b" + name
        + "\\s*=\\s*([\\\"'])([\\s\\S]*?)\\1", "i"));
    return match ? decodeHtmlText(match[2]).replace(/\s+/g, " ").trim() : "";
}

function normalizedCreditText(value) {
    return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function textFromHtml(value) {
    return decodeHtmlText(String(value || "").replace(/<[^>]*>/g, " "))
        .replace(/\s+/g, " ").trim();
}

function artistFromTrackRows(html, track) {
    const wantedTrack = normalizedCreditText(track);
    if (!wantedTrack) return "";
    const artists = new Set();
    const rows = String(html || "").match(/<tr\b[^>]*>[\s\S]*?<\/tr\s*>/gi) || [];
    for (const row of rows) {
        const cells = Array.from(row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td\s*>/gi),
            (match) => match[1]);
        for (const cell of cells) {
            const separator = /<br\s*\/?\s*>/i.exec(cell);
            if (!separator) continue;
            const candidateTrack = textFromHtml(cell.slice(0, separator.index));
            if (normalizedCreditText(candidateTrack) !== wantedTrack) continue;
            const artist = textFromHtml(cell.slice(separator.index + separator[0].length));
            if (artist && artist.length <= 180 && !/[\u0000-\u001F\u007F]/.test(artist))
                artists.add(artist);
        }
    }
    return artists.size === 1 ? artists.values().next().value : "";
}

function artistFromAlbumHtml(html, album, track) {
    // The album page lists a credit beneath every track. When the caller supplies
    // a track, only that exact row is authoritative: the Open Graph value describes
    // the release as a whole and can name a different composer or principal artist.
    if (String(track || "").trim()) return artistFromTrackRows(html, track);
    const wantedAlbum = String(album || "").replace(/\s+/g, " ").trim();
    if (!wantedAlbum) return "";
    const tags = String(html || "").match(/<meta\b[^>]*>/gi) || [];
    for (const tag of tags) {
        if (tagAttribute(tag, "property").toLowerCase() !== "og:title") continue;
        const title = tagAttribute(tag, "content");
        const marker = " - " + wantedAlbum + " - ";
        const index = title.lastIndexOf(marker);
        if (index < 0) continue;
        const artist = title.slice(index + marker.length).trim();
        if (artist && artist.length <= 180 && !/[\u0000-\u001F\u007F]/.test(artist)) return artist;
    }
    return "";
}

function musicBrainzCredit(credit) {
    const artist = (Array.isArray(credit) ? credit : []).map((entry) => {
        if (!entry || typeof entry !== "object") return "";
        const name = String(entry.name || entry.artist && entry.artist.name || "");
        return name + String(entry.joinphrase || "");
    }).join("").replace(/\s+/g, " ").trim();
    return artist && artist.length <= 180 && !/[\u0000-\u001F\u007F]/.test(artist)
        ? artist : "";
}

function musicBrainzArtist(releases, asin) {
    const artists = new Set();
    for (const release of Array.isArray(releases) ? releases : []) {
        if (!release || String(release.asin || "").toUpperCase() !== asin) continue;
        const artist = musicBrainzCredit(release["artist-credit"]);
        if (artist && artist.length <= 180 && !/[\u0000-\u001F\u007F]/.test(artist))
            artists.add(artist);
    }
    return artists.size === 1 ? artists.values().next().value : "";
}

function musicBrainzTrackArtist(releases, asin, track) {
    const wantedTrack = normalizedCreditText(track);
    if (!wantedTrack) return "";
    const artists = new Set();
    for (const release of Array.isArray(releases) ? releases : []) {
        if (!release || String(release.asin || "").toUpperCase() !== asin) continue;
        for (const medium of Array.isArray(release.media) ? release.media : []) {
            for (const candidate of Array.isArray(medium && medium.tracks)
                ? medium.tracks : []) {
                const recording = candidate && candidate.recording;
                const titles = [candidate && candidate.title, recording && recording.title];
                if (!titles.some((title) => normalizedCreditText(title) === wantedTrack)) continue;
                const artist = musicBrainzCredit(candidate["artist-credit"])
                    || musicBrainzCredit(recording && recording["artist-credit"]);
                if (artist) artists.add(artist);
            }
        }
    }
    return artists.size === 1 ? artists.values().next().value : "";
}

function responseHeader(response, name) {
    return response && response.headers && typeof response.headers.get === "function"
        ? response.headers.get(name) : null;
}

async function albumPageBytes(response) {
    const declaredSize = Number(responseHeader(response, "content-length") || 0);
    if (declaredSize > MAX_ALBUM_PAGE_BYTES)
        throw new CreditError("album_page_too_large", 413);
    if (!response.body || typeof response.body.getReader !== "function") {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_ALBUM_PAGE_BYTES)
            throw new CreditError("album_page_too_large", 413);
        return bytes;
    }
    const chunks = [], reader = response.body.getReader();
    let total = 0;
    while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > MAX_ALBUM_PAGE_BYTES) {
            await reader.cancel();
            throw new CreditError("album_page_too_large", 413);
        }
        chunks.push(Buffer.from(part.value));
    }
    return Buffer.concat(chunks, total);
}

async function fetchAlbumArtist(fetchImpl, url, album, track) {
    const startedAt = Date.now();
    debugLog("info", "upstream.request", { url });
    let response;
    try {
        response = await fetchImpl(url, {
            redirect: "manual",
            headers: {
                "Accept": "text/html",
                "User-Agent": "24sevenfm-covers-album-credit/1.0",
            },
            signal: AbortSignal.timeout(CREDIT_TIMEOUT_MS),
        });
    } catch (error) {
        debugLog("warn", "upstream.failure", {
            url,
            duration_ms: Date.now() - startedAt,
            error_name: error && error.name || "Error",
            error_message: error && error.message || "request failed",
        });
        throw error;
    }
    debugLog("info", "upstream.response", {
        url,
        status: response.status,
        content_type: responseHeader(response, "content-type"),
        duration_ms: Date.now() - startedAt,
    });
    if (response.status >= 300 && response.status < 400)
        throw new CreditError("album_redirect_not_allowed", 502);
    if (!response.ok) {
        debugLog("warn", "upstream.rejected", {
            url,
            status: response.status,
            cf_ray: responseHeader(response, "cf-ray"),
            duration_ms: Date.now() - startedAt,
        });
        const error = new CreditError("album_page_unavailable", 502);
        error.upstreamStatus = response.status;
        throw error;
    }
    const contentType = String(responseHeader(response, "content-type") || "").toLowerCase();
    if (!contentType.startsWith("text/html"))
        throw new CreditError("invalid_album_page", 502);
    const bytes = await albumPageBytes(response);
    debugLog("info", "upstream.body", {
        url,
        bytes: bytes.length,
        duration_ms: Date.now() - startedAt,
    });
    const charset = /charset\s*=\s*([^;\s]+)/i.exec(contentType);
    const requestedEncoding = charset && charset[1].replace(/["']/g, "").toLowerCase();
    const encoding = requestedEncoding === "iso-8859-1" ? "windows-1252" : "utf-8";
    return artistFromAlbumHtml(new TextDecoder(encoding).decode(bytes), album, track);
}

async function fetchMusicBrainzJson(fetchImpl, url, asin, waitImpl, phase,
    attempts = 2, timeoutMs = CREDIT_TIMEOUT_MS, retryTimeouts = true) {
    const startedAt = Date.now();
    debugLog("info", "fallback.request", { provider: "musicbrainz", asin, phase });
    let response;
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            response = await fetchImpl(url, {
                redirect: "manual",
                headers: {
                    "Accept": "application/json",
                    "User-Agent": MUSICBRAINZ_USER_AGENT,
                },
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (error) {
            if (attempt + 1 < attempts
                    && (retryTimeouts || error && error.name !== "TimeoutError")) {
                debugLog("warn", "fallback.retry", {
                    provider: "musicbrainz",
                    asin,
                    phase,
                    reason: error && error.name || "network_error",
                    delay_ms: MUSICBRAINZ_RETRY_MS,
                });
                await waitImpl(MUSICBRAINZ_RETRY_MS);
                continue;
            }
            debugLog("warn", "fallback.failure", {
                provider: "musicbrainz",
                asin,
                phase,
                duration_ms: Date.now() - startedAt,
                error_name: error && error.name || "Error",
                error_message: error && error.message || "request failed",
            });
            throw error;
        }
        const retryable = response.status === 429 || response.status >= 500;
        if (attempt + 1 < attempts && retryable) {
            debugLog("warn", "fallback.retry", {
                provider: "musicbrainz",
                asin,
                phase,
                reason: "http_" + response.status,
                delay_ms: MUSICBRAINZ_RETRY_MS,
            });
            await waitImpl(MUSICBRAINZ_RETRY_MS);
            continue;
        }
        break;
    }
    if (!response || !response.ok) {
        debugLog("warn", "fallback.rejected", {
            provider: "musicbrainz",
            asin,
            phase,
            status: response && response.status || 0,
            duration_ms: Date.now() - startedAt,
        });
        throw new CreditError("credit_lookup_unavailable", 502);
    }
    const contentType = String(responseHeader(response, "content-type") || "").toLowerCase();
    if (!contentType.startsWith("application/json"))
        throw new CreditError("credit_lookup_unavailable", 502);
    const bytes = await albumPageBytes(response);
    let body;
    try { body = JSON.parse(new TextDecoder("utf-8").decode(bytes)); }
    catch (error) { throw new CreditError("credit_lookup_unavailable", 502); }
    return body;
}

async function fetchMusicBrainzArtist(fetchImpl, albumUrl, track, waitImpl) {
    const asin = new URL(albumUrl).searchParams.get("asin").toUpperCase();
    if (!AMAZON_ASIN.test(asin)) return null;
    const searchUrl = new URL("https://musicbrainz.org/ws/2/release/");
    searchUrl.searchParams.set("query", "asin:" + asin);
    searchUrl.searchParams.set("fmt", "json");
    searchUrl.searchParams.set("limit", "25");
    const startedAt = Date.now();
    const exactTrack = !!String(track || "").trim();
    const search = await fetchMusicBrainzJson(fetchImpl, searchUrl, asin, waitImpl,
        "release-search", 2,
        exactTrack ? MUSICBRAINZ_TRACK_TIMEOUT_MS : CREDIT_TIMEOUT_MS, !exactTrack);
    let artist;
    if (exactTrack) {
        const releaseGroups = new Set((Array.isArray(search && search.releases)
            ? search.releases : []).filter((release) => release
                && String(release.asin || "").toUpperCase() === asin)
            .map((release) => release["release-group"] && release["release-group"].id)
            .filter(Boolean));
        if (releaseGroups.size !== 1) return "";
        await waitImpl(MUSICBRAINZ_RETRY_MS);
        const releasesUrl = new URL("https://musicbrainz.org/ws/2/release/");
        releasesUrl.searchParams.set("release-group", releaseGroups.values().next().value);
        releasesUrl.searchParams.set("inc", "recordings+artist-credits");
        releasesUrl.searchParams.set("fmt", "json");
        releasesUrl.searchParams.set("limit", "100");
        const releases = await fetchMusicBrainzJson(fetchImpl, releasesUrl, asin, waitImpl,
            "release-tracks", 2, MUSICBRAINZ_TRACK_TIMEOUT_MS, false);
        artist = musicBrainzTrackArtist(releases && releases.releases, asin, track);
    } else {
        artist = musicBrainzArtist(search && search.releases, asin);
    }
    debugLog("info", "fallback.response", {
        provider: "musicbrainz",
        asin,
        exact_track: exactTrack,
        has_artist: !!artist,
        duration_ms: Date.now() - startedAt,
    });
    return artist;
}

async function fetchAlbumArtistWithFallback(fetchImpl, url, album, track, waitImpl) {
    try {
        return await fetchAlbumArtist(fetchImpl, url, album, track);
    } catch (stationError) {
        const canFallback = !(stationError instanceof CreditError)
            || stationError.code === "album_page_unavailable";
        if (!canFallback) throw stationError;
        try {
            const artist = await fetchMusicBrainzArtist(fetchImpl, url, track, waitImpl);
            if (artist !== null) return artist;
        } catch (fallbackError) {
            debugLog("warn", "fallback.unavailable", {
                provider: "musicbrainz",
                error_name: fallbackError && fallbackError.name || "Error",
                error_message: fallbackError && fallbackError.message || "request failed",
            });
        }
        throw stationError;
    }
}

function sendJson(res, status, body) {
    debugLog("info", "response.body", { status, body });
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
}

function createCreditHandler(options = {}) {
    const env = options.env || process.env;
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const waitImpl = options.waitImpl
        || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    async function handleCreditRequest(req, res) {
        debugLog("info", "request.start", {
            method: req && req.method,
            album: req && req.query && req.query.album,
            track: req && req.query && req.query.track,
            url: req && req.query && req.query.url,
        });
        res.setHeader("Vary", "Origin");
        res.setHeader("X-Content-Type-Options", "nosniff");
        const origin = req.headers && req.headers.origin;
        if (origin && !allowedOrigins(env).has(origin)) {
            res.setHeader("Cache-Control", "no-store");
            return sendJson(res, 403, { error: "origin_not_allowed" });
        }
        if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        if (req.method === "OPTIONS") {
            res.statusCode = 204;
            return res.end();
        }
        if (req.method !== "GET") {
            res.setHeader("Allow", "GET, OPTIONS");
            res.setHeader("Cache-Control", "no-store");
            return sendJson(res, 405, { error: "method_not_allowed" });
        }
        try {
            const query = req.query || {};
            const album = query.album;
            const track = query.track;
            const url = trustedAlbumUrl(query.url, env);
            if (typeof album !== "string" || !album.trim() || album.length > 180
                    || /[\u0000-\u001F\u007F]/.test(album))
                throw new CreditError("invalid_album", 400);
            if (track !== undefined && (typeof track !== "string" || track.length > 300
                    || /[\u0000-\u001F\u007F]/.test(track)))
                throw new CreditError("invalid_track", 400);
            if (!url) throw new CreditError("invalid_album_url", 400);
            const artist = await fetchAlbumArtistWithFallback(
                fetchImpl, url, album.trim(), typeof track === "string" ? track.trim() : "",
                waitImpl);
            res.setHeader("Cache-Control", artist
                ? cacheControl(CREDIT_CACHE_SECONDS, 86400)
                : cacheControl(CREDIT_MISS_CACHE_SECONDS, 60));
            return sendJson(res, 200, { artist });
        } catch (error) {
            const known = error instanceof CreditError;
            res.setHeader("Cache-Control", "no-store");
            return sendJson(res, known ? error.status : 502, {
                error: known ? error.code : "album_page_unavailable",
            });
        }
    }

    return function creditHandler(req, res) {
        const context = { env, requestId: debugRequestId(), startedAt: Date.now() };
        return debugLogContext.run(context, async () => {
            const result = await handleCreditRequest(req, res);
            debugLog("info", "request.complete", {
                status: res.statusCode,
                duration_ms: Date.now() - context.startedAt,
            });
            return result;
        });
    };
}

const handler = createCreditHandler();

module.exports = {
    CREDIT_CACHE_SECONDS,
    CREDIT_MISS_CACHE_SECONDS,
    artistFromAlbumHtml,
    createCreditHandler,
    fetchAlbumArtist,
    handler,
    trustedAlbumUrl,
};
