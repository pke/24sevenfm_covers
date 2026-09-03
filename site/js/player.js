// player.js - the web player: the desktop viewer's feature set, in the browser.
//
// Same data source and timing as the apps (lib/coverfetch.cpp): poll the station's
// now-playing JSON, show the cover, re-poll when the track should end. Verified
// against the live servers: every station grants CORS on the JSON endpoint
// (Access-Control-Allow-Origin: *) and proxies an HTTPS stream at
// https://<host>/live - the same endpoint the station's own web player uses. So
// Station playback still talks DIRECTLY to the selected station. The optional movie
// backdrop feature uses this project's small resolver endpoint, as disclosed in the
// privacy policy. Metadata matching stays behind that resolver; only the explicit
// personal-key check calls fanart.tv directly.
//
// Without JavaScript none of this runs; the <noscript> block in player.html still
// offers the plain <audio> streams, which need no script at all.
"use strict";
(function () {

var PLAYER_SCRIPT_URL = new URL(document.currentScript.src, document.baseURI);

// Mirrors shared/stations.h: same ids (used as persistence keys), same hosts. The logo
// filenames are wildly inconsistent per station and NOT guessable - each URL below was
// verified live (the "500x500" variants the stations' own og:image tags reference are
// 404 across the board, so only the 200x200 set is real).
// Capabilities are the shared station-scope contract for both the settings UI and
// runtime behavior. Options themselves remain one persisted preference set; a
// capability only says where a feature may be configured and run.
var CAPABILITY_SOUNDTRACK_MEDIA = "soundtrackMedia";
var CAPABILITY_LASERS = "lasers";
var NO_STATION_CAPABILITIES = Object.freeze({});
var STATIONS = [
    { 
        id: "sst",       
        name: "StreamingSoundtracks", 
        host: "streamingsoundtracks.com", 
        desc: "Movie scores, TV themes, anime & game music", 
        capabilities: Object.freeze({
            soundtrackMedia: Object.freeze({ resolver: resolveMovieBackdrop })
        }),
        logo: "https://streamingsoundtracks.com/images/logos/logo-sst-v200x200.png" 
    },
    { 
        id: "1980s",     
        name: "1980s.FM",             
        host: "1980s.fm",                 
        desc: "1980s pop, rock & new wave",                  
        capabilities: Object.freeze({ lasers: true }),
        logo: "https://1980s.fm/images/logos/1980s_logo-200x200.png" },
    { 
        id: "adagio",    
        name: "Adagio.FM",
        host: "adagio.fm",                
        desc: "Classical & ambient",                         
        capabilities: NO_STATION_CAPABILITIES,
        logo: "https://adagio.fm/images/logos/logo-afm-200x200.png" },
    { 
        id: "death",     
        name: "Death.FM",             
        host: "death.fm",                 
        desc: "Extreme & underground metal",                 
        capabilities: NO_STATION_CAPABILITIES,
        logo: "https://death.fm/images/logos/logo-dfm-200x200.png" },
    { 
        id: "entranced", 
        name: "Entranced.FM",         
        host: "entranced.fm",             
        desc: "Trance, ambient & electronic",                
        capabilities: NO_STATION_CAPABILITIES,
        logo: "https://entranced.fm/images/logos/logo-efm-g200x200.png" 
    }
];

// --- options -----------------------------------------------------------------
// Keys and defaults mirror shared/config.h so the player behaves like the apps.
// Persisted in localStorage (documented in the privacy policy); posterBlur and
// borderRadius stay hidden here too - URL parameters instead of UI, like the INI.
var STORE_KEY = "24sevenfm-covers.player.v2";
function clampInt(v, lo, hi) {
    v = parseInt(v, 10);
    return isNaN(v) ? lo : Math.min(hi, Math.max(lo, v));
}
function intOption(lo, hi) {
    return function (value) { return clampInt(value, lo, hi); };
}
function floatOption(fallback, lo, hi) {
    return function (value) {
        value = parseFloat(value);
        if (!isFinite(value)) value = fallback;
        return Math.min(hi, Math.max(lo, value));
    };
}
function boolOption(value) {
    return (value === true || value === 1 || value === "1") ? 1 : 0;
}
function enumOption(allowed, fallback) {
    return function (value) { return allowed.indexOf(value) >= 0 ? value : fallback; };
}
function optionalTrueOption(value) {
    return boolOption(value) ? true : undefined;
}
function cloneOptionValue(value) {
    if (Array.isArray(value)) return value.map(cloneOptionValue);
    if (value && typeof value === "object") {
        var copy = {};
        Object.keys(value).forEach(function (key) {
            copy[key] = cloneOptionValue(value[key]);
        });
        return copy;
    }
    return value;
}
function selectedIdsOption(known, fallback) {
    return function (value) {
        if (!Array.isArray(value)) return fallback.slice();
        var selected = [];
        value.forEach(function (id) {
            if (known.indexOf(id) >= 0 && selected.indexOf(id) < 0) selected.push(id);
        });
        return selected;
    };
}
function featureOption(defaultOptions, coerceOptions) {
    return function (value) {
        var feature = value && typeof value === "object" && !Array.isArray(value)
            ? value : {};
        return {
            enabled: !!boolOption(feature.enabled),
            options: coerceOptions(feature.options || cloneOptionValue(defaultOptions))
        };
    };
}

var ART_PROVIDER_DEFS = Array.from(
    document.querySelectorAll("#providers > .provider"),
    row => ({
        id: row.dataset.provider,
        name: row.querySelector("label").textContent.trim()
    })
);
var PROVIDER_ORDER = ART_PROVIDER_DEFS.map(({ id }) => id);
var ART_PROVIDER_BY_ID = ART_PROVIDER_DEFS.reduce((providers, provider) => {
    providers[provider.id] = provider;
    return providers;
}, Object.create(null));
var DEFAULT_BACKDROP_OPTIONS = Object.freeze({
    providers: Object.freeze(PROVIDER_ORDER.slice()),
    cover: "hide"
});
var DEFAULT_RATING_OPTIONS = Object.freeze({ countries: Object.freeze(["DE", "US"]) });
var DEFAULT_TRANSITION_OPTIONS = Object.freeze({ style: 1, durationMs: 1000 });
var DEFAULT_REMAINING_TIME_OPTIONS = Object.freeze({ mode: "countdown", size: "small" });
function transitionOptions(value) {
    value = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
        style: intOption(1, 3)(value.style),
        durationMs: value.durationMs === undefined
            ? 1000 : intOption(500, 2000)(value.durationMs)
    };
}
function remainingTimeOptions(value) {
    value = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
        mode: enumOption(["countdown", "rolldown"], "countdown")(value.mode),
        size: enumOption(["small", "medium", "large"], "small")(value.size)
    };
}
function backdropOptions(value) {
    value = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
        providers: selectedIdsOption(PROVIDER_ORDER, PROVIDER_ORDER)(value.providers),
        cover: enumOption(["show", "hide"], "hide")(value.cover)
    };
}
function ratingOptions(value) {
    value = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
        countries: selectedIdsOption(["DE", "US"], ["DE", "US"])(value.countries)
    };
}
var OPTION_DEFS = {
    // layout intentionally differs from the apps' default (fill): a first-time web
    // visitor gets the poster - the layout that shows title/artist without any host
    // player around to provide them. Saved options always win over defaults.
    station: { default: "sst", coerce: function (value) {
        return stationIndex(value) >= 0 ? value : "sst";
    }, effect: applyStation },
    layout: { default: 1, coerce: intOption(0, 1), effect: applyLayout },
    transition: {
        default: { enabled: true, options: DEFAULT_TRANSITION_OPTIONS },
        coerce: featureOption(DEFAULT_TRANSITION_OPTIONS, transitionOptions)
    },
    remainingTime: {
        default: { enabled: false, options: DEFAULT_REMAINING_TIME_OPTIONS },
        coerce: featureOption(DEFAULT_REMAINING_TIME_OPTIONS, remainingTimeOptions)
    },
    comingNext: { optional: true, coerce: optionalTrueOption,
        effect: applyComingNextEnabled },
    posterBlur: { default: 24, coerce: intOption(0, 200) },
    borderRadius: { default: 45, coerce: intOption(0, 500) },
    volume: { default: 0.8, coerce: floatOption(0.8, 0, 1), event: "input",
        effect: applyVolume },
    milkdropEnabled: { default: 0, coerce: boolOption, effect: applyMilkdropEnabled },
    milkdropPreset: { default: "auto",
        coerce: enumOption(["auto", "aurora", "mandala", "tunnel"], "auto"),
        effect: syncSpectrum },
    laserEnabled: { default: 1, coerce: boolOption, effect: applyLaserEnabled },
    strobeEnabled: { default: 0, coerce: boolOption },
    smokeEnabled: { default: 0, coerce: boolOption, effect: applySmokeEnabled },
    spectrumEnabled: { default: 0, coerce: boolOption, effect: applySpectrumEnabled },
    bpmEnabled: { default: 0, coerce: boolOption, effect: applyBpmEnabled },
    analyzerType: { default: "spectrum",
        coerce: enumOption(["spectrum", "oscilloscope"], "spectrum"),
        effect: applyAnalyzerType },
    spectrumBars: { default: 24, coerce: intOption(8, 64), event: "input",
        format: String, effect: resetSpectrumBars },
    spectrumMode: { default: "tinted", coerce: enumOption(["legacy", "tinted"], "tinted"),
        effect: syncSpectrum },
    oscilloscopeStyle: { default: "line",
        coerce: enumOption(["line", "dots", "filled"], "line"), effect: syncSpectrum },
    // Activation is independent from configuration: turning a feature off preserves
    // provider order, cover behavior and country choices for the next time it is used.
    sstBackdrops: {
        default: { enabled: false, options: DEFAULT_BACKDROP_OPTIONS },
        coerce: featureOption(DEFAULT_BACKDROP_OPTIONS, backdropOptions)
    },
    sstRatings: {
        default: { enabled: false, options: DEFAULT_RATING_OPTIONS },
        coerce: featureOption(DEFAULT_RATING_OPTIONS, ratingOptions)
    },
    fanartKey: { default: "", coerce: function (value) {
        return (typeof value === "string") ? value.trim() : "";
    }, effect: updateBackdrop },
    fanartKeyVerifiedAt: { default: 0, coerce: value => {
        const timestamp = Number(value);
        return Number.isSafeInteger(timestamp) && timestamp > 0
            && timestamp <= 8640000000000000 ? timestamp : 0;
    } },
};
var backdropApiMeta = document.querySelector('meta[name="backdrop-api"]');
var BACKDROP_API_URL = (backdropApiMeta && backdropApiMeta.getAttribute("content")
    || "/api/backdrop").trim();
var tintApiMeta = document.querySelector('meta[name="tint-api"]');
var TINT_API_URL = (tintApiMeta && tintApiMeta.getAttribute("content")
    || "/api/tint").trim();
var creditApiMeta = document.querySelector('meta[name="credit-api"]');
var CREDIT_API_URL = (creditApiMeta && creditApiMeta.getAttribute("content")
    || "/api/credit").trim();
const FANART_KEY_CHECK_URL = "https://webservice.fanart.tv/v3/movies/27205";
var isLocalPlayer = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(location.hostname);
function localBackchannelUrl() {
    if (!isLocalPlayer || !BACKDROP_API_URL) return "";
    try {
        var url = new URL(BACKDROP_API_URL, location.href);
        if (!/^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(url.hostname)
                || (url.protocol !== "http:" && url.protocol !== "https:")) return "";
        url.pathname = "/api/backchannel";
        url.search = "";
        url.hash = "";
        return url.href;
    } catch (error) {
        return "";
    }
}
var BACKCHANNEL_API_URL = localBackchannelUrl();
// Local visual QA can force the retry state even while the real station is healthy.
// The hostname guard makes the switch inert on every deployed origin.
var simulateStationFailure = isLocalPlayer
    && new URLSearchParams(location.search).has("simulateStationFailure");
var localPreviewParams = new URLSearchParams(location.search);

function localPreviewText(key, maxLength) {
    if (!isLocalPlayer || !localPreviewParams.has(key)) return "";
    var value = localPreviewParams.get(key).trim();
    return value.length <= maxLength && !/[\u0000-\u001F\u007F]/.test(value) ? value : "";
}

// A local-only metadata fixture makes visual QA reproducible without touching the
// station feed. previewAlbum is the opt-in; the other two fields are optional.
var previewAlbum = localPreviewText("previewAlbum", 160);
var localNowPlayingPreview = previewAlbum ? Object.freeze({
    album: previewAlbum,
    track: localPreviewText("previewTrack", 300),
    artist: localPreviewText("previewArtist", 160),
}) : null;

function defaultOptions() {
    var defaults = {};
    for (var key in OPTION_DEFS) {
        if (!Object.prototype.hasOwnProperty.call(OPTION_DEFS[key], "default")) continue;
        var fallback = OPTION_DEFS[key].default;
        if (fallback !== undefined) defaults[key] = cloneOptionValue(fallback);
    }
    return defaults;
}
function applyPresetOptions(options, params) {
    var set = function (key, value) {
        var coerced = OPTION_DEFS[key].coerce(value);
        if (coerced === undefined && OPTION_DEFS[key].optional) delete options[key];
        else options[key] = coerced;
    };
    var booleanParam = function (key, param) {
        if (params.has(param)) set(key, params.get(param));
    };
    if (params.has("station")) set("station", params.get("station"));
    if (params.has("layout"))
        set("layout", params.get("layout") === "fill" ? 0 : 1);
    var transition = cloneOptionValue(options.transition);
    if (params.has("transition")) {
        var transitions = { crossfade: 1, flipHorizontal: 2, flipVertical: 3 };
        transition.enabled = params.get("transition") !== "none";
        if (Object.prototype.hasOwnProperty.call(transitions, params.get("transition")))
            transition.options.style = transitions[params.get("transition")];
    }
    if (params.has("fade")) transition.options.durationMs = params.get("fade");
    options.transition = OPTION_DEFS.transition.coerce(transition);
    var remainingTime = cloneOptionValue(options.remainingTime);
    if (params.has("remaining")) {
        remainingTime.enabled = true;
        remainingTime.options.mode = params.get("remaining");
    }
    if (params.has("remainingSize"))
        remainingTime.options.size = params.get("remainingSize");
    options.remainingTime = OPTION_DEFS.remainingTime.coerce(remainingTime);
    booleanParam("comingNext", "comingNext");
    if (params.has("volume")) set("volume", params.get("volume"));
    if (params.has("milkdrop")) {
        set("milkdropEnabled", 1);
        set("milkdropPreset", params.get("milkdrop"));
    }
    booleanParam("laserEnabled", "laser");
    booleanParam("strobeEnabled", "strobe");
    booleanParam("smokeEnabled", "smoke");
    booleanParam("bpmEnabled", "bpm");
    if (params.has("analyzer")) {
        var analyzer = params.get("analyzer");
        if (analyzer === "spectrum" || analyzer === "oscilloscope") {
            set("spectrumEnabled", 1);
            set("analyzerType", analyzer);
        }
    }
    if (params.has("bars")) set("spectrumBars", params.get("bars"));
    if (params.has("color")) set("spectrumMode", params.get("color"));
    if (params.has("scope")) set("oscilloscopeStyle", params.get("scope"));
    var backdrops = cloneOptionValue(options.sstBackdrops);
    if (params.has("sstBackdrops")) backdrops.enabled = boolOption(params.get("sstBackdrops"));
    if (params.has("sstBackdropProviders"))
        backdrops.options.providers = params.get("sstBackdropProviders").split(",").filter(Boolean);
    if (params.has("sstBackdropCover"))
        backdrops.options.cover = params.get("sstBackdropCover");
    options.sstBackdrops = OPTION_DEFS.sstBackdrops.coerce(backdrops);
    var ratings = cloneOptionValue(options.sstRatings);
    if (params.has("sstRatings")) ratings.enabled = boolOption(params.get("sstRatings"));
    if (params.has("sstRatingCountries"))
        ratings.options.countries = params.get("sstRatingCountries").split(",").filter(Boolean);
    options.sstRatings = OPTION_DEFS.sstRatings.coerce(ratings);
    if (params.has("blur")) set("posterBlur", params.get("blur"));
    if (params.has("radius")) set("borderRadius", params.get("radius"));
}

function loadOpts() {
    var o = defaultOptions();
    var p = new URLSearchParams(location.search);
    var preset = p.get("preset") === "1";
    var saved = {};
    if (!preset) {
        try {
            saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
            if (!saved || typeof saved !== "object" || saved instanceof Array) saved = {};
            for (var s in saved) if (s in OPTION_DEFS) o[s] = saved[s];
        } catch (e) { /* corrupt storage -> defaults */ }
    }
    // Coercion is defined beside each default so corrupt or partial v2 storage falls
    // back safely without carrying a legacy migration layer in the player.
    for (var key in OPTION_DEFS) {
        var value = OPTION_DEFS[key].coerce(o[key]);
        if (value === undefined && OPTION_DEFS[key].optional) delete o[key];
        else o[key] = value;
    }
    // A marked share URL is a complete preset: defaults plus its sparse keys, never
    // the recipient's unrelated local preferences. Ordinary URLs keep only the
    // station and hidden-layout overrides.
    if (preset) applyPresetOptions(o, p);
    else {
        if (p.has("station") && stationIndex(p.get("station")) >= 0) o.station = p.get("station");
        if (p.has("posterBlur")) o.posterBlur = OPTION_DEFS.posterBlur.coerce(p.get("posterBlur"));
        if (p.has("borderRadius"))
            o.borderRadius = OPTION_DEFS.borderRadius.coerce(p.get("borderRadius"));
    }
    return o;
}
var opts = loadOpts();
function contentTransitionEffect() {
    return reducedMotion.matches || !opts.transition.enabled
        ? 0 : opts.transition.options.style;
}
function contentTransitionDuration() {
    return opts.transition.options.durationMs;
}
function remainingTimeMode() {
    return opts.remainingTime.enabled ? opts.remainingTime.options.mode : "";
}
function sstBackdropsEnabled() {
    return opts.sstBackdrops.enabled && opts.sstBackdrops.options.providers.length > 0;
}
function sstRatingsEnabled() {
    return opts.sstRatings.enabled && opts.sstRatings.options.countries.length > 0;
}
function setFeatureOptionsState(element, enabled) {
    element.classList.toggle("enabled", enabled);
    element.setAttribute("aria-hidden", enabled ? "false" : "true");
    if (enabled) element.removeAttribute("inert");
    else element.setAttribute("inert", "");
}
function saveOpts() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(opts)); } catch (e) { /* private mode: session-only */ }
    syncSettingsUrl();
}
function stationIndex(id) {
    for (var i = 0; i < STATIONS.length; i++) if (STATIONS[i].id === id) return i;
    return -1;
}
var SETTINGS_URL_KEYS = [
    "preset", "station", "layout", "transition", "fade", "remaining",
    "remainingSize", "comingNext", "volume", "milkdrop", "laser", "strobe",
    "smoke", "bpm", "analyzer", "bars", "color", "scope", "sstBackdrops",
    "sstBackdropProviders", "sstBackdropCover", "sstRatings", "sstRatingCountries",
    "blur", "radius", "posterBlur", "borderRadius"
];
function writeSettingsUrl(url) {
    var params = url.searchParams;
    var transitions = [null, "crossfade", "flipHorizontal", "flipVertical"];
    SETTINGS_URL_KEYS.forEach(function (key) { params.delete(key); });
    params.set("preset", "1");
    params.set("station", opts.station);
    if (opts.layout !== 1) params.set("layout", "fill");
    if (!opts.transition.enabled) params.set("transition", "none");
    else if (opts.transition.options.style !== 1)
        params.set("transition", transitions[opts.transition.options.style]);
    if (opts.transition.options.durationMs !== 1000)
        params.set("fade", String(opts.transition.options.durationMs));
    if (opts.remainingTime.enabled)
        params.set("remaining", opts.remainingTime.options.mode);
    if (opts.remainingTime.options.size !== "small")
        params.set("remainingSize", opts.remainingTime.options.size);
    if (opts.comingNext) params.set("comingNext", "1");
    if (opts.volume !== 0.8) params.set("volume", String(opts.volume));
    if (opts.milkdropEnabled) params.set("milkdrop", opts.milkdropPreset);
    if (!opts.laserEnabled) params.set("laser", "0");
    if (opts.strobeEnabled) params.set("strobe", "1");
    if (opts.smokeEnabled) params.set("smoke", "1");
    if (opts.bpmEnabled) params.set("bpm", "1");
    if (opts.spectrumEnabled) params.set("analyzer", opts.analyzerType);
    if (opts.spectrumBars !== 24) params.set("bars", String(opts.spectrumBars));
    if (opts.spectrumMode !== "tinted") params.set("color", opts.spectrumMode);
    if (opts.oscilloscopeStyle !== "line") params.set("scope", opts.oscilloscopeStyle);
    if (opts.sstBackdrops.enabled) params.set("sstBackdrops", "1");
    if (opts.sstBackdrops.options.providers.join(",") !== PROVIDER_ORDER.join(","))
        params.set("sstBackdropProviders", opts.sstBackdrops.options.providers.join(","));
    if (opts.sstBackdrops.options.cover !== "hide")
        params.set("sstBackdropCover", opts.sstBackdrops.options.cover);
    if (opts.sstRatings.enabled) params.set("sstRatings", "1");
    if (opts.sstRatings.options.countries.join(",") !== "DE,US")
        params.set("sstRatingCountries", opts.sstRatings.options.countries.join(","));
    if (opts.posterBlur !== 24) params.set("blur", String(opts.posterBlur));
    if (opts.borderRadius !== 45) params.set("radius", String(opts.borderRadius));
    return url;
}
function settingsShareUrl() {
    return writeSettingsUrl(new URL(location.pathname, location.origin));
}
function syncSettingsUrl() {
    // Keep the address bar as the canonical, shareable non-secret state. Preserve
    // unrelated parameters (for diagnostics or campaigns) and the hash, but replace
    // every managed setting so stale URL values cannot survive a control change.
    var url = writeSettingsUrl(new URL(location.href));
    if (url.href === location.href) return;
    try { history.replaceState(history.state, "", url); }
    catch (error) { /* sandboxed/opaque documents may not be allowed to rewrite their URL */ }
}
syncSettingsUrl();

