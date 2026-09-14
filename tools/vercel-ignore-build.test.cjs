"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");
const { ignoreBuild } = require("../vercel-ignore-build.cjs");

test("compares deployed runtime across multi-commit pushes and skips unrelated changes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "vercel-ignore-"));
    const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const commit = () => { git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "test: fixture"); return git("rev-parse", "HEAD"); };
    try {
        git("init", "-q");
        mkdirSync(join(cwd, "api", "_lib"), { recursive: true });
        mkdirSync(join(cwd, "site"));
        writeFileSync(join(cwd, "api", "media.js"), "original");
        const deployed = commit();
        writeFileSync(join(cwd, "site", "index.html"), "site only");
        commit();
        assert.equal(ignoreBuild({ cwd, previousSha: deployed }), true);
        writeFileSync(join(cwd, "api", "media.test.js"), "test only");
        commit();
        assert.equal(ignoreBuild({ cwd, previousSha: deployed }), true);
        writeFileSync(join(cwd, "api", "_lib", "resolver.js"), "runtime change");
        commit();
        writeFileSync(join(cwd, "site", "index.html"), "another site change");
        commit();
        assert.equal(ignoreBuild({ cwd, previousSha: deployed }), false);
        const newDeployment = git("rev-parse", "HEAD");
        writeFileSync(join(cwd, "vercel.json"), "{}");
        commit();
        assert.equal(ignoreBuild({ cwd, previousSha: newDeployment }), false);
        assert.equal(ignoreBuild({ cwd, previousSha: "0".repeat(40) }), false);
        assert.equal(ignoreBuild({ cwd, previousSha: "" }), false);
    } finally {
        assert.ok(cwd.startsWith(join(tmpdir(), "vercel-ignore-")));
        rmSync(cwd, { recursive: true, force: true });
    }
});
