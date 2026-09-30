// Rebuild the native rating-logo bundle from the API's authoritative Wikimedia
// sources. Rasterisation is local and deterministic; no user/player data and no
// generated PNG is uploaded to an external optimiser.
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const sharp = require("sharp");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "shared", "rating_assets");
const refreshTv = process.argv.includes("--refresh-tv");
const entries = [
  ["DE", "FSK", "0", "https://upload.wikimedia.org/wikipedia/commons/1/17/FSK_0.svg"],
  ["DE", "FSK", "6", "https://upload.wikimedia.org/wikipedia/commons/b/b0/FSK_ab_6_logo.svg"],
  ["DE", "FSK", "12", "https://upload.wikimedia.org/wikipedia/commons/6/6e/FSK_12.svg"],
  ["DE", "FSK", "16", "https://upload.wikimedia.org/wikipedia/commons/3/30/FSK_16.svg"],
  ["DE", "FSK", "18", "https://upload.wikimedia.org/wikipedia/commons/5/5d/FSK_18.svg"],
  ["US", "MPA", "G", "https://upload.wikimedia.org/wikipedia/commons/4/4f/MPA_G_RATING.svg"],
  ["US", "MPA", "PG", "https://upload.wikimedia.org/wikipedia/commons/9/9a/MPA_PG_RATING.svg"],
  ["US", "MPA", "PG-13", "https://upload.wikimedia.org/wikipedia/commons/9/98/MPA_PG-13_RATING.svg"],
  ["US", "MPA", "R", "https://upload.wikimedia.org/wikipedia/commons/6/6b/MPA_R_RATING.svg"],
  ["US", "MPA", "NC-17", "https://upload.wikimedia.org/wikipedia/commons/c/c0/MPA_NC-17_RATING.svg"],
  ["US", "TV Parental Guidelines", "TV-Y", "https://upload.wikimedia.org/wikipedia/commons/2/25/TV-Y_icon.svg"],
  ["US", "TV Parental Guidelines", "TV-Y7", "https://upload.wikimedia.org/wikipedia/commons/5/5a/TV-Y7_icon.svg"],
  ["US", "TV Parental Guidelines", "TV-Y7-FV", "https://upload.wikimedia.org/wikipedia/commons/a/ac/TV-Y7-FV_icon.svg"],
  ["US", "TV Parental Guidelines", "TV-G", "https://upload.wikimedia.org/wikipedia/commons/5/5e/TV-G_icon.svg"],
  ["US", "TV Parental Guidelines", "TV-PG", "https://upload.wikimedia.org/wikipedia/commons/9/9a/TV-PG_icon.svg"],
  ["US", "TV Parental Guidelines", "TV-14", "https://upload.wikimedia.org/wikipedia/commons/c/c3/TV-14_icon.svg"],
  ["US", "TV Parental Guidelines", "TV-MA", "https://upload.wikimedia.org/wikipedia/commons/3/34/TV-MA_icon.svg"],
];

function stem(country, system, rating) {
  return [country, system, rating].join("_").toLowerCase().replace(/[^a-z0-9]+/g, "_");
}


function wikimediaPngThumbnail(svgUrl) {
  const url = new URL(svgUrl);
  const name = path.posix.basename(url.pathname);
  url.pathname = url.pathname.replace("/commons/", "/commons/thumb/")
    + `/250px-${name}.png`;
  return url.href;
}

async function download(url) {
  for (let attempt = 0; attempt < 6; ++attempt) {
    const response = await fetch(url, { headers: { "User-Agent": "24sevenfm-covers-asset-builder/1.0 (local deterministic build)" } });
    if (response.ok) return Buffer.from(await response.arrayBuffer());
    if (response.status !== 429 && response.status < 500)
      throw new Error(`${response.status} ${url}`);
    const retryAfter = Number(response.headers.get("retry-after"));
    await new Promise(resolve => setTimeout(resolve,
      Number.isFinite(retryAfter) ? retryAfter * 1000 : 1500 * (attempt + 1)));
  }
  throw new Error(`rate limited while downloading ${url}`);
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const publicDir = path.join(root, "public", "ratings", "v1");
  await fs.mkdir(publicDir, { recursive: true });
  const table = [];
  const manifest = [];
  for (const [country, system, rating, url] of entries) {
    const name = stem(country, system, rating);
    const target = path.join(output, name + ".png");
    let png;
    try {
      if (refreshTv && system === "TV Parental Guidelines") throw new Error("refresh requested");
      png = await fs.readFile(target);
    }
    catch {
      if (system === "TV Parental Guidelines") {
        // Use Wikimedia's own rasterisation of the exact SVG shown by the Web
        // player. Local SVG rasterisers can clip these marks differently.
        png = await download(wikimediaPngThumbnail(url));
      } else {
        const svg = await download(url);
        png = await sharp(svg, { density: 288 })
          .resize({ width: 512, height: 256, fit: "inside", withoutEnlargement: false })
          .png({ compressionLevel: 9, palette: true, quality: 92, effort: 10 })
          .toBuffer();
      }
      await fs.writeFile(target, png);
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    const hash = createHash("sha256").update(png).digest("hex").slice(0, 12);
    const filename = `${name}.${hash}.png`;
    const assetPath = `/ratings/v1/${filename}`;
    // Keep previously published hashes: older native binaries still request them.
    await fs.writeFile(path.join(publicDir, filename), png);
    manifest.push({ country, system, rating, path: assetPath });
    table.push(`        { "${country}", "${system}", "${rating}", "${assetPath}" }`);
  }
  const generated = `// Generated by tools/generate-rating-assets.js. Do not edit.
#pragma once
#include <string>
namespace ssc {
inline std::string ratingAssetPath(const std::string& country, const std::string& system,
                                   const std::string& rating) {
    static const struct { const char *country, *system, *rating, *path; } assets[] = {
${table.join(",\n")}
    };
    for (const auto& asset : assets)
        if (country == asset.country && system == asset.system && rating == asset.rating) return asset.path;
    return {};
}
} // namespace ssc
`;
  await fs.writeFile(path.join(root, "lib", "rating_asset_paths.h"), generated);
  await fs.writeFile(path.join(root, "public", "ratings", "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
})().catch(error => { console.error(error); process.exitCode = 1; });
