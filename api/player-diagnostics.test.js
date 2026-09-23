"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { create, sanitize } = require("../site/js/player-debug");
const { createTimeline } = require("../site/js/player-debug");
const { selectedDetails } = require("../site/js/player-debug");

test("selected diagnostics contain only the selected track, its assets and matching requests/events", () => {
    const item = { id: "queued", phase: "future", album: "Film & score", track: "Later cue",
        artist: "Composer", coverUrl: "https://images.test/later.jpg", relativeSeconds: 42,
        cache: { variants: 1 }, artwork: { variants: [{ url: "https://images.test/later-art.jpg" }] } };
    const matching = "https://api.test/api/media?album=Film+%26+score&track=Later+cue";
    const other = "https://api.test/api/media?album=Film+%26+score&track=Playing+cue";
    const snapshot = { capturedAt: "now", station: "sst", track: { album: item.album, track: "Playing cue" },
        artwork: { shownCover: "playing.jpg", images: [{ url: item.coverUrl, width: 400 }, { url: "playing.jpg" }] },
        localCache: { mediaEntries: 99 }, display: { remainingSeconds: 999 }, settings: { playing: true },
        requests: [{ url: matching, response: { diagnostics: { totalMs: 12 } } }, { url: other },
            { url: "https://api.test/api/tint?url=" + encodeURIComponent(item.coverUrl) },
            { url: "https://station.test/?action=GetQueue", response: [{ Album: item.album, Track: item.track }] },
            { url: "https://station.test/?action=GetCurrentlyPlaying", response: { Album: item.album, Track: "Playing cue" } }],
        events: [{ name: "cache.media", album: item.album, track: item.track },
            { name: "request.complete", url: matching }, { name: "request.complete", url: other },
            { name: "image.loaded", url: "https://images.test/later-art.jpg", width: 1920 },
            { name: "cache.media", album: item.album, track: "Playing cue" }] };
    for (const phase of ["future", "past"]) {
        const details = selectedDetails(snapshot, { ...item, phase });
        assert.equal(details.track.track, item.track);
        assert.equal(details.playback.phase, phase);
        assert.equal(details.playback.relativeSeconds, 42);
        assert.equal(details.localCache.variants, 1);
        assert.equal(details.requests.length, 2);
        assert.equal(details.events.length, 3);
        assert.deepEqual(details.artwork.images, [{ url: item.coverUrl, width: 400 }]);
        assert.doesNotMatch(JSON.stringify(details), /Playing cue|playing.jpg|mediaEntries|999/);
    }
    const unavailable = selectedDetails(snapshot, { id: "missing", phase: "past", album: "Gone", track: "Unknown" });
    assert.equal(unavailable.requests.length, 0);
    assert.equal(unavailable.events.length, 0);
    assert.equal(unavailable.localCache.status, "Not available for this track");
    assert.doesNotMatch(JSON.stringify(unavailable), /Playing cue|playing.jpg/);
});

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
