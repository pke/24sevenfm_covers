"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const {
    CACHE_SECONDS,
    backdropTitleCandidatesFor,
    backdropTitleFor,
    cleanMovieTitle,
    createHandler,
    createTintHandler,
    mediaHintForAlbum,
    pickComposerCredit,
    pickExactPerson,
    pickGame,
    pickMedia,
    pickMovie,
    requestedRatings,
    tintFromMeans,
    tintPreviewUrl,
    trustedCoverTintUrl,
    trustedSteamGridDbUrl,
} = require("./_lib/backdrop");

test("normalizes the live The Wings Of A Film title in the resolver", () => {
    assert.equal(backdropTitleFor("The Wings Of A Film",
        "The Thin Red Line: Journey To The Line"), "The Thin Red Line");
    assert.equal(mediaHintForAlbum("The Wings Of A Film"), "movie");
    assert.equal(backdropTitleFor("Arrival (Original Motion Picture Soundtrack)",
        "Another Film: A Cue"), "Arrival");
});

test("resolves the live The Wings Of A Film album and track contract", async () => {
    let providerQuery = "";
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            providerQuery = parsed.searchParams.get("query");
            return response(200, { results: [{
                id: 8741, title: "The Thin Red Line", backdrop_path: "/thin-red-line.jpg",
            }] });
        },
        tintForImage: async () => [100, 120, 140],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "The Wings Of A Film",
        track: "The Thin Red Line: Journey To The Line",
        providers: "tmdb",
    }), res);

    assert.equal(providerQuery, "The Thin Red Line");
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 8741, title: "The Thin Red Line", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w1280/thin-red-line.jpg",
        source: "tmdb",
        tint: [100, 120, 140],
    });
});

test("resolves the live Music For A Darkened Theatre compilation track", async () => {
    let providerQuery = "";
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            providerQuery = parsed.searchParams.get("query");
            return response(200, { results: [{
                id: 1049, title: "Sommersby", backdrop_path: "/sommersby.jpg",
            }] });
        },
        tintForImage: async () => [90, 110, 130],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Music For A Darkened Theatre, Vol. 2",
        track: "Sommersby: Return Montage",
        providers: "tmdb",
    }), res);

    assert.equal(providerQuery, "Sommersby");
    assert.equal(mediaHintForAlbum("Music For A Darkened Theatre, Vol. 2"), "movie");
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 1049, title: "Sommersby", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w1280/sommersby.jpg",
        source: "tmdb",
        tint: [90, 110, 130],
    });
});

test("returns German and US movie ratings without resolving artwork", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            requests.push(parsed.pathname);
            if (parsed.pathname === "/3/search/multi") return response(200, { results: [{
                id: 293863, media_type: "movie", title: "The Age of Adaline",
                backdrop_path: "/adaline.jpg",
            }] });
            if (parsed.pathname === "/3/movie/293863/release_dates") return response(200, {
                results: [
                    { iso_3166_1: "DE", release_dates: [
                        { certification: "12", type: 4 },
                        { certification: "6", type: 3 },
                    ] },
                    { iso_3166_1: "US", release_dates: [
                        { certification: "PG-13", type: 3 },
                    ] },
                ],
            });
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => { throw new Error("must not resolve tint"); },
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Age Of Adaline, The", providers: "tmdb", ratings: "DE,US", art: "0",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 293863, title: "The Age of Adaline", type: "movie" },
        backdrop: null,
        source: null,
        tint: [255, 255, 255],
        certifications: [
            {
                country: "DE", system: "FSK", rating: "6", label: "FSK 6",
                logo: "/ratings/fsk/fsk-6.e11fbaf818b2.png",
            },
            { country: "US", system: "MPA", rating: "PG-13", label: "PG-13" },
        ],
    });
    assert.deepEqual(requests, ["/3/search/multi", "/3/movie/293863/release_dates"]);
});

test("returns Game of Thrones German and US TV ratings", async () => {
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            if (parsed.pathname === "/3/search/multi") return response(200, { results: [{
                id: 1399, media_type: "tv", name: "Game of Thrones",
                backdrop_path: "/game-of-thrones.jpg",
            }] });
            if (parsed.pathname === "/3/tv/1399/content_ratings") return response(200, {
                results: [
                    { iso_3166_1: "DE", rating: "16" },
                    { iso_3166_1: "US", rating: "TV-MA" },
                ],
            });
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => { throw new Error("must not resolve tint"); },
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Game Of Thrones", providers: "tmdb", ratings: "DE,US", art: "0",
    }), res);

    assert.deepEqual(JSON.parse(res.body).certifications, [
        {
            country: "DE", system: "FSK", rating: "16", label: "FSK 16",
            logo: "/ratings/fsk/fsk-16.83651dbb7b3b.png",
        },
        {
            country: "US", system: "TV Parental Guidelines", rating: "TV-MA", label: "TV-MA",
        },
    ]);
});