// The feed stores track text HTML-encoded ("R&amp;B", "&#039;") - decode it for
// display, like lib/coverfetch.cpp's htmlDecode. DOMParser never executes anything,
// so feeding it untrusted feed text is safe (unlike innerHTML).
var entityDoc = new DOMParser();
function htmlDecode(value) {
    var type = typeof value;
    if (value === null || value === undefined
            || (type !== "string" && type !== "number" && type !== "boolean")) return "";
    var s = String(value);
    // Keep raw markup as text: DOMParser-created documents may still fetch resources
    // referenced by elements such as <img> and <iframe>. Character references decoded
    // by the parser are emitted as text tokens and are not parsed a second time.
    s = s.replace(/</g, "&lt;");
    return entityDoc.parseFromString(s, "text/html").body.textContent;
}
function unrotateTitleArticle(title) {
    return (title || "").replace(
        /^(.+),\s*(The|A|An)(\s+\((?:18|19|20|21)\d{2}\))?$/i, "$2 $1$3");
}

function station() { return STATIONS[stationIndex(opts.station)]; }
function stationCapability(name, selectedStation) {
    var selected = selectedStation || station();
    return selected && selected.capabilities && selected.capabilities[name] || null;
}
function stationSupports(name, selectedStation) {
    return !!stationCapability(name, selectedStation);
}

// CoverLink is controlled by the station feed. Keep image requests on the selected
// station's HTTPS origin (or a real subdomain), matching the native clients' trust
// boundary. The page's img-src CSP separately prevents redirects escaping this set.
function trustedCoverUrl(raw) {
    if (typeof raw !== "string" || !raw || /[\u0000-\u001F\u007F]/.test(raw)) return "";
    try {
        var u = new URL(raw);
        var trustedHost = station().host.toLowerCase();
        var urlHost = u.hostname.toLowerCase();
        if (u.protocol !== "https:" || (u.port && u.port !== "443")
                || u.username || u.password
                || (urlHost !== trustedHost && !urlHost.endsWith("." + trustedHost))) return "";
        return u.href;
    } catch (e) { return ""; }
}

function sizedCoverUrl(raw) {
    var trusted = trustedCoverUrl(raw);
    return trusted ? trusted.replace("/cover/", "/cover/500/") : "";
}

// The station sometimes reports backend failures as an HTTP 200 JSON object such
// as {"error":"Could not connect to DB server."}. Treat that exactly like a
// failed request: an error object must never erase a valid cover/title or masquerade
// as a station ID merely because all now-playing fields are absent.
function validNowPlaying(j) {
    if (!j || typeof j !== "object" || j instanceof Array || j.error) return false;
    return ["Album", "Track", "Artist", "CoverLink"].every(function (key) {
        return Object.prototype.hasOwnProperty.call(j, key);
    });
}

// --- DOM ---------------------------------------------------------------------
var $ = function (id) { return document.getElementById(id); };
var stage = $("stage"), coverBox = $("coverbox");

// Cover and movie work use the same generation mechanism, but separate channels:
// changing backdrop options must not cancel a still-valid cover load (and vice versa).
var renderGenerations = { cover: 0, backdrop: 0, tint: 0 };
function nextRenderGeneration(channel) { return ++renderGenerations[channel]; }
function renderIsCurrent(channel, generation) { return renderGenerations[channel] === generation; }
var IMAGE_TIMEOUT = 20000, COVER_RETRY_DELAY = 5000, COVER_RETRY_LIMIT = 3;
var COVER_RETRY_COOLDOWN = 300000;
var BACKDROP_RETRY_DELAY = 1000, BACKDROP_RETRY_LIMIT = 2;

function preloadImage(url, onLoad, onError) {
    var image = new Image(), settled = false;
    var kill = setTimeout(function () { settle(onError, true); }, IMAGE_TIMEOUT);
    function settle(callback, abort) {
        if (settled) return;
        settled = true;
        clearTimeout(kill);
        image.onload = image.onerror = null;
        if (abort) image.removeAttribute("src");
        if (callback) callback();
    }
    image.onload = function () { settle(onLoad, false); };
    image.onerror = function () { settle(onError, false); };
    image.src = url;
}

// A double-buffered image layer: two stacked <img>s, the incoming URL preloads into
// the hidden one and opacity-crossfades over the visible one (CSS .show). Used for
// both backdrop layers - a bare src swap would hard-cut, and backgrounds deserve the
// same crossfade the cover gets.
function makeLayer(a, b, channel) {
    var front = null, pendingLoad = null;
    var retirements = new Map();

    function loadedElement(url) {
        return [a, b].find(element => element.src === url
            && element.complete && element.naturalWidth > 0) || null;
    }

    function settlePending(record, element, removeSource) {
        if (record.settled) return;
        record.settled = true;
        clearTimeout(record.kill);
        if (record.element) {
            record.element.onload = record.element.onerror = null;
            if (removeSource && record.loading) record.element.removeAttribute("src");
        }
        if (pendingLoad === record) pendingLoad = null;
        record.resolve(element);
    }

    function finishRetirement(record) {
        if (record.settled) return;
        record.settled = true;
        clearTimeout(record.kill);
        record.element.removeEventListener("transitionend", record.onTransitionEnd);
        if (retirements.get(record.element) === record)
            retirements.delete(record.element);
        record.resolve();
    }

    // Removing .show starts an opacity transition, so that element is still visible
    // even though it is already the logical back buffer. Do not replace its src until
    // the exit has finished: a queue prefetch would otherwise paint the next title
    // into the fading pixels of the outgoing title.
    function retire(element) {
        const previous = retirements.get(element);
        if (previous) finishRetirement(previous);
        const duration = getComputedStyle(element).display === "none"
            ? 0 : transitionTotalMs(element);
        if (!duration) return;
        const record = {
            element: element,
            settled: false,
            kill: null,
            onTransitionEnd: null,
            resolve: null,
            promise: null
        };
        record.promise = new Promise(resolve => { record.resolve = resolve; });
        record.onTransitionEnd = function (event) {
            if (event.target === element && event.propertyName === "opacity")
                finishRetirement(record);
        };
        retirements.set(element, record);
        element.addEventListener("transitionend", record.onTransitionEnd);
        record.kill = setTimeout(() => finishRetirement(record), duration + 50);
    }

    function reuse(element) {
        const retirement = retirements.get(element);
        if (retirement) finishRetirement(retirement);
    }

    function backElement() {
        if (front === a) return b;
        if (front === b) return a;
        if (!retirements.has(a)) return a;
        if (!retirements.has(b)) return b;
        return a;
    }

    function startPending(record) {
        if (record.settled) return;
        const loaded = loadedElement(record.url);
        if (loaded) {
            settlePending(record, loaded, false);
            return;
        }
        const back = backElement();
        const retirement = retirements.get(back);
        if (retirement) {
            if (record.waitingOn !== retirement) {
                record.waitingOn = retirement;
                retirement.promise.then(function () { startPending(record); });
            }
            return;
        }
        record.waitingOn = null;
        record.element = back;
        record.loading = true;
        back.onload = () => settlePending(record, back, false);
        back.onerror = () => settlePending(record, null, true);
        back.src = record.url;
        // A memory-cache hit may complete synchronously without a later load event.
        if (back.complete && back.naturalWidth > 0)
            queueMicrotask(() => settlePending(record, back, false));
    }

    function loadIntoBack(url, purpose) {
        const loaded = loadedElement(url);
        if (loaded) return Promise.resolve(loaded);
        if (pendingLoad && pendingLoad.url === url) {
            if (purpose === "show") pendingLoad.purpose = "show";
            return pendingLoad.promise;
        }
        // Speculative queue work must never cancel the image currently requested for
        // display. The queue also owns a detached Image preload, so skipping this DOM
        // preparation still leaves the eventual promotion warm in the browser cache.
        if (pendingLoad && pendingLoad.purpose === "show" && purpose === "prepare")
            return Promise.resolve(null);
        if (pendingLoad) settlePending(pendingLoad, null, true);

        const record = {
            element: null,
            url,
            purpose,
            loading: false,
            waitingOn: null,
            settled: false,
            kill: null,
            resolve: null,
            promise: null
        };
        record.promise = new Promise(resolve => { record.resolve = resolve; });
        pendingLoad = record;
        record.kill = setTimeout(() => settlePending(record, null, true), IMAGE_TIMEOUT);
        startPending(record);
        return record.promise;
    }

    return {
        prepare: function (url) { return loadIntoBack(url, "prepare"); },
        show: function (url, generation, onShown, onError) {
            if (front && front.src === url && front.classList.contains("show")) return;
            loadIntoBack(url, "show").then(function (back) {
                if (!renderIsCurrent(channel, generation)) return;
                if (!back) {
                    if (onError) onError();
                    return;
                }
                reuse(back);
                back.classList.add("show");
                if (front && front !== back) {
                    front.classList.remove("show");
                    retire(front);
                }
                front = back;
                if (onShown) onShown();
            });
        },
        hide: function () {
            [a, b].forEach(function (element) {
                if (!element.classList.contains("show")) return;
                element.classList.remove("show");
                retire(element);
            });
            front = null;
        }
    };
}
var blurLayer = makeLayer($("backdropA"), $("backdropB"), "cover");
var imgA = $("coverA"), imgB = $("coverB");
var cdEl = $("countdown"), statusEl = $("status"), stageStatusEl = $("stage-status");
var comingNextEl = $("coming-next");
var comingNextAlbumEl = $("coming-next-album"), comingNextArtistEl = $("coming-next-artist");
var backdropErrorEl = $("backdrop-error"), backdropErrorTextEl = $("backdrop-error-text");
var backdropRetryEl = $("backdrop-retry");
var audioEl = $("audio");
var infoTitleEl = $("info-title"), backchannelStatusEl = $("backchannel-status");

// One info box serves both layouts (title, artist, countdown) - overlaid on the
// stage in fill, sitting below the cover in poster.
function setInfo(title, artist) {
    infoTitleEl.textContent = title;
    $("info-artist").textContent = artist;
}

var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

var BACKCHANNEL_TOKEN_KEY = "24sevenfm-covers.backchannel-token";
var backchannelStatusGeneration = 0, backchannelStatusTimer = null;
var backchannelClearTimer = null, backchannelSending = false;
var backchannelAvailable = false;

function showBackchannelStatus(message, visibleMilliseconds) {
    var generation = ++backchannelStatusGeneration;
    clearTimeout(backchannelStatusTimer);
    clearTimeout(backchannelClearTimer);
    function reveal() {
        if (generation !== backchannelStatusGeneration) return;
        backchannelStatusEl.textContent = message;
        backchannelStatusEl.setAttribute("aria-hidden", "false");
        requestAnimationFrame(function () {
            if (generation === backchannelStatusGeneration)
                backchannelStatusEl.classList.add("show");
        });
        if (!visibleMilliseconds) return;
        backchannelStatusTimer = setTimeout(function () {
            if (generation !== backchannelStatusGeneration) return;
            backchannelStatusEl.classList.remove("show");
            backchannelStatusEl.setAttribute("aria-hidden", "true");
            backchannelClearTimer = setTimeout(function () {
                if (generation === backchannelStatusGeneration)
                    backchannelStatusEl.textContent = "";
            }, reducedMotion.matches ? 0 : 260);
        }, visibleMilliseconds);
    }
    if (backchannelStatusEl.textContent && backchannelStatusEl.textContent !== message
            && !reducedMotion.matches) {
        backchannelStatusEl.classList.remove("show");
        backchannelStatusEl.setAttribute("aria-hidden", "true");
        backchannelClearTimer = setTimeout(reveal, 210);
    } else reveal();
}

function backchannelStoredToken() {
    try { return sessionStorage.getItem(BACKCHANNEL_TOKEN_KEY) || ""; }
    catch (error) { return ""; }
}

function storeBackchannelToken(value) {
    try {
        if (value) sessionStorage.setItem(BACKCHANNEL_TOKEN_KEY, value);
        else sessionStorage.removeItem(BACKCHANNEL_TOKEN_KEY);
    } catch (error) { /* pairing lasts for this click when storage is unavailable */ }
}

function currentBackdropDiagnostic() {
    return localBackdropDiagnostics[localBackdropDiagnosticKey(
        currentAlbum, currentTrack, currentArtist)] || null;
}

function currentBackchannelReport() {
    return {
        station: station().id,
        album: currentAlbum,
        track: currentTrack,
        artist: currentArtist,
        displayedTitle: infoTitleEl.textContent,
        settings: {
            backdropsEnabled: sstBackdropsEnabled(),
            ratingsEnabled: sstRatingsEnabled(),
            fanartPersonalKeyConfigured: !!opts.fanartKey,
            providers: enabledMovieProviders(),
            coverPolicy: opts.sstBackdrops.options.cover,
        },
        display: {
            backdropVisible: movieShown,
            backdropError: backdropErrorEl.classList.contains("show")
                ? backdropErrorTextEl.textContent : "",
            resolver: currentBackdropDiagnostic(),
        },
    };
}

async function backchannelIsEnabled() {
    var response = await fetch(BACKCHANNEL_API_URL, { cache: "no-store" });
    if (!response.ok) return false;
    var body = await response.json();
    return !!(body && body.enabled);
}

