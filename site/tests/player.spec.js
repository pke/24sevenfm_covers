// player.spec.js - functional canary for the deployed web player.
//
// The page itself is static and cannot rot on its own; what CAN break overnight are
// the external contracts it stands on, none of which this project controls:
//   - the station's CORS grant on the now-playing JSON (one server-config change away)
//   - the JSON's shape (CoverLink, Length, PlayStart, SystemTime)
//   - the HTTPS /live audio streams
//   - the sized cover-image URLs
// So half of these tests drive the real page in a real browser against the real
// station, and the other half pin the raw contracts - so a failure names the broken
// layer instead of just "the player looks wrong".
const { test, expect } = require("@playwright/test");
const localMode = process.env.PLAYER_LOCAL === "1";

// Everything here runs INSIDE the browser, from the player page's own origin. Not a
// style choice: the station's WAF 403s non-browser clients (curl, node's https,
// Playwright's request fixture) from datacenter IPs - runs 1 and 2 proved it, same
// URLs, 403 outside the browser and 200 inside it. The browser is the only vantage
// point GitHub's runners have - and conveniently the only one that matters, because
// browsers are the only thing the player runs in.
const JSON_URL =
    "https://streamingsoundtracks.com/soap/FM24sevenJSON.php?action=GetCurrentlyPlaying&_t=";

// Playwright's virtual clock prevents browser teardown on Windows; CI runs on Ubuntu.
const virtualClockTest = process.platform === "win32" ? test.skip : test;

async function stableElementRects(page, selectors, options = {}) {
    return page.evaluate(async ({ selectors, stableFrames, maxFrames, tolerance }) => {
        const elements = Object.fromEntries(Object.entries(selectors).map(([name, selector]) => {
            const element = document.querySelector(selector);
            if (!element) throw new Error(`Missing geometry fixture: ${selector}`);
            return [name, element];
        }));
        const geometryTransitions = new Set([
            "bottom", "height", "left", "margin-top", "max-height", "right", "top",
            "transform", "width",
        ]);
        const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const read = () => Object.fromEntries(Object.entries(elements).map(([name, element]) => {
            const rect = element.getBoundingClientRect();
            return [name, {
                top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left,
                width: rect.width, height: rect.height,
            }];
        }));
        const same = (before, after) => Object.keys(before).every((name) =>
            ["top", "right", "bottom", "left", "width", "height"].every((key) =>
                Math.abs(before[name][key] - after[name][key]) <= tolerance));
        const geometryIsAnimating = () => document.querySelector("#stage")
            .getAnimations({ subtree: true }).some((animation) =>
                animation.playState === "running"
                && geometryTransitions.has(animation.transitionProperty));

        let previous = null, consecutive = 0;
        for (let frame = 0; frame < maxFrames; frame++) {
            await nextFrame();
            const current = read();
            consecutive = previous && same(previous, current) ? consecutive + 1 : 0;
            if (consecutive >= stableFrames && !geometryIsAnimating()) return current;
            previous = current;
        }
        throw new Error(`Geometry did not settle within ${maxFrames} animation frames`);
    }, {
        selectors,
        stableFrames: options.stableFrames || 3,
        maxFrames: options.maxFrames || 180,
        tolerance: options.tolerance || 0.01,
    });
}

