// player.js - the web player: the desktop viewer's feature set, in the browser.
//
// Same data source and timing as the apps (lib/coverfetch.cpp): poll the station's
// now-playing JSON, show the cover, re-poll when the track should end. Verified
// against the live servers: every station grants CORS on the JSON endpoint
// (Access-Control-Allow-Origin: *) and proxies an HTTPS stream at
// https://<host>/live - the same endpoint the station's own web player uses. So
// everything here talks DIRECTLY to the station; nothing is routed through this
// site, which is also what the privacy policy promises.
//
// Without JavaScript none of this runs; the <noscript> block in player.html still
// offers the plain <audio> streams, which need no script at all.
"use strict";
(function () {

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
var DEFAULTS = {
    // layout intentionally differs from the apps' default (fill): a first-time web
    // visitor gets the poster - the layout that shows title/artist without any host
    // player around to provide them. Saved options always win over defaults.
    station: "sst", 
    layout: 1, 
    transition: 1, 
    fadeMs: 1000,
    showRemaining: 0, 
    remainingSize: 0, 
    roll: 0,
    posterBlur: 24, 
    borderRadius: 45, 
    volume: 0.8,
    // Experimental TMDB movie backdrops: OFF by default and bring-your-own-key, both
    // deliberately - enabling it sends the current album title to a third party, which
    // the privacy policy discloses, and a key shipped in public JS would be everyone's.
    // fanartBackdrops defaults ON: entering a fanart key was the opt-in before the
    // toggle existed, so a saved key keeps behaving exactly as it always has.
    // providerOrder is the art priority (first enabled provider with art wins);
    // tmdbArt is TMDB's own checkbox in that list, like fanartBackdrops is fanart's.
    tmdbBackdrops: 0, 
    tmdbKey: "", 
    fanartKey: "", 
    fanartBackdrops: 1, 
    tmdbArt: 1,
    providerOrder: ["fanart", "tmdb"],
    // Hide the cover when backdrop is available
    hideCover: 0
};
var opts = loadOpts();

function clampInt(v, lo, hi) { v = parseInt(v, 10); return isNaN(v) ? lo : Math.min(hi, Math.max(lo, v)); }

function loadOpts() {
    var o = {};
    for (var k in DEFAULTS) o[k] = DEFAULTS[k];
    try {
        var saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
        for (var s in saved) if (s in o) o[s] = saved[s];
    } catch (e) { /* corrupt storage -> defaults */ }
    // Same clamps as ssccfg::load().
    o.layout        = clampInt(o.layout, 0, 1);
    o.transition    = clampInt(o.transition, 0, 3);
    o.fadeMs        = clampInt(o.fadeMs, 500, 2000);
    o.remainingSize = clampInt(o.remainingSize, 0, 2);
    o.posterBlur    = clampInt(o.posterBlur, 0, 200);
    o.borderRadius  = clampInt(o.borderRadius, 0, 500);
    o.volume = parseFloat(o.volume);
    if (!isFinite(o.volume)) o.volume = DEFAULTS.volume;
    o.volume = Math.min(1, Math.max(0, o.volume));
    ["showRemaining", "roll", "tmdbBackdrops", "fanartBackdrops", "tmdbArt",
        "hideCover"].forEach(function (key) {
        var value = o[key];
        o[key] = (value === true || value === 1 || value === "1") ? 1 : 0;
    });
    ["tmdbKey", "fanartKey"].forEach(function (key) {
        o[key] = (typeof o[key] === "string") ? o[key].trim() : "";
    });

    // providerOrder must be a permutation of the known providers - anything else
    // (older saves, hand-edited storage) falls back to the default order. Always a
    // fresh array: the drag list mutates it, and DEFAULTS must never change.
    var known = DEFAULTS.providerOrder;
    var valid = (o.providerOrder instanceof Array)
        && o.providerOrder.length === known.length
        && known.every(function (id) { return o.providerOrder.indexOf(id) >= 0; });
    o.providerOrder = (valid ? o.providerOrder : known).slice();
    if (stationIndex(o.station) < 0) o.station = "sst";
    // URL parameters override: ?station=death for sharable links, plus the two
    // hidden settings, exactly the set the INI hides from the UI.
    var p = new URLSearchParams(location.search);
    if (p.has("station") && stationIndex(p.get("station")) >= 0) o.station = p.get("station");
    if (p.has("posterBlur"))   o.posterBlur   = clampInt(p.get("posterBlur"), 0, 200);
    if (p.has("borderRadius")) o.borderRadius = clampInt(p.get("borderRadius"), 0, 500);
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

// --- DOM ---------------------------------------------------------------------
var $ = function (id) { return document.getElementById(id); };
var stage = $("stage"), coverBox = $("coverbox");

// Cover and movie work use the same generation mechanism, but separate channels:
// changing backdrop options must not cancel a still-valid cover load (and vice versa).
var renderGenerations = { cover: 0, backdrop: 0 };
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
var cdEl = $("countdown"), statusEl = $("status"), audioEl = $("audio");

// One info box serves both layouts (title, artist, countdown) - overlaid on the
// stage in fill, sitting below the cover in poster.
function setInfo(title, artist) {
    $("info-title").textContent = title;
    $("info-artist").textContent = artist;
}

var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// --- poll engine (ported from lib/coverfetch.cpp) ----------------------------
var MIN_POLL = 5, MAX_POLL = 3600, ERR_RETRY = 8, ERR_CAP = 512, REQ_TIMEOUT = 20000;
var pollTimer = null, tickTimer = null, inflight = null, errBackoff = ERR_RETRY;
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

async function poll() {
    if (inflight) inflight.abort();
    const ctl = new AbortController();
    inflight = ctl;
    const kill = setTimeout(function () { ctl.abort(); }, REQ_TIMEOUT);
    try {
        const r = await fetch("https://" + station().host
            + "/soap/FM24sevenJSON.php?action=GetCurrentlyPlaying&_t=" + Date.now(),
            { signal: ctl.signal });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        if (ctl !== inflight) return; // superseded by a station switch
        errBackoff = ERR_RETRY;
        // remaining = Length(ms)/1000 - |SystemTime - PlayStart|; both stamps come
        // from the same server clock, so any timezone offset cancels in the diff.
        const lengthSec = Math.max(0, Math.floor((parseInt(j.Length, 10) || 0) / 1000));
        let elapsed = 0;
        const ps = Date.parse(j.PlayStart || ""), st = Date.parse(j.SystemTime || "");
        if (!isNaN(ps) && !isNaN(st)) elapsed = Math.abs(st - ps) / 1000;
        const remaining = Math.max(0, Math.floor(lengthSec - elapsed));
        remAnchor = lengthSec > 0 ? remaining : -1;
        remAnchorAt = Date.now();

        const album = htmlDecode(j.Album), track = htmlDecode(j.Track);
        // ONE determination drives everything downstream: no trusted CoverLink means
        // a station ID, unregistered track, or rejected off-origin URL.
        // The same flag that swaps the cover for the station logo below also
        // vetoes the TMDB/fanart lookup - never a movie, so its jingle name must
        // not leak to a third party as a search. One source of truth, so the
        // logo and the veto can never disagree.
        const trustedCover = sizedCoverUrl(j.CoverLink);
        const isStationId = !trustedCover;
        if (album !== currentAlbum || isStationId !== stationIdActive) {
            currentAlbum = album; stationIdActive = isStationId;
            updateBackdrop();
        }
        let title = album;
        if (album && track) title = album + " - " + track;
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
        setStatus("Station not responding – retrying…", "station");
        schedulePoll(errBackoff);
        errBackoff = Math.min(ERR_CAP, errBackoff * 2); // exponential backoff, like the lib
    } finally {
        clearTimeout(kill);
    }
}

var statusMessages = { station: "", audio: "", backdrop: "", general: "" };
function renderStatus() {
    statusEl.textContent = statusMessages.station || statusMessages.audio
        || statusMessages.backdrop || statusMessages.general;
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
// browser cache, and - when movie backdrops are on and this station resolves them -
// resolve its movie art into the per-title cache and warm that image too. The
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
        // station().backdrop currently always means the movie resolver; if other
        // resolver kinds ever appear, prefetching becomes their concern.
        if (opts.tmdbBackdrops && station().backdrop) {
            const art = await movieArtFor(htmlDecode(next.Album), generation, null,
                                          prefetchCtl.signal);
            if (art && renderIsCurrent("backdrop", generation)) new Image().src = art;
        }
    } catch (e) { /* prefetch is best-effort - including a thrown "badkey" */ }
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
        var effect = reducedMotion ? 0 : opts.transition;
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

// --- experimental: TMDB movie backdrops --------------------------------------
// Poster mode only: the movie's real backdrop, sharp and dimmed, replaces the blurred
// cover behind the artwork. The album title IS the movie title on a soundtrack station
// (after stripping soundtrack-release noise), so a TMDB search usually lands it. A
// per-title cache (negative results too) keeps it to one request per movie, and every
// failure path falls back silently to the blurred cover - experimental means the
// player must never be worse off for having it enabled.
var movieLayer = makeLayer($("movieA"), $("movieB"), "backdrop");
var movieShown = false; // a movie backdrop is currently visible (drives hide-cover)
function newMovieCache() { return Object.create(null); }
var tmdbCache = newMovieCache(); // cleaned title -> backdrop URL ("" = searched, no match)
var backdropRequest = null;

function cancelBackdropRequest() {
    if (!backdropRequest) return;
    const request = backdropRequest;
    backdropRequest = null;
    clearTimeout(request.kill);
    request.ctl.abort();
}

// Experimental: while a movie backdrop is showing, the cover can step aside and let
// the backdrop be the star. Only ever active when there IS a backdrop - no match, no
// key, or feature off always brings the cover back.
function updateCoverVisibility() {
    stage.classList.toggle("no-cover", !!(opts.hideCover && movieShown));
}
var currentAlbum = "", stationIdActive = false;

function cleanMovieTitle(album) {
    return (album || "")
        .replace(/\((original|music|motion|complete|soundtrack|score|ost|deluxe|expanded|remaster)[^)]*\)/gi, " ")
        .replace(/\b(original motion picture soundtrack|music from the motion picture|original motion picture score|motion picture soundtrack|original soundtracks?|original scores?|the original scores?|soundtrack|ost)\b/gi, " ")
        .replace(/[:\-–]\s*$/, "")
        .replace(/\s{2,}/g, " ").trim()
        // The feed stores rotated articles - "Mummy Returns, The", "Bourne Identity,
        // The" (seen live) - but TMDB knows "The Mummy Returns". Un-rotate them.
        .replace(/^(.+),\s*(The|A|An)$/i, "$2 $1");
}

// Prefer the result whose title matches the query exactly (ignoring case and
// punctuation), then the first with a backdrop, then the first at all - TMDB's own
// ranking is decent, but "Glass" should mean the movie called Glass, not whatever
// popular film merely contains the word.
function pickMovie(results, q) {
    function norm(s) { return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }
    var nq = norm(q), exact = null, withArt = null;
    for (var i = 0; i < results.length; i++) {
        var m = results[i];
        if (!exact && (norm(m.title) === nq || norm(m.original_title) === nq)) exact = m;
        if (!withArt && m.backdrop_path) withArt = m;
    }
    return exact || withArt || results[0] || null;
}

// fanart.tv carries curated, usually TEXTLESS backdrops - nicer behind a cover than
// TMDB's, which often bake in the film's logo. It has no text search, only lookup by
// TMDB id, which is why TMDB always goes first. Optional second key AND its own
// toggle (key stays saved while unticked); any failure here degrades to TMDB's own
// backdrop, never to nothing.

var TRANSIENT_ART_FAILURE = {};
async function fanartBackdrop(movieId, reportStatus, signal) {
    if (!opts.fanartKey) return ""; // keyless = a plain miss, no request
    try {
        const r = await fetch("https://webservice.fanart.tv/v3/movies/" + movieId
                              + "?api_key=" + encodeURIComponent(opts.fanartKey),
                              signal ? { signal: signal } : undefined);
        if (r.status === 401) {
            if (reportStatus) reportStatus("fanart.tv rejected its API key.");
            return "";
        }
        if (r.status === 429 || r.status >= 500) throw TRANSIENT_ART_FAILURE;
        if (!r.ok) return "";
        const list = ((await r.json()) || {}).moviebackground || [];
        if (!list.length) return "";
        const best = list.slice().sort(function (a, b) {   // textless first, then most-liked
            return (a.lang === "" ? 0 : 1) - (b.lang === "" ? 0 : 1)
                || (parseInt(b.likes, 10) || 0) - (parseInt(a.likes, 10) || 0);
        })[0];
        return best.url;
    } catch (e) {
        if (e && e.name === "AbortError") throw e;
        if (reportStatus) reportStatus("fanart.tv's API is currently unavailable.");
        throw TRANSIENT_ART_FAILURE;
    }
}

// The art providers, tried in opts.providerOrder: the first enabled one that
// delivers art wins, the rest are fallback. `enabled` (get/set) is the user's
// checkbox state over its backing option - the provider rows in the UI bind to it
// generically, so a new provider needs no handler code. Anything else a provider
// needs to deliver (fanart: its key) it checks inside art() itself, returning ""
// like any other miss - "" already means "nothing from me, next in line".
var MOVIE_ART_PROVIDERS = {
    fanart: {
        get enabled() { return !!opts.fanartBackdrops; },
        set enabled(on) { opts.fanartBackdrops = on ? 1 : 0; },
        art: function (hit, reportStatus, signal) {
            return fanartBackdrop(hit.id, reportStatus, signal);
        }
    },
    tmdb: {
        get enabled() { return !!opts.tmdbArt; },
        set enabled(on) { opts.tmdbArt = on ? 1 : 0; },
        art: function (hit) {
            return Promise.resolve(hit.backdrop_path
                ? "https://image.tmdb.org/t/p/w1280" + hit.backdrop_path : "");
        }
    }
};

// First enabled provider (in priority order) that delivers art wins. Sequential on
// purpose: asking the next provider only AFTER the preferred one came up empty is
// the whole point of a priority order. (Array.find can't do this - it cannot await.)
async function artFromProviders(hit, generation, reportStatus, cacheState, signal) {
    for (const id of opts.providerOrder) {
        if (!renderIsCurrent("backdrop", generation)) return "";
        const p = MOVIE_ART_PROVIDERS[id];
        if (!p || !p.enabled) continue;
        var url;
        try { url = await p.art(hit, reportStatus, signal); }
        catch (e) {
            if (e !== TRANSIENT_ART_FAILURE) throw e;
            cacheState.cacheable = false;
            continue;
        }
        if (!renderIsCurrent("backdrop", generation)) return "";
        if (url) return url;
    }
    return "";
}

function setMovieBackdrop(url, generation) {
    if (!renderIsCurrent("backdrop", generation)) return;
    if (!url) {
        movieLayer.hide();
        movieShown = false;
        updateCoverVisibility();
        return;
    }
    movieLayer.show(url, generation,
        function () { movieShown = true; updateCoverVisibility(); },
        function () {
            movieLayer.hide();
            movieShown = false;
            updateCoverVisibility();
        });
}

function updateBackdrop() {
    const generation = nextRenderGeneration("backdrop");
    cancelBackdropRequest();
    clearStatus("backdrop");
    // The station-ID flag set by poll() (the one that also picks the logo): never a
    // movie, so no API call - and no leftover backdrop behind the station logo.
    if (stationIdActive || !opts.tmdbBackdrops) { setMovieBackdrop("", generation); return; }
    const resolver = station().backdrop;
    if (!resolver) { setMovieBackdrop("", generation); return; } // no art source
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

// Resolve an album title to movie art (search TMDB, then the provider priority
// list), through the per-title cache. It has no direct UI effects: the current-track
// display path may inject a generation-checked status reporter, while the prefetcher
// stays silent. Throws "badkey" so the display path can tell the user.
async function movieArtFor(album, generation, reportStatus, signal) {
    const q = cleanMovieTitle(album);
    if (!renderIsCurrent("backdrop", generation) || !q || !opts.tmdbKey) return "";
    const cache = tmdbCache; // option changes replace the cache; stale work keeps this one
    if (Object.prototype.hasOwnProperty.call(cache, q)) return cache[q];
    // TMDB accepts either credential; the shape tells them apart. A v3 API key is 32
    // hex chars and rides the query string; a v4 Read Access Token is a JWT (eyJ...,
    // with dots) and goes in an Authorization: Bearer header - which triggers a CORS
    // preflight that TMDB explicitly allows (Access-Control-Allow-Headers includes
    // Authorization; verified live).
    const isToken = opts.tmdbKey.indexOf(".") >= 0 || /^eyJ/.test(opts.tmdbKey);
    const request = isToken ? { headers: { "Authorization": "Bearer " + opts.tmdbKey } } : {};
    if (signal) request.signal = signal;
    const r = await fetch("https://api.themoviedb.org/3/search/movie?include_adult=false&query="
          + encodeURIComponent(q)
          + (isToken ? "" : "&api_key=" + encodeURIComponent(opts.tmdbKey)), request);
    if (!renderIsCurrent("backdrop", generation)) return "";
    if (r.status === 401) throw "badkey"; // TMDB status_code 7: invalid key
    if (r.status !== 200) throw new Error("TMDB HTTP " + r.status);
    const j = await r.json();
    const hit = pickMovie(j.results || [], q);
    const cacheState = { cacheable: true };
    const url = hit
        ? await artFromProviders(hit, generation, reportStatus, cacheState, signal) : "";
    if (!renderIsCurrent("backdrop", generation)) return "";
    if (cacheState.cacheable) cache[q] = url;
    return url;
}

async function resolveMovieBackdrop(generation, signal) {
    if (!renderIsCurrent("backdrop", generation)) return;
    if (!opts.tmdbKey) {
        setMovieBackdrop("", generation);
        setStatus("Movie backdrops need a TMDB API key - see the Experimental options.", "backdrop");
        return;
    }
    try {
        const url = await movieArtFor(currentAlbum, generation, function (text) {
            if (renderIsCurrent("backdrop", generation)) setStatus(text, "backdrop");
        }, signal);
        if (!renderIsCurrent("backdrop", generation)) return;
        setMovieBackdrop(url, generation);
    } catch (e) {
        if (!renderIsCurrent("backdrop", generation)) return;
        if (e === "badkey") setStatus("TMDB rejected the API key - check the Experimental options.", "backdrop");
        setMovieBackdrop("", generation); // any failure: quietly back to the blurred cover
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
        if (!opts.roll || reducedMotion || !c.cur.animate) { c.cur.textContent = ch; continue; }
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
    // The D2D pass blurs at a ~240px working resolution and upscales, so its strength
    // is relative to size. A fixed CSS pixel blur reads far too mild on a big stage -
    // scale it the same way: posterBlur px at 240, proportionally more at stage width.
    stage.style.setProperty("--poster-blur", (opts.posterBlur * r.width / 240) + "px");
}
if (window.ResizeObserver) new ResizeObserver(sizeStage).observe(stage);

// --- audio -------------------------------------------------------------------
var audioBtn = $("audio-toggle"), volEl = $("volume");
var audioGeneration = 0;
function audioUrl() { return "https://" + station().host + "/live"; }
function setAudio(on) {
    const generation = ++audioGeneration;
    if (on) {
        clearStatus("audio");
        audioEl.src = audioUrl();
        audioEl.volume = opts.volume;
        audioEl.play().catch(function () {
            if (generation !== audioGeneration) return;
            setStatus("Your browser refused to play the stream – use the playlist links below.", "audio");
            setAudio(false);
        });
    } else {
        audioEl.pause();
        audioEl.removeAttribute("src");
        audioEl.load(); // actually drop the connection, don't keep buffering
    }
    audioBtn.setAttribute("aria-pressed", on ? "true" : "false");
    audioBtn.textContent = on ? "⏸ Stop audio" : "▶ Play audio";
}
audioBtn.addEventListener("click", function () {
    setAudio(audioBtn.getAttribute("aria-pressed") !== "true");
});
volEl.value = opts.volume;
volEl.addEventListener("input", function () {
    opts.volume = parseFloat(volEl.value);
    audioEl.volume = opts.volume;
    saveOpts();
});

// --- fullscreen (mirrors the apps: double-click toggles) ---------------------
function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (stage.requestFullscreen) stage.requestFullscreen();
}
stage.addEventListener("dblclick", function (e) {
    // Double-clicks inside the options overlay (a slider, a fast toggle) or on the
    // chrome buttons must not yank the user out of fullscreen.
    if (e.target.closest(".fs-options, .stage-fs, .stage-opts")) return;
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
var stationHome = stationBox.parentNode;
var stationNext = stationBox.nextElementSibling; // where it goes back (the stage)
var controlsEl = document.querySelector(".controls:not(.controls-top)");
var controlsHome = controlsEl.parentNode;
var controlsNext = controlsEl.nextElementSibling; // where it goes back
var fsOptsHost = $("fs-options"), optsBtn = $("stage-options");
var optionsOpen = false;
function setOptionsOverlay(open) {
    optionsOpen = open;
    optsBtn.setAttribute("aria-pressed", open ? "true" : "false");
    fsOptsHost.hidden = !open;
    if (open) {
        fsOptsHost.appendChild(stationBox);
        fsOptsHost.appendChild(controlsEl);
    } else if (controlsEl.parentNode === fsOptsHost) {
        stationHome.insertBefore(stationBox, stationNext);
        controlsHome.insertBefore(controlsEl, controlsNext);
    }
}
optsBtn.addEventListener("click", function () { setOptionsOverlay(!optionsOpen); });

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

// In fullscreen the chrome (⛶, ⋯, and the cursor) fades out after 2s without pointer
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
    if (document.fullscreenElement) chromeWake(); // shown briefly on entry, then idles out
    sizeStage(); // the stage rect just changed drastically; don't wait for the observer
});

// --- controls wiring ---------------------------------------------------------
function bindRadios(name, current, apply) {
    var inputs = document.querySelectorAll('input[name="' + name + '"]');
    inputs.forEach(function (r) {
        r.checked = (r.value === String(current));
        r.addEventListener("change", function () { if (r.checked) { apply(r.value); saveOpts(); } });
    });
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
        var span = document.createElement("span");
        span.textContent = s.name;
        label.appendChild(input); label.appendChild(span);
        box.appendChild(label);
    });
})();
bindRadios("station", opts.station, function (v) {
    opts.station = v;
    nextRenderGeneration("cover"); // invalidate image loads before the new poll returns
    const backdropGeneration = nextRenderGeneration("backdrop");
    cancelBackdropRequest();
    setMovieBackdrop("", backdropGeneration);
    shownUrl = ""; loadingCoverUrl = ""; remAnchor = -1;
    resetCoverRetry("");
    currentAlbum = ""; // the resolver is per-station now - always re-evaluate after a
                       // switch, even if the new station plays an identically named album
    setInfo("Loading…", "");
    setStatus("");
    if (audioBtn.getAttribute("aria-pressed") === "true") setAudio(true); // retune the stream
    poll();
});
bindRadios("layout", opts.layout, function (v) { opts.layout = clampInt(v, 0, 1); applyLayout(); });
bindRadios("transition", opts.transition, function (v) { opts.transition = clampInt(v, 0, 3); });
bindRadios("cdsize", opts.remainingSize, function (v) { opts.remainingSize = clampInt(v, 0, 2); sizeStage(); });

