# ADR 0002: Shared native integration for backdrop art and age ratings

Date: 2026-09-08
Status: Accepted and implemented

## Context

ADR 0001 introduced the project-owned resolver used by the web player:

```text
GET /api/media?album=<raw album>&track=<raw track>&artist=<raw artist>
    &providers=<ordered providers>&ratings=DE,US&width=<physical pixels>&height=<physical pixels>
```

It owns soundtrack-title cleanup, compilation exceptions, movie/TV/game
classification, provider matching and credentials. Backdrops and certifications now
also need to work in the Winamp plugin, foobar2000 component and standalone Windows
viewer without three implementations or a second set of title rules.

## Native metadata contract

All native clients compile the same `CoverMonitor`, `CoverEngine`, HTTP client and
Direct2D renderer. The station JSON is authoritative in every client.

| Client | Host/ICY use | Authoritative media metadata |
| --- | --- | --- |
| Winamp | Playlist/ICY title detects a real playback boundary; stream URL detects station. | `GetCurrentlyPlaying` and `GetQueue` JSON. |
| foobar2000 | Dynamic `TITLE` detects a playback boundary; stream URL detects station. | The same station JSON; foobar `ALBUM` is not used. |
| Desktop viewer | No host/ICY input; follows the station clock. | The same station JSON. |

`TrackInfo` therefore carries the station's raw `Album`, `Track`, `Artist`, trusted
cover and thumbnail URLs, album page URL, duration and station-ident state. ICY
remains a timing signal only. The resolver receives those separate raw UTF-8 fields,
never the ICY string or the presentation string `Album - Track (M:SS)`.

`/api/media` returns the canonical fields independently as
`metadata: { album, track, artist }`. The server decodes the full HTML5 named and
numeric character-reference vocabulary exactly once for all three fields and moves a
trailing album article (`The`, `A`, `An`) to the front. Clients do neither transform;
they format only the returned values and duration. This keeps composer names correct
as well as titles and makes future normalization fixes available without a client
release.

ADR 0008 defines the shared visible-state handoff for these fields, including the
resolver-gated startup panel, raw fallback, queue-prefetch reuse and orientation
independence. It is normative for the web and Windows clients and for future React
Native clients.

## Decision

Implement resolver access, ratings, cache/queue policy and visual state once in the
shared native code.

### Trust and transport boundary

The shared resolver:

1. Percent-encodes raw Album/Track/Artist and calls the HTTPS project endpoint with
   a 20-second request timeout.
2. Strictly parses `metadata`, `media`, `backdrop`, `source`, `tint` and `certifications` and
   accepts only the known FSK, MPA and TV Parental Guidelines vocabulary.
   Text must be valid UTF-8; limits count UTF-16 code units like JavaScript, not
   UTF-8 bytes (Album/Artist 180, Track 300). Canonical metadata is accepted atomically
   only after all three fields pass validation, with explicit provenance retained
   separately from raw fallback values.
3. Accepts direct HTTPS images only from the web player's provider mapping:
   `image.tmdb.org`, fanart.tv artwork hosts, `static.tvmaze.com` and
   `cdn2.steamgriddb.com`.
4. Keeps the project TMDB, fanart.tv and SteamGridDB application credentials
   server-side. A listener may optionally persist a fanart.tv personal `client_key`
   locally. It is sent to the project resolver only when fanart.tv artwork is enabled;
   the explicit Check action sends it once directly to fanart.tv's stable movie probe,
   matching the web player. Keys are trimmed, limited to 128 control-free UTF-16 units and
   never included in diagnostics or share state. A native request sends no browser
   `Origin`, so browser CORS policy is not used as native auth.
5. Revalidates the provider URL before the CDN request and retains the existing WIC
   dimension/response limits before rendering.

Artwork and rating provider resolution is limited to StreamingSoundtracks and is off
by default. Every station uses a metadata-only request so its display strings follow
the same server contract. `art=0` with no rating countries returns before any
third-party provider call.

### Cache, cancellation and queue behavior

Cache identity contains raw album, track and artist plus ordered provider list,
enabled artwork/ratings features, rating countries and landscape/portrait
orientation and the HD/4K resolution class. While fanart.tv artwork is enabled it also contains the personal client
key, so changing that key cannot reuse results resolved with the previous identity.
Hits and authoritative misses are cached. Endpoint, transport, image
and decode failures are not.

Every station/track/configuration/orientation snapshot gets an epoch and cancellation
token. Late work may not install pixels or badges for an older epoch. Backdrop state
is independent of square-cover state. `CoverEngine::currentCover(bytes, stationIndex)`
returns a square cover for foobar2000 only when its station identity matches the
request; identity and bytes are checked under the same lock. Mixed-station selections
are rejected rather than borrowing the globally active station's cover.

