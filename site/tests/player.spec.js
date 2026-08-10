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
const https = require("https");

// Fetch only the response HEADERS of an endless audio stream, then hang up.
function streamHeaders(host) {
    return new Promise((resolve, reject) => {
        const req = https.get({ host: host, path: "/live", timeout: 15000 }, (res) => {
            resolve({ status: res.statusCode, type: res.headers["content-type"] || "" });
            req.destroy(); // it never ends - the headers are all we want
        });
        req.on("timeout", () => req.destroy(new Error("timeout waiting for " + host)));
        req.on("error", reject);
    });
}

test.describe("the deployed player page", () => {
    test("loads, polls the station, and renders a real cover", async ({ page }) => {
        const errors = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.goto("/player.html");

        // A cover URL must arrive via the CORS fetch and actually decode to pixels.
        const front = page.locator(".coverbox img.front");
        await expect(front).toHaveAttribute("src", /\/images\/cover\//, { timeout: 60000 });
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

test.describe("station contracts the player stands on", () => {
    test("now-playing JSON still answers over HTTPS and still grants CORS", async ({ request }) => {
        const res = await request.get(
            "https://streamingsoundtracks.com/soap/FM24sevenJSON.php?action=GetCurrentlyPlaying&_t=" + Date.now(),
            { headers: { Origin: "https://24sevenfm-covers.dudesoft.app" } }
        );
        expect(res.status()).toBe(200);
        // Without this one header the whole player is dead in every browser.
        expect(res.headers()["access-control-allow-origin"]).toBe("*");
        const j = await res.json();
        expect(j.CoverLink, "feed shape: CoverLink").toMatch(/^https?:\/\//);
        expect(j.Length, "feed shape: Length").toBeDefined();
        expect(j.SystemTime, "feed shape: SystemTime").toBeDefined();
    });

    test("the sized cover variant (/cover/500/) still exists", async ({ request }) => {
        const res = await request.get(
            "https://streamingsoundtracks.com/soap/FM24sevenJSON.php?action=GetCurrentlyPlaying&_t=" + Date.now()
        );
        const cover = (await res.json()).CoverLink.replace("/cover/", "/cover/500/");
        const img = await request.get(cover);
        expect(img.status(), cover).toBe(200);
        expect(img.headers()["content-type"]).toMatch(/^image\//);
    });

    // Two hosts, not all five: enough to catch "the /live proxy is gone" without
    // quintupling the flake surface of a notoriously moody server.
    for (const host of ["streamingsoundtracks.com", "death.fm"]) {
        test(`HTTPS audio stream still answers on ${host}/live`, async () => {
            const h = await streamHeaders(host);
            expect(h.status, host).toBe(200);
            expect(h.type, host).toMatch(/^audio\//);
        });
    }
});
