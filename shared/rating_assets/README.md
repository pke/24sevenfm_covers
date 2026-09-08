# Native rating logo assets

The FSK/MPA PNG files are locally rasterised from the Wikimedia Commons SVG URLs
used by `api/_lib/backdrop.js`; the simple TV labels have a deterministic local SVG
fallback so a throttled asset host cannot make the native build incomplete. Run
`node tools/generate-rating-assets.js` to rebuild both these reviewable PNGs and the
compiled `rating_assets.generated.inc` bundle.

The native players never download or parse remote SVG. Source pages and individual
licence/attribution information are available through the corresponding Wikimedia
Commons URLs recorded in the generator and `THIRD_PARTY_NOTICES.md`.
