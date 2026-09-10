"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHandler } = require("./_lib/backdrop");

function fixture() {
    const calls = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "test", FANART_API_KEY: "test" },
        tintForImage: async () => [1, 2, 3],
        fetchImpl: async raw => {
            const url = new URL(raw); calls.push(url);
            let body;
            if (url.pathname.includes("/search/")) body = { results: [{
                id: 7, media_type: "movie", title: "Arrival", name: "Arrival",
                backdrop_path: "/arrival.jpg", poster_path: "/arrival-poster.jpg",
            }] };
            else if (url.hostname === "webservice.fanart.tv") body = {
                moviebackground: [{ url: "https://assets.fanart.tv/fanart/arrival.jpg", lang: "en" }],
                movieposter: [{ url: "https://assets.fanart.tv/fanart/arrival-poster.jpg", lang: "en" }],
                hdmovielogo: [{ url: "https://assets.fanart.tv/fanart/arrival-logo.png", lang: "en" }],
            };
            else if (url.pathname.endsWith("/release_dates")) body = { results: [] };
            else throw Error("Unexpected request " + url.pathname);
            return { ok: true, status: 200, json: async () => body };
        },
    });
    const query = { album: "Arrival", providers: "fanart,tmdb" };
    async function request(extra = {}, headers = {}) {
        const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; },
            end(body) { this.body = JSON.parse(body); } };
        await handler({ method: "GET", query: { ...query, ...extra }, headers }, res);
        return res;
    }
    return { calls, request };
}

test("HTTP logo variants share provider work while keeping each track's metadata isolated", async () => {
    const { calls, request } = fixture();
    const [off, on] = await Promise.all([
        request({ track: "First Cue", width: "1280", height: "720" }),
        request({ track: "Second Cue", logos: "1", width: "1000", height: "600" }),
    ]);
    assert.equal(off.statusCode, 200); assert.equal(on.statusCode, 200);
    assert.equal(off.body.metadata.track, "First Cue");
    assert.equal(on.body.metadata.track, "Second Cue");
    assert.equal(Object.hasOwn(off.body, "logo"), false);
    assert.equal(on.body.logo.source, "fanart");
    assert.equal(calls.length, 2); // one TMDB search and one fanart payload
    const count = calls.length;
    assert.equal((await request({ logos: "0" })).body.logo, undefined);
    assert.deepEqual((await request({ logos: "1" })).body.logo, on.body.logo);
    assert.equal(calls.length, count);
    await request({ logos: "1" }, { "cache-control": "no-cache" });
    assert.equal(calls.length, count * 2);
});

test("shared metadata cache separates provider settings, credentials, ratings and artwork classes", async () => {
    const { calls, request } = fixture();
    for (const variant of [{}, { providers: "tmdb,fanart" }, { client_key: "personal" },
        { ratings: "US" }, { width: "1080", height: "1920" }, { width: "3840", height: "2160" }]) {
        const before = calls.length;
        assert.equal((await request(variant)).statusCode, 200);
        assert.ok(calls.length > before, JSON.stringify(variant));
        const cached = calls.length;
        await request({ ...variant, logos: "0" });
        assert.equal(calls.length, cached);
    }
});

test("logo option defaults off, is validated, and cannot enable metadata-only artwork", async () => {
    const { calls, request } = fixture();
    assert.equal((await request({ logos: "yes" })).statusCode, 400);
    assert.equal((await request({ logos: "2" })).statusCode, 400);
    assert.equal(calls.length, 0);
    const result = await request({ art: "0", logos: "1" });
    assert.equal(result.statusCode, 200);
    assert.equal(Object.hasOwn(result.body, "logo"), false);
    assert.equal(calls.length, 0);
});
