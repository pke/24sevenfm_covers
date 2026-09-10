# ADR 0009: Optional title logos across web and native clients

Date: 2026-09-10
Status: Accepted

## Context

Soundtrack artwork providers can supply transparent film or series title logos as
well as backdrops. A logo can replace the album heading, but transparent padding and
restrictive height limits make stacked or wide artwork appear too small. Keeping a
hidden long album name in intrinsic layout also leaves an unnecessarily wide panel.

The web player, Windows viewer, Winamp and foobar2000 must share this behavior.
Native code remains in the shared resolver, engine, settings schema and Direct2D
renderer established by ADR 0002. Metadata handoffs follow ADR 0008.

## Decision

- Add a persisted, default-off title-logo option within SST backdrop settings:
  `sstTitleLogos` in the web player and `titleLogos` in the native shared schema.
  Turning backdrops off retains the preference while disabling its presentation.
- An album-heading or logo click toggles the same option and persists it. The web
  uses a keyboard-operable button with `aria-pressed`. Native hit testing includes
  the logo's protruding artwork, and host glue only forwards the click and persists.
  Native settings remain the keyboard-accessible alternative.
- The local web diagnostic action from ADR 0007 moves to the track heading.
  Album/logo activation never queues a Codex report.
- Keep canonical album, track and artist separately. A logo replaces only the album
  heading; track title, duration, artist, countdown and square cover export remain.
  Missing, rejected, unreadable or completely transparent logos retain album text.
- Accept only the resolver's optional `{ url, source }` logo object and validate it
  with the same source/HTTPS-host policy as backdrop artwork, including before native
  downloads. Provider credentials and matching stay on the server.
- Reuse fanart.tv and TVmaze logos returned with their artwork payloads. When a logo
  is requested and those payloads contain none, query TMDB's image endpoint for the
  already matched movie/TV ID or SteamGridDB's logo endpoint for the already matched
  game ID. SteamGridDB is never searched for a movie or series logo because its
  catalog cannot establish that screen identity safely.
- Trim transparent padding using an alpha threshold of 16 and a maximum 1600-pixel
  working dimension. Preserve aspect ratio. Permit generous height for every logo
  shape, bounded by stage width/height and scaled for native window DPI.
- Anchor artwork above a compact reserved row, allowing it to protrude beyond the
  top of the panel. Its full image height does not increase panel height. While a
  logo is visible, panel width is determined by the remaining visible text rather
  than the hidden album heading.
- Fade album text and logos, retain outgoing pixels until the exit completes, and
  interpolate panel dimensions. Rapid toggles continue from the current visible
  state. Respect browser reduced motion and Windows client-animation preferences.
- Queue preparation includes logo images in the existing bounded, minute-staggered
  scheduler. The next queued item is urgent. No URL means no image request; failures
  must not erase valid metadata, backdrop or rating state. Current and queued logo
  downloads reuse prepared images, and late work cannot update a newer track.

## Consequences

The API returns available logo URLs only with `logos=1` and artwork enabled.
Absent or `logos=0` omits the field. HTTP and client response caches distinguish
these variants; toggling refreshes current and queued response preparation. Image
preparation follows validated URLs in the API response. No URL means no download.
Prepared image bytes are bounded to 64 entries and reused after toggling back on.
Failed image loads are not successful image-cache entries.

Before projecting those response variants, the server keeps a common cache of
resolved provider metadata, artwork, ratings, tint and logos already present in
artwork payloads. Its key
excludes the logo option and per-track display metadata, but includes effective
matching inputs, provider order, credentials, media hints, rating countries and
artwork orientation/resolution class. Each response receives its own normalized
track metadata and optional-field projection without mutating the common result.
Thus toggling may require a new API response but reuses provider work.

Logo-only TMDB and SteamGridDB endpoint results use a separate cache with the same
identity, credential, reload and hit/miss lifetime rules. They are queried only for
`logos=1`, so a client with title logos disabled does not create otherwise unused
provider traffic. Queue preparation normally warms this cache before display.

Each server cache is bounded to 256 LRU entries per warm handler instance, with
the existing hit/miss TTLs. Concurrent lookups share a promise, failures are not
cached, and explicit `Cache-Control: no-cache`/`no-store`/`max-age=0` reloads replace
the entry. Credentials appear only inside hashed keys. This is an in-memory cache:
cold starts and different server instances have independent caches. Existing CDN
response caching remains in place; no persistent shared store is introduced.

The feature is opt-in and independent of exported square album art. A long album
name remains available in metadata and the web button tooltip even when replaced.
Movie and TV logos can come from fanart.tv, TMDB or TVmaze. Game logos can come from
SteamGridDB. Each logo lookup reuses an already accepted media ID; it never performs
a second cross-media title match.

The shared Windows implementation avoids separate provider, trimming, animation
or sizing rules in the viewer and plugins. Future native clients should implement
this same presentation and cache contract.

## Verification

API and native resolver tests cover optional logo validation and trusted downloads.
Server tests cover shared response projection, separate opt-in logo endpoint caches,
concurrent work, expiry, reload, LRU eviction, failures and isolation of the
request's display metadata.
Browser tests cover default-off persistence, album/keyboard activation, queue image
preparation, missing-image fallback, compact panel geometry and the separate local
diagnostic action. Native tests cover retained fades, reduced motion, aspect bounds,
settings controls, cache scheduling and stale publication. Release builds compile
the shared path into the viewer, Winamp and foobar2000.