test("keeps backdrop artwork available when the rating lookup fails", async () => {
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            if (parsed.pathname === "/3/search/multi") return response(200, { results: [{
                id: 329865, media_type: "movie", title: "Arrival", backdrop_path: "/arrival.jpg",
            }] });
            if (parsed.pathname === "/3/movie/329865/release_dates") return response(503, {});
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => [10, 20, 30],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Arrival", providers: "tmdb", ratings: "DE,US",
    }), res);

    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 329865, title: "Arrival", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w1280/arrival.jpg",
        source: "tmdb",
        tint: [10, 20, 30],
        certifications: [],
    });
});

test("validates the requested rating countries", () => {
    assert.deepEqual(requestedRatings(undefined), []);
    assert.deepEqual(requestedRatings("de,US,DE"), ["DE", "US"]);
    assert.throws(() => requestedRatings("GB"), /ratings must contain DE and\/or US/);
});

test("keeps every FSK asset filename tied to its final PNG bytes", () => {
    const directory = join(__dirname, "..", "public", "ratings", "fsk");
    const files = readdirSync(directory).sort();
    assert.deepEqual(files.map((file) => file.match(/^fsk-(0|6|12|16|18)\./)?.[1]),
        ["0", "12", "16", "18", "6"]);
    for (const file of files) {
        const match = file.match(/^fsk-(?:0|6|12|16|18)\.([a-f0-9]{12})\.png$/);
        assert.ok(match, "unexpected FSK asset name: " + file);
        const digest = createHash("sha256").update(readFileSync(join(directory, file)))
            .digest("hex");
        assert.equal(match[1], digest.slice(0, 12));
    }
});

test("resolves The Dune Sketchbook through Hans Zimmer composer credits", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            requests.push(parsed.pathname);
            if (parsed.pathname === "/3/search/multi") {
                assert.equal(parsed.searchParams.get("query"), "The Dune Sketchbook");
                return response(200, { results: [] });
            }
            if (parsed.pathname === "/3/search/person") {
                assert.equal(parsed.searchParams.get("query"), "Hans Zimmer");
                return response(200, { results: [{ id: 947, name: "Hans Zimmer" }] });
            }
            if (parsed.pathname === "/3/person/947/combined_credits") {
                return response(200, { crew: [{
                    id: 438631, media_type: "movie", title: "Dune",
                    job: "Original Music Composer", backdrop_path: "/dune.jpg",
                }] });
            }
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => [214, 190, 155],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "The Dune Sketchbook", track: "House Atreides",
        artist: "Hans Zimmer", providers: "tmdb",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 438631, title: "Dune", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w1280/dune.jpg",
        source: "tmdb",
        tint: [214, 190, 155],
    });
    assert.deepEqual(new Set(requests), new Set([
        "/3/search/multi", "/3/search/person", "/3/person/947/combined_credits",
    ]));
});

test("keeps an exact title match ahead of composer-credit fallback", async () => {
    let combinedCreditRequests = 0;
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            if (parsed.pathname === "/3/search/multi") return response(200, { results: [{
                id: 329865, media_type: "movie", title: "Arrival", backdrop_path: "/arrival.jpg",
            }] });
            if (parsed.pathname === "/3/search/person") {
                return response(200, { results: [{ id: 19099, name: "Jóhann Jóhannsson" }] });
            }
            if (parsed.pathname.includes("/combined_credits")) combinedCreditRequests++;
            throw new Error("unexpected request " + parsed.href);
        },
        tintForImage: async () => [100, 110, 120],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Arrival", artist: "Jóhann Jóhannsson", providers: "tmdb",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).media.title, "Arrival");
    assert.equal(combinedCreditRequests, 0);
});

function response(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    };
}

function mockRequest(query = {}, extras = {}) {
    return {
        method: extras.method || "GET",
        headers: extras.headers || {},
        query,
    };
}

function mockResponse() {
    const headers = new Map();
    return {
        headers,
        statusCode: 0,
        body: "",
        setHeader(name, value) { headers.set(name.toLowerCase(), String(value)); },
        end(value = "") { this.body = String(value); },
    };
}

