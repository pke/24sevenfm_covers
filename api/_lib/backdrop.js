"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");

const CACHE_SECONDS = 60 * 60 * 24 * 30 * 6;
const MISS_CACHE_SECONDS = 15 * 60;
// A TV result may need TMDB search, external IDs, fanart, and a tint thumbnail in
// sequence. Keep each leg short enough that the common four-stage path remains
// inside the 20 s client deadline even when every upstream stalls.
const PROVIDER_TIMEOUT_MS = 3000;
const debugLogContext = new AsyncLocalStorage();
let debugRequestSequence = 0;
const MAX_TINT_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TINT_IMAGE_PIXELS = 4 * 1000 * 1000;
const MAX_TINT_URL_LENGTH = 512;
const MAX_TINT_REDIRECTS = 2;
const MAX_TRACK_PREFIX_CANDIDATES = 8;
const DEFAULT_ORIGIN = "https://24sevenfm-covers.dudesoft.app";
// Exact station metadata that resolves an otherwise ambiguous
// catalog title. Only the fields present on an entry participate in its match.
const METADATA_RESOLUTIONS = Object.freeze([
    Object.freeze({
        album: "Medal Of Honor",
        track: "Attack On Fort Schmerzen",
        hint: "game",
    }),
    Object.freeze({
        album: "Romantic Duets From MGM Classics",
        track: "Be My Love",
        title: "The Toast of New Orleans (1950)",
        hint: "movie",
    }),
    Object.freeze({
        album: "Buffy The Vampire Slayer: Once More, With Feeling",
        title: "Buffy the Vampire Slayer",
        hint: "tv",
    }),
    Object.freeze({
        album: "Simpsons, The: Songs In The Key Of Springfield",
        title: "The Simpsons",
        hint: "tv",
    }),
    Object.freeze({
        album: "Jazz Loves Disney 2: A Kind Of Magic",
        track: "Stay Awake",
        title: "Mary Poppins",
        hint: "movie",
    }),
    Object.freeze({
        album: "Doctor Who: The 50th Anniversary Collection",
        track: "The Caves Of Androzani (Alternative Suite) [From \"The Caves Of Androzani\"]",
        title: "Doctor Who (1963)",
        hint: "tv",
    }),
    Object.freeze({
        album: "Enderal",
        title: "Enderal: Forgotten Stories",
        hint: "game",
    }),
    Object.freeze({
        album: "Enola Gay",
        artist: "Maurice Jarre",
        title: "Enola Gay: The Men, the Mission, the Atomic Bomb",
        hint: "movie",
    }),
    Object.freeze({
        album: "Rambo: First Blood",
        title: "First Blood",
        hint: "movie",
    }),
]);
const DEFAULT_TINT_HOSTS = Object.freeze([
    "streamingsoundtracks.com",
    "1980s.fm",
    "adagio.fm",
    "death.fm",
    "entranced.fm",
]);
const COVER_TINT_PATH = /^\/images\/cover\/(?:040\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.(?:jpe?g|png|webp)$/i;

function cacheControl(browserSeconds, sharedSeconds = CACHE_SECONDS, staleSeconds = 86400) {
    return "public, max-age=" + browserSeconds + ", s-maxage=" + sharedSeconds
        + ", stale-while-revalidate=" + staleSeconds;
}
const WHITE_TINT = Object.freeze([255, 255, 255]);

function debugLoggingEnabled(env) {
    return /^(?:1|true|yes|on)$/i.test(String(env && env.BACKDROP_DEBUG_LOG || "").trim());
}

function debugRequestId() {
    debugRequestSequence = (debugRequestSequence + 1) % Number.MAX_SAFE_INTEGER;
    return process.pid + "-" + Date.now().toString(36) + "-" + debugRequestSequence.toString(36);
}

function safeDebugUrl(raw) {
    try {
        const url = new URL(String(raw));
        for (const key of ["api_key", "client_key"]) {
            if (url.searchParams.has(key)) url.searchParams.set(key, "[redacted]");
        }
        return url.href;
    } catch (error) {
        return "invalid-url";
    }
}

function debugLog(level, event, details = {}) {
    const context = debugLogContext.getStore() || {};
    if (!debugLoggingEnabled(context.env || process.env)) return;
    const entry = {
        timestamp: new Date().toISOString(),
        event,
        request_id: context.requestId || null,
        ...details,
    };
    const writer = level === "error" ? console.error
        : level === "warn" ? console.warn : console.log;
    writer("[backdrop] " + JSON.stringify(entry));
}

function debugRequestQuery(req) {
    const query = req && req.query && typeof req.query === "object" ? req.query : {};
    const result = {};
    for (const key of ["resolver_version", "album", "track", "title", "artist", "providers",
        "ratings", "media_hint", "art"]) {
        const value = query[key];
        if (typeof value === "string") result[key] = value.slice(0, 300);
        else if (Array.isArray(value)) result[key] = value.map((part) => String(part).slice(0, 300));
    }
    return result;
}
const FSK_LOGOS = Object.freeze({
    "0": "https://upload.wikimedia.org/wikipedia/commons/1/17/FSK_0.svg",
    "6": "https://upload.wikimedia.org/wikipedia/commons/b/b0/FSK_ab_6_logo.svg",
    "12": "https://upload.wikimedia.org/wikipedia/commons/6/6e/FSK_12.svg",
    "16": "https://upload.wikimedia.org/wikipedia/commons/3/30/FSK_16.svg",
    "18": "https://upload.wikimedia.org/wikipedia/commons/5/5d/FSK_18.svg",
});
const MPA_LOGOS = Object.freeze({
    "G": "https://upload.wikimedia.org/wikipedia/commons/4/4f/MPA_G_RATING.svg",
    "PG": "https://upload.wikimedia.org/wikipedia/commons/9/9a/MPA_PG_RATING.svg",
    "PG-13": "https://upload.wikimedia.org/wikipedia/commons/9/98/MPA_PG-13_RATING.svg",
    "R": "https://upload.wikimedia.org/wikipedia/commons/6/6b/MPA_R_RATING.svg",
    "NC-17": "https://upload.wikimedia.org/wikipedia/commons/c/c0/MPA_NC-17_RATING.svg",
});
const TV_PARENTAL_GUIDELINES_LOGOS = Object.freeze({
    "TV-Y": "https://upload.wikimedia.org/wikipedia/commons/2/25/TV-Y_icon.svg",
    "TV-Y7": "https://upload.wikimedia.org/wikipedia/commons/5/5a/TV-Y7_icon.svg",
    "TV-Y7-FV": "https://upload.wikimedia.org/wikipedia/commons/a/ac/TV-Y7-FV_icon.svg",
    "TV-G": "https://upload.wikimedia.org/wikipedia/commons/5/5e/TV-G_icon.svg",
    "TV-PG": "https://upload.wikimedia.org/wikipedia/commons/9/9a/TV-PG_icon.svg",
    "TV-14": "https://upload.wikimedia.org/wikipedia/commons/c/c3/TV-14_icon.svg",
    "TV-MA": "https://upload.wikimedia.org/wikipedia/commons/3/34/TV-MA_icon.svg",
});
const TV_CONTENT_DESCRIPTORS = Object.freeze({
    "TV-Y7": Object.freeze(["FV"]),
    "TV-Y7-FV": Object.freeze(["FV"]),
    "TV-PG": Object.freeze(["D", "L", "S", "V"]),
    "TV-14": Object.freeze(["D", "L", "S", "V"]),
    "TV-MA": Object.freeze(["L", "S", "V"]),
});

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
        .replace(/\(\s*(?:video[\s-]*)?game\s*\)/gi, " ")
        .replace(/\[\s*[^\]\r\n]{0,64}\bedition\s*\]/gi, " ")
        .replace(/\(\s*vol(?:ume)?\.?\s+(?:\d{1,3}|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\s*\)/gi, " ")
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

function tvSeasonIdentity(album) {
    const cleaned = cleanMovieTitle(album);
    const match = cleaned.match(
        /^(.+?)\s*[:\-–—]\s*(series|season|staffel)\s+([0-9]{1,2})\s*$/i);
    if (!match) return null;
    const title = cleanMovieTitle(match[1]);
    if (!title) return null;
    return { title, season: Number(match[3]) };
}

function tvBookSoundtrackIdentity(album) {
    const match = String(album || "").match(
        /^(.+?)\s*:\s*original\s+music\s+from\s+book\s+([0-9]{1,2}|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\s*$/i);
    if (!match) return null;
    const title = cleanMovieTitle(match[1]);
    if (!title) return null;
    return { title, book: match[2] };
}

function starTrekSeriesAlias(album) {
    const match = cleanMovieTitle(album).match(
        /^star trek\s*[,\-–—:]\s*(tos|tng|ds9|voy|ent|pic|snw|dis|dsc)\b/i);
    if (!match) return null;
    const aliases = {
        TOS: "Star Trek",
        TNG: "Star Trek: The Next Generation",
        DS9: "Star Trek: Deep Space Nine",
        VOY: "Star Trek: Voyager",
        ENT: "Star Trek: Enterprise",
        PIC: "Star Trek: Picard",
        SNW: "Star Trek: Strange New Worlds",
        DIS: "Star Trek: Discovery",
        DSC: "Star Trek: Discovery",
    };
    return aliases[match[1].toUpperCase()] || null;
}

function isTrackPrefixedMovieCompilation(title) {
    return /^the wings of a film$/i.test(title)
        || /^music for a darkened theatre,\s*vol\.\s*[12]$/i.test(title);
}

function isTrackTitledGameCompilation(title) {
    return /^video games live(?:\s*:\s*level\s*\d+)?$/i.test(title);
}

function isTrackTitledTvCompilation(title) {
    return /^great british tv themes$/i.test(title)
        || /^television['’]s\s+greatest\s+hits\b/i.test(title);
}

function isExactTrackTitledScreenCompilation(title) {
    return /^every note paints a picture$/i.test(title)
        || /^film music \(isham\)$/i.test(title)
        || /^sci[\s-]*fi['’]s\s+greatest\s+hits\b/i.test(title);
}

function isTrackTitledScreenCompilation(title) {
    // Compilation titles commonly advertise "Themes From ..." or end in "Music
    // For Film", while each Track carries "Work - Cue". The prefix still has to
    // be an exact TMDB title, so these markers cannot turn an arbitrary cue
    // containing a dash into a fuzzy match. Some named screen-score anthology
    // series have no generic compilation marker; their tracks likewise carry the
    // work title and use the same strict provider match.
    return /\bthemes?\s+from\b/i.test(title)
        || /\bmusic\s+for\s+films?\s*$/i.test(title)
        || isExactTrackTitledScreenCompilation(title);
}

function usesExactTrackPrefix(title) {
    return isTrackTitledTvCompilation(title) || isTrackTitledScreenCompilation(title);
}

function quotedFromScreenTitle(track) {
    const match = String(track || "").trim().match(
        /\(\s*from\s+(?:"([^"]+)"|“([^”]+)”)\s*\)\s*$/i);
    const title = match && cleanMovieTitle(match[1] || match[2]);
    return title || "";
}

function metadataResolutionFor(album, track, artist) {
    const values = { album, track, artist };
    return METADATA_RESOLUTIONS.find((entry) =>
        ["album", "track", "artist"].every((field) => !entry[field]
            || normalizedTitle(entry[field]) === normalizedTitle(values[field]))) || null;
}

function trackPrefixCandidates(track) {
    const title = String(track || "").trim();
    if (!title) return [];

    // Some station metadata drops the spaced dash used by the compilation's
    // printed track list. Preserve the cheap unambiguous case, then fall back to
    // progressively shorter prefixes so the provider can validate the boundary.
    const separated = title.match(/^(.+?)\s+[-–—]\s+.+$/);
    if (separated) {
        const workTitle = cleanMovieTitle(separated[1]);
        return workTitle ? [workTitle] : [];
    }

    const words = title.match(/\S+/g) || [];
    const candidates = [];
    const seen = new Set();
    for (let end = words.length; end > 0 && candidates.length < MAX_TRACK_PREFIX_CANDIDATES; end--) {
        const candidate = cleanMovieTitle(words.slice(0, end).join(" "));
        const key = normalizedTitle(candidate);
        // Retain a very short title only when it is the complete track (for
        // example UFO); inferring a cue's work from a short prefix is unsafe.
        if (!key || (end < words.length && key.length < 4) || seen.has(key)) continue;
        seen.add(key);
        candidates.push(candidate);
    }
    return candidates;
}

function backdropTitleFor(album, track) {
    const normalizedAlbum = cleanMovieTitle(album);
    const seriesAlias = starTrekSeriesAlias(normalizedAlbum);
    if (seriesAlias) return seriesAlias;
    const seasonIdentity = tvSeasonIdentity(normalizedAlbum);
    if (seasonIdentity) return seasonIdentity.title;
    const bookIdentity = tvBookSoundtrackIdentity(album);
    if (bookIdentity) return bookIdentity.title;
    const quotedFromTitle = quotedFromScreenTitle(track);
    if (quotedFromTitle) return quotedFromTitle;
    if (isExactTrackTitledScreenCompilation(normalizedAlbum)) {
        const workTitle = cleanMovieTitle(track);
        if (workTitle) return workTitle;
    }
    if (usesExactTrackPrefix(normalizedAlbum)) {
        const candidates = trackPrefixCandidates(track);
        if (candidates.length) return candidates[0];
    }
    if (isTrackTitledGameCompilation(normalizedAlbum)) {
        const workTitle = cleanMovieTitle(track)
            .replace(/\s+(?:symphonic\s+)?suite\s*$/i, "").trim();
        if (workTitle) return workTitle;
    }
    if (isTrackPrefixedMovieCompilation(normalizedAlbum)) {
        const separator = String(track || "").indexOf(":");
        if (separator > 0) {
            const workTitle = cleanMovieTitle(String(track).slice(0, separator));
            if (workTitle) return workTitle;
        }
    }
    return normalizedAlbum;
}

function backdropTitleCandidatesFor(album, track) {
    const normalizedAlbum = cleanMovieTitle(album);
    const quotedFromTitle = quotedFromScreenTitle(track);
    if (quotedFromTitle) return [quotedFromTitle];
    if (isExactTrackTitledScreenCompilation(normalizedAlbum)) {
        const workTitle = cleanMovieTitle(track);
        if (workTitle) return [workTitle];
    }
    if (usesExactTrackPrefix(normalizedAlbum)) {
        const candidates = trackPrefixCandidates(track);
        if (candidates.length) return candidates;
    }
    return [backdropTitleFor(album, track)];
}

function mediaHintForAlbum(album) {
    const title = String(album || "");
    const cleanedTitle = cleanMovieTitle(title);
    if (/\(\s*(?:video[\s-]*)?game\s*\)/i.test(title)) return "game";
    if (starTrekSeriesAlias(cleanedTitle)) return "tv";
    if (tvSeasonIdentity(cleanedTitle)) return "tv";
    if (tvBookSoundtrackIdentity(title)) return "tv";
    if (/\banimated\s+(?:television\s+)?series\b/i.test(cleanedTitle)) return "tv";
    if (isTrackTitledTvCompilation(cleanedTitle)) return "tv";
    if (isTrackTitledScreenCompilation(cleanedTitle)) return "screen";
    if (isTrackTitledGameCompilation(cleanedTitle)) return "game";
    if (isTrackPrefixedMovieCompilation(cleanedTitle)) return "movie";
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
        .replace(/&/g, " and ")
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

function pickExactPerson(results, artist) {
    const wanted = normalizedTitle(artist);
    if (!wanted) return null;
    const matches = new Map();
    for (const person of Array.isArray(results) ? results : []) {
        const id = Number(person && person.id);
        if (!Number.isSafeInteger(id) || id <= 0
                || normalizedTitle(person && person.name) !== wanted) continue;
        if (!matches.has(id)) matches.set(id, person);
    }
    return matches.size === 1 ? matches.values().next().value : null;
}

function titleWords(value) {
    return String(value || "").normalize("NFKD").replace(/\p{M}/gu, "")
        .toLowerCase().match(/[a-z0-9]+/g) || [];
}

function containsWordSequence(words, sequence) {
    if (!sequence.length || sequence.length > words.length) return false;
    for (let start = 0; start <= words.length - sequence.length; start++) {
        if (sequence.every((word, index) => words[start + index] === word)) return true;
    }
    return false;
}

function pickComposerCredit(combinedCredits, album) {
    const albumWords = titleWords(album);
    const matches = new Map();
    for (const credit of Array.isArray(combinedCredits && combinedCredits.crew)
        ? combinedCredits.crew : []) {
        const id = Number(credit && credit.id);
        if (!credit || credit.job !== "Original Music Composer"
                || (credit.media_type !== "movie" && credit.media_type !== "tv")
                || !Number.isSafeInteger(id) || id <= 0) continue;
        const title = mediaTitle(credit);
        const words = titleWords(title);
        // Reject tiny one-word titles such as Up, It, Her, or Us. Even with a verified
        // composer they are too weak to infer safely from a soundtrack-album phrase.
        if (normalizedTitle(title).length < 4 || !containsWordSequence(albumWords, words)) continue;
        const key = credit.media_type + ":" + id;
        if (!matches.has(key)) matches.set(key, credit);
    }
    return matches.size === 1 ? matches.values().next().value : null;
}

function pickMediaMatch(results, query, wantedType) {
    const wanted = normalizedTitle(query);
    let exact = null;
    const exactMatches = [];
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
        if (titles.some((title) => normalizedTitle(title) === wanted)) {
            if (!exact) exact = media;
            if (!exactMatches.some((candidate) => candidate.id === media.id
                    && mediaType(candidate) === mediaType(media))) exactMatches.push(media);
        }
        if (!withBackdrop && media.backdrop_path) withBackdrop = media;
    }
    return { media: exact || withBackdrop || first || null, exact: !!exact, exactMatches };
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

function requestQueryValue(req, name) {
    const query = req && req.query && typeof req.query === "object" ? req.query : {};
    const fallback = queryValue(query[name]);
    // Some server adapters expose form-encoded spaces as plus signs after discarding the raw query.
    const decodedFallback = typeof fallback === "string" ? fallback.replace(/\+/g, " ") : fallback;
    if (!req || typeof req.url !== "string" || !req.url.includes("?")) return decodedFallback;
    try {
        const params = new URL(req.url, "http://localhost").searchParams;
        return params.has(name) ? params.get(name) : decodedFallback;
    } catch (error) {
        return decodedFallback;
    }
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

function requestedRatings(value) {
    if (value === undefined || value === null || value === "") return [];
    if (typeof value !== "string") {
        throw new ResolverError("invalid_ratings", 400, "ratings must contain DE and/or US");
    }
    const countries = value.split(",").map((entry) => entry.trim().toUpperCase());
    if (!countries.length || countries.some((entry) => !["DE", "US"].includes(entry))) {
        throw new ResolverError("invalid_ratings", 400, "ratings must contain DE and/or US");
    }
    return [...new Set(countries)];
}

function requestedArt(value) {
    if (value === undefined || value === null || value === "" || value === "1") return true;
    if (value === "0") return false;
    throw new ResolverError("invalid_art", 400, "art must be 0 or 1");
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
    const startedAt = Date.now();
    const loggedUrl = safeDebugUrl(url);
    debugLog("info", "provider.request", { provider, url: loggedUrl });
    let response;
    try {
        response = await fetchImpl(url, {
            ...init,
            signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        });
    } catch (error) {
        debugLog("warn", "provider.failure", {
            provider,
            url: loggedUrl,
            duration_ms: Date.now() - startedAt,
            error_name: error && error.name || "Error",
            error_message: error && error.message || "request failed",
        });
        throw new ResolverError(provider + "_unavailable", 502, provider + " request failed");
    }
    debugLog("info", "provider.response", {
        provider,
        url: loggedUrl,
        status: response.status,
        duration_ms: Date.now() - startedAt,
    });
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
        debugLog("warn", "provider.invalid_json", {
            provider,
            url: loggedUrl,
            status: response.status,
            duration_ms: Date.now() - startedAt,
        });
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

async function searchTmdbPerson(fetchImpl, artist, env) {
    const url = new URL("https://api.themoviedb.org/3/search/person");
    url.searchParams.set("include_adult", "false");
    url.searchParams.set("query", artist);
    const body = await fetchJson(fetchImpl, url, tmdbRequest(url, env), "tmdb");
    return pickExactPerson(body && body.results, artist);
}

async function composerCreditForAlbum(fetchImpl, person, album, env) {
    if (!person) return null;
    const url = new URL("https://api.themoviedb.org/3/person/"
        + encodeURIComponent(person.id) + "/combined_credits");
    const body = await fetchJson(fetchImpl, url, tmdbRequest(url, env), "tmdb");
    return pickComposerCredit(body, album);
}

async function screenComposerIds(fetchImpl, media, env) {
    const type = mediaType(media);
    const url = new URL("https://api.themoviedb.org/3/" + type + "/"
        + encodeURIComponent(media.id) + (type === "tv" ? "/aggregate_credits" : "/credits"));
    const body = await fetchJson(fetchImpl, url, tmdbRequest(url, env), "tmdb");
    return new Set((Array.isArray(body && body.crew) ? body.crew : [])
        .filter((credit) => credit && (credit.job === "Original Music Composer"
            || (Array.isArray(credit.jobs) && credit.jobs.some((job) =>
                job && job.job === "Original Music Composer"))))
        .map((credit) => Number(credit.id))
        .filter((id) => Number.isSafeInteger(id) && id > 0));
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

function normalizedTitleWords(title) {
    return String(title || "")
        .normalize("NFKD").replace(/\p{M}/gu, "")
        .toLowerCase().match(/[a-z0-9]+/g) || [];
}

function pickGame(results, query, options = {}) {
    const datedTitle = String(query || "").match(/^(.*?)\s*\(((?:18|19|20|21)\d{2})\)\s*$/);
    const searchTitle = datedTitle ? datedTitle[1].trim() : query;
    const wanted = normalizedTitle(searchTitle);
    const valid = (Array.isArray(results) ? results : []).filter((game) => game
        && Number.isSafeInteger(Number(game.id)) && Number(game.id) > 0
        && normalizedTitle(game.name));
    const exact = valid.filter((game) => normalizedTitle(game.name) === wanted);
    if (datedTitle) {
        const wantedYear = Number(datedTitle[2]);
        const sameYear = exact.find((game) => gameReleaseYear(game) === wantedYear);
        if (sameYear) return sameYear;
    }
    if (exact.length) return exact.find((game) => game.verified) || exact[0];

    // Compilation track lists sometimes use a franchise shorthand while SGDB
    // stores the first game under a subtitle (for example "Phoenix Wright" vs.
    // "Phoenix Wright: Ace Attorney"). Only allow this for an explicitly
    // track-titled game compilation, require at least two whole leading words,
    // and choose the shortest verified extension as the representative game.
    if (!options.allowPrefix) return null;
    const wantedWords = normalizedTitleWords(searchTitle);
    if (wantedWords.length < 2) return null;
    const prefixed = valid.filter((game) => {
        const words = normalizedTitleWords(game.name);
        return words.length > wantedWords.length
            && wantedWords.every((word, index) => words[index] === word);
    });
    prefixed.sort((left, right) => Number(!!right.verified) - Number(!!left.verified)
        || normalizedTitleWords(left.name).length - normalizedTitleWords(right.name).length
        || normalizedTitle(left.name).length - normalizedTitle(right.name).length);
    return prefixed[0] || null;
}

async function searchSteamGridDb(fetchImpl, query, env, options = {}) {
    const datedTitle = String(query || "").match(/^(.*?)\s*\(((?:18|19|20|21)\d{2})\)\s*$/);
    const searchTitle = datedTitle ? datedTitle[1].trim() : query;
    const url = new URL("https://www.steamgriddb.com/api/v2/search/autocomplete/"
        + encodeURIComponent(searchTitle));
    const body = await fetchJson(fetchImpl, url, steamGridDbRequest(env), "steamgriddb");
    const game = pickGame(body && body.data, query, options);
    return { game, exact: !!game };
}

function baseGameTitle(query) {
    const undated = String(query || "").replace(
        /\s*\((?:18|19|20|21)\d{2}\)\s*$/, "").trim();
    const separator = undated.indexOf(":");
    if (separator < 0) return "";
    const base = undated.slice(0, separator).trim();
    return normalizedTitle(base).length >= 4 ? base : "";
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

async function steamGridDbBaseGameHero(fetchImpl, query, exactGame, env) {
    const baseTitle = baseGameTitle(query);
    if (!baseTitle) return null;
    const baseMatch = await searchSteamGridDb(fetchImpl, baseTitle, env);
    if (!baseMatch.game || Number(baseMatch.game.id) === Number(exactGame && exactGame.id)) {
        return null;
    }
    return steamGridDbHero(fetchImpl, baseMatch.game, env);
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
    const startedAt = Date.now();
    const loggedUrl = safeDebugUrl(url);
    debugLog("info", "tint.request", { url: loggedUrl });
    try {
        const response = await fetchImpl(url, {
            headers: { "Accept": "image/*", "User-Agent": "24sevenfm-covers-backdrop-resolver/1.0" },
            signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        });
        debugLog("info", "tint.response", {
            url: loggedUrl,
            status: response.status,
            duration_ms: Date.now() - startedAt,
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
        debugLog("info", "tint.decoded", {
            url: loggedUrl,
            bytes: bytes.length,
            duration_ms: Date.now() - startedAt,
        });
        return tintFromMeans(stats.channels.slice(0, 3).map((channel) => channel.mean));
    } catch (error) {
        debugLog("warn", "tint.failure", {
            url: loggedUrl,
            duration_ms: Date.now() - startedAt,
            error_name: error && error.name || "Error",
            error_message: error && error.message || "request failed",
        });
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

function cleanCertification(raw, country) {
    const value = String(raw || "").trim();
    if (!value || value.length > 32 || /[\u0000-\u001F\u007F]/.test(value)) return "";
    if (country !== "DE") return value;
    const match = value.match(/(?:^|\D)(0|6|12|16|18)(?:\D|$)/);
    return match ? match[1] : "";
}

function movieCertification(countryResult, country) {
    const rank = new Map([[3, 0], [2, 1], [1, 2], [4, 3], [5, 4], [6, 5]]);
    return (Array.isArray(countryResult && countryResult.release_dates)
        ? countryResult.release_dates : [])
        .map((release, index) => ({
            rating: cleanCertification(release && release.certification, country),
            rank: rank.has(Number(release && release.type))
                ? rank.get(Number(release.type)) : 99,
            index,
        }))
        .filter((release) => release.rating)
        .sort((a, b) => a.rank - b.rank || a.index - b.index)[0]?.rating || "";
}

function cleanTvContentDescriptors(raw, rating) {
    const allowed = TV_CONTENT_DESCRIPTORS[rating] || [];
    if (!allowed.length) return [];
    const supplied = new Set((Array.isArray(raw) ? raw : [])
        .filter((value) => typeof value === "string")
        .map((value) => value.trim().toUpperCase()));
    // TV-Y7-FV carries FV in the rating itself, even when TMDB's optional
    // descriptors array is empty.
    if (rating === "TV-Y7-FV") supplied.add("FV");
    return allowed.filter((descriptor) => supplied.has(descriptor));
}

function certificationResponse(country, rating, type, descriptors) {
    if (!rating) return null;
    if (country === "DE") {
        return {
            country,
            system: "FSK",
            rating,
            label: "FSK " + rating,
            logo: FSK_LOGOS[rating] || null,
        };
    }
    const response = {
        country,
        system: type === "tv" ? "TV Parental Guidelines" : "MPA",
        rating,
        label: rating,
    };
    response.logo = type === "tv"
        ? TV_PARENTAL_GUIDELINES_LOGOS[rating] || null
        : MPA_LOGOS[rating] || null;
    if (type === "tv") response.descriptors = cleanTvContentDescriptors(descriptors, rating);
    return response;
}

async function screenCertifications(fetchImpl, media, countries, env) {
    if (!countries.length) return [];
    const type = mediaType(media);
    const url = new URL("https://api.themoviedb.org/3/" + type + "/"
        + encodeURIComponent(media.id) + (type === "tv" ? "/content_ratings" : "/release_dates"));
    const body = await fetchJson(fetchImpl, url, tmdbRequest(url, env), "tmdb");
    const results = Array.isArray(body && body.results) ? body.results : [];
    return countries.map((country) => {
        const countryResult = results.find((entry) => entry && entry.iso_3166_1 === country);
        const raw = type === "tv" ? countryResult && countryResult.rating
            : movieCertification(countryResult, country);
        return certificationResponse(country, cleanCertification(raw, country), type,
            type === "tv" && countryResult && countryResult.descriptors);
    }).filter(Boolean);
}

function screenMediaResponse(media, query) {
    return media ? { id: media.id, title: mediaTitle(media) || query, type: mediaType(media) } : null;
}

function gameMediaResponse(game, query) {
    return game ? { id: Number(game.id), title: game.name || query, type: "game" } : null;
}

function withCertifications(response, certifications, ratingCountries) {
    if (ratingCountries.length) response.certifications = certifications;
    return response;
}

async function resolvedArtResponse(media, art, dependencies,
    certificationsPromise = Promise.resolve([]), ratingCountries = []) {
    const [tint, certifications] = await Promise.all([
        dependencies.tintForImage(art.preview, dependencies.fetchImpl),
        certificationsPromise,
    ]);
    return withCertifications({ media, backdrop: art.url, source: art.source, tint },
        certifications, ratingCountries);
}

async function resolveBackdrop(query, providers, clientKey, dependencies, requestHint = "auto",
    artist = "", options = {}) {
    const ratingCountries = Array.isArray(options.ratingCountries) ? options.ratingCountries : [];
    const includeArt = options.includeArt !== false;
    const screenQueries = Array.isArray(options.screenQueries) && options.screenQueries.length
        ? options.screenQueries : [query];
    const requireExactScreenMatch = options.requireExactScreenMatch === true;
    const hint = configuredMediaHint(query, requestHint, dependencies.env);
    const wantsScreen = ratingCountries.length > 0 || (includeArt
        && providers.some((provider) => provider === "fanart" || provider === "tmdb"));
    const wantsGame = includeArt && providers.includes("steamgriddb");
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
        return withCertifications(
            { media: null, backdrop: null, source: null, tint: [...WHITE_TINT] },
            [], ratingCountries);
    }

    const errors = [];
    let screenFallback = null;
    let matchedWithoutArt = null;
    let matchedCertifications = [];
    for (const category of categories) {
        if (category === "screen") {
            // Start the exact person lookup beside the normal title lookup so the
            // conservative fallback does not add another full provider timeout. Its
            // result is consumed when multiple movie/TV works have the same exact
            // title. A non-exact credit fallback remains disabled for compilation
            // prefixes that explicitly require an exact provider title.
            const personLookup = artist
                ? searchTmdbPerson(dependencies.fetchImpl, artist,
                dependencies.env).then((person) => ({ person }), (error) => ({ error })) : null;
            let match = null;
            let fallbackMatch = null;
            let matchedQuery = query;
            let successfulTitleLookup = false;
            let rejectedComposerMismatch = false;
            const titleErrors = [];
            const titleLookups = await Promise.all(screenQueries.map(async (candidate) => {
                try {
                    return { candidate, match: await searchTmdb(dependencies.fetchImpl, candidate,
                        dependencies.env, hint === "movie" || hint === "tv" ? hint : undefined) };
                } catch (error) {
                    return { candidate, error };
                }
            }));
            for (const lookup of titleLookups) {
                if (lookup.error) {
                    titleErrors.push(lookup.error);
                    continue;
                }
                successfulTitleLookup = true;
                if (lookup.match && lookup.match.exact) {
                    match = lookup.match;
                    matchedQuery = lookup.candidate;
                    break;
                }
                if (!fallbackMatch && lookup.match && lookup.match.media) {
                    fallbackMatch = lookup.match;
                    matchedQuery = lookup.candidate;
                }
            }
            if (!match && !requireExactScreenMatch) match = fallbackMatch;
            if (match && match.exact && personLookup && match.exactMatches.length > 1) {
                const personResult = await personLookup;
                if (personResult.error) {
                    errors.push(personResult.error);
                } else if (personResult.person) {
                    try {
                        const credit = await composerCreditForAlbum(dependencies.fetchImpl,
                            personResult.person, query, dependencies.env);
                        const creditedMatch = credit && match.exactMatches.find((candidate) =>
                            Number(candidate.id) === Number(credit.id)
                            && mediaType(candidate) === mediaType(credit));
                        if (creditedMatch) match = { ...match, media: creditedMatch };
                    } catch (error) {
                        errors.push(error);
                    }
                }
            }
            if (match && match.exact && personLookup && options.validateExactComposer === true) {
                const personResult = await personLookup;
                if (personResult.error) {
                    errors.push(personResult.error);
                } else if (personResult.person
                        && personResult.person.known_for_department === "Sound") {
                    try {
                        const composerIds = await screenComposerIds(dependencies.fetchImpl,
                            match.media, dependencies.env);
                        if (composerIds.size && !composerIds.has(Number(personResult.person.id))) {
                            match = null;
                            rejectedComposerMismatch = true;
                        }
                    } catch (error) {
                        // Missing credits are not negative evidence. Keep the exact
                        // title match when TMDB cannot complete this refinement.
                        errors.push(error);
                    }
                }
            }
            if ((!match || !match.exact) && personLookup && !requireExactScreenMatch
                    && !rejectedComposerMismatch) {
                const personResult = await personLookup;
                if (personResult.error) {
                    errors.push(personResult.error);
                } else if (personResult.person) {
                    try {
                        const credit = await composerCreditForAlbum(dependencies.fetchImpl,
                            personResult.person, query, dependencies.env);
                        if (credit) match = { media: credit, exact: true };
                    } catch (error) {
                        errors.push(error);
                    }
                }
            }
            if (!match || !match.media) {
                if (!successfulTitleLookup) errors.push(...titleErrors);
                continue;
            }
            if (!match.exact) {
                screenFallback = match.media;
                continue;
            }
            const media = screenMediaResponse(match.media, matchedQuery);
            const certifications = ratingCountries.length
                ? screenCertifications(dependencies.fetchImpl, match.media, ratingCountries,
                    dependencies.env).catch(() => [])
                : Promise.resolve([]);
            const art = includeArt ? await screenArt(dependencies.fetchImpl, match.media, providers,
                clientKey, dependencies.env) : null;
            if (art) return resolvedArtResponse(media, art, dependencies,
                certifications, ratingCountries);
            matchedWithoutArt = matchedWithoutArt || media;
            matchedCertifications = await certifications;
            break;
        } else {
            let match;
            try {
                match = await searchSteamGridDb(dependencies.fetchImpl, query, dependencies.env, {
                    allowPrefix: options.allowGameTitleExtension === true,
                });
            } catch (error) {
                errors.push(error);
                continue;
            }
            if (!match.game) continue;
            const media = gameMediaResponse(match.game, query);
            let hero = await steamGridDbHero(dependencies.fetchImpl, match.game, dependencies.env);
            if (!hero) {
                try {
                    // SteamGridDB sometimes has a verified expansion entry but stores
                    // its hero art only on the exact base-game entry. Restrict this
                    // fallback to explicit "Base game: Subtitle" titles and require
                    // another exact provider match before borrowing that artwork.
                    hero = await steamGridDbBaseGameHero(dependencies.fetchImpl,
                        query, match.game, dependencies.env);
                } catch (error) {
                    errors.push(error);
                }
            }
            if (hero) {
                return resolvedArtResponse(media, {
                    url: hero.url, preview: hero.preview, source: "steamgriddb",
                }, dependencies, Promise.resolve([]), ratingCountries);
            }
            matchedWithoutArt = matchedWithoutArt || media;
            break;
        }
    }

    if (screenFallback) {
        const media = screenMediaResponse(screenFallback, query);
        const certifications = ratingCountries.length
            ? screenCertifications(dependencies.fetchImpl, screenFallback, ratingCountries,
                dependencies.env).catch(() => [])
            : Promise.resolve([]);
        const art = includeArt ? await screenArt(dependencies.fetchImpl, screenFallback, providers,
            clientKey, dependencies.env) : null;
        if (art) return resolvedArtResponse(media, art, dependencies,
            certifications, ratingCountries);
        matchedWithoutArt = matchedWithoutArt || media;
        matchedCertifications = await certifications;
    }
    if (!matchedWithoutArt && errors.length) throw errors[0];
    return withCertifications({
        media: matchedWithoutArt,
        backdrop: null,
        source: null,
        tint: [...WHITE_TINT],
    }, matchedCertifications, ratingCountries);
}

function sendJson(res, status, body) {
    debugLog("info", "response.body", { status, body });
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
}

function createHandler(options = {}) {
    const env = options.env || process.env;
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const tintForImage = options.tintForImage
        || ((url) => defaultTintForImage(fetchImpl, url));

    async function handleBackdropRequest(req, res) {
        const startedAt = Date.now();
        let responseFinished = false;
        debugLog("info", "request.start", {
            method: req && req.method,
            query: debugRequestQuery(req),
        });
        if (res && typeof res.once === "function") {
            res.once("finish", () => {
                responseFinished = true;
                debugLog("info", "request.finish", {
                    status: res.statusCode,
                    duration_ms: Date.now() - startedAt,
                });
            });
            res.once("close", () => {
                if (!responseFinished) {
                    debugLog("warn", "request.closed", {
                        status: res.statusCode,
                        duration_ms: Date.now() - startedAt,
                    });
                }
            });
        }
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
            const albumValue = requestQueryValue(req, "album");
            const trackValue = requestQueryValue(req, "track");
            const artistValue = requestQueryValue(req, "artist");
            const titleValue = typeof albumValue === "string"
                ? albumValue : requestQueryValue(req, "title");
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
            const metadataResolution = metadataResolutionFor(titleValue, trackValue, artistValue);
            const titleCandidates = metadataResolution && metadataResolution.title
                ? [metadataResolution.title]
                : backdropTitleCandidatesFor(titleValue, trackValue);
            const title = titleCandidates[0];
            if (!title || title.length > 160) {
                throw new ResolverError("invalid_title", 400, "cleaned title is empty or too long");
            }
            const providers = requestedProviders(requestQueryValue(req, "providers"));
            const ratingCountries = requestedRatings(requestQueryValue(req, "ratings"));
            const includeArt = requestedArt(requestQueryValue(req, "art"));
            const requestedHint = requestedMediaHint(requestQueryValue(req, "media_hint"));
            const quotedFromTitle = quotedFromScreenTitle(trackValue);
            const metadataMediaHint = metadataResolution && metadataResolution.hint || "";
            const mediaHint = requestedHint === "auto"
                ? quotedFromTitle ? "screen" : metadataMediaHint || mediaHintForAlbum(titleValue)
                : requestedHint;
            const rawClientKey = requestQueryValue(req, "client_key");
            const clientKey = typeof rawClientKey === "string" ? rawClientKey.trim() : "";
            if (clientKey.length > 128 || /[\u0000-\u001F\u007F]/.test(clientKey)) {
                throw new ResolverError("invalid_client_key", 400, "client_key is invalid");
            }
            const result = await resolveBackdrop(title, providers, clientKey, {
                env, fetchImpl, tintForImage,
            }, mediaHint, metadataResolution && metadataResolution.title
                ? "" : typeof artistValue === "string" ? artistValue.trim() : "", {
                ratingCountries,
                includeArt,
                screenQueries: titleCandidates,
                requireExactScreenMatch: usesExactTrackPrefix(cleanMovieTitle(titleValue))
                    || !!starTrekSeriesAlias(titleValue) || !!quotedFromTitle
                    || !!(metadataResolution && metadataResolution.title),
                allowGameTitleExtension:
                    isTrackTitledGameCompilation(cleanMovieTitle(titleValue)),
                validateExactComposer: requestedHint === "auto" && !quotedFromTitle
                    && !metadataResolution && mediaHint === "auto",
            });
            const shortCache = !result.media || (includeArt && !result.backdrop);
            debugLog("info", "request.resolved", {
                duration_ms: Date.now() - startedAt,
                media: result.media,
                source: result.source,
                has_backdrop: !!result.backdrop,
            });
            res.setHeader("Cache-Control", shortCache
                ? cacheControl(MISS_CACHE_SECONDS, MISS_CACHE_SECONDS, 60)
                : cacheControl(CACHE_SECONDS));
            return sendJson(res, 200, result);
        } catch (error) {
            const known = error instanceof ResolverError;
            debugLog("error", "request.error", {
                duration_ms: Date.now() - startedAt,
                status: known ? error.status : 500,
                error_code: known ? error.code : "internal_error",
                error_name: error && error.name || "Error",
                error_message: error && error.message || "request failed",
                stack: error && error.stack || null,
            });
            res.setHeader("Cache-Control", "no-store");
            return sendJson(res, known ? error.status : 500, {
                error: known ? error.code : "internal_error",
            });
        }
    }

    return function backdropHandler(req, res) {
        const context = { env, requestId: debugRequestId() };
        return debugLogContext.run(context, () => handleBackdropRequest(req, res));
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
            res.setHeader("Cache-Control", cacheControl(0));
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
    MISS_CACHE_SECONDS,
    WHITE_TINT,
    backdropTitleCandidatesFor,
    backdropTitleFor,
    certificationResponse,
    cleanMovieTitle,
    coverTintForUrl,
    createHandler,
    createTintHandler,
    handler,
    mediaHintForAlbum,
    pickComposerCredit,
    pickExactPerson,
    pickGame,
    pickMedia,
    pickMovie,
    requestQueryValue,
    requestedProviders,
    requestedRatings,
    requestedMediaHint,
    resolveBackdrop,
    tintFromMeans,
    tintPreviewUrl,
    tintHandler,
    trustedCoverTintUrl,
    trustedSteamGridDbUrl,
};
