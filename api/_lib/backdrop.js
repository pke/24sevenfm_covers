"use strict";

const CACHE_SECONDS = 60 * 60 * 24 * 30 * 6;
// A TV result may need TMDB search, external IDs, fanart, and a tint thumbnail in
// sequence. Keep each leg short enough that all four fit under the 15 s function
// and 20 s client deadlines even when every upstream stalls.
const PROVIDER_TIMEOUT_MS = 3000;
const MAX_TINT_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TINT_IMAGE_PIXELS = 4 * 1000 * 1000;
const MAX_TINT_URL_LENGTH = 512;
const MAX_TINT_REDIRECTS = 2;
const DEFAULT_ORIGIN = "https://24sevenfm-covers.dudesoft.app";
const DEFAULT_TINT_HOSTS = Object.freeze([
    "streamingsoundtracks.com",
    "1980s.fm",
    "adagio.fm",
    "death.fm",
    "entranced.fm",
]);
const COVER_TINT_PATH = /^\/images\/cover\/[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.(?:jpe?g|png|webp)$/i;
const WHITE_TINT = Object.freeze([255, 255, 255]);

class ResolverError extends Error {
    constructor(code, status, message) {
        super(message || code);
        this.name = "ResolverError";
        this.code = code;
        this.status = status;
    }
}

function cleanMovieTitle(album) {
    const cleaned = unrotateTitleArticle(String(album || "")
        .replace(/\((original|music|motion|complete|soundtrack|score|ost|deluxe|expanded|remaster)[^)]*\)/gi, " ")
        .replace(/\b(original motion picture soundtrack|music from the motion picture|original motion picture score|motion picture soundtrack|original soundtracks?|original scores?|the original scores?|soundtrack|ost)\b/gi, " ")
        .replace(/\s*[:\-–]\s*(?:the\s+)?symphonic\s+suite\s*$/i, " ")
        .replace(/[:\-–]\s*$/, "")
        .replace(/\s{2,}/g, " ").trim())
        .replace(/\s*&\s*/g, " and ")
        .replace(/\s{2,}/g, " ").trim();
    // A few compilation albums use a marketing title rather than the screen
    // work's canonical title. Keep these explicit: stripping phrases such as
    // "The Magic of" generally would corrupt real movie titles.
    if (/^the magic of inspector morse$/i.test(cleaned)) return "Inspector Morse";
    return cleaned;
}

function backdropTitleFor(album, track) {
    const normalizedAlbum = cleanMovieTitle(album);
    if (/^the wings of a film$/i.test(normalizedAlbum)) {
        const separator = String(track || "").indexOf(":");
        if (separator > 0) {
            const workTitle = cleanMovieTitle(String(track).slice(0, separator));
            if (workTitle) return workTitle;
        }
    }
    return normalizedAlbum;
}

function mediaHintForAlbum(album) {
    const title = String(album || "");
    if (/^the wings of a film$/i.test(cleanMovieTitle(title))) return "movie";
    if (/\b(?:original\s+)?video\s+game\s+(?:soundtrack|score)\b/i.test(title)
            || /\b(?:soundtrack|music|score)\s+(?:from|to)\s+the\s+(?:video\s+)?game\b/i.test(title)
            || /\boriginal\s+game\s+(?:soundtrack|score)\b/i.test(title)) return "game";
    if (/\b(?:television|tv\s+(?:series|show))\s+(?:soundtrack|score)\b/i.test(title)
            || /\b(?:soundtrack|music|score)\s+from\s+the\s+(?:television|tv\s+(?:series|show))\b/i.test(title)) return "tv";
    if (/\b(?:motion\s+picture|film)\s+(?:soundtrack|score)\b/i.test(title)
            || /\b(?:soundtrack|music|score)\s+from\s+the\s+(?:motion\s+picture|film)\b/i.test(title)) return "movie";
    return "auto";
}

function unrotateTitleArticle(title) {
    return String(title || "").replace(
        /^(.+),\s*(The|A|An)(\s+\((?:18|19|20|21)\d{2}\))?$/i, "$2 $1$3");
}

