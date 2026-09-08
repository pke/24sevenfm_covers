"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createHandler } = require("./_lib/backdrop");

function response(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    };
}

function mockRequest(query) {
    return { method: "GET", headers: {}, query };
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

const cases = [
    {
        name: "resolves Escape From Television cue as Miami Vice",
        query: {
            album: "Escape From Television",
            track: "Tubbs And Valerie",
            artist: "Jan Hammer",
        },
        searchTitle: "Miami Vice (1984)",
        tmdb: {
            id: 1908,
            media_type: "tv",
            name: "Miami Vice",
            first_air_date: "1984-09-16",
            backdrop_path: "/miami-vice.jpg",
        },
        expected: { id: 1908, title: "Miami Vice", type: "tv" },
        backdrop: "https://image.tmdb.org/t/p/w1280/miami-vice.jpg",
    },
    {
        name: "resolves Says as the Ad Astra film",
        query: { album: "Ad Astra", track: "Says", artist: "Nils Frahm" },
        searchTitle: "Ad Astra (2019)",
        tmdb: {
            id: 419704,
            media_type: "movie",
            title: "Ad Astra",
            release_date: "2019-09-17",
            backdrop_path: "/ad-astra.jpg",
        },
        expected: { id: 419704, title: "Ad Astra", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w1280/ad-astra.jpg",
    },
    {
        name: "resolves I Luv U as the 2005 London film",
        query: { album: "London", track: "I Luv U", artist: "Crystal Method, The" },
        searchTitle: "London (2005)",
        tmdb: {
            id: 7515,
            media_type: "movie",
            title: "London",
            release_date: "2005-09-03",
            backdrop_path: "/london.jpg",
        },
        expected: { id: 7515, title: "London", type: "movie" },
        backdrop: "https://image.tmdb.org/t/p/w1280/london.jpg",
    },
];

for (const fixture of cases) {
    test(fixture.name, async () => {
        const requests = [];
        const handler = createHandler({
            env: { TMDB_API_KEY: "key" },
            fetchImpl: async (url) => {
                const parsed = new URL(url);
                requests.push(parsed.href);
                assert.match(parsed.pathname, /^\/3\/search\/(?:movie|tv)$/);
                assert.equal(parsed.searchParams.get("query"),
                    fixture.searchTitle.replace(/ \(\d{4}\)$/, ""));
                const searchType = parsed.pathname.endsWith("/tv") ? "tv" : "movie";
                const yearParam = searchType === "tv"
                    ? "first_air_date_year" : "primary_release_year";
                assert.equal(parsed.searchParams.get(yearParam),
                    fixture.searchTitle.match(/\((\d{4})\)$/)[1]);
                return response(200, {
                    results: searchType === fixture.expected.type ? [fixture.tmdb] : [],
                });
            },
            tintForImage: async () => [120, 130, 140],
        });
        const res = mockResponse();

        await handler(mockRequest({ ...fixture.query, providers: "tmdb" }), res);

        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.deepEqual(body.media, fixture.expected);
        assert.equal(body.backdrop, fixture.backdrop);
        assert.equal(body.source, "tmdb");
        assert.deepEqual(body.tint, [120, 130, 140]);
        assert.equal(requests.length, 2);
    });
}