test("cleans soundtrack noise and rotated articles", () => {
    assert.equal(cleanMovieTitle("Good, The Bad & The Ugly, The (Original Motion Picture Soundtrack)"),
        "The Good, The Bad and The Ugly");
    assert.equal(cleanMovieTitle("Princess Mononoke: Symphonic Suite"), "Princess Mononoke");
    assert.equal(cleanMovieTitle("Thomas Crown Affair, The (1968)"),
        "The Thomas Crown Affair (1968)");
    assert.equal(cleanMovieTitle("The Magic Of Inspector Morse"), "Inspector Morse");
});

test("infers only explicit game, movie, and TV soundtrack markers", () => {
    assert.equal(mediaHintForAlbum("Hades (Original Video Game Soundtrack)"), "game");
    assert.equal(mediaHintForAlbum("Journey - Music From The Video Game"), "game");
    assert.equal(mediaHintForAlbum("Video Games Live: Level 2"), "game");
    assert.equal(mediaHintForAlbum("Arrival (Original Motion Picture Soundtrack)"), "movie");
    assert.equal(mediaHintForAlbum("Doctor Who (Original Television Soundtrack)"), "tv");
    assert.equal(mediaHintForAlbum("Prey"), "auto");
});

test("uses the track title for a Video Games Live compilation", () => {
    assert.equal(backdropTitleFor("Video Games Live: Level 2",
        "The Legend Of Zelda Suite"), "The Legend Of Zelda");
});

test("uses exact TV-title prefixes for a Great British TV Themes track", () => {
    assert.equal(mediaHintForAlbum("Great British TV Themes"), "tv");
    assert.deepEqual(backdropTitleCandidatesFor("Great British TV Themes",
        "The Protectors Avenues And Alleyways"), [
        "The Protectors Avenues And Alleyways",
        "The Protectors Avenues And",
        "The Protectors Avenues",
        "The Protectors",
    ]);
    assert.deepEqual(backdropTitleCandidatesFor("Great British TV Themes",
        "The Protectors - Avenues And Alleyways"), ["The Protectors"]);
});

test("uses a game's release year to disambiguate exact SteamGridDB names", () => {
    const oldGame = { id: 1, name: "Prey", release_date: 1147392000, verified: true };
    const newGame = { id: 2, name: "Prey", release_date: 1487894400, verified: false };
    assert.equal(pickGame([oldGame, newGame], "Prey (2017)"), newGame);
});

test("prefers an exact title over a more popular partial match", () => {
    const exact = { id: 2, title: "Glass", backdrop_path: null };
    assert.equal(pickMovie([
        { id: 1, title: "Glass Onion", backdrop_path: "/onion.jpg" }, exact,
    ], "Glass"), exact);
});

test("matches TV names and ignores people in TMDB multi-search results", () => {
    const show = { id: 3476, media_type: "tv", name: "Inspector Morse",
        backdrop_path: "/morse.jpg" };
    assert.equal(pickMedia([
        { id: 1, media_type: "person", name: "Inspector Morse" },
        { id: 2, media_type: "movie", title: "Inspector Morse's Oxford" },
        show,
    ], "Inspector Morse"), show);
});

test("selects one exact composer person and rejects ambiguous or partial names", () => {
    const hans = { id: 947, name: "Hans Zimmer", known_for_department: "Sound" };
    assert.equal(pickExactPerson([hans], "Hans Zimmer"), hans);
    assert.equal(pickExactPerson([hans], "Hans Zimmer Live"), null);
    assert.equal(pickExactPerson([hans, { id: 2, name: "Hans Zimmer" }], "Hans Zimmer"), null);
    assert.equal(pickExactPerson([{ id: 0, name: "Hans Zimmer" }], "Hans Zimmer"), null);
});

test("matches a unique whole-title composer crew credit inside an album title", () => {
    const dune = {
        id: 438631, media_type: "movie", title: "Dune", job: "Original Music Composer",
        backdrop_path: "/dune.jpg",
    };
    assert.equal(pickComposerCredit({
        cast: [{ ...dune, job: undefined }],
        crew: [dune, { ...dune }],
    }, "The Dune Sketchbook"), dune);
});