function normalizedTitle(title) {
    return String(title || "")
        .normalize("NFKD").replace(/\p{M}/gu, "")
        .toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function mediaType(media) {
    return media && media.media_type === "tv" ? "tv" : "movie";
}

function mediaTitle(media) {
    return mediaType(media) === "tv"
        ? (media && (media.name || media.original_name))
        : (media && (media.title || media.original_title));
}

function pickMediaMatch(results, query, wantedType) {
    const wanted = normalizedTitle(query);
    let exact = null;
    let withBackdrop = null;
    let first = null;
    for (const media of Array.isArray(results) ? results : []) {
        if (!media || (media.media_type && media.media_type !== "movie"
                && media.media_type !== "tv")) continue;
        if ((wantedType === "movie" || wantedType === "tv")
                && mediaType(media) !== wantedType) continue;
        if (!first) first = media;
        const titles = mediaType(media) === "tv"
            ? [media.name, media.original_name] : [media.title, media.original_title];
        if (!exact && titles.some((title) => normalizedTitle(title) === wanted)) exact = media;
        if (!withBackdrop && media.backdrop_path) withBackdrop = media;
    }
    return { media: exact || withBackdrop || first || null, exact: !!exact };
}

function pickMedia(results, query, wantedType) {
    return pickMediaMatch(results, query, wantedType).media;
}

// Kept as an export alias for callers written against the original movie-only resolver.
function pickMovie(results, query) {
    return pickMedia(results, query);
}

function tintFromMeans(means) {
    const rgb = Array.from(means || []).slice(0, 3).map(Number);
    if (rgb.length !== 3 || rgb.some((value) => !Number.isFinite(value))) return [...WHITE_TINT];
    const max = Math.max(...rgb);
    if (max < 255 * 0.02) return [...WHITE_TINT];
    const scale = 255 / max;
    return rgb.map((value) => {
        const normalized = Math.max(0, Math.min(255, value * scale));
        return Math.round(normalized + (255 - normalized) * 0.35);
    });
}

function allowedOrigins(env) {
    return new Set(String(env.BACKDROP_ALLOWED_ORIGINS || DEFAULT_ORIGIN)
        .split(",").map((origin) => origin.trim()).filter(Boolean));
}

function allowedTintHosts(env) {
    return new Set(String(env.TINT_ALLOWED_HOSTS || DEFAULT_TINT_HOSTS.join(","))
        .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
}

function trustedCoverTintUrl(raw, env = process.env) {
    if (typeof raw !== "string" || !raw || raw.length > MAX_TINT_URL_LENGTH
            || /[\u0000-\u001F\u007F]/.test(raw)) return "";
    try {
        const url = new URL(raw);
        const host = url.hostname.toLowerCase();
        if (url.protocol !== "https:" || (url.port && url.port !== "443")
                || url.username || url.password || url.search || url.hash
                || !allowedTintHosts(env).has(host) || !COVER_TINT_PATH.test(url.pathname)) return "";
        return url.href;
    } catch (error) {
        return "";
    }
}

function queryValue(value) {
    return Array.isArray(value) ? value[0] : value;
}

function requestedProviders(value) {
    const raw = typeof value === "string" && value ? value : "fanart,tmdb,steamgriddb";
    const providers = raw.split(",").map((entry) => entry.trim().toLowerCase());
    if (!providers.length || providers.some((entry) => !["fanart", "tmdb", "steamgriddb"].includes(entry))) {
        throw new ResolverError("invalid_providers", 400,
            "providers must contain fanart, tmdb, and/or steamgriddb");
    }
    return [...new Set(providers)];
}

function requestedMediaHint(value) {
    const hint = typeof value === "string" && value ? value.trim().toLowerCase() : "auto";
    if (!["auto", "screen", "movie", "tv", "game"].includes(hint)) {
        throw new ResolverError("invalid_media_hint", 400,
            "media_hint must be auto, screen, movie, tv, or game");
    }
    return hint;
}

function configuredMediaHint(query, requestHint, env) {
    if (requestHint !== "auto") return requestHint;
    const raw = String(env.BACKDROP_MEDIA_OVERRIDES || "").trim();
    if (!raw) return "auto";
    let overrides;
    try {
        overrides = JSON.parse(raw);
    } catch (error) {
        throw new ResolverError("resolver_not_configured", 503,
            "BACKDROP_MEDIA_OVERRIDES must be a JSON object");
    }
    if (!overrides || Array.isArray(overrides) || typeof overrides !== "object") {
        throw new ResolverError("resolver_not_configured", 503,
            "BACKDROP_MEDIA_OVERRIDES must be a JSON object");
    }
    const wanted = normalizedTitle(query);
    const entry = Object.entries(overrides).find(([title]) => normalizedTitle(title) === wanted);
    if (!entry) return "auto";
    const hint = String(entry[1] || "").toLowerCase();
    if (!["screen", "movie", "tv", "game"].includes(hint)) {
        throw new ResolverError("resolver_not_configured", 503,
            "BACKDROP_MEDIA_OVERRIDES values must be screen, movie, tv, or game");
    }
    return hint;
}

async function fetchJson(fetchImpl, url, init, provider) {
    let response;
    try {
        response = await fetchImpl(url, {
            ...init,
            signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        });
    } catch (error) {
        throw new ResolverError(provider + "_unavailable", 502, provider + " request failed");
    }
    if (response.status === 401 || response.status === 403) {
        throw new ResolverError(provider + "_authentication", 502, provider + " rejected the configured key");
    }
    if (response.status === 429 || response.status >= 500) {
        throw new ResolverError(provider + "_unavailable", 502, provider + " is temporarily unavailable");
    }
    if (!response.ok) {
        throw new ResolverError(provider + "_response", 502, provider + " returned HTTP " + response.status);
    }
    try {
        return await response.json();
    } catch (error) {
        throw new ResolverError(provider + "_response", 502, provider + " returned invalid JSON");
    }
}

function tmdbRequest(url, env) {
    let token = String(env.TMDB_READ_TOKEN || env.TMDB_API_TOKEN || "").trim();
    let key = String(env.TMDB_API_KEY || "").trim();
    // The former browser setting accepted either TMDB credential in one field.
    // Preserve that compatibility for existing deployments that stored a v4 Read
    // Access Token under TMDB_API_KEY before TMDB_READ_TOKEN was introduced.
    if (!token && (key.includes(".") || /^eyJ/.test(key))) {
        token = key;
        key = "";
    }
    if (!token && !key) {
        throw new ResolverError("resolver_not_configured", 503, "TMDB server credential is missing");
    }
    if (!token) url.searchParams.set("api_key", key);
    const headers = { "Accept": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    return { headers };
}

async function searchTmdb(fetchImpl, query, env, wantedType) {
    // SST appends a release year to some otherwise ambiguous album titles. TMDB
    // does not reliably find a title when that year remains inside `query`, so
    // carry it in the dedicated movie and TV filters. Those two searches run in
    // parallel; undated titles need only TMDB's single multi-search request.
    const datedTitle = String(query || "").match(
        /^(.*?)\s*\(((?:18|19|20|21)\d{2})\)\s*$/);
    const searchTitle = datedTitle ? datedTitle[1].trim() : query;
    const searches = datedTitle ? [
        { type: "movie", yearParam: "primary_release_year" },
        { type: "tv", yearParam: "first_air_date_year" },
    ] : [{ type: "multi", yearParam: "" }];
    const settled = await Promise.all(searches.map(async (search) => {
        const url = new URL("https://api.themoviedb.org/3/search/" + search.type);
        url.searchParams.set("include_adult", "false");
        url.searchParams.set("query", searchTitle);
        if (search.yearParam) url.searchParams.set(search.yearParam, datedTitle[2]);
        try {
            const body = await fetchJson(fetchImpl, url, tmdbRequest(url, env), "tmdb");
            return { type: search.type, results: Array.isArray(body && body.results) ? body.results : [] };
        } catch (error) {
            return { type: search.type, error };
        }
    }));
    const successes = settled.filter((result) => !result.error);
    if (!successes.length) throw settled[0].error;
    const results = successes.flatMap((result) => result.results.map((media) =>
        media && !media.media_type && result.type !== "multi"
            ? { ...media, media_type: result.type } : media));
    return pickMediaMatch(results, searchTitle, wantedType);
}

function steamGridDbRequest(env) {
    const key = String(env.STEAMGRIDDB_API_KEY || "").trim();
    if (!key) {
        throw new ResolverError("resolver_not_configured", 503,
            "SteamGridDB server credential is missing");
    }
    return { headers: { "Accept": "application/json", "Authorization": "Bearer " + key } };
}

function gameReleaseYear(game) {
    const seconds = Number(game && game.release_date);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const date = new Date(seconds * 1000);
    return Number.isNaN(date.valueOf()) ? null : date.getUTCFullYear();
}

function pickGame(results, query) {
    const datedTitle = String(query || "").match(/^(.*?)\s*\(((?:18|19|20|21)\d{2})\)\s*$/);
    const searchTitle = datedTitle ? datedTitle[1].trim() : query;
    const wanted = normalizedTitle(searchTitle);
    const exact = (Array.isArray(results) ? results : []).filter((game) => game
        && Number.isSafeInteger(Number(game.id)) && Number(game.id) > 0
        && normalizedTitle(game.name) === wanted);
    if (!exact.length) return null;
    if (datedTitle) {
        const wantedYear = Number(datedTitle[2]);
        const sameYear = exact.find((game) => gameReleaseYear(game) === wantedYear);
        if (sameYear) return sameYear;
    }
    return exact.find((game) => game.verified) || exact[0];
}

async function searchSteamGridDb(fetchImpl, query, env) {
    const datedTitle = String(query || "").match(/^(.*?)\s*\(((?:18|19|20|21)\d{2})\)\s*$/);
    const searchTitle = datedTitle ? datedTitle[1].trim() : query;
    const url = new URL("https://www.steamgriddb.com/api/v2/search/autocomplete/"
        + encodeURIComponent(searchTitle));
    const body = await fetchJson(fetchImpl, url, steamGridDbRequest(env), "steamgriddb");
    const game = pickGame(body && body.data, query);
    return { game, exact: !!game };
}

function trustedSteamGridDbUrl(raw, kind) {
    try {
        const url = new URL(String(raw || ""));
        const allowedPath = kind === "thumb"
            ? /^\/(?:hero_thumb|thumb|file\/sgdb-cdn\/(?:hero_thumb|thumb))\//
            : /^\/(?:hero|file\/sgdb-cdn\/hero)\//;
        if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "cdn2.steamgriddb.com"
                || url.username || url.password || url.search || url.hash
                || !allowedPath.test(url.pathname)
                || !/\.(?:jpe?g|png|webp)$/i.test(url.pathname)) return "";
        return url.href;
    } catch (error) {
        return "";
    }
}

async function steamGridDbHero(fetchImpl, game, env) {
    if (!game) return null;
    const url = new URL("https://www.steamgriddb.com/api/v2/heroes/game/"
        + encodeURIComponent(game.id));
    url.searchParams.set("mimes", "image/jpeg,image/png,image/webp");
    url.searchParams.set("types", "static");
    url.searchParams.set("nsfw", "false");
    url.searchParams.set("humor", "false");
    url.searchParams.set("epilepsy", "false");
    const body = await fetchJson(fetchImpl, url, steamGridDbRequest(env), "steamgriddb");
    const candidates = Array.isArray(body && body.data) ? body.data.slice() : [];
    candidates.sort((a, b) => (Number(b && b.score) || 0) - (Number(a && a.score) || 0)
        || (Number(b && b.upvotes) || 0) - (Number(a && a.upvotes) || 0)
        || (Number(b && b.width) || 0) - (Number(a && a.width) || 0));
    for (const candidate of candidates) {
        const hero = trustedSteamGridDbUrl(candidate && candidate.url, "hero");
        if (!hero) continue;
        return {
            url: hero,
            preview: trustedSteamGridDbUrl(candidate && candidate.thumb, "thumb") || hero,
        };
    }
    return null;
}

async function tvdbIdForTmdbSeries(fetchImpl, seriesId, env) {
    const url = new URL("https://api.themoviedb.org/3/tv/"
        + encodeURIComponent(seriesId) + "/external_ids");
    const body = await fetchJson(fetchImpl, url, tmdbRequest(url, env), "tmdb");
    const id = Number(body && body.tvdb_id);
    return Number.isSafeInteger(id) && id > 0 ? String(id) : "";
}

function trustedFanartUrl(raw) {
    try {
        const url = new URL(String(raw || ""));
        const host = url.hostname.toLowerCase();
        if (url.protocol !== "https:" || url.username || url.password
                || (host !== "fanart.tv" && !host.endsWith(".fanart.tv"))) return "";
        return url.href;
    } catch (error) {
        return "";
    }
}

async function fanartBackdrop(fetchImpl, media, clientKey, env) {
    if (!env.FANART_API_KEY) return "";
    const type = mediaType(media);
    let fanartId = String(media && media.id || "");
    if (type === "tv") {
        try {
            fanartId = await tvdbIdForTmdbSeries(fetchImpl, media.id, env);
        } catch (error) {
            return "";
        }
    }
    if (!fanartId) return "";
    const url = new URL("https://webservice.fanart.tv/v3/"
        + (type === "tv" ? "tv/" : "movies/") + encodeURIComponent(fanartId));
    url.searchParams.set("api_key", env.FANART_API_KEY);
    if (clientKey) url.searchParams.set("client_key", clientKey);
    let body;
    try {
        body = await fetchJson(fetchImpl, url, { headers: { "Accept": "application/json" } }, "fanart");
    } catch (error) {
        // fanart.tv is an enhancement. Provider failure must still degrade to TMDB art.
        return "";
    }
    const backgroundKey = type === "tv" ? "showbackground" : "moviebackground";
    const candidates = Array.isArray(body && body[backgroundKey])
        ? body[backgroundKey].slice() : [];
    const isTextless = (candidate) => candidate && (candidate.lang === "" || candidate.lang === "00");
    candidates.sort((a, b) => (isTextless(a) ? 0 : 1) - (isTextless(b) ? 0 : 1)
        || (parseInt(b.likes, 10) || 0) - (parseInt(a.likes, 10) || 0));
    for (const candidate of candidates) {
        const trusted = trustedFanartUrl(candidate && candidate.url);
        if (trusted) return trusted;
    }
    return "";
}

function tmdbImageUrl(path, size) {
    if (typeof path !== "string" || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(path)) return "";
    return "https://image.tmdb.org/t/p/" + size + path;
}

function tintPreviewUrl(source, backdrop, tmdbPath) {
    if (source === "tmdb") return tmdbImageUrl(tmdbPath, "w92");
    if (source !== "fanart") return "";
    try {
        const url = new URL(backdrop);
        url.pathname = url.pathname.replace("/fanart/", "/preview/");
        return url.href;
    } catch (error) {
        return "";
    }
}

async function defaultTintForImage(fetchImpl, url) {
    if (!url) return [...WHITE_TINT];
    try {
        const response = await fetchImpl(url, {
            headers: { "Accept": "image/*", "User-Agent": "24sevenfm-covers-backdrop-resolver/1.0" },
            signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        });
        if (!response.ok) return [...WHITE_TINT];
        const declaredSize = Number(response.headers.get("content-length") || 0);
        if (declaredSize > MAX_TINT_IMAGE_BYTES) return [...WHITE_TINT];
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length || bytes.length > MAX_TINT_IMAGE_BYTES) return [...WHITE_TINT];
        // Load sharp lazily: unit tests inject the tint reader, while Vercel bundles
        // the native dependency only for the production function that needs it.
        const sharp = require("sharp");
        const stats = await sharp(bytes, { limitInputPixels: MAX_TINT_IMAGE_PIXELS })
            .toColourspace("srgb").stats();
        return tintFromMeans(stats.channels.slice(0, 3).map((channel) => channel.mean));
    } catch (error) {
        // Artwork is still useful when tint decoding fails; white is the safe UI fallback.
        return [...WHITE_TINT];
    }
}

function responseHeader(response, name) {
    return response && response.headers && typeof response.headers.get === "function"
        ? response.headers.get(name) : null;
}

async function limitedImageBytes(response) {
    const declaredSize = Number(responseHeader(response, "content-length") || 0);
    if (declaredSize > MAX_TINT_IMAGE_BYTES) {
        throw new ResolverError("image_too_large", 413, "image exceeds the byte limit");
    }
    if (!response.body || typeof response.body.getReader !== "function") {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length || bytes.length > MAX_TINT_IMAGE_BYTES) {
            throw new ResolverError(bytes.length ? "image_too_large" : "invalid_image", bytes.length ? 413 : 422);
        }
        return bytes;
    }

    const chunks = [];
    const reader = response.body.getReader();
    let total = 0;
    while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > MAX_TINT_IMAGE_BYTES) {
            await reader.cancel();
            throw new ResolverError("image_too_large", 413, "image exceeds the byte limit");
        }
        chunks.push(Buffer.from(part.value));
    }
    if (!total) throw new ResolverError("invalid_image", 422, "image is empty");
    return Buffer.concat(chunks, total);
}