async function sendCurrentTitleToCodex() {
    if (backchannelSending || !BACKCHANNEL_API_URL) return;
    if (!currentAlbum || stationIdActive) {
        showBackchannelStatus("No soundtrack title to report.", 3000);
        return;
    }
    backchannelSending = true;
    infoTitleEl.setAttribute("aria-busy", "true");
    try {
        showBackchannelStatus("Checking local Codex backchannel…");
        backchannelAvailable = await backchannelIsEnabled();
        if (!backchannelAvailable) {
            showBackchannelStatus("Local Codex backchannel is not active.", 4000);
            return;
        }
        var token = backchannelStoredToken();
        if (!token) {
            token = window.prompt(
                "Enter the Codex backchannel pairing code shown by start_test_server.ps1:");
            token = typeof token === "string" ? token.trim().toUpperCase() : "";
            if (!token) {
                showBackchannelStatus("Report cancelled.", 2500);
                return;
            }
        }
        for (var attempt = 0; attempt < 2; attempt++) {
            showBackchannelStatus("Sending title to Codex…");
            var response = await fetch(BACKCHANNEL_API_URL, {
                method: "POST",
                cache: "no-store",
                headers: {
                    "Authorization": "Bearer " + token,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(currentBackchannelReport()),
            });
            if (response.status !== 401) {
                if (!response.ok) {
                    showBackchannelStatus("Codex could not accept the report.", 4500);
                    return;
                }
                storeBackchannelToken(token);
                showBackchannelStatus("Sent to this Codex task.", 4000);
                return;
            }
            storeBackchannelToken("");
            if (attempt) {
                showBackchannelStatus("Pairing code not accepted.", 4500);
                return;
            }
            token = window.prompt(
                "The pairing code was not accepted. Enter the current code shown by "
                + "start_test_server.ps1:");
            token = typeof token === "string" ? token.trim().toUpperCase() : "";
            if (!token) {
                showBackchannelStatus("Report cancelled.", 2500);
                return;
            }
        }
    } catch (error) {
        showBackchannelStatus("Local Codex backchannel is unavailable.", 4500);
    } finally {
        backchannelSending = false;
        infoTitleEl.removeAttribute("aria-busy");
    }
}

function enableLocalBackchannel() {
    if (!BACKCHANNEL_API_URL) return;
    infoTitleEl.classList.add("local-backchannel");
    infoTitleEl.setAttribute("role", "button");
    infoTitleEl.setAttribute("tabindex", "0");
    infoTitleEl.setAttribute("title", "Send this title to the current Codex task");
    infoTitleEl.addEventListener("click", sendCurrentTitleToCodex);
    infoTitleEl.addEventListener("keydown", function (event) {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        sendCurrentTitleToCodex();
    });
}

// Each country keeps two badge faces on one 3D card. The next rating is loaded into
// the hidden face first, then the same transition and duration as the cover turn the
// already-attached back face into view.
function makeRatingSlot(slot) {
    var faces = Array.from(slot.querySelectorAll(".rating-face"));
    var descriptorBubble = slot.querySelector(".rating-descriptors");
    var token = "", version = 0, settleTimer = null;

    function setDescriptors(certification) {
        if (!descriptorBubble) return;
        var descriptors = certification.descriptors || [];
        var hasDescriptors = descriptors.length > 0;
        descriptorBubble.replaceChildren();
        descriptors.forEach(function (descriptor) {
            var row = document.createElement("span");
            var code = document.createElement("strong");
            var label = document.createElement("span");
            row.className = "rating-descriptor";
            code.className = "rating-descriptor-code";
            label.className = "rating-descriptor-label";
            code.textContent = descriptor;
            label.textContent = TV_CONTENT_DESCRIPTOR_LABELS[descriptor] || "";
            row.append(code, label);
            descriptorBubble.append(row);
        });
        slot.classList.toggle("has-descriptors", hasDescriptors);
        if (hasDescriptors) slot.setAttribute("tabindex", "0");
        else {
            slot.removeAttribute("tabindex");
            if (document.activeElement === slot) slot.blur();
        }
    }

    function setFace(face, certification, logo) {
        var img = face.querySelector("img"), label = face.querySelector("span");
        face.classList.toggle("has-logo", !!logo);
        if (logo) img.src = logo;
        else img.removeAttribute("src");
        label.textContent = certification.label;
    }

    function copyFace(from, to) {
        var fromImg = from.querySelector("img"), toImg = to.querySelector("img");
        to.classList.toggle("has-logo", from.classList.contains("has-logo"));
        if (fromImg.hasAttribute("src")) toImg.src = fromImg.getAttribute("src");
        else toImg.removeAttribute("src");
        to.querySelector("span").textContent = from.querySelector("span").textContent;
    }

    function hide() {
        clearTimeout(settleTimer);
        version++;
        slot.classList.remove("show");
        slot.setAttribute("aria-hidden", "true");
        slot.removeAttribute("aria-label");
        setDescriptors({ descriptors: [] });
    }

    function effectName() {
        var effect = contentTransitionEffect();
        stage.style.setProperty("--fade-ms", contentTransitionDuration() + "ms");
        return ["none", "fade", "fliph", "flipv"][effect];
    }

    function reveal(front, certification, replaceWhileHidden) {
        var fx = effectName(), wasHidden = !slot.classList.contains("show");
        clearTimeout(settleTimer);
        delete slot.dataset.settled;
        if (slot.dataset.fx !== fx) {
            slot.dataset.warp = "";
            slot.dataset.fx = fx;
            void slot.offsetWidth;
            delete slot.dataset.warp;
        }
        // If the badges were already hidden when this track handoff began, there is
        // no outgoing badge to animate for the listener. Replace BOTH retained faces
        // while the container is still held invisible, then fade/expand the slot with
        // only the destination badge attached. Otherwise track-intro would expose the
        // old front face for the first part of a flip (or crossfade).
        if (replaceWhileHidden) {
            var incoming = front === "a" ? faces[0] : faces[1];
            copyFace(incoming, incoming === faces[0] ? faces[1] : faces[0]);
            slot.dataset.warp = "";
            slot.dataset.front = "a";
            slot.dataset.settled = "";
            slot.classList.add("show");
            void slot.offsetWidth;
            delete slot.dataset.warp;
            slot.setAttribute("aria-hidden", "false");
            slot.setAttribute("aria-label", certification.accessibleLabel);
            setDescriptors(certification);
            maybeBeginRatingTrackVisibility();
            return;
        }
        // A retained badge that is being revealed again still enters through the
        // selected cover effect. Prime the opposite face while the slot is invisible,
        // then turn/crossfade to the requested face after the forced style flush.
        if (wasHidden && fx !== "none") {
            slot.dataset.warp = "";
            slot.dataset.front = front === "a" ? "b" : "a";
            void slot.offsetWidth;
            delete slot.dataset.warp;
        }
        slot.classList.add("show");
        void slot.offsetWidth;
        slot.dataset.front = front;
        slot.setAttribute("aria-hidden", "false");
        slot.setAttribute("aria-label", certification.accessibleLabel);
        setDescriptors(certification);
        maybeBeginRatingTrackVisibility();
        if (fx === "fliph" || fx === "flipv") {
            var settleVersion = version;
            // Once the visible flip has completed, keep or copy the new SVG on the
            // flat front face and reset both 3D rotations in a transition-free frame.
            // Keeping an SVG in two permanent 180° GPU layers makes it look rasterized.
            settleTimer = setTimeout(function () {
                if (version !== settleVersion || (slot.dataset.front !== "b"
                        && slot.dataset.front !== "a")
                        || !slot.classList.contains("show")) return;
                if (slot.dataset.front === "b") copyFace(faces[1], faces[0]);
                slot.dataset.warp = "";
                slot.dataset.front = "a";
                slot.dataset.settled = "";
                void slot.offsetWidth;
                delete slot.dataset.warp;
            }, contentTransitionDuration() + 50);
        }
    }

    function show(certification, generation, replaceWhileHidden) {
        if (!certification) { hide(); return; }
        var nextToken = [certification.rating, certification.label,
            certification.logo || "", (certification.descriptors || []).join(",")].join("\n");
        if (token === nextToken && slot.dataset.front) {
            reveal(slot.dataset.front, certification, replaceWhileHidden);
            return;
        }

        var currentVersion = ++version;
        var back = slot.dataset.front === "a" ? faces[1] : faces[0];
        var commit = function (logo) {
            if (version !== currentVersion || !renderIsCurrent("backdrop", generation)) return;
            setFace(back, certification, logo);
            token = nextToken;
            reveal(back === faces[0] ? "a" : "b", certification, replaceWhileHidden);
        };
        if (certification.logo) {
            preloadImage(certification.logo,
                function () { commit(certification.logo); },
                function () { commit(""); });
        } else {
            commit("");
        }
    }

    return { show: show, hide: hide };
}

var ratingSlots = {
    DE: makeRatingSlot($("rating-de")),
    US: makeRatingSlot($("rating-us")),
};
var currentCertifications = [];
var ratingBadgesEl = $("rating-badges");
var STAGE_IDLE_MS = 2000, RATING_TRACK_VISIBLE_MS = 10000;
var ratingIntroTimer = null, ratingIntroPending = false;
var ratingHandoffStartedHidden = false;

function ratingBadgesAreHidden() {
    var style = getComputedStyle(ratingBadgesEl);
    return style.visibility === "hidden" || parseFloat(style.opacity) === 0;
}

// A new track reserves an intro window, but its ten seconds start only when the
// first selected rating is actually revealed. Resolver and SVG latency therefore
// cannot consume the entire window before the listener has seen a badge.
function prepareRatingTrackVisibility(concealHiddenHandoff) {
    // Snapshot before removing the previous track's intro class. A handoff that
    // starts genuinely hidden stays hidden even if the pointer moves while the
    // resolver or logo is loading, matching the cover's hidden-until-ready hold.
    ratingHandoffStartedHidden = !!concealHiddenHandoff && ratingBadgesAreHidden();
    clearTimeout(ratingIntroTimer);
    ratingIntroPending = true;
    ratingBadgesEl.classList.remove("track-intro");
    ratingBadgesEl.classList.toggle("track-handoff", ratingHandoffStartedHidden);
    if (ratingHandoffStartedHidden) {
        ratingBadgesEl.setAttribute("aria-hidden", "true");
        ratingSlots.DE.hide();
        ratingSlots.US.hide();
    }
}

function cancelRatingTrackVisibility() {
    clearTimeout(ratingIntroTimer);
    ratingIntroPending = false;
    ratingHandoffStartedHidden = false;
    ratingBadgesEl.classList.remove("track-intro");
    ratingBadgesEl.classList.remove("track-handoff");
}

function maybeBeginRatingTrackVisibility() {
    if (!ratingIntroPending || !ratingBadgesEl.querySelector(".rating-slot.show")) return;
    ratingIntroPending = false;
    ratingHandoffStartedHidden = false;
    ratingBadgesEl.classList.remove("track-handoff");
    ratingBadgesEl.classList.add("track-intro");
    ratingBadgesEl.setAttribute("aria-hidden", "false");
    ratingIntroTimer = setTimeout(function () {
        ratingBadgesEl.classList.remove("track-intro");
    }, RATING_TRACK_VISIBLE_MS);
}

function renderRatingBadges(generation) {
    var byCountry = currentCertifications.reduce(function (ratings, certification) {
        ratings[certification.country] = certification;
        return ratings;
    }, Object.create(null));
    var available = stationSupports(CAPABILITY_SOUNDTRACK_MEDIA);
    var de = available && sstRatingsEnabled()
            && opts.sstRatings.options.countries.indexOf("DE") >= 0
        ? byCountry.DE : null;
    var us = available && sstRatingsEnabled()
            && opts.sstRatings.options.countries.indexOf("US") >= 0
        ? byCountry.US : null;
    var replaceWhileHidden = ratingHandoffStartedHidden;
    ratingSlots.DE.show(de, generation, replaceWhileHidden);
    ratingSlots.US.show(us, generation, replaceWhileHidden);
    // Keep the handoff armed until a face actually commits. A prefetched result can
    // be superseded while its logo is still loading; clearing here would let that
    // second render animate from the stale face. Each country captures the mode so
    // both destination logos still replace their retained faces when loads race.
}

function setRatings(certifications, generation) {
    if (!renderIsCurrent("backdrop", generation)) return;
    currentCertifications = certifications instanceof Array ? certifications : [];
    renderRatingBadges(generation);
}

function syncRatingControls() {
    var master = $("ratings-enabled");
    master.checked = opts.sstRatings.enabled;
    master.setAttribute("aria-expanded", opts.sstRatings.enabled ? "true" : "false");
    $("rating-de-enabled").checked =
        opts.sstRatings.options.countries.indexOf("DE") >= 0;
    $("rating-us-enabled").checked =
        opts.sstRatings.options.countries.indexOf("US") >= 0;
    setFeatureOptionsState($("rating-options"), opts.sstRatings.enabled);
}

function commitRatingCountries() {
    opts.sstRatings.options.countries = [
        $("rating-de-enabled").checked ? "DE" : "",
        $("rating-us-enabled").checked ? "US" : ""
    ].filter(Boolean);
    saveOpts();
    syncRatingControls();
    // Hiding is immediate state work (the CSS then performs the exit transition).
    // Do not leave a stale badge up while a replacement resolver request settles.
    renderRatingBadges(renderGenerations.backdrop);
    updateBackdrop();
}
function commitRatingsEnabled() {
    opts.sstRatings.enabled = $("ratings-enabled").checked;
    saveOpts();
    syncRatingControls();
    if (sstRatingsEnabled()) prepareRatingTrackVisibility();
    else cancelRatingTrackVisibility();
    renderRatingBadges(renderGenerations.backdrop);
    updateBackdrop();
}
$("ratings-enabled").addEventListener("change", commitRatingsEnabled);
$("rating-de-enabled").addEventListener("change", commitRatingCountries);
$("rating-us-enabled").addEventListener("change", commitRatingCountries);

// --- poll engine (ported from lib/coverfetch.cpp) ----------------------------
var MIN_POLL = 5, MAX_POLL = 3600, ERR_RETRY = 8, ERR_CAP = 60, REQ_TIMEOUT = 20000;
var BOUNDARY_WATCH_SECONDS = 10, BOUNDARY_POLL_SECONDS = 2, BOUNDARY_GRACE_SECONDS = 15;
var COMING_NEXT_SECONDS = 10;
var pollTimer = null, tickTimer = null, inflight = null, errBackoff = ERR_RETRY;
var retryAt = 0, pollActive = null, lastSuccessfulPollAt = 0;
var boundaryTrackToken = "", boundaryExpectedEndAt = 0;
var shownUrl = "", loadingCoverUrl = "", remAnchor = -1, remAnchorAt = 0;
var coverRetryUrl = "", coverRetryFailures = 0, coverRetryTimer = null;
var nextTrack = null, nextTrackToken = "", nextTrackVersion = 0;
var nextCreditRequest = null, comingNextClearTimer = null, comingNextDisplayedVersion = 0;
var queuedTracks = [], queuedTrackStore = Object.create(null), queuedTrackStoreSize = 0;
var queuePrefetchTimer = null, queuePrefetchRequest = null, queuePrefetchNextAt = 0;
var queuePrefetchCursor = 0, queuePrefetchUrgent = false;
var queueRefreshRequest = null;
var QUEUE_PREFETCH_STAGGER_MS = 60 * 1000, QUEUED_TRACK_STORE_LIMIT = 64;
var queueSnapshotReady = false;

function trustedAlbumPageUrl(raw) {
    if (typeof raw !== "string" || !raw || /[\u0000-\u001F\u007F]/.test(raw)) return "";
    try {
        var url = new URL(raw);
        var host = station().host.toLowerCase();
        if (url.protocol !== "https:" || (url.port && url.port !== "443")
                || url.username || url.password || url.hash
                || url.hostname.toLowerCase() !== host || url.pathname !== "/modules.php"
                || url.searchParams.get("name") !== "Album"
                || !url.searchParams.get("asin")) return "";
        return url.href;
    } catch (error) { return ""; }
}

function cancelNextCredit(resetAttempt) {
    if (!nextCreditRequest) return;
    nextCreditRequest.ctl.abort();
    clearTimeout(nextCreditRequest.kill);
    if (resetAttempt && nextCreditRequest.track
            && nextCreditRequest.version === nextCreditRequest.track.version) {
        nextCreditRequest.track.creditAttempted = false;
        nextCreditRequest.track.creditPromise = null;
    }
    nextCreditRequest = null;
}

function nextTrackFromQueue(value, occurrence) {
    if (!value || typeof value !== "object" || value instanceof Array) return null;
    var album = htmlDecode(value.Album).trim();
    if (!album) return null;
    var track = htmlDecode(value.Track).trim();
    var artist = htmlDecode(value.Artist).trim();
    var albumUrl = trustedAlbumPageUrl(value.SiteLink);
    var coverUrl = sizedCoverUrl(value.CoverLink);
    var tintUrl = trustedCoverUrl(value.ThumbnailLink) || trustedCoverUrl(value.CoverLink);
    var queueKey = [station().host, album, track, trustedCoverUrl(value.CoverLink), albumUrl,
        occurrence || 0].join("\n");
    return {
        queueKey: queueKey,
        album: album,
        displayAlbum: unrotateTitleArticle(album),
        track: track,
        artist: artist,
        artistSource: artist ? "queue" : "",
        albumUrl: albumUrl,
        coverUrl: coverUrl,
        tintUrl: tintUrl,
        lengthSeconds: Math.max(0, Math.floor((parseInt(value.Length, 10) || 0) / 1000)),
        coverPrepared: false,
        tintAttempted: false,
        creditAttempted: false,
        creditPromise: null,
        backdropPrefetchKey: "",
        art: null,
        backdropImage: null,
        lastSeen: Date.now(),
    };
}

function setNextTrack(value) {
    var parsed = value && value.queueKey ? value : nextTrackFromQueue(value, 0);
    var token = parsed ? parsed.queueKey : "";
    if (token === nextTrackToken) return nextTrack;
    cancelNextCredit(true);
    nextTrackToken = token;
    var version = ++nextTrackVersion;
    nextTrack = parsed;
    if (nextTrack) {
        nextTrack.version = version;
        if (typeof nextTrack.creditAttempted !== "boolean") nextTrack.creditAttempted = false;
        if (!("creditPromise" in nextTrack)) nextTrack.creditPromise = null;
    }
    renderComingNext();
    maybeResolveNextArtist();
    return nextTrack;
}

function trimQueuedTrackStore() {
    if (queuedTrackStoreSize <= QUEUED_TRACK_STORE_LIMIT) return;
    var active = new Set(queuedTracks.map(function (entry) { return entry.queueKey; }));
    Object.keys(queuedTrackStore).sort(function (left, right) {
        return queuedTrackStore[left].lastSeen - queuedTrackStore[right].lastSeen;
    }).some(function (key) {
        if (queuedTrackStoreSize <= QUEUED_TRACK_STORE_LIMIT) return true;
        if (active.has(key)) return false;
        delete queuedTrackStore[key];
        queuedTrackStoreSize--;
        return false;
    });
}

function reconcileQueuedTracks(values) {
    var occurrences = Object.create(null);
    queuedTracks = (values instanceof Array ? values : []).map(function (value) {
        var base = nextTrackFromQueue(value, 0);
        if (!base) return null;
        var occurrence = occurrences[base.queueKey] || 0;
        occurrences[base.queueKey] = occurrence + 1;
        var parsed = occurrence ? nextTrackFromQueue(value, occurrence) : base;
        var entry = queuedTrackStore[parsed.queueKey];
        if (!entry) {
            entry = parsed;
            queuedTrackStore[entry.queueKey] = entry;
            queuedTrackStoreSize++;
        } else {
            entry.lastSeen = Date.now();
            entry.lengthSeconds = parsed.lengthSeconds;
            if (parsed.artist) {
                entry.artist = parsed.artist;
                entry.artistSource = "queue";
            }
        }
        return entry;
    }).filter(Boolean);
    queueSnapshotReady = true;
    setNextTrack(queuedTracks[0] || null);
    renderComingNext();
    trimQueuedTrackStore();
    scheduleQueuePrefetch(true);
}

function validArtist(value) {
    return typeof value === "string" && value.trim() && value.length <= 180
        && !/[\u0000-\u001F\u007F]/.test(value);
}

function queuedArtistIsNeeded() {
    return !!opts.comingNext
        || (stationSupports(CAPABILITY_SOUNDTRACK_MEDIA)
            && (sstBackdropsEnabled() || sstRatingsEnabled()));
}

function resolveQueuedArtist(tracked) {
    if (!queuedArtistIsNeeded() || !tracked || tracked.artist || !tracked.albumUrl)
        return Promise.resolve(tracked ? tracked.artist : "");
    if (tracked.creditPromise) return tracked.creditPromise;
    if (tracked.creditAttempted) return Promise.resolve("");
    tracked.creditAttempted = true;
    var version = tracked.version;
    var ctl = new AbortController();
    var request = {
        ctl: ctl,
        track: tracked,
        version: version,
        kill: setTimeout(function () { ctl.abort(); }, REQ_TIMEOUT),
    };
    nextCreditRequest = request;
    var url = new URL(CREDIT_API_URL, location.href);
    url.searchParams.set("album", tracked.album);
    url.searchParams.set("url", tracked.albumUrl);
    var creditPromise;
    creditPromise = fetch(url, { signal: ctl.signal }).then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
    }).then(function (body) {
        if (nextCreditRequest !== request || tracked.version !== version) return "";
        if (body && validArtist(body.artist)) {
            tracked.artist = body.artist.trim();
            tracked.artistSource = "album-page";
            if (nextTrack === tracked) renderComingNext();
        }
        return tracked.artist;
    }).catch(function () {
        if (tracked.creditPromise === creditPromise) tracked.creditAttempted = false;
        return ""; // album credit is best-effort; album-only remains useful
    })
        .finally(function () {
            clearTimeout(request.kill);
            if (nextCreditRequest === request) nextCreditRequest = null;
            if (tracked.creditPromise === creditPromise) tracked.creditPromise = null;
        });
    tracked.creditPromise = creditPromise;
    return creditPromise;
}

function maybeResolveNextArtist() {
    return resolveQueuedArtist(nextTrack);
}

function setComingNextContent() {
    comingNextAlbumEl.textContent = nextTrack ? nextTrack.displayAlbum : "";
    comingNextArtistEl.textContent = nextTrack ? nextTrack.artist : "";
    comingNextDisplayedVersion = nextTrack ? nextTrack.version : 0;
}

function clearComingNextContent() {
    if (comingNextEl.classList.contains("show")) return;
    clearTimeout(comingNextClearTimer);
    comingNextClearTimer = null;
    comingNextAlbumEl.textContent = "";
    comingNextArtistEl.textContent = "";
    comingNextDisplayedVersion = 0;
    renderComingNext();
}

function hideComingNext() {
    var wasShown = comingNextEl.classList.contains("show");
    comingNextEl.classList.remove("show");
    comingNextEl.setAttribute("aria-hidden", "true");
    if ((!wasShown && !comingNextAlbumEl.textContent) || comingNextClearTimer) return;
    var duration = reducedMotion.matches ? 0 : transitionTotalMs(comingNextEl);
    if (!duration) return clearComingNextContent();
    comingNextClearTimer = setTimeout(clearComingNextContent, duration + 50);
}

function renderComingNext() {
    var remaining = currentRemaining();
    var shouldShow = !!opts.comingNext && !!nextTrack
        && remaining >= 0 && remaining <= COMING_NEXT_SECONDS;
    if (!shouldShow) return hideComingNext();
    // If the queued track changed while the old card is exiting, let the old text
    // finish its fade before mounting the replacement.
    if (comingNextClearTimer && comingNextDisplayedVersion !== nextTrack.version) return;
    clearTimeout(comingNextClearTimer);
    comingNextClearTimer = null;
    setComingNextContent();
    comingNextEl.setAttribute("aria-hidden", "false");
    comingNextEl.classList.add("show");
}

function applyComingNextEnabled() {
    if (!opts.comingNext && !queuedArtistIsNeeded()) cancelNextCredit(true);
    else maybeResolveNextArtist();
    scheduleQueuePrefetch(true);
    renderComingNext();
}

function resetCoverRetry(url) {
    clearTimeout(coverRetryTimer);
    coverRetryTimer = null;
    coverRetryUrl = url || "";
    coverRetryFailures = 0;
}

function schedulePoll(seconds) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, seconds * 1000);
}
function scheduleHealthyPoll(trackToken, lengthSeconds, remaining, timingIsValid) {
    if (!timingIsValid || lengthSeconds <= 0) {
        boundaryTrackToken = "";
        boundaryExpectedEndAt = 0;
        schedulePoll(Math.min(MAX_POLL, Math.max(MIN_POLL, remaining)) + 1);
        return;
    }
    var candidateEnd = Date.now() + remaining * 1000;
    if (trackToken !== boundaryTrackToken) {
        boundaryTrackToken = trackToken;
        boundaryExpectedEndAt = candidateEnd;
    } else {
        // A later response may lose up to one second to feed rounding or network
        // delay. Never let that move an already-armed boundary watch backwards.
        boundaryExpectedEndAt = Math.min(boundaryExpectedEndAt, candidateEnd);
    }
    var untilEnd = boundaryExpectedEndAt - Date.now();
    var delaySeconds;
    if (untilEnd > BOUNDARY_WATCH_SECONDS * 1000) {
        delaySeconds = Math.max(1,
            Math.ceil(untilEnd / 1000 - BOUNDARY_WATCH_SECONDS));
    } else if (Date.now() <= boundaryExpectedEndAt + BOUNDARY_GRACE_SECONDS * 1000) {
        delaySeconds = BOUNDARY_POLL_SECONDS;
    } else {
        delaySeconds = MIN_POLL + 1;
    }
    schedulePoll(Math.min(MAX_POLL, delaySeconds));
}
function humanDelay(seconds) {
    if (seconds >= 60) return "1 minute";
    return seconds + " second" + (seconds === 1 ? "" : "s");
}
function renderRetryStatus() {
    if (retryAt <= 0) return;
    var seconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
    setStatus("Station not responding\nRetrying in " + humanDelay(seconds) + "…", "station");
}
function scheduleRetry(seconds) {
    retryAt = Date.now() + seconds * 1000;
    renderRetryStatus();
    schedulePoll(seconds);
}