test("rejects unsafe composer-credit fallbacks", () => {
    const credit = (id, title, job = "Original Music Composer") => ({
        id, media_type: "movie", title, job, backdrop_path: "/" + id + ".jpg",
    });
    assert.equal(pickComposerCredit({ crew: [credit(1, "Dune", "Music Supervisor")] },
        "The Dune Sketchbook"), null);
    assert.equal(pickComposerCredit({ crew: [credit(1, "Dune")] },
        "The Dunedin Sketchbook"), null);
    assert.equal(pickComposerCredit({ crew: [credit(1, "Dune"), credit(2, "Sketchbook")] },
        "The Dune Sketchbook"), null);
    assert.equal(pickComposerCredit({ crew: [credit(1, "Up")] },
        "The Up Sketchbook"), null);
    assert.equal(pickComposerCredit({ cast: [credit(1, "Dune")] },
        "The Dune Sketchbook"), null);
});

test("ports the native overlay tint normalization", () => {
    assert.deepEqual(tintFromMeans([20, 40, 80]), [131, 172, 255]);
    assert.deepEqual(tintFromMeans([1, 2, 3]), [255, 255, 255]);
});

test("uses tiny provider-specific tint images", () => {
    assert.equal(tintPreviewUrl("tmdb", "https://image.tmdb.org/t/p/w1280/a.jpg", "/a.jpg"),
        "https://image.tmdb.org/t/p/w92/a.jpg");
    assert.equal(tintPreviewUrl("fanart",
        "https://assets.fanart.tv/fanart/movies/1/a.jpg"),
        "https://assets.fanart.tv/preview/movies/1/a.jpg");
});

test("accepts only static SteamGridDB hero CDN URLs", () => {
    assert.equal(trustedSteamGridDbUrl(
        "https://cdn2.steamgriddb.com/hero/abc123.jpg", "hero"),
    "https://cdn2.steamgriddb.com/hero/abc123.jpg");
    assert.equal(trustedSteamGridDbUrl(
        "https://cdn2.steamgriddb.com/hero_thumb/abc123.webp", "thumb"),
    "https://cdn2.steamgriddb.com/hero_thumb/abc123.webp");
    assert.equal(trustedSteamGridDbUrl("https://evil.example/hero/abc.jpg", "hero"), "");
    assert.equal(trustedSteamGridDbUrl("https://cdn2.steamgriddb.com/hero/abc.gif", "hero"), "");
});

test("resolves an explicitly marked game through SteamGridDB hero art", async () => {
    const requests = [];
    let tintUrl = "";
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key", STEAMGRIDDB_API_KEY: "sgdb-key" },
        fetchImpl: async (url, init) => {
            const value = String(url);
            requests.push(value);
            assert.equal(init.headers.Authorization, "Bearer sgdb-key");
            if (value.includes("/search/autocomplete/Hades")) return response(200, {
                success: true,
                data: [{ id: 5253, name: "Hades", verified: true, release_date: 1600905600 }],
            });
            if (value.includes("/heroes/game/5253")) return response(200, {
                success: true,
                data: [{
                    score: 10, upvotes: 20, width: 3840,
                    url: "https://cdn2.steamgriddb.com/hero/hades.jpg",
                    thumb: "https://cdn2.steamgriddb.com/hero_thumb/hades.jpg",
                }],
            });
            throw new Error("unexpected request " + value);
        },
        tintForImage: async (url) => { tintUrl = url; return [80, 90, 100]; },
    });
    const res = mockResponse();
    await handler(mockRequest({
        title: "Hades (Original Video Game Soundtrack)",
        providers: "fanart,tmdb,steamgriddb",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 5253, title: "Hades", type: "game" },
        backdrop: "https://cdn2.steamgriddb.com/hero/hades.jpg",
        source: "steamgriddb",
        tint: [80, 90, 100],
    });
    assert.equal(requests.length, 2);
    assert.equal(tintUrl, "https://cdn2.steamgriddb.com/hero_thumb/hades.jpg");
});

test("resolves a Video Games Live suite through its game track", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key", STEAMGRIDDB_API_KEY: "sgdb-key" },
        fetchImpl: async (url) => {
            const value = String(url);
            requests.push(value);
            if (value.includes("/search/autocomplete/The%20Legend%20Of%20Zelda")) {
                return response(200, { success: true, data: [{
                    id: 38050, name: "The Legend of Zelda", verified: true,
                }] });
            }
            if (value.includes("/heroes/game/38050")) return response(200, {
                success: true,
                data: [{ score: 10,
                    url: "https://cdn2.steamgriddb.com/hero/zelda.jpg",
                    thumb: "https://cdn2.steamgriddb.com/hero_thumb/zelda.jpg" }],
            });
            throw new Error("unexpected request " + value);
        },
        tintForImage: async () => [10, 20, 30],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Video Games Live: Level 2",
        track: "The Legend Of Zelda Suite",
        providers: "fanart,tmdb,steamgriddb",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 38050, title: "The Legend of Zelda", type: "game" },
        backdrop: "https://cdn2.steamgriddb.com/hero/zelda.jpg",
        source: "steamgriddb",
        tint: [10, 20, 30],
    });
    assert.equal(requests.length, 2);
    assert.equal(requests.some((url) => url.includes("api.themoviedb.org")), false);
});

