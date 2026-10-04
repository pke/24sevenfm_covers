"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createHandler, pickComposerCredit } = require("./_lib/backdrop");

const original = {
    id: 11224, media_type: "movie", title: "Cinderella", release_date: "1950-02-22",
    backdrop_path: "/cinderella-1950.jpg", poster_path: "/cinderella-1950-poster.jpg",
};
const remake = { ...original, id: 150689, release_date: "2015-03-12",
    backdrop_path: "/cinderella-2015.jpg", poster_path: "/cinderella-2015-poster.jpg" };
const writerId = 1726478;

async function resolve({ job = "Songs", alternatives = false, combined = [],
    creditedId = writerId, tv = false, portrait = false } = {}) {
    const requests = [];
    const media = tv ? { ...original, media_type: "tv", name: original.title } : original;
    const handler = createHandler({
        env: { TMDB_READ_TOKEN: "test", FANART_API_KEY: "test" },
        fetchImpl: async url => {
            const parsed = new URL(url);
            requests.push(parsed.hostname + parsed.pathname);
            if (parsed.pathname === "/3/search/person") return Response.json({ results: [{
                id: writerId, name: "Mack David", known_for_department: "Sound",
            }] });
            if (parsed.pathname === "/3/search/multi") return Response.json({
                results: alternatives ? [remake, media] : [media],
            });
            if (parsed.pathname === `/3/person/${writerId}/combined_credits`)
                return Response.json({ crew: combined });
            if (parsed.pathname.endsWith("/credits") || parsed.pathname.endsWith("/aggregate_credits"))
                return Response.json({ crew: [
                    { id: 2107, job: "Original Music Composer" },
                    tv ? { id: creditedId, jobs: [{ job }] } : { id: creditedId, job },
                ] });
            if (parsed.hostname === "webservice.fanart.tv") return Response.json({
                moviebackground: [{ url: "https://assets.fanart.tv/fanart/cinderella-1950.jpg" }],
                movieposter: [{ url: "https://assets.fanart.tv/fanart/cinderella-1950-poster.jpg" }],
            });
            throw new Error("Unexpected request: " + parsed.pathname);
        },
        tintForImage: async () => [10, 20, 30],
    });
    const res = { statusCode: 200, setHeader() {}, end(body) { this.body = body; } };
    await handler({ method: "GET", headers: {}, query: {
        album: "Cinderella", artist: "Mack David", track: "Locked In The Tower; Finale",
        providers: tv ? "tmdb" : "fanart,tmdb", ...(portrait ? { width: "720", height: "1080" } : {}),
    } }, res);
    assert.equal(res.statusCode, 200, res.body);
    return { body: JSON.parse(res.body), requests };
}

test("Cinderella songwriter credits retain the exact film and fanart provider in both orientations", async () => {
    for (const job of ["Songs", "Lyricist"]) for (const portrait of [false, true]) {
        const { body } = await resolve({ job, portrait });
        assert.equal(body.media.id, original.id);
        assert.equal(body.source, "fanart");
        assert.equal(body.backdrop, "https://assets.fanart.tv/fanart/cinderella-1950"
            + (portrait ? "-poster" : "") + ".jpg");
        assert.equal(body.metadata.artist, "Mack David");
    }
});

test("a unique songwriter credit selects the original Cinderella ahead of a same-title remake", async () => {
    const { body, requests } = await resolve({ alternatives: true, combined: [
        { ...original, job: "Songs" }, { ...original, job: "Lyricist" },
    ] });
    assert.equal(body.media.id, original.id);
    assert.equal(body.source, "fanart");
    assert.ok(requests.includes("webservice.fanart.tv/v3/movies/11224"));
    assert.ok(!requests.includes("webservice.fanart.tv/v3/movies/150689"));
});

test("TV aggregate soundtrack writing jobs also validate an exact title", async () => {
    const { body } = await resolve({ job: "Songs", tv: true });
    assert.equal(body.media.type, "tv");
    assert.equal(body.media.id, original.id);
    assert.equal(body.source, "tmdb");
});

test("music support jobs and another writer's credit do not validate the requested artist", async () => {
    for (const options of [{ job: "Music Editor" }, { job: "Music Supervisor" },
        { job: "Sound Director" }, { job: "Songs", creditedId: 1726479 }]) {
        const { body, requests } = await resolve(options);
        assert.equal(body.media, null);
        assert.equal(body.backdrop, null);
        assert.ok(!requests.some(path => path.startsWith("webservice.fanart.tv")));
    }
});

test("songwriter fallback still requires a unique whole title and ignores cast", () => {
    const song = { ...original, job: "Songs" };
    assert.equal(pickComposerCredit({ crew: [song, { ...original, job: "Lyricist" }] }, "Cinderella"), song);
    assert.equal(pickComposerCredit({ crew: [song, { ...remake, job: "Songs" }] }, "Cinderella"), null);
    assert.equal(pickComposerCredit({ crew: [song] }, "Cinderellaish"), null);
    assert.equal(pickComposerCredit({ cast: [song] }, "Cinderella"), null);
});