async function poll() {
    clearTimeout(pollTimer);
    pollTimer = null;
    var wasRetry = retryAt > 0;
    retryAt = 0;
    if (wasRetry) setStatus("Contacting station…", "station");
    if (inflight) inflight.abort();
    const ctl = new AbortController();
    inflight = ctl;
    pollActive = ctl;
    const kill = setTimeout(function () { ctl.abort(); }, REQ_TIMEOUT);
    try {
        if (simulateStationFailure) throw new Error("Simulated station failure");
        var j;
        if (localNowPlayingPreview) {
            var previewTime = new Date().toISOString();
            j = {
                Album: localNowPlayingPreview.album,
                Track: localNowPlayingPreview.track,
                Artist: localNowPlayingPreview.artist,
                CoverLink: "",
                ThumbnailLink: "",
                Length: 0,
                PlayStart: previewTime,
                SystemTime: previewTime,
            };
        } else {
            const r = await fetch("https://" + station().host
                + "/soap/FM24sevenJSON.php?action=GetCurrentlyPlaying&_t=" + Date.now(),
                { signal: ctl.signal });
            if (!r.ok) throw new Error("HTTP " + r.status);
            j = await r.json();
        }
        if (ctl !== inflight) return; // superseded by a station switch
        if (!validNowPlaying(j)) throw new Error("Invalid now-playing response");
        errBackoff = ERR_RETRY;
        coverBox.classList.remove("station-outage");
        // remaining = Length(ms)/1000 - |SystemTime - PlayStart|; both stamps come
        // from the same server clock, so any timezone offset cancels in the diff.
        const lengthSec = Math.max(0, Math.floor((parseInt(j.Length, 10) || 0) / 1000));
        let elapsed = 0;
        const ps = Date.parse(j.PlayStart || ""), st = Date.parse(j.SystemTime || "");
        const timingIsValid = !isNaN(ps) && !isNaN(st);
        if (timingIsValid) elapsed = Math.abs(st - ps) / 1000;
        const remaining = Math.max(0, Math.floor(lengthSec - elapsed));
        remAnchor = lengthSec > 0 ? remaining : -1;
        remAnchorAt = Date.now();

        const album = htmlDecode(j.Album), displayAlbum = unrotateTitleArticle(album);
        const track = htmlDecode(j.Track), artist = htmlDecode(j.Artist);
        // ONE determination drives everything downstream: no trusted CoverLink means
        // a station ID, unregistered track, or rejected off-origin URL.
        // The same flag that swaps the cover for the station logo below also
        // vetoes the media-art lookup - a station ident is not a soundtrack, so its name must
        // not leak to a third party as a search. One source of truth, so the
        // logo and the veto can never disagree.
        const tintCover = trustedCoverUrl(j.ThumbnailLink) || trustedCoverUrl(j.CoverLink);
        const displayCover = sizedCoverUrl(j.CoverLink);
        const isStationId = !displayCover && !localNowPlayingPreview;
        const trackIdentityChanged = album !== currentAlbum || track !== currentTrack
            || isStationId !== stationIdActive;
        const prefetchedArt = trackIdentityChanged && !isStationId
            ? prefetchedArtForNowPlaying(album, track, displayCover) : undefined;
        // Prefer the feed's 40 px thumbnail for the whole-image colour mean. Keep
        // CoverLink as a compatibility fallback and the /500/ variant for display.
        updateCoverTint(isStationId ? "" : tintCover);
        if (album !== currentAlbum || track !== currentTrack || artist !== currentArtist
                || isStationId !== stationIdActive) {
            const metadataChanged = trackIdentityChanged || artist !== currentArtist;
            if (trackIdentityChanged) {
                setNextTrack(null);
                // If the outgoing movie backdrop hid its cover, keep that cover
                // suppressed while a backdrop miss fades away. showCover() releases
                // the hold only after the destination cover owns the front buffer.
                coverHiddenUntilCoverReady = stage.classList.contains("no-cover");
            }
            currentAlbum = album; currentTrack = track; currentArtist = artist;
            stationIdActive = isStationId;
            if (metadataChanged) prepareRatingTrackVisibility(trackIdentityChanged);
            // Promote the prepared queue result in the same generation that starts
            // current-track revalidation. With no valid result, null clears the old
            // track through the normal fade before the resolver response arrives.
            if (trackIdentityChanged) updateBackdrop(prefetchedArt || null);
            else updateBackdrop();
        }
        let title = displayAlbum;
        if (displayAlbum && track) title = displayAlbum + " - " + track;
        else if (track) title = track;
        if (title && lengthSec > 0)
            title += " (" + Math.floor(lengthSec / 60) + ":" + String(lengthSec % 60).padStart(2, "0") + ")";
        setInfo(title || "—", artist);

        const cover = isStationId ? station().logo : displayCover || station().logo;
        if (cover && cover !== shownUrl && cover !== loadingCoverUrl) showCover(cover);
        else if (trackIdentityChanged && cover === shownUrl && coverHiddenUntilCoverReady) {
            // The next cue can legitimately reuse an album cover. It is already the
            // destination image, so there is no pending buffer swap to release us.
            coverHiddenUntilCoverReady = false;
            updateCoverVisibility();
        }
        clearStatus("station");
        lastSuccessfulPollAt = Date.now();
        const trackToken = [album, track, isStationId ? "station" : displayCover].join("\n");
        if (localNowPlayingPreview) schedulePoll(MAX_POLL);
        else scheduleHealthyPoll(trackToken, lengthSec, remaining, timingIsValid);
        if (!localNowPlayingPreview && (trackIdentityChanged || !queueSnapshotReady))
            refreshQueue(); // fire-and-forget: one snapshot per confirmed track
    } catch (e) {
        if (ctl !== inflight) return;
        updateCoverTint("");
        coverBox.classList.add("station-outage");
        var outageCover = station().logo;
        if (outageCover && outageCover !== shownUrl && outageCover !== loadingCoverUrl)
            showCover(outageCover);
        scheduleRetry(errBackoff);
        // After the one-minute attempt, restart the short retry cycle.
        // Sequence: 8, 16, 32, 60 seconds, then 8 again.
        errBackoff = errBackoff >= ERR_CAP ? ERR_RETRY : Math.min(ERR_CAP, errBackoff * 2);
    } finally {
        clearTimeout(kill);
        if (pollActive === ctl) pollActive = null;
    }
}

function resynchronizeStationIfStale() {
    if (document.hidden || pollActive || retryAt > 0) return;
    if (lastSuccessfulPollAt
            && Date.now() - lastSuccessfulPollAt < BOUNDARY_POLL_SECONDS * 1000) return;
    poll();
}

var statusMessages = { station: "", audio: "", backdrop: "", general: "" };
var stageStatusClearTimer = null;
function renderStatus() {
    var text = statusMessages.station || statusMessages.audio
        || statusMessages.backdrop || statusMessages.general;
    statusEl.textContent = text;
    clearTimeout(stageStatusClearTimer);
    stageStatusClearTimer = null;
    if (statusMessages.station) {
        stageStatusEl.textContent = statusMessages.station;
        stageStatusEl.classList.add("show");
        return;
    }
    stageStatusEl.classList.remove("show");
    if (!stageStatusEl.textContent) return;
    var duration = reducedMotion.matches ? 0 : transitionTotalMs(stageStatusEl);
    if (!duration) {
        stageStatusEl.textContent = "";
        return;
    }
    stageStatusClearTimer = setTimeout(function () {
        if (!statusMessages.station) stageStatusEl.textContent = "";
        stageStatusClearTimer = null;
    }, duration);
}
function setStatus(text, source) {
    if (source) statusMessages[source] = text;
    else {
        for (var key in statusMessages) statusMessages[key] = "";
        statusMessages.general = text;
    }
    renderStatus();
}
function clearStatus(source) { setStatus("", source); }

function queueBackdropPrefetchKey(entry) {
    var providers = enabledMovieProviders();
    var includeArt = providers.length > 0;
    return JSON.stringify([
        includeArt ? providers : ["tmdb"],
        providers.indexOf("fanart") >= 0 ? opts.fanartKey : "",
        includeArt,
        sstRatingsEnabled(),
        entry && entry.artist || "",
    ]);
}

// A queue entry is only safe to promote when it is still the announced next track
// and its resolver result belongs to the current provider/rating configuration.
// Artist deliberately is not part of the identity check: the queue credit can be
// absent or provisional, while now-playing supplies the authoritative credit. Show
// the prepared result immediately, then let the regular resolver revalidate it.
function prefetchedArtForNowPlaying(album, track, coverUrl) {
    var entry = nextTrack;
    if (!entry || entry.album !== album || entry.track !== track
            || (entry.coverUrl && coverUrl && entry.coverUrl !== coverUrl)
            || entry.backdropPrefetchKey !== queueBackdropPrefetchKey(entry))
        return undefined;
    return entry.art;
}

function queuedTrackNeedsPrefetch(entry) {
    if (!entry) return false;
    if (entry.coverUrl && !entry.coverPrepared) return true;
    if (entry.tintUrl && !entry.tintAttempted
            && !Object.prototype.hasOwnProperty.call(coverTintCache, entry.tintUrl)) return true;
    if (queuedArtistIsNeeded() && !entry.artist && entry.albumUrl && !entry.creditAttempted)
        return true;
    return stationSupports(CAPABILITY_SOUNDTRACK_MEDIA)
        && (sstBackdropsEnabled() || sstRatingsEnabled())
        && entry.backdropPrefetchKey !== queueBackdropPrefetchKey(entry);
}

function nextQueuedPrefetch() {
    for (var offset = 0; offset < queuedTracks.length; offset++) {
        var index = (queuePrefetchCursor + offset) % queuedTracks.length;
        if (queuedTrackNeedsPrefetch(queuedTracks[index]))
            return { entry: queuedTracks[index], index: index };
    }
    return null;
}

async function prefetchQueuedTrack(entry, signal) {
    if (entry.coverUrl && !entry.coverPrepared) {
        entry.coverPrepared = true;
        entry.coverImage = new Image();
        entry.coverImage.src = entry.coverUrl;
    }
    var tintPromise = Promise.resolve();
    if (entry.tintUrl && !entry.tintAttempted
            && !Object.prototype.hasOwnProperty.call(coverTintCache, entry.tintUrl)) {
        entry.tintAttempted = true;
        tintPromise = serverCoverTint(entry.tintUrl, signal).then(function (tint) {
            coverTintCache[entry.tintUrl] = tint;
        }).catch(function () { /* current-track tint can retry independently */ });
    }

    await resolveQueuedArtist(entry);
    if (signal.aborted) return;
    if (stationSupports(CAPABILITY_SOUNDTRACK_MEDIA)
            && (sstBackdropsEnabled() || sstRatingsEnabled())) {
        var configKey = queueBackdropPrefetchKey(entry);
        if (entry.backdropPrefetchKey !== configKey) {
            entry.art = await movieArtFor(entry.album, entry.track, entry.artist,
                null, signal);
            if (entry.art && entry.art.url) {
                entry.backdropImage = new Image();
                entry.backdropImage.src = entry.art.url;
                if (entry === nextTrack) movieLayer.prepare(entry.art.url);
            }
            // Successful misses are cacheable. Transport/provider failures throw and
            // remain eligible for this minute-spaced worker to retry.
            entry.backdropPrefetchKey = configKey;
        }
    }
    await tintPromise;
}

function scheduleQueuePrefetch(prioritizeNext) {
    if (prioritizeNext) {
        queuePrefetchCursor = 0;
        queuePrefetchUrgent = true;
    }
    if (queuePrefetchRequest) return;
    clearTimeout(queuePrefetchTimer);
    queuePrefetchTimer = null;
    var candidate = nextQueuedPrefetch();
    if (!candidate) {
        queuePrefetchUrgent = false;
        return;
    }
    var immediate = queuePrefetchUrgent && candidate.index === 0;
    queuePrefetchUrgent = false;
    var delay = immediate ? 0 : Math.max(0, queuePrefetchNextAt - Date.now());
    queuePrefetchTimer = setTimeout(runQueuePrefetch, delay);
}

async function runQueuePrefetch() {
    clearTimeout(queuePrefetchTimer);
    queuePrefetchTimer = null;
    var candidate = nextQueuedPrefetch();
    if (!candidate) return;
    var ctl = new AbortController();
    var request = {
        ctl: ctl,
        entry: candidate.entry,
        kill: setTimeout(function () { ctl.abort(); }, REQ_TIMEOUT),
    };
    queuePrefetchRequest = request;
    try {
        await prefetchQueuedTrack(candidate.entry, ctl.signal);
    } catch (error) { /* queue prefetch is best-effort */ }
    finally {
        clearTimeout(request.kill);
        if (queuePrefetchRequest === request) queuePrefetchRequest = null;
        if (!queuePrefetchUrgent) {
            var completedIndex = queuedTracks.indexOf(candidate.entry);
            queuePrefetchCursor = completedIndex < 0 || !queuedTracks.length
                ? 0 : (completedIndex + 1) % queuedTracks.length;
        }
        queuePrefetchNextAt = Date.now() + QUEUE_PREFETCH_STAGGER_MS;
        scheduleQueuePrefetch(false);
    }
}

function resetQueuedTracks() {
    clearTimeout(queuePrefetchTimer);
    queuePrefetchTimer = null;
    if (queuePrefetchRequest) queuePrefetchRequest.ctl.abort();
    queuePrefetchRequest = null;
    if (queueRefreshRequest) queueRefreshRequest.ctl.abort();
    queueRefreshRequest = null;
    queuePrefetchNextAt = 0;
    queuePrefetchCursor = 0;
    queuePrefetchUrgent = false;
    queuedTracks = [];
    queueSnapshotReady = false;
    setNextTrack(null);
}

// Refresh the station queue, then let one self-rescheduling worker warm its
// covers, tints, credits and media results. The first entry is urgent; every
// remaining entry gets its own later cacheable GET instead of one mixed-TTL batch.
async function refreshQueue() {
    if (queueRefreshRequest) queueRefreshRequest.ctl.abort();
    var ctl = new AbortController();
    var requestedHost = station().host;
    var request = {
        ctl: ctl,
        host: requestedHost,
        kill: setTimeout(function () { ctl.abort(); }, REQ_TIMEOUT),
    };
    queueRefreshRequest = request;
    try {
        const r = await fetch("https://" + requestedHost
            + "/soap/FM24sevenJSON.php?action=GetQueue&_t=" + Date.now(),
            { signal: ctl.signal });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const queue = await r.json();
        if (queueRefreshRequest !== request || station().host !== requestedHost) return;
        reconcileQueuedTracks(queue);
    } catch (e) {
        // A timeout is a real queue failure and must not leave an old announcement
        // armed. A station switch nulls the request before aborting and is ignored.
        if (queueRefreshRequest === request && station().host === requestedHost)
            reconcileQueuedTracks([]);
    } finally {
        clearTimeout(request.kill);
        if (queueRefreshRequest === request) queueRefreshRequest = null;
    }
}

// --- cover display + transitions --------------------------------------------
// The box's data attributes ARE the display state: data-front names the visible
// buffer ("a" | "b"), data-fx the transition. CSS derives each img's opacity and
// rotation from the box, so JS never touches the imgs beyond loading their src -
// and before the first cover there simply is no data-front, so both stay hidden.
function showCover(url) {
    if (coverRetryUrl !== url) resetCoverRetry(url);
    if (coverRetryTimer) return;
    var generation = nextRenderGeneration("cover");
    loadingCoverUrl = url;
    var back = (coverBox.dataset.front === "a") ? imgB : imgA;
    preloadImage(url, function () {
        if (!renderIsCurrent("cover", generation)) return;
        loadingCoverUrl = "";
        resetCoverRetry(url);
        shownUrl = url;
        back.src = url;
        blurLayer.show(url, generation); // poster backdrop, crossfaded in poster layout
        var effect = contentTransitionEffect();
        stage.style.setProperty("--fade-ms", contentTransitionDuration() + "ms");
        var fx = ["none", "fade", "fliph", "flipv"][effect];
        if (coverBox.dataset.fx !== fx) {
            // A CHANGE of effect must teleport into the new parked poses, never
            // animate: with the flip freshly active, the back buffer would still be
            // ANIMATING toward its 90° park when the front flip retargets it to 0° -
            // a 0°→0° no-op, and the new cover just pops in statically. One
            // transition-less flush (data-warp) commits the poses instantly.
            coverBox.dataset.warp = "";
            coverBox.dataset.fx = fx;
            void coverBox.offsetWidth; // commit the parked poses without transitions
            delete coverBox.dataset.warp;
        }
        // The effect must be committed BEFORE the buffer flip: transitions fire on a
        // property change under an active transition, not on one applied after it.
        void coverBox.offsetWidth;
        coverBox.dataset.front = (back === imgA) ? "a" : "b";
        // A track or station switch can begin while the cover is hidden behind a
        // media backdrop. Keep the old cover suppressed until this destination image
        // has replaced it, then let the coverbox fade back in with the new art.
        coverHiddenUntilCoverReady = false;
        updateCoverVisibility();
    }, function () {
        if (!renderIsCurrent("cover", generation)) return;
        loadingCoverUrl = "";
        coverRetryFailures++;
        // After the bounded exponential burst, keep one sparse recovery probe alive.
        // This avoids hammering a broken endpoint without blacklisting a cover forever.
        var delay = coverRetryFailures > COVER_RETRY_LIMIT
            ? COVER_RETRY_COOLDOWN
            : COVER_RETRY_DELAY * Math.pow(2, coverRetryFailures - 1);
        coverRetryTimer = setTimeout(function () {
            coverRetryTimer = null;
            if (renderIsCurrent("cover", generation)
                    && !loadingCoverUrl && shownUrl !== url) showCover(url);
        }, delay);

    });
}

// --- experimental: movie/TV/game backdrops ------------------------------------
// Poster mode only: the media work's real backdrop, sharp and dimmed, replaces the
// blurred cover behind the artwork. The normalized soundtrack title usually resembles the movie,
// TV or game title, so a catalog can match it. A
// per-title cache (negative results too) keeps it to one request per work. A failed
// image gets a short bounded retry burst before the existing manual retry appears;
// meanwhile the player falls back to the blurred cover.
var movieLayer = makeLayer($("movieA"), $("movieB"), "backdrop");
var movieShown = false; // a screen backdrop is currently visible (drives hide-cover)
var coverHiddenUntilCoverReady = false;
var backdropImageRetryTimer = null;
function newMovieCache() { return Object.create(null); }
var movieCaches = Object.create(null);
var backdropRequest = null;

function movieCacheFor(providers, includeArt, includeRatings) {
    // Provider configuration is part of the resolver result. Keep its title cache
    // separate so switching back to a configuration can reuse both hits and misses.
    const configKey = JSON.stringify([
        providers,
        providers.indexOf("fanart") >= 0 ? opts.fanartKey : "",
        includeArt,
        includeRatings
    ]);
    if (!Object.prototype.hasOwnProperty.call(movieCaches, configKey))
        movieCaches[configKey] = newMovieCache();
    return movieCaches[configKey];
}

function cancelBackdropRequest() {
    if (!backdropRequest) return;
    const request = backdropRequest;
    backdropRequest = null;
    clearTimeout(request.kill);
    request.ctl.abort();
}

// Experimental: while a media backdrop is showing, the cover can step aside and let
// the backdrop be the star. A handoff hold can briefly outlive that backdrop so its
// hidden, outgoing cover cannot leak through before the destination cover is ready.
function updateCoverVisibility() {
    stage.classList.toggle("no-cover",
        !!(coverHiddenUntilCoverReady
            || (opts.sstBackdrops.options.cover === "hide" && movieShown)));
}
var currentAlbum = "", currentTrack = "", currentArtist = "", stationIdActive = false;
var localBackdropDiagnostics = Object.create(null), localBackdropDiagnosticOrder = [];

function localBackdropDiagnosticKey(album, track, artist) {
    return [album, track, artist].join("\n");
}

function rememberLocalBackdropDiagnostic(request, result) {
    if (!isLocalPlayer || !result || typeof result !== "object") return;
    var media = result.media && typeof result.media === "object" ? result.media : null;
    var diagnostic = {
        request: {
            album: request.album,
            track: request.track,
            artist: request.artist,
            providers: request.providers.slice(),
            includeArt: request.includeArt,
            includeRatings: request.includeRatings,
        },
        result: {
            media: media ? { id: media.id, title: media.title, type: media.type } : null,
            backdrop: typeof result.backdrop === "string" ? result.backdrop : null,
            source: typeof result.source === "string" ? result.source : null,
        },
    };
    var key = localBackdropDiagnosticKey(request.album, request.track, request.artist);
    if (!Object.prototype.hasOwnProperty.call(localBackdropDiagnostics, key))
        localBackdropDiagnosticOrder.push(key);
    localBackdropDiagnostics[key] = diagnostic;
    while (localBackdropDiagnosticOrder.length > 20)
        delete localBackdropDiagnostics[localBackdropDiagnosticOrder.shift()];
}

var SERVER_ART_UNAVAILABLE = {};

async function fetchResolverJson(url, signal, cacheMode) {
    var response;
    var init = {};
    if (signal) init.signal = signal;
    if (cacheMode) init.cache = cacheMode;
    try { response = await fetch(url.href, init); }
    catch (error) {
        if (error && error.name === "AbortError") throw error;
        throw SERVER_ART_UNAVAILABLE;
    }
    if (!response.ok) throw SERVER_ART_UNAVAILABLE;
    try { return await response.json(); }
    catch (error) { throw SERVER_ART_UNAVAILABLE; }
}