test("resolves a Great British TV Themes cue through an exact track prefix", async () => {
    const queries = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key" },
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            const query = parsed.searchParams.get("query");
            queries.push(query);
            return response(200, { results: [{
                id: 4354, media_type: "tv", name: "The Protectors",
                backdrop_path: "/protectors.jpg",
            }] });
        },
        tintForImage: async () => [40, 50, 60],
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Great British TV Themes",
        track: "The Protectors Avenues And Alleyways",
        providers: "tmdb",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(queries, [
        "The Protectors Avenues And Alleyways",
        "The Protectors Avenues And",
        "The Protectors Avenues",
        "The Protectors",
    ]);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 4354, title: "The Protectors", type: "tv" },
        backdrop: "https://image.tmdb.org/t/p/w1280/protectors.jpg",
        source: "tmdb",
        tint: [40, 50, 60],
    });
});

test("bounds TV compilation prefix searches", () => {
    const candidates = backdropTitleCandidatesFor("Great British TV Themes",
        "One Two Three Four Five Six Seven Eight Nine Ten Eleven Twelve");
    assert.equal(candidates.length, 8);
});

test("rejects fuzzy TV-prefix results for a Great British TV Themes track", async () => {
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key" },
        fetchImpl: async () => response(200, { results: [{
            id: 999, media_type: "tv", name: "Unrelated Programme",
            backdrop_path: "/unrelated.jpg",
        }] }),
        tintForImage: async () => { throw new Error("must not resolve tint"); },
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "Great British TV Themes",
        track: "Unknown Programme Famous Theme",
        providers: "tmdb",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: null,
        backdrop: null,
        source: null,
        tint: [255, 255, 255],
    });
});

test("uses provider order to break an otherwise ambiguous exact title", async () => {
    let tmdbRequests = 0;
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key", STEAMGRIDDB_API_KEY: "sgdb-key" },
        fetchImpl: async (url) => {
            const value = String(url);
            if (value.includes("steamgriddb.com/api/v2/search")) return response(200, {
                success: true, data: [{ id: 99, name: "Prey", verified: true }],
            });
            if (value.includes("steamgriddb.com/api/v2/heroes")) return response(200, {
                success: true, data: [{ score: 1,
                    url: "https://cdn2.steamgriddb.com/hero/prey.jpg",
                    thumb: "https://cdn2.steamgriddb.com/hero_thumb/prey.jpg" }],
            });
            tmdbRequests++;
            return response(200, { results: [{ id: 1, media_type: "movie",
                title: "Prey", backdrop_path: "/prey.jpg" }] });
        },
        tintForImage: async () => [1, 2, 3],
    });
    const res = mockResponse();
    await handler(mockRequest({ title: "Prey", providers: "steamgriddb,tmdb" }), res);
    assert.equal(JSON.parse(res.body).media.type, "game");
    assert.equal(tmdbRequests, 0);
});

test("prefers an exact game match over a partial screen-catalog result", async () => {
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-key", STEAMGRIDDB_API_KEY: "sgdb-key" },
        fetchImpl: async (url) => {
            const value = String(url);
            if (value.includes("api.themoviedb.org")) return response(200, { results: [{
                id: 1, media_type: "movie", title: "Journey to Hades", backdrop_path: "/partial.jpg",
            }] });
            if (value.includes("/search/autocomplete/Hades")) return response(200, {
                success: true, data: [{ id: 5253, name: "Hades", verified: true }],
            });
            if (value.includes("/heroes/game/5253")) return response(200, {
                success: true, data: [{ score: 2,
                    url: "https://cdn2.steamgriddb.com/hero/hades.jpg",
                    thumb: "https://cdn2.steamgriddb.com/hero_thumb/hades.jpg" }],
            });
            throw new Error("unexpected request " + value);
        },
        tintForImage: async () => [4, 5, 6],
    });
    const res = mockResponse();
    await handler(mockRequest({
        title: "Hades", providers: "fanart,tmdb,steamgriddb",
    }), res);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 5253, title: "Hades", type: "game" },
        backdrop: "https://cdn2.steamgriddb.com/hero/hades.jpg",
        source: "steamgriddb",
        tint: [4, 5, 6],
    });
});

