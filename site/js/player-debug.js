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
    function create() {
        const requests = [], events = [], caches = {};
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
            panel.innerHTML = '<div class="debug-toolbar"><strong>Diagnostics</strong>'
                + '<button type="button" id="debug-freeze">Freeze</button>'
                + '<button type="button" id="debug-copy">Copy snapshot</button>'
                + '<button type="button" id="debug-close" aria-label="Close diagnostics">×</button></div>'
                + '<p class="debug-note">D / Esc to close · Select text to pause updates · Timings in ms</p>'
                + '<div class="debug-body"><pre id="debug-snapshot" tabindex="0"></pre>'
                + '<button type="button" id="debug-requests" aria-expanded="false">API responses</button>'
                + '<div class="debug-responses" data-open="false"><div><pre id="debug-response-text"></pre></div></div></div>'
                + '<span id="debug-copy-status" role="status"></span>';
            stage.append(panel);
            const text = panel.querySelector("#debug-snapshot"), responseText = panel.querySelector("#debug-response-text");
            const freeze = panel.querySelector("#debug-freeze"), copyStatus = panel.querySelector("#debug-copy-status");
            let open = false, frozen = false, captured = null, timer = null, previousFocus = null, feedbackTimer = null;
            function update(force) {
                if (!open || (frozen && !force)) return;
                const selection = root.getSelection();
                if (!force && selection && !selection.isCollapsed && panel.contains(selection.anchorNode)) return;
                captured = snapshot(getState());
                const summary = { ...captured, requests: captured.requests.map(({ response, ...request }) => request) };
                text.textContent = JSON.stringify(summary, null, 2);
                responseText.textContent = JSON.stringify(captured.requests.map(({ at, url, response }) => ({ at, url, response })), null, 2);
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
                freeze.setAttribute("aria-pressed", String(frozen)); if (!frozen) update();
            });
            panel.querySelector("#debug-close").addEventListener("click", () => setOpen(false));
            panel.querySelector("#debug-requests").addEventListener("click", function () {
                const expanded = this.getAttribute("aria-expanded") !== "true";
                this.setAttribute("aria-expanded", String(expanded));
                panel.querySelector(".debug-responses").dataset.open = String(expanded);
            });
            panel.querySelector("#debug-copy").addEventListener("click", async () => {
                // Copy the exact displayed/frozen snapshot, never a newer request.
                const value = JSON.stringify(captured, null, 2);
                try {
                    await navigator.clipboard.writeText(value); copyStatus.textContent = "Snapshot copied";
                } catch (_) {
                    const area = document.createElement("textarea"); area.value = value;
                    area.style.cssText = "position:absolute;opacity:0;pointer-events:none"; panel.append(area);
                    area.select(); const ok = document.execCommand("copy"); area.remove();
                    copyStatus.textContent = ok ? "Snapshot copied" : "Copy unavailable — select the text";
                }
                clearTimeout(feedbackTimer); copyStatus.classList.add("show");
                feedbackTimer = setTimeout(() => copyStatus.classList.remove("show"), 2200);
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
        return { fetch: fetchJson, event, cache, snapshot, mount };
    }
    root.PlayerDiagnostics = { create, sanitize, safeUrl };
    if (typeof module !== "undefined") module.exports = root.PlayerDiagnostics;
})(typeof window !== "undefined" ? window : globalThis);
