# ADR 0001: Server-side backdrop resolver with shared keys and precomputed tint

Date: 2026-08-13
Status: Accepted (implementation deferred)

## Context

The web player's experimental movie-backdrop feature (TMDB search -> fanart.tv art
preferred -> TMDB art fallback) currently runs entirely in the browser and is
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
  client-side tinting IS possible for movie art; server-side tint remains the
  better place mainly because the color arrives with the URL (before the image
  loads) and is computed once per movie instead of on every client.

Terms-of-service review (2026-08-13) confirmed that one application key serving an
app's users is the intended model for both services:

- **TMDB**: application keys, free for non-commercial use with attribution
  (already on the page), rate limit ~40 req/s **per IP**, caching allowed up to
  6 months. Forbidden: selling/sublicensing API *access* - i.e. an open proxy for
  third parties, not an app backend serving its own feature.
- **fanart.tv**: the mandatory **project key** is exactly this - the developer's
  key for the app. The optional per-user **personal key** (`client_key`) only
  buys fresher images (2-day instead of 7-day delay; VIP: immediate).

## Decision

Build one small serverless endpoint (Vercel function) that resolves an album
title to backdrop art and a UI tint, using project-owned keys server-side:

```
GET /api/backdrop?title=<cleaned album title>[&client_key=<fanart personal key>]
-> { movie: { id, title }, backdrop: "https://...", source: "fanart" | "tmdb",
     tint: [r, g, b] }
   Cache-Control: s-maxage=15552000        (6 months - TMDB's caching ceiling)
```

Key points:

- **Keys live only on the server.** BYOK fields in the player become an optional
  override (and the fanart personal key passes through as `client_key`).
- **The server also computes the tint** by porting `overlayTintFrom` from
  `shared/d2d_renderer.cpp` (average to 1x1, normalize by max channel, blend
  k=0.35 toward white) - one algorithm, identical colors across apps and web.
  Server-side computation makes the entire CORS problem irrelevant: the client
  never needs pixel access, it just applies the color it is handed - and it has
  the color *before* the image even loads (tint arrives with the URL).
- **Tint is computed from tiny variants**, not the full image: TMDB `w92`
  instead of `w1280`, fanart `/preview/` instead of `/fanart/` - a few KB per
  *new* movie, once per cache lifetime.
- **Images keep flowing directly from the CDNs to the client** (`image.tmdb.org`,
  `assets.fanart.tv`). The endpoint returns URLs + tint only.
- **Edge caching per title** (`s-maxage`) means the station's finite soundtrack
  catalog converges to ~100% cache hits; TMDB/fanart see one lookup per movie
  per 6 months.
- **Scope-locked, not an open proxy**: only the two operations the player needs
  (title search -> art resolution), CORS restricted to the site origin. This is
  what keeps it an app backend under TMDB's terms rather than sublicensed API
  access.

## Consequences

- The privacy policy's "nothing runs through this site" no longer holds for this
  feature: album titles (and user IPs, toward Vercel) flow through the endpoint.
  The policy must disclose this before the endpoint ships; the feature stays
  opt-in.
- fanart.tv works either way: their CORS bug (since fixed upstream) never matters
  to a server, and the fix does not change this design - the endpoint's value is
  the shared keys, the one-lookup-per-movie caching, and the precomputed tint.
- UI tinting becomes available for every matched movie regardless of which
  provider's art is shown.
- Station covers (ASIN art) remain untintable: the stations' WAF blocks
  non-browser clients from datacenter IPs, and Vercel egress is a datacenter IP.
  Whether image URLs are gated more leniently than the JSON endpoints must be
  tested from a real Vercel function before promising anything.
- Vercel free tier suffices: KB-sized responses, tint thumbnails only on cache
  misses, no image bandwidth.

## Alternatives considered

- **Status quo (BYOK, client-only).** Maximum privacy, near-zero adoption, no
  fanart (their CORS bug), tint only for TMDB art. Kept as the fallback path -
  the client chain stays functional if the endpoint is down.
- **Proxying the images themselves** (single download from source, client fetches
  from us, canvas readable). Rejected: full image bandwidth of all users through
  the function (free tier: 100 GB/month, backdrops ~0.5 MB), worse latency than
  the CDN edge, and it makes the project an image host - operationally and
  ToS-wise a different animal.
