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

for (const motion of ["no-preference", "reduce"]) {
    test(`fanart stage hint follows current artwork and fades with ${motion} motion`, async ({ page }, testInfo) => {
        await page.emulateMedia({ reducedMotion: motion });
        let rejection = true;
        await page.route(/\/api\/media\?/, route => route.fulfill({ json: {
            metadata: { album: "Debug Album", artist: "Debug Artist", track: "Debug Track" },
            backdrop: "https://assets.fanart.tv/fanart/test.jpg", source: "fanart",
            diagnostics: { resolution: { spans: [
                ...(rejection ? [{ name: "provider.fanart", status: motion === "reduce" ? 403 : 401 }] : []),
                { name: "provider.fanart", status: 200 },
            ] } },
        } }));
        await page.goto("/player.html?preset=1&station=sst&sstBackdrops=1");
        const hint = page.locator("#fanart-stage-hint");
        await expect(hint).toHaveClass(/show/);
        await expect(hint).toContainText("Check provider settings");
        await expect(hint).toHaveAttribute("aria-hidden", "false");
        const stage = page.locator("#stage");
        const rects = await page.evaluate(() => {
            const stage = document.querySelector("#stage").getBoundingClientRect();
            const hint = document.querySelector("#fanart-stage-hint").getBoundingClientRect();
            return { inside: hint.left >= stage.left && hint.right <= stage.right && hint.top >= stage.top && hint.bottom <= stage.bottom };
        });
        expect(rects.inside).toBe(true);
        await hint.click();
        await expect(page.locator("#fs-options")).toHaveAttribute("data-state", "open");
        await expect(page.locator("#settings-tab-station")).toHaveAttribute("aria-selected", "true");
        await expect(page.locator("#fanart-key")).toBeFocused();
        await stage.click({ position: { x: 5, y: 100 } });
        await expect(page.locator("#fs-options")).toBeHidden();
        await page.locator("#fullscreen").click();
        await expect.poll(() => stage.evaluate(el => document.fullscreenElement === el)).toBe(true);
        await expect(hint).toBeVisible();
        await hint.focus();
        await page.keyboard.press("Enter");
        await expect(page.locator("#fs-options")).toHaveAttribute("data-state", "open");
        await expect(page.locator("#fanart-key")).toBeFocused();
        await expect.poll(() => stage.evaluate(el => document.fullscreenElement === el)).toBe(true);
        await stage.click({ position: { x: 5, y: 100 } });
        await expect(page.locator("#fs-options")).toBeHidden();
        await stage.screenshot({ path: testInfo.outputPath("fanart-stage-hint.png") });
        // Retain the mounted text while its outgoing opacity transition runs.
        const outgoing = await page.evaluate(() => {
            const checkbox = document.querySelector("#backdrops-enabled");
            checkbox.checked = false;
            checkbox.dispatchEvent(new Event("change", { bubbles: true }));
            const el = document.querySelector("#fanart-stage-hint");
            return { text: el.textContent, duration: getComputedStyle(el).transitionDuration,
                animations: el.getAnimations().length };
        });
        expect(outgoing.text).toContain("fanart.tv key rejected");
        if (motion === "no-preference") expect(outgoing.animations).toBeGreaterThan(0);
        else expect(outgoing.duration).toMatch(/^0s/);
        await expect(hint).toBeHidden();
        rejection = false;
        const healthyResponse = page.waitForResponse(/\/api\/media\?/);
        await page.goto("/player.html?preset=1&station=sst&sstBackdrops=1");
        await healthyResponse;
        await expect(hint).not.toHaveClass(/show/);
    });
}

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
    const albumValue = page.locator("#debug-selection .debug-value")
        .filter({ hasText: /^Debug Album$/ }).first();
    const wordCenter = await albumValue.evaluate(element => {
        const word = document.createRange();
        word.setStart(element.firstChild, 0);
        word.setEnd(element.firstChild, "Debug".length);
        const rect = word.getBoundingClientRect(), elementRect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2 - elementRect.left,
            y: rect.top + rect.height / 2 - elementRect.top };
    });
    await albumValue.dblclick({ position: wordCenter });
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
    const outgoing = await rail.getByRole("button", { name: /Future 8/ }).evaluate(el => {
        el.click();
        return document.querySelector("#debug-snapshot").textContent;
    });
    expect(outgoing).toContain("Debug Album"); // retain outgoing details during the exit fade
    await expect(page.locator("#debug-selection")).toContainText("Future 8");
    await expect(page.locator("#debug-cache")).toContainText("Variants");
    await expect(page.locator("#debug-snapshot")).toContainText("Future 8");
    for (const id of ["snapshot", "artwork", "requests-list", "cache", "player", "events"])
        await expect(page.locator("#debug-" + id)).not.toContainText("Debug Album");
    await expect(page.locator("#debug-player")).toContainText("future");
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true,
        value: { writeText: async value => { window.debugCopied = value; } } }));
    await page.getByRole("button", { name: "Copy snapshot", exact: true }).click();
    const copied = JSON.parse(await page.evaluate(() => window.debugCopied));
    expect(copied.track.album).toBe("Future 8");
    expect(JSON.stringify(copied)).not.toContain("Debug Album");
    await page.getByRole("button", { name: "Jump to current" }).click();
    await expect(page.locator("#debug-selection")).toContainText("Debug Album");
    await rail.getByRole("button", { name: /Future 8/ }).click();
    await expect(page.locator("#debug-snapshot")).toContainText("Future 8");
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
    await expect(page.locator("#debug-snapshot")).toContainText("Future 8");
    await rail.locator('[data-phase="past"]').click();
    await expect(page.locator("#debug-snapshot")).toContainText("Debug Album");
    await expect(page.locator("#debug-player")).toContainText("past");
    await page.waitForTimeout(1200);
    for (const id of ["snapshot", "artwork", "requests-list", "cache", "player", "events"])
        await expect(page.locator("#debug-" + id)).not.toContainText("Next current");
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
