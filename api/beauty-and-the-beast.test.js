"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createHandler } = require("./_lib/backdrop");

test("Angela Lansbury's Beauty and the Beast selects the 1991 film in both artwork orientations", async () => {
    for (const album of ["Beauty & The Beast", "Beauty And The Beast", "Beauty &amp; The Beast"])
        for (const portrait of [false, true]) {
            const requests = [];
            const handler = createHandler({
                env: { TMDB_READ_TOKEN: "test", FANART_API_KEY: "test" },
                fetchImpl: async url => {
                    const request = new URL(url);
                    requests.push(request);
                    if (request.pathname === "/3/search/movie") {
                        assert.equal(request.searchParams.get("query"), "Beauty and the Beast");
                        assert.equal(request.searchParams.get("primary_release_year"), "1991");
                        return Response.json({ results: [{ id: 10020, title: "Beauty and the Beast",
                            release_date: "1991-11-13", backdrop_path: "/animated.jpg",
                            poster_path: "/animated-poster.jpg" }] });
                    }
                    if (request.pathname === "/3/search/tv") return Response.json({ results: [
                        { id: 44606, name: "Beauty and the Beast", first_air_date: "2012-10-11" },
                    ] });
                    if (request.hostname === "webservice.fanart.tv") {
                        assert.equal(request.pathname, "/v3/movies/10020");
                        return Response.json({
                            moviebackground: [{ url: "https://assets.fanart.tv/fanart/beauty-1991.jpg" }],
                            movieposter: [{ url: "https://assets.fanart.tv/fanart/beauty-1991-poster.jpg" }],
                        });
                    }
                    throw new Error("Unexpected provider request: " + request.pathname);
                },
                tintForImage: async () => [10, 20, 30],
            });
            const res = { statusCode: 200, setHeader() {}, end(body) { this.body = JSON.parse(body); } };
            await handler({ method: "GET", headers: {}, query: {
                album, track: "Beauty And The Beast", artist: "Angela Lansbury",
                providers: "fanart,tmdb,tvmaze,steamgriddb",
                ...(portrait ? { width: "882", height: "1256" } : { width: "1280", height: "720" }),
            } }, res);
            assert.equal(res.statusCode, 200, JSON.stringify(res.body));
            assert.deepEqual(res.body.media, { id: 10020, title: "Beauty and the Beast", type: "movie" });
            assert.equal(res.body.source, "fanart");
            assert.equal(res.body.backdrop, "https://assets.fanart.tv/fanart/beauty-1991"
                + (portrait ? "-poster" : "") + ".jpg");
            assert.equal(res.body.metadata.artist, "Angela Lansbury");
            assert.equal(res.body.metadata.track, "Beauty And The Beast");
            assert.ok(!requests.some(request => request.pathname.includes("/person")
                || request.pathname.includes("/external_ids") || request.hostname === "www.steamgriddb.com"));
        }
});

test("the Lansbury mapping leaves other performers and explicitly different editions to normal matching", async () => {
    for (const [album, artist] of [
        ["Beauty & The Beast", "Emma Thompson"],
        ["Beauty & The Beast", "Alan Menken"],
        ["Beauty & The Beast (2017)", "Angela Lansbury"],
        ["Beauty & The Beast: Unknown Collection", "Angela Lansbury"],
    ]) {
        const requests = [];
        const handler = createHandler({
            env: { TMDB_READ_TOKEN: "test" },
            fetchImpl: async url => { requests.push(new URL(url)); return Response.json({ results: [] }); },
        });
        const res = { statusCode: 200, setHeader() {}, end(body) { this.body = JSON.parse(body); } };
        await handler({ method: "GET", headers: {}, query: {
            album, artist, track: "Beauty And The Beast", providers: "tmdb",
        } }, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.media, null);
        assert.ok(requests.some(request => request.pathname === "/3/search/person"));
        assert.ok(!requests.some(request => request.searchParams.get("primary_release_year") === "1991"));
    }
});