function enabledMovieProviders() {
    return opts.sstBackdrops.options.providers.filter(function (id) {
        return !!ART_PROVIDER_BY_ID[id];
    });
}

function trustedResolvedBackdrop(raw, source) {
    if (typeof raw !== "string" || !raw) return "";
    try {
        var url = new URL(raw);
        var host = url.hostname.toLowerCase();
        var trusted = source === "tmdb"
            ? host === "image.tmdb.org"
            : source === "fanart"
                ? (host === "fanart.tv" || host.endsWith(".fanart.tv"))
                : source === "steamgriddb" && host === "cdn2.steamgriddb.com";
        return trusted && url.protocol === "https:" && !url.username && !url.password
            ? url.href : "";
    } catch (e) { return ""; }
}

var WIKIMEDIA_RATING_LOGOS = Object.freeze({
    "DE|FSK|0": "https://upload.wikimedia.org/wikipedia/commons/1/17/FSK_0.svg",
    "DE|FSK|6": "https://upload.wikimedia.org/wikipedia/commons/b/b0/FSK_ab_6_logo.svg",
    "DE|FSK|12": "https://upload.wikimedia.org/wikipedia/commons/6/6e/FSK_12.svg",
    "DE|FSK|16": "https://upload.wikimedia.org/wikipedia/commons/3/30/FSK_16.svg",
    "DE|FSK|18": "https://upload.wikimedia.org/wikipedia/commons/5/5d/FSK_18.svg",
    "US|MPA|G": "https://upload.wikimedia.org/wikipedia/commons/4/4f/MPA_G_RATING.svg",
    "US|MPA|PG": "https://upload.wikimedia.org/wikipedia/commons/9/9a/MPA_PG_RATING.svg",
    "US|MPA|PG-13": "https://upload.wikimedia.org/wikipedia/commons/9/98/MPA_PG-13_RATING.svg",
    "US|MPA|R": "https://upload.wikimedia.org/wikipedia/commons/6/6b/MPA_R_RATING.svg",
    "US|MPA|NC-17": "https://upload.wikimedia.org/wikipedia/commons/c/c0/MPA_NC-17_RATING.svg",
    "US|TV Parental Guidelines|TV-Y": "https://upload.wikimedia.org/wikipedia/commons/2/25/TV-Y_icon.svg",
    "US|TV Parental Guidelines|TV-Y7": "https://upload.wikimedia.org/wikipedia/commons/5/5a/TV-Y7_icon.svg",
    "US|TV Parental Guidelines|TV-Y7-FV": "https://upload.wikimedia.org/wikipedia/commons/a/ac/TV-Y7-FV_icon.svg",
    "US|TV Parental Guidelines|TV-G": "https://upload.wikimedia.org/wikipedia/commons/5/5e/TV-G_icon.svg",
    "US|TV Parental Guidelines|TV-PG": "https://upload.wikimedia.org/wikipedia/commons/9/9a/TV-PG_icon.svg",
    "US|TV Parental Guidelines|TV-14": "https://upload.wikimedia.org/wikipedia/commons/c/c3/TV-14_icon.svg",
    "US|TV Parental Guidelines|TV-MA": "https://upload.wikimedia.org/wikipedia/commons/3/34/TV-MA_icon.svg",
});
var TV_CONTENT_DESCRIPTORS = Object.freeze({
    "TV-Y7": Object.freeze(["FV"]),
    "TV-Y7-FV": Object.freeze(["FV"]),
    "TV-PG": Object.freeze(["D", "L", "S", "V"]),
    "TV-14": Object.freeze(["D", "L", "S", "V"]),
    "TV-MA": Object.freeze(["L", "S", "V"]),
});
var TV_CONTENT_DESCRIPTOR_LABELS = Object.freeze({
    D: "suggestive dialogue",
    L: "coarse or crude language",
    S: "sexual situations",
    V: "violence",
    FV: "fantasy violence",
});

function trustedRatingLogo(raw, country, system, rating) {
    var expected = WIKIMEDIA_RATING_LOGOS[[country, system, rating].join("|")];
    if (typeof raw !== "string" || raw !== expected) return "";
    try {
        var url = new URL(raw);
        return url.protocol === "https:" && url.hostname === "upload.wikimedia.org"
            && !url.username && !url.password && !url.search && !url.hash
            && url.href === expected ? url.href : "";
    } catch (e) { return ""; }
}

function trustedTvContentDescriptors(raw, rating) {
    var allowed = TV_CONTENT_DESCRIPTORS[rating] || [];
    if (!allowed.length) return [];
    var supplied = (raw instanceof Array ? raw : []).reduce(function (values, value) {
        if (typeof value === "string") values[value.trim().toUpperCase()] = true;
        return values;
    }, Object.create(null));
    if (rating === "TV-Y7-FV") supplied.FV = true;
    return allowed.filter(function (descriptor) { return supplied[descriptor]; });
}

function trustedCertifications(raw) {
    if (!(raw instanceof Array)) return [];
    var seen = Object.create(null);
    return raw.reduce(function (certifications, entry) {
        if (!entry || (entry.country !== "DE" && entry.country !== "US")
                || seen[entry.country]) return certifications;
        var rating = typeof entry.rating === "string" ? entry.rating.trim() : "";
        var label = typeof entry.label === "string" ? entry.label.trim() : "";
        var system = typeof entry.system === "string" ? entry.system.trim() : "";
        if (!rating || rating.length > 32 || !label || label.length > 40
                || !system || system.length > 40
                || /[\u0000-\u001F\u007F]/.test(rating + label + system)) return certifications;
        if (entry.country === "DE" && (system !== "FSK"
                || ["0", "6", "12", "16", "18"].indexOf(rating) < 0)) return certifications;
        if (entry.country === "US" && system !== "MPA"
                && system !== "TV Parental Guidelines") return certifications;
        var descriptors = entry.country === "US" && system === "TV Parental Guidelines"
            ? trustedTvContentDescriptors(entry.descriptors, rating) : [];
        var descriptorLabel = descriptors.map(function (descriptor) {
            return descriptor + ": " + TV_CONTENT_DESCRIPTOR_LABELS[descriptor];
        }).join("; ");
        seen[entry.country] = true;
        certifications.push({
            country: entry.country,
            rating: rating,
            label: label,
            system: system,
            logo: trustedRatingLogo(entry.logo, entry.country, system, rating),
            descriptors: descriptors,
            accessibleLabel: (entry.country === "DE" ? "Germany: " : "United States: ")
                + label + (descriptorLabel ? "; content descriptors: " + descriptorLabel : ""),
        });
        return certifications;
    }, []);
}

function validTint(value) {
    return value instanceof Array && value.length === 3
        && value.every(function (channel) {
            return typeof channel === "number" && isFinite(channel)
                && channel >= 0 && channel <= 255;
        }) ? value.map(function (channel) { return Math.round(channel); }) : null;
}

var coverTintCache = Object.create(null);
var coverTintUrl = "", coverTintRequest = null;
var currentCoverTint = [255, 255, 255], currentMovieTint = null;

function cancelCoverTintRequest() {
    if (!coverTintRequest) return;
    coverTintRequest.ctl.abort();
    clearTimeout(coverTintRequest.kill);
    coverTintRequest = null;
}

function applyPreferredPlayerTint() {
    setPlayerTint(currentMovieTint || currentCoverTint);
}

async function serverCoverTint(coverUrl, signal) {
    if (!TINT_API_URL) throw SERVER_ART_UNAVAILABLE;
    var url;
    try {
        url = new URL(TINT_API_URL, location.href);
        url.searchParams.set("url", coverUrl);
    } catch (e) { throw SERVER_ART_UNAVAILABLE; }

    var body = await fetchResolverJson(url, signal);
    var tint = body && validTint(body.tint);
    if (!tint) throw SERVER_ART_UNAVAILABLE;
    return tint;
}

function updateCoverTint(nextUrl) {
    nextUrl = nextUrl || "";
    if (nextUrl === coverTintUrl) return;
    coverTintUrl = nextUrl;
    const generation = nextRenderGeneration("tint");
    cancelCoverTintRequest();
    if (!nextUrl) {
        currentCoverTint = [255, 255, 255];
        applyPreferredPlayerTint();
        return;
    }
    if (Object.prototype.hasOwnProperty.call(coverTintCache, nextUrl)) {
        currentCoverTint = coverTintCache[nextUrl];
        applyPreferredPlayerTint();
        return;
    }

    const ctl = new AbortController();
    const request = {
        ctl: ctl,
        kill: setTimeout(function () { ctl.abort(); }, REQ_TIMEOUT)
    };
    coverTintRequest = request;
    serverCoverTint(nextUrl, ctl.signal).then(function (tint) {
        if (!renderIsCurrent("tint", generation) || coverTintUrl !== nextUrl) return;
        coverTintCache[nextUrl] = tint;
        currentCoverTint = tint;
        applyPreferredPlayerTint();
    }).catch(function () {
        if (!renderIsCurrent("tint", generation) || coverTintUrl !== nextUrl) return;
        currentCoverTint = [255, 255, 255];
        applyPreferredPlayerTint();
    }).finally(function () {
        clearTimeout(request.kill);
        if (coverTintRequest === request) coverTintRequest = null;
    });
}

async function serverMovieArt(album, track, artist, providers, includeArt, includeRatings,
    signal, cacheMode) {
    if (!BACKDROP_API_URL) throw SERVER_ART_UNAVAILABLE;
    var url;
    try {
        url = new URL(BACKDROP_API_URL, location.href);
        url.searchParams.set("album", album);
        if (track) url.searchParams.set("track", track);
        if (artist) url.searchParams.set("artist", artist);
        url.searchParams.set("providers", providers.join(","));
        if (!includeArt) url.searchParams.set("art", "0");
        if (includeRatings) url.searchParams.set("ratings", "DE,US");
        if (opts.fanartKey && providers.indexOf("fanart") >= 0)
            url.searchParams.set("client_key", opts.fanartKey);
    } catch (e) { throw SERVER_ART_UNAVAILABLE; }

    var body = await fetchResolverJson(url, signal, cacheMode);
    rememberLocalBackdropDiagnostic({
        album: album,
        track: track,
        artist: artist,
        providers: providers,
        includeArt: includeArt,
        includeRatings: includeRatings,
    }, body);
    if (isLocalPlayer && typeof console !== "undefined"
            && typeof console.info === "function") {
        console.info("[backdrop resolver]", {
            request: {
                album: album,
                track: track,
                artist: artist,
                providers: providers,
                includeArt: includeArt,
                includeRatings: includeRatings,
            },
            result: body,
        });
    }
    if (!body || typeof body !== "object") return null;
    var certifications = trustedCertifications(body.certifications);
    var resolved = body.backdrop ? trustedResolvedBackdrop(body.backdrop, body.source) : "";
    if (body.backdrop && !resolved) throw SERVER_ART_UNAVAILABLE;
    return resolved || certifications.length ? {
        url: resolved,
        tint: resolved ? validTint(body.tint) : null,
        source: resolved ? body.source : null,
        certifications: certifications,
    } : null;
}

function setPlayerTint(tint) {
    var rgb = validTint(tint) || [255, 255, 255];
    stage.style.setProperty("--player-tint",
        "rgb(" + rgb[0] + ", " + rgb[1] + ", " + rgb[2] + ")");
}

function mergeMovieArt(authoritative, fallback) {
    if (!authoritative) return fallback || null;
    if (!fallback) return authoritative;
    var hasAuthoritativeBackdrop = !!authoritative.url;
    return {
        url: authoritative.url || fallback.url,
        tint: hasAuthoritativeBackdrop ? authoritative.tint : fallback.tint,
        source: hasAuthoritativeBackdrop ? authoritative.source : fallback.source,
        certifications: authoritative.certifications && authoritative.certifications.length
            ? authoritative.certifications : fallback.certifications || [],
    };
}

function cancelBackdropImageRetry() {
    clearTimeout(backdropImageRetryTimer);
    backdropImageRetryTimer = null;
}

function setMovieBackdrop(art, generation, retryFailures) {
    if (!renderIsCurrent("backdrop", generation)) return;
    const isAutomaticRetry = typeof retryFailures === "number";
    if (!isAutomaticRetry) cancelBackdropImageRetry();
    if (!art || !art.url) {
        movieLayer.hide();
        movieShown = false;
        currentMovieTint = null;
        applyPreferredPlayerTint();
        updateCoverVisibility();
        return;
    }
    // Tint starts its CSS transition while the image preloads, so it arrives with the
    // backdrop instead of snapping after the image has already appeared.
    currentMovieTint = validTint(art.tint);
    applyPreferredPlayerTint();
    movieLayer.show(art.url, generation,
        function () {
            cancelBackdropImageRetry();
            setBackdropErrorState("");
            movieShown = true;
            updateCoverVisibility();
        },
        function () {
            movieLayer.hide();
            movieShown = false;
            currentMovieTint = null;
            applyPreferredPlayerTint();
            updateCoverVisibility();
            const failures = (retryFailures || 0) + 1;
            if (failures <= BACKDROP_RETRY_LIMIT) {
                backdropImageRetryTimer = setTimeout(function () {
                    backdropImageRetryTimer = null;
                    setMovieBackdrop(art, generation, failures);
                }, BACKDROP_RETRY_DELAY * Math.pow(2, failures - 1));
            } else {
                setBackdropErrorState("error");
            }
        });
}

function setBackdropErrorState(state) {
    if (state === "error") {
        backdropErrorTextEl.textContent = "Backdrop artwork couldn’t be loaded.";
        backdropRetryEl.disabled = false;
    } else if (state === "retrying") {
        backdropErrorTextEl.textContent = "Loading backdrop artwork…";
        backdropRetryEl.disabled = true;
    }
    backdropErrorEl.classList.toggle("show", !!state);
    backdropErrorEl.setAttribute("aria-hidden", state ? "false" : "true");
}

function requestBackdrop(cacheMode, prefetchedArt) {
    const hasPrefetchedResult = arguments.length > 1;
    const generation = nextRenderGeneration("backdrop");
    cancelBackdropRequest();
    cancelBackdropImageRetry();
    // Artwork and ratings share the resolver, but not their visible state. If artwork
    // is switched off while ratings stay enabled, start the backdrop fade immediately
    // instead of leaving it visible until that ratings-only request settles.
    if (!sstBackdropsEnabled()) setMovieBackdrop(null, generation);
    if (cacheMode === "reload" && sstBackdropsEnabled()) {
        setStatus("Loading backdrop artwork…", "backdrop");
        setBackdropErrorState("retrying");
    } else {
        clearStatus("backdrop");
        setBackdropErrorState("");
    }
    // The station-ID flag set by poll() (the one that also picks the logo): never a
    // movie, so no API call - and no leftover backdrop behind the station logo.
    if (stationIdActive || (!sstBackdropsEnabled() && !sstRatingsEnabled())) {
        setMovieBackdrop(null, generation);
        setRatings([], generation);
        return;
    }
    const mediaCapability = stationCapability(CAPABILITY_SOUNDTRACK_MEDIA);
    if (!mediaCapability || typeof mediaCapability.resolver !== "function") {
        setMovieBackdrop(null, generation);
        setRatings([], generation);
        return;
    } // no media source
    if (hasPrefetchedResult) {
        setMovieBackdrop(sstBackdropsEnabled() ? prefetchedArt : null, generation);
        setRatings(prefetchedArt && prefetchedArt.certifications || [], generation);
    }
    const ctl = new AbortController();
    const request = {
        ctl: ctl,
        kill: setTimeout(function () { ctl.abort(); }, REQ_TIMEOUT)
    };
    backdropRequest = request;
    Promise.resolve(mediaCapability.resolver(generation, ctl.signal, cacheMode,
        hasPrefetchedResult ? prefetchedArt : undefined)).then(settled, settled);
    function settled() {
        clearTimeout(request.kill);
        if (backdropRequest === request) backdropRequest = null;
    }
}

function updateBackdrop(prefetchedArt) {
    if (arguments.length) requestBackdrop(undefined, prefetchedArt);
    else requestBackdrop();
    scheduleQueuePrefetch(true);
}
function retryBackdrop() { requestBackdrop("reload"); }

// Resolve only through the project endpoint. The per-title cache stores misses too;
// endpoint failures stay uncached so a later poll or option change can retry.
async function movieArtFor(album, track, artist, generation, signal, cacheMode) {
    const providers = enabledMovieProviders();
    const includeArt = sstBackdropsEnabled() && providers.length > 0;
    const includeRatings = sstRatingsEnabled();
    const requestedProviders = includeArt ? providers : ["tmdb"];
    if ((generation !== null && !renderIsCurrent("backdrop", generation)) || !album
            || (!includeArt && !includeRatings)) return null;
    const cache = movieCacheFor(requestedProviders, includeArt, includeRatings);
    const titleCacheKey = album + "\n" + track + "\n";
    const cacheKey = titleCacheKey + artist;
    if (cacheMode !== "reload" && Object.prototype.hasOwnProperty.call(cache, cacheKey))
        return cache[cacheKey];
    // Every artistless result is provisional. Artist may turn a miss into a strict
    // composer-credit match or disambiguate multiple exact TV titles, so the
    // authoritative current-playing artist always receives its own resolver lookup.

    const art = await serverMovieArt(album, track, artist, requestedProviders,
        includeArt, includeRatings, signal, cacheMode);
    if (generation !== null && !renderIsCurrent("backdrop", generation)) return null;
    cache[cacheKey] = art;
    return art;
}

async function resolveMovieBackdrop(generation, signal, cacheMode, prefetchedArt) {
    if (!renderIsCurrent("backdrop", generation)) return;
    try {
        const art = await movieArtFor(currentAlbum, currentTrack, currentArtist, generation, signal,
            cacheMode);
        if (!renderIsCurrent("backdrop", generation)) return;
        const renderedArt = mergeMovieArt(art, prefetchedArt);
        clearStatus("backdrop");
        setBackdropErrorState("");
        setMovieBackdrop(sstBackdropsEnabled() ? renderedArt : null, generation);
        setRatings(renderedArt && renderedArt.certifications || [], generation);
    } catch (e) {
        if (!renderIsCurrent("backdrop", generation)) return;
        if (prefetchedArt) {
            // Queue artwork is already validated and visible. A best-effort refinement
            // must never turn that successful state back into the cover or empty badges.
            clearStatus("backdrop");
            setBackdropErrorState("");
            setMovieBackdrop(sstBackdropsEnabled() ? prefetchedArt : null, generation);
            setRatings(prefetchedArt.certifications || [], generation);
            return;
        }
        if (sstBackdropsEnabled()
                && (e === SERVER_ART_UNAVAILABLE || (e && e.name === "AbortError"))) {
            setStatus("Backdrop service is currently unavailable.", "backdrop");
            setBackdropErrorState("error");
        } else {
            setBackdropErrorState("");
        }
        setMovieBackdrop(null, generation); // any failure: quietly back to the blurred cover
        setRatings([], generation);
    }
}

