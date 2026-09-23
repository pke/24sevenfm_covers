const { test, expect } = require("@playwright/test");
test.skip(process.env.PLAYER_LOCAL !== "1", "Deterministic local debug contracts");

test.beforeEach(async ({ page }) => {
    await page.route(/\/soap\/FM24sevenJSON.php\?/, route => route.fulfill({ json:
        new URL(route.request().url()).searchParams.get("action") === "GetQueue" ? [] : {
            Album: "Debug Album", Artist: "Debug Artist", Track: "Debug Track",
            CoverLink: "https://streamingsoundtracks.com/images/cover/test.jpg",
            Length: "300000", PlayStart: "2026-09-23T12:00:00", SystemTime: "2026-09-23T12:00:10",
        } }));
    await page.route(/\/api\/media\?/, route => route.fulfill({ json: {
        metadata: { album: "Debug Album", artist: "Debug Artist", track: "Debug Track" },
        media: null, backdrop: null, source: null, tint: [255, 255, 255],
        diagnostics: { totalMs: 12, recordedAt: "2026-09-23T12:00:00Z" },
    } }));
    await page.route(/https:\/\/.*\.(png|jpg)/, route => route.fulfill({ contentType: "image/png",
        body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==", "base64") }));
    await page.route(/\/api\/tint\?/, route => route.fulfill({ json: { tint: [255, 255, 255] } }));
    await page.goto("/player.html", { waitUntil: "domcontentloaded" });
});

test("debug overlay fades, ignores typing and closes outside or with Escape in fullscreen", async ({ page }) => {
    const panel = page.locator("#stage-debug");
    await page.keyboard.press("d");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-state", "open");
    await expect(page.locator("#debug-snapshot")).toContainText("Debug Album");
    // Observe the outgoing DOM in the same task as dismissal, before the 200 ms
    // fade can complete while Playwright waits for a busy browser process.
    const outgoing = await panel.evaluate(el => {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
        return { state: el.dataset.state, hidden: el.hidden, text: el.textContent };
    });
    expect(outgoing.state).toBe("closing");
    expect(outgoing.hidden).toBe(false);
    expect(outgoing.text).toContain("Debug Album");
    await expect(panel).toBeHidden();
    await page.keyboard.press("d");
    await page.locator("h2").first().click();
    await expect(panel).toBeHidden();
    await page.evaluate(() => {
        const input = document.createElement("input"); input.id = "typing-fixture";
        document.body.append(input); input.focus();
    });
    await page.keyboard.type("d");
    await expect(panel).toBeHidden();
    await page.locator("#typing-fixture").evaluate(el => el.remove());
    await page.locator("#fullscreen").click();
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
    await page.keyboard.press("d");
    await expect(panel).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
});

test("debug snapshot can be frozen and copied with response timings and redacted secrets", async ({ page, context, browserName }) => {
    if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    else await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true,
        value: { writeText: async value => { window.debugCopied = value; }, readText: async () => window.debugCopied } }));
    await page.keyboard.press("d");
    const snapshot = page.locator("#debug-snapshot");
    await expect(snapshot).toContainText("Debug Album");
    await expect(snapshot).toContainText("headersMs");
    await expect(page.locator("#debug-response-text")).toContainText('"totalMs": 12');
    await page.getByRole("button", { name: "Freeze", exact: true }).click();
    const frozen = await snapshot.textContent();
    await page.waitForTimeout(1200);
    expect(await snapshot.textContent()).toBe(frozen);
    await page.getByRole("button", { name: "Copy snapshot", exact: true }).click();
    const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
    expect(copied.requests.some(request => request.response?.diagnostics?.totalMs === 12)).toBe(true);
    expect(copied.requests.some(request => request.url.includes("diagnostics=1"))).toBe(true);
    expect(copied.capturedAt).toBeTruthy();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(snapshot).not.toHaveText(frozen);
});

test("debug overlay respects reduced motion and keeps long responses inside the stage", async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press("d");
    const panel = page.locator("#stage-debug");
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox(), stage = await page.locator("#stage").boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(stage.x);
    expect(box.x + box.width).toBeLessThanOrEqual(stage.x + stage.width + 1);
    await page.screenshot({ path: testInfo.outputPath("debug-mobile.png"), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
});