async function defaultTintFromBytes(bytes) {
    try {
        const sharp = require("sharp");
        const stats = await sharp(bytes, { limitInputPixels: MAX_TINT_IMAGE_PIXELS })
            .toColourspace("srgb").stats();
        return tintFromMeans(stats.channels.slice(0, 3).map((channel) => channel.mean));
    } catch (error) {
        throw new ResolverError("invalid_image", 422, "image cannot be decoded safely");
    }
}

async function coverTintForUrl(rawUrl, dependencies) {
    let currentUrl = trustedCoverTintUrl(rawUrl, dependencies.env);
    if (!currentUrl) throw new ResolverError("invalid_image_url", 400, "image URL is not allowed");
    const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);

    for (let redirects = 0; redirects <= MAX_TINT_REDIRECTS; redirects++) {
        let response;
        try {
            response = await dependencies.fetchImpl(currentUrl, {
                headers: {
                    "Accept": "image/jpeg, image/png, image/webp",
                    "User-Agent": "24sevenfm-covers-tint-resolver/1.0",
                },
                redirect: "manual",
                signal,
            });
        } catch (error) {
            throw new ResolverError("image_unavailable", 502, "image request failed");
        }

        if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (redirects === MAX_TINT_REDIRECTS) {
                throw new ResolverError("image_unavailable", 502, "too many image redirects");
            }
            let redirected;
            try {
                redirected = new URL(responseHeader(response, "location") || "", currentUrl).href;
            } catch (error) {
                redirected = "";
            }
            currentUrl = trustedCoverTintUrl(redirected, dependencies.env);
            if (!currentUrl) {
                throw new ResolverError("image_redirect_not_allowed", 502, "image redirect is not allowed");
            }
            continue;
        }
        if (response.status === 429 || response.status >= 500) {
            throw new ResolverError("image_unavailable", 502, "image host is temporarily unavailable");
        }
        if (!response.ok) throw new ResolverError("image_response", 502, "image host rejected the request");

        const contentType = String(responseHeader(response, "content-type") || "")
            .split(";", 1)[0].trim().toLowerCase();
        if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(contentType)) {
            throw new ResolverError("invalid_image_type", 415, "response is not a supported image");
        }
        let bytes;
        try {
            bytes = await limitedImageBytes(response);
        } catch (error) {
            if (error instanceof ResolverError) throw error;
            throw new ResolverError("image_unavailable", 502, "image body could not be read");
        }
        return dependencies.tintFromBytes(bytes);
    }
    throw new ResolverError("image_unavailable", 502, "image could not be resolved");
}

