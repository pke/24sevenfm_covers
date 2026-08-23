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
// `backdrop` holds the station's backdrop resolver - the function that turns its
// current track into background art. Only SST resolves movies - it is (and stays)
// the only soundtrack station; the other stations play regular albums, whose
// names would only produce false movie matches. A future station plugs in its own
// resolver function here without touching the engine.
var STATIONS = [
    { 
        id: "sst",       
        name: "StreamingSoundtracks", 
        host: "streamingsoundtracks.com", 
        desc: "Movie scores, TV themes, anime & game music", 
        backdrop: resolveMovieBackdrop, 
        logo: "https://streamingsoundtracks.com/images/logos/logo-sst-v200x200.png" 
    },
    { 
        id: "1980s",     
        name: "1980s.FM",             
        host: "1980s.fm",                 
        desc: "1980s pop, rock & new wave",                  
        logo: "https://1980s.fm/images/logos/1980s_logo-200x200.png" },
    { 
        id: "adagio",    
        name: "Adagio.FM",
        host: "adagio.fm",                
        desc: "Classical & ambient",                         
        logo: "https://adagio.fm/images/logos/logo-afm-200x200.png" },
    { 
        id: "death",     
        name: "Death.FM",             
        host: "death.fm",                 
        desc: "Extreme & underground metal",                 
        logo: "https://death.fm/images/logos/logo-dfm-200x200.png" },
    { 
        id: "entranced", 
        name: "Entranced.FM",         
        host: "entranced.fm",             
        desc: "Trance, ambient & electronic",                
        logo: "https://entranced.fm/images/logos/logo-efm-g200x200.png" 
    }
];