// --- countdown ---------------------------------------------------------------
// Anchored once per poll, derived from the clock each tick - so a throttled
// background tab self-corrects the moment it becomes visible again.
var cells = [];
function currentRemaining() {
    if (remAnchor < 0) return -1;
    return Math.max(0, remAnchor - Math.floor((Date.now() - remAnchorAt) / 1000));
}
function fmt(s) { return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
function renderCountdown() {
    var mode = remainingTimeMode();
    var rem = mode ? currentRemaining() : -1;
    cdEl.classList.toggle("hidden", rem < 0);
    if (rem < 0) { cells = []; cdEl.textContent = ""; return; }
    var text = fmt(rem);
    if (cells.length !== text.length) { // rebuild cells when the width changes (10:00 -> 9:59)
        cdEl.textContent = "";
        cells = [];
        for (var i = 0; i < text.length; i++) {
            var cell = document.createElement("span");
            cell.className = "cd-cell";
            var cur = document.createElement("span");
            cur.className = "cd-cur";
            cur.textContent = text[i];
            cell.appendChild(cur);
            cdEl.appendChild(cell);
            cells.push({ el: cell, cur: cur, ch: text[i] });
        }
        return;
    }
    for (var k = 0; k < cells.length; k++) {
        var c = cells[k], ch = text[k];
        if (c.ch === ch) continue;
        c.ch = ch;
        if (mode !== "rolldown" || reducedMotion.matches || !c.cur.animate) {
            c.cur.textContent = ch;
            continue;
        }
        // Rolling digit via the Web Animations API: a ghost of the OLD digit slides up
        // and out while the real cell, already holding the NEW digit, slides in from
        // below. Animations can't leave residual styles behind, which is what broke the
        // class-based version (removing its class reverted the transform WITH the
        // transition still active, so the old digit slid back into view).
        var stale = c.el.querySelector(".cd-ghost"); // a paused background tab never
        if (stale) stale.remove();                   // fired onfinish - don't stack ghosts
        var ghost = document.createElement("span");
        ghost.className = "cd-ghost";
        ghost.textContent = c.cur.textContent;
        c.el.appendChild(ghost);
        c.cur.textContent = ch;
        ghost.animate(
            [{ transform: "translateY(0)" }, { transform: "translateY(-100%)" }],
            { duration: 350, easing: "ease" }
        ).onfinish = (function (g) { return function () { g.remove(); }; })(ghost);
        c.cur.animate(
            [{ transform: "translateY(100%)" }, { transform: "translateY(0)" }],
            { duration: 350, easing: "ease" }
        );
    }
}

// --- layout / sizing ---------------------------------------------------------
function applyLayout() {
    stage.classList.toggle("layout-poster", opts.layout === 1);
    stage.classList.toggle("layout-fill", opts.layout !== 1);
    // The countdown lives where each layout wants it - appendChild MOVES the node:
    // the info box's last row in poster, a corner overlay on the cover in fill.
    if (opts.layout === 1) document.querySelector(".info").appendChild(cdEl);
    else coverBox.appendChild(cdEl);
    sizeStage();
}
function sizeStage() {
    var r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // The cover box is the largest SQUARE that fits the stage (CSS alone can't cap a
    // square by both dimensions without breaking the aspect ratio on portrait
    // screens), leaving room below for the info box in poster layout. Because it is
    // sized off the stage, fullscreen scales everything with no extra rules.
    // The taller oscilloscope borrows a small amount of the poster cover's vertical
    // budget. A four-percent cover reduction creates a readable scope strip without
    // moving the title box or letting either element overlap it.
    var expandedOscilloscope = opts.spectrumEnabled
        && opts.analyzerType === "oscilloscope";
    var posterCoverFraction = expandedOscilloscope ? 0.555 : 0.58;
    var side = opts.layout === 1
        ? Math.min(r.height * posterCoverFraction, r.width * 0.86)
        : Math.min(r.height * 0.96, r.width * 0.96);
    coverBox.style.width = side + "px";
    coverBox.style.height = side + "px";
    // The compact analyser shares the cover's width in every stage size. The 80s
    // laser scene gives the cover visual depth with a .8 scale, so expose that final
    // width too; CSS animates between both values with the analyser's width transition.
    stage.style.setProperty("--cover-side", side + "px");
    stage.style.setProperty("--cover-depth-side", (side * 0.8) + "px");
    // The C++ renderer sizes everything off the cover's side; do the same, with the
    // poster's actual fractions: title 7.2%, artist 5.8% of the cover side. The
    // countdown sits BELOW the title in the hierarchy - it's a status row, not the
    // headline - so its steps start under the artist size and top out at the title's.
    stage.style.setProperty("--cover-radius", (side * opts.borderRadius / 1000) + "px");
    stage.style.setProperty("--title-size", Math.max(16, side * 0.072) + "px");
    stage.style.setProperty("--artist-size", Math.max(13, side * 0.058) + "px");
    var cdFrac = { small: 0.048, medium: 0.062, large: 0.08 }[
        opts.remainingTime.options.size];
    stage.style.setProperty("--cd-size", Math.max(12, side * cdFrac) + "px");
    // The grid fixes the info box's center. Re-center the cover in the space above
    // the box's visible top edge; when the box grows, CSS animates this small shift.
    // With 72/28 rows the simplified offset is 7% of stage height - 25% of box height.
    var infoRect = document.querySelector(".info").getBoundingClientRect();
    var infoHeight = infoRect.height;
    var coverShift = opts.layout === 1 ? r.height * 0.07 - infoHeight * 0.25 : 0;
    // Lift the slightly smaller cover as the scope expands. Its top has ample room in
    // the 72% artwork row; spending that room here creates a true 60px waveform lane
    // instead of squeezing the requested height back down to the old 48px strip.
    if (opts.layout === 1 && expandedOscilloscope)
        coverShift -= Math.min(16, r.height * 0.03);
    stage.style.setProperty("--cover-shift", coverShift + "px");
    if (opts.layout === 1) {
        var coverBottom = r.height * 0.36 + coverShift + side * 0.5;
        var infoTop = infoRect.top - r.top;
        var availableAnalyzerHeight = Math.max(32, infoTop - coverBottom - 4);
        var desiredAnalyzerHeight = opts.analyzerType === "oscilloscope"
            ? Math.min(72, Math.max(56, side * 0.22))
            : Math.min(48, Math.max(32, r.height * 0.075));
        stage.style.setProperty("--analyzer-height",
            Math.min(desiredAnalyzerHeight, availableAnalyzerHeight) + "px");
        stage.style.setProperty("--spectrum-top", ((coverBottom + infoTop) * 0.5) + "px");
    } else {
        stage.style.setProperty("--analyzer-height", (opts.analyzerType === "oscilloscope"
            ? Math.min(72, Math.max(56, side * 0.22))
            : Math.min(48, Math.max(32, r.height * 0.075))) + "px");
    }
    // The D2D pass blurs at a ~240px working resolution and upscales, so its strength
    // is relative to size. A fixed CSS pixel blur reads far too mild on a big stage -
    // scale it the same way: posterBlur px at 240, proportionally more at stage width.
    stage.style.setProperty("--poster-blur", (opts.posterBlur * r.width / 240) + "px");
    if (comingNextEl.classList.contains("show") && nextTrack) setComingNextContent();
    positionSpectrumOptions();
}
if (window.ResizeObserver) {
    var layoutObserver = new ResizeObserver(sizeStage);
    layoutObserver.observe(stage);
    layoutObserver.observe(document.querySelector(".info"));
}

// --- audio -------------------------------------------------------------------
var audioBtn = $("audio-toggle"), stageAudioBtn = $("stage-audio");
var spectrumEl = $("stage-spectrum"), milkdropEl = $("stage-milkdrop");
var laserEl = $("stage-lasers");
var laserFrontEl = $("stage-lasers-front");
var bpmEl = $("stage-bpm");
var audioGeneration = 0, audioWanted = false, audioHasPlayed = false;
var audioRetryTimer = null, audioStallTimer = null, audioWatchdogTimer = null;
var audioRetryAttempt = 0, audioLastProgressTime = 0;
var AUDIO_RETRY_DELAYS = [1000, 2000, 5000, 10000, 30000];
var AUDIO_STALL_MS = 12000, AUDIO_STARTUP_STALL_MS = 30000;
var audioSpectrumController = null, audioSpectrumModulePromise = null;
var audioSpectrumModuleRetry = 0;

function syncSpectrum() {
    if (audioSpectrumController) audioSpectrumController.sync();
}
function prepareSpectrum() {
    return audioSpectrumController ? audioSpectrumController.prepare() : false;
}
function clearSpectrum() {
    if (audioSpectrumController) audioSpectrumController.clear("spectrum");
}
function audioUrl() { return "https://" + station().host + "/live"; }
function clearAudioTimers() {
    clearTimeout(audioRetryTimer);
    clearTimeout(audioStallTimer);
    clearTimeout(audioWatchdogTimer);
    audioRetryTimer = audioStallTimer = audioWatchdogTimer = null;
}
function dropAudioConnection() {
    audioEl.pause();
    audioEl.removeAttribute("src");
    audioEl.load(); // actually drop the connection, don't keep buffering
}
function scheduleAudioReconnect() {
    if (!audioWanted || audioRetryTimer !== null) return;
    audioHasPlayed = false;
    syncSpectrum();
    clearTimeout(audioStallTimer);
    clearTimeout(audioWatchdogTimer);
    audioStallTimer = audioWatchdogTimer = null;
    var delay = AUDIO_RETRY_DELAYS[Math.min(audioRetryAttempt, AUDIO_RETRY_DELAYS.length - 1)];
    audioRetryAttempt++;
    var generation = audioGeneration;
    setStatus("Audio interrupted – reconnecting…", "audio");
    audioRetryTimer = setTimeout(function () {
        audioRetryTimer = null;
        if (!audioWanted || generation !== audioGeneration) return;
        startAudio(false);
    }, delay);
}
function armAudioStallTimer() {
    if (!audioWanted || audioStallTimer !== null) return;
    var generation = audioGeneration;
    var delay = audioHasPlayed ? AUDIO_STALL_MS : AUDIO_STARTUP_STALL_MS;
    audioStallTimer = setTimeout(function () {
        audioStallTimer = null;
        if (!audioWanted || generation !== audioGeneration) return;
        scheduleAudioReconnect();
    }, delay);
}
// Media events are not reliable for every broken network path. Sample currentTime as
// a second line of defence: if the decoder clock stops for a full startup window,
// replace the request even when the browser never emits stalled/error/ended.
function armAudioWatchdog() {
    clearTimeout(audioWatchdogTimer);
    if (!audioWanted) return;
    var generation = audioGeneration;
    var sampledTime = Number(audioEl.currentTime);
    audioWatchdogTimer = setTimeout(function () {
        audioWatchdogTimer = null;
        if (!audioWanted || generation !== audioGeneration) return;
        var currentTime = Number(audioEl.currentTime);
        if (!audioEl.paused && Number.isFinite(sampledTime) && Number.isFinite(currentTime)
                && currentTime > sampledTime + 0.25) {
            armAudioWatchdog();
            return;
        }
        scheduleAudioReconnect();
    }, AUDIO_STARTUP_STALL_MS);
}
function startAudio(stopOnPlayFailure) {
    clearAudioTimers();
    var generation = ++audioGeneration;
    dropAudioConnection();
    audioLastProgressTime = Number(audioEl.currentTime);
    if (!Number.isFinite(audioLastProgressTime)) audioLastProgressTime = 0;
    audioEl.src = audioUrl();
    audioEl.volume = opts.volume;
    armAudioWatchdog();
    var playResult = audioEl.play();
    if (!playResult || typeof playResult.catch !== "function") return;
    playResult.catch(function () {
        if (!audioWanted || generation !== audioGeneration) return;
        if (!stopOnPlayFailure) {
            scheduleAudioReconnect();
            return;
        }
        setStatus("Your browser refused to play the stream – use the playlist links below.", "audio");
        setAudio(false);
    });
}
function setAudio(on) {
    var wasWanted = audioWanted;
    audioWanted = on;
    if (on) {
        clearStatus("audio");
        audioHasPlayed = false;
        audioRetryAttempt = 0;
        prepareSpectrum(); // user-gesture call path unlocks AudioContext
        syncSpectrum();
        startAudio(!wasWanted);
    } else {
        audioHasPlayed = false;
        syncSpectrum();
        ++audioGeneration; // invalidate play promises and reconnect callbacks
        clearAudioTimers();
        dropAudioConnection();
    }
    var pressed = on ? "true" : "false";
    var action = on ? "Stop audio" : "Play audio";
    audioBtn.setAttribute("aria-pressed", pressed);
    audioBtn.textContent = on ? "⏸ Stop audio" : "▶ Play audio";
    stageAudioBtn.setAttribute("aria-pressed", pressed);
    stageAudioBtn.setAttribute("aria-label", action);
    stageAudioBtn.title = action;
    stageAudioBtn.textContent = on ? "⏸" : "▶";
}
function audioSpectrumModuleUrl() {
    var url = new URL("audio-spectrum.js", PLAYER_SCRIPT_URL);
    url.search = PLAYER_SCRIPT_URL.search;
    if (audioSpectrumModuleRetry) url.searchParams.set("retry", audioSpectrumModuleRetry);
    return url.href;
}
function loadAudioSpectrumModule() {
    if (audioSpectrumController) return Promise.resolve(audioSpectrumController);
    if (!audioSpectrumModulePromise) {
        audioSpectrumModulePromise = import(audioSpectrumModuleUrl()).then(function (module) {
            if (typeof module.createAudioVisualizationController !== "function")
                throw new Error("Invalid audio visualization module");
            audioSpectrumController = module.createAudioVisualizationController({
                audioElement: audioEl,
                spectrumElement: spectrumEl,
                milkdropElement: milkdropEl,
                laserElement: laserEl,
                laserForegroundElement: laserFrontEl,
                bpmElement: bpmEl,
                infoElement: document.querySelector(".info"),
                getOptions: () => opts,
                hasCapability: (name) => stationSupports(name),
                isAudioWanted: () => audioWanted,
                hasAudioPlayed: () => audioHasPlayed,
                reducedMotion: reducedMotion
            });
            if (!audioSpectrumController
                    || typeof audioSpectrumController.prepare !== "function"
                    || typeof audioSpectrumController.sync !== "function")
                throw new Error("Invalid audio spectrum controller");
            // The shared analyser may be needed by any plugin (the 80s laser show is
            // on by default), not only by the compact analyzer or MilkDrop scene.
            if (audioWanted) audioSpectrumController.prepare();
            audioSpectrumController.sync();
            return audioSpectrumController;
        }).catch(function (error) {
            audioSpectrumController = null;
            audioSpectrumModulePromise = null;
            audioSpectrumModuleRetry++;
            throw error;
        });
    }
    return audioSpectrumModulePromise;
}
function toggleAudio() {
    var on = !audioWanted;
    // Keep play() on the original click/keypress stack. Awaiting a module fetch first
    // would lose transient user activation in browsers that gate media playback.
    setAudio(on);
    if (!on) return;
    loadAudioSpectrumModule().catch(function () {
        if (!audioWanted) return;
        setAudio(false);
        setStatus("Audio controls failed to load – try again.", "audio");
    });
}
audioEl.addEventListener("playing", function () {
    if (!audioWanted) return;
    audioHasPlayed = true;
    audioRetryAttempt = 0;
    audioLastProgressTime = Number(audioEl.currentTime);
    if (!Number.isFinite(audioLastProgressTime)) audioLastProgressTime = 0;
    clearTimeout(audioRetryTimer);
    clearTimeout(audioStallTimer);
    audioRetryTimer = audioStallTimer = null;
    clearStatus("audio");
    armAudioWatchdog();
    syncSpectrum();
});
audioEl.addEventListener("timeupdate", function () {
    if (!audioWanted) return;
    var currentTime = Number(audioEl.currentTime);
    if (!Number.isFinite(currentTime) || currentTime <= audioLastProgressTime + 0.05) return;
    audioLastProgressTime = currentTime;
    clearTimeout(audioStallTimer);
    audioStallTimer = null;
});
audioEl.addEventListener("waiting", armAudioStallTimer);
audioEl.addEventListener("stalled", armAudioStallTimer);
audioEl.addEventListener("pause", function () {
    audioHasPlayed = false;
    syncSpectrum();
});
audioEl.addEventListener("error", scheduleAudioReconnect);
audioEl.addEventListener("ended", scheduleAudioReconnect);
window.addEventListener("online", function () {
    if (!audioWanted || (audioRetryTimer === null && audioStallTimer === null)) return;
    setStatus("Audio interrupted – reconnecting…", "audio");
    startAudio(false);
});
audioBtn.addEventListener("click", function () {
    toggleAudio();
});
stageAudioBtn.addEventListener("click", toggleAudio);
document.addEventListener("keydown", function (e) {
    if (e.key !== " " || e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target.closest("a, button, input, select, textarea, [contenteditable]")) return;
    e.preventDefault();
    toggleAudio();
});
function applyVolume(value) { audioEl.volume = value; }

// --- fullscreen (mirrors the apps: double-click toggles) ---------------------
function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (stage.requestFullscreen) stage.requestFullscreen();
}
stage.addEventListener("dblclick", function (e) {
    // Double-clicks inside the options overlay (a slider, a fast toggle) or on the
    // chrome buttons must not yank the user out of fullscreen.
    if (e.target.closest(".fs-options, .spectrum-options, .stage-audio, .stage-spectrum, .stage-fs, .stage-opts")) return;
    toggleFullscreen();
});
$("fullscreen").addEventListener("click", toggleFullscreen);

// --- fullscreen options overlay ----------------------------------------------
// Only descendants of the fullscreen element are rendered, so the options panel
// below the stage is unreachable there. The ⋯ button MOVES the real panel into an
// overlay inside the stage - moving (not copying) keeps every binding and value,
// and there is exactly one panel to keep in sync.
// Two panels move: the station picker (above the stage) and the main options panel
// (below it). The overlay shows them stacked, station first - same order as embedded.
var stationBox = document.querySelector(".controls-top");
var controlsEl = document.querySelector(".controls:not(.controls-top)");
var fsOptsHost = $("fs-options"), optsBtn = $("stage-options");

// A portal remembers each node's exact home, so an overlay can temporarily host the
// REAL controls without copying their state or event handlers. createDisclosure keeps
// that portal mounted through the exit transition; only then does it restore the nodes
// and apply hidden. Both player overlays use the same lifecycle.
function createPortal(nodes) {
    var homes = nodes.map(function (node) {
        return { node: node, parent: node.parentNode, next: node.nextSibling };
    });
    return {
        mount: function (host) {
            homes.forEach(function (home) { host.appendChild(home.node); });
        },
        restore: function () {
            homes.forEach(function (home) {
                var next = home.next && home.next.parentNode === home.parent
                    ? home.next : null;
                home.parent.insertBefore(home.node, next);
            });
        }
    };
}
function cssTimeMs(value) {
    value = value.trim();
    return parseFloat(value) * (value.endsWith("ms") ? 1 : 1000) || 0;
}
function transitionTotalMs(element) {
    var style = getComputedStyle(element);
    var durations = style.transitionDuration.split(",").map(cssTimeMs);
    var delays = style.transitionDelay.split(",").map(cssTimeMs);
    var count = Math.max(durations.length, delays.length), longest = 0;
    for (var i = 0; i < count; i++) {
        longest = Math.max(longest,
            durations[i % durations.length] + delays[i % delays.length]);
    }
    return longest;
}
function createDisclosure(host, trigger, portal, onOpen, onState) {
    var state = "closed", closeTimer = null, closeListener = null, generation = 0;
    host.dataset.state = state;
    host.setAttribute("aria-hidden", "true");

    function cancelClose() {
        clearTimeout(closeTimer);
        closeTimer = null;
        if (closeListener) host.removeEventListener("transitionend", closeListener);
        closeListener = null;
    }
    function finishClose(currentGeneration) {
        if (generation !== currentGeneration || state !== "closing") return;
        cancelClose();
        portal.restore();
        host.hidden = true;
        state = host.dataset.state = "closed";
    }
    function set(open) {
        if (open) {
            if (state === "open") return;
            cancelClose();
            generation++;
            portal.mount(host);
            host.hidden = false;
            host.dataset.state = "closed";
            host.setAttribute("aria-hidden", "false");
            if (onState) onState(true);
            if (onOpen) onOpen();
            // Commit the closed geometry before changing state so opacity/transform
            // interpolate even when the panel was display:none one line earlier.
            void host.offsetWidth;
            state = host.dataset.state = "open";
            if (trigger) trigger.setAttribute("aria-pressed", "true");
            return;
        }
        if (state === "closed" || state === "closing") return;
        cancelClose();
        var currentGeneration = ++generation;
        state = host.dataset.state = "closing";
        host.setAttribute("aria-hidden", "true");
        if (trigger) trigger.setAttribute("aria-pressed", "false");
        if (onState) onState(false);
        var duration = reducedMotion.matches ? 0 : transitionTotalMs(host);
        if (!duration) {
            finishClose(currentGeneration);
            return;
        }
        closeListener = function (event) {
            if (event.target === host) finishClose(currentGeneration);
        };
        host.addEventListener("transitionend", closeListener);
        // A fallback covers interrupted transitions and browsers that suppress the
        // event when fullscreen state changes during the fade.
        closeTimer = setTimeout(function () { finishClose(currentGeneration); }, duration + 50);
    }
    return { set: set, isOpen: function () { return state === "open"; } };
}

var optionsOpen = false;
var optionsDisclosure = createDisclosure(fsOptsHost, optsBtn,
    createPortal([stationBox, controlsEl]), null,
    function (open) { optionsOpen = open; });
function setOptionsOverlay(open) { optionsDisclosure.set(open); }
optsBtn.addEventListener("click", function () {
    setSpectrumOptions(false);
    setOptionsOverlay(!optionsOpen);
});

var spectrumSettingsEl = $("spectrum-settings");
var spectrumOptionsHost = $("spectrum-options"), spectrumOptionsOpen = false;
function positionSpectrumOptions() {
    if (!spectrumOptionsOpen) return;
    var stageRect = stage.getBoundingClientRect();
    var spectrumRect = spectrumEl.getBoundingClientRect();
    var edge = 8, gap = 10;
    var available = stageRect.right - spectrumRect.right - gap - edge;
    spectrumOptionsHost.style.left = (spectrumRect.right - stageRect.left + gap) + "px";
    spectrumOptionsHost.style.width = Math.max(100, Math.min(304, available)) + "px";
    var center = (spectrumRect.top + spectrumRect.bottom) * 0.5 - stageRect.top;
    var halfHeight = spectrumOptionsHost.getBoundingClientRect().height * 0.5;
    spectrumOptionsHost.style.top = Math.max(edge + halfHeight,
        Math.min(stageRect.height - edge - halfHeight, center)) + "px";
}
var spectrumDisclosure = createDisclosure(spectrumOptionsHost, null,
    createPortal([spectrumSettingsEl]), positionSpectrumOptions,
    function (open) { spectrumOptionsOpen = open; });