function hasTmdbCredential(env) {
    return !!String(env.TMDB_READ_TOKEN || env.TMDB_API_TOKEN || env.TMDB_API_KEY || "").trim();
}

function hasSteamGridDbCredential(env) {
    return !!String(env.STEAMGRIDDB_API_KEY || "").trim();
}

async function screenArt(fetchImpl, media, providers, clientKey, env) {
    for (const provider of providers) {
        let url = "";
        if (provider === "fanart") {
            url = await fanartBackdrop(fetchImpl, media, clientKey, env);
        } else if (provider === "tmdb") {
            url = tmdbImageUrl(media.backdrop_path, "w1280");
        }
        if (url) {
            return {
                url,
                source: provider,
                preview: tintPreviewUrl(provider, url, media.backdrop_path),
            };
        }
    }
    return null;
}

function screenMediaResponse(media, query) {
    return media ? { id: media.id, title: mediaTitle(media) || query, type: mediaType(media) } : null;
}

function gameMediaResponse(game, query) {
    return game ? { id: Number(game.id), title: game.name || query, type: "game" } : null;
}

async function resolvedArtResponse(media, art, dependencies) {
    const tint = await dependencies.tintForImage(art.preview, dependencies.fetchImpl);
    return { media, backdrop: art.url, source: art.source, tint };
}

