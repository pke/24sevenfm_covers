"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createHandler, backdropTitleCandidatesFor, mediaHintForAlbum } = require("./_lib/backdrop");

const works = [
    { track: "Star Trek, First Contact (End Title)", title: "Star Trek: First Contact", id: 199, type: "movie" },
    { track: "Star Trek: The Motion Picture (The Enterprise)", title: "Star Trek: The Motion Picture", id: 152, type: "movie" },
    { track: "Star Trek: Voyager (Main Title)", title: "Star Trek: Voyager", id: 1855, type: "tv" },
    { track: "Logan's Run (The Monument)", title: "Logan's Run", id: 10803, type: "movie" },
    { track: "Alien (End Title)", title: "Alien", id: 348, type: "movie" },
];

test("Frontiers uses exact track titles only for Goldsmith's known compilation", () => {
    for (const album of ["Frontiers", "Frontiers: Classic Science Fiction Themes"])
        for (const artist of ["Jerry Goldsmith", "Goldsmith, Jerry"]) {
            assert.equal(mediaHintForAlbum(album, artist), "screen");
            assert.deepEqual(backdropTitleCandidatesFor(album, works[0].track, artist), [
                works[0].track, "Star Trek, First Contact",
            ]);
        }
    for (const [album, artist] of [["Frontiers", "Other Artist"], ["Frontiers", ""],
        ["Frontiers (2026)", "Jerry Goldsmith"], ["Frontiers: Unknown Collection", "Jerry Goldsmith"]]) {
        assert.equal(mediaHintForAlbum(album, artist), "auto");
        assert.deepEqual(backdropTitleCandidatesFor(album, works[0].track, artist), [album]);
    }
});

test("each Frontiers work selects its own film or series and provider artwork in both orientations", async () => {
    for (const work of works) for (const portrait of [false, true]) {
        const requests = [];
        const media = { id: work.id, media_type: work.type, backdrop_path: "/back.jpg", poster_path: "/poster.jpg",
            ...(work.type === "tv" ? { name: work.title } : { title: work.title }) };
        const handler = createHandler({
            env: { TMDB_READ_TOKEN: "test", FANART_API_KEY: "test" },
            fetchImpl: async url => {
                const request = new URL(url); requests.push(request);
                if (request.pathname === "/3/search/person")
                    return Response.json({ results: [{ id: 1729, name: "Jerry Goldsmith", known_for_department: "Sound" }] });
                if (request.pathname === "/3/search/multi") return Response.json({ results: [media] });
                if (request.pathname === "/3/person/1729/combined_credits")
                    return Response.json({ crew: [{ ...media, job: "Original Music Composer" }] });
                if (request.pathname.endsWith("/credits") || request.pathname.endsWith("/aggregate_credits"))
                    return Response.json({ crew: [{ id: 1729, job: "Original Music Composer" }] });
                if (request.pathname === "/3/tv/1855/external_ids") return Response.json({ tvdb_id: 74550 });
                if (request.hostname === "webservice.fanart.tv") {
                    assert.equal(request.pathname, work.type === "tv" ? "/v3/tv/74550" : "/v3/movies/" + work.id);
                    return Response.json({
                        [work.type === "tv" ? "showbackground" : "moviebackground"]: [
                            { url: `https://assets.fanart.tv/fanart/frontiers-${work.id}.jpg` }],
                        [work.type === "tv" ? "tvposter" : "movieposter"]: [
                            { url: `https://assets.fanart.tv/fanart/frontiers-${work.id}-poster.jpg` }],
                    });
                }
                throw new Error("Unexpected provider request: " + request.pathname);
            },
            tintForImage: async () => [10, 20, 30],
        });
        const res = { statusCode: 200, setHeader() {}, end(body) { this.body = JSON.parse(body); } };
        await handler({ method: "GET", headers: {}, query: {
            album: "Frontiers", track: work.track, artist: "Jerry Goldsmith",
            providers: "fanart,tmdb,tvmaze,steamgriddb",
            width: portrait ? "882" : "1280", height: portrait ? "1256" : "720",
        } }, res);
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.deepEqual(res.body.media, { id: work.id, title: work.title, type: work.type });
        assert.equal(res.body.source, "fanart");
        assert.equal(res.body.backdrop, `https://assets.fanart.tv/fanart/frontiers-${work.id}${portrait ? "-poster" : ""}.jpg`);
        assert.deepEqual(res.body.metadata, { album: "Frontiers", track: work.track, artist: "Jerry Goldsmith" });
        assert.ok(!requests.some(request => request.hostname === "www.steamgriddb.com"
            || request.searchParams.get("query") === "Frontiers"));
    }
});

test("an unknown Frontiers cue cannot fall back to the unrelated Frontiers game or a partial screen match", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_READ_TOKEN: "test", STEAMGRIDDB_API_KEY: "test" },
        fetchImpl: async url => {
            const request = new URL(url); requests.push(request);
            if (request.pathname === "/3/search/person") return Response.json({ results: [] });
            if (request.pathname === "/3/search/multi") return Response.json({ results: [
                { id: 42, title: "The Unknown Cue Returns", media_type: "movie", backdrop_path: "/unrelated.jpg" },
            ] });
            throw new Error("Unexpected provider request: " + request.pathname);
        },
    });
    const res = { statusCode: 200, setHeader() {}, end(body) { this.body = JSON.parse(body); } };
    await handler({ method: "GET", headers: {}, query: {
        album: "Frontiers", track: "The Unknown Cue", artist: "Jerry Goldsmith", providers: "tmdb,steamgriddb",
    } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.media, null);
    assert.equal(res.body.backdrop, null);
    assert.ok(!requests.some(request => request.hostname === "www.steamgriddb.com"));
});
