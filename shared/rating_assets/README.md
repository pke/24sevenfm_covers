# Native rating logo assets

The FSK and MPA PNG files are locally rasterised from the exact Wikimedia Commons
SVG URLs whitelisted by the Web player and returned by `api/_lib/backdrop.js`. TV
Parental Guidelines use Wikimedia's own PNG thumbnails of those SVGs so a local SVG
rasteriser cannot clip them differently from the browser. Run
`node tools/generate-rating-assets.js --refresh-tv` to refresh the TV PNGs and rebuild
the versioned files in `public/ratings/v1/` and the native path table in
`lib/rating_asset_paths.h`. Filenames include a SHA-256 content hash. Keep older
hashed files when refreshing: released native clients still request those URLs.

Vercel serves these PNGs alongside the API with one-year immutable cache headers
for clients and the edge. The native media worker downloads only known badge
paths, validates PNG dimensions and decoding, and caches bytes in memory and under
`%LOCALAPPDATA%\24seven.fm\Covers\ratings-v1`. The renderer uses text until an image
is ready, then crossfades through the existing rating transition. Failed downloads
retain text and use bounded background retries. Deploy the static files before
distributing native builds that reference them.

The native players never download or parse remote SVG. Source pages and individual
licence/attribution information are available through the corresponding Wikimedia
Commons URLs recorded in the generator and `THIRD_PARTY_NOTICES.md`.
