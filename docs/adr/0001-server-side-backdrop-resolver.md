# ADR 0001: Server-side artwork resolver with shared keys and precomputed tint

Date: 2026-08-13
Status: Accepted

## Context

The web player's experimental movie/TV-backdrop feature (TMDB search -> fanart.tv
art preferred -> TMDB art fallback) currently runs entirely in the browser and is
bring-your-own-key: every user must create a TMDB credential (and optionally a
fanart.tv key). That was a deliberate privacy choice - nothing runs through this
project's infrastructure - but it has real costs:

- **Key friction.** Almost no listener will create API keys; the feature is
  effectively invisible.
- **fanart.tv was unusable from browsers.** `webservice.fanart.tv` answered with a
  duplicated `Access-Control-Allow-Origin` header (`*, *`), which the CORS spec
  forbids - every browser rejected every response. `assets.fanart.tv` (the image
  CDN) sent no ACAO header at all, so its images could be displayed but never
  read into a canvas.
  *Update, same day: fixed upstream on BOTH hosts within hours of the Discord
  report (verified 2026-08-13: API fetch resolves, image canvas-readback works).
  The client-side chain therefore works fully again; this motivation is
  historical.*
- **UI tinting was impossible client-side for most art.** Station cover images
  carry no CORS headers (canvas tainting) - that part stands. With fanart.tv's
  fix, both `image.tmdb.org` and `assets.fanart.tv` are now canvas-readable, so
  client-side tinting IS possible for screen art; server-side tint remains the
  better place mainly because the color arrives with the URL (before the image
  loads) and is computed once per matched work instead of on every client.

Terms-of-service review (2026-08-13) confirmed that one application key serving an
app's users is the intended model for both services:

- **TMDB**: application keys, free for non-commercial use with attribution
  (already on the page), rate limit ~40 req/s **per IP**, caching allowed up to
  6 months. Forbidden: selling/sublicensing API *access* - i.e. an open proxy for
  third parties, not an app backend serving its own feature.
- **fanart.tv**: the mandatory **project key** is exactly this - the developer's
  key for the app. The optional per-user **personal key** (`client_key`) only
  buys fresher images (2-day instead of 7-day delay; VIP: immediate).

On 2026-08-20 the same feature was extended to game soundtracks. SteamGridDB exposes
a self-service API key, exact game-title search, and landscape “hero” artwork, so it
fits the existing URL-plus-tint resolver without adding an image proxy or client key.

## Decision

Build two small serverless endpoints (Vercel functions). The first resolves a
normalized soundtrack title to backdrop art and a UI tint, using project-owned keys server-side:

```
GET /api/media?album=<raw album>&track=<raw track>[&client_key=<fanart personal key>]
-> { media: { id, title, type: "movie" | "tv" | "game" }, backdrop: "https://...",
     source: "fanart" | "tmdb" | "steamgriddb",
     tint: [r, g, b], metadata: { album, track, artist } }
   Cache-Control: s-maxage=15552000        (artwork hit)
   Cache-Control: s-maxage=900             (no-backdrop result)
```

The legacy `title` and optional `media_hint` parameters remain accepted for direct
callers; the player uses `album` and `track` so normalization stays server-side.
`metadata` is returned independently of a media match. It HTML5-decodes Album, Track
and Artist exactly once and applies the trailing `, The/A/An` display transformation
to Album. An `art=0` request without rating countries exits before provider matching,
which lets every client obtain canonical display fields without contacting TMDB,
fanart.tv, TVmaze or SteamGridDB.

The second computes the same tint from a canonical station cover, so the normal
player can remain cover-colored even when screen backdrops are disabled:

```
GET /api/tint?url=https%3A%2F%2Fstreamingsoundtracks.com%2Fimages%2Fcover%2F....jpg
-> { tint: [r, g, b] }
   Cache-Control: s-maxage=15552000
```

Key points:

