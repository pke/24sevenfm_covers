"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createHandler } = require("./_lib/backdrop");

function resolver(type = "movie", fanart = null) {
    const requests = [], previews = [];
    const handler = createHandler({
        env: { TMDB_READ_TOKEN: "test", FANART_API_KEY: "test" },
        fetchImpl: async url => {
            const parsed = new URL(url);
            requests.push(parsed.hostname + parsed.pathname);
            if (parsed.pathname === "/3/search/multi") return Response.json({ results: [{
                id: 7, media_type: type, title: "Arrival", name: "Arrival",
                backdrop_path: "/arrival-backdrop.jpg", poster_path: "/arrival-poster.jpg",
            }] });
            if (parsed.hostname === "webservice.fanart.tv") return Response.json(fanart || {});
            throw new Error("Unexpected provider request: " + parsed.pathname);
        },
        tintForImage: async url => { previews.push(url); return [10, 20, 30]; },
    });
    return {
        requests, previews,
        async resolve(query = {}) {
            const req = { method: "GET", headers: {}, query: {
                album: "Arrival", providers: "tmdb", ...query,
            } };
            const res = { statusCode: 200, setHeader() {}, end(body) { this.body = body; } };
            await handler(req, res);
            assert.equal(res.statusCode, 200, res.body);
            return JSON.parse(res.body);
        },
    };
}

test("TMDB chooses originals for UHD movie and TV surfaces, with HD boundary preserved", async () => {
    for (const type of ["movie", "tv"]) {
        const api = resolver(type);
        for (const [query, size, image] of [
            [{}, "w1280", "backdrop"],
            [{ width: "1920", height: "1080" }, "w1280", "backdrop"],
            [{ width: "1921", height: "1080" }, "original", "backdrop"],
            [{ width: "1920", height: "1081" }, "original", "backdrop"],
            [{ width: "3840", height: "2160" }, "original", "backdrop"],
            [{ width: "720", height: "1080" }, "w780", "poster"],
            [{ width: "720", height: "1081" }, "original", "poster"],
            [{ width: "2160", height: "3840" }, "original", "poster"],
            [{ width: "2160", height: "2160" }, "original", "backdrop"],
        ]) {
            const result = await api.resolve(query);
            assert.equal(result.source, "tmdb");
            assert.equal(result.backdrop, `https://image.tmdb.org/t/p/${size}/arrival-${image}.jpg`);
            assert.equal(result.media.type, type);
        }
        // Four orientation/resolution variants; resizing within a class reuses
        // the resolver result and returning to HD cannot inherit an original URL.
        assert.equal(api.requests.length, 4);
        const calls = api.requests.length;
        assert.match((await api.resolve({ width: "1920", height: "1080" })).backdrop, /\/w1280\//);
        assert.match((await api.resolve({ width: "720", height: "1080" })).backdrop, /\/w780\//);
        assert.equal(api.requests.length, calls);
        assert.deepEqual(api.previews, [
            "https://image.tmdb.org/t/p/w92/arrival-backdrop.jpg",
            "https://image.tmdb.org/t/p/w92/arrival-backdrop.jpg",
            "https://image.tmdb.org/t/p/w92/arrival-poster.jpg",
            "https://image.tmdb.org/t/p/w92/arrival-poster.jpg",
        ]);
    }
});

test("TMDB UHD fallback preserves provider priority and metadata-only requests skip artwork", async () => {
    const query = { providers: "fanart,tmdb", width: "3840", height: "2160" };
    const fallback = resolver();
    assert.equal((await fallback.resolve(query)).backdrop,
        "https://image.tmdb.org/t/p/original/arrival-backdrop.jpg");
    assert.equal(fallback.requests.length, 2);

    const fanartUrl = "https://assets.fanart.tv/fanart/arrival.jpg";
    const preferred = resolver("movie", { moviebackground: [{ url: fanartUrl, lang: "00" }] });
    assert.equal((await preferred.resolve(query)).backdrop, fanartUrl);

    const metadata = resolver();
    const result = await metadata.resolve({ ...query, art: "0" });
    assert.equal(result.backdrop, null);
    assert.equal(result.metadata.album, "Arrival");
    assert.deepEqual(metadata.requests, []);
});
