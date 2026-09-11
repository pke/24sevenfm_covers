# Native rating logo assets

The FSK and MPA PNG files are locally rasterised from the exact Wikimedia Commons
SVG URLs whitelisted by the Web player and returned by `api/_lib/backdrop.js`. TV
Parental Guidelines use Wikimedia's own PNG thumbnails of those SVGs so a local SVG
rasteriser cannot clip them differently from the browser. Run
`node tools/generate-rating-assets.js --refresh-tv` to refresh the TV PNGs and rebuild
the compiled `rating_assets.generated.inc` bundle.

The native players never download or parse remote SVG. Source pages and individual
licence/attribution information are available through the corresponding Wikimedia
Commons URLs recorded in the generator and `THIRD_PARTY_NOTICES.md`.
