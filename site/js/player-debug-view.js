"use strict";
(function (root) {
    const label = key => ({ headersMs: "Headers", downloadMs: "Body received", parseMs: "JSON parse",
        totalMs: "Total", serverMs: "Server", analysisMs: "Image analysis", responseBytes: "Response size" }[key]
        || key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").replace(/^./, c => c.toUpperCase()));
    function format(value, key) {
        if (value === null || value === undefined) return "Unknown";
        if (typeof value === "boolean") return value ? "Yes" : "No";
        if (typeof value === "number") return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
            + (/Ms$/.test(key) ? " ms" : /bytes$/i.test(key) ? " bytes" : /Seconds$/.test(key) ? " s" : "");
        return String(value) || "—";
    }
    function el(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    }
    function fields(value, depth = 0) {
        const list = el("dl", "debug-fields");
        if (depth > 10) return list;
        Object.entries(value || {}).forEach(([key, item]) => {
            const row = el("div", "debug-field"), term = el("dt", "", label(key)), description = el("dd");
            row.append(term, description); list.append(row);
            if (item && typeof item === "object") {
                if (Object.keys(item).length) description.append(fields(item, depth + 1)); else description.textContent = "None";
            } else {
                const text = el("span", "debug-value", format(item, key));
                const copy = el("button", "debug-copy-value", "Copy"); copy.type = "button";
                copy.setAttribute("aria-label", "Copy " + label(key));
                copy.dataset.copy = item === null || item === undefined ? "" : String(item);
                description.append(text, copy);
            }
        });
        return list;
    }
    function updateFields(target, value) {
        const stamp = JSON.stringify(value);
        if (target._stamp === stamp) return;
        if (target.contains(document.activeElement) && document.activeElement.matches("button")) return;
        target._stamp = stamp; target.replaceChildren(fields(value));
    }
    function relative(item) {
        if (item.phase === "current") return "Playing now";
        if (item.relativeSeconds === null) return "Start time unknown";
        const seconds = Math.round(Math.abs(item.relativeSeconds));
        const time = Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
        return item.phase === "past" ? "Observed −" + time : "Estimated +" + time;
    }
    function mount(panel) {
        panel.innerHTML = '<div class="debug-toolbar"><div><span class="debug-eyebrow">STAGE INSPECTOR</span>'
            + '<strong>Diagnostics <span id="debug-live-state">Live</span></strong></div>'
            + '<button type="button" id="debug-freeze">Freeze</button><button type="button" id="debug-copy">Copy snapshot</button>'
            + '<button type="button" id="debug-close" aria-label="Close diagnostics">×</button></div>'
            + '<div class="debug-body"><div id="debug-metrics" class="debug-metrics"></div>'
            + '<section class="debug-section debug-timeline-section"><div class="debug-section-heading">'
            + '<div><h3>Playback &amp; cache</h3><p>Observed history · Current · Upcoming queue</p></div>'
            + '<button type="button" id="debug-current" aria-label="Jump to current">Current ↗</button></div>'
            + '<div id="debug-timeline" class="debug-timeline" role="group" aria-label="Playback timeline" tabindex="0"></div>'
            + '<p class="debug-note">Scroll horizontally · Select a card for its metadata and cache</p>'
            + '<div id="debug-selection" class="debug-selection"></div></section>'
            + '<div class="debug-columns"><section class="debug-section"><h3>Now playing</h3><div id="debug-snapshot"></div></section>'
            + '<section class="debug-section"><h3>Artwork</h3><div id="debug-artwork"></div></section></div>'
            + '<section class="debug-section"><h3>Requests &amp; timings</h3><p class="debug-note">Client durations; server measurements are separate.</p>'
            + '<div id="debug-requests-list"></div></section>'
            + '<div class="debug-columns"><section class="debug-section"><h3>Cache</h3><div id="debug-cache"></div></section>'
            + '<section class="debug-section"><h3>Player</h3><div id="debug-player"></div></section></div>'
            + '<section class="debug-section"><h3>Recent events</h3><div id="debug-events"></div></section></div>'
            + '<div class="debug-footer"><span>D / Esc to close · Select text to pause</span><span id="debug-updated"></span></div>'
            + '<span id="debug-copy-status" role="status"></span>';
        const find = id => panel.querySelector("#debug-" + id);
        const rail = find("timeline"), cards = new Map(), requests = new Map();
        let selected = null, entries = [], follow = true;
        function select(id) {
            selected = id;
            cards.forEach((card, key) => card.setAttribute("aria-pressed", String(key === id)));
            const item = entries.find(entry => entry.id === id);
            updateFields(find("selection"), item ? { album: item.album, track: item.track, artist: item.artist,
                position: label(item.phase) + " · " + relative(item), durationSeconds: item.lengthSeconds,
                cache: item.cache, coverUrl: item.coverUrl } : { timeline: "Waiting for station metadata" });
        }
        function center() {
            const item = entries.find(entry => entry.phase === "current");
            if (!item || !cards.has(item.id)) return;
            const card = cards.get(item.id);
            rail.scrollTo({ left: card.offsetLeft - rail.offsetLeft - (rail.clientWidth - card.clientWidth) / 2,
                behavior: root.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
            select(item.id); follow = true;
        }
        find("current").addEventListener("click", center);
        ["pointerdown", "wheel", "keydown"].forEach(type => rail.addEventListener(type, () => { follow = false; }, { passive: true }));
        rail.addEventListener("wheel", event => {
            if (Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.ctrlKey) return;
            const before = rail.scrollLeft; rail.scrollLeft += event.deltaY;
            if (rail.scrollLeft !== before) event.preventDefault();
        }, { passive: false });
        function renderTimeline(next, opening) {
            const oldCurrent = entries.find(entry => entry.phase === "current");
            const anchor = [...cards.values()].find(card => card.offsetLeft + card.offsetWidth > rail.scrollLeft + rail.offsetLeft);
            const anchorOffset = anchor ? anchor.offsetLeft - rail.scrollLeft : 0;
            entries = next;
            const ids = new Set(entries.map(item => item.id));
            cards.forEach((card, id) => {
                if (!ids.has(id) && !card.classList.contains("leaving")) {
                    card.classList.add("leaving"); card.removeAttribute("aria-current"); card.disabled = true;
                    setTimeout(() => { if (!entries.some(item => item.id === id)) { card.remove(); cards.delete(id); } }, 200);
                }
            });
            let previous = null;
            entries.forEach(item => {
                let card = cards.get(item.id);
                if (!card) {
                    card = el("button", "debug-track entering"); card.type = "button";
                    card.append(el("span", "debug-track-phase"), el("strong"), el("span", "debug-track-artist"),
                        el("span", "debug-track-time"), el("span", "debug-track-cache"));
                    card.addEventListener("click", () => select(item.id)); cards.set(item.id, card);
                    requestAnimationFrame(() => requestAnimationFrame(() => card.classList.remove("entering")));
                }
                card.classList.remove("leaving"); card.disabled = false;
                if (card.parentNode !== rail || card.previousElementSibling !== previous)
                    rail.insertBefore(card, previous ? previous.nextSibling : rail.firstChild);
                previous = card; card.dataset.phase = item.phase;
                if (item.phase === "current") card.setAttribute("aria-current", "true"); else card.removeAttribute("aria-current");
                card.children[0].textContent = item.phase === "current" ? "● Current" : label(item.phase);
                card.children[1].textContent = item.album || item.track || "Unknown title";
                card.children[2].textContent = [item.track, item.artist].filter(Boolean).join(" · ") || "—";
                card.children[3].textContent = relative(item);
                card.children[4].textContent = "Cache · " + (Object.entries(item.cache || {}).filter(([, value]) => value === true)
                    .map(([key]) => label(key)).join(" / ") || "Not prepared");
            });
            if (anchor && anchor.isConnected) rail.scrollLeft = anchor.offsetLeft - anchorOffset;
            const current = entries.find(item => item.phase === "current");
            if (opening || (follow && current && current.id !== (oldCurrent && oldCurrent.id))) center();
            else select(ids.has(selected) ? selected : current && current.id);
        }
        function renderRequests(values) {
            const list = find("requests-list"), ids = new Set();
            values.slice().reverse().forEach((request, i) => {
                const id = request.at + request.url; ids.add(id);
                let card = requests.get(id);
                if (!card) {
                    card = el("article", "debug-request"); const heading = el("div", "debug-request-heading");
                    heading.append(el("strong"), el("span", "debug-badge"));
                    const toggle = el("button", "debug-response-toggle", "Response details"); toggle.type = "button";
                    toggle.setAttribute("aria-expanded", "false");
                    const response = el("div", "debug-response"), inner = el("div"); response.append(inner);
                    toggle.addEventListener("click", () => {
                        const expanded = toggle.getAttribute("aria-expanded") !== "true";
                        toggle.setAttribute("aria-expanded", String(expanded)); response.classList.toggle("open", expanded);
                        if (expanded) updateFields(inner, { response: card._request.response });
                    });
                    card.append(heading, el("div", "debug-request-fields"), toggle, response); requests.set(id, card);
                }
                card._request = request;
                const currentAt = list.children[i]; if (currentAt !== card) list.insertBefore(card, currentAt || null);
                let endpoint = request.url; try { endpoint = new URL(request.url).pathname; } catch (_) {}
                card.children[0].children[0].textContent = endpoint;
                card.children[0].children[1].textContent = (request.status || "Pending") + " · " + format(request.totalMs, "totalMs");
                updateFields(card.children[1], { url: request.url, headersMs: request.headersMs,
                    downloadMs: request.downloadMs, parseMs: request.parseMs, responseBytes: request.responseBytes,
                    httpCache: request.httpCache, serverMs: request.response && request.response.diagnostics
                        ? request.response.diagnostics.totalMs : null, error: request.error });
                if (card.children[2].getAttribute("aria-expanded") === "true")
                    updateFields(card.children[3].firstChild, { response: request.response });
            });
            requests.forEach((card, id) => { if (!ids.has(id)) { card.classList.add("leaving");
                setTimeout(() => { card.remove(); requests.delete(id); }, 200); } });
        }
        return {
            render(snapshot, opening) {
                const latest = snapshot.requests[snapshot.requests.length - 1];
                const metrics = { Station: snapshot.station || "—", Requests: snapshot.requests.length,
                    "Latest request": latest ? format(latest.totalMs, "totalMs") : "—",
                    "Media cache": snapshot.localCache && snapshot.localCache.mediaEntries || 0 };
                const target = find("metrics");
                if (!target.children.length) Object.keys(metrics).forEach(key => {
                    const card = el("div"); card.append(el("span", "", key), el("strong")); target.append(card);
                });
                Object.values(metrics).forEach((value, i) => { target.children[i].lastChild.textContent = value; });
                updateFields(find("snapshot"), snapshot.track); updateFields(find("artwork"), snapshot.artwork);
                updateFields(find("cache"), { ...snapshot.localCache, lastOperations: snapshot.caches });
                updateFields(find("player"), { build: snapshot.build, ...snapshot.display, settings: snapshot.settings });
                updateFields(find("events"), snapshot.events.slice(-10).reverse());
                renderTimeline(snapshot.timeline || [], opening); renderRequests(snapshot.requests);
                find("updated").textContent = "Updated " + new Date(snapshot.capturedAt).toLocaleTimeString();
            }
        };
    }
    root.PlayerDebugView = { mount };
})(window);