test("resolves fanart first and returns a precomputed tint", async () => {
    const requests = [];
    const fetchImpl = async (url) => {
        const value = String(url);
        requests.push(value);
        if (value.startsWith("https://api.themoviedb.org/3/search/multi")) {
            return response(200, { results: [{
                id: 429, media_type: "movie", title: "The Good, the Bad and the Ugly",
                backdrop_path: "/tmdb.jpg",
            }] });
        }
        if (value.startsWith("https://webservice.fanart.tv/v3/movies/429")) {
            return response(200, { moviebackground: [{
                url: "https://assets.fanart.tv/fanart/movies/429/best.jpg",
                lang: "", likes: "12",
            }] });
        }
        throw new Error("unexpected request " + value);
    };
    let tintUrl = "";
    const handler = createHandler({
        env: {
            TMDB_API_KEY: "tmdb-project-key",
            FANART_API_KEY: "fanart-project-key",
            BACKDROP_ALLOWED_ORIGINS: "https://example.test",
        },
        fetchImpl,
        tintForImage: async (url) => { tintUrl = url; return [12, 34, 56]; },
    });
    const res = mockResponse();
    await handler(mockRequest({
        title: "The Good, the Bad and the Ugly",
        client_key: "personal-key",
    }, { headers: { origin: "https://example.test" } }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 429, title: "The Good, the Bad and the Ugly", type: "movie" },
        backdrop: "https://assets.fanart.tv/fanart/movies/429/best.jpg",
        source: "fanart",
        tint: [12, 34, 56],
    });
    assert.match(requests[1], /client_key=personal-key/);
    assert.equal(tintUrl, "https://assets.fanart.tv/preview/movies/429/best.jpg");
    assert.equal(res.headers.get("access-control-allow-origin"), "https://example.test");
    assert.equal(res.headers.get("cache-control"), "public, max-age=" + CACHE_SECONDS
        + ", s-maxage=" + CACHE_SECONDS + ", stale-while-revalidate=86400");
});

test("falls back to TMDB when fanart is unavailable", async () => {
    const handler = createHandler({
        env: { TMDB_READ_TOKEN: "read-token", FANART_API_KEY: "fanart-key" },
        fetchImpl: async (url, init) => {
            const value = String(url);
            if (value.includes("search/multi")) {
                assert.equal(init.headers.Authorization, "Bearer read-token");
                return response(200, { results: [{ id: 7, media_type: "movie",
                    title: "Arrival", backdrop_path: "/arrival.jpg" }] });
            }
            return response(500, {});
        },
        tintForImage: async () => [100, 110, 120],
    });
    const res = mockResponse();
    await handler(mockRequest({ title: "Arrival" }), res);
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 7, title: "Arrival", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w1280/arrival.jpg",
        source: "tmdb",
        tint: [100, 110, 120],
    });
});

test("sends a soundtrack release year as a TMDB filter", async () => {
    const searchUrls = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-project-key" },
        fetchImpl: async (url) => {
            const searchUrl = new URL(url);
            searchUrls.push(searchUrl);
            return response(200, { results: searchUrl.pathname.endsWith("/movie") ? [{
                id: 912, title: "The Thomas Crown Affair", backdrop_path: "/crown.jpg",
            }] : [] });
        },
        tintForImage: async () => [10, 20, 30],
    });
    const res = mockResponse();
    await handler(mockRequest({
        title: "Thomas Crown Affair, The (1968)", providers: "tmdb",
    }), res);

    const movieUrl = searchUrls.find((url) => url.pathname.endsWith("/movie"));
    const tvUrl = searchUrls.find((url) => url.pathname.endsWith("/tv"));
    assert.equal(movieUrl.searchParams.get("query"), "The Thomas Crown Affair");
    assert.equal(movieUrl.searchParams.get("primary_release_year"), "1968");
    assert.equal(tvUrl.searchParams.get("query"), "The Thomas Crown Affair");
    assert.equal(tvUrl.searchParams.get("first_air_date_year"), "1968");
    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 912, title: "The Thomas Crown Affair", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w1280/crown.jpg",
        source: "tmdb",
        tint: [10, 20, 30],
    });
});

