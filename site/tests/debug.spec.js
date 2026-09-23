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
    await expect(page.locator("#debug-requests-list")).toContainText("Headers");
    await expect(page.locator("#debug-requests-list")).toContainText("Server");
    await page.getByRole("button", { name: "Copy Album", exact: true }).first().click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Debug Album");
    await page.locator("#debug-selection .debug-value").first().dblclick();
    expect(await page.evaluate(() => window.getSelection().toString())).toContain("Debug");
    await page.evaluate(() => window.getSelection().removeAllRanges());
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
    await expect(page.locator("#debug-live-state")).toHaveText("Live");
});

test("debug uses selectable fields and a horizontally scrollable timeline with one current track", async ({ page }, testInfo) => {
    await page.route(/\/soap\/FM24sevenJSON.php\?.*action=GetQueue/, route => route.fulfill({ json:
        Array.from({ length: 9 }, (_, i) => ({ Album: "Future " + i, Track: "Cue " + i,
            Artist: "Composer", Length: "180000", CoverLink: "https://streamingsoundtracks.com/images/cover/test.jpg" })) }));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.keyboard.press("d");
    await expect(page.locator("#debug-snapshot dl").first()).toBeVisible();
    await expect(page.locator("#debug-snapshot pre, #debug-snapshot textarea")).toHaveCount(0);
    const rail = page.locator("#debug-timeline");
    await expect(rail.locator('[aria-current="true"]')).toHaveCount(1);
    await expect(rail).toContainText("Future 8");
    expect(await rail.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    await rail.evaluate(el => { el.scrollLeft = el.scrollWidth; });
    await rail.getByRole("button", { name: /Future 8/ }).click();
    await expect(page.locator("#debug-selection")).toContainText("Future 8");
    await expect(page.locator("#debug-selection")).toContainText("Cache");
    await page.getByRole("button", { name: "Jump to current" }).click();
    await expect(page.locator("#debug-selection")).toContainText("Debug Album");
    await page.route(/\/soap\/FM24sevenJSON.php\?.*action=GetCurrentlyPlaying/, route => route.fulfill({ json: {
        Album: "Next current", Track: "Another cue", Artist: "Composer", Length: "180000",
        CoverLink: "https://streamingsoundtracks.com/images/cover/test.jpg",
        PlayStart: "2026-09-23T12:05:00", SystemTime: "2026-09-23T12:05:10"
    } }));
    await page.waitForTimeout(2100); // the normal focus refresh ignores station polls newer than 2 s
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(rail.locator('[aria-current="true"]')).toContainText("Next current");
    await expect(rail.locator('[data-phase="past"]')).toContainText("Debug Album");
    await expect(rail.locator('[aria-current="true"]')).toHaveCount(1);
    await page.locator("#stage").screenshot({ path: testInfo.outputPath("debug-timeline-desktop.png") });
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
    await page.locator("#stage").screenshot({ path: testInfo.outputPath("debug-mobile.png") });
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
});
