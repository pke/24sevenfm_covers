"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHandler } = require("./_lib/backdrop");

const poster = "https://assets.fanart.tv/fanart/inception-poster.jpg";
async function resolve(clientKey, statuses, repeat = false, debugLogging = false) {
    const fanartRequests = [];
    const handler = createHandler({
        env: { TMDB_READ_TOKEN: "server-tmdb", FANART_API_KEY: "server-fanart",
            BACKDROP_DEBUG_LOG: debugLogging ? "1" : "0" },
        fetchImpl: async raw => {
            const url = new URL(raw);
            if (url.hostname === "webservice.fanart.tv") {
                fanartRequests.push(new URL(url));
                const status = statuses[fanartRequests.length - 1] || 200;
                return new Response(JSON.stringify({ movieposter: [{ url: poster, lang: "00" }] }), { status });
            }
            assert.equal(url.hostname, "api.themoviedb.org");
            assert.equal(url.pathname, "/3/search/multi");
            return new Response(JSON.stringify({ results: [{ id: 27205,
                media_type: "movie", title: "Inception", poster_path: "/tmdb-poster.jpg" }] }));
        },
        tintForImage: async () => [10, 20, 30],
    });
    const res = { setHeader() {}, end(value) { this.body = JSON.parse(value); } };
    const req = { method: "GET", headers: {}, query: {
        album: "Inception", providers: "fanart,tmdb", media_hint: "movie",
        width: "720", height: "1080", client_key: clientKey, diagnostics: "1",
    } };
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    const body = res.body;
    let cachedBody;
    if (repeat) {
        await handler(req, res);
        cachedBody = res.body;
    }
    return { body, fanartRequests, cachedBody };
}

for (const rejection of [401, 403]) {
    test(`rejected personal fanart key (${rejection}) preserves artwork provider priority`, async () => {
        const withoutKey = await resolve("", [200]);
        const { body, fanartRequests, cachedBody } = await resolve("rejected-personal-key", [rejection, 200], true);
        assert.equal(body.source, "fanart");
        assert.equal(body.backdrop, withoutKey.body.backdrop);
        assert.equal(body.backdrop, poster);
        assert.equal(fanartRequests.length, 2);
        assert.equal(fanartRequests[0].searchParams.get("client_key"), "rejected-personal-key");
        assert.equal(fanartRequests[1].searchParams.has("client_key"), false);
        assert.equal(fanartRequests[1].searchParams.get("api_key"), "server-fanart");
        assert.equal(JSON.stringify(body.diagnostics).includes("rejected-personal-key"), false);
        const failed = body.diagnostics.resolution.spans.find(span => span.name === "provider.fanart" && span.status === rejection);
        assert.equal(failed.hint, `fanart.tv rejected the personal key (HTTP ${rejection}). Retrying without it; check or clear the key in provider settings.`);
        assert.deepEqual(cachedBody.diagnostics.resolution, body.diagnostics.resolution);
        assert.equal(cachedBody.diagnostics.cache.metadata.status, "hit");
    });
}

test("accepted personal fanart key requires only one provider request", async () => {
    const { body, fanartRequests } = await resolve("accepted-personal-key", [200]);
    assert.equal(body.source, "fanart");
    assert.equal(fanartRequests.length, 1);
    assert.equal(fanartRequests[0].searchParams.get("client_key"), "accepted-personal-key");
    assert.equal(body.diagnostics.resolution.spans.some(span => span.hint), false);
});

test("enabled debug logs print the fanart authentication hint without credentials", async context => {
    context.mock.method(console, "log", () => {});
    const warnings = context.mock.method(console, "warn", () => {});
    await resolve("rejected-personal-key", [401, 200], false, true);
    const logged = warnings.mock.calls.map(call => call.arguments.join(" ")).join("\n");
    assert.match(logged, /HTTP 401/);
    assert.match(logged, /check or clear the key in provider settings/);
    assert.doesNotMatch(logged, /rejected-personal-key|server-fanart|server-tmdb/);
});

test("failed server authentication still falls back after the bounded key retry", async () => {
    const { body, fanartRequests } = await resolve("rejected-personal-key", [401, 401]);
    assert.equal(body.source, "tmdb");
    assert.equal(fanartRequests.length, 2);
    const failures = body.diagnostics.resolution.spans.filter(span => span.name === "provider.fanart");
    assert.match(failures[1].hint, /Check the server API key/);
    assert.equal(JSON.stringify(body.diagnostics).includes("server-fanart"), false);
});

test("server-only authentication failures and upstream outages do not retry", async () => {
    for (const [key, status] of [["", 401], ["", 403], ["personal-key", 429], ["personal-key", 500]]) {
        const { body, fanartRequests } = await resolve(key, [status]);
        assert.equal(body.source, "tmdb");
        assert.equal(fanartRequests.length, 1);
        const failed = body.diagnostics.resolution.spans.find(span => span.name === "provider.fanart");
        if (status === 401 || status === 403) assert.match(failed.hint, /Check the server API key/);
        else assert.equal(failed.hint, undefined);
    }
});
