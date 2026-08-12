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
var STATIONS = [
    { id: "sst",       name: "StreamingSoundtracks", host: "streamingsoundtracks.com", desc: "Movie scores, TV themes, anime & game music", logo: "https://streamingsoundtracks.com/images/logos/logo-sst-v200x200.png" },
    { id: "1980s",     name: "1980s.FM",             host: "1980s.fm",                 desc: "1980s pop, rock & new wave",                  logo: "https://1980s.fm/images/logos/1980s_logo-200x200.png" },
    { id: "adagio",    name: "Adagio.FM",            host: "adagio.fm",                desc: "Classical & ambient",                         logo: "https://adagio.fm/images/logos/logo-afm-200x200.png" },
    { id: "death",     name: "Death.FM",             host: "death.fm",                 desc: "Extreme & underground metal",                 logo: "https://death.fm/images/logos/logo-dfm-200x200.png" },
    { id: "entranced", name: "Entranced.FM",         host: "entranced.fm",             desc: "Trance, ambient & electronic",                logo: "https://entranced.fm/images/logos/logo-efm-g200x200.png" }
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
    station: "sst", layout: 1, transition: 1, fadeMs: 1000,
    showRemaining: 0, remainingSize: 0, roll: 0,
    posterBlur: 24, borderRadius: 45, volume: 0.8
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
var stage = $("stage"), coverBox = $("coverbox"), backdrop = $("backdrop");
var imgA = $("coverA"), imgB = $("coverB"), front = imgA;
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

function poll() {
    if (inflight) inflight.abort();
    var ctl = new AbortController();
    inflight = ctl;
    var kill = setTimeout(function () { ctl.abort(); }, REQ_TIMEOUT);
    var host = station().host;
    fetch("https://" + host + "/soap/FM24sevenJSON.php?action=GetCurrentlyPlaying&_t=" + Date.now(),
          { signal: ctl.signal })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (j) {
            clearTimeout(kill);
            if (ctl !== inflight) return; // superseded by a station switch
            errBackoff = ERR_RETRY;
            // remaining = Length(ms)/1000 - |SystemTime - PlayStart|; both stamps come
            // from the same server clock, so any timezone offset cancels in the diff.
            var lengthSec = Math.max(0, Math.floor((parseInt(j.Length, 10) || 0) / 1000));
            var elapsed = 0;
            var ps = Date.parse(j.PlayStart || ""), st = Date.parse(j.SystemTime || "");
            if (!isNaN(ps) && !isNaN(st)) elapsed = Math.abs(st - ps) / 1000;
            var remaining = Math.max(0, Math.floor(lengthSec - elapsed));
            remAnchor = lengthSec > 0 ? remaining : -1;
            remAnchorAt = Date.now();

            var album = htmlDecode(j.Album), track = htmlDecode(j.Track);
            var title = album;
            if (album && track) title = album + " - " + track;
            else if (track) title = track;
            if (title && lengthSec > 0)
                title += " (" + Math.floor(lengthSec / 60) + ":" + String(lengthSec % 60).padStart(2, "0") + ")";
            setInfo(title || "—", htmlDecode(j.Artist));

            // No CoverLink means a station ID or an unregistered track - show the
            // station's logo, exactly what the station's own web player does (its
            // reference logic: ASIN -> sized cover, CoverLink -> as-is, else logo).
            var cover = (j.CoverLink || "").replace("/cover/", "/cover/500/") || station().logo;
            if (cover && cover !== shownUrl) { shownUrl = cover; showCover(cover); }
            setStatus("");
            // Re-poll when the track should end (clamped), +1s for the server to roll over.
            schedulePoll(Math.min(MAX_POLL, Math.max(MIN_POLL, remaining)) + 1);
        })
        .catch(function (e) {
            clearTimeout(kill);
            if (ctl !== inflight) return;
            setStatus("Station not responding – retrying…");
            schedulePoll(errBackoff);
            errBackoff = Math.min(ERR_CAP, errBackoff * 2); // exponential backoff, like the lib
        });
}

function setStatus(text) { statusEl.textContent = text; }

// --- cover display + transitions --------------------------------------------
function showCover(url) {
    var back = (front === imgA) ? imgB : imgA;
    var pre = new Image();
    pre.onload = function () {
        back.src = url;
        backdrop.src = url; // poster backdrop (CSS blurs it; ignored in fill layout)
        var effect = reducedMotion ? 0 : opts.transition;
        stage.style.setProperty("--fade-ms", opts.fadeMs + "ms");
        // The effect class must be in place BEFORE the front swap: transitions fire on
        // a property change under an active transition, not on class changes after it.
        coverBox.className = "coverbox" +
            (effect === 1 ? " fx-fade" : effect === 2 ? " fx-fliph" : effect === 3 ? " fx-flipv" : "");
        void coverBox.offsetWidth; // commit the class change first
        back.classList.add("front"); front.classList.remove("front");
        front = back;
        stage.classList.add("have-cover");
    };
    pre.src = url;
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
var controlsEl = document.querySelector(".controls");
var controlsHome = controlsEl.parentNode;
var controlsNext = controlsEl.nextElementSibling; // where it goes back
var fsOptsHost = $("fs-options"), optsBtn = $("stage-options");
var optionsOpen = false;
function setOptionsOverlay(open) {
    optionsOpen = open;
    optsBtn.setAttribute("aria-pressed", open ? "true" : "false");
    fsOptsHost.hidden = !open;
    if (open) fsOptsHost.appendChild(controlsEl);
    else if (controlsEl.parentNode === fsOptsHost) controlsHome.insertBefore(controlsEl, controlsNext);
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

// --- go ----------------------------------------------------------------------
applyLayout();
setInfo("Loading…", "");
tickTimer = setInterval(renderCountdown, 1000);
poll();

})();
