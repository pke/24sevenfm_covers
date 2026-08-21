# ADR 0002: Shared native integration for movie, TV and game backdrop art

Date: 2026-08-20
Status: Proposed

## Context

ADR 0001 introduced the server-side backdrop resolver used by the web player:

```
GET /api/backdrop?album=<raw album>&track=<raw track>
```

The resolver owns soundtrack-title cleanup, compilation exceptions, movie/TV/game
classification and provider selection. Clients should not reproduce that logic.

The same feature may later be added to the Winamp plugin, foobar2000 component and
standalone Windows viewer. Before doing so, we need to establish which metadata the
native clients actually receive and choose an integration boundary that avoids three
host-specific implementations.

## Existing native metadata paths

All three native clients compile and use the same `CoverMonitor`, `CoverEngine`, HTTP
client and Direct2D renderer. The station's now-playing JSON is the authoritative
source of album and track metadata in every client.

| Client | Host/ICY metadata use | Authoritative album and track source |
| --- | --- | --- |
| Winamp | Polls `IPC_GETPLAYLISTTITLE`, an ICY-derived playlist title, to detect a real track change. The playlist URL identifies the tuned station. | `FM24sevenJSON.php?action=GetCurrentlyPlaying` through `CoverMonitor`. |
| foobar2000 | Handles `on_playback_dynamic_info_track`, reads only the dynamic `TITLE` value and uses it as a track-change signal. The stream URL identifies the station. | The same `GetCurrentlyPlaying` JSON through `CoverMonitor`; foobar's `ALBUM` metadata is not used. |
| Desktop viewer | Has no host player and receives no ICY metadata. It runs the monitor with `autoAdvance=true` and follows the station's server clock. | The same `GetCurrentlyPlaying` JSON through `CoverMonitor`. |

`CoverMonitor::pollOnce` parses and HTML-decodes `Album`, `Track` and `Artist` into
`TrackInfo`. `CoverEngine` currently combines those fields only for display as
`Album - Track (M:SS)`. That formatted display string is not an appropriate resolver
input because its separators and appended duration are presentation details.

For the plugins, an ICY title change causes `CoverEngine::onTitleChanged` to swap the
preloaded cover and request a JSON refresh. ICY therefore controls playback timing,
but does not supply the album/track pair used for cover metadata or future backdrop
resolution. The viewer obtains both metadata and timing entirely from JSON.

## Decision

When native backdrop art is implemented, implement it once in the shared native
layer rather than in the Winamp, foobar2000 and desktop host adapters.

### Resolver input

- Pass `TrackInfo.album` and `TrackInfo.track` to `/api/backdrop` as the `album` and
  `track` query parameters.
- Pass the HTML-decoded UTF-8 strings without local title cleanup, splitting,
  rotation, soundtrack-suffix removal or media classification.
- Do not send Winamp's playlist title, foobar's dynamic `TITLE`, or the formatted
  `Album - Track (M:SS)` display string.
- A native wrapper may call its second argument `title` internally, but it must map
  it to the API's `track` parameter. The API's legacy `title` parameter means a
  directly supplied work title and must not be confused with an ICY track title.

This keeps every title exception, including multi-film compilation handling, in the
server resolver and makes future corrections immediately available to all clients.

### Shared ownership

A shared native resolver component should:

1. Percent-encode the UTF-8 `album` and `track` values and call the project HTTPS
   endpoint using the existing WinHTTP-based transport.
2. Parse the returned `backdrop`, `source`, `media` and optional `tint` fields.
3. Accept only HTTPS image URLs on the provider hosts approved by the web client:
   TMDB's image host, fanart.tv artwork hosts and SteamGridDB's static hero CDN.
4. Download and decode the selected image under the existing response-size and
   image-dimension limits.
5. Cache successful results and misses, while leaving endpoint failures retryable.
6. Use cancellation plus a per-track or per-station generation token so a late
   response can never install artwork for an old track or station.

Native requests do not send a browser `Origin` header, so the resolver's browser CORS
allowlist does not block them. No provider credential belongs in a native executable;
TMDB, fanart.tv and SteamGridDB keys remain server-side.

