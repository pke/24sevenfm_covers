"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
    CREDIT_CACHE_SECONDS,
    CREDIT_MISS_CACHE_SECONDS,
    artistFromAlbumHtml,
    createCreditHandler,
    trustedAlbumUrl,
} = require("./_lib/credit");

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

test("extracts the album credit from stable Open Graph metadata", () => {
    const html = `<!doctype html><html><head>
        <meta content="StreamingSoundtracks - StreamingSoundtracks.com -
            JFK (2013) - Joel Goodman" property="og:title">
        </head></html>`;

    assert.equal(artistFromAlbumHtml(html, "JFK (2013)"), "Joel Goodman");
    assert.equal(artistFromAlbumHtml(
        '<meta property="og:title" content="Station - Rock &amp; Roll - Hall &amp; Oates">',
        "Rock & Roll"), "Hall & Oates");
});

test("does not guess a credit when the exact album is absent", () => {
    assert.equal(artistFromAlbumHtml(
        '<meta property="og:title" content="Station - Another Album - Someone">',
        "Requested Album"), "");
    assert.equal(artistFromAlbumHtml("<html></html>", "Requested Album"), "");
});

test("accepts only exact public album links on an allowed station", () => {
    const env = { ALBUM_CREDIT_ALLOWED_HOSTS: "streamingsoundtracks.com,death.fm" };
    assert.equal(trustedAlbumUrl(
        "https://streamingsoundtracks.com/modules.php?name=Album&asin=B00GHJ08XC", env),
    "https://streamingsoundtracks.com/modules.php?name=Album&asin=B00GHJ08XC");
    for (const value of [
        "http://streamingsoundtracks.com/modules.php?name=Album&asin=B00GHJ08XC",
        "https://evil.example/modules.php?name=Album&asin=B00GHJ08XC",
        "https://streamingsoundtracks.com/admin?name=Album&asin=B00GHJ08XC",
        "https://streamingsoundtracks.com/modules.php?name=Other&asin=B00GHJ08XC",
        "https://streamingsoundtracks.com/modules.php?name=Album&asin=../../admin",
        "https://streamingsoundtracks.com/modules.php?name=Album&asin=B00&extra=1",
    ]) assert.equal(trustedAlbumUrl(value, env), "", value);
});

test("returns a cacheable composer from the station album page", async () => {
    let requestUrl = "", requestInit;
    const handler = createCreditHandler({
        env: {
            ALBUM_CREDIT_ALLOWED_HOSTS: "streamingsoundtracks.com",
            BACKDROP_ALLOWED_ORIGINS: "https://player.test",
        },
        fetchImpl: async (url, init) => {
            requestUrl = String(url);
            requestInit = init;
            return new Response(
                '<meta property="og:title" content="StreamingSoundtracks - '
                    + 'StreamingSoundtracks.com - JFK (2013) - Joel Goodman">',
                { headers: { "content-type": "text/html; charset=utf-8" } });
        },
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "JFK (2013)",
        url: "https://streamingsoundtracks.com/modules.php?name=Album&asin=B00GHJ08XC",
    }, { headers: { origin: "https://player.test" } }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { artist: "Joel Goodman" });
    assert.equal(requestUrl,
        "https://streamingsoundtracks.com/modules.php?name=Album&asin=B00GHJ08XC");
    assert.equal(requestInit.redirect, "manual");
    assert.equal(res.headers.get("access-control-allow-origin"), "https://player.test");
    assert.equal(res.headers.get("cache-control"), "public, max-age=" + CREDIT_CACHE_SECONDS
        + ", s-maxage=" + CREDIT_CACHE_SECONDS + ", stale-while-revalidate=86400");
});

test("returns a short-cache miss when the album page has no usable credit", async () => {
    const handler = createCreditHandler({
        env: { ALBUM_CREDIT_ALLOWED_HOSTS: "streamingsoundtracks.com" },
        fetchImpl: async () => new Response(
            '<meta property="og:title" content="Unexpected title">',
            { headers: { "content-type": "text/html" } }),
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "JFK (2013)",
        url: "https://streamingsoundtracks.com/modules.php?name=Album&asin=B00GHJ08XC",
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { artist: "" });
    assert.equal(res.headers.get("cache-control"), "public, max-age=" + CREDIT_MISS_CACHE_SECONDS
        + ", s-maxage=" + CREDIT_MISS_CACHE_SECONDS + ", stale-while-revalidate=60");
});

test("rejects untrusted album URLs before making a request", async () => {
    let fetched = false;
    const handler = createCreditHandler({
        env: { ALBUM_CREDIT_ALLOWED_HOSTS: "streamingsoundtracks.com" },
        fetchImpl: async () => { fetched = true; throw new Error("must not fetch"); },
    });
    const res = mockResponse();
    await handler(mockRequest({
        album: "JFK (2013)",
        url: "https://127.0.0.1/modules.php?name=Album&asin=B00GHJ08XC",
    }), res);

    assert.equal(res.statusCode, 400);
    assert.deepEqual(JSON.parse(res.body), { error: "invalid_album_url" });
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(fetched, false);
});

test("rejects redirects and oversized album pages", async () => {
    const query = {
        album: "JFK (2013)",
        url: "https://streamingsoundtracks.com/modules.php?name=Album&asin=B00GHJ08XC",
    };
    for (const response of [
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }),
        new Response("x", { headers: { "content-type": "text/html",
            "content-length": String(256 * 1024 + 1) } }),
    ]) {
        const handler = createCreditHandler({
            env: { ALBUM_CREDIT_ALLOWED_HOSTS: "streamingsoundtracks.com" },
            fetchImpl: async () => response,
        });
        const res = mockResponse();
        await handler(mockRequest(query), res);
        assert.notEqual(res.statusCode, 200);
        assert.equal(res.headers.get("cache-control"), "no-store");
    }
});