function setSpectrumOptions(open) {
    if (open) setOptionsOverlay(false);
    spectrumDisclosure.set(open);
}
spectrumEl.addEventListener("click", function () {
    setSpectrumOptions(!spectrumOptionsOpen);
});
document.addEventListener("pointerdown", function (e) {
    if (!spectrumOptionsOpen
            || e.target.closest(".spectrum-options, .stage-spectrum")) return;
    setSpectrumOptions(false);
});

// Light dismiss: pressing anywhere outside the panel closes it, like a native
// popover. pointerdown, not click - a slider drag that starts inside the panel and
// ends outside must not dismiss, and pointerdown judges by where the press BEGAN.
// The ⋯ button is excluded: its own handler is the toggle, and handling the same
// press twice would reopen what was just closed. (Esc needs nothing here - it exits
// fullscreen, and the fullscreenchange handler already closes the panel.)
stage.addEventListener("pointerdown", function (e) {
    if (!optionsOpen) return;
    if (e.target.closest(".fs-options, .stage-opts")) return;
    setOptionsOverlay(false);
});

// In fullscreen the chrome (▶/⏸, ⛶, ⋯, and the cursor) fades out after 2s without pointer
// movement and comes back on the next move - :hover can't express "idle" when the
// stage covers the whole screen. After their guaranteed ten-second track window,
// rating badges follow this same `.idle` state through CSS.
var idleTimer = null;
function chromeWake() {
    if (!document.fullscreenElement) return;
    stage.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
        if (!optionsOpen) stage.classList.add("idle"); // never fade while adjusting options
    }, STAGE_IDLE_MS);
}
stage.addEventListener("pointermove", chromeWake);
document.addEventListener("fullscreenchange", function () {
    stage.classList.remove("idle");
    clearTimeout(idleTimer);
    setOptionsOverlay(false); // entering or leaving: start with the panel in its home
    setSpectrumOptions(false);
    if (document.fullscreenElement) chromeWake(); // shown briefly on entry, then idles out
    sizeStage(); // the stage rect just changed drastically; don't wait for the observer
});

// --- controls wiring ---------------------------------------------------------
function syncOptionControls(key) {
    var def = OPTION_DEFS[key], value = opts[key];
    document.querySelectorAll('[data-option="' + key + '"]').forEach(function (control) {
        if (control.type === "checkbox")
            control.checked = def.checked ? def.checked(value) : !!value;
        else if (control.type === "radio")
            control.checked = control.value === String(value)
                || (value === undefined && control.value === "");
        else control.value = value;
        var outputId = control.getAttribute("data-output");
        if (outputId && def.format) $(outputId).textContent = def.format(value);
    });
}
function handleOptionControl(event) {
    var control = event.target.closest("[data-option]");
    if (!control) return;
    var key = control.dataset.option, def = OPTION_DEFS[key];
    if (!def) throw new Error("Unknown player option control: " + key);
    if (event.type !== (def.event || "change")) return;
    if (control.type === "radio" && !control.checked) return;
    var raw = control.type === "checkbox" ? control.checked : control.value;
    if (def.fromControl) raw = def.fromControl(raw, control);
    var value = def.coerce(raw);
    if (value === undefined && def.optional) delete opts[key];
    else opts[key] = value;
    syncOptionControls(key);
    saveOpts();
    if (def.effect) def.effect(opts[key], control);
}
function bindOptionControls() {
    var seen = Object.create(null);
    document.querySelectorAll("[data-option]").forEach(function (control) {
        var key = control.dataset.option;
        if (!OPTION_DEFS[key]) throw new Error("Unknown player option control: " + key);
        if (!seen[key]) {
            seen[key] = true;
            syncOptionControls(key);
        }
    });
    var root = document.querySelector(".page");
    root.addEventListener("input", handleOptionControl);
    root.addEventListener("change", handleOptionControl);
}

// fanart.tv distinguishes the project's api_key from a listener's personal
// client_key. Check the latter against one stable movie directly, without involving
// this site's resolver or changing normal artwork matching.
const fanartKeyElement = $("fanart-key");
const fanartKeySettingElement = fanartKeyElement.closest(".provider-key-setting");
const fanartKeyCheckElement = $("fanart-key-check");
const fanartKeyCheckLabelElement = $("fanart-key-check-label");
const fanartKeyStatusElement = $("fanart-key-status");
let fanartKeyCheckController = null;
let fanartKeyCheckGeneration = 0;
let fanartKeyLabelTimer = null;
let fanartKeyStatusTimer = null;
let fanartKeyCheckButtonState = "idle";

function setFanartKeyCheckButton(state) {
    const labels = { idle: "Check", checking: "…", success: "✓" };
    const verificationText = opts.fanartKeyVerifiedAt
        ? "successfully checked on "
            + new Date(opts.fanartKeyVerifiedAt).toISOString().slice(0, 10)
        : "";
    const accessibleNames = {
        idle: "Check fanart.tv personal key",
        checking: "Checking fanart.tv personal key",
        success: verificationText
            ? "Recheck fanart.tv personal key; " + verificationText
            : "Recheck fanart.tv personal key"
    };
    fanartKeyCheckElement.disabled = state === "checking";
    fanartKeyCheckElement.title = state === "success"
        ? "Check fanart.tv personal key again"
            + (verificationText ? "; " + verificationText : "")
        : accessibleNames[state];
    fanartKeyCheckElement.classList.toggle("success", state === "success");
    fanartKeyCheckElement.setAttribute("aria-label", accessibleNames[state]);
    if (state === fanartKeyCheckButtonState) return;
    fanartKeyCheckButtonState = state;
    clearTimeout(fanartKeyLabelTimer);
    fanartKeyCheckLabelElement.classList.add("changing");
    fanartKeyLabelTimer = setTimeout(() => {
        fanartKeyCheckLabelElement.textContent = labels[state];
        fanartKeyCheckLabelElement.classList.remove("changing");
    }, reducedMotion.matches ? 0 : 150);
}

function hideFanartKeyStatus(nextText = "") {
    fanartKeyStatusElement.classList.remove("show");
    clearTimeout(fanartKeyStatusTimer);
    fanartKeyStatusTimer = setTimeout(() => {
        fanartKeyStatusElement.textContent = nextText;
    }, reducedMotion.matches ? 0 : 200);
}

function showFanartKeyError(message) {
    clearTimeout(fanartKeyStatusTimer);
    fanartKeyStatusElement.textContent = message;
    requestAnimationFrame(() => fanartKeyStatusElement.classList.add("show"));
}

function resetFanartKeyCheck() {
    fanartKeyCheckGeneration++;
    if (fanartKeyCheckController) fanartKeyCheckController.abort();
    fanartKeyCheckController = null;
    opts.fanartKeyVerifiedAt = 0;
    const hasKey = fanartKeyElement.value.trim() !== "";
    fanartKeySettingElement.classList.toggle("has-key", hasKey);
    setFanartKeyCheckButton("idle");
    hideFanartKeyStatus();
}

function restoreFanartKeyCheck() {
    const hasKey = fanartKeyElement.value.trim() !== "";
    fanartKeySettingElement.classList.toggle("has-key", hasKey);
    setFanartKeyCheckButton(hasKey && opts.fanartKeyVerifiedAt ? "success" : "idle");
}

async function checkFanartKey() {
    const personalKey = fanartKeyElement.value.trim();
    if (!personalKey) return;
    const previousVerification = opts.fanartKeyVerifiedAt;
    if (fanartKeyCheckController) fanartKeyCheckController.abort();
    const controller = new AbortController();
    fanartKeyCheckController = controller;
    const generation = ++fanartKeyCheckGeneration;
    setFanartKeyCheckButton("checking");
    hideFanartKeyStatus();

    const url = new URL(FANART_KEY_CHECK_URL);
    url.searchParams.set("client_key", personalKey);
    try {
        const response = await fetch(url, {
            cache: "no-store",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            signal: controller.signal
        });
        if (generation !== fanartKeyCheckGeneration) return;
        if (response.status === 401 || response.status === 403) {
            fanartKeyCheckController = null;
            opts.fanartKeyVerifiedAt = 0;
            saveOpts();
            setFanartKeyCheckButton("idle");
            showFanartKeyError("Personal key not accepted.");
            return;
        }
        if (!response.ok) throw new Error("fanart.tv returned " + response.status);
        const body = await response.json();
        if (generation !== fanartKeyCheckGeneration) return;
        if (!body || String(body.tmdb_id) !== "27205")
            throw new Error("fanart.tv returned an unexpected response");
        fanartKeyCheckController = null;
        opts.fanartKey = personalKey;
        opts.fanartKeyVerifiedAt = Date.now();
        syncOptionControls("fanartKey");
        saveOpts();
        setFanartKeyCheckButton("success");
        hideFanartKeyStatus("Personal key accepted.");
    } catch (error) {
        if ((error && error.name === "AbortError")
                || generation !== fanartKeyCheckGeneration) return;
        fanartKeyCheckController = null;
        setFanartKeyCheckButton(previousVerification ? "success" : "idle");
        showFanartKeyError("Couldn’t check the personal key right now.");
    }
}

fanartKeyElement.addEventListener("input", resetFanartKeyCheck);
fanartKeyCheckElement.addEventListener("click", checkFanartKey);
// Station picker is built from the table so it can never drift from STATIONS.
(function buildStations() {
    var box = $("stations");
    STATIONS.forEach(function (s) {
        var label = document.createElement("label");
        label.className = "seg";
        label.title = s.desc;
        var input = document.createElement("input");
        input.type = "radio"; input.name = "station"; input.value = s.id;
        input.dataset.option = "station";
        var span = document.createElement("span");
        span.textContent = s.name;
        label.appendChild(input); label.appendChild(span);
        box.appendChild(label);
    });
})();

var settingsTabList = $("settings-tabs");
var settingsTabHost = $("settings-tab-host");
var settingsTabs = Array.prototype.slice.call(
    settingsTabList.querySelectorAll('[role="tab"]'));
var settingsTabPanels = Array.prototype.slice.call(
    settingsTabHost.querySelectorAll('[role="tabpanel"]'));
var activeSettingsPanel = $("settings-panel-common");
var settingsTabFrame = null, settingsTabTimer = null, settingsTabGeneration = 0;
var stationTabTimer = null, stationTabGeneration = 0;

function settingsPanelFor(tab) {
    return $(tab.getAttribute("aria-controls"));
}
function setSettingsPanelSemantics(panel, active) {
    panel.setAttribute("aria-hidden", active ? "false" : "true");
    if (active) panel.removeAttribute("inert");
    else panel.setAttribute("inert", "");
}
function syncSettingsTabSemantics(activePanel) {
    settingsTabs.forEach(function (tab) {
        var selected = settingsPanelFor(tab) === activePanel;
        tab.setAttribute("aria-selected", selected ? "true" : "false");
        tab.tabIndex = selected && !tab.hidden && !tab.disabled ? 0 : -1;
    });
}
function settleSettingsTabs(panel) {
    cancelAnimationFrame(settingsTabFrame);
    clearTimeout(settingsTabTimer);
    settingsTabFrame = settingsTabTimer = null;
    settingsTabHost.classList.remove("transitioning", "swapping");
    settingsTabHost.style.height = "";
    settingsTabPanels.forEach(function (candidate) {
        candidate.classList.remove("tab-panel-incoming", "tab-panel-outgoing");
        var selected = candidate === panel;
        candidate.hidden = !selected;
        setSettingsPanelSemantics(candidate, selected);
    });
    syncSettingsTabSemantics(panel);
}
function selectSettingsTab(tab, animate) {
    if (!tab || tab.hidden || tab.disabled) return;
    var nextPanel = settingsPanelFor(tab);
    if (nextPanel === activeSettingsPanel) {
        syncSettingsTabSemantics(activeSettingsPanel);
        return;
    }
    var interruptedHeight = settingsTabHost.classList.contains("transitioning")
        ? settingsTabHost.getBoundingClientRect().height : 0;
    settleSettingsTabs(activeSettingsPanel);
    var outgoingPanel = activeSettingsPanel;
    activeSettingsPanel = nextPanel;
    syncSettingsTabSemantics(nextPanel);
    if (!outgoingPanel || animate === false || reducedMotion.matches) {
        settleSettingsTabs(nextPanel);
        return;
    }

    var generation = ++settingsTabGeneration;
    var startHeight = interruptedHeight || outgoingPanel.getBoundingClientRect().height;
    nextPanel.hidden = false;
    setSettingsPanelSemantics(outgoingPanel, false);
    setSettingsPanelSemantics(nextPanel, true);
    outgoingPanel.classList.add("tab-panel-outgoing");
    nextPanel.classList.add("tab-panel-incoming");
    settingsTabHost.style.height = startHeight + "px";
    settingsTabHost.classList.add("transitioning");
    var targetHeight = nextPanel.getBoundingClientRect().height;
    void settingsTabHost.offsetHeight;
    settingsTabFrame = requestAnimationFrame(function () {
        settingsTabFrame = null;
        if (generation !== settingsTabGeneration) return;
        settingsTabHost.style.height = targetHeight + "px";
        settingsTabHost.classList.add("swapping");
        var duration = Math.max(
            transitionTotalMs(settingsTabHost),
            transitionTotalMs(outgoingPanel),
            transitionTotalMs(nextPanel));
        settingsTabTimer = setTimeout(function () {
            if (generation !== settingsTabGeneration) return;
            settleSettingsTabs(nextPanel);
        }, duration + 50);
    });
}
settingsTabList.addEventListener("click", function (event) {
    selectSettingsTab(event.target.closest('[role="tab"]'), true);
});
settingsTabList.addEventListener("keydown", function (event) {
    var current = event.target.closest('[role="tab"]');
    if (!current) return;
    var available = settingsTabs.filter(function (tab) {
        return !tab.hidden && !tab.disabled && !tab.classList.contains("tab-exiting");
    });
    var index = available.indexOf(current), next = null;
    if (event.key === "ArrowRight") next = available[(index + 1) % available.length];
    else if (event.key === "ArrowLeft")
        next = available[(index - 1 + available.length) % available.length];
    else if (event.key === "Home") next = available[0];
    else if (event.key === "End") next = available[available.length - 1];
    else return;
    event.preventDefault();
    next.focus();
    selectSettingsTab(next, true);
});

function stationHasSettings(selectedStation) {
    return stationSupports(CAPABILITY_SOUNDTRACK_MEDIA, selectedStation)
        || stationSupports(CAPABILITY_LASERS, selectedStation);
}
function syncStationSettingsTab(animate) {
    var tab = $("settings-tab-station");
    var available = stationHasSettings(station());
    var wasHidden = tab.hidden;
    var wasExiting = tab.classList.contains("tab-exiting");
    var generation = ++stationTabGeneration;
    clearTimeout(stationTabTimer);
    stationTabTimer = null;
    if (available) {
        tab.hidden = false;
        tab.disabled = false;
        tab.setAttribute("aria-hidden", "false");
        if (!wasHidden && !wasExiting) {
            syncSettingsTabSemantics(activeSettingsPanel);
            return;
        }
        if (animate === false || reducedMotion.matches) {
            tab.classList.remove("tab-entering", "tab-exiting");
            syncSettingsTabSemantics(activeSettingsPanel);
            return;
        }
        tab.classList.remove("tab-exiting");
        tab.classList.add("tab-entering");
        void tab.offsetWidth;
        requestAnimationFrame(function () {
            if (generation !== stationTabGeneration) return;
            tab.classList.remove("tab-entering");
            syncSettingsTabSemantics(activeSettingsPanel);
        });
        return;
    }

    if (activeSettingsPanel === $("settings-panel-station"))
        selectSettingsTab($("settings-tab-common"), animate);
    tab.disabled = true;
    tab.tabIndex = -1;
    tab.setAttribute("aria-hidden", "true");
    if (animate === false || reducedMotion.matches) {
        tab.classList.remove("tab-entering", "tab-exiting");
        tab.hidden = true;
        return;
    }
    tab.classList.remove("tab-entering");
    tab.classList.add("tab-exiting");
    var duration = transitionTotalMs(tab);
    stationTabTimer = setTimeout(function () {
        if (generation !== stationTabGeneration) return;
        tab.hidden = true;
        tab.classList.remove("tab-exiting");
    }, duration + 50);
}
settleSettingsTabs(activeSettingsPanel);
syncStationSettingsTab(false);

var stationContextHost = $("station-context-host");
var stationContextName = $("station-tab-name");
var stationContextPanels = Array.prototype.slice.call(
    stationContextHost.querySelectorAll(".station-context-panel"));
var activeStationContextPanel = null;
var stationContextFrame = null, stationContextTimer = null;
var stationContextGeneration = 0;

function contextPanelFor(selectedStation) {
    for (var i = 0; i < stationContextPanels.length; i++) {
        var panel = stationContextPanels[i];
        if (panel.dataset.capability
                && stationSupports(panel.dataset.capability, selectedStation)) return panel;
        if (panel.dataset.station === selectedStation.id) return panel;
    }
    return null;
}
function setContextPanelSemantics(panel, active) {
    panel.setAttribute("aria-hidden", active ? "false" : "true");
    if (active) panel.removeAttribute("inert");
    else panel.setAttribute("inert", "");
}
function settleStationContext(panel) {
    cancelAnimationFrame(stationContextFrame);
    clearTimeout(stationContextTimer);
    stationContextFrame = stationContextTimer = null;
    stationContextHost.classList.remove("transitioning", "swapping");
    stationContextHost.style.height = "";
    stationContextPanels.forEach(function (candidate) {
        candidate.classList.remove("context-incoming", "context-outgoing");
        var selected = candidate === panel;
        candidate.hidden = !selected;
        setContextPanelSemantics(candidate, selected);
    });
}
function syncStationContext(animate) {
    var selectedStation = station();
    var nextPanel = contextPanelFor(selectedStation);
    stationContextName.textContent = selectedStation.id === "sst"
        ? "SST" : selectedStation.name;
    stationContextHost.setAttribute("aria-label", "Settings for " + selectedStation.name);
    // A station without contextual settings has no Station tab. Keep the outgoing
    // content mounted while the tab panel itself crossfades to Common.
    if (!nextPanel) return;

    var interruptedHeight = stationContextHost.classList.contains("transitioning")
        ? stationContextHost.getBoundingClientRect().height : 0;
    settleStationContext(activeStationContextPanel);
    if (!activeStationContextPanel || activeStationContextPanel === nextPanel
            || animate === false || reducedMotion.matches
            || !stationContextHost.getClientRects().length) {
        activeStationContextPanel = nextPanel;
        settleStationContext(nextPanel);
        return;
    }

    var outgoingPanel = activeStationContextPanel;
    var generation = ++stationContextGeneration;
    var startHeight = interruptedHeight || outgoingPanel.getBoundingClientRect().height;
    activeStationContextPanel = nextPanel;
    nextPanel.hidden = false;
    setContextPanelSemantics(outgoingPanel, false);
    setContextPanelSemantics(nextPanel, true);
    outgoingPanel.classList.add("context-outgoing");
    nextPanel.classList.add("context-incoming");
    stationContextHost.style.height = startHeight + "px";
    stationContextHost.classList.add("transitioning");
    var targetHeight = nextPanel.getBoundingClientRect().height;
    void stationContextHost.offsetHeight;

    stationContextFrame = requestAnimationFrame(function () {
        stationContextFrame = null;
        if (generation !== stationContextGeneration) return;
        stationContextHost.style.height = targetHeight + "px";
        stationContextHost.classList.add("swapping");
        var duration = Math.max(
            transitionTotalMs(stationContextHost),
            transitionTotalMs(outgoingPanel),
            transitionTotalMs(nextPanel));
        stationContextTimer = setTimeout(function () {
            if (generation !== stationContextGeneration) return;
            settleStationContext(nextPanel);
        }, duration + 50);
    });
}
syncStationContext(false);