// --- options -----------------------------------------------------------------
// Keys and defaults mirror shared/config.h so the player behaves like the apps.
// Persisted in localStorage (documented in the privacy policy); posterBlur and
// borderRadius stay hidden here too - URL parameters instead of UI, like the INI.
var STORE_KEY = "24sevenfm-covers.player";
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
function orderedIdsOption(known) {
    return function (value) {
        var valid = (value instanceof Array) && value.length > 0
            && value.every(function (id, index, order) {
                return known.indexOf(id) >= 0 && order.indexOf(id) === index;
            });
        var order = (valid ? value : known).slice();
        known.forEach(function (id) {
            if (order.indexOf(id) < 0) order.push(id);
        });
        return order;
    };
}
function enabledIdsOption(known) {
    return value => {
        if (!Array.isArray(value)) return known.slice();
        return known.filter(id => value.indexOf(id) >= 0);
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
var OPTION_DEFS = {
    // layout intentionally differs from the apps' default (fill): a first-time web
    // visitor gets the poster - the layout that shows title/artist without any host
    // player around to provide them. Saved options always win over defaults.
    station: { default: "sst", coerce: function (value) {
        return stationIndex(value) >= 0 ? value : "sst";
    }, effect: applyStation },
    layout: { default: 1, coerce: intOption(0, 1), effect: applyLayout },
    transition: { default: 1, coerce: intOption(0, 3) },
    fadeMs: { default: 1000, coerce: intOption(500, 2000), event: "input",
        format: function (value) { return (value / 1000).toFixed(1) + " s"; } },
    showRemaining: { default: 0, coerce: boolOption, effect: renderCountdown },
    showComingNext: { default: 0, coerce: boolOption, effect: applyComingNextEnabled },
    remainingSize: { default: 0, coerce: intOption(0, 2), effect: sizeStage },
    roll: { default: 0, coerce: boolOption },
    posterBlur: { default: 24, coerce: intOption(0, 200) },
    borderRadius: { default: 45, coerce: intOption(0, 500) },
    volume: { default: 0.8, coerce: floatOption(0.8, 0, 1), event: "input",
        effect: applyVolume },
    laserEnabled: { default: 1, coerce: boolOption, effect: applyLaserEnabled },
    strobeEnabled: { default: 0, coerce: boolOption },
    smokeEnabled: { default: 0, coerce: boolOption, effect: applySmokeEnabled },
    spectrumEnabled: { default: 0, coerce: boolOption, effect: applySpectrumEnabled },
    spectrumBars: { default: 24, coerce: intOption(8, 64), event: "input",
        format: String, effect: resetSpectrumBars },
    spectrumMode: { default: "tinted", coerce: enumOption(["legacy", "tinted"], "tinted"),
        effect: clearSpectrum },
    // Ratings are independently opt-in because they use the same title resolver as
    // backdrops. Country choices remain selected while the master switch is off.
    ratingsEnabled: { default: 0, coerce: boolOption, effect: applyRatingsEnabled },
    ratingDE: { default: 1, coerce: boolOption, effect: applyRatingCountries },
    ratingUS: { default: 1, coerce: boolOption, effect: applyRatingCountries },
    // Experimental film/TV/game backdrops stay OFF by default because enabling them sends
    // current/next soundtrack titles through the project resolver. fanart's optional
    // personal client key can unlock fresher art through that same resolver.
    // providerOrder is the art priority (first enabled provider with art wins), while
    // enabledProviders contains the IDs whose checkbox is active.
    tmdbBackdrops: { default: 0, coerce: boolOption, effect: updateBackdrop },
    fanartKey: { default: "", coerce: function (value) {
        return (typeof value === "string") ? value.trim() : "";
    }, effect: updateBackdrop },
    fanartKeyVerifiedAt: { default: 0, coerce: value => {
        const timestamp = Number(value);
        return Number.isSafeInteger(timestamp) && timestamp > 0
            && timestamp <= 8640000000000000 ? timestamp : 0;
    } },
    enabledProviders: { default: PROVIDER_ORDER, coerce: enabledIdsOption(PROVIDER_ORDER) },
    providerOrder: { default: PROVIDER_ORDER, coerce: orderedIdsOption(PROVIDER_ORDER) },
    // Hide the cover when backdrop is available
    hideCover: { default: 0, coerce: boolOption, effect: updateCoverVisibility }
};
var opts = loadOpts();
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
// Local visual QA can force the retry state even while the real station is healthy.
// The hostname guard makes the switch inert on every deployed origin.
var simulateStationFailure = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(location.hostname)
    && new URLSearchParams(location.search).has("simulateStationFailure");

function loadOpts() {
    var o = {};
    for (var k in OPTION_DEFS) {
        var fallback = OPTION_DEFS[k].default;
        o[k] = fallback instanceof Array ? fallback.slice() : fallback;
    }
    try {
        var saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
        if (!saved || typeof saved !== "object" || saved instanceof Array) saved = {};
        for (var s in saved) if (s in o) o[s] = saved[s];
    } catch (e) { /* corrupt storage -> defaults */ }
    // Coercion is defined beside each default, so storage migration and first-load
    // behavior cannot drift into separate lists as settings are added.
    for (var key in OPTION_DEFS) o[key] = OPTION_DEFS[key].coerce(o[key]);
    // URL parameters override: ?station=death for sharable links, plus the two
    // hidden settings, exactly the set the INI hides from the UI.
    var p = new URLSearchParams(location.search);
    if (p.has("station") && stationIndex(p.get("station")) >= 0) o.station = p.get("station");
    if (p.has("posterBlur")) o.posterBlur = OPTION_DEFS.posterBlur.coerce(p.get("posterBlur"));
    if (p.has("borderRadius"))
        o.borderRadius = OPTION_DEFS.borderRadius.coerce(p.get("borderRadius"));
    return o;
}
function saveOpts() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(opts)); } catch (e) { /* private mode: session-only */ }
}
function stationIndex(id) {
    for (var i = 0; i < STATIONS.length; i++) if (STATIONS[i].id === id) return i;
    return -1;
}
function syncStationUrl() {
    var url = new URL(location.href);
    if (url.searchParams.get("station") === opts.station) return;
    url.searchParams.set("station", opts.station);
    history.replaceState(history.state, "", url);
}

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

    function loadedElement(url) {
        return [a, b].find(element => element.src === url
            && element.complete && element.naturalWidth > 0) || null;
    }

    function settlePending(record, element, removeSource) {
        if (record.settled) return;
        record.settled = true;
        clearTimeout(record.kill);
        record.element.onload = record.element.onerror = null;
        if (removeSource) record.element.removeAttribute("src");
        if (pendingLoad === record) pendingLoad = null;
        record.resolve(element);
    }

    function loadIntoBack(url) {
        const loaded = loadedElement(url);
        if (loaded) return Promise.resolve(loaded);
        if (pendingLoad && pendingLoad.url === url) return pendingLoad.promise;
        if (pendingLoad) settlePending(pendingLoad, null, true);

        const back = front === a ? b : a;
        const record = {
            element: back,
            url,
            settled: false,
            kill: null,
            resolve: null,
            promise: null
        };
        record.promise = new Promise(resolve => { record.resolve = resolve; });
        pendingLoad = record;
        record.kill = setTimeout(() => settlePending(record, null, true), IMAGE_TIMEOUT);
        back.onload = () => settlePending(record, back, false);
        back.onerror = () => settlePending(record, null, true);
        back.src = url;
        // A memory-cache hit may complete synchronously without a later load event.
        if (back.complete && back.naturalWidth > 0)
            queueMicrotask(() => settlePending(record, back, false));
        return record.promise;
    }

    return {
        prepare: function (url) { return loadIntoBack(url); },
        show: function (url, generation, onShown, onError) {
            if (front && front.src === url && front.classList.contains("show")) return;
            loadIntoBack(url).then(function (back) {
                if (!renderIsCurrent(channel, generation)) return;
                if (!back) {
                    if (onError) onError();
                    return;
                }
                back.classList.add("show");
                if (front && front !== back) front.classList.remove("show");
                front = back;
                if (onShown) onShown();
            });
        },
        hide: function () {
            a.classList.remove("show");
            b.classList.remove("show");
            front = null;
        }
    };
}
var blurLayer = makeLayer($("backdropA"), $("backdropB"), "cover");
var imgA = $("coverA"), imgB = $("coverB");
var cdEl = $("countdown"), statusEl = $("status"), stageStatusEl = $("stage-status");
var comingNextEl = $("coming-next"), comingNextContentEl = $("coming-next-content");
var comingNextLabelEl = comingNextEl.querySelector(".coming-next-label");
var comingNextAlbumEl = $("coming-next-album"), comingNextArtistEl = $("coming-next-artist");
var backdropErrorEl = $("backdrop-error"), backdropErrorTextEl = $("backdrop-error-text");
var backdropRetryEl = $("backdrop-retry");
var audioEl = $("audio");

