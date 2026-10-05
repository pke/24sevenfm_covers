# Shared native media preparation

Status: implemented incremental migration, 2026-10-04.

## Findings before this change

Both clients already used `CoverMonitor`, `TrackInfo`, `MediaResolver`,
`MediaRequest` and `MediaResult`. Feed parsing, provider-result validation and
trusted CDN selection were already common. Matching and HTML/article normalization
remain in the project's API, with validation and raw-metadata fallback in the
portable resolver.

The remaining duplication was above the renderer:

- Windows `CoverEngine` contained the resolver worker, retries, media cache,
  credit enrichment, logo/backdrop downloading and validation. Its worker created
  Direct2D rating types, coupling acquisition to Windows.
- macOS used `PresentationPipeline` but independently implemented asset downloading,
  credit enrichment and ratings filtering. AppKit assembled requests, feed queue
  transports, track identities and canonical/raw text selection.
- Windows publishes metadata, ratings, logos and backdrops progressively, with
  retries and cached fallbacks. macOS publishes complete prepared presentations.
  Replacing either scheduler directly would change observable behavior.

## Boundary after this change

`Provider/Feed -> TrackInfo + MediaRequest/MediaResult -> portable preparation
-> PresentationController -> FrameState -> native drawing`

`shared/media_preparation.*` owns:

- `MediaPreferences` to `MediaRequest` projection: SST eligibility, backdrop/logo
  dependency, independent ratings, provider order/key and viewport caps.
- Requests bound to a track, live/queue identities, canonical/raw text projection
  and station-ident labels.
- Best-effort credits, trusted station-cover URL selection, validated backdrop,
  logo and rating bytes, and cancellation before publication.
- Provider/orientation/resolution compatibility for backdrop reuse, including the
  distinction between a logo response variant and an artwork selection.
- Cancellable station queue acquisition using the existing feed parser.

`PreparedRating` carries the original certification and optional validated image
bytes, without native types. Windows converts to UTF-16/native draw data at the
publication adapter. macOS decodes bytes into native images. The Windows text
fallback while a badge image loads is retained.

`shared/media_worker.*` owns the formerly Windows-only resolver work executor,
bounded media/logo caches, cache fallback selection, queue credit work, resolver,
image and rating retries, and backdrop-cycle downloads. Callbacks carry portable
data. It is built and tested on Windows and Apple Silicon. The worker mutex
protects jobs/cache; publication callbacks run outside that mutex. Adapters retain
the final epoch/selection check under their publication lock.

`PresentationPipeline` and the Windows worker both use `MediaPreparation` for
acquisition policy and asset validation. `PresentationController` remains the
presentation authority described in ADR 0009. No network work moves to a UI thread.

## Deliberately retained differences and remaining work

This is not a claim that the whole application now has one session state machine.

- Two portable delivery schedulers remain: progressive publications with retries,
  versus complete-frame transactions. Only Windows currently consumes
  `MediaWorkerState` in production; both platforms test it.
- Windows `CoverEngine` still coordinates feed callbacks, current/queued-cover
  promotion and retries, queue retention across idents and per-orientation manual
  backdrop selection with UI mailboxes. These are remaining session policies
  above the rendering boundary, not inherently Windows behavior. A later common
  session controller should retain these regressions before macOS adopts them.
- macOS still coordinates its independent rating-overlay cache and serial
  artwork/main queues. Queue transport construction and text selection moved out
  of AppKit.
- Windows retains the settings schema's `DE,US` fallback when both country flags
  are false; macOS retains empty selection as disabled ratings. Neither store is
  rewritten. Cover timeouts remain explicit inputs: 20 seconds for the Windows
  flow and 12 seconds for complete-frame preparation.
- HTTP/TLS, bounded native image probing/decoding, bitmap tint/blur processing,
  GPU resources, text measurement, DPI/backing scale, windows/input and settings
  persistence remain native. Windows rating PNG disk I/O remains behind
  `RatingAssetCache`; its finite in-memory certification cache is portable.
- The web player remains JavaScript; the provider service remains server-side.

## Verification and installation

Seven new cross-platform tests cover station/options projection, queue identity
under enrichment, canonical text authority, cover trust/image validation,
cancellation during download and credit enrichment, certification preservation,
cache compatibility, and the production portable worker with fixture transport.
The worker test checks normalized metadata and prepared pixels, then verifies
that a repeat request reuses cache without additional HTTP traffic.

- Windows Debug: 226/226 CTest cases passed, including native engine, renderer,
  settings, fullscreen, queued artwork and stale-publication regressions.
- Apple Silicon Release: 132/132 CTest cases passed. Live TLS/feed/image,
  cancellation and API-normalization smoke test passed.
- Desktop/Winamp build graphs and the foobar project source list include the new
  shared sources. No settings schema, provider order or user defaults changed.
- macOS installation verifies ad-hoc signing and matching executable SHA-256;
  the installer now also exports existing preferences after graceful quit.
- macOS automated UI checks passed for live cover, layouts/settings, window
  levels, countdown/odometer pixels, Coming Next slide/text fitting, idle controls,
  resize, station logos and silent provider changes/reordering.
- Windows Release viewer and Winamp plugin built, UPX verification passed, and
  both installed file hashes match their build outputs. The running viewer was
  restarted and its executable path/responding state verified. Winamp was not
  running. No manual Windows visual inspection was performed in this change.
- Windows settings SHA-256 remained unchanged across replacement. macOS
  preferences compared equal to the exported backup after restart and isolated UI
  checks. Existing installations and settings have recoverable backups.

Local evidence is retained under
`.codex/native-backups/data-layer-20261004-050211/`. The pre-existing uncommitted
source state is archived there as `source-before.tar.gz`; it was not reset or
committed as part of this migration.
