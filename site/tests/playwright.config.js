// Playwright config for the web-player canary. Target defaults to the DEPLOYED site -
// the point of the daily run is "is the live page still working", not "does the code
// pass" - and can be overridden with PLAYER_URL for a local build.
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
    timeout: 120000,   // the station server is slow and drops connections under load
    retries: 2,        // retry before crying wolf - a canary that flakes gets ignored
    reporter: [["list"]],
    use: {
        baseURL: process.env.PLAYER_URL || "https://24sevenfm-covers.dudesoft.app",
        // Branded Chrome, not Playwright's Chromium: the audio contract test needs the
        // AAC decoder (proprietary - Chromium doesn't ship it, so canplay would fail on
        // a perfectly healthy audio/aacp stream), and the station's WAF is friendliest
        // to the most genuine browser fingerprint.
        channel: "chrome",
        headless: true,
        viewport: { width: 1280, height: 800 },
        // A regular Chrome UA, not "HeadlessChrome": the station WAF answers 403 to
        // some datacenter-IP requests, and headless fingerprints only invite more of
        // that. Costs nothing, removes one variable from every failure analysis.
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    },
});