// One info box serves both layouts (title, artist, countdown) - overlaid on the
// stage in fill, sitting below the cover in poster.
function setInfo(title, artist) {
    $("info-title").textContent = title;
    $("info-artist").textContent = artist;
}

var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

// Each country keeps two badge faces on one 3D card. The next rating is loaded into
// the hidden face first, then the same transition and duration as the cover turn the
// already-attached back face into view.
function makeRatingSlot(slot) {
    var faces = Array.from(slot.querySelectorAll(".rating-face"));
    var token = "", version = 0, settleTimer = null;

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
    }

    function effectName() {
        var effect = reducedMotion.matches ? 0 : opts.transition;
        stage.style.setProperty("--fade-ms", opts.fadeMs + "ms");
        return ["none", "fade", "fliph", "flipv"][effect];
    }

    function reveal(front, certification) {
        var fx = effectName(), wasHidden = !slot.classList.contains("show");
        clearTimeout(settleTimer);
        delete slot.dataset.settled;
        if (slot.dataset.fx !== fx) {
            slot.dataset.warp = "";
            slot.dataset.fx = fx;
            void slot.offsetWidth;
            delete slot.dataset.warp;
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
            }, opts.fadeMs + 50);
        }
    }

    function show(certification, generation) {
        if (!certification) { hide(); return; }
        var nextToken = [certification.rating, certification.label,
            certification.logo || ""].join("\n");
        if (token === nextToken && slot.dataset.front) {
            reveal(slot.dataset.front, certification);
            return;
        }

        var currentVersion = ++version;
        var back = slot.dataset.front === "a" ? faces[1] : faces[0];
        var commit = function (logo) {
            if (version !== currentVersion || !renderIsCurrent("backdrop", generation)) return;
            setFace(back, certification, logo);
            token = nextToken;
            reveal(back === faces[0] ? "a" : "b", certification);
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

// A new track reserves an intro window, but its ten seconds start only when the
// first selected rating is actually revealed. Resolver and SVG latency therefore
// cannot consume the entire window before the listener has seen a badge.
function prepareRatingTrackVisibility() {
    clearTimeout(ratingIntroTimer);
    ratingIntroPending = true;
    ratingBadgesEl.classList.remove("track-intro");
}

function cancelRatingTrackVisibility() {
    clearTimeout(ratingIntroTimer);
    ratingIntroPending = false;
    ratingBadgesEl.classList.remove("track-intro");
}

function maybeBeginRatingTrackVisibility() {
    if (!ratingIntroPending || !ratingBadgesEl.querySelector(".rating-slot.show")) return;
    ratingIntroPending = false;
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
    ratingSlots.DE.show(opts.ratingsEnabled && opts.ratingDE ? byCountry.DE : null, generation);
    ratingSlots.US.show(opts.ratingsEnabled && opts.ratingUS ? byCountry.US : null, generation);
}

function setRatings(certifications, generation) {
    if (!renderIsCurrent("backdrop", generation)) return;
    currentCertifications = certifications instanceof Array ? certifications : [];
    renderRatingBadges(generation);
}

function syncRatingControls() {
    var countries = $("rating-country-options"), master = $("ratings-enabled");
    countries.classList.toggle("enabled", !!opts.ratingsEnabled);
    countries.setAttribute("aria-hidden", opts.ratingsEnabled ? "false" : "true");
    master.setAttribute("aria-expanded", opts.ratingsEnabled ? "true" : "false");
    [$("rating-de-enabled"), $("rating-us-enabled")].forEach(function (control) {
        control.disabled = !opts.ratingsEnabled;
    });
}

function applyRatingsEnabled() {
    syncRatingControls();
    if (opts.ratingsEnabled) prepareRatingTrackVisibility();
    else cancelRatingTrackVisibility();
    // Hiding is immediate state work (the CSS then performs the exit transition).
    // Do not leave a stale badge up while a replacement resolver request settles.
    renderRatingBadges(renderGenerations.backdrop);
    updateBackdrop();
}

function applyRatingCountries() {
    renderRatingBadges(renderGenerations.backdrop);
}

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
    return !!opts.showComingNext
        || (!!station().backdrop && (opts.tmdbBackdrops || opts.ratingsEnabled));
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

function comingNextWidth() {
    var style = getComputedStyle(comingNextEl);
    var padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
        + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
    var natural = Math.max(
        comingNextContentEl.scrollWidth,
        comingNextLabelEl.scrollWidth,
        comingNextAlbumEl.scrollWidth,
        comingNextArtistEl.scrollWidth) + padding;
    var available = Math.max(0, stage.getBoundingClientRect().width - 22);
    return Math.ceil(Math.min(natural, window.innerWidth * 0.5, available));
}

function setComingNextContent() {
    comingNextAlbumEl.textContent = nextTrack ? nextTrack.displayAlbum : "";
    comingNextArtistEl.textContent = nextTrack ? nextTrack.artist : "";
    comingNextEl.style.setProperty("--coming-next-width", comingNextWidth() + "px");
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
    var shouldShow = !!opts.showComingNext && !!nextTrack
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
    if (!opts.showComingNext && !queuedArtistIsNeeded()) cancelNextCredit(true);
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
        const r = await fetch("https://" + station().host
            + "/soap/FM24sevenJSON.php?action=GetCurrentlyPlaying&_t=" + Date.now(),
            { signal: ctl.signal });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
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
        const isStationId = !displayCover;
        const trackIdentityChanged = album !== currentAlbum || track !== currentTrack
            || isStationId !== stationIdActive;
        // Prefer the feed's 40 px thumbnail for the whole-image colour mean. Keep
        // CoverLink as a compatibility fallback and the /500/ variant for display.
        updateCoverTint(isStationId ? "" : tintCover);
        if (album !== currentAlbum || track !== currentTrack || artist !== currentArtist
                || isStationId !== stationIdActive) {
            const metadataChanged = trackIdentityChanged || artist !== currentArtist;
            if (trackIdentityChanged) {
                setNextTrack(null);
                // The outgoing image remains mounted while CSS fades it, but it must
                // stop claiming the stage as soon as a different track is confirmed.
                const staleGeneration = nextRenderGeneration("backdrop");
                cancelBackdropRequest();
                setMovieBackdrop(null, staleGeneration);
                setRatings([], staleGeneration);
            }
            currentAlbum = album; currentTrack = track; currentArtist = artist;
            stationIdActive = isStationId;
            if (metadataChanged) prepareRatingTrackVisibility();
            updateBackdrop();
        }
        let title = displayAlbum;
        if (displayAlbum && track) title = displayAlbum + " - " + track;
        else if (track) title = track;
        if (title && lengthSec > 0)
            title += " (" + Math.floor(lengthSec / 60) + ":" + String(lengthSec % 60).padStart(2, "0") + ")";
        setInfo(title || "—", artist);

        const cover = isStationId ? station().logo : displayCover;
        if (cover && cover !== shownUrl && cover !== loadingCoverUrl) showCover(cover);
        clearStatus("station");
        lastSuccessfulPollAt = Date.now();
        const trackToken = [album, track, isStationId ? "station" : displayCover].join("\n");
        scheduleHealthyPoll(trackToken, lengthSec, remaining, timingIsValid);
        if (trackIdentityChanged || !queueSnapshotReady)
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
    var includeArt = !!opts.tmdbBackdrops && providers.length > 0;
    return JSON.stringify([
        includeArt ? providers : ["tmdb"],
        providers.indexOf("fanart") >= 0 ? opts.fanartKey : "",
        includeArt,
        !!opts.ratingsEnabled,
        entry && entry.artist || "",
    ]);
}

function queuedTrackNeedsPrefetch(entry) {
    if (!entry) return false;
    if (entry.coverUrl && !entry.coverPrepared) return true;
    if (entry.tintUrl && !entry.tintAttempted
            && !Object.prototype.hasOwnProperty.call(coverTintCache, entry.tintUrl)) return true;
    if (queuedArtistIsNeeded() && !entry.artist && entry.albumUrl && !entry.creditAttempted)
        return true;
    return !!station().backdrop && (opts.tmdbBackdrops || opts.ratingsEnabled)
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
    if (station().backdrop && (opts.tmdbBackdrops || opts.ratingsEnabled)) {
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
        var effect = reducedMotion.matches ? 0 : opts.transition;
        stage.style.setProperty("--fade-ms", opts.fadeMs + "ms");
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
        // A station switch can begin while SST's cover is hidden behind a media
        // backdrop. Keep that old cover suppressed until this destination image has
        // replaced it, then let the coverbox fade back in with the new station's art.
        coverHiddenForStationSwitch = false;
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
// per-title cache (negative results too) keeps it to one request per work, and every
// failure path falls back silently to the blurred cover - experimental means the
// player must never be worse off for having it enabled.
var movieLayer = makeLayer($("movieA"), $("movieB"), "backdrop");
var movieShown = false; // a screen backdrop is currently visible (drives hide-cover)
var coverHiddenForStationSwitch = false;
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
// the backdrop be the star. Only ever active when there IS a backdrop - no match, no
// key, or feature off always brings the cover back.
function updateCoverVisibility() {
    stage.classList.toggle("no-cover",
        !!(coverHiddenForStationSwitch || (opts.hideCover && movieShown)));
}
var currentAlbum = "", currentTrack = "", currentArtist = "", stationIdActive = false;

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
    return opts.providerOrder.filter(id =>
        ART_PROVIDER_BY_ID[id] && opts.enabledProviders.indexOf(id) >= 0);
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
        seen[entry.country] = true;
        certifications.push({
            country: entry.country,
            rating: rating,
            label: label,
            system: system,
            logo: trustedRatingLogo(entry.logo, entry.country, system, rating),
            accessibleLabel: (entry.country === "DE" ? "Germany: " : "United States: ") + label,
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

function setMovieBackdrop(art, generation) {
    if (!renderIsCurrent("backdrop", generation)) return;
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
        function () { movieShown = true; updateCoverVisibility(); },
        function () {
            movieLayer.hide();
            movieShown = false;
            currentMovieTint = null;
            applyPreferredPlayerTint();
            updateCoverVisibility();
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

function requestBackdrop(cacheMode) {
    const generation = nextRenderGeneration("backdrop");
    cancelBackdropRequest();
    if (cacheMode === "reload" && opts.tmdbBackdrops) {
        setStatus("Loading backdrop artwork…", "backdrop");
        setBackdropErrorState("retrying");
    } else {
        clearStatus("backdrop");
        setBackdropErrorState("");
    }
    // The station-ID flag set by poll() (the one that also picks the logo): never a
    // movie, so no API call - and no leftover backdrop behind the station logo.
    if (stationIdActive || (!opts.tmdbBackdrops && !opts.ratingsEnabled)) {
        setMovieBackdrop(null, generation);
        setRatings([], generation);
        return;
    }
    const resolver = station().backdrop;
    if (!resolver) {
        setMovieBackdrop(null, generation);
        setRatings([], generation);
        return;
    } // no media source
    const ctl = new AbortController();
    const request = {
        ctl: ctl,
        kill: setTimeout(function () { ctl.abort(); }, REQ_TIMEOUT)
    };
    backdropRequest = request;
    Promise.resolve(resolver(generation, ctl.signal, cacheMode)).then(settled, settled);
    function settled() {
        clearTimeout(request.kill);
        if (backdropRequest === request) backdropRequest = null;
    }
}

function updateBackdrop() {
    requestBackdrop();
    scheduleQueuePrefetch(true);
}
function retryBackdrop() { requestBackdrop("reload"); }

// Resolve only through the project endpoint. The per-title cache stores misses too;
// endpoint failures stay uncached so a later poll or option change can retry.
async function movieArtFor(album, track, artist, generation, signal, cacheMode) {
    const providers = enabledMovieProviders();
    const includeArt = !!opts.tmdbBackdrops && providers.length > 0;
    const includeRatings = !!opts.ratingsEnabled;
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

async function resolveMovieBackdrop(generation, signal, cacheMode) {
    if (!renderIsCurrent("backdrop", generation)) return;
    try {
        const art = await movieArtFor(currentAlbum, currentTrack, currentArtist, generation, signal,
            cacheMode);
        if (!renderIsCurrent("backdrop", generation)) return;
        clearStatus("backdrop");
        setBackdropErrorState("");
        setMovieBackdrop(opts.tmdbBackdrops ? art : null, generation);
        setRatings(art && art.certifications || [], generation);
    } catch (e) {
        if (!renderIsCurrent("backdrop", generation)) return;
        if (opts.tmdbBackdrops
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
    var rem = opts.showRemaining ? currentRemaining() : -1;
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
        if (!opts.roll || reducedMotion.matches || !c.cur.animate) { c.cur.textContent = ch; continue; }
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
    var side = opts.layout === 1
        ? Math.min(r.height * 0.58, r.width * 0.86)
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
    var cdFrac = [0.048, 0.062, 0.08][opts.remainingSize];
    stage.style.setProperty("--cd-size", Math.max(12, side * cdFrac) + "px");
    // The grid fixes the info box's center. Re-center the cover in the space above
    // the box's visible top edge; when the box grows, CSS animates this small shift.
    // With 72/28 rows the simplified offset is 7% of stage height - 25% of box height.
    var infoRect = document.querySelector(".info").getBoundingClientRect();
    var infoHeight = infoRect.height;
    var coverShift = opts.layout === 1 ? r.height * 0.07 - infoHeight * 0.25 : 0;
    stage.style.setProperty("--cover-shift", coverShift + "px");
    if (opts.layout === 1) {
        var coverBottom = r.height * 0.36 + coverShift + side * 0.5;
        var infoTop = infoRect.top - r.top;
        stage.style.setProperty("--spectrum-top", ((coverBottom + infoTop) * 0.5) + "px");
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
var spectrumEl = $("stage-spectrum"), laserEl = $("stage-lasers");
var laserFrontEl = $("stage-lasers-front");
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
                laserElement: laserEl,
                laserForegroundElement: laserFrontEl,
                infoElement: document.querySelector(".info"),
                getOptions: () => opts,
                isAudioWanted: () => audioWanted,
                hasAudioPlayed: () => audioHasPlayed,
                reducedMotion: reducedMotion
            });
            if (!audioSpectrumController
                    || typeof audioSpectrumController.prepare !== "function"
                    || typeof audioSpectrumController.sync !== "function")
                throw new Error("Invalid audio spectrum controller");
            // The shared analyser may be needed by any plugin (the 80s laser show is
            // on by default), not only by the compact spectrum plugin.
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
        if (control.type === "checkbox") control.checked = !!value;
        else if (control.type === "radio") control.checked = control.value === String(value);
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
    opts[key] = def.coerce(raw);
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
function applyStation() {
    // Keep the shareable URL on the station the player is actually showing. Replace
    // the current history entry so trying several stations does not make Back step
    // through every radio-button click; unrelated parameters and the hash survive.
    syncStationUrl();
    // If a media backdrop currently owns the stage, clearing it below must not expose
    // SST's still-buffered cover. showCover() releases this hold only after the new
    // station cover (or logo) has loaded and become the front buffer.
    coverHiddenForStationSwitch = stage.classList.contains("no-cover");
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
var strobeEnabledEl = $("strobe-enabled");
var smokeEnabledEl = $("smoke-enabled");
function syncSpectrumSettingControls() {
    spectrumBarsEl.disabled = !opts.spectrumEnabled;
    spectrumModeEls.forEach(function (input) { input.disabled = !opts.spectrumEnabled; });
}
function syncLaserSettingControls() {
    strobeEnabledEl.disabled = !opts.laserEnabled;
    smokeEnabledEl.disabled = !opts.laserEnabled;
}
function applySpectrumEnabled() {
    syncSpectrumSettingControls();
    if (opts.spectrumEnabled && audioWanted) prepareSpectrum();
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
bindOptionControls();
restoreFanartKeyCheck();
syncSpectrumSettingControls();
syncLaserSettingControls();
syncRatingControls();

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
opts.providerOrder.forEach(function (id) {
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
    opts.providerOrder = Array.prototype.map.call(providersEl.children, function (li) {
        return li.dataset.provider;
    });
    saveOpts();
    updateBackdrop();
    syncProviderHandles(moved);
}
syncProviderHandles();
// One generic wiring for every provider row: the checkbox IS the provider's
// enabled property (getter/setter over its backing option) - a new provider row
// needs no handler code of its own.
Array.prototype.forEach.call(providersEl.querySelectorAll(".provider"), function (li) {
    var provider = ART_PROVIDER_BY_ID[li.dataset.provider];
    if (!provider) throw new Error("Unknown artwork provider control: " + li.dataset.provider);
    var box = li.querySelector('input[type="checkbox"]');
    box.checked = opts.enabledProviders.indexOf(provider.id) >= 0;
    box.addEventListener("change", function () {
        opts.enabledProviders = PROVIDER_ORDER.filter(id => {
            return id === provider.id
                ? box.checked : opts.enabledProviders.indexOf(id) >= 0;
        });
        saveOpts();
        updateBackdrop();
    });
});
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
        document.body.classList.add("row-dragging");
        moveTo(e);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", endDrag);
        window.addEventListener("pointercancel", endDrag);
    });
})();

// --- go ----------------------------------------------------------------------
applyLayout();
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