async function resolveBackdrop(query, providers, clientKey, dependencies, requestHint = "auto") {
    const hint = configuredMediaHint(query, requestHint, dependencies.env);
    const wantsScreen = providers.some((provider) => provider === "fanart" || provider === "tmdb");
    const wantsGame = providers.includes("steamgriddb");
    const screenAvailable = wantsScreen && hasTmdbCredential(dependencies.env);
    const gameAvailable = wantsGame && hasSteamGridDbCredential(dependencies.env);
    if (!screenAvailable && !gameAvailable) {
        throw new ResolverError("resolver_not_configured", 503,
            "no requested backdrop provider is configured");
    }

    let categories;
    if (hint === "game") {
        categories = gameAvailable ? ["game"] : [];
    } else if (hint === "screen" || hint === "movie" || hint === "tv") {
        categories = screenAvailable ? ["screen"] : [];
    } else {
        categories = [];
        if (screenAvailable) categories.push("screen");
        if (gameAvailable) categories.push("game");
        categories.sort((a, b) => {
            const rank = (category) => category === "game"
                ? providers.indexOf("steamgriddb")
                : Math.min(...providers.map((provider, index) =>
                    provider === "fanart" || provider === "tmdb" ? index : Infinity));
            return rank(a) - rank(b);
        });
    }
    if (!categories.length) {
        return { media: null, backdrop: null, source: null, tint: [...WHITE_TINT] };
    }

    const errors = [];
    let screenFallback = null;
    let matchedWithoutArt = null;
    for (const category of categories) {
        if (category === "screen") {
            let match;
            try {
                match = await searchTmdb(dependencies.fetchImpl, query, dependencies.env,
                    hint === "movie" || hint === "tv" ? hint : undefined);
            } catch (error) {
                errors.push(error);
                continue;
            }
            if (!match.media) continue;
            if (!match.exact) {
                screenFallback = match.media;
                continue;
            }
            const media = screenMediaResponse(match.media, query);
            const art = await screenArt(dependencies.fetchImpl, match.media, providers,
                clientKey, dependencies.env);
            if (art) return resolvedArtResponse(media, art, dependencies);
            matchedWithoutArt = matchedWithoutArt || media;
            break;
        } else {
            let match;
            try {
                match = await searchSteamGridDb(dependencies.fetchImpl, query, dependencies.env);
            } catch (error) {
                errors.push(error);
                continue;
            }
            if (!match.game) continue;
            const media = gameMediaResponse(match.game, query);
            const hero = await steamGridDbHero(dependencies.fetchImpl, match.game, dependencies.env);
            if (hero) {
                return resolvedArtResponse(media, {
                    url: hero.url, preview: hero.preview, source: "steamgriddb",
                }, dependencies);
            }
            matchedWithoutArt = matchedWithoutArt || media;
            break;
        }
    }

    if (screenFallback) {
        const media = screenMediaResponse(screenFallback, query);
        const art = await screenArt(dependencies.fetchImpl, screenFallback, providers,
            clientKey, dependencies.env);
        if (art) return resolvedArtResponse(media, art, dependencies);
        matchedWithoutArt = matchedWithoutArt || media;
    }
    if (!matchedWithoutArt && errors.length) throw errors[0];
    return {
        media: matchedWithoutArt,
        backdrop: null,
        source: null,
        tint: [...WHITE_TINT],
    };
}