test("resolves TV fanart through the series TheTVDB id", async () => {
    const requests = [];
    const handler = createHandler({
        env: { TMDB_API_KEY: "tmdb-project-key", FANART_API_KEY: "fanart-project-key" },
        fetchImpl: async (url) => {
            const value = String(url);
            requests.push(value);
            if (value.includes("/search/multi")) {
                assert.equal(new URL(value).searchParams.get("query"), "Inspector Morse");
                return response(200, { results: [{
                    id: 3476, media_type: "tv", name: "Inspector Morse",
                    backdrop_path: "/tmdb-morse.jpg",
                }] });
            }
            if (value.includes("/tv/3476/external_ids")) {
                return response(200, { tvdb_id: 76582 });
            }
            if (value.includes("webservice.fanart.tv/v3/tv/76582")) {
                return response(200, { showbackground: [{
                    url: "https://assets.fanart.tv/fanart/tv/76582/showbackground/morse.jpg",
                    lang: "00", likes: "8",
                }] });
            }
            throw new Error("unexpected request " + value);
        },
        tintForImage: async () => [90, 100, 110],
    });
    const res = mockResponse();
    await handler(mockRequest({
        title: "The Magic Of Inspector Morse", providers: "fanart,tmdb",
        client_key: "personal-key",
    }), res);

    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 3476, title: "Inspector Morse", type: "tv" },
        backdrop: "https://assets.fanart.tv/fanart/tv/76582/showbackground/morse.jpg",
        source: "fanart",
        tint: [90, 100, 110],
    });
    assert.match(requests[2], /client_key=personal-key/);
});

test("falls back to the TMDB series backdrop when TV fanart is unavailable", async () => {
    const handler = createHandler({
        env: { TMDB_API_KEY: "key", FANART_API_KEY: "fanart-key" },
        fetchImpl: async (url) => {
            const value = String(url);
            if (value.includes("/search/multi")) return response(200, { results: [{
                id: 3476, media_type: "tv", name: "Inspector Morse",
                backdrop_path: "/morse.jpg",
            }] });
            if (value.includes("/tv/3476/external_ids")) return response(200, { tvdb_id: 76582 });
            if (value.includes("webservice.fanart.tv/v3/tv/76582")) return response(200, {});
            throw new Error("unexpected request " + value);
        },
        tintForImage: async () => [120, 130, 140],
    });
    const res = mockResponse();
    await handler(mockRequest({ title: "The Magic Of Inspector Morse" }), res);

    assert.deepEqual(JSON.parse(res.body), {
        media: { id: 3476, title: "Inspector Morse", type: "tv" },
        backdrop: "https://image.tmdb.org/t/p/w1280/morse.jpg",
        source: "tmdb",
        tint: [120, 130, 140],
    });
});

test("auto-detects a v4 read token stored under the legacy TMDB_API_KEY name", async () => {
    const legacyToken = "eyJhbGciOiJIUzI1NiJ9.payload.signature";
    const handler = createHandler({
        env: { TMDB_API_KEY: legacyToken },
        fetchImpl: async (url, init) => {
            assert.equal(init.headers.Authorization, "Bearer " + legacyToken);
            assert.equal(new URL(url).searchParams.has("api_key"), false);
            return response(200, { results: [] });
        },
        tintForImage: async () => { throw new Error("must not run"); },
    });
    const res = mockResponse();
    await handler(mockRequest({ title: "Arrival", providers: "tmdb" }), res);
    assert.equal(res.statusCode, 200);
});

test("returns a cacheable miss without exposing provider details", async () => {
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async () => response(200, { results: [] }),
        tintForImage: async () => { throw new Error("must not run"); },
    });
    const res = mockResponse();
    await handler(mockRequest({ title: "Unknown" }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        media: null, backdrop: null, source: null, tint: [255, 255, 255],
    });
    assert.match(res.headers.get("cache-control"), /s-maxage=/);
});

test("rejects invalid artist metadata before provider access", async () => {
    let requests = 0;
    const handler = createHandler({
        env: { TMDB_API_KEY: "key" },
        fetchImpl: async () => {
            requests++;
            return response(200, { results: [] });
        },
        tintForImage: async () => { throw new Error("must not run"); },
    });
    for (const artist of ["x".repeat(181), "Hans\u0000Zimmer"]) {
        const res = mockResponse();
        await handler(mockRequest({ title: "Dune", artist }), res);
        assert.equal(res.statusCode, 400);
        assert.deepEqual(JSON.parse(res.body), { error: "invalid_artist" });
    }
    assert.equal(requests, 0);
});

