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
GET /api/backdrop?album=<raw album>&track=<raw track>[&client_key=<fanart personal key>]
-> { media: { id, title, type: "movie" | "tv" | "game" }, backdrop: "https://...",
     source: "fanart" | "tmdb" | "steamgriddb",
     tint: [r, g, b] }
   Cache-Control: s-maxage=15552000        (artwork hit)
   Cache-Control: s-maxage=900             (no-backdrop result)
```

The legacy `title` and optional `media_hint` parameters remain accepted for direct
callers; the player uses `album` and `track` so normalization stays server-side.

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
- **Tint is computed from tiny variants**, not the full image: TMDB `w92`
  instead of `w1280`, fanart `/preview/` instead of `/fanart/`, and SteamGridDB's
  returned hero thumbnail instead of its full hero - a few KB per *new* work, once
  per cache lifetime.
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
  only for the feed's `/images/cover/<file>` thumbnails, without credentials,
  query or fragment. It
  validates every redirect, MIME type, a 2 MB transfer cap, a 4 MP decode cap and
  a 4 second deadline. CORS is restricted to the site origin. This is
  what keeps it an app backend under TMDB's terms rather than sublicensed API
  access.
- **Abuse controls are layered.** Artwork hits are edge-cached for six months and
  misses for 15 minutes; invalid inputs fail before any upstream fetch. Vercel's platform DDoS
  mitigation remains the outer layer, and a WAF rate-limit rule covers `/api/*`.
  CORS is not treated as authentication or rate limiting.

## Consequences

- The web player's user IP and each new canonical cover URL flow through Vercel
  for tint resolution. Album titles additionally flow through the resolver only
  when the off-by-default movie/TV/game-backdrop option is enabled. The privacy policy
  discloses both paths.
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
- The feed's original 200 px CoverLink is used for tinting; the 500 px display
  variant remains browser-only. This cuts tint-source transfer by roughly 72%
  for a representative live cover (10.9 KB instead of 39 KB).

## Implementation

Implemented on 2026-08-20:

- `api/backdrop.js` and `api/tint.js` expose the Vercel Functions; provider
  resolution, strict URL validation, bounded image decoding, caching and tint
  calculation live in `api/_lib/backdrop.js`.
- The web player calls only this resolver for provider metadata. It validates the
  returned CDN URL and tint before displaying them and degrades to the normal
  blurred cover if the endpoint is unavailable.
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
