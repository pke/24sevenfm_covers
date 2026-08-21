// player.js - the web player: the desktop viewer's feature set, in the browser.
//
// Same data source and timing as the apps (lib/coverfetch.cpp): poll the station's
// now-playing JSON, show the cover, re-poll when the track should end. Verified
// against the live servers: every station grants CORS on the JSON endpoint
// (Access-Control-Allow-Origin: *) and proxies an HTTPS stream at
// https://<host>/live - the same endpoint the station's own web player uses. So
// Station playback still talks DIRECTLY to the selected station. The optional movie
// backdrop feature uses this project's small resolver endpoint, as disclosed in the
// privacy policy. The browser never calls the metadata providers directly.
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

var ART_PROVIDER_DEFS = [
    { id: "fanart", name: "fanart.tv" },
    { id: "tmdb", name: "TMDB" },
    { id: "steamgriddb", name: "GameArt by SteamGridDB" }
];
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
    remainingSize: { default: 0, coerce: intOption(0, 2), effect: sizeStage },
    roll: { default: 0, coerce: boolOption },
    posterBlur: { default: 24, coerce: intOption(0, 200) },
    borderRadius: { default: 45, coerce: intOption(0, 500) },
    volume: { default: 0.8, coerce: floatOption(0.8, 0, 1), event: "input",
        effect: applyVolume },
    spectrumEnabled: { default: 0, coerce: boolOption, effect: applySpectrumEnabled },
    spectrumBars: { default: 24, coerce: intOption(8, 64), event: "input",
        format: String, effect: resetSpectrumBars },
    spectrumMode: { default: "tinted", coerce: enumOption(["legacy", "tinted"], "tinted"),
        effect: clearSpectrum },
    // Experimental film/TV/game backdrops stay OFF by default because enabling them sends
    // current/next soundtrack titles through the project resolver. fanart's optional
    // personal client key can unlock fresher art through that same resolver.
    // providerOrder is the art priority (first enabled provider with art wins), while
    // enabledProviders contains the IDs whose checkbox is active.
    tmdbBackdrops: { default: 0, coerce: boolOption, effect: updateBackdrop },
    fanartKey: { default: "", coerce: function (value) {
        return (typeof value === "string") ? value.trim() : "";
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
    var front = null;
    return {
        show: function (url, generation, onShown, onError) {
            if (front && front.src === url && front.classList.contains("show")) return;
            var back = (front === a) ? b : a;
            preloadImage(url, function () {
                if (!renderIsCurrent(channel, generation)) return;
                back.src = url;
                back.classList.add("show");
                if (front) front.classList.remove("show");
                front = back;
                if (onShown) onShown();
            }, function () {
                if (renderIsCurrent(channel, generation) && onError) onError();
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
var audioEl = $("audio");

// One info box serves both layouts (title, artist, countdown) - overlaid on the
// stage in fill, sitting below the cover in poster.
function setInfo(title, artist) {
    $("info-title").textContent = title;
    $("info-artist").textContent = artist;
}

var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

// --- poll engine (ported from lib/coverfetch.cpp) ----------------------------
var MIN_POLL = 5, MAX_POLL = 3600, ERR_RETRY = 8, ERR_CAP = 60, REQ_TIMEOUT = 20000;
var pollTimer = null, tickTimer = null, inflight = null, errBackoff = ERR_RETRY;
var retryAt = 0;
var shownUrl = "", loadingCoverUrl = "", remAnchor = -1, remAnchorAt = 0;
var coverRetryUrl = "", coverRetryFailures = 0, coverRetryTimer = null;

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
        if (!isNaN(ps) && !isNaN(st)) elapsed = Math.abs(st - ps) / 1000;
        const remaining = Math.max(0, Math.floor(lengthSec - elapsed));
        remAnchor = lengthSec > 0 ? remaining : -1;
        remAnchorAt = Date.now();

        const album = htmlDecode(j.Album), displayAlbum = unrotateTitleArticle(album);
        const track = htmlDecode(j.Track);
        // ONE determination drives everything downstream: no trusted CoverLink means
        // a station ID, unregistered track, or rejected off-origin URL.
        // The same flag that swaps the cover for the station logo below also
        // vetoes the media-art lookup - a station ident is not a soundtrack, so its name must
        // not leak to a third party as a search. One source of truth, so the
        // logo and the veto can never disagree.
        const tintCover = trustedCoverUrl(j.CoverLink);
        const trustedCover = sizedCoverUrl(j.CoverLink);
        const isStationId = !trustedCover;
        // The feed's original CoverLink is already a 200 px thumbnail. Keep the
        // /500/ variant for display, but send only the smaller original to /api/tint.
        updateCoverTint(isStationId ? "" : tintCover);
        if (album !== currentAlbum || track !== currentTrack
                || isStationId !== stationIdActive) {
            currentAlbum = album; currentTrack = track;
            stationIdActive = isStationId;
            updateBackdrop();
        }
        let title = displayAlbum;
        if (displayAlbum && track) title = displayAlbum + " - " + track;
        else if (track) title = track;
        if (title && lengthSec > 0)
            title += " (" + Math.floor(lengthSec / 60) + ":" + String(lengthSec % 60).padStart(2, "0") + ")";
        setInfo(title || "—", htmlDecode(j.Artist));

        const cover = isStationId ? station().logo : trustedCover;
        if (cover && cover !== shownUrl && cover !== loadingCoverUrl) showCover(cover);
        clearStatus("station");
        // Re-poll when the track should end (clamped), +1s for the server to roll over.
        schedulePoll(Math.min(MAX_POLL, Math.max(MIN_POLL, remaining)) + 1);
        prefetchNext(ctl, renderGenerations.backdrop); // fire-and-forget: warm the NEXT track's art meanwhile
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
    }
}

var statusMessages = { station: "", audio: "", backdrop: "", general: "" };
function renderStatus() {
    var text = statusMessages.station || statusMessages.audio
        || statusMessages.backdrop || statusMessages.general;
    statusEl.textContent = text;
    stageStatusEl.textContent = statusMessages.station;
    stageStatusEl.classList.toggle("show", !!statusMessages.station);
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

// Prefetch the NEXT track from the station's queue (action=GetQueue, same CORS
// grant as the now-playing feed; [0] is up next): warm its sized cover into the
// browser cache, and - when screen backdrops are on and this station resolves them -
// resolve its movie/TV/game art into the per-title cache and warm that image too. The
// track change then lands with zero network waits: showCover's preload and the
// backdrop lookup all hit caches. Best-effort by design: one attempt per poll, and
// any failure just means the switch loads the way it always did. A child controller
// keeps the request's own timeout alive after poll() clears its timer, while still
// inheriting the poll abort so a station switch cancels stale queue work immediately.
async function prefetchNext(ctl, generation) {
    const prefetchCtl = new AbortController();
    const abortPrefetch = function () { prefetchCtl.abort(); };
    if (ctl.signal.aborted) abortPrefetch();
    else ctl.signal.addEventListener("abort", abortPrefetch, { once: true });
    const kill = setTimeout(abortPrefetch, REQ_TIMEOUT);
    try {
        const r = await fetch("https://" + station().host
            + "/soap/FM24sevenJSON.php?action=GetQueue&_t=" + Date.now(),
            { signal: prefetchCtl.signal });
        if (!r.ok) return;
        const next = ((await r.json()) || [])[0];
        // No entry or no trusted CoverLink (station ID or rejected URL): nothing to warm.
        const nextCover = next && sizedCoverUrl(next.CoverLink);
        if (!nextCover) return;
        new Image().src = nextCover;
        // station().backdrop currently always means the screen-media resolver; if other
        // resolver kinds ever appear, prefetching becomes their concern.
        if (opts.tmdbBackdrops && station().backdrop) {
            const art = await movieArtFor(htmlDecode(next.Album), htmlDecode(next.Track), generation,
                                          prefetchCtl.signal);
            if (art && art.url && renderIsCurrent("backdrop", generation))
                new Image().src = art.url;
        }
    } catch (e) { /* prefetch is best-effort */ }
    finally {
        clearTimeout(kill);
        ctl.signal.removeEventListener("abort", abortPrefetch);
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
var tmdbCache = newMovieCache(); // cleaned title -> {url,tint} or null (searched, no match)
var backdropRequest = null;

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
var currentAlbum = "", currentTrack = "", stationIdActive = false;

var SERVER_ART_UNAVAILABLE = {};

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

    var response;
    try { response = await fetch(url.href, signal ? { signal: signal } : undefined); }
    catch (e) {
        if (e && e.name === "AbortError") throw e;
        throw SERVER_ART_UNAVAILABLE;
    }
    if (!response.ok) throw SERVER_ART_UNAVAILABLE;
    var body;
    try { body = await response.json(); }
    catch (e) { throw SERVER_ART_UNAVAILABLE; }
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

async function serverMovieArt(album, track, providers, signal) {
    if (!BACKDROP_API_URL) throw SERVER_ART_UNAVAILABLE;
    var url;
    try {
        url = new URL(BACKDROP_API_URL, location.href);
        url.searchParams.set("album", album);
        if (track) url.searchParams.set("track", track);
        url.searchParams.set("providers", providers.join(","));
        if (opts.fanartKey && providers.indexOf("fanart") >= 0)
            url.searchParams.set("client_key", opts.fanartKey);
    } catch (e) { throw SERVER_ART_UNAVAILABLE; }

    var response;
    try { response = await fetch(url.href, signal ? { signal: signal } : undefined); }
    catch (e) {
        if (e && e.name === "AbortError") throw e;
        throw SERVER_ART_UNAVAILABLE;
    }
    if (!response.ok) throw SERVER_ART_UNAVAILABLE;
    var body;
    try { body = await response.json(); }
    catch (e) { throw SERVER_ART_UNAVAILABLE; }
    if (!body || !body.backdrop) return null;
    var resolved = trustedResolvedBackdrop(body.backdrop, body.source);
    if (!resolved) throw SERVER_ART_UNAVAILABLE;
    return { url: resolved, tint: validTint(body.tint), source: body.source };
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

function updateBackdrop() {
    const generation = nextRenderGeneration("backdrop");
    cancelBackdropRequest();
    clearStatus("backdrop");
    // The station-ID flag set by poll() (the one that also picks the logo): never a
    // movie, so no API call - and no leftover backdrop behind the station logo.
    if (stationIdActive || !opts.tmdbBackdrops) { setMovieBackdrop(null, generation); return; }
    const resolver = station().backdrop;
    if (!resolver) { setMovieBackdrop(null, generation); return; } // no art source
    const ctl = new AbortController();
    const request = {
        ctl: ctl,
        kill: setTimeout(function () { ctl.abort(); }, REQ_TIMEOUT)
    };
    backdropRequest = request;
    Promise.resolve(resolver(generation, ctl.signal)).then(settled, settled);
    function settled() {
        clearTimeout(request.kill);
        if (backdropRequest === request) backdropRequest = null;
    }
}

// Resolve only through the project endpoint. The per-title cache stores misses too;
// endpoint failures stay uncached so a later poll or option change can retry.
async function movieArtFor(album, track, generation, signal) {
    const providers = enabledMovieProviders();
    if (!renderIsCurrent("backdrop", generation) || !album || !providers.length) return null;
    const cache = tmdbCache; // option changes replace the cache; stale work keeps this one
    const cacheKey = album + "\n" + track;
    if (Object.prototype.hasOwnProperty.call(cache, cacheKey)) return cache[cacheKey];

    const art = await serverMovieArt(album, track, providers, signal);
    if (!renderIsCurrent("backdrop", generation)) return null;
    cache[cacheKey] = art;
    return art;
}

async function resolveMovieBackdrop(generation, signal) {
    if (!renderIsCurrent("backdrop", generation)) return;
    try {
        const art = await movieArtFor(currentAlbum, currentTrack, generation, signal);
        if (!renderIsCurrent("backdrop", generation)) return;
        setMovieBackdrop(art, generation);
    } catch (e) {
        if (!renderIsCurrent("backdrop", generation)) return;
        if (e === SERVER_ART_UNAVAILABLE || (e && e.name === "AbortError"))
            setStatus("Backdrop service is currently unavailable.", "backdrop");
        setMovieBackdrop(null, generation); // any failure: quietly back to the blurred cover
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
    positionSpectrumOptions();
}
if (window.ResizeObserver) {
    var layoutObserver = new ResizeObserver(sizeStage);
    layoutObserver.observe(stage);
    layoutObserver.observe(document.querySelector(".info"));
}

// --- audio -------------------------------------------------------------------
var audioBtn = $("audio-toggle"), stageAudioBtn = $("stage-audio");
var spectrumEl = $("stage-spectrum");
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
    if (audioSpectrumController) audioSpectrumController.clear();
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
            if (typeof module.createAudioSpectrumController !== "function")
                throw new Error("Invalid audio spectrum module");
            audioSpectrumController = module.createAudioSpectrumController({
                audioElement: audioEl,
                spectrumElement: spectrumEl,
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
            if (opts.spectrumEnabled && audioWanted) audioSpectrumController.prepare();
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
// stage covers the whole screen. pointermove covers mouse, pen and touch alike.
var idleTimer = null;
function chromeWake() {
    if (!document.fullscreenElement) return;
    stage.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
        if (!optionsOpen) stage.classList.add("idle"); // never fade while adjusting options
    }, 2000);
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
    // If a media backdrop currently owns the stage, clearing it below must not expose
    // SST's still-buffered cover. showCover() releases this hold only after the new
    // station cover (or logo) has loaded and become the front buffer.
    coverHiddenForStationSwitch = stage.classList.contains("no-cover");
    nextRenderGeneration("cover"); // invalidate image loads before the new poll returns
    updateCoverTint("");
    const backdropGeneration = nextRenderGeneration("backdrop");
    cancelBackdropRequest();
    setMovieBackdrop(null, backdropGeneration);
    shownUrl = ""; loadingCoverUrl = ""; remAnchor = -1;
    resetCoverRetry("");
    // The resolver is per-station now - always re-evaluate after a switch, even if
    // the new station plays an identically named album.
    currentAlbum = ""; currentTrack = "";
    setInfo("Loading…", "");
    setStatus("");
    if (audioWanted) setAudio(true); // retune the stream
    poll();
}

var spectrumBarsEl = $("spectrum-bars");
var spectrumModeEls = document.querySelectorAll('input[name="spectrum-mode"]');
function syncSpectrumSettingControls() {
    spectrumBarsEl.disabled = !opts.spectrumEnabled;
    spectrumModeEls.forEach(function (input) { input.disabled = !opts.spectrumEnabled; });
}
function applySpectrumEnabled() {
    syncSpectrumSettingControls();
    if (opts.spectrumEnabled && audioWanted) prepareSpectrum();
    syncSpectrum();
}
function resetSpectrumBars() {
    if (audioSpectrumController) audioSpectrumController.resetBars();
}
bindOptionControls();
syncSpectrumSettingControls();
var fanartKeyEl = $("fanart-key");
fanartKeyEl.value = opts.fanartKey;
fanartKeyEl.addEventListener("change", function () {
    opts.fanartKey = fanartKeyEl.value.trim();
    tmdbCache = newMovieCache(); // cached art may now be upgradable (or was fanart-based)
    saveOpts();
    updateBackdrop();
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
    tmdbCache = newMovieCache(); // priority decides which source's URL gets cached
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
        tmdbCache = newMovieCache(); // every cached URL may be the other source's now
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
tickTimer = setInterval(function () {
    renderCountdown();
    renderRetryStatus();
}, 1000);
poll();

})();