Artwork requests include the rendering HWND's client width and height in physical
pixels (bounded to 8192), following ADR 0001. No explicit poster/orientation or DPI
parameter is sent: the API derives portrait from `height > width`. Local cache
keys use that same rule. The shared timer observes orientation
and HD/4K threshold changes, including fullscreen and monitor moves; sizes inside one
class reuse the same current and queue entries. Metadata-only requests omit the hint.

Window/fullscreen handoff selects the new viewport immediately. Ready current-item
cache hits and cached misses publish directly under the new epoch, without waiting
for the network worker or an unrelated queue request to finish. Portrait/landscape and HD/4K
variants remain separate entries and survive repeated handoffs. Missing logo image
bytes may still be prepared in the worker without delaying an already cached backdrop.
Only the active drawing window may consume publications or drive rendering/timers.
The handoff also paints the destination synchronously before fullscreen uncovers
the host window. An invalidation alone lets Windows briefly expose the host's old
retained portrait frame before the first fullscreen-to-portrait crossfade frame.

The shared Direct2D renderer retains decoded, premultiplied BGRA pixels across
target recreation and device loss. Its LRU holds at most 16 images and 128 MiB of
encoded keys plus decoded pixels; only rendered artwork enters it, not the entire
queue. Identity includes the exact encoded bytes and whether alpha padding was
trimmed, so square covers and cropped title logos cannot alias. Dimension checks
still precede pixel allocation. Invalid images are not cached, and shutdown frees
the cache. The metadata/viewport cache remains authoritative about which image is
eligible; a decoded cache hit never substitutes an unavailable orientation.

The current cover's 240-by-240 blurred background is retained separately as CPU
pixels. Window changes and releasing the offscreen blur device preserve it;
changed cover bytes or blur strength invalidate it. A new HWND still gets its own
GPU bitmaps because these belong to the render target's resource domain, but a
warm handoff only uploads retained pixels instead of repeating WIC decoding,
logo alpha scanning, cover tint extraction and Gaussian-blur readback. The first
destination frame and outgoing/incoming fade ordering remain unchanged.

A same-track viewport refinement keeps the displayed backdrop while the new variant
loads. A confirmed fresh/cached miss fades to the default cover presentation unless
prepared artwork for the same viewport is available. Portrait-only artwork must not
remain as a landscape fallback, nor vice versa; missing variants never borrow or
cache artwork from another orientation. Replacement fades start after the target
bitmap is ready; the outgoing layer stays opaque below the incoming layer throughout
an image-to-image crossfade, so the square cover cannot show through between them.

The public settings object belongs exclusively to the host UI thread. Startup,
`repaint()` and manual retry copy it into the worker's mutex-protected snapshot;
monitor callbacks never read mutable UI strings. Updating configuration, selecting
the current/queued tracks and scheduling replacement work are one transaction under
the worker mutex. A station switch first joins the old monitor, then installs the
new snapshot and generation before starting its replacement.

Generation advancement, result validation and publication use the same publication
mutex. The UI validates the pending generation again and retains that mutex through
the renderer's byte/ratings commit. Pending results from earlier generations are
discarded; already displayed content remains available for its outgoing transition.
Generations also advance at shutdown and are never reset when a worker restarts.
The only nested lock order is worker state followed by publication; publishers and
the renderer never acquire the worker mutex while holding the publication lock.

`GetQueue` exposes full TrackInfo records. The first queued item is eligible
immediately; further items are admitted one per minute. The cross-snapshot cache is
bounded to 64 configuration-aware entries. Sixty-four is a memory bound, not 64
immediate requests or an assumed station queue length: queues are normally much
shorter, while repeated snapshots can temporarily contain distinct tracks.

If a queue row has no Artist, `/api/credit` can enrich it only through the selected
station's validated album URL. A prefetched result is provisional: native clients
show it immediately on the matching boundary and revalidate with authoritative
current-playing Artist. A failed or empty refinement never erases valid prefetched
art or ratings.

### Web robustness parity

- Current-cover failures retry after 5, 10 and 20 seconds, then every five minutes.
- Backdrop image failures retry after 1 and 2 seconds. Prepared compatible artwork
  remains visible when available. Once retries are exhausted, an unavailable variant
  fades to the normal cover rather than retaining artwork from another viewport.
  The context menu offers an explicit retry.