- **Application keys live only on the server.** This includes TMDB, fanart.tv and
  SteamGridDB. The optional fanart personal key
  passes through as `client_key`; the browser has no direct metadata-provider
  fallback.
- **Classification is evidence-based and conservative.** The station feed has no
  media-type field. Explicit soundtrack wording supplies a game, movie or TV hint;
  TMDB distinguishes movie from TV in its result; SteamGridDB is accepted only on
  an exact normalized title match. For otherwise ambiguous exact titles, provider
  order is the user-controlled tie-breaker and the server supports explicit
  `BACKDROP_MEDIA_OVERRIDES` corrections.
- **The server also computes the tint** by porting `overlayTintFrom` from
  `shared/d2d_renderer.cpp` (average to 1x1, normalize by max channel, blend
  k=0.35 toward white) - one algorithm, identical colors across apps and web.
  Server-side computation makes the entire CORS problem irrelevant: the client
  never needs pixel access, it just applies the color it is handed - and it has
  the color *before* the image even loads (tint arrives with the URL).
- **Tint prefers tiny variants**: TMDB `w92`
  instead of `w1280`, fanart `/preview/` instead of `/fanart/`, and SteamGridDB's
  returned hero thumbnail instead of its full hero - a few KB per *new* work, once
  per cache lifetime. Providers without a thumbnail may require the original;
  the same bounded download/decode policy applies in either case.
- **Images keep flowing directly from the CDNs to the client** (`image.tmdb.org`,
  `assets.fanart.tv`, `cdn2.steamgriddb.com`). The endpoint returns URLs + tint only.
- **Edge caching per title** (`s-maxage`) means the station's finite soundtrack
  catalog converges to ~100% cache hits. Artwork hits live for six months; a result
  without a backdrop lives for only 15 minutes so provider additions and resolver
  fixes are discovered quickly.
- **The web cache key follows the resolver source automatically.** The site renderer
  fingerprints `api/_lib/backdrop.js` and writes the first 12 SHA-256 hex characters
  as `resolver_version` in the endpoint URL. Resolver changes also trigger the site
  workflow, so changing matching logic cannot depend on somebody remembering to bump
  a manual version number.
- **Scope-locked, not an open proxy**: only the operations the player needs are
  exposed. `/api/tint` accepts HTTPS/443 URLs only on five exact station hosts,
  only for the feed's `/images/cover/<file>` and `/images/cover/040/<file>`
  thumbnails, without credentials, query or fragment. It
  validates every redirect, MIME type, an 8 MiB transfer cap, a 4096 × 2160 pixel
  decode cap and a 3 second download deadline. The transfer cap is enforced while
  streaming, even without a truthful Content-Length; incomplete images are never
  decoded for tint. CORS is restricted to the site origin. This is
  what keeps it an app backend under TMDB's terms rather than sublicensed API
  access.
- **Abuse controls are layered.** Artwork hits are edge-cached for six months and
  misses for 15 minutes; invalid inputs fail before any upstream fetch. Vercel's platform DDoS
  mitigation remains the outer layer, and a WAF rate-limit rule covers `/api/*`.
  CORS is not treated as authentication or rate limiting.

### Resolution-aware fanart.tv artwork (2026-09-10)

Artwork requests may include `width` and `height`, the current rendering surface's
dimensions in physical pixels. Both must be integers from 1 through 8192; omitting
both selects HD landscape artwork. The server alone derives the artwork format:
`height > width` selects portrait; wide and square surfaces select landscape. There
is no separate poster/orientation or DPI parameter; obsolete `orientation` query
values are ignored and cannot override the dimensions.

A width above 1920 or a height above 1080
prefers fanart.tv's `movie4kbackground` / `show4kbackground` collection, preserving
the existing textless/likes ranking and falling back to the ordinary background
collection when 4K is absent. This does not change provider ordering. Portrait mode
still prefers actual posters, including a later provider's poster, before using a
landscape background as fallback.

