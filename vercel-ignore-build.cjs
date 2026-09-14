"use strict";

const { spawnSync } = require("node:child_process");

// Vercel uses 0 to cancel the build, and 1 to continue. Compare with the last
// successful deployment, so a push containing several commits is handled too.
// Missing history (including shallow clones) must allow the build to proceed.
function ignoreBuild({ previousSha = process.env.VERCEL_GIT_PREVIOUS_SHA,
    cwd = __dirname, run = spawnSync } = {}) {
    if (!/^[a-f0-9]{40,64}$/i.test(previousSha || "")) return false;
    const result = run("git", ["diff", "--quiet", previousSha, "HEAD", "--",
        "api/", "package.json", "package-lock.json", "vercel.json",
        ".vercelignore", "vercel-ignore-build.cjs",
        ":(glob,exclude)api/**/*.test.js"], { cwd, stdio: "ignore" });
    return !result.error && result.status === 0;
}

if (require.main === module) {
    const skip = ignoreBuild();
    console.log(skip ? "Skipping unchanged API deployment." : "Building API deployment.");
    process.exitCode = skip ? 0 : 1;
}

module.exports = { ignoreBuild };
