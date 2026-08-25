"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createLocalApiServer } = require("./local_api_server");

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
