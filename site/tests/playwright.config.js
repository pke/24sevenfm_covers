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
        headless: true,
        viewport: { width: 1280, height: 800 },
    },
});