function applyStation() {
    // Most station changes pass through saveOpts(); keep this sync here as well so
    // programmatic station changes cannot leave the address bar stale.
    syncSettingsUrl();
    syncStationSettingsTab(true);
    syncStationContext(true);
    // Station-specific visualizations consume the same capability model as the
    // contextual UI, so a switch also releases any now-unavailable scene.
    syncSpectrum();
    // If a media backdrop currently owns the stage, clearing it below must not expose
    // SST's still-buffered cover. showCover() releases this hold only after the new
    // station cover (or logo) has loaded and become the front buffer.
    coverHiddenUntilCoverReady = stage.classList.contains("no-cover");
    nextRenderGeneration("cover"); // invalidate image loads before the new poll returns
    updateCoverTint("");
    const backdropGeneration = nextRenderGeneration("backdrop");
    cancelBackdropRequest();
    setMovieBackdrop(null, backdropGeneration);
    setRatings([], backdropGeneration);
    shownUrl = ""; loadingCoverUrl = ""; remAnchor = -1;
    resetQueuedTracks();
    boundaryTrackToken = ""; boundaryExpectedEndAt = 0; lastSuccessfulPollAt = 0;
    resetCoverRetry("");
    // The resolver is per-station now - always re-evaluate after a switch, even if
    // the new station plays an identically named album.
    currentAlbum = ""; currentTrack = ""; currentArtist = "";
    setInfo("Loading…", "");
    setStatus("");
    if (audioWanted) setAudio(true); // retune the stream
    poll();
}

var spectrumBarsEl = $("spectrum-bars");
var spectrumModeEls = document.querySelectorAll('input[name="spectrum-mode"]');
var analyzerTypeEls = document.querySelectorAll('input[name="analyzer-type"]');
var oscilloscopeStyleEls = document.querySelectorAll('input[name="oscilloscope-style"]');
var analyzerTypeSettingEl = $("analyzer-type-setting");
var spectrumBarsSettingEl = $("spectrum-bars-setting");
var oscilloscopeStyleSettingEl = $("oscilloscope-style-setting");
var analyzerColorSettingEl = $("analyzer-color-setting");
var milkdropPresetEls = document.querySelectorAll('input[name="milkdrop-preset"]');
var milkdropPresetSettingEl = $("milkdrop-preset-setting");
var strobeEnabledEl = $("strobe-enabled");
var smokeEnabledEl = $("smoke-enabled");
function setVisualizationSettingEnabled(element, enabled) {
    element.classList.toggle("disabled", !enabled);
    element.setAttribute("aria-disabled", enabled ? "false" : "true");
}
function syncSpectrumSettingControls() {
    var enabled = !!opts.spectrumEnabled;
    var spectrum = opts.analyzerType === "spectrum";
    spectrumBarsEl.disabled = !enabled || !spectrum;
    analyzerTypeEls.forEach(function (input) { input.disabled = !enabled; });
    spectrumModeEls.forEach(function (input) { input.disabled = !enabled || !spectrum; });
    oscilloscopeStyleEls.forEach(function (input) {
        input.disabled = !enabled || spectrum;
    });
    setVisualizationSettingEnabled(analyzerTypeSettingEl, enabled);
    setVisualizationSettingEnabled(spectrumBarsSettingEl, enabled && spectrum);
    setVisualizationSettingEnabled(oscilloscopeStyleSettingEl, enabled && !spectrum);
    setVisualizationSettingEnabled(analyzerColorSettingEl, enabled && spectrum);
    $("spectrum-enabled").setAttribute("aria-expanded", enabled ? "true" : "false");
    setFeatureOptionsState($("analyzer-options"), enabled);
    setFeatureOptionsState($("spectrum-detail-options"), enabled && spectrum);
    setFeatureOptionsState($("oscilloscope-detail-options"), enabled && !spectrum);
}
function syncLaserSettingControls() {
    var enabled = !!opts.laserEnabled && !opts.milkdropEnabled;
    strobeEnabledEl.disabled = !enabled;
    smokeEnabledEl.disabled = !enabled;
    $("laser-enabled").setAttribute("aria-expanded",
        opts.laserEnabled ? "true" : "false");
    setFeatureOptionsState($("laser-options"), !!opts.laserEnabled);
}
function syncMilkdropSettingControls() {
    var enabled = !!opts.milkdropEnabled;
    milkdropPresetEls.forEach(function (input) { input.disabled = !enabled; });
    setVisualizationSettingEnabled(milkdropPresetSettingEl, enabled);
    $("milkdrop-enabled").setAttribute("aria-expanded", enabled ? "true" : "false");
    setFeatureOptionsState($("milkdrop-options"), enabled);
}
function applySpectrumEnabled() {
    syncSpectrumSettingControls();
    sizeStage();
    if (opts.spectrumEnabled && audioWanted) prepareSpectrum();
    syncSpectrum();
}
function applyBpmEnabled() {
    if (opts.bpmEnabled && audioWanted) prepareSpectrum();
    syncSpectrum();
}
function applyAnalyzerType() {
    syncSpectrumSettingControls();
    sizeStage();
    syncSpectrum();
}
function applyMilkdropEnabled() {
    syncMilkdropSettingControls();
    syncLaserSettingControls();
    if (opts.milkdropEnabled && audioWanted) prepareSpectrum();
    syncSpectrum();
}
function applyLaserEnabled() {
    syncLaserSettingControls();
    if (opts.laserEnabled && audioWanted) prepareSpectrum();
    syncSpectrum();
}
function applySmokeEnabled(enabled) {
    // A user-initiated rising edge previews the effect immediately when the laser
    // visualization is already live. Loading a saved true value does not call effects,
    // so reopening the page never produces a surprise burst.
    if (enabled && audioSpectrumController)
        audioSpectrumController.trigger("lasers", "smoke");
}
function resetSpectrumBars() {
    if (audioSpectrumController) audioSpectrumController.reset("spectrum");
}

var transitionEnabledEl = $("transitions-enabled");
var transitionStyleEls = document.querySelectorAll('input[name="transition"]');
var transitionDurationEl = $("fade");
var transitionDurationOutputEl = $("fade-val");
var transitionPreviewTimer = null;
function syncTransitionControls() {
    var enabled = opts.transition.enabled;
    transitionEnabledEl.checked = enabled;
    transitionEnabledEl.setAttribute("aria-expanded", enabled ? "true" : "false");
    transitionStyleEls.forEach(function (input) {
        input.checked = Number(input.value) === opts.transition.options.style;
    });
    transitionDurationEl.value = opts.transition.options.durationMs;
    transitionDurationOutputEl.textContent =
        (opts.transition.options.durationMs / 1000).toFixed(1) + " s";
    setFeatureOptionsState($("transition-options"), enabled);
}
function previewTransitionChoice(input) {
    if (reducedMotion.matches) return;
    var label = input.nextElementSibling;
    var previewClasses = ["", "preview-crossfade", "preview-flip-horizontal",
        "preview-flip-vertical"];
    document.querySelectorAll(".transition-choice span").forEach(function (choice) {
        previewClasses.slice(1).forEach(function (name) { choice.classList.remove(name); });
    });
    void label.offsetWidth;
    label.classList.add(previewClasses[Number(input.value)]);
    clearTimeout(transitionPreviewTimer);
    transitionPreviewTimer = setTimeout(function () {
        previewClasses.slice(1).forEach(function (name) { label.classList.remove(name); });
    }, 750);
}
transitionEnabledEl.addEventListener("change", function () {
    opts.transition.enabled = transitionEnabledEl.checked;
    saveOpts();
    syncTransitionControls();
});
transitionStyleEls.forEach(function (input) {
    // Label clicks and taps activate the real radio input even when it is already
    // selected. `click` therefore replays the sample on every activation, whereas
    // `change` alone would only preview the first selection.
    input.addEventListener("click", function () { previewTransitionChoice(input); });
    input.addEventListener("change", function () {
        if (!input.checked) return;
        opts.transition.options.style = Number(input.value);
        saveOpts();
        syncTransitionControls();
    });
});
transitionDurationEl.addEventListener("input", function () {
    opts.transition.options.durationMs = intOption(500, 2000)(transitionDurationEl.value);
    saveOpts();
    syncTransitionControls();
});

var remainingTimeEnabledEl = $("remaining-time-enabled");
var remainingTimeModeEls = document.querySelectorAll('input[name="remaining"]');
var remainingTimeSizeEls = document.querySelectorAll('input[name="cdsize"]');
function syncRemainingTimeControls() {
    var enabled = opts.remainingTime.enabled;
    remainingTimeEnabledEl.checked = enabled;
    remainingTimeEnabledEl.setAttribute("aria-expanded", enabled ? "true" : "false");
    remainingTimeModeEls.forEach(function (input) {
        input.checked = input.value === opts.remainingTime.options.mode;
    });
    remainingTimeSizeEls.forEach(function (input) {
        input.checked = input.value === opts.remainingTime.options.size;
    });
    setFeatureOptionsState($("remaining-time-options"), enabled);
}
remainingTimeEnabledEl.addEventListener("change", function () {
    opts.remainingTime.enabled = remainingTimeEnabledEl.checked;
    saveOpts();
    syncRemainingTimeControls();
    renderCountdown();
    sizeStage();
});
remainingTimeModeEls.forEach(function (input) {
    input.addEventListener("change", function () {
        if (!input.checked) return;
        opts.remainingTime.options.mode = input.value;
        saveOpts();
        syncRemainingTimeControls();
        renderCountdown();
    });
});
remainingTimeSizeEls.forEach(function (input) {
    input.addEventListener("change", function () {
        if (!input.checked) return;
        opts.remainingTime.options.size = input.value;
        saveOpts();
        syncRemainingTimeControls();
        sizeStage();
    });
});
bindOptionControls();
syncTransitionControls();
syncRemainingTimeControls();
restoreFanartKeyCheck();
syncSpectrumSettingControls();
syncMilkdropSettingControls();
syncLaserSettingControls();
syncRatingControls();

var shareSettingsButton = $("share-settings");
var shareSettingsStatus = $("share-settings-status");
var shareStatusTimer = null, shareStatusClearTimer = null;
function copyTextFallback(value) {
    var field = document.createElement("textarea");
    field.value = value;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    var copied = false;
    try { copied = document.execCommand("copy"); } catch (error) { /* report below */ }
    field.remove();
    return copied;
}
function showShareStatus(message) {
    clearTimeout(shareStatusTimer);
    clearTimeout(shareStatusClearTimer);
    shareSettingsStatus.textContent = message;
    requestAnimationFrame(function () { shareSettingsStatus.classList.add("show"); });
    shareStatusTimer = setTimeout(function () {
        shareSettingsStatus.classList.remove("show");
        var duration = reducedMotion.matches ? 0 : transitionTotalMs(shareSettingsStatus);
        shareStatusClearTimer = setTimeout(function () {
            shareSettingsStatus.textContent = "";
        }, duration + 50);
    }, 2400);
}
shareSettingsButton.addEventListener("click", async function () {
    var value = settingsShareUrl().href;
    var copied = false;
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(value);
            copied = true;
        } catch (error) { /* fall through to the selection-based copy path */ }
    }
    if (!copied) copied = copyTextFallback(value);
    showShareStatus(copied
        ? "Settings link copied."
        : "Couldn’t copy the settings link in this browser.");
});

// --- provider priority: pointer + keyboard ------------------------------------
// Pointer-based, NOT native HTML5 DnD: the native API renders a translucent
// snapshot beside a text-drag cursor and the real row stays put - it cannot make
// the row itself ride the pointer. Here the actual row goes position:fixed and
// follows the pointer (visibly lifted out of the list), a dashed placeholder
// keeps its gap, and elementFromPoint moves the gap - possible because the
// floating row is pointer-events:none, so hit testing sees through it. The <li>
// order stays the single source of truth, read back on release. Pointer events also
// make this work on touch (the grip's touch-action:none stops scrolling). The same
// button supports arrow/Home/End moves with its position announced to assistive tech.
// The ⠿ grip is the only handle: the row also holds a key input, and a drag must not
// fight text selection there.
var providersEl = $("providers");
backdropRetryEl.addEventListener("click", retryBackdrop);
var providerDomOrder = opts.sstBackdrops.options.providers.concat(PROVIDER_ORDER.filter(function (id) {
    return opts.sstBackdrops.options.providers.indexOf(id) < 0;
}));
providerDomOrder.forEach(function (id) {
    var row = providersEl.querySelector('[data-provider="' + id + '"]');
    if (!row) throw new Error("Missing artwork provider control: " + id);
    providersEl.appendChild(row);
});
var providerStatusEl = $("provider-status");
function providerName(li) {
    var provider = ART_PROVIDER_BY_ID[li.dataset.provider];
    return provider ? provider.name : li.dataset.provider;
}
function syncProviderHandles(moved) {
    var rows = Array.prototype.slice.call(providersEl.querySelectorAll(".provider"));
    rows.forEach(function (li, i) {
        li.querySelector(".grip").setAttribute("aria-label", "Reorder " + providerName(li)
            + ", position " + (i + 1) + " of " + rows.length
            + ". Use Arrow Up, Arrow Down, Home, or End.");
    });
    if (moved) providerStatusEl.textContent = providerName(moved) + " moved to position "
        + (rows.indexOf(moved) + 1) + " of " + rows.length + ".";
}
function commitProviderOrder(moved) {
    var providers = Array.prototype.filter.call(providersEl.children, function (li) {
        return li.querySelector('input[type="checkbox"]').checked;
    }).map(function (li) { return li.dataset.provider; });
    opts.sstBackdrops.options.providers = providers;
    saveOpts();
    syncBackdropControls();
    updateBackdrop();
    syncProviderHandles(moved);
}
syncProviderHandles();
function syncBackdropControls() {
    var master = $("backdrops-enabled");
    master.checked = opts.sstBackdrops.enabled;
    master.setAttribute("aria-expanded", opts.sstBackdrops.enabled ? "true" : "false");
    $("hide-cover").checked = opts.sstBackdrops.options.cover === "hide";
    setFeatureOptionsState($("backdrop-options"), opts.sstBackdrops.enabled);
    Array.prototype.forEach.call(providersEl.querySelectorAll(".provider"), function (li) {
        li.querySelector('input[type="checkbox"]').checked =
            opts.sstBackdrops.options.providers.indexOf(li.dataset.provider) >= 0;
    });
    var fanartSelected = opts.sstBackdrops.options.providers.indexOf("fanart") >= 0;
    fanartKeySettingElement.classList.toggle("provider-selected", fanartSelected);
    fanartKeySettingElement.setAttribute("aria-hidden",
        fanartSelected ? "false" : "true");
    if (fanartSelected) fanartKeySettingElement.removeAttribute("inert");
    else fanartKeySettingElement.setAttribute("inert", "");
}
function commitBackdropsEnabled() {
    opts.sstBackdrops.enabled = $("backdrops-enabled").checked;
    saveOpts();
    syncBackdropControls();
    updateBackdrop();
}
function commitBackdropCover() {
    opts.sstBackdrops.options.cover = $("hide-cover").checked ? "hide" : "show";
    saveOpts();
    updateCoverVisibility();
}
$("backdrops-enabled").addEventListener("change", commitBackdropsEnabled);
$("hide-cover").addEventListener("change", commitBackdropCover);
// Provider selection and order are retained while the backdrop master switch is off.
Array.prototype.forEach.call(providersEl.querySelectorAll(".provider"), function (li) {
    var provider = ART_PROVIDER_BY_ID[li.dataset.provider];
    if (!provider) throw new Error("Unknown artwork provider control: " + li.dataset.provider);
    var box = li.querySelector('input[type="checkbox"]');
    box.addEventListener("change", function () { commitProviderOrder(); });
});
syncBackdropControls();
providersEl.addEventListener("keydown", function (e) {
    var grip = e.target.closest(".grip");
    if (!grip) return;
    var row = grip.closest(".provider"), moved = false;
    if (e.key === "ArrowUp" && row.previousElementSibling) {
        providersEl.insertBefore(row, row.previousElementSibling); moved = true;
    } else if (e.key === "ArrowDown" && row.nextElementSibling) {
        providersEl.insertBefore(row.nextElementSibling, row); moved = true;
    } else if (e.key === "Home" && row.previousElementSibling) {
        providersEl.insertBefore(row, providersEl.firstElementChild); moved = true;
    } else if (e.key === "End" && row.nextElementSibling) {
        providersEl.appendChild(row); moved = true;
    } else if (e.key !== "ArrowUp" && e.key !== "ArrowDown"
            && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    if (moved) commitProviderOrder(row);
    grip.focus();
});
(function () {
    var row = null, placeholder = null, grabX = 0, grabY = 0;
    function moveTo(e) {
        // fixed at 0/0, so the translate IS the viewport position; the slight tilt
        // is what makes it read as "picked up" rather than misrendered
        row.style.transform = "translate(" + (e.clientX - grabX) + "px, "
            + (e.clientY - grabY) + "px) rotate(1.5deg)";
    }
    function onMove(e) {
        moveTo(e);
        var under = document.elementFromPoint(e.clientX, e.clientY);
        var over = under && under.closest(".provider:not(.dragging):not(.placeholder)");
        if (!over) return;
        var r = over.getBoundingClientRect();
        providersEl.insertBefore(placeholder,
            e.clientY < r.top + r.height / 2 ? over : over.nextSibling);
    }
    function endDrag() {
        if (!row) return; // a stray pointercancel after release
        var moved = row;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", endDrag);
        window.removeEventListener("pointercancel", endDrag);
        providersEl.insertBefore(row, placeholder);
        placeholder.remove();
        placeholder = null;
        row.classList.remove("dragging");
        row.style.transform = "";
        row.style.width = "";
        row = null;
        document.body.classList.remove("row-dragging");
        commitProviderOrder(moved);
    }
    providersEl.addEventListener("pointerdown", function (e) {
        if (!e.target.closest(".grip") || row) return;
        if (e.pointerType === "mouse" && e.button !== 0) return;
        e.preventDefault(); // no text selection during the drag
        row = e.target.closest(".provider");
        var r = row.getBoundingClientRect();
        grabX = e.clientX - r.left;
        grabY = e.clientY - r.top;
        placeholder = document.createElement("li");
        placeholder.className = "provider placeholder";
        placeholder.style.height = r.height + "px";
        row.parentNode.insertBefore(placeholder, row);
        row.style.width = r.width + "px"; // fixed positioning loses the list's width
        row.classList.add("dragging");
        // Settings disclosures animate with transforms. A fixed child of a transformed
        // ancestor is positioned against that ancestor rather than the viewport, which
        // offsets it far from the pointer. Portal only the actively dragged row to the
        // page root: it escapes those transforms while retaining the page's theme tokens.
        // The placeholder keeps its exact position in the provider list.
        document.querySelector(".page").appendChild(row);
        document.body.classList.add("row-dragging");
        moveTo(e);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", endDrag);
        window.addEventListener("pointercancel", endDrag);
    });
})();

// --- easter egg ---------------------------------------------------------------
// Seven taps on the current cover unlock a self-contained game chunk. Keep the
// module, its stylesheet and the extra history/queue requests out of the ordinary
// player path; even import() is deferred until the gesture is complete.
var memoryGameModule = null, coverTapCount = 0, coverTapResetTimer = null;
var coverTapStart = null;
function openMemoryGame() {
    if (!memoryGameModule) {
        var moduleUrl = new URL("memory-game.js" + PLAYER_SCRIPT_URL.search, PLAYER_SCRIPT_URL);
        memoryGameModule = import(moduleUrl.href).catch(function (error) {
            memoryGameModule = null;
            throw error;
        });
    }
    memoryGameModule.then(function (game) {
        var selectedStation = station();
        game.openMemoryGame({
            host: selectedStation.host,
            stationName: selectedStation.name,
            stationLogo: selectedStation.logo,
        });
    }).catch(function () {
        setStatus("The secret level couldn’t be loaded.", "general");
    });
}
coverBox.addEventListener("pointerdown", function (event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    coverTapStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
});
coverBox.addEventListener("pointerup", function (event) {
    if (!coverTapStart || event.pointerId !== coverTapStart.id) return;
    var distance = Math.hypot(event.clientX - coverTapStart.x,
        event.clientY - coverTapStart.y);
    coverTapStart = null;
    if (distance > 12) {
        coverTapCount = 0;
        clearTimeout(coverTapResetTimer);
        return;
    }
    coverTapCount++;
    clearTimeout(coverTapResetTimer);
    if (coverTapCount < 7) {
        coverTapResetTimer = setTimeout(function () { coverTapCount = 0; }, 4000);
        return;
    }
    coverTapCount = 0;
    openMemoryGame();
});
coverBox.addEventListener("pointercancel", function () { coverTapStart = null; });

// --- go ----------------------------------------------------------------------
applyLayout();
enableLocalBackchannel();
setInfo("Loading…", "");
document.addEventListener("visibilitychange", function () {
    if (!document.hidden) resynchronizeStationIfStale();
});
window.addEventListener("focus", resynchronizeStationIfStale);
window.addEventListener("pageshow", resynchronizeStationIfStale);
audioEl.addEventListener("playing", resynchronizeStationIfStale);
tickTimer = setInterval(function () {
    renderCountdown();
    renderComingNext();
    renderRetryStatus();
}, 1000);
poll();

})();