test("accepts only canonical cover URLs from explicitly allowed hosts", () => {
    const env = { TINT_ALLOWED_HOSTS: "streamingsoundtracks.com" };
    assert.equal(trustedCoverTintUrl(
        "https://streamingsoundtracks.com/images/cover/B000FBFTCS.jpg", env),
    "https://streamingsoundtracks.com/images/cover/B000FBFTCS.jpg");
    assert.equal(trustedCoverTintUrl("http://streamingsoundtracks.com/images/cover/a.jpg", env), "");
    assert.equal(trustedCoverTintUrl("https://evil.example/images/cover/a.jpg", env), "");
    assert.equal(trustedCoverTintUrl("https://streamingsoundtracks.com/admin", env), "");
    assert.equal(trustedCoverTintUrl(
        "https://streamingsoundtracks.com/images/cover/500/a.jpg", env), "");
    assert.equal(trustedCoverTintUrl(
        "https://streamingsoundtracks.com/images/cover/a.jpg?cache-bust=1", env), "");
});

test("returns a cacheable tint for a bounded trusted image", async () => {
    let fetchedUrl = "";
    const handler = createTintHandler({
        env: {
            TINT_ALLOWED_HOSTS: "streamingsoundtracks.com",
            BACKDROP_ALLOWED_ORIGINS: "https://example.test",
        },
        fetchImpl: async (url, init) => {
            fetchedUrl = String(url);
            assert.equal(init.redirect, "manual");
            return new Response(new Uint8Array([1, 2, 3]), {
                headers: { "content-type": "image/jpeg", "content-length": "3" },
            });
        },
        tintFromBytes: async (bytes) => {
            assert.deepEqual([...bytes], [1, 2, 3]);
            return [12, 34, 56];
        },
    });
    const res = mockResponse();
    await handler(mockRequest({
        url: "https://streamingsoundtracks.com/images/cover/B000FBFTCS.jpg",
    }, { headers: { origin: "https://example.test" } }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { tint: [12, 34, 56] });
    assert.match(fetchedUrl, /\/images\/cover\/B000FBFTCS\.jpg$/);
    assert.equal(res.headers.get("access-control-allow-origin"), "https://example.test");
    assert.match(res.headers.get("cache-control"), /s-maxage=/);
});

test("blocks redirects outside the cover allowlist", async () => {
    let requests = 0;
    const handler = createTintHandler({
        env: { TINT_ALLOWED_HOSTS: "streamingsoundtracks.com" },
        fetchImpl: async () => {
            requests++;
            return new Response(null, {
                status: 302,
                headers: { location: "http://127.0.0.1/private.jpg" },
            });
        },
    });
    const res = mockResponse();
    await handler(mockRequest({
        url: "https://streamingsoundtracks.com/images/cover/B000FBFTCS.jpg",
    }), res);
    assert.equal(requests, 1);
    assert.equal(res.statusCode, 502);
    assert.deepEqual(JSON.parse(res.body), { error: "image_redirect_not_allowed" });
    assert.equal(res.headers.get("cache-control"), "no-store");
});

test("rejects oversized cover responses before decoding", async () => {
    let decoded = false;
    const handler = createTintHandler({
        env: { TINT_ALLOWED_HOSTS: "streamingsoundtracks.com" },
        fetchImpl: async () => new Response(new Uint8Array([1]), {
            headers: { "content-type": "image/jpeg", "content-length": String(2 * 1024 * 1024 + 1) },
        }),
        tintFromBytes: async () => { decoded = true; return [1, 2, 3]; },
    });
    const res = mockResponse();
    await handler(mockRequest({
        url: "https://streamingsoundtracks.com/images/cover/B000FBFTCS.jpg",
    }), res);
    assert.equal(res.statusCode, 413);
    assert.deepEqual(JSON.parse(res.body), { error: "image_too_large" });
    assert.equal(decoded, false);
});

test("rejects unapproved browser origins before provider access", async () => {
    let fetched = false;
    const handler = createHandler({
        env: { TMDB_API_KEY: "key", BACKDROP_ALLOWED_ORIGINS: "https://allowed.test" },
        fetchImpl: async () => { fetched = true; return response(200, {}); },
    });
    const res = mockResponse();
    await handler(mockRequest({ title: "Arrival" }, {
        headers: { origin: "https://attacker.test" },
    }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(fetched, false);
    assert.equal(res.headers.get("cache-control"), "no-store");
});
