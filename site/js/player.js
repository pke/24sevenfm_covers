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
function htmlDecode(s) {
    if (!s || s.indexOf("&") < 0) return s || "";
    return entityDoc.parseFromString(s, "text/html").documentElement.textContent;
}
function station() { return STATIONS[stationIndex(opts.station)]; }

// --- DOM ---------------------------------------------------------------------
var $ = function (id) { return document.getElementById(id); };
var stage = $("stage"), coverBox = $("coverbox");

// A double-buffered image layer: two stacked <img>s, the incoming URL preloads into
// the hidden one and opacity-crossfades over the visible one (CSS .show). Used for
// both backdrop layers - a bare src swap would hard-cut, and backgrounds deserve the
// same crossfade the cover gets.
function makeLayer(a, b) {
    var front = null;
    return {
        show: function (url, onShown) {
            if (front && front.src === url && front.classList.contains("show")) return;
            var back = (front === a) ? b : a;
            var pre = new Image();
            pre.onload = function () {
                back.src = url;
                back.classList.add("show");
                if (front) front.classList.remove("show");
                front = back;
                if (onShown) onShown();
            };
            pre.src = url; // preload failure: keep whatever is showing
        },
        hide: function () {
            a.classList.remove("show");
            b.classList.remove("show");
            front = null;
        }
    };
}
var blurLayer = makeLayer($("backdropA"), $("backdropB"));
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
var shownUrl = "", remAnchor = -1, remAnchorAt = 0;

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
        // ONE determination drives everything downstream: no CoverLink means a
        // station ID or unregistered track (the station's own player.php rule).
        // The same flag that swaps the cover for the station logo below also
        // vetoes the TMDB/fanart lookup - never a movie, so its jingle name must
        // not leak to a third party as a search. One source of truth, so the
        // logo and the veto can never disagree.
        const isStationId = !(j.CoverLink || "");
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

        const cover = isStationId ? station().logo
                                  : j.CoverLink.replace("/cover/", "/cover/500/");
        if (cover && cover !== shownUrl) { shownUrl = cover; showCover(cover); }
        setStatus("");
        // Re-poll when the track should end (clamped), +1s for the server to roll over.
        schedulePoll(Math.min(MAX_POLL, Math.max(MIN_POLL, remaining)) + 1);
    } catch (e) {
        if (ctl !== inflight) return;
        setStatus("Station not responding – retrying…");
        schedulePoll(errBackoff);
        errBackoff = Math.min(ERR_CAP, errBackoff * 2); // exponential backoff, like the lib
    } finally {
        clearTimeout(kill);
    }
}

function setStatus(text) { statusEl.textContent = text; }

// --- cover display + transitions --------------------------------------------
// The box's data attributes ARE the display state: data-front names the visible
// buffer ("a" | "b"), data-fx the transition. CSS derives each img's opacity and
// rotation from the box, so JS never touches the imgs beyond loading their src -
// and before the first cover there simply is no data-front, so both stay hidden.
function showCover(url) {
    var back = (coverBox.dataset.front === "a") ? imgB : imgA;
    var pre = new Image();
    pre.onload = function () {
        back.src = url;
        blurLayer.show(url); // poster backdrop, crossfaded (CSS blurs it; idle in fill layout)
        var effect = reducedMotion ? 0 : opts.transition;
        stage.style.setProperty("--fade-ms", opts.fadeMs + "ms");
        // The effect must be in place BEFORE the buffer flip: transitions fire on a
        // property change under an active transition, not on one applied after it.
        coverBox.dataset.fx = ["none", "fade", "fliph", "flipv"][effect];
        void coverBox.offsetWidth; // commit the fx change first
        coverBox.dataset.front = (back === imgA) ? "a" : "b";
    };
    pre.src = url;
}

// --- experimental: TMDB movie backdrops --------------------------------------
// Poster mode only: the movie's real backdrop, sharp and dimmed, replaces the blurred
// cover behind the artwork. The album title IS the movie title on a soundtrack station
// (after stripping soundtrack-release noise), so a TMDB search usually lands it. A
// per-title cache (negative results too) keeps it to one request per movie, and every
// failure path falls back silently to the blurred cover - experimental means the
// player must never be worse off for having it enabled.
var movieLayer = makeLayer($("movieA"), $("movieB"));
var movieShown = false; // a movie backdrop is currently visible (drives hide-cover)
var tmdbCache = {};   // cleaned title -> backdrop URL ("" = searched, no match)

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