function sendJson(res, status, body) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
}

function createHandler(options = {}) {
    const env = options.env || process.env;
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const tintForImage = options.tintForImage
        || ((url) => defaultTintForImage(fetchImpl, url));

    return async function backdropHandler(req, res) {
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
            const albumValue = queryValue(req.query && req.query.album);
            const trackValue = queryValue(req.query && req.query.track);
            const artistValue = queryValue(req.query && req.query.artist);
            const titleValue = typeof albumValue === "string"
                ? albumValue : queryValue(req.query && req.query.title);
            if (typeof titleValue !== "string" || !titleValue.trim() || titleValue.length > 180
                    || /[\u0000-\u001F\u007F]/.test(titleValue)) {
                throw new ResolverError("invalid_title", 400, "title is required and must be at most 180 characters");
            }
            if (trackValue !== undefined && (typeof trackValue !== "string" || trackValue.length > 300
                    || /[\u0000-\u001F\u007F]/.test(trackValue))) {
                throw new ResolverError("invalid_title", 400, "track must be at most 300 characters");
            }
            if (artistValue !== undefined && (typeof artistValue !== "string" || artistValue.length > 180
                    || /[\u0000-\u001F\u007F]/.test(artistValue))) {
                throw new ResolverError("invalid_artist", 400,
                    "artist must be at most 180 characters");
            }
            const title = backdropTitleFor(titleValue, trackValue);
            if (!title || title.length > 160) {
                throw new ResolverError("invalid_title", 400, "cleaned title is empty or too long");
            }
            const providers = requestedProviders(queryValue(req.query && req.query.providers));
            const requestedHint = requestedMediaHint(queryValue(req.query && req.query.media_hint));
            const mediaHint = requestedHint === "auto" ? mediaHintForAlbum(titleValue) : requestedHint;
            const rawClientKey = queryValue(req.query && req.query.client_key);
            const clientKey = typeof rawClientKey === "string" ? rawClientKey.trim() : "";
            if (clientKey.length > 128 || /[\u0000-\u001F\u007F]/.test(clientKey)) {
                throw new ResolverError("invalid_client_key", 400, "client_key is invalid");
            }
            const result = await resolveBackdrop(title, providers, clientKey, {
                env, fetchImpl, tintForImage,
            }, mediaHint, typeof artistValue === "string" ? artistValue.trim() : "");
            res.setHeader("Cache-Control", "public, max-age=0, s-maxage=" + CACHE_SECONDS
                + ", stale-while-revalidate=86400");
            return sendJson(res, 200, result);
        } catch (error) {
            const known = error instanceof ResolverError;
            res.setHeader("Cache-Control", "no-store");
            return sendJson(res, known ? error.status : 500, {
                error: known ? error.code : "internal_error",
            });
        }
    };
}

