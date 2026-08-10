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
        const front = page.locator(".coverbox img.front");
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
        await page.goto("/player.html");
        await page.locator("label.seg", { hasText: "Death.FM" }).click();
        await expect(page.locator(".coverbox img.front"))
            .toHaveAttribute("src", /death\.fm\/images\/cover/, { timeout: 60000 });
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
