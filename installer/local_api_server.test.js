"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { createBackchannelHandler } = require("./backchannel");
const { createLocalApiServer } = require("./local_api_server");

const BACKCHANNEL_ORIGIN = "http://localhost:8099";
const BACKCHANNEL_TOKEN = "ABCD-EFGH-IJKL";
const BACKCHANNEL_THREAD = "0198f34e-7abc-7def-8123-123456789abc";

function backchannelReport() {
    return {
        station: "sst",
        album: "La Mula",
        track: "El Tocadiscos",
        artist: "Oscar Navarro",
        displayedTitle: "La Mula - El Tocadiscos (2:03)",
        settings: {
            backdropsEnabled: true,
            ratingsEnabled: false,
            fanartPersonalKeyConfigured: false,
            providers: ["fanart", "tmdb"],
            coverPolicy: "hide",
        },
        display: {
            backdropVisible: false,
            backdropError: "",
            resolver: {
                request: {
                    album: "La Mula", track: "El Tocadiscos", artist: "Oscar Navarro",
                    providers: ["fanart", "tmdb"], includeArt: true, includeRatings: false,
                },
                result: {
                    media: { id: 172265, title: "La Mula", type: "movie" },
                    backdrop: null,
                    source: null,
                },
            },
        },
    };
}

async function withServer(routes, callback) {
    const server = createLocalApiServer({ routes });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    try {
        const address = server.address();
        await callback(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test("decodes browser query strings before handing metadata to an API handler", async () => {
    await withServer({
        "/api/backdrop": (req, res) => {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ query: req.query, rawUrl: req.url }));
        },
    }, async (origin) => {
        const response = await fetch(origin + "/api/backdrop"
            + "?album=Defiance+%28Video+Game%29&track=Dark+Woods"
            + "&artist=Bear+McCreary&providers=tmdb%2Csteamgriddb%2Cfanart");
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const body = await response.json();
        assert.deepEqual(body.query, {
            album: "Defiance (Video Game)",
            track: "Dark Woods",
            artist: "Bear McCreary",
            providers: "tmdb,steamgriddb,fanart",
        });
        assert.match(body.rawUrl, /album=Defiance\+%28Video\+Game%29/);
    });
});

test("returns JSON 404 for paths outside the local API", async () => {
    await withServer({}, async (origin) => {
        const response = await fetch(origin + "/not-an-api");
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { error: "not_found" });
    });
});

test("advertises the local backchannel and allows only the configured loopback origin",
    async () => {
        const handler = createBackchannelHandler({
            token: BACKCHANNEL_TOKEN,
            threadId: BACKCHANNEL_THREAD,
            root: path.join(__dirname, ".."),
            allowedOrigins: [BACKCHANNEL_ORIGIN],
            queueMessage: async () => {},
        });
        await withServer({ "/api/backchannel": handler }, async (origin) => {
            const status = await fetch(origin + "/api/backchannel", {
                headers: { Origin: BACKCHANNEL_ORIGIN },
            });
            assert.equal(status.status, 200);
            assert.equal(status.headers.get("access-control-allow-origin"), BACKCHANNEL_ORIGIN);
            assert.equal(status.headers.get("access-control-allow-methods"),
                "GET, POST, OPTIONS");
            assert.equal(status.headers.get("access-control-allow-headers"),
                "Authorization, Content-Type");
            assert.deepEqual(await status.json(), {
                enabled: true,
                authentication: "pairing_code",
            });

            const preflight = await fetch(origin + "/api/backchannel", {
                method: "OPTIONS",
                headers: {
                    Origin: BACKCHANNEL_ORIGIN,
                    "Access-Control-Request-Private-Network": "true",
                },
            });
            assert.equal(preflight.status, 204);
            assert.equal(preflight.headers.get("access-control-allow-methods"),
                "GET, POST, OPTIONS");
            assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");

            const denied = await fetch(origin + "/api/backchannel", {
                headers: { Origin: "https://example.com" },
            });
            assert.equal(denied.status, 403);
            assert.deepEqual(await denied.json(), { error: "origin_not_allowed" });
        });
    });

test("pairs once and queues a bounded metadata report into the configured Codex task",
    async () => {
        let queued = null;
        const handler = createBackchannelHandler({
            token: BACKCHANNEL_TOKEN,
            threadId: BACKCHANNEL_THREAD,
            root: path.join(__dirname, ".."),
            codexExecutable: "C:\\tools\\codex.exe",
            allowedOrigins: [BACKCHANNEL_ORIGIN],
            queueMessage: async (request) => { queued = request; },
        });
        await withServer({ "/api/backchannel": handler }, async (origin) => {
            const rejected = await fetch(origin + "/api/backchannel", {
                method: "POST",
                headers: {
                    Origin: BACKCHANNEL_ORIGIN,
                    Authorization: "Bearer WRONG-CODE-0000",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(backchannelReport()),
            });
            assert.equal(rejected.status, 401);
            assert.equal(queued, null);

            const untrusted = backchannelReport();
            untrusted.display.resolver.result.backdrop = "https://example.com/not-provider-art.jpg";
            untrusted.display.resolver.result.source = "tmdb";
            const invalid = await fetch(origin + "/api/backchannel", {
                method: "POST",
                headers: {
                    Origin: BACKCHANNEL_ORIGIN,
                    Authorization: `Bearer ${BACKCHANNEL_TOKEN}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(untrusted),
            });
            assert.equal(invalid.status, 400);
            assert.equal(queued, null);

            const report = backchannelReport();
            report.settings.fanartKey = "must-not-reach-codex";
            const accepted = await fetch(origin + "/api/backchannel", {
                method: "POST",
                headers: {
                    Origin: BACKCHANNEL_ORIGIN,
                    Authorization: `Bearer ${BACKCHANNEL_TOKEN}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(report),
            });
            assert.equal(accepted.status, 202);
            assert.deepEqual(await accepted.json(), { queued: true });
            assert.equal(queued.threadId, BACKCHANNEL_THREAD);
            assert.equal(queued.codexExecutable, "C:\\tools\\codex.exe");
            assert.equal(queued.root, path.join(__dirname, ".."));
            assert.match(queued.prompt, /^\[Player-Backchannel\] La Mula — El Tocadiscos/);
            assert.match(queued.prompt, /"id": 172265/);
            assert.match(queued.prompt, /Conventional-Commit-Nachricht/);
            assert.doesNotMatch(queued.prompt, new RegExp(BACKCHANNEL_TOKEN));
            assert.doesNotMatch(queued.prompt, /must-not-reach-codex/);
        });
    });

test("keeps the backchannel disabled without a valid local task binding", async () => {
    const handler = createBackchannelHandler({
        token: BACKCHANNEL_TOKEN,
        threadId: "not-a-thread",
        root: path.join(__dirname, ".."),
        allowedOrigins: [BACKCHANNEL_ORIGIN],
        queueMessage: async () => assert.fail("disabled backchannel must not queue"),
    });
    await withServer({ "/api/backchannel": handler }, async (origin) => {
        const status = await fetch(origin + "/api/backchannel", {
            headers: { Origin: BACKCHANNEL_ORIGIN },
        });
        assert.deepEqual(await status.json(), { enabled: false, authentication: "disabled" });
        const response = await fetch(origin + "/api/backchannel", {
            method: "POST",
            headers: {
                Origin: BACKCHANNEL_ORIGIN,
                Authorization: `Bearer ${BACKCHANNEL_TOKEN}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(backchannelReport()),
        });
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { error: "backchannel_disabled" });
    });
});
