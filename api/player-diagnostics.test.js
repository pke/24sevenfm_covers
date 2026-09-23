"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { create, sanitize } = require("../site/js/player-debug");
const { createTimeline } = require("../site/js/player-debug");

test("timeline retains observed history, one current item and distinct queued repeats with live cache state", () => {
    let now = 100000;
    const timeline = createTimeline({ now: () => now, limit: 2 });
    const a = { album: "A", track: "Cue", occurrence: "first" };
    const b = { album: "B", track: "Cue", lengthSeconds: 80 };
    timeline.observe("sst", a);
    now += 20000;
    timeline.observe("sst", { ...a, artist: "Corrected credit" });
    assert.equal(timeline.entries([], 30).length, 1, "credit refinements are not a new play");
    timeline.observe("sst", b);
    let entries = timeline.entries([a, a], 30, item => ({ metadata: item.album === "A" }));
    assert.deepEqual(entries.map(item => item.phase), ["past", "current", "future", "future"]);
    assert.equal(new Set(entries.map(item => item.id)).size, 4);
    assert.equal(entries[0].artist, "Corrected credit");
    assert.equal(entries[0].cache.metadata, true);
    assert.equal(entries[0].relativeSeconds, -20);
    assert.equal(entries[2].relativeSeconds, 30);
    assert.equal(entries[3].relativeSeconds, null, "missing duration cannot invent an ETA");
    assert.equal(timeline.entries([], 30, () => ({ metadata: false }))[0].cache.metadata, false,
        "cache eviction is visible on a historical card");
    timeline.observe("sst", a); timeline.observe("sst", b);
    assert.equal(timeline.entries([], 30).filter(item => item.phase === "past").length, 2);
    timeline.observe("death", a);
    assert.equal(timeline.entries([], 30).length, 1, "station timelines do not leak into each other");
    timeline.observe("other", null);
    assert.equal(timeline.entries([], 30).length, 0, "changing station clears the old current before the new feed arrives");
});

test("web debug snapshots redact nested credentials and retain only bounded request history", async t => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async () => Response.json({ album: "Film", api_key: "server-secret",
        nested: { url: "https://example.test/?client_key=personal-secret&album=Film" } });
    const debug = create();
    for (let i = 0; i < 40; i++) {
        const response = await debug.fetch("https://example.test/api/media?client_key=personal-secret");
        assert.equal((await response.json()).api_key, "server-secret", "diagnostics must not mutate caller data");
    }
    const snapshot = debug.snapshot({ settings: { fanartKey: "personal-secret" } });
    assert.equal(snapshot.requests.length, 30);
    assert.equal(snapshot.events.length, 30);
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /personal-secret|server-secret/);
    assert.ok(snapshot.requests.every(r => r.headersMs >= 0 && r.downloadMs >= r.headersMs));
    assert.equal(snapshot.requests[0].response.album, "Film");
});

test("web diagnostic redaction removes URL userinfo and captures failed requests without raw error bodies", async t => {
    assert.doesNotMatch(sanitize("https://name:secret@example.test/?token=private"), /name|secret|private/);
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async () => new Response("private-unstructured-error", { status: 502 });
    const debug = create();
    const result = await debug.fetch("https://example.test/api/media");
    assert.equal(result.status, 502);
    assert.doesNotMatch(JSON.stringify(debug.snapshot({})), /private-unstructured-error/);
});
