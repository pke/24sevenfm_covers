# Third-party notices

## Artwork metadata and images

The optional StreamingSoundtracks media feature uses the TMDB API but is not
endorsed or certified by TMDB. Depending on the user-selected provider order, the
project resolver can also select artwork from [fanart.tv](https://fanart.tv/),
[TVmaze](https://www.tvmaze.com/) and
[SteamGridDB](https://www.steamgriddb.com/). Project application credentials stay on
the project resolver. An optional listener-owned fanart.tv personal client key remains
in that client's local settings, is forwarded by the resolver only for enabled
fanart.tv artwork, and is sent directly to fanart.tv only when the listener explicitly
presses Check. Native applications fetch a selected image directly from that provider's
validated CDN host.

## Age-rating logos

Native applications fetch locally rasterised PNG versions of the known rating
marks from the project API deployment so Windows does not need to decode remote SVG. The authoritative
source URLs are kept in `tools/generate-rating-assets.js`; the generated assets live
under `shared/rating_assets/` and are published with content-hashed filenames under
`public/ratings/v1/`. Native clients retain a local disk cache.

- FSK 0/6/12/16/18 source files: Wikimedia Commons. Consult each linked file page
  from the generator for its attribution and licence terms.
- MPA G/PG/PG-13/R/NC-17 source files: Wikimedia Commons. Consult each linked file
  page from the generator for its attribution and licence terms.
- TV Parental Guidelines marks are simple local high-resolution renderings of the
  accepted TV-Y, TV-Y7, TV-Y7-FV, TV-G, TV-PG, TV-14 and TV-MA labels. The matching
  Wikimedia Commons files referenced by the web resolver identify the marks as
  public-domain works.

The asset generator performs palette PNG compression locally with `sharp`; it does
not upload generated assets or application/user data to TinyPNG/TinyJPG or another
image-optimisation service.

## HTML character references

The project media endpoint uses Mathias Bynens' MIT-licensed `he` package to decode
the complete HTML character-reference set into Unicode metadata before returning it
to the players. The package is used server-side only.

## Native executable compression

The Windows viewer and plugins are compressed with unmodified
[UPX 5.2.1](https://github.com/upx/upx/releases/tag/v5.2.1). UPX is licensed under
GPL-2.0-or-later with its special exception for compressed executables. The
original decompression stub is retained. See the upstream
[license and exception](https://github.com/upx/upx/blob/v5.2.1/LICENSE).
