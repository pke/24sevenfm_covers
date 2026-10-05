"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createHandler } = require("./_lib/backdrop");

const album = "Lion King, The: Hakuna Matata ...Rhythm Of The Pride Lands";

test("Passage To Dawn with Diego Navarro resolves its verified Spanish original title", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_READ_TOKEN: "test" },
        fetchImpl: async url => {
            const request = new URL(url);
            requests.push(request);
            if (request.pathname === "/3/search/multi") {
                assert.equal(request.searchParams.get("query"), "Pasaje al amanecer");
                return Response.json({ results: [{ id: 405360, title: "Pasaje al amanecer",
                    media_type: "movie", release_date: "2016-10-22", backdrop_path: "/pasaje.jpg",
                    poster_path: "/pasaje-poster.jpg" }] });
            }
            if (request.pathname === "/3/search/tv") return Response.json({ results: [] });
            throw new Error("Unexpected request: " + request.pathname);
        },
        tintForImage: async () => [10, 20, 30],
    });
    for (const portrait of [false, true]) {
        const res = { statusCode: 200, setHeader() {}, end(body) { this.body = body; } };
        await handler({ method: "GET", headers: {}, query: {
            album: "Passage To Dawn", track: "Moonlight", artist: "Diego Navarro", providers: "tmdb",
            ...(portrait ? { width: "720", height: "1080" } : {}),
        } }, res);
        assert.equal(res.statusCode, 200, res.body);
        const result = JSON.parse(res.body);
        assert.equal(result.media.id, 405360);
        const backdrop = new URL(result.backdrop);
        assert.equal(backdrop.hostname, "image.tmdb.org");
        assert.ok(backdrop.pathname.endsWith("/pasaje" + (portrait ? "-poster" : "") + ".jpg"));
        assert.deepEqual(result.metadata, { album: "Passage To Dawn", track: "Moonlight", artist: "Diego Navarro" });
    }
    assert.ok(!requests.some(request => request.pathname.includes("/person")));
});

test("the Passage To Dawn alias requires its verified composer and complete album title", async () => {
    for (const [otherAlbum, artist] of [["Passage To Dawn", "Other Composer"],
        ["Passage To Dawn (2024)", "Diego Navarro"]]) {
        const requests = [];
        const handler = createHandler({
            env: { TMDB_READ_TOKEN: "test" },
            fetchImpl: async url => { requests.push(new URL(url)); return Response.json({ results: [] }); },
        });
        const res = { statusCode: 200, setHeader() {}, end(body) { this.body = body; } };
        await handler({ method: "GET", headers: {}, query: { album: otherAlbum, artist, providers: "tmdb" } }, res);
        assert.equal(res.statusCode, 200);
        assert.equal(JSON.parse(res.body).media, null);
        assert.ok(!requests.some(request => request.searchParams.get("query") === "Pasaje al amanecer"));
    }
});

test("Rhythm Of The Pride Lands resolves the 1994 Lion King with the station's performer credit", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_READ_TOKEN: "test", FANART_API_KEY: "test" },
        fetchImpl: async url => {
            const request = new URL(url);
            requests.push(request);
            if (request.pathname === "/3/search/movie") {
                assert.equal(request.searchParams.get("query"), "The Lion King");
                assert.equal(request.searchParams.get("primary_release_year"), "1994");
                return Response.json({ results: [{ id: 8587, title: "The Lion King",
                    release_date: "1994-06-24", backdrop_path: "/original.jpg",
                    poster_path: "/original-poster.jpg" }] });
            }
            if (request.pathname === "/3/search/tv") return Response.json({ results: [] });
            if (request.hostname === "webservice.fanart.tv") {
                assert.equal(request.pathname, "/v3/movies/8587");
                return Response.json({
                    moviebackground: [{ url: "https://assets.fanart.tv/fanart/lion-king-1994.jpg" }],
                    movieposter: [{ url: "https://assets.fanart.tv/fanart/lion-king-1994-poster.jpg" }],
                });
            }
            throw new Error("Unexpected request: " + request.pathname);
        },
        tintForImage: async () => [10, 20, 30],
    });
    for (const portrait of [false, true]) {
        const res = { statusCode: 200, setHeader() {}, end(body) { this.body = body; } };
        await handler({ method: "GET", headers: {}, query: {
            album, track: "Lea Halalela", artist: "Khululiwe Sithole",
            providers: "fanart,tmdb,tvmaze,steamgriddb",
            ...(portrait ? { width: "720", height: "1080" } : {}),
        } }, res);
        assert.equal(res.statusCode, 200, res.body);
        const result = JSON.parse(res.body);
        assert.equal(result.media.id, 8587);
        assert.equal(result.source, "fanart");
        assert.equal(result.backdrop, "https://assets.fanart.tv/fanart/lion-king-1994"
            + (portrait ? "-poster" : "") + ".jpg");
        assert.deepEqual(result.metadata, { album: "The Lion King: Hakuna Matata ...Rhythm Of The Pride Lands",
            track: "Lea Halalela", artist: "Khululiwe Sithole" });
    }
    assert.ok(!requests.some(request => request.pathname.includes("/person")
        || request.hostname === "www.steamgriddb.com"));
});

test("the verified album mapping does not strip an arbitrary Lion King subtitle or revision", async () => {
    for (const otherAlbum of ["Lion King, The: Unknown Collection", album + " (2019)"]) {
        const requests = [];
        const handler = createHandler({
            env: { TMDB_READ_TOKEN: "test" },
            fetchImpl: async url => {
                const request = new URL(url);
                requests.push(request);
                return Response.json({ results: [] });
            },
            tintForImage: async () => [10, 20, 30],
        });
        const res = { statusCode: 200, setHeader() {}, end(body) { this.body = body; } };
        await handler({ method: "GET", headers: {}, query: {
            album: otherAlbum, track: "Lea Halalela", artist: "Khululiwe Sithole", providers: "tmdb",
        } }, res);
        assert.equal(res.statusCode, 200);
        assert.equal(JSON.parse(res.body).media, null);
        assert.ok(requests.some(request => request.pathname === "/3/search/person"));
        assert.ok(!requests.some(request => request.searchParams.get("primary_release_year") === "1994"));
    }
});
