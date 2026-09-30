"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createLocalApiServer } = require("../installer/local_api_server");
const root = path.join(__dirname, "..");
const manifest = require("../public/ratings/manifest.json");

test("all rating PNGs have immutable content-hashed URLs matching native paths", async () => {
    assert.equal(manifest.length, 17);
    const native = await fs.readFile(path.join(root, "lib/rating_asset_paths.h"), "utf8");
    for (const entry of manifest) {
        assert.match(entry.path, /^\/ratings\/v1\/[a-z0-9_-]+\.[a-f0-9]{12}\.png$/);
        const png = await fs.readFile(path.join(root, "public", entry.path));
        const hash = createHash("sha256").update(png).digest("hex").slice(0, 12);
        assert.ok(entry.path.endsWith(`.${hash}.png`));
        assert.ok(native.includes(`"${entry.path}"`));
        const stem = [entry.country, entry.system, entry.rating].join("_").toLowerCase().replace(/[^a-z0-9]+/g, "_");
        assert.deepEqual(png, await fs.readFile(path.join(root, "shared/rating_assets", stem + ".png")));
    }
});

test("rating images are served as PNGs with year-long immutable caching", async () => {
    const server = createLocalApiServer({ routes: {} });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
        const origin = `http://127.0.0.1:${server.address().port}`;
        const response = await fetch(origin + manifest[0].path);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "image/png");
        assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
        const expected = await fs.readFile(path.join(root, "public", manifest[0].path));
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
        const head = await fetch(origin + manifest[0].path, { method: "HEAD" });
        assert.equal(head.status, 200); assert.equal(await head.text(), "");
        assert.equal(Number(head.headers.get("content-length")), expected.length);
        const missing = await fetch(origin + "/ratings/v1/unknown.000000000000.png");
        assert.equal(missing.status, 404); assert.equal(missing.headers.get("cache-control"), "no-store");
        assert.equal((await fetch(origin + manifest[0].path, { method: "POST" })).status, 405);
        assert.equal((await fetch(origin + "/ratings/v1/%2e%2e%2fpackage.json")).status, 404);
    } finally { await new Promise(resolve => server.close(resolve)); }
});

test("Vercel deploys changed assets and gives them a year at the edge and client", () => {
    const config = require("../vercel.json");
    assert.equal(config.outputDirectory, "public");
    const headers = config.headers.find(row => row.source === "/ratings/v1/:asset").headers;
    for (const key of ["Cache-Control", "Vercel-CDN-Cache-Control"])
        assert.equal(headers.find(header => header.key === key).value, "public, max-age=31536000, immutable");
    const { ignoreBuild } = require("../vercel-ignore-build.cjs");
    assert.equal(ignoreBuild({ previousSha: "a".repeat(40), run: (_cmd, args) => {
        assert.ok(args.includes("public/")); return { status: 1 };
    } }), false);
});
