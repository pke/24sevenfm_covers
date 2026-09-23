"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { createHandler, createTintHandler } = require("./_lib/backdrop");

async function call(handler, query) {
    const response = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
        end(body) { this.body = JSON.parse(body); } };
    await handler({ method: "GET", headers: {}, query }, response);
    return response;
}

test("diagnostics measures the actual tint preview without extra image downloads", async () => {
    const bytes = await sharp({ create: { width: 92, height: 52, channels: 3,
        background: "#947a62" } }).png().toBuffer();
    let imageCalls = 0;
    const handler = createHandler({ env: { TMDB_READ_TOKEN: "secret-token" }, fetchImpl: async url => {
        if (String(url).includes("search/multi")) return Response.json({ results: [
            { id: 1, title: "Film", media_type: "movie", backdrop_path: "/preview.jpg" },
        ] });
        if (String(url).includes("image.tmdb.org")) {
            imageCalls++;
            return new Response(bytes, { headers: { "Content-Type": "image/png" } });
        }
        throw Error("Unexpected URL: " + url);
    } });
    const query = { album: "Film", providers: "tmdb", diagnostics: "1" };
    const first = await call(handler, query);
    assert.equal(first.statusCode, 200);
    const d = first.body.diagnostics;
    assert.equal(d.cache.metadata.status, "miss");
    assert.ok(d.totalMs >= 0);
    const image = d.resolution.images[0];
    assert.match(image.url, /\/w92\//);
    assert.equal(image.bytes, bytes.length);
    assert.equal(image.width, 92);
    assert.equal(image.height, 52);
    assert.equal(image.format, "png");
    assert.equal(image.status, "ok");
    assert.ok(image.downloadMs >= image.headersMs);
    assert.ok(image.analysisMs >= 0);
    assert.ok(image.totalMs >= image.downloadMs);
    assert.ok(d.resolution.spans.some(span => span.name === "provider.tmdb" && span.status === 200));
    assert.equal(d.resolution.selections.find(item => item.scope === "display-artwork").url, first.body.backdrop);
    assert.doesNotMatch(JSON.stringify(d), /secret-token/);
    const cached = await call(handler, query);
    assert.equal(cached.body.diagnostics.cache.metadata.status, "hit");
    assert.deepEqual(cached.body.diagnostics.resolution, d.resolution,
        "cached timings retain the original measurement timestamp");
    assert.equal(imageCalls, 1);
    assert.equal((await call(handler, { ...query, diagnostics: "0" })).body.diagnostics, undefined);
    assert.equal(imageCalls, 1, "diagnostics is a projection of the shared result");
});

test("cover tint diagnostics includes image dimensions, failures and strict opt-in validation", async () => {
    const bytes = await sharp({ create: { width: 40, height: 24, channels: 3,
        background: "red" } }).jpeg().toBuffer();
    let fail = false;
    const handler = createTintHandler({ fetchImpl: async () => new Response(fail ? "invalid" : bytes,
        { headers: { "Content-Type": "image/jpeg" } }) });
    const query = { url: "https://streamingsoundtracks.com/images/cover/040/test.jpg", diagnostics: "1" };
    const result = await call(handler, query);
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.diagnostics.images[0].width, 40);
    assert.equal(result.body.diagnostics.images[0].height, 24);
    fail = true;
    const failed = await call(handler, query);
    assert.equal(failed.statusCode, 422);
    assert.equal(failed.body.diagnostics.images[0].status, "error");
    assert.equal(failed.body.diagnostics.images[0].width, null);
    for (const diagnostics of ["", "true", "2"]) {
        assert.equal((await call(handler, { ...query, diagnostics })).statusCode, 400);
        assert.equal((await call(createHandler(), { album: "Film", art: "0", diagnostics })).statusCode, 400);
    }
});

test("concurrent cache waiters have their own request timing and share only creation measurements", async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const handler = createHandler({ env: { TMDB_READ_TOKEN: "private" }, fetchImpl: async () => {
        await gate;
        return Response.json({ results: [] });
    } });
    const query = { album: "Film", providers: "tmdb", diagnostics: "1" };
    const first = call(handler, query);
    const second = call(handler, query);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.body.diagnostics.cache.metadata.status, "miss");
    assert.equal(b.body.diagnostics.cache.metadata.status, "coalesced");
    assert.notEqual(a.body.diagnostics.requestId, b.body.diagnostics.requestId);
    assert.deepEqual(a.body.diagnostics.resolution, b.body.diagnostics.resolution);
});

test("failed provider work retains its measured phases without caching the failure", async () => {
    let calls = 0;
    const handler = createHandler({ env: { TMDB_READ_TOKEN: "private" }, fetchImpl: async () => {
        calls++;
        return new Response("invalid JSON", { status: 200 });
    } });
    const query = { album: "Film", providers: "tmdb", diagnostics: "1" };
    const first = await call(handler, query);
    assert.equal(first.statusCode, 502);
    assert.equal(first.body.diagnostics.resolution.spans[0].status, "invalid_json");
    assert.ok(first.body.diagnostics.resolution.spans[0].totalMs >= 0);
    const second = await call(handler, query);
    assert.equal(second.body.diagnostics.cache.metadata.status, "miss");
    assert.ok(calls >= 2);
});