- Station-feed and current resolver failures use 8, 16, 32 and 60-second delays,
  then restart at 8 seconds like the web player.
- Queue provider failures remain uncached and eligible on the minute-spaced worker.
- Current work has priority over queue work in the single bounded network lane.
- A cacheable miss is distinct from an endpoint failure.
- Empty or rejected current CoverLinks fall back to the selected station's trusted
  logo, and corrupt/oversized cover or backdrop payloads enter the normal retry path.
- Backdrop replacement and removal keep the outgoing content rendered through an
  opacity fade. Cover geometry scales with the window, and Windows' client-animation
  preference disables cover, media and rolling-digit motion together.

### Rating images

Windows Imaging Component has no sufficiently reliable, uniform SVG path for these
three native hosts. The finite accepted logo vocabulary is bundled as high-resolution
palette PNG instead. FSK/MPA SVG sources are rasterised locally with `sharp`; TV marks
also have a deterministic local SVG fallback so source throttling cannot make a build
incomplete. The generated PNGs and compiled byte bundle are reproducible and are not
uploaded to TinyPNG/TinyJPG or another optimizer. Text is retained as a decode-safe
fallback. Source and provider notices live in `THIRD_PARTY_NOTICES.md`.

### Settings and UI

The shared options page owns backdrop, age-rating country, hide-cover and ordered
provider controls. Selecting a provider fades a detail surface in below the native
checkbox list view with its clickable site link and applicable attribution. fanart.tv's
detail additionally owns the masked personal-key field, documentation/key links,
asynchronous direct check and persisted verification date. Winamp and the viewer
persist the shared schema in INI; foobar2000 maps it to GUID-backed
`cfg_int`/`cfg_string` values. Provider enablement uses the checked state of a Win32
common-control list view; its row order is the resolver fallback order, so the three
native hosts share both the control implementation and the persisted value.

Winamp registers a scroll host for its shorter Preferences pane, so the complete
shared options page and provider details stay reachable. Configure and the fullscreen
context menu open Winamp's own Options/About dialog; a fullscreen-owned dialog joins
the topmost band and does not close the presentation or redirect into host settings.

Provider details and Winamp Options/About are child windows. They use the shared
`child_fade` snapshot surface rather than `AnimateWindow(AW_BLEND)`, which supports
only top-level windows. The old and new rendered pixels crossfade for 150 ms in an
ordinary child overlay, with sibling clipping on the real pages as well. Rapid
selections reuse the current blended pixels; no deferred callback can outlive the
dialog. Bitmap/DC/timer resources follow the overlay's window lifetime. Reduced
motion bypasses the fade, and allocation/painting/timer failure still reveals the
requested page. No layered-child support or manifest changes in the plugin host
are required. The foobar click map forwards WTL's second argument (control ID), not
its first (notification code), into the same shared options behavior.

The native renderer follows the web player's visible media contract as well:

- Rating marks are retained at the lower-right in DE-then-US order and crossfade on
  track/configuration changes.
- Badge height follows both stage-relative web sizing and the fullscreen window's
  effective DPI, with DPI-scaled lower and upper bounds so high-density monitors do
  not shrink the native PNG marks visually.
- A rating becomes visible for ten seconds once the current track's first badge is
  ready. Afterwards a normal window follows pointer hover; fullscreen fades the
  badges 350 ms after two seconds without pointer movement. Moving the pointer reveals
  them again, and the Windows client-animation preference disables those fades.
- Fullscreen uses that same two-second web-player idle boundary for the system cursor:
  it is visible on entry and immediately after movement, hidden while parked over the
  fullscreen canvas, restored on exit, and kept visible while its menu or options UI
  is open.
- The dedicated fullscreen HWND is activated, kept topmost and registered with
  Explorer through `ITaskbarList2::MarkFullscreenWindow`; this covers the primary
  taskbar as reliably as secondary-monitor taskbars.
- The desktop viewer registers its rendered fullscreen HWND as the main window's
  taskbar preview using `ITaskbarList3::RegisterTab`, `SetTabOrder` and `SetTabActive`.
  The shell then composites the current fullscreen surface, rather than the last
  frame of the covered normal window. The viewer's title/icon and existing taskbar
  group are retained. No second renderer, GPU readback, polling timer or extra media
  request is introduced. Registration waits for `TaskbarButtonCreated`, is renewed
  after Explorer recreates the button, and is removed during `WM_DESTROY` while the
  fullscreen handle is still valid. Failure leaves the normal preview available.
  This host integration is DV-only; the plugins do not replace their player's
  taskbar previews. See Microsoft's [tab-preview contract](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-itaskbarlist3-registertab).