async function openSettingsTab(page, name) {
    const tab = name === "Station"
        ? page.locator("#settings-tab-station")
        : page.getByRole("tab", { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(`#${await tab.getAttribute("aria-controls")}`)).toBeVisible();
}

async function openBackdropSettings(page) {
    await openSettingsTab(page, "Station");
    const enabled = page.locator("#backdrops-enabled");
    if (!await enabled.isChecked()) await enabled.check();
    await expect(page.locator("#backdrop-options")).toHaveAttribute("aria-hidden", "false");
    await page.locator("#backdrop-options").evaluate((element) => Promise.all(
        element.getAnimations({ subtree: true }).map((animation) =>
            animation.finished.catch(() => undefined))));
}

test.describe("the deployed player page", () => {
    test("enforces a restrictive player resource policy", async ({ page }) => {
        await mockProviderTestFeed(page);
        let escaped = false;
        page.on("request", (request) => {
            if (request.url() === "https://example.com/exfil") escaped = true;
        });
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]')
            .getAttribute("content");
        expect(policy).toContain("default-src 'self'");
        await expect(page.locator("html")).not.toHaveAttribute("data-framed", "");
        expect(policy).toContain("script-src 'self' 'sha256-");
        expect(policy).toContain("connect-src 'self'");
        expect(policy).toContain("https://24covers-api.vercel.app");
        expect(policy).toContain("https://webservice.fanart.tv");
        await expect(page.locator('meta[name="backdrop-api"]')).toHaveAttribute(
            "content", /^https:\/\/24covers-api\.vercel\.app\/api\/backdrop\?resolver_version=[a-f0-9]{12}$/);
        await expect(page.locator('meta[name="tint-api"]')).toHaveAttribute(
            "content", "https://24covers-api.vercel.app/api/tint");
        await expect(page.locator('meta[name="credit-api"]')).toHaveAttribute(
            "content", "https://24covers-api.vercel.app/api/credit");
        expect(policy).toContain("media-src https://streamingsoundtracks.com");
        expect(policy).toContain("object-src 'none'");

        await page.locator("#themeswitch").evaluate((box) => {
            box.checked = !box.checked;
            box.dispatchEvent(new Event("change", { bubbles: true }));
        });
        expect(await page.evaluate(() => localStorage.getItem("theme"))).toMatch(/^(dark|light)$/);
        const blocked = await page.evaluate(() => fetch("https://example.com/exfil")
            .then(() => false, () => true));
        expect(blocked).toBe(true);
        expect(escaped).toBe(false);
    });
    test("shows linked artwork-provider credits in the player footer", async ({ page }) => {
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        const credits = page.locator("footer .art-credits");
        await expect(credits).toContainText(
            "This product uses the TMDB API but is not endorsed or certified by TMDB.");
        await expect(credits.locator("a")).toHaveCount(3);
        await expect(credits.locator("a").nth(0)).toHaveAttribute(
            "href", "https://www.themoviedb.org/");
        await expect(credits.locator("a").nth(1)).toHaveAttribute("href", "https://fanart.tv/");
        await expect(credits.locator("a").nth(2)).toHaveAttribute(
            "href", "https://www.steamgriddb.com/");
        await expect(credits.locator("img")).toHaveAttribute("src", "img/tmdb.svg");
        await expect.poll(() => credits.locator("img").evaluate((image) => image.naturalWidth))
            .toBeGreaterThan(0);
    });
    test("describes backdrop title data without binding the copy to feed fields", async ({ page }) => {
        await mockProviderTestFeed(page);
        await page.goto("/privacy.html", { waitUntil: "domcontentloaded" });
        await expect(page.locator("main")).toContainText(
            "information about the current and upcoming queued titles");
        await expect(page.locator("main")).toContainText(
            "request failures are not cached");
        await expect(page.locator("main")).toContainText(
            "If you press Check, the browser sends it directly to fanart.tv once");
        await expect(page.locator("main")).not.toContainText("Album and Track fields");

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect(page.locator(".controls .note")).toHaveCount(0);
    });
    test("keeps the theme toggle working when storage is unavailable", async ({ page }) => {
        await mockProviderTestFeed(page);
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        await page.addInitScript(() => {
            Storage.prototype.getItem = function () {
                throw new DOMException("storage denied", "SecurityError");
            };
            Storage.prototype.setItem = function () {
                throw new DOMException("storage denied", "SecurityError");
            };
        });

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        const box = page.locator("#themeswitch");
        const before = await box.isChecked();
        await box.evaluate((input) => {
            input.checked = !input.checked;
            input.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await expect(box).toBeChecked({ checked: !before });
        await expect(page.locator("#info-title")).not.toHaveText(/Loading/);
        expect(errors).toEqual([]);
    });
    test("keeps a saved theme when the OS color scheme changes", async ({ page }) => {
        await mockProviderTestFeed(page);
        await page.emulateMedia({ colorScheme: "light" });
        await page.addInitScript(() => {
            localStorage.setItem("theme", "dark");
        });

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        const box = page.locator("#themeswitch");
        const root = page.locator(".page");
        await expect(box).toBeChecked();
        await expect(root).toHaveCSS("color-scheme", "dark");

        await page.emulateMedia({ colorScheme: "dark" });
        await expect(box).not.toBeChecked();
        await expect(root).toHaveCSS("color-scheme", "dark");
    });
    test("uses the shared theme script on every page", async ({ page }) => {
        await mockProviderTestFeed(page);
        await page.addInitScript(() => localStorage.removeItem("theme"));

        for (const path of ["/", "/privacy.html", "/player.html"]) {
            await page.goto(path, { waitUntil: "domcontentloaded" });
            await expect(page.locator('script[src^="js/theme.js?v="]')).toHaveCount(1);
            await expect(page.locator('script:not([src])').filter({ hasText: "syncTheme" }))
                .toHaveCount(0);

            const box = page.locator("#themeswitch");
            const before = await box.isChecked();
            await box.evaluate((input) => {
                input.checked = !input.checked;
                input.dispatchEvent(new Event("change", { bubbles: true }));
            });
            await expect(box).toBeChecked({ checked: !before });
            expect(await page.evaluate(() => localStorage.getItem("theme")))
                .toMatch(/^(dark|light)$/);
        }
    });
    test("paints the OS palette and its manual inverse", async ({ page }) => {
        await mockProviderTestFeed(page);
        await page.addInitScript(() => localStorage.removeItem("theme"));
        // This test owns the palette contract, not the separately specified crossfade.
        // Reduced motion makes each color assertion land on a completed theme state.
        await page.emulateMedia({ reducedMotion: "reduce" });

        const cases = [
            { os: "light", normal: "rgb(246, 247, 250)", inverse: "rgb(11, 13, 18)" },
            { os: "dark", normal: "rgb(11, 13, 18)", inverse: "rgb(246, 247, 250)" }
        ];
        for (const palette of cases) {
            await page.emulateMedia({ colorScheme: palette.os });
            await page.goto("/player.html", { waitUntil: "domcontentloaded" });
            const root = page.locator(".page");
            const toggle = page.locator("#themeswitch");

            await expect(root).toHaveCSS("background-color", palette.normal);
            await expect(root).toHaveCSS("color-scheme", palette.os);
            // The native checkbox is intentionally visually hidden; click it in-page
            // so the real change handler runs without an impossible actionability wait.
            await toggle.evaluate((input) => input.click());
            await expect(toggle).toBeChecked();
            await expect(root).toHaveCSS("background-color", palette.inverse);
            await expect(root).toHaveCSS("color-scheme",
                palette.os === "light" ? "dark" : "light");
        }
    });
    test("uses shared stage-button and options-overlay components", async ({ page }) => {
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });

        await expect(page.locator(".stage-button")).toHaveCount(3);
        await expect(page.locator(".options-overlay")).toHaveCount(2);
        for (const selector of ["#spectrum-options", "#fs-options"]) {
            const transitionProperties = await page.locator(selector).evaluate((element) =>
                getComputedStyle(element).transitionProperty.split(", "));
            expect(transitionProperties).toEqual(expect.arrayContaining([
                "opacity", "transform", "visibility"
            ]));
        }
    });
    test("keeps the player hidden in a sandboxed third-party frame", async ({ page }) => {
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        const playerUrl = page.url();
        const attackerUrl = localMode ? process.env.PLAYER_ATTACKER_URL : "https://attacker.invalid/";
        const attackerBody =
            `<!doctype html><iframe sandbox="allow-scripts" src="${playerUrl}"></iframe>`;

        if (localMode) {
            await page.goto(attackerUrl, { waitUntil: "domcontentloaded" });
            await page.setContent(attackerBody, { waitUntil: "domcontentloaded" });
        } else {
            await page.route(attackerUrl, (route) => route.fulfill({
                contentType: "text/html", body: attackerBody,
            }));
            await page.goto(attackerUrl, { waitUntil: "domcontentloaded" });
        }
        await expect.poll(() => page.frames().some((frame) => frame.url() === playerUrl)).toBe(true);
        const playerFrame = page.frames().find((frame) => frame.url() === playerUrl);
        expect(await playerFrame.evaluate(() => getComputedStyle(document.documentElement).display))
            .toBe("none");
    });
    test("keeps the no-JavaScript audio fallback visible at top level", async ({ browser }) => {
        const context = await browser.newContext({ javaScriptEnabled: false });
        const page = await context.newPage();
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });

        await expect(page.locator(".noscript-player")).toBeVisible();
        await expect(page.locator(".noscript-player audio")).toHaveCount(5);
        await context.close();
    });
    test("loads the audio spectrum module only when audio is first requested",
        async ({ page }) => {
            const moduleRequests = [];
            let pendingModuleRoute = null;
            page.on("request", (request) => {
                if (new URL(request.url()).pathname.endsWith("/js/audio-spectrum.js"))
                    moduleRequests.push(request.url());
            });
            await page.route("**/js/audio-spectrum.js*", (route) => {
                pendingModuleRoute = route;
            });
            await page.addInitScript(() => {
                window.__playCalls = 0;
                HTMLMediaElement.prototype.play = function () {
                    window.__playCalls++;
                    return Promise.resolve();
                };
                HTMLMediaElement.prototype.pause = function () {};
                HTMLMediaElement.prototype.load = function () {};
            });
            await mockProviderTestFeed(page);
            await page.goto("/player.html", { waitUntil: "domcontentloaded" });

            expect(moduleRequests).toEqual([]);
            await openSettingsTab(page, "Visualizations");
            await page.locator("#spectrum-enabled").check();
            expect(moduleRequests).toEqual([]);

            const loaded = page.waitForResponse((response) =>
                new URL(response.url()).pathname.endsWith("/js/audio-spectrum.js")
                && response.ok());
            await page.locator("#audio-toggle").click();
            await expect.poll(() => !!pendingModuleRoute).toBe(true);
            expect(await page.evaluate(() => window.__playCalls)).toBe(1);
            await pendingModuleRoute.continue();
            await loaded;
            await expect(page.locator("#audio-toggle")).toHaveAttribute("aria-pressed", "true");
            expect(moduleRequests).toHaveLength(1);
            const playerScript = await page.locator('script[src^="js/player.js?v="]')
                .getAttribute("src");
            expect(new URL(moduleRequests[0]).searchParams.get("v"))
                .toBe(new URL(playerScript, page.url()).searchParams.get("v"));

            await page.locator("#audio-toggle").click();
            await page.locator("#audio-toggle").click();
            await page.waitForTimeout(100);
            expect(moduleRequests).toHaveLength(1);
        });
    test("recovers when the lazy audio spectrum module initially fails to load",
        async ({ page }) => {
            const moduleUrls = [];
            const pageErrors = [];
            page.on("pageerror", (error) => pageErrors.push(String(error)));
            await page.route("**/js/audio-spectrum.js*", (route) => {
                moduleUrls.push(route.request().url());
                if (moduleUrls.length === 1) return route.abort("failed");
                return route.fulfill({ contentType: "text/javascript",
                    body: `export function createAudioVisualizationController() {
                        return { prepare() {}, sync() {}, clear() {}, reset() {} };
                    }` });
            });
            await page.addInitScript(() => {
                HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
                HTMLMediaElement.prototype.pause = function () {};
                HTMLMediaElement.prototype.load = function () {};
            });
            await mockProviderTestFeed(page);
            await page.goto("/player.html", { waitUntil: "domcontentloaded" });

            await page.locator("#audio-toggle").click();
            await expect(page.locator("#status"))
                .toHaveText("Audio controls failed to load – try again.");
            await expect(page.locator("#audio-toggle")).toHaveAttribute("aria-pressed", "false");
            expect(moduleUrls).toHaveLength(1);

            await page.locator("#audio-toggle").click();
            await expect.poll(() => moduleUrls.length).toBe(2);
            await expect(page.locator("#audio-toggle")).toHaveAttribute("aria-pressed", "true");
            await expect(page.locator("#status")).toHaveText("");
            expect(new URL(moduleUrls[0]).searchParams.get("retry")).toBe(null);
            expect(new URL(moduleUrls[1]).searchParams.get("retry")).toBe("1");
            expect(pageErrors).toEqual([]);
        });
    test("runs analyser producers only for declarative blackboard demand",
        async ({ page }) => {
            await mockProviderTestFeed(page);
            await page.goto("/player.html", { waitUntil: "domcontentloaded" });

            const result = await page.evaluate(async () => {
                const module = await import("/js/audio-spectrum.js?blackboard-contract-test");
                const { ANALYSER_FACTS, createAudioAnalyserController } = module;
                const telemetry = {
                    frequencyReads: 0,
                    timeReads: 0,
                    processes: 0,
                    resets: 0,
                    draws: { first: 0, second: 0, time: 0 }
                };
                class FakeNode { connect() {} }
                class FakeAnalyser extends FakeNode {
                    constructor() {
                        super();
                        this.frequencyBinCount = 64;
                        this.fftSize = 128;
                    }
                    getByteFrequencyData(data) {
                        telemetry.frequencyReads++;
                        data.fill(96);
                    }
                    getByteTimeDomainData(data) {
                        telemetry.timeReads++;
                        data.fill(128);
                    }
                }
                const PreviousAudioContext = window.AudioContext;
                window.AudioContext = class {
                    constructor() {
                        this.destination = {};
                        this.state = "running";
                    }
                    createAnalyser() { return new FakeAnalyser(); }
                    createMediaElementSource() { return new FakeNode(); }
                    resume() { return Promise.resolve(); }
                };
                const options = { first: true, second: true, time: false };
                const reducedMotion = { matches: false, addEventListener() {} };
                const audio = document.createElement("audio");
                const wait = milliseconds => new Promise(resolve =>
                    setTimeout(resolve, milliseconds));
                const snapshot = () => JSON.parse(JSON.stringify(telemetry));
                const derivedFact = "test.derived";
                const derivedConsumer = id => ({
                    id,
                    needs: [derivedFact],
                    enabled(current) { return current[id]; },
                    setActive() {},
                    clear() {},
                    draw({ blackboard }) {
                        if (!blackboard.has(derivedFact))
                            throw new Error("Missing derived blackboard fact");
                        telemetry.draws[id]++;
                    }
                });
                const timeConsumer = {
                    id: "time",
                    needs: [ANALYSER_FACTS.timeDomainData],
                    enabled(current) { return current.time; },
                    setActive() {},
                    clear() {},
                    draw({ blackboard }) {
                        if (!blackboard.has(ANALYSER_FACTS.timeDomainData))
                            throw new Error("Missing time-domain blackboard fact");
                        telemetry.draws.time++;
                    }
                };
                const producer = {
                    id: "test-producer",
                    needs: [ANALYSER_FACTS.frequencyData],
                    provides: [derivedFact],
                    process(blackboard) {
                        telemetry.processes++;
                        blackboard.set(derivedFact, telemetry.processes);
                    },
                    reset(blackboard) {
                        telemetry.resets++;
                        blackboard.delete(derivedFact);
                    }
                };
                const controllerArgs = {
                    audioElement: audio,
                    getOptions: () => options,
                    isAudioWanted: () => true,
                    hasAudioPlayed: () => true,
                    reducedMotion,
                    producers: [producer],
                    visualizations: [derivedConsumer("first"),
                        derivedConsumer("second"), timeConsumer]
                };
                const controller = createAudioAnalyserController(controllerArgs);
                controller.prepare();
                controller.sync();
                await wait(180);
                const both = snapshot();

                options.first = false;
                controller.sync();
                await wait(500);
                const one = snapshot();

                options.second = false;
                controller.sync();
                const beforeRelease = snapshot();
                await wait(120);
                const releasing = snapshot();
                await wait(500);
                const stopped = snapshot();
                await wait(120);
                const stable = snapshot();

                options.time = true;
                controller.sync();
                await wait(180);
                const timeOnly = snapshot();
                options.time = false;
                controller.sync();
                await wait(500);

                function constructionError(producers) {
                    try {
                        createAudioAnalyserController({
                            ...controllerArgs, producers, visualizations: []
                        });
                        return "";
                    } catch (error) {
                        return String(error.message || error);
                    }
                }
                const duplicate = constructionError([
                    { id: "a", provides: ["duplicate"], process() {} },
                    { id: "b", provides: ["duplicate"], process() {} }
                ]);
                const cyclic = constructionError([
                    { id: "a", needs: ["cycle.b"], provides: ["cycle.a"], process() {} },
                    { id: "b", needs: ["cycle.a"], provides: ["cycle.b"], process() {} }
                ]);
                let missing = "";
                try {
                    createAudioAnalyserController({
                        ...controllerArgs,
                        producers: [],
                        visualizations: [{ id: "missing", needs: ["missing.fact"] }]
                    });
                } catch (error) {
                    missing = String(error.message || error);
                }
                window.AudioContext = PreviousAudioContext;
                return { both, one, beforeRelease, releasing, stopped, stable,
                    timeOnly, duplicate, cyclic, missing };
            });

            expect(result.both.frequencyReads).toBeGreaterThan(0);
            expect(result.both.processes).toBe(result.both.frequencyReads);
            expect(result.both.draws.first).toBeGreaterThan(0);
            expect(result.both.draws.second).toBeGreaterThan(0);
            expect(result.both.processes).toBeLessThan(
                result.both.draws.first + result.both.draws.second);
            expect(result.both.timeReads).toBe(0);
            expect(result.one.frequencyReads).toBeGreaterThan(result.both.frequencyReads);
            expect(result.one.resets).toBe(0);
            expect(result.releasing.frequencyReads)
                .toBeGreaterThan(result.beforeRelease.frequencyReads);
            expect(result.stopped.resets).toBe(1);
            expect(result.stable.frequencyReads).toBe(result.stopped.frequencyReads);
            expect(result.stable.processes).toBe(result.stopped.processes);
            expect(result.timeOnly.timeReads).toBeGreaterThan(result.stable.timeReads);
            expect(result.timeOnly.frequencyReads).toBe(result.stable.frequencyReads);
            expect(result.duplicate).toContain("Duplicate analyser fact provider");
            expect(result.cyclic).toContain("Cyclic analyser fact dependency");
            expect(result.missing).toContain("Missing analyser fact provider");
        });
    test("reveals the canvas audio control and keeps both audio buttons in sync",
        async ({ page }) => {
            await page.addInitScript(() => {
                window.__playCalls = 0;
                HTMLMediaElement.prototype.play = function () {
                    window.__playCalls++;
                    return Promise.resolve();
                };
                HTMLMediaElement.prototype.pause = function () {};
                HTMLMediaElement.prototype.load = function () {};
            });
            await mockProviderTestFeed(page);
            await page.goto("/player.html", { waitUntil: "domcontentloaded" });

            const stage = page.locator("#stage");
            const stageAudio = page.locator("#stage-audio");
            const panelAudio = page.locator("#audio-toggle");
            await expect(stageAudio).toHaveCSS("opacity", "0");
            await stage.hover();
            await expect(stageAudio).toHaveCSS("opacity", "1");

            const canvasBackground = await stageAudio
                .evaluate((button) => getComputedStyle(button).backgroundColor);
            await stageAudio.click();
            await expect.poll(() => page.evaluate(() => window.__playCalls)).toBe(1);
            await expect(stageAudio).toHaveAttribute("aria-pressed", "true");
            await expect(stageAudio).toHaveCSS("background-color", canvasBackground);
            await expect(stageAudio).toHaveAttribute("aria-label", "Stop audio");
            await expect(panelAudio).toHaveAttribute("aria-pressed", "true");
            await expect(panelAudio).toHaveText("⏸ Stop audio");

            await panelAudio.click();
            await expect(stageAudio).toHaveAttribute("aria-pressed", "false");
            await expect(stageAudio).toHaveAttribute("aria-label", "Play audio");
            await expect(panelAudio).toHaveAttribute("aria-pressed", "false");

            await page.locator("#coverbox").click();
            await page.keyboard.press("Space");
            await expect(stageAudio).toHaveAttribute("aria-pressed", "true");
            await page.keyboard.press("Space");
            await expect(stageAudio).toHaveAttribute("aria-pressed", "false");

            await page.locator("#fullscreen").click();
            await expect.poll(() => page.evaluate(() =>
                document.fullscreenElement && document.fullscreenElement.id)).toBe("stage");
            await expect(stageAudio).toHaveCSS("opacity", "1");
            await expect(stage).toHaveClass(/idle/);
            await expect(stageAudio).toHaveCSS("opacity", "0");
            const fullscreenBox = await stage.boundingBox();
            await page.mouse.move(fullscreenBox.x + fullscreenBox.width / 2,
                fullscreenBox.y + fullscreenBox.height / 2);
            await expect(stage).not.toHaveClass(/idle/);
            await expect(stageAudio).toHaveCSS("opacity", "1");
            await page.evaluate(() => document.exitFullscreen());
        });
    test("keeps fullscreen options mounted until their exit fade completes", async ({ page }) => {
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });

        await page.locator("#fullscreen").click();
        await expect.poll(() => page.evaluate(() =>
            document.fullscreenElement && document.fullscreenElement.id)).toBe("stage");

        const trigger = page.locator("#stage-options");
        const panel = page.locator("#fs-options");
        await trigger.click();
        await expect(panel).toBeVisible();
        await expect(panel).toHaveCSS("opacity", "1");
        await expect(panel.locator(":scope > .controls-top")).toHaveCount(1);
        await expect(panel.locator(":scope > .controls:not(.controls-top)")).toHaveCount(1);

        const closing = await panel.evaluate((element) => {
            document.querySelector("#stage-options").click();
            return {
                hidden: element.hidden,
                state: element.dataset.state,
                controls: element.querySelectorAll(":scope > .controls").length,
            };
        });
        expect(closing).toEqual({ hidden: false, state: "closing", controls: 2 });

        await expect(panel).toBeHidden();
        await expect(page.locator("main .controls-top")).toHaveCount(1);
        await expect(page.locator("main.wrap > section > .controls:not(.controls-top)")).toHaveCount(1);
        await page.evaluate(() => document.exitFullscreen());
        await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBe(null);

        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.locator("#fullscreen").click();
        await expect.poll(() => page.evaluate(() =>
            document.fullscreenElement && document.fullscreenElement.id)).toBe("stage");
        await trigger.click();
        await expect(panel).toBeVisible();
        const reducedClose = await panel.evaluate((element) => {
            document.querySelector("#stage-options").click();
            return {
                hidden: element.hidden,
                state: element.dataset.state,
                controls: element.querySelectorAll(":scope > .controls").length,
            };
        });
        expect(reducedClose).toEqual({ hidden: true, state: "closed", controls: 0 });
        await expect(page.locator("main .controls-top")).toHaveCount(1);
        await page.evaluate(() => document.exitFullscreen());
    });
    test("defaults the 80s lasers on, keeps optional visualizations off, and persists settings", async ({ page }) => {
        await page.route("https://1980s.fm/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Station ID", Track: "", Artist: "24seven.fm", CoverLink: "", Length: 0,
                PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route("https://1980s.fm/images/logos/*", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.goto("/player.html?station=1980s", { waitUntil: "domcontentloaded" });

        const bars = page.locator("#spectrum-bars");
        const enabled = page.locator("#spectrum-enabled");
        const bpm = page.locator("#bpm-enabled");
        const lasers = page.locator("#laser-enabled");
        const milkdrop = page.locator("#milkdrop-enabled");
        const strobe = page.locator("#strobe-enabled");
        const smoke = page.locator("#smoke-enabled");
        const spectrumType = page.locator('input[name="analyzer-type"][value="spectrum"]');
        const oscilloscopeType = page.locator(
            'input[name="analyzer-type"][value="oscilloscope"]');
        const scopeLine = page.locator(
            'input[name="oscilloscope-style"][value="line"]');
        const scopeDots = page.locator(
            'input[name="oscilloscope-style"][value="dots"]');
        const milkdropAuto = page.locator(
            'input[name="milkdrop-preset"][value="auto"]');
        const milkdropMandala = page.locator(
            'input[name="milkdrop-preset"][value="mandala"]');
        await expect(lasers).toBeChecked();
        await expect(milkdrop).not.toBeChecked();
        await expect(milkdropAuto).toBeChecked();
        await expect(milkdropAuto).toBeDisabled();
        await expect(strobe).not.toBeChecked();
        await expect(strobe).toBeEnabled();
        await expect(smoke).not.toBeChecked();
        await expect(smoke).toBeEnabled();
        await expect(enabled).not.toBeChecked();
        await expect(bpm).not.toBeChecked();
        await expect(bars).toHaveValue("24");
        await expect(bars).toHaveAttribute("step", "8");
        await expect(bars).toBeDisabled();
        await expect(page.locator("#spectrum-bars-val")).toHaveText("24");
        await expect(spectrumType).toBeChecked();
        await expect(spectrumType).toBeDisabled();
        await expect(oscilloscopeType).toBeDisabled();
        await expect(scopeLine).toBeChecked();
        await expect(scopeLine).toBeDisabled();
        await expect(page.locator('input[name="spectrum-mode"][value="tinted"]')).toBeChecked();

        await openSettingsTab(page, "Station");
        await strobe.check();
        await smoke.check();
        await lasers.uncheck();
        await openSettingsTab(page, "Visualizations");
        await enabled.check();
        await bpm.check();
        await expect(strobe).toBeDisabled();
        await expect(smoke).toBeDisabled();
        await expect(bars).toBeEnabled();
        await expect(spectrumType).toBeEnabled();
        await expect(oscilloscopeType).toBeEnabled();
        await bars.evaluate((input) => {
            input.value = "48";
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await page.locator("label.seg", { hasText: "Legacy" }).click();
        await page.locator("label.seg", { hasText: "Oscilloscope" }).click();
        await expect(bars).toBeDisabled();
        await expect(scopeLine).toBeEnabled();
        await page.locator("label.seg", { hasText: "Dots" }).click();
        await milkdrop.check();
        await expect(milkdropAuto).toBeEnabled();
        await page.locator("label.seg", { hasText: "Mandala" }).click();
        await expect(page.locator("#spectrum-bars-val")).toHaveText("48");

        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(lasers).not.toBeChecked();
        await expect(milkdrop).toBeChecked();
        await expect(milkdropMandala).toBeChecked();
        await expect(strobe).toBeChecked();
        await expect(strobe).toBeDisabled();
        await expect(smoke).toBeChecked();
        await expect(smoke).toBeDisabled();
        await expect(enabled).toBeChecked();
        await expect(bpm).toBeChecked();
        await expect(bars).toHaveValue("48");
        await expect(bars).toBeDisabled();
        await expect(page.locator("#spectrum-bars-val")).toHaveText("48");
        await expect(oscilloscopeType).toBeChecked();
        await expect(scopeDots).toBeChecked();
        await expect(page.locator('input[name="spectrum-mode"][value="legacy"]')).toBeChecked();
    });
    test("persists the ratings switch independently from its country options", async ({ page }) => {
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });

        await openSettingsTab(page, "Station");
        const master = page.locator("#ratings-enabled");
        const options = page.locator("#rating-options");
        const countries = page.locator("#rating-country-options");
        const de = page.locator("#rating-de-enabled");
        const us = page.locator("#rating-us-enabled");
        await expect(master).not.toBeChecked();
        await expect(master).toHaveAttribute("aria-expanded", "false");
        await expect(options).toHaveAttribute("aria-hidden", "true");
        await expect(countries).toBeHidden();
        await master.check();
        await expect(options).toHaveAttribute("aria-hidden", "false");
        await expect(countries).toBeVisible();
        await expect(de).toBeChecked();
        await expect(us).toBeChecked();
        await us.uncheck();
        await expect(de).toBeChecked();
        await expect(us).not.toBeChecked();
        await expect.poll(() => page.evaluate(() =>
            JSON.parse(localStorage.getItem("24sevenfm-covers.player.v2")).sstRatings))
            .toEqual({ enabled: true, options: { countries: ["DE"] } });
        await master.uncheck();
        await expect.poll(() => page.evaluate(() =>
            JSON.parse(localStorage.getItem("24sevenfm-covers.player.v2")).sstRatings))
            .toEqual({ enabled: false, options: { countries: ["DE"] } });
        await expect(options).toHaveAttribute("aria-hidden", "true");

        await page.reload({ waitUntil: "domcontentloaded" });
        await openSettingsTab(page, "Station");
        await expect(master).not.toBeChecked();
        await master.check();
        await expect(de).toBeChecked();
        await expect(us).not.toBeChecked();
    });
    test("resolves ratings without artwork, flips the next logos, and settles SVGs flat", async ({ page }) => {
        const covers = [
            "https://streamingsoundtracks.com/images/cover/adaline.svg",
            "https://streamingsoundtracks.com/images/cover/got.svg",
        ];
        let nowPlayingRequests = 0;
        const resolverRequests = [];
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ sstRatings: { enabled: true, options: { countries: ["DE", "US"] } },
                transition: { enabled: true, options: { style: 2, durationMs: 1000 } } })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            const second = nowPlayingRequests++ > 0;
            return route.fulfill({ json: {
                Album: second ? "Game Of Thrones" : "Age Of Adaline, The",
                Track: second ? "Main Title" : "Start Again",
                Artist: second ? "Ramin Djawadi" : "Rob Simonsen",
                CoverLink: second ? covers[1] : covers[0],
                Length: 0, PlayStart: "2026-08-20T12:00:00Z",
                SystemTime: "2026-08-20T12:00:00Z",
            } });
        });
        await page.route(/streamingsoundtracks\.com\/images\/cover\/500\/(?:adaline|got)\.svg/,
            (route) => route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/tint\?/, (route) =>
            route.fulfill({ json: { tint: [40, 50, 60] } }));
        await page.route(/\/api\/backdrop\?/, (route) => {
            const url = new URL(route.request().url());
            resolverRequests.push({
                album: url.searchParams.get("album"),
                art: url.searchParams.get("art"),
                ratings: url.searchParams.get("ratings"),
                providers: url.searchParams.get("providers"),
            });
            const gameOfThrones = /Game Of Thrones/i.test(url.searchParams.get("album"));
            return route.fulfill({ json: {
                media: { id: gameOfThrones ? 1399 : 293863,
                    title: gameOfThrones ? "Game of Thrones" : "The Age of Adaline",
                    type: gameOfThrones ? "tv" : "movie" },
                backdrop: null, source: null, tint: [255, 255, 255],
                certifications: gameOfThrones ? [
                    { country: "DE", system: "FSK", rating: "16", label: "FSK 16",
                        logo: "https://upload.wikimedia.org/wikipedia/commons/3/30/FSK_16.svg" },
                    { country: "US", system: "TV Parental Guidelines", rating: "TV-MA",
                        label: "TV-MA",
                        logo: "https://upload.wikimedia.org/wikipedia/commons/3/34/TV-MA_icon.svg" },
                ] : [
                    { country: "DE", system: "FSK", rating: "6", label: "FSK 6",
                        logo: "https://upload.wikimedia.org/wikipedia/commons/b/b0/FSK_ab_6_logo.svg" },
                    { country: "US", system: "MPA", rating: "PG-13", label: "PG-13",
                        logo: "https://upload.wikimedia.org/wikipedia/commons/9/98/MPA_PG-13_RATING.svg" },
                ],
            } });
        });
        await page.route("https://upload.wikimedia.org/wikipedia/commons/**/*.svg", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>' }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await page.evaluate(() => {
            const slot = document.querySelector("#rating-de");
            window.__ratingFlipSnapshot = null;
            const captureSecondRatingFlip = () => {
                const faces = Array.from(slot.querySelectorAll(".rating-face"));
                const sources = faces.map((face) => {
                    const image = face.querySelector("img");
                    return image.hasAttribute("src") ? image.getAttribute("src") : "";
                });
                if (slot.dataset.front !== "b" || !sources[1].includes("FSK_16.svg")) return;
                window.__ratingFlipSnapshot = {
                    sources,
                    backTransform: getComputedStyle(faces[1]).transform,
                    cardTransform: getComputedStyle(slot.querySelector(".rating-card")).transform,
                };
                observer.disconnect();
            };
            const observer = new MutationObserver(captureSecondRatingFlip);
            observer.observe(slot, { attributes: true, subtree: true });
            captureSecondRatingFlip();
        });
        await expect.poll(() => resolverRequests.some((request) =>
            request.album === "Age Of Adaline, The")).toBe(true);
        expect(resolverRequests.find((request) =>
            request.album === "Age Of Adaline, The")).toEqual({
            album: "Age Of Adaline, The", art: "0", ratings: "DE,US", providers: "tmdb",
        });
        await expect(page.locator("#rating-de")).toHaveClass(/show/);
        await expect(page.locator("#rating-us")).toHaveClass(/show/);
        const usMovieRating = page.locator("#rating-us .rating-face").first();
        await expect(usMovieRating).toHaveClass(/has-logo/);
        await expect(usMovieRating).toHaveCSS("box-shadow", "none");
        await expect(page.locator("#movieA.show, #movieB.show")).toHaveCount(0);
        await expect(page.locator("#rating-de")).toHaveAttribute("data-settled", "");

        await expect.poll(() => page.locator("#rating-badges").evaluate(() => {
            const stage = document.querySelector("#stage").getBoundingClientRect();
            const de = document.querySelector("#rating-de").getBoundingClientRect();
            const us = document.querySelector("#rating-us").getBoundingClientRect();
            const right = stage.right - us.right;
            return Math.max(Math.abs((us.left - de.right) - right),
                Math.abs((stage.bottom - us.bottom) - right));
        })).toBeLessThan(1.1);

        const badgeGeometry = await page.locator("#rating-badges").evaluate((badges) => {
            const stage = document.querySelector("#stage").getBoundingClientRect();
            const de = document.querySelector("#rating-de").getBoundingClientRect();
            const us = document.querySelector("#rating-us").getBoundingClientRect();
            const slotStyle = getComputedStyle(document.querySelector("#rating-de"));
            const cardStyle = getComputedStyle(document.querySelector("#rating-de .rating-card"));
            return {
                right: stage.right - us.right,
                bottom: stage.bottom - us.bottom,
                gap: us.left - de.right,
                transform: slotStyle.transform,
                transitionProperties: slotStyle.transitionProperty,
                transitionDurations: slotStyle.transitionDuration,
                cardDuration: cardStyle.transitionDuration,
                cardTransformStyle: cardStyle.transformStyle,
                frontBackface: getComputedStyle(document.querySelector(
                    "#rating-de .rating-face:first-child")).backfaceVisibility,
                backOpacity: getComputedStyle(document.querySelector(
                    "#rating-de .rating-face:last-child")).opacity,
                cardWidth: document.querySelector("#rating-de .rating-card").offsetWidth,
                cardHeight: document.querySelector("#rating-de .rating-card").offsetHeight,
                effect: document.querySelector("#rating-de").dataset.fx,
            };
        });
        expect(Math.abs(badgeGeometry.gap - badgeGeometry.right)).toBeLessThan(1.1);
        expect(Math.abs(badgeGeometry.bottom - badgeGeometry.right)).toBeLessThan(1.1);
        expect(badgeGeometry.transform).toBe("none");
        expect(badgeGeometry.transitionProperties.split(", ")).not.toContain("transform");
        expect(badgeGeometry.transitionDurations.split(", ")).toContain("1s");
        expect(badgeGeometry.cardDuration).toBe("1s");
        expect(badgeGeometry.cardTransformStyle).toBe("flat");
        expect(badgeGeometry.frontBackface).toBe("visible");
        expect(badgeGeometry.backOpacity).toBe("0");
        expect(badgeGeometry.effect).toBe("fliph");

        await openSettingsTab(page, "Station");
        const deToggle = page.locator("#rating-de-enabled");
        const usToggle = page.locator("#rating-us-enabled");
        await deToggle.uncheck();
        await usToggle.uncheck();
        await expect(page.locator("#rating-de")).not.toHaveClass(/show/);
        await expect(page.locator("#rating-us")).not.toHaveClass(/show/);
        await expect(page.locator("#rating-de")).toHaveCSS("max-width", "0px");
        await deToggle.check();
        await usToggle.check();
        await expect(page.locator("#rating-de")).toHaveClass(/show/);
        await expect(page.locator("#rating-us")).toHaveClass(/show/);
        const enteringBadge = await page.locator("#rating-de").evaluate((slot) => ({
            cardWidth: slot.querySelector(".rating-card").offsetWidth,
            cardHeight: slot.querySelector(".rating-card").offsetHeight,
            cardTransform: getComputedStyle(slot.querySelector(".rating-card")).transform,
            effect: slot.dataset.fx,
        }));
        expect(Math.abs(enteringBadge.cardWidth - badgeGeometry.cardWidth)).toBeLessThan(1.1);
        expect(Math.abs(enteringBadge.cardHeight - badgeGeometry.cardHeight)).toBeLessThan(1.1);
        expect(enteringBadge.effect).toBe("fliph");
        expect(enteringBadge.cardTransform).not.toBe("none");
        await usToggle.uncheck();
        await expect(page.locator("#rating-de")).toHaveClass(/show/);
        await expect(page.locator("#rating-us")).not.toHaveClass(/show/);
        await usToggle.check();
        await expect(page.locator("#rating-us")).toHaveClass(/show/);
        await deToggle.uncheck();
        await expect(page.locator("#rating-de")).not.toHaveClass(/show/);
        await expect(page.locator("#rating-us")).toHaveClass(/show/);
        await deToggle.check();
        await expect(page.locator("#rating-de")).toHaveClass(/show/);

        await expect.poll(() => resolverRequests.some((request) =>
            request.album === "Game Of Thrones"), { timeout: 10000 }).toBe(true);
        await expect(page.locator("#rating-de")).toHaveAttribute("data-fx", "fliph");
        await expect.poll(() => page.evaluate(() => !!window.__ratingFlipSnapshot)).toBe(true);
        const glued = await page.evaluate(() => window.__ratingFlipSnapshot);
        expect(glued.sources[0]).toContain("FSK_ab_6_logo.svg");
        expect(glued.sources[1]).toContain("FSK_16.svg");
        expect(glued.backTransform).not.toBe("none");
        // The SVG may use the 3D card while it is visibly flipping, but must be
        // normalized back onto the untransformed front face afterwards. Leaving the
        // two 180° layers composed indefinitely makes Chromium rasterize it softly.
        await expect.poll(() => page.locator("#rating-de").getAttribute("data-front"),
            { timeout: 3000 }).toBe("a");
        await expect(page.locator("#rating-de")).toHaveAttribute("data-settled", "");
        const settled = await page.locator("#rating-de").evaluate((slot) => {
            const front = slot.querySelector(".rating-face:first-child");
            return {
                cardTransform: getComputedStyle(slot.querySelector(".rating-card")).transform,
                cardTransformStyle: getComputedStyle(slot.querySelector(
                    ".rating-card")).transformStyle,
                faceTransform: getComputedStyle(front).transform,
                faceBackface: getComputedStyle(front).backfaceVisibility,
                source: front.querySelector("img").getAttribute("src"),
            };
        });
        expect(settled.cardTransform).toBe("none");
        expect(settled.cardTransformStyle).toBe("flat");
        expect(settled.faceTransform).toBe("none");
        expect(settled.faceBackface).toBe("visible");
        expect(settled.source).toContain("FSK_16.svg");
        const usTvRating = page.locator("#rating-us .rating-face").last();
        await expect(usTvRating).toHaveText("TV-MA");
        await expect(usTvRating).toHaveClass(/has-logo/);
        await expect(usTvRating.locator("img")).toHaveAttribute("src",
            "https://upload.wikimedia.org/wikipedia/commons/3/34/TV-MA_icon.svg");
        await expect(usTvRating).toHaveCSS("border-top-width", "0px");
        await expect(usTvRating).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(usTvRating).toHaveCSS("box-shadow", "none");
    });
    test("falls back to the existing US TV text badge when its logo cannot load",
        async ({ page }) => {
            const logo = "https://upload.wikimedia.org/wikipedia/commons/3/34/TV-MA_icon.svg";
            let logoRequested = false;
            await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
                JSON.stringify({
                    sstRatings: { enabled: true, options: { countries: ["US"] } },
                })));
            await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*",
                (route) => {
                    const action = new URL(route.request().url()).searchParams.get("action");
                    if (action === "GetQueue") return route.fulfill({ json: [] });
                    return route.fulfill({ json: {
                        Album: "Fallback TV", Track: "Main Title", Artist: "Test Composer",
                        CoverLink: "https://streamingsoundtracks.com/images/cover/fallback-tv.svg",
                        Length: 0, PlayStart: "2026-08-20T12:00:00Z",
                        SystemTime: "2026-08-20T12:00:00Z",
                    } });
                });
            await page.route(
                "https://streamingsoundtracks.com/images/cover/500/fallback-tv.svg",
                (route) => route.fulfill({ status: 200, contentType: "image/svg+xml",
                    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
            await page.route(/\/api\/tint\?/, (route) =>
                route.fulfill({ json: { tint: [40, 50, 60] } }));
            await page.route(/\/api\/backdrop\?/, (route) => route.fulfill({ json: {
                media: { id: 42, title: "Fallback TV", type: "tv" },
                backdrop: null, source: null, tint: [255, 255, 255],
                certifications: [{
                    country: "US", system: "TV Parental Guidelines", rating: "TV-MA",
                    label: "TV-MA", logo,
                }],
            } }));
            await page.route(logo, (route) => {
                logoRequested = true;
                return route.fulfill({ status: 404, contentType: "text/plain", body: "missing" });
            });

            await page.goto("/player.html", { waitUntil: "domcontentloaded" });
            await expect.poll(() => logoRequested).toBe(true);
            const slot = page.locator("#rating-us");
            await expect(slot).toHaveClass(/show/);
            await expect(slot).toHaveAttribute("aria-label", "United States: TV-MA");
            await expect(slot).toContainText("TV-MA");
            await expect(slot.locator(".rating-face.has-logo")).toHaveCount(0);
            await expect(slot.locator(".rating-face img[src]")).toHaveCount(0);
        });
    test("fades ratings after ten idle seconds and wakes them on pointer movement", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/rating-idle.svg";
        let secondTrack = false;
        let firstResolverRequested = false;
        let releaseFirstResolver;
        const firstResolverMayFinish = new Promise((resolve) => {
            releaseFirstResolver = resolve;
        });
        let secondResolverRequested = false;
        let releaseSecondResolver;
        const secondResolverMayFinish = new Promise((resolve) => {
            releaseSecondResolver = resolve;
        });
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ sstRatings: { enabled: true, options: { countries: ["DE"] } },
                transition: { enabled: true, options: { style: 1, durationMs: 500 } } })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: secondTrack ? "Next Rating Movie" : "Rating Idle Movie",
                Track: secondTrack ? "Second Cue" : "Main Title", Artist: "Idle Composer",
                CoverLink: cover, Length: 0, PlayStart: "2026-08-20T12:00:00Z",
                SystemTime: "2026-08-20T12:00:00Z",
            } });
        });
        await page.route("https://streamingsoundtracks.com/images/cover/500/rating-idle.svg",
            (route) => route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/tint\?/, (route) =>
            route.fulfill({ json: { tint: [40, 50, 60] } }));
        await page.route(/\/api\/backdrop\?/, async (route) => {
            const next = /Next Rating Movie/.test(
                new URL(route.request().url()).searchParams.get("album"));
            if (!next) {
                firstResolverRequested = true;
                await firstResolverMayFinish;
            } else {
                secondResolverRequested = true;
                await secondResolverMayFinish;
            }
            return route.fulfill({ json: {
                media: { id: next ? 11 : 10,
                    title: next ? "Next Rating Movie" : "Rating Idle Movie", type: "movie" },
                backdrop: null, source: null, tint: [255, 255, 255],
                certifications: [{ country: "DE", system: "FSK",
                    rating: next ? "16" : "12", label: next ? "FSK 16" : "FSK 12",
                    logo: next
                        ? "https://upload.wikimedia.org/wikipedia/commons/3/30/FSK_16.svg"
                        : "https://upload.wikimedia.org/wikipedia/commons/6/6e/FSK_12.svg" }],
            } });
        });
        await page.route(/https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/(?:6\/6e\/FSK_12|3\/30\/FSK_16)\.svg/,
            (route) => route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>' }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        const stage = page.locator("#stage");
        const badges = page.locator("#rating-badges");
        const stageAudio = page.locator("#stage-audio");
        await expect.poll(() => firstResolverRequested).toBe(true);

        // A refresh must not spend its visibility window waiting on the API. Even
        // after ten slow seconds, the first revealed rating gets a fresh full window.
        await page.waitForTimeout(10100);
        await expect(page.locator("#rating-de")).not.toHaveClass(/show/);
        await expect(badges).not.toHaveClass(/track-intro/);
        releaseFirstResolver();
        await expect(page.locator("#rating-de")).toHaveClass(/show/);
        await expect(badges).toHaveClass(/track-intro/);
        await expect(badges).toHaveAttribute("aria-hidden", "false");
        await expect(badges).toHaveCSS("opacity", "1");

        await page.waitForTimeout(10100);
        await expect(badges).not.toHaveClass(/track-intro/);
        await expect(badges).toHaveCSS("opacity", "0");
        await expect(badges).toBeHidden();
        await expect(stageAudio).toHaveCSS("opacity", "0");

        // Re-enabling ratings is a fresh listener action and gets the same complete
        // ten-second reveal as a new track, even though the certification is retained.
        await openSettingsTab(page, "Station");
        const ratingsToggle = page.locator("#ratings-enabled");
        await ratingsToggle.uncheck();
        await ratingsToggle.check();
        await expect(badges).toHaveClass(/track-intro/);
        await expect(badges).toHaveCSS("opacity", "1");
        await page.waitForTimeout(10100);
        await expect(badges).not.toHaveClass(/track-intro/);
        await expect(badges).toHaveCSS("opacity", "0");

        await stage.scrollIntoViewIfNeeded();
        const box = await stage.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await expect(badges).toHaveCSS("opacity", "1");
        await expect(stageAudio).toHaveCSS("opacity", "1");

        // Embedded mode is hover-driven, exactly like the buttons: a stationary
        // pointer over the stage does not invoke fullscreen's idle timeout.
        await page.waitForTimeout(2100);
        await expect(badges).toHaveCSS("opacity", "1");
        await expect(stageAudio).toHaveCSS("opacity", "1");

        await page.mouse.move(1, 1);
        await expect(badges).toHaveCSS("opacity", "0");
        await expect(stageAudio).toHaveCSS("opacity", "0");

        // Fullscreen uses the same `.idle` class and two-second timer as the buttons.
        await stage.evaluate((element) => element.requestFullscreen());
        const fullscreenBox = await stage.boundingBox();
        await page.mouse.move(fullscreenBox.x + fullscreenBox.width / 3,
            fullscreenBox.y + fullscreenBox.height / 2);
        await expect(stage).not.toHaveClass(/idle/);
        await expect(badges).toHaveCSS("opacity", "1");
        await expect(stageAudio).toHaveCSS("opacity", "1");
        await expect(stage).toHaveClass(/idle/);
        await expect(badges).toHaveCSS("opacity", "0");
        await expect(stageAudio).toHaveCSS("opacity", "0");
        await page.mouse.move(fullscreenBox.x + fullscreenBox.width * 2 / 3,
            fullscreenBox.y + fullscreenBox.height / 2);
        await expect(stage).not.toHaveClass(/idle/);
        await expect(badges).toHaveCSS("opacity", "1");
        await expect(stageAudio).toHaveCSS("opacity", "1");
        await expect(stage).toHaveClass(/idle/);
        await expect(badges).toHaveCSS("opacity", "0");

        // A track handoff that begins while fullscreen chrome is hidden must keep
        // the outgoing badge concealed until the destination logo is ready. Even a
        // pointer wake during that wait may not reveal the stale front/back faces.
        secondTrack = true;
        await expect(page.locator("#info-title"))
            .toContainText("Next Rating Movie - Second Cue", { timeout: 7000 });
        await expect.poll(() => secondResolverRequested).toBe(true);
        await expect(badges).toHaveClass(/track-handoff/);
        await expect(page.locator("#rating-de")).not.toHaveClass(/show/);
        await page.mouse.move(fullscreenBox.x + fullscreenBox.width / 4,
            fullscreenBox.y + fullscreenBox.height / 3);
        await expect(stage).not.toHaveClass(/idle/);
        await expect(badges).toHaveCSS("opacity", "0");
        await expect(badges).toBeHidden();

        releaseSecondResolver();
        await expect(page.locator("#rating-de")).toHaveAttribute("aria-label", "Germany: FSK 16");
        await expect(badges).not.toHaveClass(/track-handoff/);
        await expect(badges).toHaveClass(/track-intro/);
        await expect(badges).toHaveAttribute("aria-hidden", "false");
        await expect(badges).toHaveCSS("opacity", "1");
        const handoffFaces = await page.locator("#rating-de .rating-face img")
            .evaluateAll((images) => images.map((image) => image.getAttribute("src")));
        expect(handoffFaces).toEqual([
            "https://upload.wikimedia.org/wikipedia/commons/3/30/FSK_16.svg",
            "https://upload.wikimedia.org/wikipedia/commons/3/30/FSK_16.svg",
        ]);
        await page.evaluate(() => document.exitFullscreen());
    });
    test("persists scalar controls and reapplies their effects", async ({ page }) => {
        await mockLayoutTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });

        await page.locator('label.seg:has(input[name="layout"][value="0"])').click();
        await page.locator('label.seg:has(input[name="transition"][value="3"])').click();
        await page.locator("#remaining-time-enabled").check();
        await page.locator('label.seg:has(input[name="cdsize"][value="large"])').click();
        await page.locator('label.seg:has(input[name="remaining"][value="rolldown"])').click();
        await page.locator("#show-coming-next").check();
        await page.locator("#fade").evaluate((input) => {
            input.value = "1700";
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await page.locator("#volume").evaluate((input) => {
            input.value = "0.35";
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await openBackdropSettings(page);
        await page.locator("#fanart-on").uncheck();
        await page.locator("#steamgriddb-on").uncheck();
        await page.locator("#hide-cover").check();

        await expect.poll(() => page.evaluate(() =>
            JSON.parse(localStorage.getItem("24sevenfm-covers.player.v2"))))
            .toMatchObject({ layout: 0,
                transition: { enabled: true, options: { style: 3, durationMs: 1700 } },
                remainingTime: { enabled: true,
                    options: { mode: "rolldown", size: "large" } },
                comingNext: true,
                sstBackdrops: { enabled: true,
                    options: { providers: ["tmdb"], cover: "hide" } },
                volume: 0.35 });
        await expect.poll(() => Object.fromEntries(new URL(page.url()).searchParams))
            .toMatchObject({ preset: "1", station: "sst", layout: "fill",
                transition: "flipVertical", fade: "1700", remaining: "rolldown",
                remainingSize: "large", comingNext: "1", volume: "0.35",
                sstBackdrops: "1", sstBackdropProviders: "tmdb" });
        expect(new URL(page.url()).searchParams.has("fanartKey")).toBe(false);
        await expect(page.locator("#stage")).toHaveClass(/layout-fill/);
        await expect(page.locator("#fade-val")).toHaveText("1.7 s");

        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.locator("#stage")).toHaveClass(/layout-fill/);
        await expect(page.locator('input[name="transition"][value="3"]')).toBeChecked();
        await expect(page.locator('input[name="cdsize"][value="large"]')).toBeChecked();
        await expect(page.locator('input[name="remaining"][value="rolldown"]')).toBeChecked();
        await expect(page.locator("#show-coming-next")).toBeChecked();
        await expect(page.locator("#backdrops-enabled")).toBeChecked();
        await expect(page.locator("#tmdbart-on")).toBeChecked();
        await expect(page.locator("#hide-cover")).toBeChecked();
        await expect(page.locator("#fade")).toHaveValue("1700");
        await expect(page.locator("#fade-val")).toHaveText("1.7 s");
        await expect(page.locator("#volume")).toHaveValue("0.35");

        await page.locator("#remaining-time-enabled").uncheck();
        await expect.poll(() => page.evaluate(() =>
            JSON.parse(localStorage.getItem("24sevenfm-covers.player.v2"))))
            .toMatchObject({ remainingTime: { enabled: false,
                options: { mode: "rolldown", size: "large" } } });
        expect(new URL(page.url()).searchParams.has("remaining")).toBe(false);
        expect(new URL(page.url()).searchParams.get("remainingSize")).toBe("large");

        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.locator("#remaining-time-enabled")).not.toBeChecked();
        await expect(page.locator('input[name="cdsize"][value="large"]')).toBeChecked();
    });
    test("shows the queued album and handed-in artist for the final ten seconds",
        async ({ page }) => {
            const album = "A Very Long Album Name That Needs The Full Available Announcement Width Before It Is Ellipsized";
            const artist = "A Composer With An Equally Long Credit That Must Also Be Ellipsized";
            let creditRequests = 0;
            await page.setViewportSize({ width: 1000, height: 760 });
            await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
                JSON.stringify({ comingNext: true })));
            await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
                const action = new URL(route.request().url()).searchParams.get("action");
                if (action === "GetQueue") return route.fulfill({ json: [{
                    Album: album, Track: "Next Cue", Artist: artist,
                    CoverLink: "", SiteLink: "",
                }] });
                return route.fulfill({ json: {
                    Album: "Current Album", Track: "Current Cue", Artist: "Current Composer",
                    CoverLink: "", Length: 12000,
                    PlayStart: "2026-08-23T12:00:00Z",
                    SystemTime: "2026-08-23T12:00:02Z",
                } });
            });
            await page.route("https://streamingsoundtracks.com/images/logos/*", (route) =>
                route.fulfill({ status: 200, contentType: "image/svg+xml",
                    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
            await page.route("https://24covers-api.vercel.app/api/credit?*", (route) => {
                creditRequests++;
                return route.fulfill({ json: { artist: "Wrong fallback" } });
            });

            await page.goto("/player.html", { waitUntil: "domcontentloaded" });
            const announcement = page.locator("#coming-next");
            await expect(announcement).toHaveClass(/show/, { timeout: 3000 });
            await expect(announcement).toHaveAttribute("aria-hidden", "false");
            await expect(page.locator("#coming-next-album")).toHaveText(album);
            await expect(page.locator("#coming-next-artist")).toHaveText(artist);
            expect(creditRequests).toBe(0);

            await stableElementRects(page, {
                stage: "#stage", announcement: "#coming-next", button: "#fullscreen",
            });
            const geometry = await announcement.evaluate((element) => {
                const stage = document.querySelector("#stage").getBoundingClientRect();
                const button = document.querySelector("#fullscreen").getBoundingClientRect();
                const box = element.getBoundingClientRect();
                const albumLine = document.querySelector("#coming-next-album");
                const style = getComputedStyle(element);
                const lineStyle = getComputedStyle(albumLine);
                return {
                    width: box.width,
                    stageWidth: stage.width,
                    rightGap: stage.right - box.right,
                    belowButton: box.top >= button.bottom,
                    albumOverflow: albumLine.scrollWidth > albumLine.clientWidth,
                    textOverflow: lineStyle.textOverflow,
                    transitionProperties: style.transitionProperty.split(", "),
                };
            });
            expect(geometry.width).toBeLessThanOrEqual(geometry.stageWidth / 2 + 1);
            expect(geometry.width).toBeGreaterThanOrEqual(geometry.stageWidth / 2 - 2);
            expect(geometry.rightGap).toBeGreaterThan(5);
            expect(geometry.rightGap).toBeLessThan(20);
            expect(geometry.belowButton).toBe(true);
            expect(geometry.albumOverflow).toBe(true);
            expect(geometry.textOverflow).toBe("ellipsis");
            expect(geometry.transitionProperties).toEqual(expect.arrayContaining(
                ["opacity", "transform"]));
            expect(geometry.transitionProperties).not.toContain("width");

            await page.locator("#stage").evaluate((element) => element.requestFullscreen());
            await expect.poll(() => page.evaluate(() =>
                document.fullscreenElement && document.fullscreenElement.id)).toBe("stage");
            const fullscreenRects = await stableElementRects(page, {
                stage: "#stage", announcement: "#coming-next",
            });
            const fullscreenRightGap = fullscreenRects.stage.right
                - fullscreenRects.announcement.right;
            expect(fullscreenRects.announcement.width).toBeLessThanOrEqual(
                fullscreenRects.stage.width / 2 + 1);
            expect(fullscreenRects.announcement.width).toBeGreaterThanOrEqual(
                fullscreenRects.stage.width / 2 - 2);
            expect(fullscreenRightGap).toBeGreaterThan(5);
            expect(fullscreenRightGap).toBeLessThan(20);
            await page.evaluate(() => document.exitFullscreen());
        });
    test("keeps the Coming next header complete for a short queued album", async ({ page }) => {
        await page.addInitScript(() => {
            const nativeSetInterval = window.setInterval.bind(window);
            window.setInterval = (callback, delay, ...args) => {
                if (delay === 1000 && !window.__playerTick) {
                    window.__playerTick = () => callback(...args);
                    return 1;
                }
                return nativeSetInterval(callback, delay, ...args);
            };
        });
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ comingNext: true })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [{
                Album: "Super 8", Track: "Next Cue", CoverLink: "", SiteLink: "",
            }] });
            return route.fulfill({ json: {
                Album: "Current Album", Track: "Current Cue", Artist: "Current Composer",
                CoverLink: "", Length: 10000,
                PlayStart: "2026-08-23T12:00:00Z",
                SystemTime: "2026-08-23T12:00:05Z",
            } });
        });
        await page.route("https://streamingsoundtracks.com/images/logos/*", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect(page.locator("#coming-next")).toHaveClass(/show/);
        await expect(page.locator("#coming-next-album")).toHaveText("Super 8");
        const settled = await stableElementRects(page, {
            announcement: "#coming-next", label: ".coming-next-label",
        });
        const header = await page.locator(".coming-next-label").evaluate((label) => ({
            clientWidth: label.clientWidth,
            scrollWidth: label.scrollWidth,
            textOverflow: getComputedStyle(label).textOverflow,
        }));
        expect(header.textOverflow).toBe("clip");
        expect(header.clientWidth).toBeGreaterThanOrEqual(header.scrollWidth);
        let afterRenderTicks;
        for (let tick = 0; tick < 3; tick++) {
            await page.evaluate(() => window.__playerTick());
            afterRenderTicks = await stableElementRects(page, {
                announcement: "#coming-next",
            });
        }
        expect(afterRenderTicks.announcement.width).toBeCloseTo(
            settled.announcement.width, 5);
    });
    virtualClockTest("reveals coming next exactly as remaining time reaches ten seconds",
        async ({ page }) => {
            let queueRequests = 0;
            await page.clock.install({ time: new Date("2026-08-23T12:00:00Z") });
            await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
                JSON.stringify({ comingNext: true })));
            await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
                const action = new URL(route.request().url()).searchParams.get("action");
                if (action === "GetQueue") {
                    queueRequests++;
                    return route.fulfill({ json: [{
                        Album: "Next Album", Track: "Next Cue", Artist: "Next Composer",
                        CoverLink: "", SiteLink: "",
                    }] });
                }
                return route.fulfill({ json: {
                    Album: "Current Album", Track: "Current Cue", Artist: "Current Composer",
                    CoverLink: "", Length: 12000,
                    PlayStart: "2026-08-23T12:00:00Z",
                    SystemTime: "2026-08-23T12:00:01Z",
                } });
            });
            await page.route("https://streamingsoundtracks.com/images/logos/*", (route) =>
                route.fulfill({ status: 200, contentType: "image/svg+xml",
                    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));

            await page.goto("/player.html", { waitUntil: "domcontentloaded" });
            await expect.poll(() => queueRequests).toBe(1);
            const announcement = page.locator("#coming-next");
            await expect(announcement).not.toHaveClass(/show/);

            await page.clock.runFor(1000);

            await expect(announcement).toHaveClass(/show/);
            await expect(page.locator("#coming-next-album")).toHaveText("Next Album");
        });
    test("fetches an album credit only when the queue omits Artist and retains text while fading",
        async ({ page }) => {
            let currentAlbum = "Current Album", queueAvailable = true, creditRequests = 0;
            await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
                JSON.stringify({ comingNext: true })));
            await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
                const action = new URL(route.request().url()).searchParams.get("action");
                if (action === "GetQueue") return route.fulfill({ json: queueAvailable ? [{
                    Album: "JFK (2013)", Track: "Campaigning In The South",
                    CoverLink: "",
                    SiteLink: "https://streamingsoundtracks.com/modules.php?name=Album&asin=B00GHJ08XC",
                }] : [] });
                return route.fulfill({ json: {
                    Album: currentAlbum, Track: "Current Cue", Artist: "Current Composer",
                    CoverLink: "", Length: 10000,
                    PlayStart: "2026-08-23T12:00:00Z",
                    SystemTime: "2026-08-23T12:00:05Z",
                } });
            });
            await page.route("https://streamingsoundtracks.com/images/logos/*", (route) =>
                route.fulfill({ status: 200, contentType: "image/svg+xml",
                    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
            await page.route("https://24covers-api.vercel.app/api/credit?*", (route) => {
                creditRequests++;
                const url = new URL(route.request().url());
                expect(url.searchParams.get("album")).toBe("JFK (2013)");
                expect(url.searchParams.get("url")).toBe(
                    "https://streamingsoundtracks.com/modules.php?name=Album&asin=B00GHJ08XC");
                return route.fulfill({ json: { artist: "Joel Goodman" } });
            });

            await page.goto("/player.html", { waitUntil: "domcontentloaded" });
            const announcement = page.locator("#coming-next");
            await expect(announcement).toHaveClass(/show/);
            await expect(page.locator("#coming-next-album")).toHaveText("JFK (2013)");
            await expect(page.locator("#coming-next-artist")).toHaveText("Joel Goodman");
            expect(creditRequests).toBe(1);

            currentAlbum = "Following Album";
            queueAvailable = false;
            const closing = await page.locator('input[name="station"][value="sst"]')
                .evaluate((input) => {
                    input.dispatchEvent(new Event("change", { bubbles: true }));
                    const card = document.querySelector("#coming-next");
                    return {
                        shown: card.classList.contains("show"),
                        ariaHidden: card.getAttribute("aria-hidden"),
                        album: document.querySelector("#coming-next-album").textContent,
                    };
                });
            // Capture the synchronous closing state in one browser turn: outgoing
            // content stays mounted while opacity and width animate to their exit state.
            expect(closing).toEqual({ shown: false, ariaHidden: "true", album: "JFK (2013)" });
            await expect(page.locator("#coming-next-album")).toHaveText("");
        });
    test("shares a fetched queue credit with backdrop prefetch", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/enriched-next.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/enriched-next.svg";
        const albumUrl = "https://streamingsoundtracks.com/modules.php?name=Album&asin=B00ENRICH";
        let creditRequests = 0, backdropArtist;
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ comingNext: true, sstBackdrops: { enabled: true, options: { providers: ["tmdb"], cover: "show" } } })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [{
                Album: "Enriched Next", Track: "Next Cue", CoverLink: cover,
                SiteLink: albumUrl,
            }] });
            return route.fulfill({ json: {
                Album: "Station ID", Track: "", Artist: "24seven.fm", CoverLink: "",
                Length: 10000, PlayStart: "2026-08-23T12:00:00Z",
                SystemTime: "2026-08-23T12:00:05Z",
            } });
        });
        await page.route("https://streamingsoundtracks.com/images/logos/*", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(sizedCover, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route("https://24covers-api.vercel.app/api/credit?*", (route) => {
            creditRequests++;
            return route.fulfill({ json: { artist: "Enriched Composer" } });
        });
        await page.route(/\/api\/backdrop\?/, (route) => {
            backdropArtist = new URL(route.request().url()).searchParams.get("artist");
            return route.fulfill({ json: {
                media: { id: 77, title: "Enriched Next", type: "movie" },
                backdrop: null, source: null, tint: [255, 255, 255],
            } });
        });

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });

        await expect.poll(() => creditRequests).toBe(1);
        await expect.poll(() => backdropArtist).toBe("Enriched Composer");
        await expect(page.locator("#coming-next-artist")).toHaveText("Enriched Composer");
    });
    test("rechecks queued backdrop art after a transient credit failure", async ({ page }) => {
        let creditRequests = 0;
        const backdropCalls = [];
        await page.addInitScript(() => {
            localStorage.setItem("24sevenfm-covers.player.v2", JSON.stringify({
                sstBackdrops: { enabled: true, options: { providers: ["tmdb"], cover: "show" } },
            }));
            const nativeSetTimeout = window.setTimeout.bind(window);
            window.setTimeout = function (callback, delay) {
                const args = Array.prototype.slice.call(arguments, 2);
                return nativeSetTimeout(callback,
                    delay >= 59000 && delay <= 60000 ? 150 : delay, ...args);
            };
        });
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [
                {
                    Album: "Recovered Credit", Track: "Main Title", Artist: "", CoverLink: "",
                    SiteLink: "https://streamingsoundtracks.com/modules.php?name=Album&asin=B000RECOVER",
                },
                {
                    Album: "Healthy Tail", Track: "End Title", Artist: "Tail Composer",
                    CoverLink: "",
                },
            ] });
            return route.fulfill({ json: {
                Album: "Station ID", Track: "", Artist: "24seven.fm", CoverLink: "",
                Length: 3600000, PlayStart: "2026-08-23T12:00:00Z",
                SystemTime: "2026-08-23T12:00:00Z",
            } });
        });
        await page.route("https://streamingsoundtracks.com/images/logos/*", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route("https://24covers-api.vercel.app/api/credit?*", (route) => {
            creditRequests++;
            if (creditRequests === 1) return route.fulfill({ status: 503, json: {} });
            return route.fulfill({ json: { artist: "Recovered Composer" } });
        });
        await page.route(/\/api\/backdrop\?/, (route) => {
            const url = new URL(route.request().url());
            backdropCalls.push({
                album: url.searchParams.get("album"),
                artist: url.searchParams.get("artist"),
            });
            return route.fulfill({ json: {
                media: { id: 78, title: "Recovered Credit", type: "movie" },
                backdrop: null, source: null, tint: [255, 255, 255],
            } });
        });

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });

        await expect.poll(() => creditRequests).toBe(2);
        await expect.poll(() => backdropCalls).toEqual([
            { album: "Recovered Credit", artist: null },
            { album: "Healthy Tail", artist: "Tail Composer" },
            { album: "Recovered Credit", artist: "Recovered Composer" },
        ]);
    });
    test("disables coming-next motion when reduced motion is requested", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ comingNext: true })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [{
                Album: "Next Album", Track: "Next Cue", Artist: "Next Composer", CoverLink: "",
            }] });
            return route.fulfill({ json: {
                Album: "Current Album", Track: "Current Cue", Artist: "Current Composer",
                CoverLink: "", Length: 10000,
                PlayStart: "2026-08-23T12:00:00Z",
                SystemTime: "2026-08-23T12:00:05Z",
            } });
        });
        await page.route("https://streamingsoundtracks.com/images/logos/*", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        const announcement = page.locator("#coming-next");
        await expect(announcement).toHaveClass(/show/);
        expect(await announcement.evaluate((element) => ({
            durations: getComputedStyle(element).transitionDuration.split(","),
            animations: element.getAnimations().length,
        }))).toEqual({ durations: ["0s"], animations: 0 });
    });
    test("keeps coming next off by default and skips missing-artist enrichment",
        async ({ page }) => {
            let creditRequests = 0;
            await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
                const action = new URL(route.request().url()).searchParams.get("action");
                if (action === "GetQueue") return route.fulfill({ json: [{
                    Album: "Next Album", Track: "Next Cue", CoverLink: "",
                    SiteLink: "https://streamingsoundtracks.com/modules.php?name=Album&asin=B00NEXT",
                }] });
                return route.fulfill({ json: {
                    Album: "Current Album", Track: "Current Cue", Artist: "Current Composer",
                    CoverLink: "", Length: 10000,
                    PlayStart: "2026-08-23T12:00:00Z",
                    SystemTime: "2026-08-23T12:00:05Z",
                } });
            });
            await page.route("https://streamingsoundtracks.com/images/logos/*", (route) =>
                route.fulfill({ status: 200, contentType: "image/svg+xml",
                    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
            await page.route("https://24covers-api.vercel.app/api/credit?*", (route) => {
                creditRequests++;
                return route.fulfill({ json: { artist: "Should not load" } });
            });

            await page.goto("/player.html", { waitUntil: "domcontentloaded" });
            await expect(page.locator("#show-coming-next")).not.toBeChecked();
            await expect(page.locator("#coming-next")).not.toHaveClass(/show/);
            await page.waitForTimeout(250);
            expect(creditRequests).toBe(0);
        });
    test("maps both flip effects to their CSS axes", async ({ page }) => {
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });

        const transforms = await page.locator("#coverbox").evaluate((coverBox) => {
            const card = coverBox.querySelector(".card");
            const back = coverBox.querySelector("img:last-of-type");
            coverBox.dataset.warp = "";
            return ["fliph", "flipv"].map((effect) => {
                coverBox.dataset.fx = effect;
                coverBox.dataset.front = "b";
                return {
                    axis: getComputedStyle(coverBox).getPropertyValue("--flip-transform").trim(),
                    back: getComputedStyle(back).transform,
                    card: getComputedStyle(card).transform
                };
            });
        });

        expect(transforms.map(({ axis }) => axis))
            .toEqual(["rotateY(180deg)", "rotateX(180deg)"]);
        for (const transform of transforms) {
            expect(transform.back).not.toBe("none");
            expect(transform.card).toBe(transform.back);
        }
        expect(transforms[0].card).not.toBe(transforms[1].card);
    });
    test("uses compact master switches and previews the selected transition", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });

        await expect(page.locator('.transition-choice span')).toHaveText([
            "Crossfade", "Flip horizontal", "Flip vertical",
        ]);
        await expect(page.locator('input[name="transition"][value="0"]')).toHaveCount(0);
        await expect(page.locator('input[name="remaining"][value=""]')).toHaveCount(0);
        await expect(page.locator("#transitions-enabled + span")).toHaveText("Transitions");
        await expect(page.locator("#remaining-time-enabled + span"))
            .toHaveText("Remaining time");

        const horizontal = page.locator(
            'label.transition-choice:has(input[value="2"])');
        await horizontal.locator("span").evaluate((element) => {
            window.__transitionPreviewStarts = 0;
            element.addEventListener("animationstart", () => {
                window.__transitionPreviewStarts++;
            });
        });
        await horizontal.click();
        await expect(horizontal.locator("span")).toHaveClass(/preview-flip-horizontal/);
        expect(await horizontal.locator("span").evaluate((element) =>
            element.getAnimations().map((animation) => animation.animationName)))
            .toContain("settings-preview-flip-horizontal");
        await expect.poll(() => page.evaluate(() => window.__transitionPreviewStarts)).toBe(1);
        await horizontal.click();
        await expect.poll(() => page.evaluate(() => window.__transitionPreviewStarts)).toBe(2);
        await expect.poll(() => page.evaluate(() =>
            JSON.parse(localStorage.getItem("24sevenfm-covers.player.v2")).transition))
            .toEqual({ enabled: true, options: { style: 2, durationMs: 1000 } });

        await page.emulateMedia({ reducedMotion: "reduce" });
        const vertical = page.locator('label.transition-choice:has(input[value="3"])');
        await vertical.click();
        expect(await vertical.locator("span").evaluate((element) =>
            element.getAnimations().length)).toBe(0);
    });
    test("binds generated station controls through the option schema", async ({ page }) => {
        await mockProviderTestFeed(page);
        await page.route("https://death.fm/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Station ID", Track: "", Artist: "24seven.fm", CoverLink: "",
                Length: 0, PlayStart: "2026-08-13T12:00:00Z",
                SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route("https://death.fm/images/logos/*", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });

        const stations = page.locator('#stations input[name="station"]');
        await expect(stations).toHaveCount(5);
        expect(await stations.evaluateAll((inputs) =>
            inputs.map((input) => input.dataset.option))).toEqual(Array(5).fill("station"));
        await page.locator('label.seg:has(input[value="death"])').click();
        await expect.poll(() => page.evaluate(() =>
            JSON.parse(localStorage.getItem("24sevenfm-covers.player.v2")).station)).toBe("death");
        await expect(page.locator('input[name="station"][value="death"]')).toBeChecked();
    });
    test("shows the Station tab only for stations with contextual settings", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.route(/https:\/\/(streamingsoundtracks\.com|1980s\.fm|adagio\.fm|death\.fm|entranced\.fm)\/soap\/FM24sevenJSON\.php\?/,
            (route) => {
                const action = new URL(route.request().url()).searchParams.get("action");
                if (action === "GetQueue") return route.fulfill({ json: [] });
                return route.fulfill({ json: {
                    Album: "Station ID", Track: "", Artist: "24seven.fm", CoverLink: "",
                    Length: 0, PlayStart: "2026-08-13T12:00:00Z",
                    SystemTime: "2026-08-13T12:00:00Z",
                } });
            });
        await page.route(/https:\/\/(streamingsoundtracks\.com|1980s\.fm|adagio\.fm|death\.fm|entranced\.fm)\/images\/logos\//,
            (route) => route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });

        const commonTab = page.getByRole("tab", { name: "Common", exact: true });
        const stationTab = page.locator("#settings-tab-station");
        const visualizationsTab = page.getByRole(
            "tab", { name: "Visualizations", exact: true });
        await expect(page.getByRole("tab")).toHaveCount(3);
        await expect(stationTab).toHaveText("SST");
        await expect(commonTab).toHaveAttribute("aria-selected", "true");
        await expect(page.locator("#settings-panel-common")).toBeVisible();
        await expect(page.locator("#settings-panel-station")).toBeHidden();
        await visualizationsTab.focus();
        await visualizationsTab.press("Home");
        await expect(commonTab).toBeFocused();

        await openSettingsTab(page, "Station");
        await expect(page.locator("#station-tab-name")).toHaveText("SST");
        await expect(page.locator("#station-context-sst")).toBeVisible();
        await expect(page.locator("#station-context-1980s")).toBeHidden();
        await page.locator("#backdrops-enabled").check();
        await page.locator("#ratings-enabled").check();
        await page.locator("#rating-us-enabled").uncheck();

        const removal = await page.locator('input[name="station"][value="death"]')
            .evaluate(async (input) => {
                const stationTab = document.querySelector("#settings-tab-station");
                const stationPanel = document.querySelector("#settings-panel-station");
                const commonPanel = document.querySelector("#settings-panel-common");
                input.checked = true;
                input.dispatchEvent(new Event("change", { bubbles: true }));
                await new Promise((resolve) => requestAnimationFrame(() =>
                    requestAnimationFrame(resolve)));
                return {
                    tabHidden: stationTab.hidden,
                    tabExiting: stationTab.classList.contains("tab-exiting"),
                    stationPanelHidden: stationPanel.hidden,
                    stationPanelInert: stationPanel.hasAttribute("inert"),
                    commonPanelHidden: commonPanel.hidden,
                    commonPanelInert: commonPanel.hasAttribute("inert"),
                };
            });
        expect(removal).toEqual({
            tabHidden: false,
            tabExiting: true,
            stationPanelHidden: false,
            stationPanelInert: true,
            commonPanelHidden: false,
            commonPanelInert: false,
        });
        await expect(stationTab).toBeHidden();
        await expect(commonTab).toHaveAttribute("aria-selected", "true");
        await expect(page.locator("#settings-panel-common")).toBeVisible();
        await expect(page.locator("#settings-panel-station")).toBeHidden();
        await expect(page.locator("#station-context-death")).toHaveCount(0);

        await page.locator('label.seg:has(input[name="station"][value="1980s"])').click();
        await expect(stationTab).toBeVisible();
        await expect(stationTab).toHaveText("1980s.FM");
        await openSettingsTab(page, "Station");
        await expect(page.locator("#station-context-1980s")).toBeVisible();
        await expect(stationTab).not.toHaveClass(/tab-entering|tab-exiting/);

        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.locator(
            'label.seg:has(input[name="station"][value="adagio"])').click();
        await expect(stationTab).toBeHidden();
        await expect(page.locator("#settings-panel-common")).toBeVisible();
        await expect(page.locator("#settings-tab-host")).not.toHaveClass(/transitioning/);
        await page.locator('label.seg:has(input[name="station"][value="sst"])').click();
        await expect(stationTab).toBeVisible();
        await openSettingsTab(page, "Station");
        await expect(page.locator("#station-context-sst")).toBeVisible();
        await expect(page.locator("#station-context-host")).not.toHaveClass(/transitioning/);
        await expect(page.locator("#backdrops-enabled")).toBeChecked();
        await expect(page.locator("#ratings-enabled")).toBeChecked();
        await expect(page.locator("#rating-de-enabled")).toBeChecked();
        await expect(page.locator("#rating-us-enabled")).not.toBeChecked();

        await page.setViewportSize({ width: 390, height: 760 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth
            <= document.documentElement.clientWidth)).toBe(true);
    });
    test("binds the fanart personal key through the option schema", async ({ page }) => {
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ fanartKey: "initial-key" })));
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await openBackdropSettings(page);

        const key = page.locator("#fanart-key");
        await expect(key).toHaveAttribute("data-option", "fanartKey");
        await expect(key).toHaveValue("initial-key");
        await key.fill("  updated-key  ");
        await key.dispatchEvent("change");
        await expect(key).toHaveValue("updated-key");
        await expect.poll(() => page.evaluate(() =>
            JSON.parse(localStorage.getItem("24sevenfm-covers.player.v2")).fanartKey))
            .toBe("updated-key");
    });
    test("offers personal-key help below an empty fanart field", async ({ page }) => {
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await openBackdropSettings(page);

        const provider = page.locator('.provider[data-provider="fanart"]');
        const key = provider.locator("#fanart-key");
        const help = provider.locator("#fanart-key-help");
        await expect(help).toBeVisible();
        await expect(help.getByRole("link", { name: "Why?", exact: true }))
            .toHaveAttribute("href", "https://fanart.tv/personal-api-keys/");
        await expect(help.getByRole("link", { name: "Get one", exact: true }))
            .toHaveAttribute("href", "https://fanart.tv/get-an-api-key/");

        const rows = await provider.evaluate((element) => {
            const label = element.querySelector("label").getBoundingClientRect();
            const input = element.querySelector("#fanart-key").getBoundingClientRect();
            const links = element.querySelector("#fanart-key-help").getBoundingClientRect();
            return { labelBottom: label.bottom, inputTop: input.top,
                inputBottom: input.bottom, linksTop: links.top };
        });
        expect(rows.inputTop).toBeGreaterThanOrEqual(rows.labelBottom);
        expect(rows.linksTop).toBeGreaterThanOrEqual(rows.inputBottom);

        await key.fill("personal-key");
        await expect(help).toBeHidden();
        await key.fill("");
        await expect(help).toBeVisible();
    });
    test("checks a fanart personal key directly as a client key", async ({ page }) => {
        await mockProviderTestFeed(page);
        await page.addInitScript(() => {
            const nativeFetch = window.fetch;
            window.fetch = function (input, init) {
                if (String(input).startsWith("https://webservice.fanart.tv/")) {
                    window.fanartKeyCheckFetchOptions = {
                        cache: init.cache,
                        credentials: init.credentials,
                        referrerPolicy: init.referrerPolicy
                    };
                }
                return nativeFetch.call(this, input, init);
            };
        });
        let requestUrl = "";
        let releaseFanartResponse;
        const fanartResponseGate = new Promise((resolve) => { releaseFanartResponse = resolve; });
        await page.route("https://webservice.fanart.tv/v3/movies/27205?*", async (route) => {
            requestUrl = route.request().url();
            await fanartResponseGate;
            await route.fulfill({ json: { name: "Inception", tmdb_id: "27205",
                moviebackground: [] } });
        });
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await openBackdropSettings(page);

        const key = page.locator("#fanart-key");
        const check = page.locator("#fanart-key-check");
        const status = page.locator("#fanart-key-status");
        await expect(check).toBeHidden();

        await key.fill("personal-client-key");
        await expect(check).toBeVisible();
        await expect(check).toHaveText("Check");
        const label = page.locator("#fanart-key-check-label");
        await expect(label).not.toHaveClass(/changing/);
        await key.press("End");
        await key.press("x");
        expect(await label.evaluate((element) => element.classList.contains("changing")))
            .toBe(false);
        const transition = await check.evaluate((element) => ({
            opacity: getComputedStyle(element).transitionProperty.includes("opacity"),
            width: getComputedStyle(element).transitionProperty.includes("max-width")
        }));
        expect(transition).toEqual({ opacity: true, width: true });

        await check.click();
        await expect(check).toBeDisabled();
        await expect(check).toHaveAccessibleName("Checking fanart.tv personal key");
        await expect(check).toHaveText("…");
        releaseFanartResponse();
        await expect(check).toHaveText("✓");
        await expect(check).toHaveClass(/success/);
        await expect(check).toHaveAccessibleName(
            /Recheck fanart\.tv personal key; successfully checked on \d{4}-\d{2}-\d{2}/);
        await expect(status).toContainText("Personal key accepted.");
        await expect.poll(() => page.evaluate(() =>
            JSON.parse(localStorage.getItem("24sevenfm-covers.player.v2")).fanartKeyVerifiedAt))
            .toBeGreaterThan(0);

        const url = new URL(requestUrl);
        expect(url.searchParams.get("client_key")).toBe("personal-client-keyx");
        expect(url.searchParams.has("api_key")).toBe(false);
        expect(await page.evaluate(() => window.fanartKeyCheckFetchOptions)).toEqual({
            cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer"
        });

        await key.fill("changed-client-key");
        await expect(check).toHaveText("Check");
        await expect(check).not.toHaveClass(/success/);
    });
    test("keeps the fanart key check retryable after an API error", async ({ page }) => {
        await mockProviderTestFeed(page);
        let requests = 0;
        await page.route("https://webservice.fanart.tv/v3/movies/27205?*", async (route) => {
            requests++;
            if (requests === 1) {
                return route.fulfill({ status: 401, json: { error: "Invalid client key" } });
            }
            if (requests === 3) return route.abort();
            return route.fulfill({ json: { name: "Inception", tmdb_id: "27205" } });
        });
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await openBackdropSettings(page);

        const key = page.locator("#fanart-key");
        const check = page.locator("#fanart-key-check");
        const status = page.locator("#fanart-key-status");
        await key.fill("invalid-client-key");
        await check.click();
        await expect(check).toBeEnabled();
        await expect(check).toHaveText("Check");
        await expect(status).toBeVisible();
        await expect(status).toHaveText("Personal key not accepted.");
        const transition = await status.evaluate((element) => ({
            opacity: getComputedStyle(element).transitionProperty.includes("opacity"),
            height: getComputedStyle(element).transitionProperty.includes("max-height")
        }));
        expect(transition).toEqual({ opacity: true, height: true });

        await check.click();
        await expect(check).toHaveText("✓");
        await expect(status).toBeHidden();
        expect(requests).toBe(2);

        await key.fill("another-client-key");
        await check.click();
        await expect(status).toBeVisible();
        await expect(status).toHaveText("Couldn’t check the personal key right now.");
        await expect(check).toBeEnabled();
        expect(requests).toBe(3);
    });
    test("restores a checked fanart key without another API request", async ({ page }) => {
        const verifiedAt = Date.UTC(2026, 7, 20, 12, 34, 56);
        await page.addInitScript((saved) => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify(saved)), {
            fanartKey: "persisted-client-key", fanartKeyVerifiedAt: verifiedAt
        });
        await mockProviderTestFeed(page);
        let fanartRequests = 0;
        await page.route("https://webservice.fanart.tv/v3/movies/27205?*", (route) => {
            fanartRequests++;
            if (fanartRequests === 1) return route.abort();
            if (fanartRequests === 2)
                return route.fulfill({ status: 401, json: { error: "Invalid client key" } });
            return route.fulfill({ json: { name: "Inception", tmdb_id: "27205" } });
        });
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await openBackdropSettings(page);

        const key = page.locator("#fanart-key");
        const check = page.locator("#fanart-key-check");
        await expect(key).toHaveValue("persisted-client-key");
        await expect(check).toHaveText("✓");
        await expect(check).toHaveClass(/success/);
        await expect(check).toBeEnabled();
        await expect(check).toHaveAccessibleName(
            "Recheck fanart.tv personal key; successfully checked on 2026-08-20");
        await expect(check).toHaveAttribute("title",
            "Check fanart.tv personal key again; successfully checked on 2026-08-20");
        expect(fanartRequests).toBe(0);

        await check.click();
        await expect(page.locator("#fanart-key-status")).toHaveText(
            "Couldn’t check the personal key right now.");
        await expect(check).toHaveText("✓");
        await expect(check).toBeEnabled();
        expect(await page.evaluate(() =>
            JSON.parse(localStorage.getItem("24sevenfm-covers.player.v2")).fanartKeyVerifiedAt))
            .toBe(verifiedAt);

        await check.click();
        await expect(check).toHaveText("Check");
        await expect.poll(() => page.evaluate(() =>
            JSON.parse(localStorage.getItem("24sevenfm-covers.player.v2")).fanartKeyVerifiedAt))
            .toBe(0);

        await check.click();
        await expect(check).toHaveText("✓");
        await expect.poll(() => page.evaluate(() =>
            JSON.parse(localStorage.getItem("24sevenfm-covers.player.v2")).fanartKeyVerifiedAt))
            .toBeGreaterThan(verifiedAt);
        expect(fanartRequests).toBe(3);

        await key.press("End");
        await key.press("x");
        await key.dispatchEvent("change");
        await expect(check).toHaveText("Check");
        await expect(check).toBeEnabled();
        await expect.poll(() => page.evaluate(() =>
            JSON.parse(localStorage.getItem("24sevenfm-covers.player.v2")).fanartKeyVerifiedAt))
            .toBe(0);
        expect(fanartRequests).toBe(3);
    });
    test("renders a real spectrum while audio plays and respects reduced motion",
        async ({ page }) => {
            await page.addInitScript(() => {
                window.__analyserReads = 0;
                class FakeAudioNode { connect() {} }
                class FakeAnalyser extends FakeAudioNode {
                    constructor() {
                        super();
                        this.frequencyBinCount = 64;
                    }
                    getByteFrequencyData(data) {
                        window.__analyserReads++;
                        data.fill(176);
                    }
                }
                window.AudioContext = class {
                    constructor() {
                        this.destination = {};
                        this.state = "running";
                    }
                    createAnalyser() { return new FakeAnalyser(); }
                    createMediaElementSource() { return new FakeAudioNode(); }
                    resume() { return Promise.resolve(); }
                };
                HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
                HTMLMediaElement.prototype.pause = function () {};
                HTMLMediaElement.prototype.load = function () {};
            });
            await mockProviderTestFeed(page);
            await page.goto("/player.html", { waitUntil: "domcontentloaded" });

            const audio = page.locator("#audio");
            const spectrum = page.locator("#stage-spectrum");
            const spectrumEnabled = page.locator("#spectrum-enabled");
            await expect(audio).toHaveAttribute("crossorigin", "anonymous");
            await expect(spectrum).not.toHaveAttribute("tabindex", /.+/);
            await expect(spectrum).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
            await expect(spectrum).toHaveCSS("border-top-width", "0px");
            const transitions = await spectrum.evaluate((canvas) =>
                getComputedStyle(canvas).transitionProperty.split(", "));
            expect(transitions).toEqual(expect.arrayContaining(["opacity", "width", "height"]));
            await openSettingsTab(page, "Visualizations");
            await spectrumEnabled.check();
            await page.locator("#stage").hover();
            await page.evaluate(() => {
                window.__spectrumAttackSamples = [];
                const canvas = document.querySelector("#stage-spectrum");
                const sample = () => {
                    const data = canvas.getContext("2d")
                        .getImageData(0, 0, canvas.width, canvas.height).data;
                    window.__spectrumAttackSamples.push(
                        data.filter((value, index) => index % 4 === 3 && value).length);
                    if (window.__spectrumAttackSamples.length < 40) requestAnimationFrame(sample);
                };
                requestAnimationFrame(sample);
            });
            await page.locator("#stage-audio").click();
            await audio.dispatchEvent("playing");
            await expect(spectrum).toHaveClass(/active/);
            const filledPixels = () => spectrum.evaluate((canvas) => {
                const data = canvas.getContext("2d")
                    .getImageData(0, 0, canvas.width, canvas.height).data;
                return data.filter((value, index) => index % 4 === 3 && value).length;
            });
            await expect.poll(() => page.evaluate(() => window.__analyserReads))
                .toBeGreaterThan(0);
            await expect.poll(() => spectrum.evaluate((canvas) =>
                canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height)
                    .data.some(Boolean))).toBe(true);
            const rendered = await spectrum.evaluate((canvas) => {
                const context = canvas.getContext("2d");
                const pixels = context
                    .getImageData(0, canvas.height - 1, canvas.width, 1).data;
                let runs = 0, inside = false, first = null;
                for (let x = 0; x < canvas.width; x++) {
                    const offset = x * 4, filled = pixels[offset + 3] > 0;
                    if (filled && !inside) {
                        runs++;
                        if (!first) first = Array.from(pixels.slice(offset, offset + 3));
                    }
                    inside = filled;
                }
                return { runs, first };
            });
            const infoTint = await page.locator(".info").evaluate((info) =>
                getComputedStyle(info).color.match(/[\d.]+/g).slice(0, 3).map(Number));
            expect(rendered.runs).toBe(24);
            expect(rendered.first).toEqual(infoTint);
            const expectSpectrumClearOfInfo = async () => {
                // Fullscreen changes the stage before ResizeObserver has necessarily
                // recomputed the spectrum gap. Require three animation frames with
                // unchanged boxes and no running geometry transition, then assert the
                // exact snapshot that satisfied that condition.
                const boxes = await stableElementRects(page, {
                    stage: "#stage", spectrum: "#stage-spectrum",
                    cover: "#coverbox", info: ".info",
                });
                expect(boxes.spectrum.left).toBeGreaterThanOrEqual(boxes.stage.left);
                expect(boxes.spectrum.top).toBeGreaterThanOrEqual(boxes.stage.top);
                expect(boxes.spectrum.right).toBeLessThanOrEqual(boxes.stage.right);
                expect(boxes.spectrum.bottom).toBeLessThanOrEqual(boxes.stage.bottom);
                const overlapsInfo = !(boxes.spectrum.right <= boxes.info.left
                    || boxes.spectrum.left >= boxes.info.right
                    || boxes.spectrum.bottom <= boxes.info.top
                    || boxes.spectrum.top >= boxes.info.bottom);
                expect(overlapsInfo).toBe(false);
                expect(boxes.spectrum.top).toBeGreaterThanOrEqual(boxes.cover.bottom - 1);
                expect(boxes.spectrum.bottom).toBeLessThanOrEqual(boxes.info.top + 1);
                const spectrumCenter = (boxes.spectrum.left + boxes.spectrum.right) * 0.5;
                const coverCenter = (boxes.cover.left + boxes.cover.right) * 0.5;
                const infoCenter = (boxes.info.left + boxes.info.right) * 0.5;
                expect(Math.abs(boxes.spectrum.width - boxes.cover.width))
                    .toBeLessThanOrEqual(1);
                expect(Math.abs(spectrumCenter - coverCenter)).toBeLessThanOrEqual(1);
                expect(Math.abs(spectrumCenter - infoCenter)).toBeLessThanOrEqual(1);
            };
            await expectSpectrumClearOfInfo();
            await spectrum.click();
            const spectrumOptions = page.locator("#spectrum-options");
            await expect(spectrumOptions).toBeVisible();
            await expect(page.locator("#spectrum-options > #spectrum-settings")).toHaveCount(1);
            await expect(page.locator("#fs-options")).toBeHidden();
            const placement = await page.evaluate(() => {
                const spectrumBox = document.querySelector("#stage-spectrum").getBoundingClientRect();
                const optionsBox = document.querySelector("#spectrum-options").getBoundingClientRect();
                const fieldsetBox = document.querySelector("#spectrum-settings").getBoundingClientRect();
                const legendBox = document.querySelector("#spectrum-settings legend").getBoundingClientRect();
                const stageBox = document.querySelector("#stage").getBoundingClientRect();
                return { gap: optionsBox.left - spectrumBox.right,
                    inside: optionsBox.right <= stageBox.right + 1,
                    legendInside: legendBox.top >= fieldsetBox.top
                        && legendBox.bottom <= fieldsetBox.bottom };
            });
            expect(placement.gap).toBeGreaterThanOrEqual(0);
            expect(placement.gap).toBeLessThanOrEqual(16);
            expect(placement.inside).toBe(true);
            expect(placement.legendInside).toBe(true);
            await spectrum.click();
            await expect(spectrumOptions).toBeHidden();
            await page.locator("#fullscreen").click();
            await expect.poll(() => page.evaluate(() =>
                document.fullscreenElement && document.fullscreenElement.id)).toBe("stage");
            await expectSpectrumClearOfInfo();
            await spectrum.click();
            await expect(spectrumOptions).toBeVisible();
            await expect(page.locator("#spectrum-options > #spectrum-settings")).toHaveCount(1);
            await expect(page.locator("#fs-options")).toBeHidden();
            await page.evaluate(() => document.exitFullscreen());
            await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBe(null);
            await expect(spectrumOptions).toBeHidden();
            await expect(page.locator(
                "#settings-panel-visualizations > #spectrum-settings")).toHaveCount(1);

            await expect(spectrum).toHaveCSS("opacity", "0.92");
            const fullFilled = await filledPixels();
            expect(await page.evaluate((fullCount) =>
                window.__spectrumAttackSamples.some((count) =>
                    count > 0 && count < fullCount), fullFilled)).toBe(true);
            await page.evaluate(() => {
                window.__spectrumReleaseSamples = [];
                const canvas = document.querySelector("#stage-spectrum");
                const sample = () => {
                    const data = canvas.getContext("2d")
                        .getImageData(0, 0, canvas.width, canvas.height).data;
                    window.__spectrumReleaseSamples.push(
                        data.filter((value, index) => index % 4 === 3 && value).length);
                    if (window.__spectrumReleaseSamples.length < 40) requestAnimationFrame(sample);
                };
                requestAnimationFrame(sample);
            });
            await page.locator("#stage-audio").click();
            await expect(spectrum).toHaveClass(/active/);
            await expect(spectrum).toHaveCSS("opacity", "0.92");
            await expect.poll(() => spectrum.evaluate((canvas) =>
                canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height)
                    .data.some(Boolean)), { timeout: 1000 }).toBe(false);
            expect(await page.evaluate((fullCount) =>
                window.__spectrumReleaseSamples.some((count) =>
                    count > 0 && count < fullCount), fullFilled)).toBe(true);
            await expect(spectrum).not.toHaveClass(/active/);
            await page.locator("#stage-audio").click();
            await audio.dispatchEvent("playing");
            await expect(spectrum).toHaveClass(/active/);

            await page.emulateMedia({ reducedMotion: "reduce" });
            await expect(spectrum).not.toHaveClass(/active/);
            await expect(spectrum).toHaveCSS("display", "none");
            await page.locator("#audio-toggle").click();
        });
    test("renders Winamp oscilloscope styles from time-domain audio and crossfades modes",
        async ({ page }) => {
            const pageErrors = [];
            page.on("pageerror", (error) => pageErrors.push(String(error)));
            await page.addInitScript(() => {
                window.__frequencyReads = 0;
                window.__timeDomainReads = 0;
                class FakeAudioNode { connect() {} }
                class FakeAnalyser extends FakeAudioNode {
                    constructor() {
                        super();
                        this.frequencyBinCount = 64;
                    }
                    getByteFrequencyData(data) {
                        window.__frequencyReads++;
                        data.fill(176);
                    }
                    getByteTimeDomainData(data) {
                        window.__timeDomainReads++;
                        for (let index = 0; index < data.length; index++) {
                            data[index] = 128 + Math.round(Math.sin(
                                index * Math.PI * 8 / data.length
                                + window.__timeDomainReads * .08) * 82);
                        }
                    }
                }
                window.AudioContext = class {
                    constructor() {
                        this.destination = {};
                        this.state = "running";
                    }
                    createAnalyser() { return new FakeAnalyser(); }
                    createMediaElementSource() { return new FakeAudioNode(); }
                    resume() { return Promise.resolve(); }
                };
                HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
                HTMLMediaElement.prototype.pause = function () {};
                HTMLMediaElement.prototype.load = function () {};
            });
            await mockProviderTestFeed(page);
            await page.goto("/player.html", { waitUntil: "domcontentloaded" });

            const audio = page.locator("#audio");
            const analyzer = page.locator("#stage-spectrum");
            await openSettingsTab(page, "Visualizations");
            await page.locator("#spectrum-enabled").check();
            await page.locator("#stage-audio").click();
            await audio.dispatchEvent("playing");
            await expect(analyzer).toHaveAttribute("data-analyzer-type", "spectrum");
            await expect.poll(() => page.evaluate(() => window.__frequencyReads))
                .toBeGreaterThan(0);

            await page.locator("label.seg", { hasText: "Oscilloscope" }).click();
            await expect(analyzer).toHaveAttribute("data-mode-transition", "crossfading");
            await expect(analyzer).toHaveAttribute("data-outgoing-analyzer", "spectrum");
            await expect(analyzer).toHaveAttribute("data-analyzer-type", "oscilloscope");
            await expect.poll(() => page.evaluate(() => window.__timeDomainReads))
                .toBeGreaterThan(0);
            await expect(analyzer).toHaveAttribute("data-time-domain-samples", "1024");
            await expect(analyzer).toHaveAttribute("data-oscilloscope-window-samples", "512");
            await expect(analyzer).toHaveAttribute("data-mode-transition", "idle");
            await expect(analyzer).not.toHaveAttribute("data-outgoing-analyzer");

            const scopeBoxes = await stableElementRects(page, {
                scope: "#stage-spectrum", cover: "#coverbox", info: ".info",
            });
            expect(scopeBoxes.scope.height).toBeGreaterThan(48);
            expect(scopeBoxes.scope.top).toBeGreaterThanOrEqual(scopeBoxes.cover.bottom - 1);
            expect(scopeBoxes.scope.bottom).toBeLessThanOrEqual(scopeBoxes.info.top + 1);

            const waveform = await analyzer.evaluate((canvas) => {
                const data = canvas.getContext("2d")
                    .getImageData(0, 0, canvas.width, canvas.height).data;
                const center = Math.floor(canvas.height / 2);
                let above = false, below = false;
                for (let y = 0; y < canvas.height; y++) {
                    for (let x = 0; x < canvas.width; x++) {
                        if (!data[(y * canvas.width + x) * 4 + 3]) continue;
                        if (y < center - 2) above = true;
                        if (y > center + 2) below = true;
                    }
                }
                return { above, below };
            });
            expect(waveform).toEqual({ above: true, below: true });

            await page.locator("label.seg", { hasText: "Dots" }).click();
            await expect(analyzer).toHaveAttribute("data-oscilloscope-style", "dots");
            await expect(analyzer).toHaveAttribute("data-mode-transition", "crossfading");
            await expect(analyzer).toHaveAttribute("data-mode-transition", "idle");
            await page.locator("label.seg", { hasText: "Filled" }).click();
            await expect(analyzer).toHaveAttribute("data-oscilloscope-style", "filled");
            expect(pageErrors).toEqual([]);
        });

    test("renders a shared-analyser MilkDrop scene and crossfades curated presets",
        async ({ page }) => {
            const pageErrors = [];
            page.on("pageerror", (error) => pageErrors.push(String(error)));
            await page.addInitScript(() => {
                window.__milkdropAudioContexts = 0;
                window.__milkdropFrequencyReads = 0;
                window.__milkdropTimeReads = 0;
                class FakeAudioNode { connect() {} }
                class FakeAnalyser extends FakeAudioNode {
                    constructor() {
                        super();
                        this.frequencyBinCount = 128;
                    }
                    getByteFrequencyData(data) {
                        window.__milkdropFrequencyReads++;
                        const beat = window.__milkdropFrequencyReads % 8 === 0;
                        for (let index = 0; index < data.length; index++) {
                            const rolloff = 1 - index / data.length;
                            data[index] = Math.round((beat ? 220 : 84) * rolloff
                                + (index % 7) * 3);
                        }
                    }
                    getByteTimeDomainData(data) {
                        window.__milkdropTimeReads++;
                        for (let index = 0; index < data.length; index++) {
                            data[index] = 128 + Math.round(
                                Math.sin(index * Math.PI * 12 / data.length
                                    + window.__milkdropTimeReads * .1) * 72
                                + Math.sin(index * Math.PI * 5 / data.length) * 18);
                        }
                    }
                }
                window.AudioContext = class {
                    constructor() {
                        window.__milkdropAudioContexts++;
                        this.destination = {};
                        this.state = "running";
                    }
                    createAnalyser() { return new FakeAnalyser(); }
                    createMediaElementSource() { return new FakeAudioNode(); }
                    resume() { return Promise.resolve(); }
                };
                HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
                HTMLMediaElement.prototype.pause = function () {};
                HTMLMediaElement.prototype.load = function () {};
            });
            await page.route("https://1980s.fm/soap/FM24sevenJSON.php?*", (route) => {
                const action = new URL(route.request().url()).searchParams.get("action");
                if (action === "GetQueue") return route.fulfill({ json: [] });
                return route.fulfill({ json: {
                    Album: "MilkDrop Test", Track: "Feedback", Artist: "24seven.fm",
                    CoverLink: "", Length: 0,
                    PlayStart: "2026-08-13T12:00:00Z",
                    SystemTime: "2026-08-13T12:00:00Z",
                } });
            });
            await page.route("https://1980s.fm/images/logos/*", (route) =>
                route.fulfill({ status: 200, contentType: "image/svg+xml",
                    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
            await page.goto("/player.html?station=1980s", { waitUntil: "domcontentloaded" });

            const audio = page.locator("#audio");
            const milkdrop = page.locator("#stage-milkdrop");
            const lasers = page.locator("#stage-lasers");
            const stage = page.locator("#stage");
            await page.locator("#stage-audio").click();
            await audio.dispatchEvent("playing");
            await expect(lasers).toHaveClass(/active/);

            await openSettingsTab(page, "Visualizations");
            await page.locator("#milkdrop-enabled").check();
            await expect(milkdrop).toHaveClass(/active/);
            await expect(stage).toHaveClass(/milkdrop-scene/);
            await expect(lasers).not.toHaveClass(/active/);
            await expect(page.locator("#strobe-enabled")).toBeDisabled();
            await expect(page.locator("#smoke-enabled")).toBeDisabled();
            await expect(milkdrop).toHaveAttribute("data-renderer", "canvas2d-feedback");
            await expect(milkdrop).toHaveAttribute("data-audio-source", "analyser");
            await expect(milkdrop).toHaveAttribute("data-preset", "aurora");
            await expect.poll(() => milkdrop.getAttribute("data-frame")
                .then(Number)).toBeGreaterThan(3);
            await expect.poll(() => milkdrop.evaluate((canvas) =>
                canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height)
                    .data.some(Boolean))).toBe(true);
            expect(await page.evaluate(() => window.__milkdropAudioContexts)).toBe(1);
            await expect.poll(() => page.evaluate(() => window.__milkdropTimeReads))
                .toBeGreaterThan(0);
            await expect.poll(() => milkdrop.getAttribute("data-beat-count")
                .then(Number)).toBeGreaterThan(0);
            await expect.poll(() => milkdrop.getAttribute("data-beat-hue-target")
                .then(Number)).toBeGreaterThan(50);
            const beatHue = await milkdrop.getAttribute("data-beat-hue").then(Number);
            const beatHueTarget = await milkdrop.getAttribute("data-beat-hue-target")
                .then(Number);
            expect(beatHue).toBeGreaterThan(0);
            expect(beatHue).not.toBe(beatHueTarget);

            const readsBefore = await page.evaluate(() => ({
                frequency: window.__milkdropFrequencyReads,
                time: window.__milkdropTimeReads,
            }));
            await page.waitForTimeout(180);
            const readsAfter = await page.evaluate(() => ({
                frequency: window.__milkdropFrequencyReads,
                time: window.__milkdropTimeReads,
            }));
            expect(readsAfter.frequency - readsBefore.frequency)
                .toBe(readsAfter.time - readsBefore.time);

            await page.locator("label.seg", { hasText: "Mandala" }).click();
            await expect(milkdrop).toHaveAttribute("data-preset", "mandala");
            await expect(milkdrop).toHaveAttribute("data-preset-transition", "crossfading");
            await expect(milkdrop).toHaveAttribute("data-outgoing-preset", "aurora");
            await expect(milkdrop).toHaveAttribute("data-preset-transition", "idle");
            await expect(milkdrop).not.toHaveAttribute("data-outgoing-preset");

            await page.locator("#fullscreen").click();
            await expect.poll(() => page.evaluate(() =>
                document.fullscreenElement && document.fullscreenElement.id)).toBe("stage");
            const fullscreenBoxes = await stableElementRects(page, {
                stage: "#stage", milkdrop: "#stage-milkdrop",
            });
            for (const edge of ["top", "right", "bottom", "left"])
                expect(Math.abs(fullscreenBoxes.stage[edge] - fullscreenBoxes.milkdrop[edge]))
                    .toBeLessThanOrEqual(1);
            const renderSize = await milkdrop.evaluate((canvas) => ({
                width: canvas.width, height: canvas.height,
            }));
            expect(renderSize.width).toBeLessThanOrEqual(1280);
            expect(renderSize.height).toBeLessThanOrEqual(720);
            await page.evaluate(() => document.exitFullscreen());

            await page.emulateMedia({ reducedMotion: "reduce" });
            await expect(milkdrop).not.toHaveClass(/active/);
            await expect(milkdrop).toHaveCSS("display", "none");
            await expect(stage).not.toHaveClass(/milkdrop-scene/);
            expect(pageErrors).toEqual([]);
            await page.locator("#audio-toggle").click();
        });

    test("runs the 80s laser plugin from the shared analyser and fades it between stations",
        async ({ page }) => {
            const pageErrors = [];
            page.on("pageerror", (error) => pageErrors.push(String(error)));
            await page.addInitScript(() => {
                window.__analyserReads = 0;
                window.__audioContexts = 0;
                window.__laserKicks = 0;
                class FakeAudioNode { connect() {} }
                class FakeAnalyser extends FakeAudioNode {
                    constructor() {
                        super();
                        this.frequencyBinCount = 128;
                    }
                    getByteFrequencyData(data) {
                        window.__analyserReads++;
                        data.fill(52);
                        const beatPhase = window.__analyserReads % 8;
                        // A primary kick followed roughly 100ms later by a double-hit.
                        if (beatPhase === 0 || beatPhase === 3) {
                            window.__laserKicks++;
                            for (let index = 1; index < Math.floor(data.length * .04); index++)
                                data[index] = 244;
                        }
                        for (let index = Math.floor(data.length * .22); index < data.length; index++)
                            data[index] = 96 + (index % 5) * 16;
                    }
                }
                window.AudioContext = class {
                    constructor() {
                        window.__audioContexts++;
                        this.destination = {};
                        this.state = "running";
                    }
                    createAnalyser() { return new FakeAnalyser(); }
                    createMediaElementSource() { return new FakeAudioNode(); }
                    resume() { return Promise.resolve(); }
                };
                HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
                HTMLMediaElement.prototype.pause = function () {};
                HTMLMediaElement.prototype.load = function () {};
            });
            await mockProviderTestFeed(page);
            await page.route("https://1980s.fm/soap/FM24sevenJSON.php?*", (route) => {
                const action = new URL(route.request().url()).searchParams.get("action");
                if (action === "GetQueue") return route.fulfill({ json: [] });
                return route.fulfill({ json: {
                    Album: "Laser Test", Track: "Neon Nights", Artist: "24seven.fm",
                    CoverLink: "", Length: 0, PlayStart: "2026-08-13T12:00:00Z",
                    SystemTime: "2026-08-13T12:00:00Z",
                } });
            });
            await page.route("https://1980s.fm/images/logos/*", (route) =>
                route.fulfill({ status: 200, contentType: "image/svg+xml",
                    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
            await page.goto("/player.html", { waitUntil: "domcontentloaded" });

            const audio = page.locator("#audio");
            const lasers = page.locator("#stage-lasers");
            const frontLasers = page.locator("#stage-lasers-front");
            const spectrum = page.locator("#stage-spectrum");
            const bpmDisplay = page.locator("#stage-bpm");
            const bpmEnabled = page.locator("#bpm-enabled");
            await expect(page.locator("#laser-enabled")).toBeChecked();
            const strobe = page.locator("#strobe-enabled");
            const station1980s = page.locator("label.seg", { hasText: "1980s.FM" });
            const stationSst = page.locator("label.seg", { hasText: "StreamingSoundtracks" });
            await expect(strobe).not.toBeChecked();
            await station1980s.click();
            await openSettingsTab(page, "Station");
            await expect(strobe).toBeVisible();
            await strobe.check();
            const smoke = page.locator("#smoke-enabled");
            await expect(smoke).not.toBeChecked();
            await stationSst.click();
            await expect(strobe).toBeHidden();
            await page.locator("#audio-toggle").click();
            await audio.dispatchEvent("playing");
            await expect(lasers).not.toHaveClass(/active/);
            expect(await page.evaluate(() => window.__audioContexts)).toBe(0);

            await station1980s.click();
            await audio.dispatchEvent("playing");
            await expect(lasers).toHaveClass(/active/);
            await expect(frontLasers).toHaveClass(/active/);
            await expect(bpmDisplay).not.toHaveClass(/active/);
            await openSettingsTab(page, "Visualizations");
            await bpmEnabled.check();
            await expect(bpmDisplay).toHaveClass(/active/);
            await expect(bpmDisplay).toHaveCSS("opacity", "1");
            await expect(bpmDisplay).toHaveAttribute("aria-hidden", "false");
            await expect(lasers).toHaveCSS("opacity", "1");
            await expect(frontLasers).toHaveCSS("opacity", "1");
            await expect(lasers).toHaveCSS("background-color", "rgb(0, 0, 0)");
            await expect(frontLasers).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
            await expect(page.locator("#stage")).toHaveClass(/laser-scene/);
            await expect(page.locator("#coverbox")).toBeVisible();
            await expect(page.locator("#coverbox")).toHaveCSS("opacity", "1");
            const coverDepthScale = await page.locator("#coverbox").evaluate((cover) =>
                cover.getBoundingClientRect().width / parseFloat(getComputedStyle(cover).width));
            expect(coverDepthScale).toBeCloseTo(.8, 1);
            await expect(lasers).toHaveAttribute("data-renderer", "webgl");
            await expect(lasers).toHaveAttribute("data-rig-origin", "ceiling");
            await expect(lasers).toHaveAttribute("data-landing-spots", "6");
            await expect(lasers).toHaveAttribute("data-strobe-pattern",
                "occasional-double");
            await expect(lasers).toHaveAttribute("data-smoke-pattern",
                "two-front-particle-emitters");
            await expect(lasers).toHaveAttribute("data-smoke-count", "0");
            await openSettingsTab(page, "Station");
            await smoke.check();
            await expect.poll(async () => Number(
                await lasers.getAttribute("data-smoke-count"))).toBeGreaterThan(0);
            await expect(lasers).toHaveAttribute("data-smoke-source", "preview");
            await expect.poll(async () => Number(
                await frontLasers.getAttribute("data-smoke-particles")))
                .toBeGreaterThan(40);
            await expect(lasers).toHaveAttribute("data-gpu-tier", /^(hardware|software)$/);
            await expect(lasers).toHaveAttribute("data-spectrum-bands", "32");
            await expect(lasers).toHaveAttribute("data-audio-source", "spectrum");
            await expect.poll(() => page.evaluate(() => window.__analyserReads))
                .toBeGreaterThan(0);
            await expect(lasers).toHaveClass(/beat/);
            await expect.poll(async () => Number(
                await lasers.getAttribute("data-beat-count"))).toBeGreaterThan(1);
            const beatTelemetry = await page.evaluate(() => ({
                beats: Number(document.querySelector("#stage-lasers").dataset.beatCount) - 1,
                kicks: window.__laserKicks
            }));
            expect(beatTelemetry.beats).toBeGreaterThan(0);
            expect(beatTelemetry.beats).toBeLessThanOrEqual(beatTelemetry.kicks);
            await expect(lasers).toHaveAttribute("data-laser-mode", "beat");
            await expect.poll(async () => Number(
                await lasers.getAttribute("data-beat-accent-count"))).toBeGreaterThan(0);
            await expect.poll(async () => Number(
                await lasers.getAttribute("data-strobe-count")),
            { timeout: 15000 }).toBeGreaterThan(0);
            await expect.poll(async () => Number(
                await frontLasers.getAttribute("data-strobe-painted-frames")),
            { timeout: 15000 }).toBeGreaterThan(0);
            await expect.poll(async () => Number(
                await lasers.getAttribute("data-smoke-count")),
            { timeout: 15000 }).toBeGreaterThan(0);
            await expect.poll(async () => Number(
                await frontLasers.getAttribute("data-smoke-painted-frames")),
            { timeout: 15000 }).toBeGreaterThan(0);
            await expect.poll(async () => Number(
                await lasers.getAttribute("data-bpm"))).toBeGreaterThanOrEqual(80);
            expect(Number(await lasers.getAttribute("data-bpm"))).toBeLessThanOrEqual(160);
            await expect.poll(() => bpmDisplay.evaluate((display) => {
                const bpm = Number(display.dataset.bpm);
                return bpm >= 80 && bpm <= 160
                    && display.querySelector(".stage-bpm-value").textContent === String(bpm)
                    && display.getAttribute("aria-label") === `${bpm} beats per minute`;
            })).toBe(true);
            expect(pageErrors).toEqual([]);
            await expect.poll(() => laserHasPixels(lasers)).toBe(true);
            const renderSurface = await lasers.evaluate((canvas) => ({
                pixels: canvas.width * canvas.height,
                budget: canvas.dataset.gpuTier === "software" ? 180000 : 600000,
                filter: getComputedStyle(canvas).filter,
                blend: getComputedStyle(canvas).mixBlendMode,
                zIndex: getComputedStyle(canvas).zIndex
            }));
            expect(renderSurface.pixels).toBeLessThanOrEqual(renderSurface.budget * 1.01);
            expect(renderSurface.filter).toBe("none");
            expect(renderSurface.blend).toBe("normal");
            expect(renderSurface.zIndex).toBe("1");
            await expect(frontLasers).toHaveCSS("z-index", "2");
            const geometry = await page.evaluate(() => {
                const rect = (selector) =>
                    document.querySelector(selector).getBoundingClientRect().toJSON();
                return { stage: rect("#stage"), lasers: rect("#stage-lasers") };
            });
            expect(geometry.lasers.x).toBeGreaterThanOrEqual(geometry.stage.x);
            expect(geometry.lasers.y).toBeGreaterThanOrEqual(geometry.stage.y);
            expect(geometry.lasers.x + geometry.lasers.width)
                .toBeLessThanOrEqual(geometry.stage.x + geometry.stage.width);
            expect(geometry.lasers.y + geometry.lasers.height)
                .toBeLessThanOrEqual(geometry.stage.y + geometry.stage.height);
            expect(geometry.lasers.width).toBeGreaterThan(geometry.stage.width - 3);
            expect(geometry.lasers.height).toBeGreaterThan(geometry.stage.height - 3);
            // Foreground beams fade to transparent at each pose boundary, so use the
            // monotonic paint count rather than racing a single transient frame.
            await expect.poll(async () => Number(await frontLasers
                .getAttribute("data-front-painted-frames")),
            { timeout: 15000 }).toBeGreaterThan(0);

            await openSettingsTab(page, "Visualizations");
            await page.locator("#spectrum-enabled").check();
            await expect(spectrum).toHaveClass(/active/);
            expect(await page.evaluate(() => window.__audioContexts)).toBe(1);
            const spectrumCoverWidthDelta = () => page.evaluate(() => {
                const spectrumBox = document.querySelector("#stage-spectrum")
                    .getBoundingClientRect();
                const coverBox = document.querySelector("#coverbox").getBoundingClientRect();
                return Math.abs(spectrumBox.width - coverBox.width);
            });
            await expect.poll(spectrumCoverWidthDelta).toBeLessThanOrEqual(1);

            const releaseStartedWhileMounted = await page.locator("label.seg",
                { hasText: "StreamingSoundtracks" }).evaluate((label) => {
                    label.click();
                    return document.querySelector("#stage-lasers").classList.contains("active");
                });
            // The outgoing plugin stays mounted while its 400ms envelope releases.
            expect(releaseStartedWhileMounted).toBe(true);
            await audio.dispatchEvent("playing");
            await expect(spectrum).toHaveClass(/active/);
            await expect(lasers).not.toHaveClass(/active/);
            await expect(frontLasers).not.toHaveClass(/active/);
            await expect(bpmDisplay).toHaveClass(/active/);
            await expect(bpmDisplay).toHaveCSS("opacity", "1");
            await expect(bpmDisplay).toHaveAttribute("aria-hidden", "false");
            await expect(page.locator("#stage")).not.toHaveClass(/laser-scene/);
            await expect.poll(spectrumCoverWidthDelta).toBeLessThanOrEqual(1);
            await expect.poll(() => laserHasPixels(lasers)).toBe(false);
            await expect.poll(() => laserHasPixels(frontLasers)).toBe(false);

            const bpmReleaseStartedWhileMounted = await bpmEnabled.evaluate((input) => {
                input.click();
                return document.querySelector("#stage-bpm").classList.contains("active");
            });
            expect(bpmReleaseStartedWhileMounted).toBe(true);
            await expect(bpmDisplay).not.toHaveClass(/active/);
            await expect(bpmDisplay).toHaveCSS("opacity", "0");
            await expect(bpmDisplay).toHaveAttribute("aria-hidden", "true");

            await page.emulateMedia({ reducedMotion: "reduce" });
            await expect(lasers).toHaveCSS("display", "none");
            await expect(frontLasers).toHaveCSS("display", "none");
            await page.locator("#audio-toggle").click();
        });
    test("shows an ambient 80s laser fallback when Web Audio is unavailable",
        async ({ page }) => {
            await page.addInitScript(() => {
                Object.defineProperty(window, "AudioContext",
                    { configurable: true, value: undefined });
                Object.defineProperty(window, "webkitAudioContext",
                    { configurable: true, value: undefined });
                HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
                HTMLMediaElement.prototype.pause = function () {};
                HTMLMediaElement.prototype.load = function () {};
            });
            await page.route("https://1980s.fm/soap/FM24sevenJSON.php?*", (route) => {
                const action = new URL(route.request().url()).searchParams.get("action");
                if (action === "GetQueue") return route.fulfill({ json: [] });
                return route.fulfill({ json: {
                    Album: "Ambient Laser Test", Track: "", Artist: "24seven.fm",
                    CoverLink: "", Length: 0, PlayStart: "2026-08-13T12:00:00Z",
                    SystemTime: "2026-08-13T12:00:00Z",
                } });
            });
            await page.route("https://1980s.fm/images/logos/*", (route) =>
                route.fulfill({ status: 200, contentType: "image/svg+xml",
                    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
            await page.goto("/player.html?station=1980s", { waitUntil: "domcontentloaded" });

            const audio = page.locator("#audio");
            const lasers = page.locator("#stage-lasers");
            const bpmDisplay = page.locator("#stage-bpm");
            await openSettingsTab(page, "Visualizations");
            await page.locator("#bpm-enabled").check();
            await page.locator("#audio-toggle").click();
            await audio.dispatchEvent("playing");
            await expect(lasers).toHaveClass(/active/);
            await expect(lasers).toHaveAttribute("data-renderer", "webgl");
            await expect(lasers).toHaveAttribute("data-audio-source", "ambient");
            await expect(lasers).toHaveAttribute("data-laser-mode", "calm");
            await expect(lasers).toHaveAttribute("data-bpm", "");
            await expect(bpmDisplay).toHaveClass(/active/);
            await expect(bpmDisplay).toHaveAttribute("data-bpm", "");
            await expect(bpmDisplay.locator(".stage-bpm-value")).toHaveText("—");
            await expect(bpmDisplay).toHaveAttribute("aria-label", "Estimating tempo");
            await expect.poll(() => laserHasPixels(lasers)).toBe(true);
            expect(await page.evaluate(() => typeof window.AudioContext)).toBe("undefined");
            await page.locator("#audio-toggle").click();
            await expect(lasers).not.toHaveClass(/active/);
        });
    test("shows a grayscale station image without treating a backend error as a station ID", async ({ page }) => {
        let logoRequested = false, pollRequests = 0;
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            pollRequests++;
            return route.fulfill({ json: { error: "Could not connect to DB server." } });
        });
        await page.route("https://streamingsoundtracks.com/images/logos/*", (route) => {
            logoRequested = true;
            return route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="red"/></svg>' });
        });

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });

        const retryPattern = /Station not responding\s+Retrying in (?:\d+ seconds?|1 minute)…/;
        await expect(page.locator("#status")).toHaveText(retryPattern);
        const coverStatus = page.locator("#stage-status");
        await expect(coverStatus).toBeVisible();
        await expect(coverStatus).toHaveText(retryPattern);
        expect(await coverStatus.evaluate((element) =>
            getComputedStyle(element).transitionProperty.split(", ")))
            .toEqual(expect.arrayContaining(["opacity", "visibility"]));
        expect(await coverStatus.evaluate((el) => el.parentElement.id)).toBe("coverbox");
        await page.locator("#fullscreen").click();
        await expect.poll(() => page.evaluate(() =>
            document.fullscreenElement && document.fullscreenElement.id)).toBe("stage");
        await expect(coverStatus).toBeVisible();
        await expect(coverStatus).toHaveText(retryPattern);
        const coverBox = page.locator("#coverbox");
        await expect(coverBox).toHaveClass(/station-outage/);
        await expect(coverBox).toHaveAttribute("data-front", /[ab]/);
        const front = page.locator(
            '.coverbox[data-front="a"] img:first-of-type, .coverbox[data-front="b"] img:last-of-type');
        await expect(front).toHaveAttribute("src", /streamingsoundtracks\.com\/images\/logos\//);
        expect(await front.evaluate((img) => getComputedStyle(img).filter)).toContain("grayscale(1)");
        await expect.poll(() => pollRequests, { timeout: 10000 }).toBe(2);
        await expect(page.locator("#info-title")).toHaveText("Loading…");
        expect(logoRequested).toBe(true);
    });
    test("rejects a CoverLink outside the selected station", async ({ page }) => {
        const hostile = "https://example.invalid/private-cover.jpg";
        let hostileRequested = false;
        page.on("request", (r) => { if (r.url() === hostile) hostileRequested = true; });
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", async (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Station ID", Track: "", Artist: "24seven.fm",
                CoverLink: hostile, Length: 0,
                PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route("https://streamingsoundtracks.com/images/logos/*", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));

        await page.goto("/player.html");
        const front = page.locator(
            '.coverbox[data-front="a"] img:first-of-type, .coverbox[data-front="b"] img:last-of-type');
        await expect(front).toHaveAttribute("src", /streamingsoundtracks\.com\/images\/logos\//);
        expect(hostileRequested).toBe(false);
    });

    test("blocks a trusted cover URL from redirecting off the image allowlist", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/redirect.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/redirect.svg";
        let coverRequested = false, redirectRequested = false;
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) =>
            route.fulfill({ json: {
                Album: "Redirect test", Track: "", Artist: "24seven.fm",
                CoverLink: cover, Length: 0,
                PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
            } }));
        await page.route(sizedCover, (route) => {
            coverRequested = true;
            return route.fulfill({ status: 302, headers: { location: "https://example.com/escaped.svg" } });
        });
        await page.route("https://example.com/**", (route) => {
            redirectRequested = true;
            return route.abort();
        });

        await page.goto("/player.html");
        await expect.poll(() => coverRequested).toBe(true);
        await page.waitForTimeout(100);
        expect(redirectRequested).toBe(false);
    });
    test("normalizes primitive text fields from the station feed", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/primitive-text.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/primitive-text.svg";
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: 2026, Track: false, Artist: 24,
                CoverLink: cover, Length: 0,
                PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route(sizedCover, (route) => route.fulfill({
            status: 200, contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
        }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect(page.locator("#info-title")).toHaveText("2026 - false");
        await expect(page.locator("#info-artist")).toHaveText("24");
        await expect(page.locator("#status")).toHaveText("");
        const front = page.locator(
            '.coverbox[data-front="a"] img:first-of-type, .coverbox[data-front="b"] img:last-of-type');
        await expect(front).toHaveAttribute("src", sizedCover);
    });

    test("retries a cover after a transient image load failure", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/retry-cover.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/retry-cover.svg";
        let coverRequests = 0;
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Retry Cover", Track: "", Artist: "24seven.fm",
                CoverLink: cover, Length: 0,
                PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route(sizedCover, (route) => {
            coverRequests++;
            if (coverRequests === 1) return route.abort();
            return route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' });
        });

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect.poll(() => coverRequests, { timeout: 10000 }).toBe(2);
        const front = page.locator(
            '.coverbox[data-front="a"] img:first-of-type, .coverbox[data-front="b"] img:last-of-type');
        await expect(front).toHaveAttribute("src", sizedCover);
        await expect.poll(() => front.evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
    });
    virtualClockTest("retries a stalled cover before a long track ends", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/stalled.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/stalled.svg";
        let coverRequests = 0;
        await page.clock.install();
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Stalled Cover", Track: "", Artist: "24seven.fm",
                CoverLink: cover, Length: 300000,
                PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route(sizedCover, (route) => {
            coverRequests++;
            if (coverRequests === 1) return;
            return route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' });
        });

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect.poll(() => coverRequests).toBe(1);
        await page.clock.fastForward(20001);
        await expect.poll(() => coverRequests).toBe(1);
        await page.clock.fastForward(5001);
        await expect.poll(() => coverRequests).toBe(2);
        const front = page.locator(
            '.coverbox[data-front="a"] img:first-of-type, .coverbox[data-front="b"] img:last-of-type');
        await expect(front).toHaveAttribute("src", sizedCover);
    });
    virtualClockTest("bounds retries for a permanently missing cover", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/missing.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/missing.svg";
        let coverRequests = 0;
        await page.clock.install();
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Missing Cover", Track: "", Artist: "24seven.fm",
                CoverLink: cover, Length: 3600000,
                PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route(sizedCover, (route) => {
            coverRequests++;
            return route.abort();
        });

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect.poll(() => coverRequests).toBe(1);

        for (const [index, delay] of [5001, 10001, 20001].entries()) {
            await page.clock.fastForward(delay);
            await expect.poll(() => coverRequests).toBe(index + 2);
        }

        await page.clock.fastForward(60001);
        await expect.poll(() => coverRequests).toBe(4);
    });
    virtualClockTest("probes an exhausted cover again after a recovery cooldown", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/recovering.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/recovering.svg";
        let coverRequests = 0;
        await page.clock.install();
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Recovering Cover", Track: "", Artist: "24seven.fm",
                CoverLink: cover, Length: 3600000,
                PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route(sizedCover, (route) => {
            coverRequests++;
            if (coverRequests <= 4) return route.abort();
            return route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' });
        });

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect.poll(() => coverRequests).toBe(1);
        for (const [index, delay] of [5001, 10001, 20001].entries()) {
            await page.clock.fastForward(delay);
            await expect.poll(() => coverRequests).toBe(index + 2);
        }

        await page.clock.fastForward(300001);
        await expect.poll(() => coverRequests).toBe(5);
        const front = page.locator(
            '.coverbox[data-front="a"] img:first-of-type, .coverbox[data-front="b"] img:last-of-type');
        await expect(front).toHaveAttribute("src", sizedCover);
    });
    virtualClockTest("keeps the cover retry budget across short polls", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/short-poll.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/short-poll.svg";
        let coverRequests = 0, pollRequests = 0, queueRequests = 0;
        await page.clock.install();
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") {
                queueRequests++;
                return route.fulfill({ json: [] });
            }
            pollRequests++;
            return route.fulfill({ json: {
                Album: "Unknown Length", Track: "", Artist: "24seven.fm",
                CoverLink: cover, Length: 0,
                PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route(sizedCover, (route) => {
            coverRequests++;
            return route.abort();
        });

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect.poll(() => coverRequests).toBe(1);
        await expect.poll(() => pollRequests).toBe(1);
        await expect.poll(() => queueRequests).toBe(1);

        for (let i = 1; i <= 10; i++) {
            await page.clock.fastForward(6001);
            await expect.poll(() => pollRequests).toBe(i + 1);
            // Boundary/watchdog polls only refresh queue order after a confirmed
            // track change; an unchanged unknown-length track keeps its snapshot.
            expect(queueRequests).toBe(1);
        }
        await expect.poll(() => coverRequests).toBe(4);
    });
    test("honors reduced-motion changes before the next cover", async ({ page }) => {
        const sstCover = "https://streamingsoundtracks.com/images/cover/motion-sst.svg";
        const deathCover = "https://death.fm/images/cover/motion-death.svg";
        await page.emulateMedia({ reducedMotion: "no-preference" });

        async function mockStation(host, album, cover) {
            await page.route(`https://${host}/soap/FM24sevenJSON.php?*`, (route) => {
                const action = new URL(route.request().url()).searchParams.get("action");
                if (action === "GetQueue") return route.fulfill({ json: [] });
                return route.fulfill({ json: {
                    Album: album, Track: "", Artist: "24seven.fm",
                    CoverLink: cover, Length: 3600000,
                    PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
                } });
            });
        }

        await mockStation("streamingsoundtracks.com", "SST motion", sstCover);
        await mockStation("death.fm", "Death motion", deathCover);
        await page.route(/^https:\/\/(?:streamingsoundtracks\.com|death\.fm)\/images\/cover\/500\/motion-.*\.svg$/,
            (route) => route.fulfill({ contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>' }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        const coverBox = page.locator("#coverbox");
        await expect(coverBox).toHaveAttribute("data-fx", "fade");

        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.locator("label.seg", { hasText: "Death.FM" }).click();
        await expect(page.locator("#info-title")).toContainText("Death motion");
        await expect(coverBox).toHaveAttribute("data-fx", "none");
    });
    test("ignores a cover that finishes after a station switch", async ({ page }) => {
        const slowCover = "https://streamingsoundtracks.com/images/cover/slow.svg";
        const slowSized = "https://streamingsoundtracks.com/images/cover/500/slow.svg";
        const fastCover = "https://death.fm/images/cover/fast.svg";
        const fastSized = "https://death.fm/images/cover/500/fast.svg";
        let slowRoute = null;
        await page.route(/https:\/\/(streamingsoundtracks\.com|death\.fm)\/soap\/FM24sevenJSON\.php\?/, (route) => {
            const url = new URL(route.request().url());
            if (url.searchParams.get("action") === "GetQueue") return route.fulfill({ json: [] });
            const isDeath = url.hostname === "death.fm";
            return route.fulfill({ json: {
                Album: isDeath ? "Fast" : "Slow", Track: "", Artist: "24seven.fm",
                CoverLink: isDeath ? fastCover : slowCover, Length: 0,
                PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route(slowSized, (route) => { slowRoute = route; });
        await page.route(fastSized, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect.poll(() => !!slowRoute).toBe(true);
        await page.locator("label.seg", { hasText: "Death.FM" }).click();
        const front = page.locator(
            '.coverbox[data-front="a"] img:first-of-type, .coverbox[data-front="b"] img:last-of-type');
        await expect(front).toHaveAttribute("src", fastSized);

        await slowRoute.fulfill({ status: 200, contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' });
        await page.waitForTimeout(100);
        await expect(front).toHaveAttribute("src", fastSized);
    });

    test("keeps a hidden SST cover suppressed until the next station cover is ready", async ({ page }) => {
        const sstCover = "https://streamingsoundtracks.com/images/cover/hidden-sst.svg";
        const sstSized = "https://streamingsoundtracks.com/images/cover/500/hidden-sst.svg";
        const deathCover = "https://death.fm/images/cover/hidden-death.svg";
        const deathSized = "https://death.fm/images/cover/500/hidden-death.svg";
        const movieBackdrop = "https://image.tmdb.org/t/p/w1280/hidden-sst.jpg";
        let deathImageRoute = null;

        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ sstBackdrops: { enabled: true, options: { providers: ["tmdb"], cover: "hide" } } })));
        await page.route(/https:\/\/(streamingsoundtracks\.com|death\.fm)\/soap\/FM24sevenJSON\.php\?/, (route) => {
            const url = new URL(route.request().url());
            if (url.searchParams.get("action") === "GetQueue") return route.fulfill({ json: [] });
            const isDeath = url.hostname === "death.fm";
            return route.fulfill({ json: {
                Album: isDeath ? "Death album" : "SST movie", Track: "", Artist: "24seven.fm",
                CoverLink: isDeath ? deathCover : sstCover, Length: 0,
                PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route(sstSized, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(deathSized, (route) => { deathImageRoute = route; });
        await page.route(/\/api\/tint\?/, (route) => route.fulfill({ json: { tint: [20, 40, 60] } }));
        await page.route(/\/api\/backdrop\?/, (route) => route.fulfill({ json: {
            media: { id: 1, title: "SST movie", type: "movie" },
            backdrop: movieBackdrop, source: "tmdb", tint: [100, 120, 140],
        } }));
        await page.route(movieBackdrop, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"/>' }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        const stage = page.locator("#stage");
        const front = page.locator(
            '.coverbox[data-front="a"] img:first-of-type, .coverbox[data-front="b"] img:last-of-type');
        await expect(stage).toHaveClass(/no-cover/);
        await expect(front).toHaveAttribute("src", sstSized);

        await page.locator("label.seg", { hasText: "Death.FM" }).click();
        await expect.poll(() => !!deathImageRoute).toBe(true);
        await expect(stage).toHaveClass(/no-cover/);
        await expect(front).toHaveAttribute("src", sstSized);
        await expect(page.locator("#coverbox")).toHaveCSS("opacity", "0");

        await deathImageRoute.fulfill({ status: 200, contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' });
        await expect(front).toHaveAttribute("src", deathSized);
        await expect(stage).not.toHaveClass(/no-cover/);
    });

    test("keeps an outgoing hidden cover suppressed until the next track cover is ready",
        async ({ page }) => {
            const oldCover = "https://streamingsoundtracks.com/images/cover/hidden-old.svg";
            const oldSized = "https://streamingsoundtracks.com/images/cover/500/hidden-old.svg";
            const nextCover = "https://streamingsoundtracks.com/images/cover/hidden-next.svg";
            const nextSized = "https://streamingsoundtracks.com/images/cover/500/hidden-next.svg";
            const oldBackdrop = "https://image.tmdb.org/t/p/w1280/hidden-old.jpg";
            let current = {
                Album: "Old backdrop movie", Track: "Finale", Artist: "Old Composer",
                CoverLink: oldCover, Length: 180000,
                PlayStart: "2026-08-24T12:00:00Z", SystemTime: "2026-08-24T12:00:00Z",
            };
            let nextImageRoute = null;
            const resolverAlbums = [];

            await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
                JSON.stringify({ sstBackdrops: { enabled: true, options: { providers: ["tmdb"], cover: "hide" } } })));
            await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
                const action = new URL(route.request().url()).searchParams.get("action");
                if (action === "GetQueue") return route.fulfill({ json: [{
                    Album: "Next without backdrop", Track: "Opening", Artist: "Next Composer",
                    CoverLink: nextCover,
                }] });
                return route.fulfill({ json: current });
            });
            await page.route(oldSized, (route) => route.fulfill({ status: 200,
                contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
            await page.route(nextSized, (route) => { nextImageRoute = route; });
            await page.route(/\/api\/tint\?/, (route) =>
                route.fulfill({ json: { tint: [20, 40, 60] } }));
            await page.route(/\/api\/backdrop\?/, (route) => {
                const album = new URL(route.request().url()).searchParams.get("album");
                resolverAlbums.push(album);
                return route.fulfill({ json: album === "Old backdrop movie" ? {
                    media: { id: 1, title: album, type: "movie" },
                    backdrop: oldBackdrop, source: "tmdb", tint: [100, 120, 140],
                } : {
                    media: null, backdrop: null, source: null, tint: [255, 255, 255],
                } });
            });
            await page.route(oldBackdrop, (route) => route.fulfill({ status: 200,
                contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"/>' }));

            await page.goto("/player.html", { waitUntil: "domcontentloaded" });
            const stage = page.locator("#stage");
            const front = page.locator(
                '.coverbox[data-front="a"] img:first-of-type, .coverbox[data-front="b"] img:last-of-type');
            await expect(stage).toHaveClass(/no-cover/);
            await expect(front).toHaveAttribute("src", oldSized);
            await expect.poll(() => resolverAlbums).toContain("Next without backdrop");
            await expect.poll(() => !!nextImageRoute).toBe(true);

            current = {
                Album: "Next without backdrop", Track: "Opening", Artist: "Next Composer",
                CoverLink: nextCover, Length: 180000,
                PlayStart: "2026-08-24T12:03:00Z", SystemTime: "2026-08-24T12:03:00Z",
            };
            await page.waitForTimeout(2100);
            await page.evaluate(() => window.dispatchEvent(new Event("focus")));
            await expect(page.locator("#info-title")).toContainText("Next without backdrop");
            await expect(page.locator("#movieA.show, #movieB.show")).toHaveCount(0);
            await expect(stage).toHaveClass(/no-cover/);
            await expect(front).toHaveAttribute("src", oldSized);
            await expect(page.locator("#coverbox")).toHaveCSS("opacity", "0");

            await nextImageRoute.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' });
            await expect(front).toHaveAttribute("src", nextSized);
            await expect(stage).not.toHaveClass(/no-cover/);
        });

    test("logs the raw backdrop resolver result on localhost", async ({ page }) => {
        test.skip(!localMode, "localhost-only diagnostics must stay disabled in production");
        const logs = [];
        page.on("console", async (message) => {
            if (message.type() !== "info"
                    || !message.text().startsWith("[backdrop resolver]")) return;
            logs.push(await Promise.all(message.args().map((argument) => argument.jsonValue())));
        });
        await page.addInitScript(() => localStorage.setItem(
            "24sevenfm-covers.player.v2", JSON.stringify({
                sstBackdrops: { enabled: true,
                    options: { providers: ["tmdb"], cover: "show" } },
            })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*",
            (route) => {
                const action = new URL(route.request().url()).searchParams.get("action");
                if (action === "GetQueue") return route.fulfill({ json: [] });
                return route.fulfill({ json: {
                    Album: "Tvpopmuzik", Track: "Regency Punk", Artist: "Daniel Pemberton",
                    CoverLink: "https://streamingsoundtracks.com/images/cover/tvpopmuzik.svg",
                    Length: 180000, PlayStart: "2026-08-27T12:00:00Z",
                    SystemTime: "2026-08-27T12:00:00Z",
                } });
            });
        await page.route("https://streamingsoundtracks.com/images/cover/500/tvpopmuzik.svg",
            (route) => route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/tint\?/, (route) =>
            route.fulfill({ json: { tint: [255, 255, 255] } }));
        let resolverRequests = 0;
        await page.route(/\/api\/backdrop\?/, (route) => {
            resolverRequests++;
            return route.fulfill({ json: {
            media: null, backdrop: null, source: null, tint: [255, 255, 255],
            certifications: [],
            } });
        });

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect.poll(() => resolverRequests).toBe(1);
        await expect.poll(() => logs.length).toBe(1);
        expect(logs[0]).toEqual([
            "[backdrop resolver]",
            {
                request: {
                    album: "Tvpopmuzik",
                    track: "Regency Punk",
                    artist: "Daniel Pemberton",
                    providers: ["tmdb"],
                    includeArt: true,
                    includeRatings: false,
                },
                result: {
                    media: null, backdrop: null, source: null, tint: [255, 255, 255],
                    certifications: [],
                },
            },
        ]);
    });

    test("aborts a resolver result when the backdrop master switch is disabled", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/race.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/race.svg";
        let backdropRequested = false;
        await page.addInitScript(() => {
            localStorage.setItem("24sevenfm-covers.player.v2", JSON.stringify({
                sstBackdrops: { enabled: true, options: { providers: ["fanart", "tmdb", "steamgriddb"], cover: "show" } },
                fanartKey: "fanart-race-key",
            }));
            window.__resolverStarted = false;
            window.__resolverAborted = false;
            const nativeFetch = window.fetch;
            window.fetch = function (url, init) {
                if (String(url).includes("/api/backdrop?")) {
                    window.__resolverStarted = true;
                    return new Promise((resolve, reject) => {
                        const abort = () => {
                            window.__resolverAborted = true;
                            reject(new DOMException("Aborted", "AbortError"));
                        };
                        const signal = init && init.signal;
                        if (signal && signal.aborted) abort();
                        else if (signal) signal.addEventListener("abort", abort, { once: true });
                    });
                }
                return nativeFetch.apply(this, arguments);
            };
        });
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Slow Movie", Track: "", Artist: "24seven.fm",
                CoverLink: cover, Length: 0,
                PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route(sizedCover, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route("https://image.tmdb.org/t/p/w1280/slow.jpg", (route) => {
            backdropRequested = true;
            return route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' });
        });

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect.poll(() => page.evaluate(() => window.__resolverStarted)).toBe(true);
        await openSettingsTab(page, "Station");
        await page.locator("#backdrops-enabled").uncheck();
        await expect.poll(() => page.evaluate(() => window.__resolverAborted)).toBe(true);
        await expect(page.locator("#fanart-on")).toBeChecked();
        await expect(page.locator("#tmdbart-on")).toBeChecked();
        await expect(page.locator("#steamgriddb-on")).toBeChecked();
        await expect.poll(() => page.evaluate(() =>
            JSON.parse(localStorage.getItem("24sevenfm-covers.player.v2")).sstBackdrops))
            .toEqual({ enabled: false, options: {
                providers: ["fanart", "tmdb", "steamgriddb"], cover: "show" } });
        await page.waitForTimeout(100);
        expect(backdropRequested).toBe(false);
        await expect(page.locator("#movieA.show, #movieB.show")).toHaveCount(0);
    });
    test("hides and restores a backdrop without waiting for a ratings-only request",
        async ({ page }) => {
            const cover = "https://streamingsoundtracks.com/images/cover/toggle-backdrop.svg";
            let resolverRequests = 0, releaseRatingsRequest;
            const ratingsRequestMayFinish = new Promise((resolve) => {
                releaseRatingsRequest = resolve;
            });
            await page.addInitScript(() => localStorage.setItem(
                "24sevenfm-covers.player.v2", JSON.stringify({
                    sstBackdrops: { enabled: true,
                        options: { providers: ["tmdb"], cover: "hide" } },
                    sstRatings: { enabled: true, options: { countries: ["DE"] } },
                })));
            await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*",
                (route) => {
                    const action = new URL(route.request().url()).searchParams.get("action");
                    if (action === "GetQueue") return route.fulfill({ json: [] });
                    return route.fulfill({ json: {
                        Album: "Toggle Backdrop Movie", Track: "Main Cue",
                        Artist: "Toggle Composer", CoverLink: cover, Length: 0,
                        PlayStart: "2026-08-25T12:00:00Z",
                        SystemTime: "2026-08-25T12:00:00Z",
                    } });
                });
            await page.route("https://streamingsoundtracks.com/images/cover/500/toggle-backdrop.svg",
                (route) => route.fulfill({ status: 200, contentType: "image/svg+xml",
                    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
            await page.route(/\/api\/tint\?/, (route) =>
                route.fulfill({ json: { tint: [40, 50, 60] } }));
            await page.route(/\/api\/backdrop\?/, async (route) => {
                resolverRequests++;
                if (resolverRequests > 1) {
                    await ratingsRequestMayFinish;
                    try { return await route.fulfill({ json: { backdrop: null,
                        certifications: [] } }); } catch (error) { return; }
                }
                return route.fulfill({ json: {
                    backdrop: "https://image.tmdb.org/t/p/w1280/toggle-backdrop.jpg",
                    source: "tmdb", tint: [70, 80, 90], certifications: [],
                } });
            });
            await page.route("https://image.tmdb.org/t/p/w1280/toggle-backdrop.jpg",
                (route) => route.fulfill({ status: 200, contentType: "image/svg+xml",
                    body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"/>' }));

            await page.goto("/player.html", { waitUntil: "domcontentloaded" });
            const visibleBackdrop = page.locator("#movieA.show, #movieB.show");
            await expect(visibleBackdrop).toHaveCount(1);
            await openSettingsTab(page, "Station");
            const master = page.locator("#backdrops-enabled");
            expect(await master.evaluate((input) => {
                input.checked = false;
                input.dispatchEvent(new Event("change", { bubbles: true }));
                return document.querySelectorAll("#movieA.show, #movieB.show").length;
            })).toBe(0);
            await expect.poll(() => resolverRequests).toBeGreaterThan(1);

            const showStarted = Date.now();
            await master.evaluate((input) => {
                input.checked = true;
                input.dispatchEvent(new Event("change", { bubbles: true }));
            });
            await expect(visibleBackdrop).toHaveCount(1, { timeout: 3000 });
            expect(Date.now() - showStarted).toBeLessThan(3000);
            releaseRatingsRequest();
        });

    test("uses the server cover tint without enabling movie backdrops", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/cover-tint.jpg";
        const thumbnail = "https://streamingsoundtracks.com/images/cover/040/cover-tint.jpg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/cover-tint.jpg";
        let tintRequests = 0, backdropRequests = 0, requestedCover = "";
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Cover Tint", Track: "No Movie Art", Artist: "24seven.fm",
                CoverLink: cover, ThumbnailLink: thumbnail, Length: 0,
                PlayStart: "2026-08-20T12:00:00Z", SystemTime: "2026-08-20T12:00:00Z",
            } });
        });
        await page.route(sizedCover, (route) => route.fulfill({ status: 200,
            contentType: "image/jpeg", body: Buffer.from([1, 2, 3]) }));
        await page.route(/\/api\/tint\?/, (route) => {
            tintRequests++;
            requestedCover = new URL(route.request().url()).searchParams.get("url");
            return route.fulfill({ json: { tint: [31, 63, 127] } });
        });
        await page.route(/\/api\/backdrop\?/, (route) => {
            backdropRequests++;
            return route.abort();
        });

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect.poll(() => tintRequests).toBe(1);
        expect(requestedCover).toBe(thumbnail);
        expect(backdropRequests).toBe(0);
        await expect.poll(() => page.locator("#stage").evaluate((stage) =>
             getComputedStyle(stage).getPropertyValue("--player-tint").trim()))
            .toBe("rgb(31, 63, 127)");
    });
    test("uses the cover tint resolver for every station", async ({ page }) => {
        const stations = [
            { name: "StreamingSoundtracks", host: "streamingsoundtracks.com", id: "sst" },
            { name: "1980s.FM", host: "1980s.fm", id: "1980s" },
            { name: "Adagio.FM", host: "adagio.fm", id: "adagio" },
            { name: "Death.FM", host: "death.fm", id: "death" },
            { name: "Entranced.FM", host: "entranced.fm", id: "entranced" },
        ].map((entry) => ({
            ...entry,
            cover: "https://" + entry.host + "/images/cover/tint-" + entry.id + ".jpg",
            thumbnail: "https://" + entry.host + "/images/cover/040/tint-" + entry.id + ".jpg",
        }));
        const requestedCovers = [];

        await page.route(/https:\/\/(?:streamingsoundtracks\.com|1980s\.fm|adagio\.fm|death\.fm|entranced\.fm)\/soap\/FM24sevenJSON\.php\?/, (route) => {
            const url = new URL(route.request().url());
            if (url.searchParams.get("action") === "GetQueue") return route.fulfill({ json: [] });
            const selected = stations.find((entry) => entry.host === url.hostname);
            return route.fulfill({ json: {
                Album: "Tint " + selected.name, Track: "", Artist: "24seven.fm",
                CoverLink: selected.cover, ThumbnailLink: selected.thumbnail, Length: 0,
                PlayStart: "2026-08-20T12:00:00Z", SystemTime: "2026-08-20T12:00:00Z",
            } });
        });
        await page.route(/https:\/\/(?:streamingsoundtracks\.com|1980s\.fm|adagio\.fm|death\.fm|entranced\.fm)\/images\/cover\/500\/tint-.*\.jpg/,
            (route) => route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/tint\?/, (route) => {
            requestedCovers.push(new URL(route.request().url()).searchParams.get("url"));
            return route.fulfill({ json: { tint: [31, 63, 127] } });
        });

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        for (const selected of stations) {
            if (selected.id !== "sst") {
                await page.locator("label.seg", { hasText: selected.name }).click();
            }
            await expect.poll(() => requestedCovers.includes(selected.thumbnail)).toBe(true);
        }
        expect(new Set(requestedCovers)).toEqual(new Set(stations.map((entry) => entry.thumbnail)));
    });
    test("uses the server backdrop and tint without browser provider calls", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/arrival.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/arrival.svg";
        const backdrop = "https://image.tmdb.org/t/p/w1280/arrival.jpg";
        let resolverRequests = 0, directProviderRequests = 0;
        let resolvedAlbum = "", resolvedTrack = "", resolvedArtist = "", resolvedProviders = "";
        let resolverVersion = "";
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ sstBackdrops: { enabled: true, options: { providers: ["fanart", "tmdb", "steamgriddb"], cover: "show" } } })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Arrival (Original Motion Picture Soundtrack)", Track: "Heptapod B",
                Artist: "Jóhann Jóhannsson", CoverLink: cover, Length: 0,
                PlayStart: "2026-08-20T12:00:00Z", SystemTime: "2026-08-20T12:00:00Z",
            } });
        });
        await page.route(sizedCover, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/tint\?/, (route) =>
            route.fulfill({ json: { tint: [20, 40, 60] } }));
        await page.route(/\/api\/backdrop\?/, (route) => {
            const url = new URL(route.request().url());
            resolverRequests++;
            resolvedAlbum = url.searchParams.get("album");
            resolvedTrack = url.searchParams.get("track");
            resolvedArtist = url.searchParams.get("artist");
            resolvedProviders = url.searchParams.get("providers");
            resolverVersion = url.searchParams.get("resolver_version");
            return route.fulfill({ json: {
                movie: { id: 329865, title: "Arrival" }, backdrop,
                source: "tmdb", tint: [131, 172, 255],
            } });
        });
        await page.route(/https:\/\/(api\.themoviedb\.org|webservice\.fanart\.tv|www\.steamgriddb\.com)\//, (route) => {
            directProviderRequests++;
            return route.abort();
        });
        await page.route(backdrop, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect.poll(() => resolverRequests).toBe(1);
        expect(resolvedAlbum).toBe("Arrival (Original Motion Picture Soundtrack)");
        expect(resolvedTrack).toBe("Heptapod B");
        expect(resolvedArtist).toBe("Jóhann Jóhannsson");
        expect(resolvedProviders).toBe("fanart,tmdb,steamgriddb");
        expect(resolverVersion).toMatch(/^[a-f0-9]{12}$/);
        expect(directProviderRequests).toBe(0);
        await expect(page.locator("#movieA.show, #movieB.show"))
            .toHaveAttribute("src", /arrival\.jpg/);
        await expect.poll(() => page.locator("#stage").evaluate((stage) =>
            getComputedStyle(stage).getPropertyValue("--player-tint").trim()))
            .toBe("rgb(131, 172, 255)");
    });
    test("sends raw game soundtrack metadata and accepts a SteamGridDB hero", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/hades.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/hades.svg";
        const backdrop = "https://cdn2.steamgriddb.com/hero/hades.jpg";
        let album = "", track = "", providers = "";
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ sstBackdrops: { enabled: true, options: { providers: ["fanart", "tmdb", "steamgriddb"], cover: "show" } } })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Hades (Original Video Game Soundtrack)", Track: "No Escape",
                Artist: "Darren Korb", CoverLink: cover, Length: 144000,
                PlayStart: "2026-08-20T12:00:00Z", SystemTime: "2026-08-20T12:00:00Z",
            } });
        });
        await page.route(sizedCover, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/backdrop\?/, (route) => {
            const url = new URL(route.request().url());
            album = url.searchParams.get("album");
            track = url.searchParams.get("track");
            providers = url.searchParams.get("providers");
            return route.fulfill({ json: {
                media: { id: 5253, title: "Hades", type: "game" }, backdrop,
                source: "steamgriddb", tint: [90, 100, 110],
            } });
        });
        await page.route(backdrop, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });

        await expect.poll(() => album).toBe("Hades (Original Video Game Soundtrack)");
        expect(track).toBe("No Escape");
        expect(providers).toBe("fanart,tmdb,steamgriddb");
        await expect(page.locator("#movieA.show, #movieB.show"))
            .toHaveAttribute("src", /cdn2\.steamgriddb\.com\/hero\/hades\.jpg/);
    });
    test("normalizes the live rotated conjunction title for the resolver", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/history-title.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/history-title.svg";
        let resolverQuery = "", personalKey = "";
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ sstBackdrops: { enabled: true, options: { providers: ["fanart", "tmdb", "steamgriddb"], cover: "show" } },
                fanartKey: "fanart-history-key" })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Good, The Bad &amp; The Ugly, The", Track: "The Trio (Main Title)",
                Artist: "Ennio Morricone", CoverLink: cover, Length: 301723,
                PlayStart: "2026-08-18T12:00:00Z", SystemTime: "2026-08-18T12:00:00Z",
            } });
        });
        await page.route(sizedCover, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/backdrop\?/, (route) => {
            const url = new URL(route.request().url());
            resolverQuery = url.searchParams.get("album");
            personalKey = url.searchParams.get("client_key");
            return route.fulfill({ json: {
                movie: { id: 429, title: "The Good, the Bad and the Ugly" },
                backdrop: "https://fanart.tv/good-bad-ugly.jpg",
                source: "fanart", tint: [200, 210, 220],
            } });
        });
        await page.route("https://fanart.tv/good-bad-ugly.jpg", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });

        await expect(page.locator("#info-title"))
            .toContainText("The Good, The Bad & The Ugly - The Trio (Main Title)");
        await expect.poll(() => resolverQuery).toBe("Good, The Bad & The Ugly, The");
        expect(personalKey).toBe("fanart-history-key");
        await expect(page.locator("#movieA.show, #movieB.show"))
            .toHaveAttribute("src", /good-bad-ugly\.jpg/);
    });
    test("strips a symphonic-suite album suffix for the movie resolver", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/princess-mononoke.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/princess-mononoke.svg";
        const backdrop = "https://image.tmdb.org/t/p/w1280/princess-mononoke.jpg";
        let resolverQuery = "";
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ sstBackdrops: { enabled: true, options: { providers: ["tmdb", "steamgriddb"], cover: "show" } } })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Princess Mononoke: Symphonic Suite", Track: "The Journey To The West",
                Artist: "Joe Hisaishi", CoverLink: cover, Length: 291000,
                PlayStart: "2026-08-20T12:00:00Z", SystemTime: "2026-08-20T12:00:00Z",
            } });
        });
        await page.route(sizedCover, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/backdrop\?/, (route) => {
            resolverQuery = new URL(route.request().url()).searchParams.get("album");
            return route.fulfill({ json: {
                movie: { id: 128, title: "Princess Mononoke" }, backdrop,
                source: "tmdb", tint: [150, 160, 170],
            } });
        });
        await page.route(backdrop, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });

        await expect(page.locator("#info-title")).toContainText(
            "Princess Mononoke: Symphonic Suite - The Journey To The West (4:51)");
        await expect.poll(() => resolverQuery).toBe("Princess Mononoke: Symphonic Suite");
        await expect(page.locator("#movieA.show, #movieB.show"))
            .toHaveAttribute("src", /princess-mononoke\.jpg/);
    });
    test("unrotates an article before a soundtrack release year", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/thomas-crown.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/thomas-crown.svg";
        const backdrop = "https://image.tmdb.org/t/p/w1280/thomas-crown.jpg";
        let resolverQuery = "";
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ sstBackdrops: { enabled: true, options: { providers: ["tmdb", "steamgriddb"], cover: "show" } } })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Thomas Crown Affair, The (1968)",
                Track: "Theme From The Thomas Crown Affair (The Windmills Of Your Mind) (Perf. By Noel Harrison)",
                Artist: "Michel Legrand", CoverLink: cover, Length: 138000,
                PlayStart: "2026-08-20T12:00:00Z", SystemTime: "2026-08-20T12:00:00Z",
            } });
        });
        await page.route(sizedCover, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/backdrop\?/, (route) => {
            resolverQuery = new URL(route.request().url()).searchParams.get("album");
            return route.fulfill({ json: {
                movie: { id: 912, title: "The Thomas Crown Affair" }, backdrop,
                source: "tmdb", tint: [150, 160, 170],
            } });
        });
        await page.route(backdrop, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });

        await expect(page.locator("#info-title")).toContainText(
            "The Thomas Crown Affair (1968) - Theme From The Thomas Crown Affair "
            + "(The Windmills Of Your Mind) (Perf. By Noel Harrison) (2:18)");
        await expect.poll(() => resolverQuery).toBe("Thomas Crown Affair, The (1968)");
        await expect(page.locator("#movieA.show, #movieB.show"))
            .toHaveAttribute("src", /thomas-crown\.jpg/);
    });
    test("maps a compilation album to its canonical TV series title", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/inspector-morse.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/inspector-morse.svg";
        const backdrop = "https://image.tmdb.org/t/p/w1280/inspector-morse.jpg";
        let resolverQuery = "";
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ sstBackdrops: { enabled: true, options: { providers: ["fanart", "tmdb", "steamgriddb"], cover: "show" } } })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "The Magic Of Inspector Morse", Track: "Irish Connection",
                Artist: "Barrington Pheloung", CoverLink: cover, Length: 183000,
                PlayStart: "2026-08-20T12:00:00Z", SystemTime: "2026-08-20T12:00:00Z",
            } });
        });
        await page.route(sizedCover, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/backdrop\?/, (route) => {
            resolverQuery = new URL(route.request().url()).searchParams.get("album");
            return route.fulfill({ json: {
                media: { id: 3476, title: "Inspector Morse", type: "tv" }, backdrop,
                source: "tmdb", tint: [100, 120, 140],
            } });
        });
        await page.route(backdrop, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });

        await expect(page.locator("#info-title"))
            .toContainText("The Magic Of Inspector Morse - Irish Connection (3:03)");
        await expect.poll(() => resolverQuery).toBe("The Magic Of Inspector Morse");
        await expect(page.locator("#movieA.show, #movieB.show"))
            .toHaveAttribute("src", /inspector-morse\.jpg/);
    });
    test("uses the movie prefix from a known multi-film compilation track", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/wings-of-a-film.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/wings-of-a-film.svg";
        const backdrop = "https://image.tmdb.org/t/p/w1280/thin-red-line.jpg";
        let resolverAlbum = "", resolverTrack = "";
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ sstBackdrops: { enabled: true, options: { providers: ["fanart", "tmdb", "steamgriddb"], cover: "show" } } })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "The Wings Of A Film", Track: "The Thin Red Line: Journey To The Line",
                Artist: "Hans Zimmer", CoverLink: cover, Length: 590000,
                PlayStart: "2026-08-20T12:00:00Z", SystemTime: "2026-08-20T12:00:00Z",
            } });
        });
        await page.route(sizedCover, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/backdrop\?/, (route) => {
            const url = new URL(route.request().url());
            resolverAlbum = url.searchParams.get("album");
            resolverTrack = url.searchParams.get("track");
            return route.fulfill({ json: {
                media: { id: 8741, title: "The Thin Red Line", type: "movie" }, backdrop,
                source: "tmdb", tint: [100, 120, 140],
            } });
        });
        await page.route(backdrop, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });

        await expect(page.locator("#info-title")).toContainText(
            "The Wings Of A Film - The Thin Red Line: Journey To The Line (9:50)");
        await expect.poll(() => resolverAlbum).toBe("The Wings Of A Film");
        expect(resolverTrack).toBe("The Thin Red Line: Journey To The Line");
        await expect(page.locator("#movieA.show, #movieB.show"))
            .toHaveAttribute("src", /thin-red-line\.jpg/);
    });
    test("treats inherited object names as normal movie cache keys", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/constructor.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/constructor.svg";
        let resolverRequests = 0;
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ sstBackdrops: { enabled: true, options: { providers: ["tmdb", "steamgriddb"], cover: "show" } } })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "constructor", Track: "", Artist: "24seven.fm",
                CoverLink: cover, Length: 0,
                PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route(sizedCover, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/backdrop\?/, (route) => {
            resolverRequests++;
            return route.fulfill({ json: {
                movie: { id: 13, title: "constructor" },
                backdrop: "https://image.tmdb.org/t/p/w1280/constructor.jpg",
                source: "tmdb", tint: [255, 255, 255],
            } });
        });
        await page.route("https://image.tmdb.org/t/p/w1280/constructor.jpg", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect.poll(() => resolverRequests).toBe(1);
        await expect(page.locator("#movieA.show, #movieB.show"))
            .toHaveAttribute("src", /constructor\.jpg/);
    });
    virtualClockTest("preserves the resolver-outage warning across successful polls", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/no-key.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/no-key.svg";
        await page.clock.install();
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ sstBackdrops: { enabled: true, options: { providers: ["fanart", "tmdb", "steamgriddb"], cover: "show" } } })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "No Key Movie", Track: "", Artist: "24seven.fm",
                CoverLink: cover, Length: 0,
                PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route(sizedCover, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/backdrop\?/, (route) => route.abort());

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        const warning = "Backdrop service is currently unavailable.";
        await expect(page.locator("#status")).toHaveText(warning);
        await page.clock.fastForward(12002);
        await expect(page.locator("#status")).toHaveText(warning);
    });
    test("checks the station before the boundary and fades stale art while replacement waits",
        async ({ page }) => {
            const oldCover = "https://streamingsoundtracks.com/images/cover/old-boundary.svg";
            const newCover = "https://streamingsoundtracks.com/images/cover/new-boundary.svg";
            const oldBackdrop = "https://image.tmdb.org/t/p/w1280/old-boundary.jpg";
            const newBackdrop = "https://image.tmdb.org/t/p/w1280/new-boundary.jpg";
            let nowRequests = 0, queueRequests = 0, newResolverRequested = false;
            let releaseNewResolver;
            const newResolverMayFinish = new Promise((resolve) => { releaseNewResolver = resolve; });
            await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
                JSON.stringify({ sstBackdrops: { enabled: true, options: { providers: ["tmdb"], cover: "show" } },
                    transition: { enabled: true,
                        options: { style: 1, durationMs: 500 } } })));
            await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
                const action = new URL(route.request().url()).searchParams.get("action");
                if (action === "GetQueue") {
                    queueRequests++;
                    return route.fulfill({ json: [] });
                }
                nowRequests++;
                return route.fulfill({ json: nowRequests === 1 ? {
                    Album: "Old Boundary Movie", Track: "Old Cue", Artist: "Old Composer",
                    CoverLink: oldCover, Length: 12000,
                    PlayStart: "2026-08-23T12:00:00Z",
                    SystemTime: "2026-08-23T12:00:02Z",
                } : {
                    Album: "New Boundary Movie", Track: "New Cue", Artist: "New Composer",
                    CoverLink: newCover, Length: 180000,
                    PlayStart: "2026-08-23T12:00:12Z",
                    SystemTime: "2026-08-23T12:00:12Z",
                } });
            });
            await page.route("https://streamingsoundtracks.com/images/cover/500/*.svg", (route) =>
                route.fulfill({ status: 200, contentType: "image/svg+xml",
                    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
            await page.route(/\/api\/tint\?/, (route) =>
                route.fulfill({ json: { tint: [40, 50, 60] } }));
            await page.route(/\/api\/backdrop\?/, async (route) => {
                const album = new URL(route.request().url()).searchParams.get("album");
                if (album === "New Boundary Movie") {
                    newResolverRequested = true;
                    await newResolverMayFinish;
                }
                return route.fulfill({ json: {
                    media: { id: album === "New Boundary Movie" ? 2 : 1,
                        title: album, type: "movie" },
                    backdrop: album === "New Boundary Movie" ? newBackdrop : oldBackdrop,
                    source: "tmdb", tint: [80, 100, 120],
                } });
            });
            await page.route(/https:\/\/image\.tmdb\.org\/t\/p\/w1280\/(?:old|new)-boundary\.jpg/,
                (route) => route.fulfill({ status: 200, contentType: "image/svg+xml",
                    body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"/>' }));

            await page.goto("/player.html", { waitUntil: "domcontentloaded" });
            const oldImage = page.locator(
                `#movieA[src="${oldBackdrop}"], #movieB[src="${oldBackdrop}"]`);
            await expect(oldImage).toHaveClass(/show/);

            await expect(page.locator("#info-title"))
                .toContainText("New Boundary Movie", { timeout: 4000 });
            await expect.poll(() => newResolverRequested).toBe(true);
            await expect(oldImage).not.toHaveClass(/show/);
            await expect(oldImage).toHaveAttribute("src", oldBackdrop);
            expect(queueRequests).toBe(2);

            releaseNewResolver();
            await expect(page.locator("#movieA.show, #movieB.show"))
                .toHaveAttribute("src", newBackdrop);
        });
    test("resynchronizes after a visible player regains focus", async ({ page }) => {
        let album = "Before Backgrounding", nowRequests = 0;
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            nowRequests++;
            return route.fulfill({ json: {
                Album: album, Track: "Cue", Artist: "Composer", CoverLink: "",
                Length: 3600000, PlayStart: "2026-08-23T12:00:00Z",
                SystemTime: "2026-08-23T12:00:00Z",
            } });
        });
        await page.route("https://streamingsoundtracks.com/images/logos/*", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect(page.locator("#info-title")).toContainText("Before Backgrounding");
        album = "After Backgrounding";
        await page.waitForTimeout(2100);
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));

        await expect.poll(() => nowRequests).toBe(2);
        await expect(page.locator("#info-title")).toContainText("After Backgrounding");
    });
    test("offers an explanatory cache-bypassing retry after a backdrop outage", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/retry.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/retry.svg";
        const backdrop = "https://image.tmdb.org/t/p/w1280/retry.jpg";
        let resolverRequests = 0;
        let releaseRetry;
        const retryMayFinish = new Promise((resolve) => { releaseRetry = resolve; });
        await page.addInitScript(() => {
            localStorage.setItem("24sevenfm-covers.player.v2",
                JSON.stringify({ sstBackdrops: { enabled: true, options: { providers: ["tmdb"], cover: "show" } } }));
            const nativeFetch = window.fetch;
            window.backdropFetchCacheModes = [];
            window.fetch = function (input, init) {
                if (new URL(typeof input === "string" ? input : input.url, location.href)
                        .pathname === "/api/backdrop") {
                    window.backdropFetchCacheModes.push(init && init.cache || "default");
                }
                return nativeFetch.apply(this, arguments);
            };
        });
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Retry Movie", Track: "Retry Cue", Artist: "Retry Composer",
                CoverLink: cover, Length: 0,
                PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route(sizedCover, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/backdrop\?/, async (route) => {
            resolverRequests++;
            if (resolverRequests === 1)
                return route.fulfill({ status: 503, json: { error: "temporarily_unavailable" } });
            await retryMayFinish;
            return route.fulfill({ json: {
                movie: { id: 42, title: "Retry Movie" },
                backdrop, source: "tmdb", tint: [40, 50, 60],
            } });
        });
        await page.route(backdrop, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"/>' }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await openBackdropSettings(page);
        const error = page.locator("#backdrop-error");
        const retry = page.locator("#backdrop-retry");
        await expect(error).toBeVisible();
        await expect(error).toContainText("Backdrop artwork couldn’t be loaded.");
        await expect(retry).toHaveText("Retry");
        await expect(retry).toBeEnabled();
        const transitionProperties = await error.evaluate((element) =>
            getComputedStyle(element).transitionProperty.split(", "));
        expect(transitionProperties).toEqual(expect.arrayContaining(["opacity", "max-height"]));

        await retry.click();
        await expect(error).toContainText("Loading backdrop artwork…");
        await expect(retry).toBeDisabled();
        expect(await page.evaluate(() => window.backdropFetchCacheModes))
            .toEqual(["default", "reload"]);

        releaseRetry();
        await expect(page.locator("#movieA.show, #movieB.show")).toHaveAttribute("src", backdrop);
        await expect(error).toBeHidden();
        await expect(error).toContainText("Loading backdrop artwork… Retry");
        await expect(page.locator("#status")).toHaveText("");
        expect(resolverRequests).toBe(2);
    });
    test("retries a backdrop after a transient image load failure", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/blade-runner-2049.svg";
        const sizedCover =
            "https://streamingsoundtracks.com/images/cover/500/blade-runner-2049.svg";
        const backdrop = "https://fanart.tv/blade-runner-2049.jpg";
        let resolverRequests = 0, imageRequests = 0;
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ sstBackdrops: { enabled: true, options: {
                providers: ["fanart", "tmdb"], cover: "show" } } })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Blade Runner 2049", Track: "Main Titles",
                Artist: "Hans Zimmer, Benjamin Wallfisch", CoverLink: cover, Length: 0,
                PlayStart: "2026-08-25T12:00:00Z", SystemTime: "2026-08-25T12:00:00Z",
            } });
        });
        await page.route(sizedCover, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/backdrop\?/, (route) => {
            resolverRequests++;
            return route.fulfill({ json: {
                media: { id: 335984, title: "Blade Runner 2049", type: "movie" },
                backdrop, source: "fanart", tint: [255, 226, 229],
            } });
        });
        await page.route(backdrop, (route) => {
            imageRequests++;
            if (imageRequests === 1) return route.abort();
            return route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"/>' });
        });

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect.poll(() => imageRequests, { timeout: 5000 }).toBe(2);
        await expect(page.locator("#movieA.show, #movieB.show")).toHaveAttribute("src", backdrop);
        await expect(page.locator("#backdrop-error")).not.toHaveClass(/show/);
        expect(resolverRequests).toBe(1);
    });
    test("rejects a non-string persisted fanart personal key", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/invalid-key.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/invalid-key.svg";
        let resolverRequests = 0;
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ sstBackdrops: { enabled: true, options: { providers: ["fanart", "tmdb", "steamgriddb"], cover: "show" } }, fanartKey: { key: "bad" } })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Invalid Key Movie", Track: "", Artist: "24seven.fm",
                CoverLink: cover, Length: 0,
                PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route(sizedCover, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/backdrop\?/, (route) => {
            resolverRequests++;
            expect(new URL(route.request().url()).searchParams.has("client_key")).toBe(false);
            return route.fulfill({ status: 503, json: { error: "resolver_not_configured" } });
        });

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect(page.locator("#tmdb-key")).toHaveCount(0);
        await expect(page.locator("#fanart-key")).toHaveValue("");
        await expect(page.locator("#status")).toHaveText(
            "Backdrop service is currently unavailable.");
        expect(resolverRequests).toBe(1);
    });
    test("preserves audio errors across backdrop option changes", async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem("24sevenfm-covers.player.v2",
                JSON.stringify({ sstBackdrops: { enabled: true, options: { providers: ["fanart", "tmdb", "steamgriddb"], cover: "show" } } }));
            HTMLMediaElement.prototype.play = function () { return Promise.reject(new Error("denied")); };
            HTMLMediaElement.prototype.pause = function () {};
            HTMLMediaElement.prototype.load = function () {};
        });
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await page.locator("#audio-toggle").click();
        const audioError = "Your browser refused to play the stream "
            + String.fromCharCode(0x2013) + " use the playlist links below.";
        await expect(page.locator("#status")).toHaveText(audioError);

        await page.locator("#fanart-key").evaluate((input) => {
            input.value = "changed";
            input.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await expect(page.locator("#status")).toHaveText(audioError);
    });
    test("clears stale movie art when the replacement image fails", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/movie-failure.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/movie-failure.svg";
        let resolverRequests = 0, failedImages = 0;
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ sstBackdrops: { enabled: true, options: { providers: ["fanart", "tmdb", "steamgriddb"], cover: "hide" } } })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Backdrop Failure", Track: "", Artist: "24seven.fm",
                CoverLink: cover, Length: 0,
                PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route(sizedCover, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/tint\?/, (route) =>
            route.fulfill({ json: { tint: [20, 40, 60] } }));
        await page.route(/\/api\/backdrop\?/, (route) => {
            resolverRequests++;
            const path = resolverRequests === 1 ? "/working.jpg" : "/broken.jpg";
            return route.fulfill({ json: {
                movie: { id: 1, title: "Backdrop Failure" },
                backdrop: "https://image.tmdb.org/t/p/w1280" + path,
                source: "tmdb", tint: [220, 230, 240],
            } });
        });
        await page.route("https://image.tmdb.org/t/p/w1280/working.jpg", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route("https://image.tmdb.org/t/p/w1280/broken.jpg", (route) => {
            failedImages++;
            return route.abort();
        });

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect(page.locator("#movieA.show, #movieB.show")).toHaveCount(1);
        await expect(page.locator("#stage")).toHaveClass(/no-cover/);
        await page.locator("#fanart-key").evaluate((input) => {
            input.value = "new-personal-key";
            input.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await expect.poll(() => resolverRequests).toBe(2);
        await expect.poll(() => failedImages, { timeout: 5000 }).toBe(3);
        await expect(page.locator("#movieA.show, #movieB.show")).toHaveCount(0);
        await expect(page.locator("#stage")).not.toHaveClass(/no-cover/);
        await openBackdropSettings(page);
        await expect(page.locator("#backdrop-error")).toBeVisible();
        await expect(page.locator("#backdrop-error"))
            .toContainText("Backdrop artwork couldn’t be loaded. Retry");
        await expect.poll(() => page.locator("#stage").evaluate((stage) =>
            getComputedStyle(stage).getPropertyValue("--player-tint").trim()))
            .toBe("rgb(20, 40, 60)");
    });

    for (const status of [429, 500]) {
        test(`retries the resolver after a transient HTTP ${status}`, async ({ page }) => {
            const cover = "https://streamingsoundtracks.com/images/cover/retry.svg";
            const sizedCover = "https://streamingsoundtracks.com/images/cover/500/retry.svg";
            let resolverRequests = 0;
            await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
                JSON.stringify({ sstBackdrops: { enabled: true, options: { providers: ["tmdb"], cover: "show" } } })));
            await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
                const action = new URL(route.request().url()).searchParams.get("action");
                if (action === "GetQueue") return route.fulfill({ json: [] });
                return route.fulfill({ json: {
                    Album: "Retry Movie", Track: "", Artist: "24seven.fm",
                    CoverLink: cover, Length: 0,
                    PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
                } });
            });
            await page.route(sizedCover, (route) => route.fulfill({ status: 200,
                contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
            await page.route(/\/api\/backdrop\?/, (route) => {
                resolverRequests++;
                if (resolverRequests === 1)
                    return route.fulfill({ status, json: { error: "temporary_failure" } });
                return route.fulfill({ json: {
                    movie: { id: 1, title: "Retry Movie" },
                    backdrop: "https://image.tmdb.org/t/p/w1280/retry.jpg",
                    source: "tmdb", tint: [255, 255, 255],
                } });
            });
            await page.route("https://image.tmdb.org/t/p/w1280/retry.jpg", (route) =>
                route.fulfill({ status: 200, contentType: "image/svg+xml",
                    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));

            await page.goto("/player.html", { waitUntil: "domcontentloaded" });
            await expect.poll(() => resolverRequests).toBe(1);
            await page.waitForTimeout(100); // let the failed lookup settle without caching
            await openBackdropSettings(page);
            const toggle = page.locator("label:has(#tmdbart-on)");
            await toggle.click();
            await toggle.click();

            await expect.poll(() => resolverRequests).toBe(2);
            await expect(page.locator("#movieA.show, #movieB.show")).toHaveCount(1);
        });
    }

    test("keeps next-track resolver failures out of the current status", async ({ page }) => {
        const nextCover = "https://streamingsoundtracks.com/images/cover/next.svg";
        const nextSized = "https://streamingsoundtracks.com/images/cover/500/next.svg";
        let resolverRequests = 0, resolvedArtist = "";
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ sstBackdrops: { enabled: true, options: { providers: ["fanart", "tmdb", "steamgriddb"], cover: "show" } },
                fanartKey: "bad-fanart-key" })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [{
                Album: "Next Movie", Track: "Next Cue", Artist: "Next Composer",
                CoverLink: nextCover,
            }] });
            return route.fulfill({ json: {
                Album: "Station ID", Track: "", Artist: "24seven.fm", CoverLink: "", Length: 0,
                PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route("https://streamingsoundtracks.com/images/logos/*", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(nextSized, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/backdrop\?/, (route) => {
            resolverRequests++;
            resolvedArtist = new URL(route.request().url()).searchParams.get("artist");
            return route.fulfill({ status: 502, json: { error: "provider_unavailable" } });
        });

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect.poll(() => resolverRequests).toBe(1);
        expect(resolvedArtist).toBe("Next Composer");
        await expect(page.locator("#status")).toHaveText("");
    });
    test("stagger-prefetches every queued tint and backdrop through one scheduler", async ({ page }) => {
        const albums = ["First Queued", "Second Queued", "Third Queued"];
        const covers = albums.map((album, index) =>
            `https://streamingsoundtracks.com/images/cover/queued-${index + 1}.svg`);
        const tintUrls = [], backdropAlbums = [];
        await page.addInitScript(() => {
            localStorage.setItem("24sevenfm-covers.player.v2", JSON.stringify({
                sstBackdrops: { enabled: true, options: { providers: ["tmdb"], cover: "show" } },
            }));
            const nativeSetTimeout = window.setTimeout.bind(window);
            window.__prefetchDelays = [];
            window.__fakePrefetchTimerId = 1000000000;
            window.__runNextPrefetchDelay = () => {
                const pending = window.__prefetchDelays.shift();
                if (!pending) throw new Error("No queued prefetch delay");
                pending.callback(...pending.args);
            };
            window.setTimeout = function (callback, delay) {
                const args = Array.prototype.slice.call(arguments, 2);
                if (delay >= 59000 && delay <= 60000) {
                    window.__prefetchDelays.push({ callback, args });
                    return ++window.__fakePrefetchTimerId;
                }
                return nativeSetTimeout(callback, delay, ...args);
            };
        });
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: albums.map((album, index) => ({
                Album: album, Track: `Cue ${index + 1}`, Artist: `Composer ${index + 1}`,
                CoverLink: covers[index],
                ThumbnailLink: covers[index].replace("/cover/", "/cover/040/"),
                SiteLink: "",
            })) });
            return route.fulfill({ json: {
                Album: "Station ID", Track: "", Artist: "24seven.fm", CoverLink: "",
                Length: 3600000, PlayStart: "2026-08-23T12:00:00Z",
                SystemTime: "2026-08-23T12:00:00Z",
            } });
        });
        await page.route("https://streamingsoundtracks.com/images/logos/*", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route("https://streamingsoundtracks.com/images/cover/500/*.svg", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/tint\?/, (route) => {
            tintUrls.push(new URL(route.request().url()).searchParams.get("url"));
            return route.fulfill({ json: { tint: [40, 50, 60] } });
        });
        await page.route(/\/api\/backdrop\?/, (route) => {
            const url = new URL(route.request().url());
            backdropAlbums.push(url.searchParams.get("album"));
            return route.fulfill({ json: {
                media: { id: backdropAlbums.length, title: backdropAlbums.at(-1), type: "movie" },
                backdrop: null, source: null, tint: [255, 255, 255],
            } });
        });

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect.poll(() => backdropAlbums).toEqual(["First Queued"]);
        await expect.poll(() => page.evaluate(() => window.__prefetchDelays.length)).toBe(1);
        expect(backdropAlbums).toEqual(["First Queued"]);
        await page.evaluate(() => window.__runNextPrefetchDelay());
        await expect.poll(() => backdropAlbums).toEqual(albums.slice(0, 2));
        await expect.poll(() => page.evaluate(() => window.__prefetchDelays.length)).toBe(1);
        await page.evaluate(() => window.__runNextPrefetchDelay());
        await expect.poll(() => backdropAlbums).toEqual(albums);
        await expect.poll(() => tintUrls).toHaveLength(3);
        expect(new Set(tintUrls)).toEqual(new Set(covers.map((cover) =>
            cover.replace("/cover/", "/cover/040/"))));
    });
    test("keeps enriched queue entries and prefetches only the new tail after a track change",
        async ({ page }) => {
            let current = {
                Album: "Station ID", Track: "", Artist: "24seven.fm", CoverLink: "",
                Length: 3600000, PlayStart: "2026-08-23T12:00:00Z",
                SystemTime: "2026-08-23T12:00:00Z",
            };
            let queueAlbums = ["Queue A", "Queue B"], queueRequests = 0;
            const backdropAlbums = [];
            await page.addInitScript(() => {
                localStorage.setItem("24sevenfm-covers.player.v2", JSON.stringify({
                    sstBackdrops: { enabled: true, options: { providers: ["tmdb"], cover: "show" } },
                }));
                const nativeSetTimeout = window.setTimeout.bind(window);
                window.setTimeout = function (callback, delay) {
                    const args = Array.prototype.slice.call(arguments, 2);
                    if (delay >= 50000 && delay <= 60000) delay = 20;
                    return nativeSetTimeout(callback, delay, ...args);
                };
            });
            await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
                const action = new URL(route.request().url()).searchParams.get("action");
                if (action === "GetQueue") {
                    queueRequests++;
                    return route.fulfill({ json: queueAlbums.map((album) => ({
                        Album: album, Track: "Cue", Artist: `${album} Composer`,
                        CoverLink: `https://streamingsoundtracks.com/images/cover/${album.slice(-1)}.svg`,
                    })) });
                }
                return route.fulfill({ json: current });
            });
            await page.route("https://streamingsoundtracks.com/images/{logos,cover}/**", (route) =>
                route.fulfill({ status: 200, contentType: "image/svg+xml",
                    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
            await page.route(/\/api\/tint\?/, (route) =>
                route.fulfill({ json: { tint: [40, 50, 60] } }));
            await page.route(/\/api\/backdrop\?/, (route) => {
                backdropAlbums.push(new URL(route.request().url()).searchParams.get("album"));
                return route.fulfill({ json: {
                    media: { id: backdropAlbums.length, title: backdropAlbums.at(-1), type: "movie" },
                    backdrop: null, source: null, tint: [255, 255, 255],
                } });
            });

            await page.goto("/player.html", { waitUntil: "domcontentloaded" });
            await expect.poll(() => backdropAlbums).toEqual(["Queue A", "Queue B"]);

            current = {
                Album: "Queue A", Track: "Cue", Artist: "Queue A Composer",
                CoverLink: "https://streamingsoundtracks.com/images/cover/A.svg",
                Length: 180000, PlayStart: "2026-08-23T12:00:00Z",
                SystemTime: "2026-08-23T12:00:00Z",
            };
            queueAlbums = ["Queue B", "Queue C"];

            await page.waitForTimeout(2100);
            await page.evaluate(() => window.dispatchEvent(new Event("focus")));
            await expect.poll(() => queueRequests).toBe(2);
            await expect.poll(() => backdropAlbums).toEqual(["Queue A", "Queue B", "Queue C"]);
        });
    test("revalidates an artistless backdrop hit with the current-playing artist",
        async ({ page }) => {
        const nextCover = "https://streamingsoundtracks.com/images/cover/land-before-time.svg";
        const nextSized = "https://streamingsoundtracks.com/images/cover/500/land-before-time.svg";
        const provisionalBackdrop = "https://image.tmdb.org/t/p/w1280/land-before-time-provisional.jpg";
        const definitiveBackdrop = "https://image.tmdb.org/t/p/w1280/land-before-time-definitive.jpg";
        let current = {
            Album: "Station ID", Track: "", Artist: "24seven.fm", CoverLink: "",
            Length: 3600000, PlayStart: "2026-08-21T12:00:00Z",
            SystemTime: "2026-08-21T12:00:00Z",
        };
        const artists = [];
        let backdropLoads = 0;
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ sstBackdrops: { enabled: true, options: { providers: ["tmdb"], cover: "show" } } })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [{
                Album: "Land Before Time, The", Track: "The Great Migration",
                CoverLink: nextCover,
            }] });
            return route.fulfill({ json: current });
        });
        await page.route("https://streamingsoundtracks.com/images/logos/*", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(nextSized, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/backdrop\?/, (route) => {
            const url = new URL(route.request().url());
            const artist = url.searchParams.get("artist");
            artists.push(artist);
            return route.fulfill({ json: {
                media: { id: 12144, title: "The Land Before Time", type: "movie" },
                backdrop: artist ? definitiveBackdrop : provisionalBackdrop,
                source: "tmdb", tint: [110, 150, 90],
            } });
        });
        await page.route(/https:\/\/image\.tmdb\.org\/t\/p\/w1280\/land-before-time-(?:provisional|definitive)\.jpg/,
            (route) => {
            backdropLoads++;
            return route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' });
            });

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect.poll(() => artists).toEqual([null]);
        await expect.poll(() => backdropLoads).toBe(1);
        const preparedBackdrop = page.locator(
            `#movieA[src="${provisionalBackdrop}"], #movieB[src="${provisionalBackdrop}"]`);
        await expect(preparedBackdrop).toHaveCount(1);
        await expect(preparedBackdrop).not.toHaveClass(/show/);
        await expect.poll(() => preparedBackdrop.evaluate((image) =>
            image.complete && image.naturalWidth > 0)).toBe(true);
        current = {
            Album: "Land Before Time, The", Track: "The Great Migration",
            Artist: "James Horner", CoverLink: nextCover, Length: 180000,
            PlayStart: "2026-08-21T12:00:00Z", SystemTime: "2026-08-21T12:00:00Z",
        };
        await page.locator('input[name="station"][value="sst"]').evaluate((input) =>
            input.dispatchEvent(new Event("change", { bubbles: true })));

        await expect(page.locator("#info-title")).toContainText("The Land Before Time");
        await expect.poll(() => artists).toEqual([null, "James Horner"]);
        await expect(page.locator("#movieA.show, #movieB.show"))
            .toHaveAttribute("src", definitiveBackdrop);
        expect(backdropLoads).toBe(2);
        await expect(page.locator(
            `#movieA.show[src="${provisionalBackdrop}"], #movieB.show[src="${provisionalBackdrop}"]`))
            .toHaveCount(0);
    });
    test("shows and keeps prefetched backdrop and rating through empty revalidation",
        async ({ page }) => {
            const cover = "https://streamingsoundtracks.com/images/cover/promoted.svg";
            const sizedCover = "https://streamingsoundtracks.com/images/cover/500/promoted.svg";
            const prefetchedBackdrop = "https://image.tmdb.org/t/p/w1280/promoted-prefetch.jpg";
            let current = {
                Album: "Station ID", Track: "", Artist: "24seven.fm", CoverLink: "",
                Length: 3600000, PlayStart: "2026-08-24T00:00:00Z",
                SystemTime: "2026-08-24T00:00:00Z",
            };
            const resolverArtists = [];
            let releaseDefinitive;
            const definitiveMayFinish = new Promise((resolve) => { releaseDefinitive = resolve; });
            await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
                JSON.stringify({
                    sstBackdrops: { enabled: true,
                        options: { providers: ["tmdb"], cover: "show" } },
                    sstRatings: { enabled: true,
                        options: { countries: ["DE", "US"] } },
                })));
            await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*",
                (route) => {
                    const action = new URL(route.request().url()).searchParams.get("action");
                    if (action === "GetQueue") return route.fulfill({ json:
                        current.Album === "Station ID" ? [{
                            Album: "Promoted Movie", Track: "Opening Cue",
                            Artist: "Queued Composer", CoverLink: cover,
                        }] : [] });
                    return route.fulfill({ json: current });
                });
            await page.route("https://streamingsoundtracks.com/images/logos/*", (route) =>
                route.fulfill({ status: 200, contentType: "image/svg+xml",
                    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
            await page.route(sizedCover, (route) => route.fulfill({ status: 200,
                contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
            await page.route(/\/api\/tint\?/, (route) =>
                route.fulfill({ json: { tint: [40, 50, 60] } }));
            await page.route(/\/api\/backdrop\?/, async (route) => {
                const artist = new URL(route.request().url()).searchParams.get("artist");
                resolverArtists.push(artist);
                if (artist === "Authoritative Composer") await definitiveMayFinish;
                const definitive = artist === "Authoritative Composer";
                return route.fulfill({ json: {
                    media: definitive ? null
                        : { id: 88, title: "Promoted Movie", type: "movie" },
                    backdrop: definitive ? null : prefetchedBackdrop,
                    source: definitive ? null : "tmdb",
                    tint: definitive ? [255, 255, 255] : [60, 70, 80],
                    certifications: definitive ? [] : [{ country: "DE", system: "FSK",
                        rating: "12", label: "FSK 12",
                        logo: "https://upload.wikimedia.org/wikipedia/commons/6/6e/FSK_12.svg" }],
                } });
            });
            await page.route(prefetchedBackdrop,
                (route) => route.fulfill({ status: 200, contentType: "image/svg+xml",
                    body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"/>' }));
            await page.route("https://upload.wikimedia.org/wikipedia/commons/6/6e/FSK_12.svg",
                (route) => route.fulfill({ status: 200, contentType: "image/svg+xml",
                    body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>' }));

            await page.goto("/player.html", { waitUntil: "domcontentloaded" });
            await expect.poll(() => resolverArtists).toEqual(["Queued Composer"]);
            const preparedBackdrop = page.locator(
                `#movieA[src="${prefetchedBackdrop}"], #movieB[src="${prefetchedBackdrop}"]`);
            await expect(preparedBackdrop).toHaveCount(1);
            await expect.poll(() => preparedBackdrop.evaluate((image) =>
                image.complete && image.naturalWidth > 0)).toBe(true);

            current = {
                Album: "Promoted Movie", Track: "Opening Cue", Artist: "Authoritative Composer",
                CoverLink: cover, Length: 180000, PlayStart: "2026-08-24T00:00:00Z",
                SystemTime: "2026-08-24T00:00:00Z",
            };
            await page.waitForTimeout(2100);
            await page.evaluate(() => window.dispatchEvent(new Event("focus")));
            await expect.poll(() => resolverArtists)
                .toEqual(["Queued Composer", "Authoritative Composer"]);

            // The authoritative lookup is still blocked: these are necessarily the
            // promoted queue result rather than a fast second response.
            await expect(page.locator("#movieA.show, #movieB.show"))
                .toHaveAttribute("src", prefetchedBackdrop);
            await expect(page.locator("#rating-de")).toHaveClass(/show/);
            await expect(page.locator("#rating-de")).toContainText("FSK 12");

            const emptyResponse = page.waitForResponse((response) =>
                response.url().includes("/api/backdrop?")
                && new URL(response.url()).searchParams.get("artist")
                    === "Authoritative Composer");
            releaseDefinitive();
            await emptyResponse;
            await page.waitForTimeout(100);
            await expect(page.locator("#movieA.show, #movieB.show"))
                .toHaveAttribute("src", prefetchedBackdrop);
            await expect(page.locator("#rating-de")).toHaveClass(/show/);
            await expect(page.locator("#rating-de")).toContainText("FSK 12");
        });
    test("retries a prefetched title miss when now-playing supplies the artist", async ({ page }) => {
        const nextCover = "https://streamingsoundtracks.com/images/cover/composer-fallback.svg";
        const nextSized = "https://streamingsoundtracks.com/images/cover/500/composer-fallback.svg";
        const backdrop = "https://image.tmdb.org/t/p/w1280/composer-fallback.jpg";
        let current = {
            Album: "Station ID", Track: "", Artist: "24seven.fm", CoverLink: "",
            Length: 3600000, PlayStart: "2026-08-21T12:00:00Z",
            SystemTime: "2026-08-21T12:00:00Z",
        };
        const artists = [];
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ sstBackdrops: { enabled: true, options: { providers: ["tmdb"], cover: "show" } } })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [{
                Album: "Unmatched Sketchbook", Track: "Opening", CoverLink: nextCover,
            }] });
            return route.fulfill({ json: current });
        });
        await page.route("https://streamingsoundtracks.com/images/logos/*", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(nextSized, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/backdrop\?/, (route) => {
            const artist = new URL(route.request().url()).searchParams.get("artist");
            artists.push(artist);
            if (!artist) return route.fulfill({ json: {
                media: null, backdrop: null, source: null, tint: [255, 255, 255],
            } });
            return route.fulfill({ json: {
                media: { id: 7, title: "Unmatched", type: "movie" },
                backdrop, source: "tmdb", tint: [120, 140, 160],
            } });
        });
        await page.route(backdrop, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect.poll(() => artists).toEqual([null]);

        current = {
            Album: "Unmatched Sketchbook", Track: "Opening", Artist: "Known Composer",
            CoverLink: nextCover, Length: 180000, PlayStart: "2026-08-21T12:00:00Z",
            SystemTime: "2026-08-21T12:00:00Z",
        };
        await page.locator('input[name="station"][value="sst"]').evaluate((input) =>
            input.dispatchEvent(new Event("change", { bubbles: true })));

        await expect.poll(() => artists).toEqual([null, "Known Composer"]);
        await expect(page.locator("#movieA.show, #movieB.show")).toHaveAttribute(
            "src", /composer-fallback\.jpg/);
    });
    test("does not request TMDB art when that provider is disabled", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/no-fallback.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/no-fallback.svg";
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ sstBackdrops: { enabled: true, options: { providers: ["fanart", "steamgriddb"], cover: "show" } }, fanartKey: "fanart-key" })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "No Fallback", Track: "", Artist: "24seven.fm",
                CoverLink: cover, Length: 0,
                PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route(sizedCover, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/backdrop\?/, (route) => {
            const providers = new URL(route.request().url()).searchParams.get("providers").split(",");
            expect(providers).toContain("fanart");
            expect(providers).toContain("steamgriddb");
            expect(providers).not.toContain("tmdb");
            return route.fulfill({ json: {
                movie: { id: 21, title: "No Fallback" },
                backdrop: null, source: null, tint: [255, 255, 255],
            } });
        });

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect(page.locator("#status")).toHaveText("");
        await expect(page.locator("#movieA.show, #movieB.show")).toHaveCount(0);
        await expect(page.locator('.provider[data-provider="tmdb"] input')).not.toBeChecked();
    });
    test("re-resolves cached art after the fanart personal key changes", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/fanart-retry.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/fanart-retry.svg";
        let resolverRequests = 0, lastPersonalKey = "";
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ sstBackdrops: { enabled: true, options: { providers: ["fanart", "tmdb", "steamgriddb"], cover: "show" } },
                fanartKey: "fanart-key" })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Fanart Retry", Track: "", Artist: "24seven.fm",
                CoverLink: cover, Length: 0,
                PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route(sizedCover, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/backdrop\?/, (route) => {
            resolverRequests++;
            lastPersonalKey = new URL(route.request().url()).searchParams.get("client_key");
            const first = resolverRequests === 1;
            return route.fulfill({ json: {
                movie: { id: 9, title: "Fanart Retry" },
                backdrop: first
                    ? "https://image.tmdb.org/t/p/w1280/tmdb-fallback.jpg"
                    : "https://fanart.tv/fanart-retry.jpg",
                source: first ? "tmdb" : "fanart", tint: [240, 240, 240],
            } });
        });
        await page.route("https://image.tmdb.org/t/p/w1280/tmdb-fallback.jpg", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route("https://fanart.tv/fanart-retry.jpg", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect.poll(() => resolverRequests).toBe(1);
        await expect(page.locator("#movieA.show, #movieB.show")).toHaveAttribute("src", /tmdb-fallback/);
        await page.locator("#fanart-key").evaluate((input) => {
            input.value = "new-personal-key";
            input.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await expect.poll(() => resolverRequests).toBe(2);
        expect(lastPersonalKey).toBe("new-personal-key");
        await expect(page.locator("#movieA.show, #movieB.show")).toHaveAttribute("src", /fanart-retry/);
    });

    test("re-resolves cached art after provider priority or enablement changes", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/provider-refresh.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/provider-refresh.svg";
        const providerRequests = [];
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ sstBackdrops: { enabled: true, options: { providers: ["fanart", "tmdb", "steamgriddb"], cover: "show" } } })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Provider Refresh", Track: "Main Theme", Artist: "Test Composer",
                CoverLink: cover, Length: 0,
                PlayStart: "2026-08-21T12:00:00Z", SystemTime: "2026-08-21T12:00:00Z",
            } });
        });
        await page.route(sizedCover, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/backdrop\?/, (route) => {
            const providers = new URL(route.request().url()).searchParams.get("providers").split(",");
            providerRequests.push(providers);
            const first = providers[0];
            const backdrop = first === "tmdb"
                ? "https://image.tmdb.org/t/p/w1280/tmdb-priority.jpg"
                : `https://fanart.tv/fanart-priority-${providerRequests.length}.jpg`;
            return route.fulfill({ json: {
                media: { id: 22, title: "Provider Refresh", type: "movie" },
                backdrop, source: first, tint: [240, 240, 240],
            } });
        });
        await page.route(/https:\/\/(image\.tmdb\.org\/t\/p\/w1280|fanart\.tv)\//, (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect.poll(() => providerRequests).toEqual([
            ["fanart", "tmdb", "steamgriddb"],
        ]);
        await expect(page.locator("#movieA.show, #movieB.show"))
            .toHaveAttribute("src", /fanart-priority-1/);

        await openBackdropSettings(page);
        await page.locator('.provider[data-provider="fanart"] .grip').press("ArrowDown");
        await expect.poll(() => providerRequests).toEqual([
            ["fanart", "tmdb", "steamgriddb"],
            ["tmdb", "fanart", "steamgriddb"],
        ]);
        await expect(page.locator("#movieA.show, #movieB.show"))
            .toHaveAttribute("src", /tmdb-priority/);

        await page.locator("#tmdbart-on").uncheck();
        await expect.poll(() => providerRequests).toEqual([
            ["fanart", "tmdb", "steamgriddb"],
            ["tmdb", "fanart", "steamgriddb"],
            ["fanart", "steamgriddb"],
        ]);
        await expect(page.locator("#movieA.show, #movieB.show"))
            .toHaveAttribute("src", /fanart-priority-3/);

        await page.locator("#tmdbart-on").check();
        await expect(page.locator("#movieA.show, #movieB.show"))
            .toHaveAttribute("src", /tmdb-priority/);
        expect(providerRequests).toHaveLength(3);

        await page.locator('.provider[data-provider="fanart"] .grip').press("ArrowUp");
        await expect(page.locator("#movieA.show, #movieB.show"))
            .toHaveAttribute("src", /fanart-priority-1/);
        expect(providerRequests).toHaveLength(3);
    });

    test("keeps the final provider variant when a superseded lookup finishes", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/provider-race.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/provider-race.svg";
        const providerRequests = [];
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ sstBackdrops: { enabled: true, options: { providers: ["fanart", "tmdb"], cover: "show" } } })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Provider Race", Track: "Final Theme", Artist: "Test Composer",
                CoverLink: cover, Length: 0,
                PlayStart: "2026-08-21T12:00:00Z", SystemTime: "2026-08-21T12:00:00Z",
            } });
        });
        await page.route(sizedCover, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/backdrop\?/, async (route) => {
            const providers = new URL(route.request().url()).searchParams.get("providers");
            providerRequests.push(providers);
            if (providers === "tmdb") await new Promise((resolve) => setTimeout(resolve, 400));
            const fanart = providers.startsWith("fanart");
            return route.fulfill({ json: {
                media: { id: 23, title: "Provider Race", type: "movie" },
                backdrop: fanart ? "https://fanart.tv/provider-final.jpg"
                    : "https://image.tmdb.org/t/p/w1280/provider-stale.jpg",
                source: fanart ? "fanart" : "tmdb", tint: [240, 240, 240],
            } }).catch(() => {});
        });
        await page.route(/https:\/\/(image\.tmdb\.org\/t\/p\/w1280|fanart\.tv)\//, (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect(page.locator("#movieA.show, #movieB.show"))
            .toHaveAttribute("src", /provider-final/);

        await openBackdropSettings(page);
        await page.locator("#fanart-on").uncheck();
        await expect.poll(() => providerRequests).toEqual(["fanart,tmdb", "tmdb"]);
        await page.locator("#fanart-on").check();
        await page.waitForTimeout(600);

        expect(providerRequests).toEqual(["fanart,tmdb", "tmdb"]);
        await expect(page.locator("#movieA.show, #movieB.show"))
            .toHaveAttribute("src", /provider-final/);
    });

    virtualClockTest("times out a stalled queue prefetch independently", async ({ page }) => {
        await page.clock.install();
        await page.addInitScript(() => {
            window.__queueStarted = false;
            window.__queueAborted = false;
            const nativeFetch = window.fetch;
            window.fetch = function (url, init) {
                if (String(url).includes("action=GetQueue")) {
                    window.__queueStarted = true;
                    return new Promise((resolve, reject) => {
                        init.signal.addEventListener("abort", () => {
                            window.__queueAborted = true;
                            reject(new DOMException("Aborted", "AbortError"));
                        }, { once: true });
                    });
                }
                return nativeFetch.apply(this, arguments);
            };
        });
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) =>
            route.fulfill({ json: {
                Album: "Station ID", Track: "", Artist: "24seven.fm", CoverLink: "",
                Length: 3600000, PlayStart: "2026-08-13T12:00:00Z",
                SystemTime: "2026-08-13T12:00:00Z",
            } }));
        await page.route("https://streamingsoundtracks.com/images/logos/*", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect.poll(() => page.evaluate(() => window.__queueStarted)).toBe(true);
        await page.clock.fastForward(20001);
        await expect.poll(() => page.evaluate(() => window.__queueAborted)).toBe(true);
    });
    virtualClockTest("times out a stalled prefetched resolver lookup", async ({ page }) => {
        const nextCover = "https://streamingsoundtracks.com/images/cover/art-timeout.svg";
        const nextSized = "https://streamingsoundtracks.com/images/cover/500/art-timeout.svg";
        await page.clock.install();
        await page.addInitScript(() => {
            localStorage.setItem("24sevenfm-covers.player.v2", JSON.stringify({
                sstBackdrops: { enabled: true, options: { providers: ["fanart", "tmdb", "steamgriddb"], cover: "show" } },
                fanartKey: "fanart-timeout-key",
            }));
            window.__resolverStarted = false;
            window.__resolverAborted = false;
            const nativeFetch = window.fetch;
            window.fetch = function (url, init) {
                if (String(url).includes("/api/backdrop?")) {
                    window.__resolverStarted = true;
                    return new Promise((resolve, reject) => {
                        const abort = () => {
                            window.__resolverAborted = true;
                            reject(new DOMException("Aborted", "AbortError"));
                        };
                        const signal = init && init.signal;
                        if (signal && signal.aborted) abort();
                        else if (signal) signal.addEventListener("abort", abort, { once: true });
                    });
                }
                return nativeFetch.apply(this, arguments);
            };
        });
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [{
                Album: "Next Movie", CoverLink: nextCover,
            }] });
            return route.fulfill({ json: {
                Album: "Station ID", Track: "", Artist: "24seven.fm", CoverLink: "",
                Length: 3600000, PlayStart: "2026-08-13T12:00:00Z",
                SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route("https://streamingsoundtracks.com/images/logos/*", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(nextSized, (route) => route.fulfill({ status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect.poll(() => page.evaluate(() => window.__resolverStarted)).toBe(true);
        await page.clock.fastForward(20001);
        await expect.poll(() => page.evaluate(() => window.__resolverAborted)).toBe(true);
    });
    test("lazy-loads the seven-tap cover game, lets the listener size the deck, and tracks downloads", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.setViewportSize({ width: 1280, height: 720 });
        const memoryAssets = [];
        let historyRequests = 0;
        let historyCoverRequests = 0;
        page.on("request", (request) => {
            if (/memory-game\.(js|css)/.test(request.url())) memoryAssets.push(request.url());
        });
        const queue = Array.from({ length: 6 }, (_, index) => ({
            Album: `Upcoming ${index + 1}`,
            Track: `Queue cue ${index + 1}`,
            CoverLink: `https://streamingsoundtracks.com/images/cover/game-queue-${index + 1}.svg`,
        }));
        const history = Array.from({ length: 6 }, (_, index) => ({
            Album: `History ${index + 1}`,
            Track: `Played cue ${index + 1}`,
            CoverLink: `https://streamingsoundtracks.com/images/cover/game-history-${index + 1}.svg`,
        }));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: queue });
            if (action === "GetHistory") {
                historyRequests++;
                return route.fulfill({ json: history });
            }
            return route.fulfill({ json: {
                Album: "Station ID", Track: "", Artist: "24seven.fm", CoverLink: "", Length: 0,
                PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route("https://streamingsoundtracks.com/images/logos/*", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#7c5cff"/></svg>' }));
        await page.route("https://streamingsoundtracks.com/images/cover/500/game-*.svg", async (route) => {
            if (route.request().url().includes("game-history")) historyCoverRequests++;
            await new Promise((resolve) => setTimeout(resolve, 450));
            const hue = Math.abs(route.request().url().split("").reduce(
                (sum, character) => sum + character.charCodeAt(0), 0)) % 360;
            return route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="hsl(${hue} 70% 45%)"/></svg>` });
        });

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        for (let tap = 0; tap < 6; tap++) await page.locator("#coverbox").click();
        expect(memoryAssets).toEqual([]);
        expect(historyRequests).toBe(0);
        await expect(page.locator(".memory-game-overlay")).toHaveCount(0);

        await page.locator("#coverbox").click();
        const dialog = page.getByRole("dialog", { name: "Cover Memory" });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole("heading", { name: "How many covers?" })).toBeVisible();
        expect(memoryAssets.some((url) => url.includes("memory-game.js"))).toBe(true);
        expect(memoryAssets.some((url) => url.includes("memory-game.css"))).toBe(true);
        expect(historyRequests).toBe(1);
        expect(historyCoverRequests).toBe(0);
        await expect(dialog.locator(".memory-game-size-choice")).toHaveCount(6);

        await dialog.getByRole("button", { name: "10 covers, 20 cards" }).click();
        await dialog.getByRole("button", { name: "Deal 10 pairs" }).click();
        const progress = dialog.getByRole("progressbar", { name: "Cover downloads" });
        await expect(progress).toBeVisible();
        await expect(progress).toHaveAttribute("aria-valuemax", "10");
        await expect(dialog.locator(".memory-game-card-stack")).toBeVisible();

        const cards = dialog.locator(".memory-game-card");
        await expect(cards).toHaveCount(20);
        await expect(dialog.locator(".memory-game-card-back img")).toHaveCount(20);
        expect(historyCoverRequests).toBeGreaterThan(0);
        const gameGeometry = await dialog.evaluate((element) => {
            const viewport = element.querySelector(".memory-game-viewport");
            const shell = element.getBoundingClientRect();
            const header = element.querySelector(".memory-game-header").getBoundingClientRect();
            const board = element.querySelector(".memory-game-board").getBoundingClientRect();
            return {
                overflowY: getComputedStyle(viewport).overflowY,
                viewportClientHeight: viewport.clientHeight,
                viewportScrollHeight: viewport.scrollHeight,
                shellTop: shell.top,
                shellBottom: shell.bottom,
                headerTop: header.top,
                boardBottom: board.bottom,
                windowHeight: window.innerHeight,
            };
        });
        expect(gameGeometry.overflowY).toBe("hidden");
        expect(gameGeometry.viewportScrollHeight).toBeLessThanOrEqual(
            gameGeometry.viewportClientHeight + 1);
        expect(gameGeometry.shellTop).toBeLessThanOrEqual(20);
        expect(gameGeometry.headerTop - gameGeometry.shellTop).toBeLessThanOrEqual(2);
        expect(gameGeometry.shellBottom).toBeLessThanOrEqual(gameGeometry.windowHeight);
        expect(gameGeometry.boardBottom).toBeLessThanOrEqual(gameGeometry.shellBottom - 6);
        const pairCounts = await cards.evaluateAll((elements) => elements.reduce((counts, card) => {
            counts[card.dataset.pair] = (counts[card.dataset.pair] || 0) + 1;
            return counts;
        }, {}));
        expect(Object.values(pairCounts)).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);

        for (const pair of Object.keys(pairCounts)) {
            const pairCards = dialog.locator(`.memory-game-card[data-pair="${pair}"]`);
            await pairCards.nth(0).click();
            await pairCards.nth(1).click();
            await expect(pairCards.nth(0)).toHaveClass(/is-matched/);
        }
        await expect(dialog.getByRole("button", { name: "Play again" })).toBeVisible();
        await expect(dialog.locator(".memory-game-pairs")).toHaveText("10 / 10");

        await page.keyboard.press("Escape");
        await expect(page.locator(".memory-game-overlay")).toHaveCount(0);

        // A smaller queue snapshot shortens the picker instead of offering empty decks.
        queue.length = 4;
        history.length = 3;
        await page.reload({ waitUntil: "domcontentloaded" });
        for (let tap = 0; tap < 7; tap++) await page.locator("#coverbox").click();
        const cappedDialog = page.getByRole("dialog", { name: "Cover Memory" });
        await expect(cappedDialog.getByRole("heading", { name: "How many covers?" })).toBeVisible();
        await expect(cappedDialog).toContainText("Pick 5–7 covers");
        await expect(cappedDialog.locator(".memory-game-size-choice")).toHaveCount(3);
    });

    async function mockProviderTestFeed(page) {
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Station ID", Track: "", Artist: "24seven.fm", CoverLink: "", Length: 0,
                PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route("https://streamingsoundtracks.com/images/logos/*", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
    }

    async function laserHasPixels(lasers) {
        return lasers.evaluate((canvas) => {
            if (canvas.dataset.renderer === "webgl") {
                const gl = canvas.getContext("webgl");
                if (!gl || !Number(canvas.dataset.frame)) return false;
                const sampleHeight = Math.min(48, canvas.height);
                const pixels = new Uint8Array(canvas.width * sampleHeight * 4);
                gl.readPixels(0, 0, canvas.width, sampleHeight,
                    gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                return pixels.some(Boolean);
            }
            const context = canvas.getContext("2d");
            return context && context.getImageData(0, 0, canvas.width, canvas.height)
                .data.some(Boolean);
        });
    }

    async function mockLayoutTestFeed(page) {
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Layout Test", Track: "", Artist: "24seven.fm", CoverLink: "",
                Length: 600000, PlayStart: "2026-08-13T12:00:00Z",
                SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route("https://streamingsoundtracks.com/images/logos/*", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
    }

    async function posterMetrics(page) {
        return page.locator("#stage").evaluate((stage) => {
            const cover = stage.querySelector("#coverbox");
            const info = stage.querySelector(".info");
            const countdown = stage.querySelector("#countdown");
            const stageRect = stage.getBoundingClientRect();
            const coverRect = cover.getBoundingClientRect();
            const infoRect = info.getBoundingClientRect();
            const coverShift = parseFloat(getComputedStyle(stage)
                .getPropertyValue("--cover-shift")) || 0;
            return {
                stageTop: stageRect.top,
                stageHeight: stageRect.height,
                coverTop: coverRect.top,
                coverBottom: coverRect.bottom,
                coverWidth: coverRect.width,
                coverHeight: coverRect.height,
                infoTop: infoRect.top,
                infoHeight: infoRect.height,
                infoCenter: infoRect.top + infoRect.height / 2,
                expectedInfoCenter: stageRect.top + stageRect.height * .86,
                topGap: coverRect.top - stageRect.top,
                lowerGap: infoRect.top - coverRect.bottom,
                coverShift,
                expectedCoverShift: stageRect.height * .07 - infoRect.height * .25,
                countdownMaxHeight: parseFloat(getComputedStyle(countdown).maxHeight) || 0,
                countdownVisibility: getComputedStyle(countdown).visibility,
            };
        });
    }

    async function expectBalancedPoster(page) {
        await stableElementRects(page, {
            stage: "#stage", cover: "#coverbox", info: ".info", countdown: "#countdown",
        });
        const metrics = await posterMetrics(page);
        expect(Math.abs(metrics.topGap - metrics.lowerGap)).toBeLessThan(2.5);
        return metrics;
    }

    test("animates poster info height around a fixed center and keeps the cover balanced",
        async ({ page }) => {
            await page.emulateMedia({ reducedMotion: "no-preference" });
            await mockLayoutTestFeed(page);
            await page.goto("/player.html", { waitUntil: "domcontentloaded" });
            await expect(page.locator("#info-title")).toContainText("Layout Test");

            const timeline = await page.evaluate(async () => {
                const stage = document.querySelector("#stage");
                const cover = document.querySelector("#coverbox");
                const info = document.querySelector(".info");
                const countdown = document.querySelector("#countdown");
                const countdownEnabled = document.querySelector("#remaining-time-enabled");
                const twoFrames = () => new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const sample = () => {
                    const stageRect = stage.getBoundingClientRect();
                    const coverRect = cover.getBoundingClientRect();
                    const infoRect = info.getBoundingClientRect();
                    const coverShift = parseFloat(getComputedStyle(stage)
                        .getPropertyValue("--cover-shift")) || 0;
                    return {
                        infoHeight: infoRect.height,
                        infoCenter: infoRect.top + infoRect.height / 2,
                        coverTop: coverRect.top,
                        coverWidth: coverRect.width,
                        coverHeight: coverRect.height,
                        topGap: coverRect.top - stageRect.top,
                        lowerGap: infoRect.top - coverRect.bottom,
                        coverShift,
                        expectedCoverShift: stageRect.height * .07 - infoRect.height * .25,
                        countdownVisibility: getComputedStyle(countdown).visibility,
                    };
                };
                const transitionNames = () => countdown.getAnimations()
                    .map((animation) => animation.transitionProperty)
                    .filter(Boolean);
                const pauseCountdownAtHalf = () => countdown.getAnimations()
                    .filter((animation) => ["max-height", "margin-top", "opacity"]
                        .includes(animation.transitionProperty))
                    .forEach((animation) => {
                        const timing = animation.effect.getComputedTiming();
                        animation.pause();
                        animation.currentTime = Number(timing.delay || 0)
                            + Number(timing.activeDuration || 0) * 0.5;
                    });
                const finishAndSettle = async () => {
                    for (let pass = 0; pass < 8; pass++) {
                        const running = stage.getAnimations({ subtree: true })
                            .filter((animation) => animation.playState === "running"
                                || animation.playState === "paused");
                        running.forEach((animation) => animation.finish());
                        await twoFrames();
                        if (!stage.getAnimations({ subtree: true }).some((animation) =>
                            animation.playState === "running"
                            || animation.playState === "paused")) return;
                    }
                    throw new Error("Poster transitions did not settle");
                };

                const collapsed = sample();
                countdownEnabled.checked = true;
                countdownEnabled.dispatchEvent(new Event("change", { bubbles: true }));
                await twoFrames();
                const expandingTransitions = transitionNames();
                pauseCountdownAtHalf();
                await twoFrames();
                const expanding = sample();
                await finishAndSettle();
                const expanded = sample();
                await twoFrames();
                const expandedSettled = sample();

                countdownEnabled.checked = false;
                countdownEnabled.dispatchEvent(new Event("change", { bubbles: true }));
                await twoFrames();
                const collapsingTransitions = transitionNames();
                pauseCountdownAtHalf();
                await twoFrames();
                const collapsing = sample();
                await finishAndSettle();
                const collapsedEnd = sample();
                await twoFrames();
                const collapsedSettled = sample();

                return {
                    collapsed, expandingTransitions, expanding, expanded, expandedSettled,
                    collapsingTransitions, collapsing, collapsedEnd, collapsedSettled,
                };
            });

            expect(timeline.expandingTransitions).toEqual(expect.arrayContaining(
                ["max-height", "margin-top", "opacity"]));
            expect(timeline.collapsingTransitions).toEqual(expect.arrayContaining(
                ["max-height", "margin-top", "opacity"]));
            expect(timeline.expanding.infoHeight).toBeGreaterThan(timeline.collapsed.infoHeight + 2);
            expect(timeline.expanding.infoHeight).toBeLessThan(timeline.expanded.infoHeight - 2);
            expect(timeline.collapsing.infoHeight).toBeLessThan(timeline.expanded.infoHeight - 2);
            expect(timeline.collapsing.infoHeight)
                .toBeGreaterThan(timeline.collapsedEnd.infoHeight + 2);
            expect(timeline.expanded.infoHeight)
                .toBeGreaterThan(timeline.collapsed.infoHeight + 15);
            expect(Math.abs(timeline.collapsedEnd.infoHeight - timeline.collapsed.infoHeight))
                .toBeLessThan(1);
            [
                timeline.expanding, timeline.expanded, timeline.expandedSettled,
                timeline.collapsing, timeline.collapsedEnd, timeline.collapsedSettled,
            ].forEach((metrics) => {
                expect(Math.abs(metrics.infoCenter - timeline.collapsed.infoCenter))
                    .toBeLessThan(1);
                expect(Math.abs(metrics.coverWidth - timeline.collapsed.coverWidth))
                    .toBeLessThan(.5);
                expect(Math.abs(metrics.coverHeight - timeline.collapsed.coverHeight))
                    .toBeLessThan(.5);
            });
            expect(timeline.expanded.countdownVisibility).toBe("visible");
            expect(timeline.collapsedEnd.countdownVisibility).toBe("hidden");
            expect(timeline.expandedSettled.topGap)
                .toBeLessThan(timeline.collapsedSettled.topGap - 2);
            expect(Math.abs(timeline.expandedSettled.topGap
                - timeline.expandedSettled.lowerGap)).toBeLessThan(2.5);
            expect(Math.abs(timeline.collapsedSettled.topGap
                - timeline.collapsedSettled.lowerGap)).toBeLessThan(2.5);
            expect(Math.abs(timeline.expandedSettled.coverShift
                - timeline.expandedSettled.expectedCoverShift)).toBeLessThan(.1);
            expect(Math.abs(timeline.collapsedSettled.coverShift
                - timeline.collapsedSettled.expectedCoverShift)).toBeLessThan(.1);
        });

    test("rebalances the poster cover after resizing and in fullscreen", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await mockLayoutTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect(page.locator("#info-title")).toContainText("Layout Test");
        await page.locator("#remaining-time-enabled").check();

        const embedded = await expectBalancedPoster(page);
        expect(Math.abs(embedded.coverWidth - embedded.coverHeight)).toBeLessThan(.5);
        expect(Math.abs(embedded.infoCenter - embedded.expectedInfoCenter)).toBeLessThan(1);
        expect(Math.abs(embedded.coverShift - embedded.expectedCoverShift)).toBeLessThan(.1);

        await page.setViewportSize({ width: 800, height: 600 });
        const resized = await expectBalancedPoster(page);
        expect(Math.abs(resized.coverWidth - resized.coverHeight)).toBeLessThan(.5);
        expect(Math.abs(resized.infoCenter - resized.expectedInfoCenter)).toBeLessThan(1);
        expect(Math.abs(resized.coverShift - resized.expectedCoverShift)).toBeLessThan(.1);
        expect(Math.abs(resized.stageHeight - embedded.stageHeight)).toBeGreaterThan(50);

        await page.locator("#fullscreen").click();
        await expect.poll(() => page.evaluate(() =>
            document.fullscreenElement && document.fullscreenElement.id)).toBe("stage");
        const fullscreen = await expectBalancedPoster(page);
        expect(Math.abs(fullscreen.stageTop)).toBeLessThan(1);
        expect(Math.abs(fullscreen.stageHeight - 600)).toBeLessThan(1);
        expect(Math.abs(fullscreen.coverWidth - fullscreen.coverHeight)).toBeLessThan(.5);
        expect(Math.abs(fullscreen.infoCenter - fullscreen.expectedInfoCenter)).toBeLessThan(1);
        expect(Math.abs(fullscreen.coverShift - fullscreen.expectedCoverShift)).toBeLessThan(.1);
        await page.evaluate(() => document.exitFullscreen());
    });

    test("makes poster height and cover-position changes instant for reduced motion",
        async ({ page }) => {
            await page.emulateMedia({ reducedMotion: "reduce" });
            await mockLayoutTestFeed(page);
            await page.goto("/player.html", { waitUntil: "domcontentloaded" });
            await expect(page.locator("#info-title")).toContainText("Layout Test");

            const result = await page.evaluate(async () => {
                const cover = document.querySelector("#coverbox");
                const info = document.querySelector(".info");
                const countdown = document.querySelector("#countdown");
                const countdownEnabled = document.querySelector("#remaining-time-enabled");
                const twoFrames = () => new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const infoHeight = () => info.getBoundingClientRect().height;

                const collapsedHeight = infoHeight();
                countdownEnabled.checked = true;
                countdownEnabled.dispatchEvent(new Event("change", { bubbles: true }));
                await twoFrames();
                const expandedHeight = infoHeight();
                const expandedAnimations = {
                    countdown: countdown.getAnimations().length,
                    cover: cover.getAnimations().length,
                };
                countdownEnabled.checked = false;
                countdownEnabled.dispatchEvent(new Event("change", { bubbles: true }));
                await twoFrames();

                return {
                    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
                    collapsedHeight,
                    expandedHeight,
                    collapsedAgainHeight: infoHeight(),
                    countdownDuration: getComputedStyle(countdown).transitionDuration,
                    coverDuration: getComputedStyle(cover).transitionDuration,
                    expandedAnimations,
                    collapsedAnimations: {
                        countdown: countdown.getAnimations().length,
                        cover: cover.getAnimations().length,
                    },
                };
            });

            expect(result.reducedMotion).toBe(true);
            expect(result.expandedHeight).toBeGreaterThan(result.collapsedHeight + 15);
            expect(Math.abs(result.collapsedAgainHeight - result.collapsedHeight)).toBeLessThan(1);
            expect(result.countdownDuration.split(",").every((duration) =>
                duration.trim() === "0s")).toBe(true);
            expect(result.coverDuration.split(",").every((duration) =>
                duration.trim() === "0s")).toBe(true);
            expect(result.expandedAnimations).toEqual({ countdown: 0, cover: 0 });
            expect(result.collapsedAnimations).toEqual({ countdown: 0, cover: 0 });
            await expectBalancedPoster(page);
        });
    test("clamps an invalid persisted volume before playback", async ({ page }) => {
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        await page.addInitScript(() => {
            localStorage.setItem("24sevenfm-covers.player.v2", JSON.stringify({ volume: 2 }));
            HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
            HTMLMediaElement.prototype.pause = function () {};
        });
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect(page.locator("#volume")).toHaveValue("1");
        await page.locator("#audio-toggle").click();
        expect(errors, "invalid storage must not throw from the media volume setter").toEqual([]);
        expect(await page.locator("#audio").evaluate((audio) => audio.volume)).toBe(1);
        await expect(page.locator("#audio-toggle")).toHaveAttribute("aria-pressed", "true");
    });

    test("normalizes persisted scalar options and invalid backdrop options", async ({ page }) => {
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({
                station: "unknown",
                layout: -7,
                transition: { enabled: 1,
                    options: { style: 99, durationMs: "not-a-number" } },
                remainingTime: { enabled: 1,
                    options: { mode: "unknown", size: 99 } },
                spectrumBars: 999,
                spectrumMode: "unknown",
                analyzerType: "unknown",
                oscilloscopeStyle: "unknown",
                milkdropPreset: "unknown",
                fanartKey: 42,
                sstBackdrops: { enabled: "1", options: "invalid" },
            })));
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });

        await expect(page.locator('input[name="station"][value="sst"]')).toBeChecked();
        await expect(page.locator("#stage")).toHaveClass(/layout-fill/);
        await expect(page.locator('input[name="transition"][value="3"]')).toBeChecked();
        await expect(page.locator("#fade")).toHaveValue("500");
        await expect(page.locator("#fade-val")).toHaveText("0.5 s");
        await expect(page.locator('input[name="cdsize"][value="small"]')).toBeChecked();
        await expect(page.locator("#spectrum-bars")).toHaveValue("64");
        await expect(page.locator('input[name="spectrum-mode"][value="tinted"]')).toBeChecked();
        await expect(page.locator(
            'input[name="analyzer-type"][value="spectrum"]')).toBeChecked();
        await expect(page.locator(
            'input[name="oscilloscope-style"][value="line"]')).toBeChecked();
        await expect(page.locator(
            'input[name="milkdrop-preset"][value="auto"]')).toBeChecked();
        await expect(page.locator("#fanart-key")).toHaveValue("");
        await expect(page.locator("#backdrops-enabled")).toBeChecked();
        expect(await page.locator("#providers > .provider")
            .evaluateAll((rows) => rows.map((row) => row.dataset.provider)))
            .toEqual(["fanart", "tmdb", "steamgriddb"]);
    });

    test("keeps the selected station in the URL across a reload", async ({ page }) => {
        await page.route(/https:\/\/(streamingsoundtracks\.com|death\.fm)\/soap\/FM24sevenJSON\.php\?/, (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Station ID", Track: "", Artist: "24seven.fm", CoverLink: "", Length: 0,
                PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route(/https:\/\/(streamingsoundtracks\.com|death\.fm)\/images\/logos\//, (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));

        await page.goto("/player.html?station=sst&campaign=canary#share",
            { waitUntil: "domcontentloaded" });
        const historyLength = await page.evaluate(() => history.length);
        expect(new URL(page.url()).searchParams.get("preset")).toBe("1");
        expect(new URL(page.url()).searchParams.get("campaign")).toBe("canary");
        await page.locator("label.seg", { hasText: "Death.FM" }).click();

        await expect.poll(() => new URL(page.url()).searchParams.get("station")).toBe("death");
        expect(new URL(page.url()).searchParams.get("campaign")).toBe("canary");
        expect(new URL(page.url()).hash).toBe("#share");
        expect(await page.evaluate(() => history.length)).toBe(historyLength);

        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.locator('input[name="station"][value="death"]')).toBeChecked();
        expect(new URL(page.url()).searchParams.get("station")).toBe("death");
    });

    test("shares a complete sparse preset without local secrets", async ({ page }) => {
        const recipientSettings = {
            station: "death",
            layout: 1,
            remainingTime: { enabled: true,
                options: { mode: "rolldown", size: "medium" } },
            sstBackdrops: { enabled: true, options: { providers: ["steamgriddb"], cover: "show" } },
            fanartKey: "recipient-secret",
        };
        await page.addInitScript((settings) => {
            localStorage.setItem("24sevenfm-covers.player.v2", JSON.stringify(settings));
            window.__copiedSettingsUrl = "";
            Object.defineProperty(window, "isSecureContext",
                { configurable: true, value: true });
            Object.defineProperty(navigator, "clipboard", {
                configurable: true,
                value: { writeText(value) {
                    window.__copiedSettingsUrl = value;
                    return Promise.resolve();
                } },
            });
        }, recipientSettings);
        await mockProviderTestFeed(page);
        await page.goto("/player.html?preset=1&station=sst&layout=fill"
            + "&remaining=countdown&remainingSize=large&comingNext=1"
            + "&sstBackdrops=1&sstBackdropProviders=tmdb,fanart"
            + "&sstBackdropCover=hide&sstRatings=1&sstRatingCountries=US&bpm=1",
        { waitUntil: "domcontentloaded" });

        await expect(page.locator('input[name="station"][value="sst"]')).toBeChecked();
        await expect(page.locator('input[name="layout"][value="0"]')).toBeChecked();
        await expect(page.locator(
            'input[name="remaining"][value="countdown"]')).toBeChecked();
        await expect(page.locator('input[name="cdsize"][value="large"]')).toBeChecked();
        await expect(page.locator("#show-coming-next")).toBeChecked();
        await expect(page.locator("#bpm-enabled")).toBeChecked();
        await expect(page.locator("#backdrops-enabled")).toBeChecked();
        await expect(page.locator("#tmdbart-on")).toBeChecked();
        await expect(page.locator("#fanart-on")).toBeChecked();
        await expect(page.locator("#steamgriddb-on")).not.toBeChecked();
        await expect(page.locator("#hide-cover")).toBeChecked();
        await expect(page.locator("#ratings-enabled")).toBeChecked();
        await expect(page.locator("#rating-de-enabled")).not.toBeChecked();
        await expect(page.locator("#rating-us-enabled")).toBeChecked();
        await expect(page.locator("#fanart-key")).toHaveValue("");
        expect(await page.locator("#providers > .provider").evaluateAll((rows) =>
            rows.map((row) => row.dataset.provider)))
            .toEqual(["tmdb", "fanart", "steamgriddb"]);
        expect(await page.evaluate(() => JSON.parse(
            localStorage.getItem("24sevenfm-covers.player.v2"))))
            .toEqual(recipientSettings);

        await page.locator("#share-settings").click();
        await expect(page.locator("#share-settings-status")).toHaveText(
            "Settings link copied.");
        const sharedUrl = new URL(await page.evaluate(() => window.__copiedSettingsUrl));
        expect(Object.fromEntries(sharedUrl.searchParams)).toEqual({
            preset: "1",
            station: "sst",
            layout: "fill",
            remaining: "countdown",
            remainingSize: "large",
            comingNext: "1",
            bpm: "1",
            sstBackdrops: "1",
            sstBackdropProviders: "tmdb,fanart",
            sstRatings: "1",
            sstRatingCountries: "US",
        });
        expect(sharedUrl.searchParams.has("fanartKey")).toBe(false);
        expect(sharedUrl.searchParams.has("remainingDisplay")).toBe(false);

        await openSettingsTab(page, "Visualizations");
        await page.locator("#bpm-enabled").uncheck();
        await expect.poll(() => new URL(page.url()).searchParams.has("bpm"))
            .toBe(false);
        await openSettingsTab(page, "Common");
        await page.locator("#remaining-time-enabled").uncheck();
        await expect.poll(() => new URL(page.url()).searchParams.has("remaining"))
            .toBe(false);
        expect(new URL(page.url()).searchParams.get("remainingSize")).toBe("large");
        const savedAfterEdit = await page.evaluate(() => JSON.parse(
            localStorage.getItem("24sevenfm-covers.player.v2")));
        expect(savedAfterEdit.remainingTime).toEqual({ enabled: false,
            options: { mode: "countdown", size: "large" } });

        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.locator("#remaining-time-enabled")).not.toBeChecked();
        await expect(page.locator('input[name="cdsize"][value="large"]')).toBeChecked();
    });

    test("starts from v2 defaults instead of migrating the old storage key", async ({ page }) => {
        let resolverRequests = 0;
        await page.addInitScript(() => {
            localStorage.removeItem("24sevenfm-covers.player.v2");
            localStorage.setItem("24sevenfm-covers.player", JSON.stringify({
                station: "death", layout: 0, tmdbBackdrops: 1,
                enabledProviders: ["tmdb"], hideCover: 1,
            }));
        });
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Privacy Movie", Track: "", Artist: "24seven.fm",
                CoverLink: "https://streamingsoundtracks.com/images/cover/privacy.svg", Length: 0,
                PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route("https://streamingsoundtracks.com/images/cover/500/privacy.svg", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route(/\/api\/backdrop\?/, (route) => {
            resolverRequests++;
            return route.abort();
        });

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect(page.locator('input[name="station"][value="sst"]')).toBeChecked();
        await expect(page.locator("#stage")).toHaveClass(/layout-poster/);
        await expect(page.locator("#backdrops-enabled")).not.toBeChecked();
        await expect(page.locator("#fanart-on")).toBeChecked();
        await expect(page.locator("#tmdbart-on")).toBeChecked();
        await expect(page.locator("#steamgriddb-on")).toBeChecked();
        await expect(page.locator("#remaining-time-enabled")).not.toBeChecked();
        await expect(page.locator("#show-coming-next")).not.toBeChecked();
        await expect(page.locator("#hide-cover")).toBeChecked();
        expect(await page.evaluate(() => localStorage.getItem(
            "24sevenfm-covers.player.v2"))).toBeNull();
        await page.waitForTimeout(100);
        expect(resolverRequests).toBe(0);
    });
    test("ignores a stale audio rejection after a station switch", async ({ page }) => {
        await page.addInitScript(() => {
            window.__plays = [];
            HTMLMediaElement.prototype.play = function () {
                const src = this.src;
                return new Promise((resolve, reject) => window.__plays.push({ src, resolve, reject }));
            };
            HTMLMediaElement.prototype.pause = function () {};
            HTMLMediaElement.prototype.load = function () {};
        });
        await page.route(/https:\/\/(streamingsoundtracks\.com|death\.fm)\/soap\/FM24sevenJSON\.php\?/, (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Station ID", Track: "", Artist: "24seven.fm", CoverLink: "", Length: 0,
                PlayStart: "2026-08-13T12:00:00Z", SystemTime: "2026-08-13T12:00:00Z",
            } });
        });
        await page.route(/https:\/\/(streamingsoundtracks\.com|death\.fm)\/images\/logos\//, (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await page.locator("#audio-toggle").click();
        await expect.poll(() => page.evaluate(() => window.__plays.length)).toBe(1);
        await page.locator("label.seg", { hasText: "Death.FM" }).click();
        await expect.poll(() => page.evaluate(() => window.__plays.length)).toBe(2);
        await page.evaluate(() => window.__plays[0].reject(new DOMException("superseded", "AbortError")));
        await page.waitForTimeout(100);
        await expect(page.locator("#audio-toggle")).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator("#audio")).toHaveAttribute("src", "https://death.fm/live");
        await page.evaluate(() => window.__plays[1].resolve());
    });
    test("reconnects audio when a playing stream remains stalled", async ({ page }) => {
        await page.addInitScript(() => {
            window.__plays = [];
            const nativeSetTimeout = window.setTimeout.bind(window);
            window.setTimeout = (callback, delay, ...args) =>
                nativeSetTimeout(callback, delay === 12000 ? 10 : delay, ...args);
            HTMLMediaElement.prototype.play = function () {
                window.__plays.push(this.src);
                return Promise.resolve();
            };
            HTMLMediaElement.prototype.pause = function () {};
            HTMLMediaElement.prototype.load = function () {};
        });
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await page.locator("#audio-toggle").click();
        await expect.poll(() => page.evaluate(() => window.__plays.length)).toBe(1);

        await page.locator("#audio").dispatchEvent("playing");
        await page.locator("#audio").dispatchEvent("waiting");
        await expect(page.locator("#status")).toHaveText("Audio interrupted – reconnecting…");
        expect(await page.evaluate(() => window.__plays.length)).toBe(1);

        await expect.poll(() => page.evaluate(() => window.__plays.length)).toBe(2);
        await expect(page.locator("#audio-toggle")).toHaveAttribute("aria-pressed", "true");
        await page.locator("#audio").dispatchEvent("playing");
        await expect(page.locator("#status")).toHaveText("");
        await page.locator("#audio-toggle").click();
    });
    test("keeps artwork-provider controls aligned with their public contract", async ({ page }) => {
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect(page.locator("#backdrops-enabled")).not.toBeChecked();
        await expect(page.locator("#backdrop-options")).toHaveAttribute("aria-hidden", "true");
        await expect(page.locator("#hide-cover")).toBeChecked();

        const providers = await page.locator("#providers > .provider").evaluateAll((rows) =>
            rows.map((row) => {
                const box = row.querySelector('input[type="checkbox"]');
                return {
                    id: row.dataset.provider,
                    label: row.querySelector("label").textContent.trim(),
                    controlId: box.id,
                    enabled: box.checked,
                    reorderLabel: row.querySelector(".grip").getAttribute("aria-label"),
                };
            }));
        expect(providers).toEqual([
            { id: "fanart", label: "fanart.tv", controlId: "fanart-on", enabled: true,
                reorderLabel: expect.stringMatching(/^Reorder fanart\.tv, position 1 of 3\./) },
            { id: "tmdb", label: "TMDB backdrops", controlId: "tmdbart-on", enabled: true,
                reorderLabel: expect.stringMatching(/^Reorder TMDB backdrops, position 2 of 3\./) },
            { id: "steamgriddb", label: "GameArt by SteamGridDB",
                controlId: "steamgriddb-on", enabled: true,
                reorderLabel: expect.stringMatching(/^Reorder GameArt by SteamGridDB, position 3 of 3\./) },
        ]);
    });
    test("persists provider enablement inside backdrop options", async ({ page }) => {
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ sstBackdrops: { enabled: true, options: { providers: ["tmdb"], cover: "show" } } })));
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await openBackdropSettings(page);

        await expect(page.locator("#fanart-on")).not.toBeChecked();
        await expect(page.locator("#tmdbart-on")).toBeChecked();
        await expect(page.locator("#steamgriddb-on")).not.toBeChecked();
        await page.locator("#fanart-on").check();

        const saved = await page.evaluate(() =>
            JSON.parse(localStorage.getItem("24sevenfm-covers.player.v2")));
        expect(saved.sstBackdrops).toEqual({ enabled: true,
            options: { providers: ["tmdb", "fanart"], cover: "show" } });
    });
    test("reorders and persists backdrop providers with the keyboard", async ({ page }) => {
        await page.addInitScript(() => {
            if (!localStorage.getItem("24sevenfm-covers.player.v2"))
                localStorage.setItem("24sevenfm-covers.player.v2", JSON.stringify({
                    sstBackdrops: { enabled: true, options: { providers: ["fanart", "tmdb", "steamgriddb"], cover: "show" } },
                }));
        });
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await openBackdropSettings(page);
        const order = () => page.locator("#providers > .provider")
            .evaluateAll((rows) => rows.map((row) => row.dataset.provider));
        const fanartGrip = page.locator('.provider[data-provider="fanart"] .grip');

        await fanartGrip.focus();
        await fanartGrip.press("ArrowDown");
        expect(await order()).toEqual(["tmdb", "fanart", "steamgriddb"]);
        await expect(fanartGrip).toBeFocused();
        await expect(fanartGrip).toHaveAttribute("aria-label", /position 2 of 3/);
        await expect(page.locator("#provider-status")).toHaveText("fanart.tv moved to position 2 of 3.");

        await page.reload({ waitUntil: "domcontentloaded" });
        await openBackdropSettings(page);
        expect(await order()).toEqual(["tmdb", "fanart", "steamgriddb"]);
        await fanartGrip.focus();
        await fanartGrip.press("ArrowUp");
        expect(await order()).toEqual(["fanart", "tmdb", "steamgriddb"]);
    });

    test("filters unknown provider IDs from v2 backdrop options", async ({ page }) => {
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player.v2",
            JSON.stringify({ sstBackdrops: { enabled: true,
                options: { providers: ["unknown", "tmdb"], cover: "show" } } })));
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await openBackdropSettings(page);
        const order = await page.locator("#providers > .provider")
            .evaluateAll((rows) => rows.map((row) => row.dataset.provider));
        expect(order).toEqual(["tmdb", "fanart", "steamgriddb"]);
    });

    test("keeps backdrop providers pointer-draggable", async ({ page }) => {
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await openBackdropSettings(page);
        await expect(page.locator("#providers")).toBeVisible();
        expect(await page.locator("#providers").evaluate((providers) =>
            !!(providers.compareDocumentPosition(document.querySelector("#hide-cover"))
                & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
        const dragged = page.locator('.provider[data-provider="fanart"]');
        const grip = dragged.locator(".grip");
        const target = page.locator('.provider[data-provider="tmdb"]');
        await grip.scrollIntoViewIfNeeded();
        const from = await grip.boundingBox(), to = await target.boundingBox();
        expect(from).not.toBeNull();
        expect(to).not.toBeNull();
        const themeBefore = await dragged.evaluate((row) => ({
            color: getComputedStyle(row).color,
            accent: getComputedStyle(row.querySelector('input[type="checkbox"]')).accentColor,
        }));

        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
        await page.mouse.down();
        const pointer = { x: to.x + to.width / 2, y: to.y + to.height * .75 };
        await page.mouse.move(pointer.x, pointer.y, { steps: 5 });
        const floatingGrip = await grip.boundingBox();
        expect(Math.abs(floatingGrip.x + floatingGrip.width / 2 - pointer.x))
            .toBeLessThan(15);
        expect(Math.abs(floatingGrip.y + floatingGrip.height / 2 - pointer.y))
            .toBeLessThan(15);
        expect(await dragged.evaluate((row) => ({
            color: getComputedStyle(row).color,
            accent: getComputedStyle(row.querySelector('input[type="checkbox"]')).accentColor,
        }))).toEqual(themeBefore);
        await page.mouse.up();

        const order = await page.locator("#providers > .provider")
            .evaluateAll((rows) => rows.map((row) => row.dataset.provider));
        expect(order).toEqual(["tmdb", "fanart", "steamgriddb"]);
        await expect(page.locator("#provider-status")).toHaveText("fanart.tv moved to position 2 of 3.");
    });

    test("loads, polls the station, and renders a real cover", async ({ page }) => {
        test.skip(localMode, "requires the deployed site and live station contracts");
        const errors = [];
        const netlog = []; // every station response/failure the PAGE itself saw
        page.on("pageerror", (e) => errors.push(String(e)));
        page.on("response", (r) => {
            if (/FM24sevenJSON|\/images\/cover\//.test(r.url()))
                netlog.push(r.status() + " " + r.url().slice(0, 100));
        });
        page.on("requestfailed", (r) =>
            netlog.push("FAILED " + ((r.failure() || {}).errorText || "?") + " " + r.url().slice(0, 100)));
        await page.goto("/player.html");

        // A cover URL must arrive via the CORS fetch and actually decode to pixels.
        // The visible buffer is named by data-front on the box (see player.css).
        const front = page.locator(
            '.coverbox[data-front="a"] img:first-of-type, .coverbox[data-front="b"] img:last-of-type');
        try {
            await expect(front).toHaveAttribute("src", /\/images\/cover\//, { timeout: 60000 });
        } catch (e) {
            // The generic timeout says nothing - what the page's own station requests
            // returned is the actual diagnosis (403s = WAF gating the runner's IP).
            throw new Error("cover never arrived. Station traffic as seen by the page:\n"
                + (netlog.join("\n") || "(no station requests at all - JS broken?)")
                + "\n\noriginal: " + e.message);
        }
        await expect
            .poll(() => front.evaluate((img) => img.naturalWidth), { timeout: 30000 })
            .toBeGreaterThan(0);

        await expect(page.locator("#info-title")).not.toHaveText(/Loading|^—$/, { timeout: 30000 });
        expect(errors, "page must run without JS errors").toEqual([]);
    });

    test("poster layout shows the info box, and options survive a reload", async ({ page }) => {
        test.skip(localMode, "requires the deployed site and live station contracts");
        await page.goto("/player.html");
        await page.locator("label.seg", { hasText: "Poster" }).click();
        await expect(page.locator(".info")).toBeVisible();
        await expect(page.locator("#info-title")).not.toHaveText(/Loading/, { timeout: 60000 });

        await page.reload(); // localStorage must bring the layout back
        await expect(page.locator("#stage")).toHaveClass(/layout-poster/);
    });

    test("countdown appears when enabled", async ({ page }) => {
        test.skip(localMode, "requires the deployed site and live station contracts");
        await page.goto("/player.html");
        await page.locator(
            'label.seg:has(input[name="remaining"][value="countdown"])').click();
        await expect(page.locator("#info-title")).not.toHaveText(/Loading/, { timeout: 60000 });

        // No track length from the station means a hidden countdown IS the correct
        // behaviour (mirrors the apps) - skip rather than fail on a DJ stream.
        const hidden = await page.locator("#countdown").evaluate((el) => el.classList.contains("hidden"));
        test.skip(hidden, "station reported no track length - countdown correctly hidden");
        await expect(page.locator("#countdown")).toHaveText(/\d+:\d\d/);
    });

    test("switching station repolls and shows that station's cover", async ({ page }) => {
        test.skip(localMode, "requires the deployed site and live station contracts");
        const netlog = []; // death.fm traffic as the page saw it - the diagnosis on failure
        page.on("response", (r) => {
            if (/death\.fm/.test(r.url())) netlog.push(r.status() + " " + r.url().slice(0, 100));
        });
        page.on("requestfailed", (r) => {
            if (/death\.fm/.test(r.url()))
                netlog.push("FAILED " + ((r.failure() || {}).errorText || "?") + " " + r.url().slice(0, 100));
        });
        await page.goto("/player.html");
        await page.locator("label.seg", { hasText: "Death.FM" }).click();

        // A healthy switch shows a death.fm cover - but the station may legitimately
        // have none right now (station ID, unregistered track, or a feed outage like
        // 2026-08-13's "Could not connect to DB server"), and then the player's logo
        // fallback IS the correct behaviour. So: accept cover or logo first, and only
        // fail hard when neither ever appears (= the switch itself is broken).
        const front = page.locator(
            '.coverbox[data-front="a"] img:first-of-type, .coverbox[data-front="b"] img:last-of-type');
        try {
            await expect(front)
                .toHaveAttribute("src", /death\.fm\/images\/(cover|logos)/, { timeout: 60000 });
        } catch (e) {
            throw new Error("switching to death.fm produced neither a cover nor the logo "
                + "fallback. death.fm traffic as seen by the page:\n"
                + (netlog.join("\n") || "(no death.fm requests at all - switch broken?)")
                + "\n\noriginal: " + e.message);
        }
        if (/logos/.test(await front.getAttribute("src"))) {
            // Logo shown: verify the feed really offers no cover - mirroring the
            // countdown test, station-side absence is a skip, not a player failure.
            const feed = await page.evaluate(() =>
                fetch("https://death.fm/soap/FM24sevenJSON.php?action=GetCurrentlyPlaying&_t=" + Date.now())
                    .then((r) => r.json()).catch((e) => ({ error: String(e) })));
            test.skip(!feed.CoverLink, "death.fm reports no cover right now ("
                + (feed.error || "station ID / unregistered track") + ") - logo fallback is correct");
            // The feed HAS a cover yet the player kept the logo: that is a player bug.
            await expect(front)
                .toHaveAttribute("src", /death\.fm\/images\/cover/, { timeout: 60000 });
        }
    });
});

test.describe("station contracts, exercised like a real listener", () => {
    test.skip(localMode, "requires the deployed site and live station contracts");
    test("now-playing JSON: cross-origin fetch succeeds (= CORS grant) with the right shape", async ({ page }) => {
        await page.goto("/player.html");
        // Merely resolving proves the CORS contract: without Access-Control-Allow-Origin
        // the browser throws before any data is readable.
        const j = await page.evaluate((url) => fetch(url + Date.now()).then((r) => r.json()), JSON_URL);
        expect(j.CoverLink, "feed shape: CoverLink").toMatch(/^https?:\/\//);
        expect(j.Length, "feed shape: Length").toBeDefined();
        expect(j.SystemTime, "feed shape: SystemTime").toBeDefined();
    });

    test("the sized cover variant (/cover/500/) still decodes to pixels", async ({ page }) => {
        await page.goto("/player.html");
        const width = await page.evaluate((url) =>
            fetch(url + Date.now())
                .then((r) => r.json())
                .then((j) => new Promise((resolve, reject) => {
                    const img = new Image(); // images need no CORS - same path the player uses
                    img.onload = () => resolve(img.naturalWidth);
                    img.onerror = () => reject(new Error("cover failed to load: " + img.src));
                    img.src = j.CoverLink.replace("/cover/", "/cover/500/");
                })), JSON_URL);
        expect(width).toBeGreaterThan(0);
    });

    // Two hosts, not all five: enough to catch "the /live proxy is gone" without
    // quintupling the flake surface of a notoriously moody server. canplay from a
    // real <audio> element is the actual user experience, not a proxy for it.
    for (const host of ["streamingsoundtracks.com", "death.fm"]) {
        test(`HTTPS audio stream reaches canplay on ${host}/live`, async ({ page }) => {
            await page.goto("/player.html");
            const result = await page.evaluate((h) => new Promise((resolve) => {
                const a = new Audio("https://" + h + "/live");
                a.addEventListener("canplay", () => resolve("canplay"), { once: true });
                a.addEventListener("error", () =>
                    resolve("error code " + (a.error ? a.error.code : "?")), { once: true });
                setTimeout(() => resolve("timeout after 25s"), 25000);
                a.load(); // buffering needs no user gesture; only play() does
            }), host);
            expect(result, host).toBe("canplay");
        });
    }
});