The provider's [official API implementation](https://github.com/fanart-tv/fanart.tv-api)
defines those separate 3840 × 2160 collections; the existing v3 endpoint already
returns them. No separate endpoint, application key or client-side provider request
is required. Tint continues to use the selected image's small `/preview/` variant,
not its full 4K download. The 8 MiB and 8,847,360-pixel decode bounds also accommodate
complete UHD and DCI 4K sources when no thumbnail is available.

Web uses stage CSS dimensions multiplied by devicePixelRatio; native clients use
the render HWND's client pixels without applying DPI a second time. Clients observe
orientation and the HD/4K threshold on resize/fullscreen/DPI changes. Their current
and queue caches separate these variants but do not split entries for every pixel
of window size. Actual dimensions still travel in the request, so edge cache URLs
can differ across sizes. Metadata-only requests omit the dimensions, and accepted
canonical metadata remains independent of artwork resolution (ADR 0008).

## Consequences

- The web player's user IP and each new cover-thumbnail URL flow through Vercel
  for tint resolution. Album titles additionally flow through the resolver only
  for every track so the resolver can return canonical display metadata. Artwork and
  rating provider calls remain conditional on the off-by-default options. The privacy
  policy discloses both paths.
- fanart.tv works either way: their CORS bug (since fixed upstream) never matters
  to a server, and the fix does not change this design - the endpoint's value is
  the shared keys, the one-lookup-per-movie caching, and the precomputed tint.
- UI tinting becomes available for every matched movie, TV series or game regardless of which
  provider's art is shown.
- Station covers are tintable through the constrained endpoint in local
  end-to-end tests. A Vercel Preview must still confirm that station image hosts
  accept Vercel egress before Production is enabled.
- The endpoint returns only RGB JSON; cover and backdrop images still load
  directly in the browser. The function downloads one bounded source image only
  on an edge-cache miss.
- The feed's 40 px `ThumbnailLink` is preferred for tinting, with the 200 px
  `CoverLink` as a compatibility fallback; the 500 px display variant remains
  browser-only. A live 37-cover sample across all five stations cut tint-source
  transfer by 95.4% (750,873 bytes to 34,264 bytes), with an average
  post-normalization channel drift of 0.96 on the 0–255 RGB scale.

## Implementation

Implemented on 2026-08-20:

- `api/media.js` and `api/tint.js` expose the Vercel Functions; provider
  resolution, strict URL validation, bounded image decoding, caching and tint
  calculation live in `api/_lib/backdrop.js`.
- The web player calls only this resolver for provider metadata. It validates the
  returned CDN URL and tint before displaying them and degrades to the normal
  blurred cover if the endpoint is unavailable.
- The web and native players render the resolver's separate normalized Album, Track
  and Artist values. Title article rotation is not duplicated in client code.
- Project credentials come from Vercel environment variables; only an optional
  fanart.tv personal key can originate in the browser.
- The normal cover tint is the player's base color. A loaded media backdrop's
  tint temporarily overrides it; failures restore the cover tint.
- Unit and browser tests cover movie/TV/game matching, provider fallback, caching, origin
  restrictions, title normalization, race cancellation, malicious URLs, redirect escape,
  transfer limits and tint priority.

Deployment configuration and required variables are documented in
`docs/vercel-backdrop.md`.

## Alternatives considered

- **Status quo (BYOK, client-only).** Maximum privacy, near-zero adoption, and
  duplicated provider logic in every browser. Rejected; an endpoint outage now
  degrades to the ordinary blurred station cover.
- **Proxying the images themselves** (single download from source, client fetches
  from us, canvas readable). Rejected: full image bandwidth of all users through
  the function (free tier: 100 GB/month, backdrops ~0.5 MB), worse latency than
  the CDN edge, and it makes the project an image host - operationally and
  ToS-wise a different animal.