async function fanartBackdrop(movieId) {
    if (!opts.fanartKey) return ""; // keyless = a plain miss, no request
    try {
        const r = await fetch("https://webservice.fanart.tv/v3/movies/" + movieId
                              + "?api_key=" + encodeURIComponent(opts.fanartKey));
        if (r.status === 401) { setStatus("fanart.tv rejected its key - using TMDB art only."); return ""; }
        if (!r.ok) return "";
        const list = ((await r.json()) || {}).moviebackground || [];
        if (!list.length) return "";
        const best = list.slice().sort(function (a, b) {   // textless first, then most-liked
            return (a.lang === "" ? 0 : 1) - (b.lang === "" ? 0 : 1)
                || (parseInt(b.likes, 10) || 0) - (parseInt(a.likes, 10) || 0);
        })[0];
        return best.url;
    } catch (e) {
        setStatus("fanart.tv's API currently not working - using TMDB art.");
        return "";
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
        art: function (hit) { return fanartBackdrop(hit.id); }
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
async function artFromProviders(hit) {
    for (const id of opts.providerOrder) {
        const p = MOVIE_ART_PROVIDERS[id];
        if (!p || !p.enabled) continue;
        const url = await p.art(hit);
        if (url) return url;
    }
    return "";
}

function setMovieBackdrop(url) {
    if (!url) {
        movieLayer.hide();
        movieShown = false;
        updateCoverVisibility();
        return;
    }
    movieLayer.show(url, function () { movieShown = true; updateCoverVisibility(); });
}

function updateBackdrop() {
    // The station-ID flag set by poll() (the one that also picks the logo): never a
    // movie, so no API call - and no leftover backdrop behind the station logo.
    if (stationIdActive || !opts.tmdbBackdrops) { setMovieBackdrop(""); return; }
    const resolver = station().backdrop;
    if (!resolver) { setMovieBackdrop(""); return; } // this station has no art source
    resolver();
}

async function resolveMovieBackdrop() {
    if (!opts.tmdbKey) {
        setMovieBackdrop("");
        setStatus("Movie backdrops need a TMDB API key - see the Experimental options.");
        return;
    }
    const q = cleanMovieTitle(currentAlbum);
    if (!q) { setMovieBackdrop(""); return; }
    if (q in tmdbCache) { setMovieBackdrop(tmdbCache[q]); return; }
    // TMDB accepts either credential; the shape tells them apart. A v3 API key is 32
    // hex chars and rides the query string; a v4 Read Access Token is a JWT (eyJ...,
    // with dots) and goes in an Authorization: Bearer header - which triggers a CORS
    // preflight that TMDB explicitly allows (Access-Control-Allow-Headers includes
    // Authorization; verified live).
    const isToken = opts.tmdbKey.indexOf(".") >= 0 || /^eyJ/.test(opts.tmdbKey);
    try {
        const r = await fetch("https://api.themoviedb.org/3/search/movie?include_adult=false&query="
              + encodeURIComponent(q)
              + (isToken ? "" : "&api_key=" + encodeURIComponent(opts.tmdbKey)),
              isToken ? { headers: { "Authorization": "Bearer " + opts.tmdbKey } } : undefined);
        if (r.status === 401) throw "badkey"; // TMDB status_code 7: invalid key
        const j = await r.json();
        const hit = pickMovie(j.results || [], q);
        if (!hit) { tmdbCache[q] = ""; setMovieBackdrop(""); return; }
        const url = await artFromProviders(hit);
        tmdbCache[q] = url;
        setMovieBackdrop(url);
    } catch (e) {
        if (e === "badkey") setStatus("TMDB rejected the API key - check the Experimental options.");
        setMovieBackdrop(""); // any failure: quietly back to the blurred cover
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
function audioUrl() { return "https://" + station().host + "/live"; }
function setAudio(on) {
    if (on) {
        audioEl.src = audioUrl();
        audioEl.volume = opts.volume;
        audioEl.play().catch(function () {
            setStatus("Your browser refused to play the stream – use the playlist links below.");
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
    shownUrl = ""; remAnchor = -1;
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
    setStatus("");
    updateBackdrop();
});
tmdbKeyEl.addEventListener("change", function () {
    opts.tmdbKey = tmdbKeyEl.value.trim();
    tmdbCache = {}; // a new key deserves a fresh try, including negative caches
    saveOpts();
    setStatus("");
    updateBackdrop();
});
var fanartKeyEl = $("fanart-key");
fanartKeyEl.value = opts.fanartKey;
fanartKeyEl.addEventListener("change", function () {
    opts.fanartKey = fanartKeyEl.value.trim();
    tmdbCache = {}; // cached art may now be upgradable (or was fanart-based)
    saveOpts();
    setStatus("");
    updateBackdrop();
});

// --- provider priority: drag & drop -------------------------------------------
// Pointer-based, NOT native HTML5 DnD: the native API renders a translucent
// snapshot beside a text-drag cursor and the real row stays put - it cannot make
// the row itself ride the pointer. Here the actual row goes position:fixed and
// follows the pointer (visibly lifted out of the list), a dashed placeholder
// keeps its gap, and elementFromPoint moves the gap - possible because the
// floating row is pointer-events:none, so hit testing sees through it. The <li>
// order stays the single source of truth, read back on release. Pointer events
// also make this work on touch (the grip's touch-action:none stops scrolling).
// The ⠿ grip is the only handle: the row also holds a key input, and a drag must
// not fight text selection there.
var providersEl = $("providers");
opts.providerOrder.forEach(function (id) {
    providersEl.appendChild(providersEl.querySelector('[data-provider="' + id + '"]'));
});
// One generic wiring for every provider row: the checkbox IS the provider's
// enabled property (getter/setter over its backing option) - a new provider row
// needs no handler code of its own.
Array.prototype.forEach.call(providersEl.querySelectorAll(".provider"), function (li) {
    var p = MOVIE_ART_PROVIDERS[li.dataset.provider];
    var box = li.querySelector('input[type="checkbox"]');
    box.checked = p.enabled;
    box.addEventListener("change", function () {
        p.enabled = box.checked;
        tmdbCache = {}; // every cached URL may be the other source's now
        saveOpts();
        setStatus("");
        updateBackdrop();
    });
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
        opts.providerOrder = Array.prototype.map.call(providersEl.children, function (li) {
            return li.dataset.provider;
        });
        tmdbCache = {}; // priority decides which source's URL got cached
        saveOpts();
        updateBackdrop();
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
