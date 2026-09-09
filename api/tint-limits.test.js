"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHandler, createTintHandler } = require("./_lib/backdrop");
const LIMIT = 8 * 1024 * 1024;
function reply() {
    return { setHeader() {}, end(body) { this.body = JSON.parse(body); } };
}
function request(query) { return { method: "GET", headers: {}, query }; }
const cover = "https://streamingsoundtracks.com/images/cover/review.png";

test("tint accepts a complete image at the 8 MiB byte boundary", async () => {
    let decodedBytes = 0;
    const handler = createTintHandler({
        fetchImpl: async () => new Response(new Uint8Array(LIMIT), { headers: { "content-type": "image/png" } }),
        tintFromBytes: async bytes => { decodedBytes = bytes.length; return [10, 20, 30]; },
    });
    const res = reply(); await handler(request({ url: cover }), res);
    assert.equal(res.statusCode, 200); assert.equal(decodedBytes, LIMIT);
});

for (const endpoint of ["cover", "media"]) {
    test(`${endpoint} tint cancels a declared oversized body without reading it`, async () => {
        let cancelled = false;
        const image = () => new Response(new ReadableStream({
            cancel() { cancelled = true; },
        }), { headers: { "content-type": "image/png", "content-length": String(LIMIT + 1) } });
        const options = {
            env: { TMDB_READ_TOKEN: "test-token" },
            fetchImpl: async url => String(url).includes("search/multi")
                ? new Response(JSON.stringify({ results: [{ id: 7, title: "Arrival",
                    media_type: "movie", backdrop_path: "/arrival.png" }] })) : image(),
        };
        const res = reply();
        await (endpoint === "cover" ? createTintHandler(options) : createHandler(options))(
            request(endpoint === "cover" ? { url: cover } : { album: "Arrival", providers: "tmdb" }), res);
        assert.equal(cancelled, true);
        assert.equal(res.statusCode, endpoint === "cover" ? 413 : 200);
        if (endpoint === "media") assert.deepEqual(res.body.tint, [255, 255, 255]);
    });
    for (const contentLength of [undefined, "1"]) {
        test(`${endpoint} tint stops oversized streams with length=${contentLength}`, async () => {
            let cancelled = false, produced = 0, decoded = false;
            const image = () => new Response(new ReadableStream({
                pull(controller) {
                    if (produced >= LIMIT * 2) return controller.close();
                    const bytes = new Uint8Array(256 * 1024);
                    produced += bytes.length; controller.enqueue(bytes);
                },
                cancel() { cancelled = true; },
            }), { headers: { "content-type": "image/png",
                ...(contentLength === undefined ? {} : { "content-length": contentLength }) } });
            const options = {
                env: { TMDB_READ_TOKEN: "test-token" },
                fetchImpl: async url => String(url).includes("search/multi")
                    ? new Response(JSON.stringify({ results: [{ id: 7, title: "Arrival",
                        media_type: "movie", backdrop_path: "/arrival.png" }] })) : image(),
                tintFromBytes: async () => { decoded = true; return [1, 2, 3]; },
            };
            const res = reply();
            await (endpoint === "cover" ? createTintHandler(options) : createHandler(options))(
                request(endpoint === "cover" ? { url: cover } : { album: "Arrival", providers: "tmdb" }), res);
            assert.equal(cancelled, true);
            assert.ok(produced <= LIMIT + 512 * 1024, `stream produced ${produced} bytes`);
            assert.equal(decoded, false);
            assert.equal(res.statusCode, endpoint === "cover" ? 413 : 200);
            if (endpoint === "media") assert.deepEqual(res.body.tint, [255, 255, 255]);
        });
    }
}

test("real sharp tint decoding accepts UHD, DCI 4K and rotated 4K", async () => {
    const sharp = require("sharp");
    for (const [width, height] of [[3840, 2160], [4096, 2160], [2160, 4096]]) {
        const bytes = await sharp({ create: { width, height, channels: 3,
            background: { r: 40, g: 80, b: 120 } } }).png().toBuffer();
        const handler = createTintHandler({ fetchImpl: async () =>
            new Response(bytes, { headers: { "content-type": "image/png" } }) });
        const res = reply(); await handler(request({ url: cover }), res);
        assert.equal(res.statusCode, 200, `${width}x${height}`);
        assert.equal(res.body.tint.length, 3);
        assert.notDeepEqual(res.body.tint, [255, 255, 255]);
    }
});

test("media tint decodes a complete 4K source but falls back above the pixel limit", async () => {
    const sharp = require("sharp");
    for (const height of [2160, 2161]) {
        const bytes = await sharp({ create: { width: 4096, height, channels: 3,
            background: { r: 40, g: 80, b: 120 } } }).png().toBuffer();
        const handler = createHandler({
            env: { TMDB_READ_TOKEN: "test-token" },
            fetchImpl: async url => String(url).includes("search/multi")
                ? new Response(JSON.stringify({ results: [{ id: 7, title: "Arrival",
                    media_type: "movie", backdrop_path: "/arrival.png" }] }))
                : new Response(bytes, { headers: { "content-type": "image/png" } }),
        });
        const res = reply(); await handler(request({ album: "Arrival", providers: "tmdb" }), res);
        assert.equal(res.statusCode, 200);
        assert.ok(res.body.backdrop);
        if (height === 2160) assert.notDeepEqual(res.body.tint, [255, 255, 255]);
        else assert.deepEqual(res.body.tint, [255, 255, 255]);
    }
});

test("real sharp tint decoding still rejects images above the 4K pixel ceiling", async () => {
    const sharp = require("sharp");
    const bytes = await sharp({ create: { width: 4096, height: 2161, channels: 3,
        background: { r: 40, g: 80, b: 120 } } }).png().toBuffer();
    const handler = createTintHandler({ fetchImpl: async () =>
        new Response(bytes, { headers: { "content-type": "image/png" } }) });
    const res = reply(); await handler(request({ url: cover }), res);
    assert.equal(res.statusCode, 422);
});
