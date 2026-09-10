"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMetadataCache } = require("./_lib/metadata_cache");

test("metadata cache coalesces concurrent work, expires hits and short-lived misses", async () => {
    let time = 0, calls = 0, release;
    const cache = createMetadataCache({ now: () => time });
    const ttl = result => result.media ? 100 : 1;
    const resolve = () => { calls++; return new Promise(done => { release = done; }); };
    const first = cache("movie", resolve, ttl), second = cache("movie", resolve, ttl);
    await Promise.resolve();
    assert.equal(calls, 1);
    release({ media: "movie", logo: { url: "art.png" } });
    assert.deepEqual(await first, await second);
    time = 99999;
    await cache("movie", () => assert.fail("unexpired hit"), ttl);
    time++;
    assert.deepEqual(await cache("movie", () => ({ media: null }), ttl), { media: null });
    time += 999;
    await cache("movie", () => assert.fail("unexpired miss"), ttl);
    time++;
    assert.deepEqual(await cache("movie", () => ({ media: "new" }), ttl), { media: "new" });
});

test("metadata cache retries failures, bounds LRU entries and honors explicit reload", async () => {
    const cache = createMetadataCache({ limit: 2 });
    const ttl = () => 60;
    await assert.rejects(cache("a", () => { throw Error("offline"); }, ttl), /offline/);
    await cache("a", () => "a", ttl);
    await cache("b", () => "b", ttl);
    assert.equal(await cache("a", () => assert.fail("hit"), ttl), "a");
    await cache("c", () => "c", ttl);
    assert.equal(await cache("a", () => assert.fail("recent entry retained"), ttl), "a");
    assert.equal(await cache("b", () => "new b", ttl), "new b");
    assert.equal(await cache("b", () => "reloaded b", ttl, true), "reloaded b");
});

test("an obsolete failed request cannot erase a newer reloaded entry", async () => {
    const cache = createMetadataCache();
    const ttl = () => 60;
    let reject;
    const old = cache("a", () => new Promise((_, fail) => { reject = fail; }), ttl);
    await Promise.resolve();
    assert.equal(await cache("a", () => "fresh", ttl, true), "fresh");
    reject(Error("old failure"));
    await assert.rejects(old, /old failure/);
    assert.equal(await cache("a", () => assert.fail("fresh entry retained"), ttl), "fresh");
});
