"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { create, sanitize } = require("../site/js/player-debug");

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
