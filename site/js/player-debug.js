"use strict";
(function (root) {
    const secretKey = /key|token|password|secret|authorization|credential/i;
    function safeUrl(value) {
        try {
            const url = new URL(value, root.location && root.location.href);
            url.username = ""; url.password = ""; url.hash = "";
            for (const key of [...url.searchParams.keys()]) {
                if (secretKey.test(key)) url.searchParams.set(key, "[redacted]");
                else if (/^https?:/i.test(url.searchParams.get(key)))
                    url.searchParams.set(key, safeUrl(url.searchParams.get(key)));
            }
            return url.href;
        } catch (_) { return "[invalid URL]"; }
    }
    function sanitize(value, depth = 0) {
        if (depth > 12) return "[depth limit]";
        if (typeof value === "string") return (/^https?:\/\//i.test(value) ? safeUrl(value) : value)
            .replace(/((?:api[_-]?key|client[_-]?key|token|password|secret)=)[^&\s"<>]+/gi, "$1[redacted]")
            .slice(0, 4096);
        if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitize(item, depth + 1));
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 100)
            .map(([key, item]) => [key, secretKey.test(key) ? "[redacted]" : sanitize(item, depth + 1)]));
        return value;
    }
    function createTimeline({ now = Date.now, limit = 40 } = {}) {
        let station = null, current = null, serial = 0, past = [];
        const identity = item => [item.album, item.track, item.occurrence || ""].join("\n");
        return {
            observe(nextStation, track) {
                if (station !== nextStation) { station = nextStation; past = []; current = null; }
                if (!track || !(track.album || track.track)) return;
                if (current && identity(current) === identity(track)) {
                    current = { ...current, ...sanitize(track) }; return;
                }
                if (current) { past.push(current); if (past.length > limit) past.shift(); }
                current = { ...sanitize(track), id: "play-" + ++serial, observedAt: now() };
            },
            entries(queue = [], remaining = null, cacheFor = () => ({})) {
                if (!current) return [];
                const time = now();
                const entries = past.map(item => ({ ...item, phase: "past",
                    relativeSeconds: (item.observedAt - time) / 1000, timeKind: "observed" }));
                entries.push({ ...current, phase: "current", relativeSeconds: 0, timeKind: "current" });
                let offset = Number.isFinite(remaining) && remaining >= 0 ? remaining : null;
                queue.slice(0, 40).forEach((item, i) => {
                    entries.push({ ...sanitize(item), id: "queue-" + (item.queueId || identity(item) + "-" + i),
                        phase: "future", relativeSeconds: offset, timeKind: "estimated" });
                    offset = offset !== null && item.lengthSeconds > 0 ? offset + item.lengthSeconds : null;
                });
                return entries.map(item => ({ ...item, cache: sanitize(cacheFor(item)) }));
            }
        };
    }
    // Resolve every detail from the selected identity. Session-wide state is
    // deliberately excluded; unavailable/evicted data must never fall back to now playing.
    function selectedDetails(snapshot, item) {
        const unavailable = () => ({ status: "Not available for this track" });
        item = item || {};
        const urls = new Set();
        function collect(value) {
            if (typeof value === "string" && /^https?:\/\//i.test(value)) urls.add(value);
            else if (value && typeof value === "object") Object.values(value).forEach(collect);
        }
        collect(item.coverUrl); collect(item.tintUrl); collect(item.artwork);
        const sameTrack = (album, track) => !!(item.album || item.track)
            && album === (item.album || "") && track === (item.track || "");
        function matchesUrl(value) {
            if (!value) return false;
            try {
                const url = new URL(value), params = url.searchParams;
                if (params.has("album") && params.has("track"))
                    return sameTrack(params.get("album"), params.get("track"));
                if (params.has("url")) return urls.has(params.get("url"));
                return urls.has(value);
            } catch (_) { return false; }
        }
        const requests = (snapshot.requests || []).filter(request => matchesUrl(request.url)
            || (request.response && !Array.isArray(request.response)
                && sameTrack(request.response.Album, request.response.Track)));
        const requestUrls = new Set(requests.map(request => request.url));
        const events = (snapshot.events || []).filter(event => sameTrack(event.album, event.track)
            || matchesUrl(event.url) || requestUrls.has(event.url));
        const track = { album: item.album, track: item.track, artist: item.artist, lengthSeconds: item.lengthSeconds };
        if (item.phase === "current" && snapshot.track && sameTrack(snapshot.track.album, snapshot.track.track))
            Object.assign(track, snapshot.track);
        const artwork = { coverUrl: item.coverUrl || null, tintUrl: item.tintUrl || null,
            ...(item.artwork || unavailable()),
            images: ((snapshot.artwork || {}).images || []).filter(image => urls.has(image.url)) };
        return { schemaVersion: snapshot.schemaVersion, capturedAt: snapshot.capturedAt, station: snapshot.station,
            selected: { id: item.id, phase: item.phase }, track, artwork, localCache: item.cache || unavailable(),
            playback: { phase: item.phase, observedAt: item.observedAt ? new Date(item.observedAt).toISOString() : null,
                relativeSeconds: item.relativeSeconds, timeKind: item.timeKind,
                ...(item.phase === "current" ? { remainingSeconds: track.remainingSeconds } : {}) }, requests, events };
    }
    function create() {
        const requests = [], events = [], caches = {};
        const timeline = createTimeline();
        const ms = start => Math.round((performance.now() - start) * 100) / 100;
        function event(name, details) {
            events.push({ at: new Date().toISOString(), name, ...sanitize(details || {}) });
            if (events.length > 30) events.shift();
        }
        function cache(name, status, details) {
            caches[name] = { status, at: new Date().toISOString(), ...sanitize(details || {}) };
            event("cache." + name, caches[name]);
        }
        async function fetchJson(url, options) {
            const started = performance.now();
            const entry = { at: new Date().toISOString(), url: safeUrl(String(url)),
                status: null, headersMs: null, downloadMs: null, parseMs: null, totalMs: null,
                responseBytes: null, response: null, error: null, httpCache: "unknown" };
            requests.push(entry);
            if (requests.length > 30) requests.shift();
            try {
                const response = await root.fetch(url, options);
                entry.headersMs = ms(started); entry.status = response.status;
                entry.httpCache = response.headers.get("x-vercel-cache") || "unknown";
                entry.ageSeconds = response.headers.get("age");
                entry.cacheControl = response.headers.get("cache-control");
                const body = await response.text();
                entry.downloadMs = ms(started);
                entry.responseBytes = new TextEncoder().encode(body).length;
                const parseStart = performance.now();
                let json, parseError;
                try { json = JSON.parse(body); }
                catch (error) { parseError = error; entry.error = "invalid JSON"; }
                entry.parseMs = ms(parseStart); entry.totalMs = ms(started);
                entry.response = entry.responseBytes > 65536 ? { truncated: true } : sanitize(json);
                event("request.complete", { url: entry.url, status: entry.status, totalMs: entry.totalMs });
                return { ok: response.ok, status: response.status, headers: response.headers,
                    async json() { if (parseError) throw parseError; return json; } };
            } catch (error) {
                entry.totalMs = ms(started);
                entry.error = error && error.name === "AbortError" ? "aborted" : "network error";
                event("request.failed", { url: entry.url, error: entry.error });
                throw error;
            }
        }
        function snapshot(state) {
            return sanitize({ schemaVersion: 1, capturedAt: new Date().toISOString(),
                client: "web", ...state, caches, requests, events });
        }
        function mount(stage, getState) {
            const panel = document.createElement("section");
            panel.id = "stage-debug"; panel.className = "stage-debug"; panel.hidden = true;
            panel.dataset.state = "closed"; panel.tabIndex = -1;
            panel.setAttribute("aria-label", "Player diagnostics"); panel.setAttribute("aria-hidden", "true");
            const view = root.PlayerDebugView.mount(panel);
            stage.append(panel);
            const freeze = panel.querySelector("#debug-freeze"), copyStatus = panel.querySelector("#debug-copy-status");
            let open = false, frozen = false, captured = null, timer = null, previousFocus = null, feedbackTimer = null;
            function update(force) {
                if (!open || (frozen && !force)) return;
                const selection = root.getSelection();
                if (!force && selection && !selection.isCollapsed && panel.contains(selection.anchorNode)) {
                    panel.querySelector("#debug-live-state").textContent = "Selection paused"; return;
                }
                captured = snapshot(getState());
                view.render(captured, force);
                panel.querySelector("#debug-live-state").textContent = "Live";
            }
            function setOpen(value) {
                open = value; clearTimeout(timer);
                if (open) {
                    previousFocus = document.activeElement; frozen = false; freeze.textContent = "Freeze";
                    freeze.setAttribute("aria-pressed", "false");
                    panel.hidden = false; panel.setAttribute("aria-hidden", "false"); panel.inert = false;
                    update(true); void panel.offsetWidth; panel.dataset.state = "open"; panel.focus({ preventScroll: true });
                } else {
                    panel.dataset.state = "closing"; panel.setAttribute("aria-hidden", "true"); panel.inert = true;
                    if (panel.contains(document.activeElement) && previousFocus && previousFocus.isConnected)
                        previousFocus.focus({ preventScroll: true });
                    const duration = root.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 200;
                    timer = setTimeout(() => { panel.hidden = true; panel.dataset.state = "closed"; }, duration);
                }
            }
            freeze.addEventListener("click", () => {
                frozen = !frozen; freeze.textContent = frozen ? "Resume" : "Freeze";
                panel.querySelector("#debug-live-state").textContent = frozen ? "Frozen" : "Live";
                freeze.setAttribute("aria-pressed", String(frozen)); if (!frozen) update();
            });
            panel.querySelector("#debug-close").addEventListener("click", () => setOpen(false));
            async function copy(value, message) {
                try {
                    await navigator.clipboard.writeText(value); copyStatus.textContent = message;
                } catch (_) {
                    const area = document.createElement("textarea"); area.value = value;
                    area.style.cssText = "position:absolute;opacity:0;pointer-events:none"; panel.append(area);
                    area.select(); const ok = document.execCommand("copy"); area.remove();
                    copyStatus.textContent = ok ? message : "Copy unavailable — select the text";
                }
                clearTimeout(feedbackTimer); copyStatus.classList.add("show");
                feedbackTimer = setTimeout(() => copyStatus.classList.remove("show"), 2200);
            }
            panel.querySelector("#debug-copy").addEventListener("click", () => copy(JSON.stringify(view.snapshot(), null, 2), "Snapshot copied"));
            panel.addEventListener("click", event => {
                const button = event.target.closest("[data-copy]");
                if (button) copy(button.dataset.copy, "Value copied");
            });
            document.addEventListener("keydown", event => {
                if (event.key === "Escape" && open) {
                    event.preventDefault(); event.stopImmediatePropagation(); setOpen(false); return;
                }
                if (event.key.toLowerCase() !== "d" || event.repeat || event.ctrlKey || event.altKey || event.metaKey
                        || event.target.closest("input, textarea, select, [contenteditable]")) return;
                event.preventDefault(); event.stopImmediatePropagation(); setOpen(!open);
            }, true);
            document.addEventListener("pointerdown", event => {
                if (open && !panel.contains(event.target)) setOpen(false);
            }, true);
            // Browsers may consume Escape to leave fullscreen without dispatching
            // a key event to the page. Dismiss on that transition as well.
            let wasFullscreen = !!document.fullscreenElement;
            document.addEventListener("fullscreenchange", () => {
                const fullscreen = !!document.fullscreenElement;
                if (wasFullscreen && !fullscreen && open) setOpen(false);
                wasFullscreen = fullscreen;
            });
            panel.addEventListener("dblclick", event => event.stopPropagation());
            setInterval(() => update(), 1000);
            return { update, setOpen };
        }
        return { fetch: fetchJson, event, cache, snapshot, mount, timeline };
    }
    root.PlayerDiagnostics = { create, sanitize, safeUrl, createTimeline, selectedDetails };
    if (typeof module !== "undefined") module.exports = root.PlayerDiagnostics;
})(typeof window !== "undefined" ? window : globalThis);