var fadeEl = $("fade"), fadeVal = $("fade-val");
fadeEl.value = opts.fadeMs;
fadeVal.textContent = (opts.fadeMs / 1000).toFixed(1) + " s";
fadeEl.addEventListener("input", function () {
    opts.fadeMs = clampInt(fadeEl.value, 500, 2000);
    fadeVal.textContent = (opts.fadeMs / 1000).toFixed(1) + " s";
    saveOpts();
});
var showEl = $("show-remaining"), rollEl = $("roll");
showEl.checked = !!opts.showRemaining;
rollEl.checked = !!opts.roll;
showEl.addEventListener("change", function () { opts.showRemaining = showEl.checked ? 1 : 0; saveOpts(); renderCountdown(); });
rollEl.addEventListener("change", function () { opts.roll = rollEl.checked ? 1 : 0; saveOpts(); });

var tmdbOnEl = $("tmdb-on"), tmdbKeyEl = $("tmdb-key");
tmdbOnEl.checked = !!opts.tmdbBackdrops;
tmdbKeyEl.value = opts.tmdbKey;
tmdbOnEl.addEventListener("change", function () {
    opts.tmdbBackdrops = tmdbOnEl.checked ? 1 : 0;
    saveOpts();
    updateBackdrop();
});
tmdbKeyEl.addEventListener("change", function () {
    opts.tmdbKey = tmdbKeyEl.value.trim();
    tmdbCache = newMovieCache(); // a new key deserves a fresh try, including negative caches
    saveOpts();
    updateBackdrop();
});
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
    providersEl.appendChild(providersEl.querySelector('[data-provider="' + id + '"]'));
});
var providerStatusEl = $("provider-status");
var PROVIDER_NAMES = { fanart: "fanart.tv", tmdb: "TMDB" };
function providerName(li) { return PROVIDER_NAMES[li.dataset.provider] || li.dataset.provider; }
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
    var p = MOVIE_ART_PROVIDERS[li.dataset.provider];
    var box = li.querySelector('input[type="checkbox"]');
    box.checked = p.enabled;
    box.addEventListener("change", function () {
        p.enabled = box.checked;
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
var hideCoverEl = $("hide-cover");
hideCoverEl.checked = !!opts.hideCover;
hideCoverEl.addEventListener("change", function () {
    opts.hideCover = hideCoverEl.checked ? 1 : 0;
    saveOpts();
    updateCoverVisibility();
});

// --- go ----------------------------------------------------------------------
applyLayout();
setInfo("Loading…", "");
tickTimer = setInterval(renderCountdown, 1000);
poll();

})();