All three current native targets are Windows builds and can use the existing WinHTTP
TLS path. A future non-Windows consumer of `lib/` would first need a platform HTTPS
transport because the current non-Windows fallback is plain HTTP only.

### Engine and rendering state

Backdrop bytes and renderer state must remain separate from the normal station cover.
In particular, `CoverEngine::currentCover()` feeds foobar2000's native album-art
system and must continue to return the square station cover, not a landscape hero.

The backdrop request should run independently of the normal cover download and queue
preload. Adding a provider lookup synchronously to the existing cover callback would
delay following-cover prefetch and could make `stop()` or a station switch wait on an
unrelated provider request.

Visible backdrop replacement must use the existing double-buffered transition model:
keep outgoing art rendered until its exit fade completes, animate geometry changes,
and respect the Windows reduced-motion/animation preference. A miss or failure should
fade back to the existing cover-derived poster background without disrupting the
cover itself.

### Queue prefetch

The current native `nextCoverUrl` path reads only the next `CoverLink` and `Length`
from `GetQueue`. It does not expose the queued `Album` or `Track`. That is sufficient
for instant square-cover swaps but insufficient for pre-resolving the next backdrop.

Extend the shared queue result to carry the next track's album, track, artist, cover
and duration as one structure. The plugins can then associate the preloaded backdrop
with the same queued item whose cover they swap on the ICY title boundary; the viewer
can use the same data at the server-clock boundary. This extension belongs in
`CoverMonitor`, not in either plugin.

An initial implementation may resolve only the current JSON item and accept a later
backdrop arrival, but queue metadata is required for parity with the web player's
prefetch behavior and for seamless native transitions.

### Scope, settings and attribution

- Keep native backdrops experimental and off by default.
- Initially enable resolution only for the StreamingSoundtracks station, matching the
  web player. Other family stations are not soundtrack catalogs and should not send
  their titles to artwork providers.
- Put the option in `CoverEngine::Settings` and the shared options page. Winamp and the
  viewer will inherit INI persistence through the shared config schema; foobar2000
  requires one new GUID-backed `cfg_int` mapping.
- Add the same privacy disclosure used by the web player: when enabled, current and
  queued Album/Track values go to the project's resolver, while provider CDNs receive
  direct image requests from the client.
- Surface TMDB's required notice and provider links in an accessible native About or
  shared Options/Credits surface. Do not rely on documentation that is absent from the
  installed application.

## Consequences

- Winamp, foobar2000 and the viewer need no host-specific title parsing or media-type
  logic. Their existing host metadata remains a timing and station-detection concern.
- Fixes to soundtrack normalization remain centralized in the server and benefit all
  released clients without rebuilding them.
- Most implementation work is shared: API transport/parsing, cancellation, caching,
  queue metadata, backdrop renderer state and transitions.
- Per-host work is limited primarily to build-file inclusion, settings persistence
  where required, and an appropriate attribution surface.
- The safe initial cache key is the raw album/track pair. This preserves compilation
  correctness but can duplicate lookups for different cues from the same ordinary
  soundtrack. If that becomes material, the API can later return an explicit stable
  cache key or album-versus-track scope; clients must not infer that scope by copying
  the resolver's title rules.
- The feature continues to degrade cleanly: unavailable API, provider miss, rejected
  URL, failed image download or decode all leave the normal cover presentation intact.

## Alternatives considered

- **Use ICY metadata as resolver input.** Rejected. Winamp and foobar expose it in
  different host-specific forms, the viewer has no ICY source, and it may contain a
  composite display title rather than separate album and track values.
- **Send the formatted poster title.** Rejected. `Album - Track (M:SS)` is lossy and
  ambiguous to parse, and duration formatting is unrelated to media matching.
- **Implement one resolver client per host.** Rejected. All hosts already converge in
  `CoverEngine` with the same `TrackInfo`; separate implementations would duplicate
  networking, validation, caching and race handling.
- **Copy web normalization into C++.** Rejected. Rules would drift between JavaScript
  and native releases, and every correction would require rebuilding all clients.
- **Replace foobar's exported album art with the backdrop.** Rejected. A landscape
  movie/TV/game hero is a visual background, not the track's album cover.

## Implementation status

Assessment only. No native backdrop transport, settings, queue changes or renderer
changes have been implemented as part of this ADR.