- Poster mode keeps the cover in the upper artwork row and the information panel
  below it for landscape and portrait windows; it no longer switches to the former
  native side-by-side layout on wide windows.
- The cover basis is `min(stage height * 0.58, stage width * 0.86)`. Title, artist
  and countdown sizes use the web factors `0.072`, `0.058`, and
  `0.048`/`0.062`/`0.080`, including the 16/13/12-pixel minimums and medium-weight,
  centred countdown.
- Resolver `tint` colours title, artist and countdown. The renderer falls back to
  the cover-derived tint when no authoritative backdrop tint exists and interpolates
  old and new tint during the same media fade, so the information panel does not
  snap to its next colour.
- The information-panel background matches the web `rgba(10, 12, 18, .55)` surface;
  the tint applies to its text, not to that translucent surface.

## Consequences

- Server matching corrections benefit web and every native release without copying
  JavaScript normalization into C++.
- Host glue remains limited to playback timing, station detection, persistence,
  message forwarding and build inclusion.
- A configuration-aware key can duplicate results across cues, but prevents provider,
  artist or orientation bleed and avoids guessing the resolver's title scope.
- Resolver outage, miss, rejected URL, image failure or decode failure degrades to the
  normal cover-derived presentation and never replaces exported square album art.
- A future non-Windows consumer must add a real HTTPS transport before enabling this
  feature; the current non-Windows socket fallback is plain HTTP.

## Alternatives considered

- **Use ICY metadata as resolver input.** Rejected: host-specific and absent in the
  viewer; it is a timing string rather than structured media metadata.
- **Send the formatted poster title.** Rejected: duration/separators are lossy
  presentation details.
- **Implement one client per host.** Rejected: it duplicates validation, caching,
  cancellation, retry and rendering races.
- **Copy web normalization into C++.** Rejected: rules would drift between releases.
- **Use remote SVG rating logos.** Rejected: adds network failure and inconsistent
  native SVG support for a small, fixed vocabulary.
- **Replace foobar's exported album art with a hero.** Rejected: a landscape/portrait
  backdrop is not the track's square album cover.

## Verification

Deterministic native tests cover raw feed preservation and full queue metadata, resolver
trust/sanitization, hit-versus-miss-versus-failure state, cache identity, exact retry
cadence, queue staggering and every bundled rating PNG. The existing API tests remain
authoritative for provider fallback/matching/certifications, while Playwright remains
authoritative for the web rendering behavior from which these native contracts are
derived. Release builds compile the same shared implementation into all three hosts.

`native_renderer_tests` additionally exercises real WIC and Direct2D on hidden
portrait and landscape windows. Repeated warm handoffs with deterministic 4K
JPEGs assert zero new decodes or blur computations; other cases check blur input
invalidation, hide/show and shutdown, cropped-logo identity, LRU/byte limits and
rejection of malformed or oversized images. Set `SSC_RENDER_BENCHMARK=1` to report
first-frame timings for the eight measured handoffs, excluding fixture encoding,
networking and warm-up. Timing/counter instrumentation is compiled only into that
test target, and no machine-dependent timing threshold determines test success.
On the development machine (Release, 2026-09-14), the same local fixture averaged
477 ms per handoff before the change and 224 ms afterwards without a concurrent
build. Across eight warm handoffs, decodes fell from 48 to zero and blur computations
from eight to zero, with about 70 MiB of decoded-cache payload. These timings cover
renderer target reset through the first frame, not Windows shell/fullscreen animation
or an API cache miss; image-preparation and blur sub-timings can overlap.

Windows CTest additionally runs the production engine scheduler/publication path
against concurrent settings edits, blocked stale publishers, pending UI results,
worker restarts and retry/queue preservation without networking. Deterministic
tests also cover accepted canonical metadata surviving failed/legacy retries, retained
exit and entry fades, rapid handoffs, reduced motion, UTF-16-equivalent text bounds,
HD/4K request/cache separation and station-scoped album-art export. Native off-screen
dialog tests exercise actual WTL button routing, provider ordering, the mandatory
rating-country selection, details/key persistence, opacity interpolation, rapid
page changes, timer and parent-destruction cleanup, repaint clipping and no-animation
fallbacks. These UI tests use the bundled WTL headers and Visual Studio ATL; they
do not drive or restart a user's installed player.

`desktop_taskbar_tests` uses hidden native windows and a simulated shell interface
to verify the fullscreen preview's source, deferred registration, automatic
unregistration before HWND destruction, rapid replacement, Explorer recreation,
failure rollback/retry and COM resource cleanup.
