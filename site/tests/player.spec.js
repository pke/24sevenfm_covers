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

// Everything here runs INSIDE the browser, from the player page's own origin. Not a
// style choice: the station's WAF 403s non-browser clients (curl, node's https,
// Playwright's request fixture) from datacenter IPs - runs 1 and 2 proved it, same
// URLs, 403 outside the browser and 200 inside it. The browser is the only vantage
// point GitHub's runners have - and conveniently the only one that matters, because
// browsers are the only thing the player runs in.
const JSON_URL =
    "https://streamingsoundtracks.com/soap/FM24sevenJSON.php?action=GetCurrentlyPlaying&_t=";

test.describe("the deployed player page", () => {
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

    test("ignores a TMDB result after movie backdrops are disabled", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/race.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/race.svg";
        let tmdbRoute = null, backdropRequested = false, fanartRequested = false;
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ tmdbBackdrops: 1, tmdbKey: "race-test-key",
                fanartBackdrops: 1, fanartKey: "fanart-race-key", tmdbArt: 1 })));
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
        await page.route(/https:\/\/api\.themoviedb\.org\/3\/search\/movie\?/, (route) => {
            tmdbRoute = route;
        });
        await page.route("https://webservice.fanart.tv/v3/movies/**", (route) => {
            fanartRequested = true;
            return route.fulfill({ json: { moviebackground: [
                { url: "https://fanart.tv/slow.jpg", lang: "", likes: "1" },
            ] } });
        });
        await page.route("https://image.tmdb.org/t/p/w1280/slow.jpg", (route) => {
            backdropRequested = true;
            return route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' });
        });

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect.poll(() => !!tmdbRoute).toBe(true);
        await page.locator("label:has(#tmdb-on)").click();
        await tmdbRoute.fulfill({ json: { results: [
            { id: 1, title: "Slow Movie", original_title: "Slow Movie", backdrop_path: "/slow.jpg" },
        ] } });
        await page.waitForTimeout(100);
        expect(backdropRequested).toBe(false);
        expect(fanartRequested).toBe(false);
        await expect(page.locator("#movieA.show, #movieB.show")).toHaveCount(0);
    });
    test("clears stale movie art when the replacement image fails", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/movie-failure.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/movie-failure.svg";
        let tmdbRequests = 0, failedImages = 0;
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ tmdbBackdrops: 1, tmdbKey: "first-key",
                fanartBackdrops: 0, tmdbArt: 1, hideCover: 1 })));
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
        await page.route(/https:\/\/api\.themoviedb\.org\/3\/search\/movie\?/, (route) => {
            tmdbRequests++;
            const path = tmdbRequests === 1 ? "/working.jpg" : "/broken.jpg";
            return route.fulfill({ json: { results: [
                { id: 1, title: "Backdrop Failure", original_title: "Backdrop Failure",
                    backdrop_path: path },
            ] } });
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
        await page.locator("#tmdb-key").evaluate((input) => {
            input.value = "second-key";
            input.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await expect.poll(() => tmdbRequests).toBe(2);
        await expect.poll(() => failedImages).toBe(1);
        await expect(page.locator("#movieA.show, #movieB.show")).toHaveCount(0);
        await expect(page.locator("#stage")).not.toHaveClass(/no-cover/);
    });

    for (const status of [429, 500]) {
        test(`retries TMDB after a transient HTTP ${status}`, async ({ page }) => {
            const cover = "https://streamingsoundtracks.com/images/cover/retry.svg";
            const sizedCover = "https://streamingsoundtracks.com/images/cover/500/retry.svg";
            let tmdbRequests = 0;
            await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
                JSON.stringify({ tmdbBackdrops: 1, tmdbKey: "retry-test-key",
                    fanartBackdrops: 0, tmdbArt: 1 })));
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
            await page.route(/https:\/\/api\.themoviedb\.org\/3\/search\/movie\?/, (route) => {
                tmdbRequests++;
                if (tmdbRequests === 1)
                    return route.fulfill({ status, json: { status_message: "temporary failure" } });
                return route.fulfill({ json: { results: [
                    { id: 1, title: "Retry Movie", original_title: "Retry Movie",
                        backdrop_path: "/retry.jpg" },
                ] } });
            });
            await page.route("https://image.tmdb.org/t/p/w1280/retry.jpg", (route) =>
                route.fulfill({ status: 200, contentType: "image/svg+xml",
                    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));

            await page.goto("/player.html", { waitUntil: "domcontentloaded" });
            await expect.poll(() => tmdbRequests).toBe(1);
            await page.waitForTimeout(100); // let the failed lookup settle without caching
            const toggle = page.locator("label:has(#tmdb-on)");
            await toggle.click();
            await toggle.click();

            await expect.poll(() => tmdbRequests).toBe(2);
            await expect(page.locator("#movieA.show, #movieB.show")).toHaveCount(1);
        });
    }

    test("keeps next-track fanart prefetch failures out of the current status", async ({ page }) => {
        const nextCover = "https://streamingsoundtracks.com/images/cover/next.svg";
        const nextSized = "https://streamingsoundtracks.com/images/cover/500/next.svg";
        let fanartRequests = 0;
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ tmdbBackdrops: 1, tmdbKey: "prefetch-test-key",
                fanartBackdrops: 1, fanartKey: "bad-fanart-key", tmdbArt: 1 })));
        await page.route("https://streamingsoundtracks.com/soap/FM24sevenJSON.php?*", (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "GetQueue") return route.fulfill({ json: [{
                Album: "Next Movie", CoverLink: nextCover,
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
        await page.route(/https:\/\/api\.themoviedb\.org\/3\/search\/movie\?/, (route) =>
            route.fulfill({ json: { results: [
                { id: 7, title: "Next Movie", original_title: "Next Movie",
                    backdrop_path: "/next.jpg" },
            ] } }));
        await page.route("https://webservice.fanart.tv/v3/movies/**", (route) => {
            fanartRequests++;
            return route.fulfill({ status: 401, json: { error: "bad key" } });
        });
        await page.route("https://image.tmdb.org/t/p/w1280/next.jpg", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect.poll(() => fanartRequests).toBe(1);
        await expect(page.locator("#status")).toHaveText("");
    });
    test("retries fanart.tv after a transient provider failure", async ({ page }) => {
        const cover = "https://streamingsoundtracks.com/images/cover/fanart-retry.svg";
        const sizedCover = "https://streamingsoundtracks.com/images/cover/500/fanart-retry.svg";
        let fanartRequests = 0;
        await page.addInitScript(() => localStorage.setItem("24sevenfm-covers.player",
            JSON.stringify({ tmdbBackdrops: 1, tmdbKey: "fanart-retry-key",
                fanartBackdrops: 1, fanartKey: "fanart-key", tmdbArt: 1 })));
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
        await page.route(/https:\/\/api\.themoviedb\.org\/3\/search\/movie\?/, (route) =>
            route.fulfill({ json: { results: [
                { id: 9, title: "Fanart Retry", original_title: "Fanart Retry",
                    backdrop_path: "/tmdb-fallback.jpg" },
            ] } }));
        await page.route("https://webservice.fanart.tv/v3/movies/**", (route) => {
            fanartRequests++;
            if (fanartRequests === 1) return route.fulfill({ status: 500 });
            return route.fulfill({ json: { moviebackground: [
                { url: "https://fanart.tv/fanart-retry.jpg", lang: "", likes: "1" },
            ] } });
        });
        await page.route("https://image.tmdb.org/t/p/w1280/tmdb-fallback.jpg", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        await page.route("https://fanart.tv/fanart-retry.jpg", (route) =>
            route.fulfill({ status: 200, contentType: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));

        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        await expect.poll(() => fanartRequests).toBe(1);
        await expect(page.locator("#movieA.show, #movieB.show")).toHaveAttribute("src", /tmdb-fallback/);
        const toggle = page.locator("label:has(#tmdb-on)");
        await toggle.click();
        await toggle.click();
        await expect.poll(() => fanartRequests).toBe(2);
        await expect(page.locator("#movieA.show, #movieB.show")).toHaveAttribute("src", /fanart-retry/);
    });

    test("times out a stalled queue prefetch independently", async ({ page }) => {
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

    test("reorders and persists backdrop providers with the keyboard", async ({ page }) => {
        await mockProviderTestFeed(page);
        await page.goto("/player.html", { waitUntil: "domcontentloaded" });
        const order = () => page.locator("#providers > .provider")
            .evaluateAll((rows) => rows.map((row) => row.dataset.provider));
        const fanartGrip = page.locator('.provider[data-provider="fanart"] .grip');

        await fanartGrip.focus();
        await fanartGrip.press("ArrowDown");
        expect(await order()).toEqual(["tmdb", "fanart"]);
        await expect(fanartGrip).toBeFocused();
        await expect(fanartGrip).toHaveAttribute("aria-label", /position 2 of 2/);
        await expect(page.locator("#provider-status")).toHaveText("fanart.tv moved to position 2 of 2.");

        await page.reload({ waitUntil: "domcontentloaded" });
        expect(await order()).toEqual(["tmdb", "fanart"]);
        await fanartGrip.focus();
        await fanartGrip.press("ArrowUp");
        expect(await order()).toEqual(["fanart", "tmdb"]);
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
        expect(order).toEqual(["tmdb", "fanart"]);
        await expect(page.locator("#provider-status")).toHaveText("fanart.tv moved to position 2 of 2.");
    });

    test("loads, polls the station, and renders a real cover", async ({ page }) => {
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
        await page.goto("/player.html");
        await page.locator("label.seg", { hasText: "Poster" }).click();
        await expect(page.locator(".info")).toBeVisible();
        await expect(page.locator("#info-title")).not.toHaveText(/Loading/, { timeout: 60000 });

        await page.reload(); // localStorage must bring the layout back
        await expect(page.locator("#stage")).toHaveClass(/layout-poster/);
    });

    test("countdown appears when enabled", async ({ page }) => {
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
