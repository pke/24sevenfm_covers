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
            "content", "https://24covers-api.vercel.app/api/backdrop?resolver_version=1");
        await expect(page.locator('meta[name="tint-api"]')).toHaveAttribute(
            "content", "https://24covers-api.vercel.app/api/tint");
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
            "information about the current and next queued title");
        await expect(page.locator("main")).toContainText(
            "If you press Check, the browser sends it directly to fanart.tv once");
        await expect(page.locator("main")).not.toContainText("Album and Track fields");

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect(page.locator("fieldset:has(#tmdb-on) > p.note"))
            .toContainText("information about the current and next queued title");
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
            await toggle.evaluate((input) => { input.checked = true; });
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
                    body: `export function createAudioSpectrumController() {
                        return { prepare() {}, sync() {} };
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
    test("defaults the tinted analyzer off and persists analyzer settings", async ({ page }) => {
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });

        const bars = page.locator("#spectrum-bars");
        const enabled = page.locator("#spectrum-enabled");
        await expect(enabled).not.toBeChecked();
        await expect(bars).toHaveValue("24");
        await expect(bars).toHaveAttribute("step", "8");
        await expect(bars).toBeDisabled();
        await expect(page.locator("#spectrum-bars-val")).toHaveText("24");
        await expect(page.locator('input[name="spectrum-mode"][value="tinted"]')).toBeChecked();

        await enabled.check();
        await expect(bars).toBeEnabled();
        await bars.evaluate((input) => {
            input.value = "48";
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await page.locator("label.seg", { hasText: "Legacy" }).click();
        await expect(page.locator("#spectrum-bars-val")).toHaveText("48");

        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(enabled).toBeChecked();
        await expect(bars).toHaveValue("48");
        await expect(page.locator("#spectrum-bars-val")).toHaveText("48");
        await expect(page.locator('input[name="spectrum-mode"][value="legacy"]')).toBeChecked();
    });
    test("persists scalar controls and reapplies their effects", async ({ page }) => {
        await mockLayoutTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });

        await page.locator('label.seg:has(input[name="layout"][value="0"])').click();
        await page.locator('label.seg:has(input[name="transition"][value="3"])').click();
        await page.locator('label.seg:has(input[name="cdsize"][value="2"])').click();
        await page.locator("#show-remaining").check();
        await page.locator("#roll").check();
        await page.locator("#tmdb-on").check();
        await page.locator("#hide-cover").check();
        await page.locator("#fade").evaluate((input) => {
            input.value = "1700";
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await page.locator("#volume").evaluate((input) => {
            input.value = "0.35";
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });

        await expect.poll(() => page.evaluate(() =>
            JSON.parse(localStorage.getItem("24sevenfm-covers.player"))))
            .toMatchObject({ layout: 0, transition: 3, remainingSize: 2,
                showRemaining: 1, roll: 1, tmdbBackdrops: 1, hideCover: 1,
                fadeMs: 1700, volume: 0.35 });
        await expect(page.locator("#stage")).toHaveClass(/layout-fill/);
        await expect(page.locator("#fade-val")).toHaveText("1.7 s");

        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.locator("#stage")).toHaveClass(/layout-fill/);
        await expect(page.locator('input[name="transition"][value="3"]')).toBeChecked();
        await expect(page.locator('input[name="cdsize"][value="2"]')).toBeChecked();
        await expect(page.locator("#show-remaining")).toBeChecked();
        await expect(page.locator("#roll")).toBeChecked();
        await expect(page.locator("#tmdb-on")).toBeChecked();
        await expect(page.locator("#hide-cover")).toBeChecked();
        await expect(page.locator("#fade")).toHaveValue("1700");
        await expect(page.locator("#fade-val")).toHaveText("1.7 s");
        await expect(page.locator("#volume")).toHaveValue("0.35");
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
            JSON.parse(localStorage.getItem("24sevenfm-covers.player")).station)).toBe("death");
        await expect(page.locator('input[name="station"][value="death"]')).toBeChecked();
    });
    test("binds the fanart personal key through the option schema", async ({ page }) => {
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ fanartKey: "initial-key" })));
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });

        const key = page.locator("#fanart-key");
        await expect(key).toHaveAttribute("data-option", "fanartKey");
        await expect(key).toHaveValue("initial-key");
        await key.fill("  updated-key  ");
        await key.dispatchEvent("change");
        await expect(key).toHaveValue("updated-key");
        await expect.poll(() => page.evaluate(() =>
            JSON.parse(localStorage.getItem("24sevenfm-covers.player")).fanartKey))
            .toBe("updated-key");
    });
    test("offers personal-key help below an empty fanart field", async ({ page }) => {
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });

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
            JSON.parse(localStorage.getItem("24sevenfm-covers.player")).fanartKeyVerifiedAt))
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
        await page.addInitScript((saved) => localStorage.setItem("24sevenfm-covers.player",
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
            JSON.parse(localStorage.getItem("24sevenfm-covers.player")).fanartKeyVerifiedAt))
            .toBe(verifiedAt);

        await check.click();
        await expect(check).toHaveText("Check");
        await expect.poll(() => page.evaluate(() =>
            JSON.parse(localStorage.getItem("24sevenfm-covers.player")).fanartKeyVerifiedAt))
            .toBe(0);

        await check.click();
        await expect(check).toHaveText("✓");
        await expect.poll(() => page.evaluate(() =>
            JSON.parse(localStorage.getItem("24sevenfm-covers.player")).fanartKeyVerifiedAt))
            .toBeGreaterThan(verifiedAt);
        expect(fanartRequests).toBe(3);

        await key.press("End");
        await key.press("x");
        await key.dispatchEvent("change");
        await expect(check).toHaveText("Check");
        await expect(check).toBeEnabled();
        await expect.poll(() => page.evaluate(() =>
            JSON.parse(localStorage.getItem("24sevenfm-covers.player")).fanartKeyVerifiedAt))
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
                const readBoxes = () => page.evaluate(() => {
                    const rect = (selector) =>
                        document.querySelector(selector).getBoundingClientRect().toJSON();
                    return { stage: rect("#stage"), spectrum: rect("#stage-spectrum"),
                        cover: rect("#coverbox"), info: rect(".info") };
                });
                // Fullscreen changes the stage before ResizeObserver has necessarily
                // recomputed the spectrum gap. Assert the settled geometry, not that
                // transient frame; the same non-overlap constraints still apply.
                await expect.poll(async () => {
                    const boxes = await readBoxes();
                    return boxes.spectrum.top >= boxes.cover.bottom - 1
                        && boxes.spectrum.bottom <= boxes.info.top + 1;
                }).toBe(true);
                const boxes = await readBoxes();
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
            await expect(page.locator(".controls > #spectrum-settings")).toHaveCount(1);

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
        let coverRequests = 0, pollRequests = 0;
        await page.clock.install();
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
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

        for (let i = 1; i <= 10; i++) {
            await page.clock.fastForward(6001);
            await expect.poll(() => pollRequests).toBe(i + 1);
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

        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ tmdbBackdrops: 1, enabledProviders: ["tmdb"], hideCover: 1 })));
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

    test("ignores a resolver result after movie backdrops are disabled", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/race.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/race.svg";
        let backdropRequested = false;
        await page.addInitScript(() => {
            localStorage.setItem("24sevenfm-covers.player", JSON.stringify({
                tmdbBackdrops: 1,
                enabledProviders: ["fanart", "tmdb", "steamgriddb"],
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
        await page.locator("label:has(#tmdb-on)").click();
        await expect.poll(() => page.evaluate(() => window.__resolverAborted)).toBe(true);
        await page.waitForTimeout(100);
        expect(backdropRequested).toBe(false);
        await expect(page.locator("#movieA.show, #movieB.show")).toHaveCount(0);
    });
    test("uses the server cover tint without enabling movie backdrops", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/cover-tint.jpg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/cover-tint.jpg";
        let tintRequests = 0, backdropRequests = 0, requestedCover = "";
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [] });
            return route.fulfill({ json: {
                Album: "Cover Tint", Track: "No Movie Art", Artist: "24seven.fm",
                CoverLink: cover, Length: 0,
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
        expect(requestedCover).toBe(cover);
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
        }));
        const requestedCovers = [];

        await page.route(/https:\/\/(?:streamingsoundtracks\.com|1980s\.fm|adagio\.fm|death\.fm|entranced\.fm)\/soap\/FM24sevenJSON\.php\?/, (route) => {
            const url = new URL(route.request().url());
            if (url.searchParams.get("action") === "GetQueue") return route.fulfill({ json: [] });
            const selected = stations.find((entry) => entry.host === url.hostname);
            return route.fulfill({ json: {
                Album: "Tint " + selected.name, Track: "", Artist: "24seven.fm",
                CoverLink: selected.cover, Length: 0,
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
            await expect.poll(() => requestedCovers.includes(selected.cover)).toBe(true);
        }
        expect(new Set(requestedCovers)).toEqual(new Set(stations.map((entry) => entry.cover)));
    });
    test("uses the server backdrop and tint without browser provider calls", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/arrival.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/arrival.svg";
        const backdrop = "https://image.tmdb.org/t/p/w1280/arrival.jpg";
        let resolverRequests = 0, directProviderRequests = 0;
        let resolvedAlbum = "", resolvedTrack = "", resolvedArtist = "", resolvedProviders = "";
        let resolverVersion = "";
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ tmdbBackdrops: 1,
                enabledProviders: ["fanart", "tmdb", "steamgriddb"] })));
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
        expect(resolverVersion).toBe("1");
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
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ tmdbBackdrops: 1,
                enabledProviders: ["fanart", "tmdb", "steamgriddb"] })));
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
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ tmdbBackdrops: 1,
                enabledProviders: ["fanart", "tmdb", "steamgriddb"],
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
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ tmdbBackdrops: 1,
                enabledProviders: ["tmdb", "steamgriddb"] })));
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
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ tmdbBackdrops: 1,
                enabledProviders: ["tmdb", "steamgriddb"] })));
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
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ tmdbBackdrops: 1,
                enabledProviders: ["fanart", "tmdb", "steamgriddb"] })));
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
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ tmdbBackdrops: 1,
                enabledProviders: ["fanart", "tmdb", "steamgriddb"] })));
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
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ tmdbBackdrops: 1,
                enabledProviders: ["tmdb", "steamgriddb"] })));
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
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ tmdbBackdrops: 1 })));
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
    test("offers an explanatory cache-bypassing retry after a backdrop outage", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/retry.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/retry.svg";
        const backdrop = "https://image.tmdb.org/t/p/w1280/retry.jpg";
        let resolverRequests = 0;
        let releaseRetry;
        const retryMayFinish = new Promise((resolve) => { releaseRetry = resolve; });
        await page.addInitScript(() => {
            localStorage.setItem("24sevenfm-covers.player",
                JSON.stringify({ tmdbBackdrops: 1, enabledProviders: ["tmdb"] }));
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
    test("rejects a non-string persisted fanart personal key", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/invalid-key.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/invalid-key.svg";
        let resolverRequests = 0;
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ tmdbBackdrops: 1, fanartKey: { key: "bad" } })));
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
            localStorage.setItem("24sevenfm-covers.player",
                JSON.stringify({ tmdbBackdrops: 1 }));
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
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ tmdbBackdrops: 1,
                enabledProviders: ["fanart", "tmdb", "steamgriddb"], hideCover: 1 })));
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
        await expect.poll(() => failedImages).toBe(1);
        await expect(page.locator("#movieA.show, #movieB.show")).toHaveCount(0);
        await expect(page.locator("#stage")).not.toHaveClass(/no-cover/);
        await expect.poll(() => page.locator("#stage").evaluate((stage) =>
            getComputedStyle(stage).getPropertyValue("--player-tint").trim()))
            .toBe("rgb(20, 40, 60)");
    });

    for (const status of [429, 500]) {
        test(`retries the resolver after a transient HTTP ${status}`, async ({ page }) => {
            const cover = "https://streamingsoundtracks.com/images/cover/retry.svg";
            const sizedCover = "https://streamingsoundtracks.com/images/cover/500/retry.svg";
            let resolverRequests = 0;
            await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
                JSON.stringify({ tmdbBackdrops: 1,
                    enabledProviders: ["tmdb", "steamgriddb"] })));
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
            const toggle = page.locator("label:has(#tmdb-on)");
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
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ tmdbBackdrops: 1,
                enabledProviders: ["fanart", "tmdb", "steamgriddb"],
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
    test("reuses prefetched backdrop art when the queue omits the artist", async ({ page }) => {
        const nextCover = "https://streamingsoundtracks.com/images/cover/land-before-time.svg";
        const nextSized = "https://streamingsoundtracks.com/images/cover/500/land-before-time.svg";
        const backdrop = "https://image.tmdb.org/t/p/w1280/land-before-time.jpg";
        let current = {
            Album: "Station ID", Track: "", Artist: "24seven.fm", CoverLink: "",
            Length: 3600000, PlayStart: "2026-08-21T12:00:00Z",
            SystemTime: "2026-08-21T12:00:00Z",
        };
        let resolverRequests = 0, backdropLoads = 0, firstArtist;
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ tmdbBackdrops: 1, enabledProviders: ["tmdb"] })));
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
            resolverRequests++;
            if (resolverRequests === 1) firstArtist = url.searchParams.get("artist");
            return route.fulfill({ json: {
                media: { id: 12144, title: "The Land Before Time", type: "movie" },
                backdrop, source: "tmdb", tint: [110, 150, 90],
            } });
        });
        await page.route(backdrop, (route) => {
            backdropLoads++;
            return route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' });
        });

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect.poll(() => resolverRequests).toBe(1);
        await expect.poll(() => backdropLoads).toBe(1);
        expect(firstArtist).toBe(null);
        const preparedBackdrop = page.locator(
            `#movieA[src="${backdrop}"], #movieB[src="${backdrop}"]`);
        await expect(preparedBackdrop).toHaveCount(1);
        await expect(preparedBackdrop).not.toHaveClass(/show/);
        await expect.poll(() => preparedBackdrop.evaluate((image) =>
            image.complete && image.naturalWidth > 0)).toBe(true);
        const preparedBackdropId = await preparedBackdrop.getAttribute("id");

        current = {
            Album: "Land Before Time, The", Track: "The Great Migration",
            Artist: "James Horner", CoverLink: nextCover, Length: 180000,
            PlayStart: "2026-08-21T12:00:00Z", SystemTime: "2026-08-21T12:00:00Z",
        };
        await page.locator('input[name="station"][value="sst"]').evaluate((input) =>
            input.dispatchEvent(new Event("change", { bubbles: true })));

        await expect(page.locator("#info-title")).toContainText("The Land Before Time");
        await expect(page.locator(`#${preparedBackdropId}`)).toHaveClass(/show/);
        await page.waitForTimeout(100);
        expect(resolverRequests).toBe(1);
        expect(backdropLoads).toBe(1);
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
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ tmdbBackdrops: 1, enabledProviders: ["tmdb"] })));
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
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ tmdbBackdrops: 1,
                enabledProviders: ["fanart", "steamgriddb"], fanartKey: "fanart-key" })));
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
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ tmdbBackdrops: 1,
                enabledProviders: ["fanart", "tmdb", "steamgriddb"],
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
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ tmdbBackdrops: 1,
                enabledProviders: ["fanart", "tmdb", "steamgriddb"] })));
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
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ tmdbBackdrops: 1, enabledProviders: ["fanart", "tmdb"] })));
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
            localStorage.setItem("24sevenfm-covers.player", JSON.stringify({
                tmdbBackdrops: 1,
                enabledProviders: ["fanart", "tmdb", "steamgriddb"],
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
        await expect.poll(async () => {
            const metrics = await posterMetrics(page);
            return Math.abs(metrics.topGap - metrics.lowerGap);
        }, { timeout: 3000 }).toBeLessThan(2.5);
        return posterMetrics(page);
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
                const checkbox = document.querySelector("#show-remaining");
                const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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

                const collapsed = sample();
                checkbox.checked = true;
                checkbox.dispatchEvent(new Event("change", { bubbles: true }));
                await twoFrames();
                const expandingTransitions = transitionNames();
                await wait(120);
                const expanding = sample();
                await wait(420);
                const expanded = sample();
                await wait(550);
                const expandedSettled = sample();

                checkbox.checked = false;
                checkbox.dispatchEvent(new Event("change", { bubbles: true }));
                await twoFrames();
                const collapsingTransitions = transitionNames();
                await wait(120);
                const collapsing = sample();
                await wait(420);
                const collapsedEnd = sample();
                await wait(550);
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
        await page.locator("#show-remaining").check();

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
                const checkbox = document.querySelector("#show-remaining");
                const twoFrames = () => new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const infoHeight = () => info.getBoundingClientRect().height;

                const collapsedHeight = infoHeight();
                checkbox.checked = true;
                checkbox.dispatchEvent(new Event("change", { bubbles: true }));
                await twoFrames();
                const expandedHeight = infoHeight();
                const expandedAnimations = {
                    countdown: countdown.getAnimations().length,
                    cover: cover.getAnimations().length,
                };
                checkbox.checked = false;
                checkbox.dispatchEvent(new Event("change", { bubbles: true }));
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
            localStorage.setItem("24sevenfm-covers.player", JSON.stringify({ volume: 2 }));
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

    test("normalizes persisted scalar options and an invalid provider order", async ({ page }) => {
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({
                station: "unknown",
                layout: -7,
                transition: 99,
                fadeMs: "not-a-number",
                remainingSize: 99,
                spectrumBars: 999,
                spectrumMode: "unknown",
                fanartKey: 42,
                providerOrder: ["unknown", "tmdb"],
            })));
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });

        await expect(page.locator('input[name="station"][value="sst"]')).toBeChecked();
        await expect(page.locator("#stage")).toHaveClass(/layout-fill/);
        await expect(page.locator('input[name="transition"][value="3"]')).toBeChecked();
        await expect(page.locator("#fade")).toHaveValue("500");
        await expect(page.locator("#fade-val")).toHaveText("0.5 s");
        await expect(page.locator('input[name="cdsize"][value="2"]')).toBeChecked();
        await expect(page.locator("#spectrum-bars")).toHaveValue("64");
        await expect(page.locator('input[name="spectrum-mode"][value="tinted"]')).toBeChecked();
        await expect(page.locator("#fanart-key")).toHaveValue("");
        expect(await page.locator("#providers > .provider")
            .evaluateAll((rows) => rows.map((row) => row.dataset.provider)))
            .toEqual(["fanart", "tmdb", "steamgriddb"]);
    });

    test("keeps string zero boolean options disabled", async ({ page }) => {
        let resolverRequests = 0;
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ tmdbBackdrops: "0",
                showRemaining: "0", roll: "0", hideCover: "0" })));
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
        await expect(page.locator("#tmdb-on")).not.toBeChecked();
        await expect(page.locator("#show-remaining")).not.toBeChecked();
        await expect(page.locator("#roll")).not.toBeChecked();
        await expect(page.locator("#hide-cover")).not.toBeChecked();
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
    test("persists provider enablement as an ID list", async ({ page }) => {
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ enabledProviders: ["tmdb"] })));
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });

        await expect(page.locator("#fanart-on")).not.toBeChecked();
        await expect(page.locator("#tmdbart-on")).toBeChecked();
        await expect(page.locator("#steamgriddb-on")).not.toBeChecked();
        await page.locator("#fanart-on").check();

        const saved = await page.evaluate(() =>
            JSON.parse(localStorage.getItem("24sevenfm-covers.player")));
        expect(saved.enabledProviders).toEqual(["fanart", "tmdb"]);
    });
    test("reorders and persists backdrop providers with the keyboard", async ({ page }) => {
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
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
        expect(await order()).toEqual(["tmdb", "fanart", "steamgriddb"]);
        await fanartGrip.focus();
        await fanartGrip.press("ArrowUp");
        expect(await order()).toEqual(["fanart", "tmdb", "steamgriddb"]);
    });

    test("appends SteamGridDB to an older saved two-provider order", async ({ page }) => {
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ providerOrder: ["tmdb", "fanart"] })));
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        const order = await page.locator("#providers > .provider")
            .evaluateAll((rows) => rows.map((row) => row.dataset.provider));
        expect(order).toEqual(["tmdb", "fanart", "steamgriddb"]);
    });

    test("keeps backdrop providers pointer-draggable", async ({ page }) => {
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        const grip = page.locator('.provider[data-provider="fanart"] .grip');
        const target = page.locator('.provider[data-provider="tmdb"]');
        await grip.scrollIntoViewIfNeeded();
        const from = await grip.boundingBox(), to = await target.boundingBox();
        expect(from).not.toBeNull();
        expect(to).not.toBeNull();

        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
        await page.mouse.down();
        await page.mouse.move(to.x + to.width / 2, to.y + to.height * .75, { steps: 5 });
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
        await page.locator("label:has(#show-remaining)").click();
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