function createTintHandler(options = {}) {
    const env = options.env || process.env;
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const tintFromBytes = options.tintFromBytes || defaultTintFromBytes;

    return async function tintHandler(req, res) {
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
            const keys = Object.keys(query);
            if (keys.length !== 1 || keys[0] !== "url" || typeof query.url !== "string") {
                throw new ResolverError("invalid_image_url", 400, "exactly one image URL is required");
            }
            const tint = await coverTintForUrl(query.url, { env, fetchImpl, tintFromBytes });
            res.setHeader("Cache-Control", "public, max-age=0, s-maxage=" + CACHE_SECONDS
                + ", stale-while-revalidate=86400");
            return sendJson(res, 200, { tint });
        } catch (error) {
            const known = error instanceof ResolverError;
            res.setHeader("Cache-Control", "no-store");
            return sendJson(res, known ? error.status : 500, {
                error: known ? error.code : "internal_error",
            });
        }
    };
}

const handler = createHandler();
const tintHandler = createTintHandler();

module.exports = {
    CACHE_SECONDS,
    WHITE_TINT,
    backdropTitleFor,
    cleanMovieTitle,
    coverTintForUrl,
    createHandler,
    createTintHandler,
    handler,
    mediaHintForAlbum,
    pickGame,
    pickMedia,
    pickMovie,
    requestedProviders,
    requestedMediaHint,
    resolveBackdrop,
    tintFromMeans,
    tintPreviewUrl,
    tintHandler,
    trustedCoverTintUrl,
    trustedSteamGridDbUrl,
};
