const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

test("native and rendered-web requests share the resolver cache version", () => {
    const root = path.resolve(__dirname, "..");
    const source = fs.readFileSync(path.join(__dirname, "_lib", "backdrop.js"));
    const expected = crypto.createHash("sha256").update(source).digest("hex").slice(0, 12);
    const header = fs.readFileSync(path.join(root, "lib", "media_resolver.h"), "utf8");
    const match = header.match(/resolverVersion\s*=\s*"([a-f0-9]{12})"/);
    assert.ok(match, "native resolverVersion must remain an explicit 12-hex cache key");
    assert.equal(match[1], expected,
        "update native resolverVersion when api/_lib/backdrop.js changes");
});
