# Shared C++ integration spec for implementation agents

Verified against the repository source on 2026-10-13.

## Assignment and intended result

Build or extend a native host by reusing this repository's feed, media preparation,
settings and presentation code. Keep platform code responsible for windows,
input, persistence, native resources and drawing. Reuse shared policies rather
than implementing another parser, provider client, cache or animation timeline.

This document describes the existing interfaces and the requirements for their
consumers. It does not introduce a new public API or a unified application session
controller. Read the repository's `AGENTS.md` before implementation; its rules
also apply to installation, motion and commits.

## Choose the integration surface

| Host or requirement | Reuse | Reference implementation |
| --- | --- | --- |
| Windows viewer or player plugin | `CoverEngine` and the shared Direct2D renderer | `desktop/24sevenfm_covers.cpp`, `winamp/gen_24sevenfm_covers.cpp`, `foobar2000/foo_24sevenfm_covers/ui_element.cpp` |
| Native host with its own renderer | `CoverMonitor` → `PresentationPipeline` → `PreparedPresentation` → `PresentationController` → `FrameState` | `desktop/linux/viewer.cpp`, `desktop/linux/stage.cpp`, `desktop/macos/main.mm` |
| Progressive asset publication and retry behavior | `MediaPreparation` and `MediaWorkerState`, with host session coordination | `shared/cover_engine.cpp`, `shared/media_worker.cpp` |
| Feed-only integration from C, Swift or JNI | `lib/coverfetch_c.h` | `lib/coverfetch_c.cpp` |

`shared/` is a source directory, not a portable library target. Some of its files
include Win32 and Direct2D headers. The portable CMake library target is
`coverfetch`, defined in `lib/CMakeLists.txt`; it already includes preparation,
pipeline, worker and rating sources. `PresentationController` is header-only.
`CoverEngine` is Windows-only despite being shared across Windows hosts.

## Ownership map

| Source | Responsibility |
| --- | --- |
| `lib/coverfetch.h` | Feed polling, parsing, `TrackInfo`, queue queries, refresh and countdown ticks |
| `lib/media_resolver.h` | Project API requests, canonical metadata validation, trusted provider URLs and downloads |
| `lib/media_policy.h` | Cache keys, retry timing, prefetch limits, rating visibility and common layout helpers |
| `shared/stations.h` | Station IDs, hosts, trusted ident logos and station labels |
| `shared/media_preparation.h` | Settings-to-request projection, identities, text selection, credits and validated asset bytes |
| `shared/presentation_pipeline.h` | Complete prepared presentations, generation invalidation, queue scheduling and bounded cache |
| `shared/media_worker.h` | Progressive resolver/image/rating work, retries, caches and backdrop cycling |
| `shared/presentation_controller.h` | Per-view presentation state, operation tokens, transitions and sampled frames |
| `shared/coming_next.h`, `info_presentation.h`, `title_logo_presentation.h` | Retained content and transitions consumed by the controller |
| `shared/engine_settings.h`, `settings_schema.h` | Defaults, canonical settings, per-platform storage aliases and constraints |
| `shared/config_store.h`, `config.h` | Key/value persistence interface and existing settings helpers; INI operations are Windows-specific |
| `lib/http_client.*`, `lib/image_probe*` | Platform transport and bounded image validation |
| `shared/d2d_*`, `cover_menu.*`, `options_panel.*`, `fullscreen_window.*` | Windows rendering and UI helpers |

Provider matching and service credentials remain in the project's server API.
Native hosts must consume `MediaResolver` rather than independently querying
each provider. The optional personal fanart key remains a local setting and must
not appear in diagnostics or handoff artifacts.

## Portable host integration

### Build the core once

Use C++17 for native hosts. The legacy feed facade has older-language support,
but the full native integration should follow the existing C++17 build graphs.

For a new CMake host inside this repository, adapt this fragment to its location:

```cmake
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(COVERFETCH_BUILD_EXAMPLE OFF CACHE BOOL "" FORCE)
add_subdirectory("${REPOSITORY_ROOT}/lib" core)
target_include_directories(my_host PRIVATE "${REPOSITORY_ROOT}/shared")
target_link_libraries(my_host PRIVATE coverfetch)
```

Define `REPOSITORY_ROOT` as the absolute checkout path and create `my_host` before
its target commands. `coverfetch` publicly exports the `lib/` include directory;
add `shared/` for includes such as `presentation_pipeline.h`. Do not also compile
the core's `.cpp` files directly into the same target. Windows hosts currently
use explicit source lists instead; follow that established graph when editing
an existing Windows project.

Platform dependencies are selected by the core CMake file:

- Windows: WinHTTP, WIC, COM and sockets; native drawing additionally uses
  Direct2D and DirectWrite. WinHTTP linking also uses an MSVC source pragma.
- Apple: Objective-C++, ARC, Foundation, ImageIO and CoreGraphics; AppKit and
  QuartzCore belong to the viewer.
- Linux: libcurl and GdkPixbuf development packages; `SSC_LINUX_NATIVE=1` is
  exported by the core target. Qt belongs to the viewer, not the core.
- Other/mobile branches: plain-socket transport and a weaker signature-only
  image probe remain. Do not assume the desktop TLS/decoder guarantees apply to
  a new mobile port; inspect and supply the platform backend it needs.

### Own a session and serialize presentation

Each session owns a monitor and a pipeline, a fixed station index, its latest
live-track identity, and a lifetime/revision guard. Each visible view owns a
`PresentationController`. A controller has no internal synchronization: call
its events, measurement methods and `advance()` on one serial executor, normally
the UI thread. Worker callbacks must dispatch there before touching it.

Create the pipeline before starting the monitor. This factory demonstrates the
existing complete-presentation acquisition path; `publish` is supplied by the
host and must dispatch and validate as described below:

```cpp
#include "presentation_pipeline.h"
#include <memory>

std::unique_ptr<ssc::PresentationPipeline> makePipeline(
    int stationIndex, ssc::PresentationPipeline::Publish publish) {
    return std::make_unique<ssc::PresentationPipeline>(
        [stationIndex](const ssc::TrackInfo& track,
                       const ssc::MediaRequest& request,
                       const std::atomic<bool>* cancel) {
            return std::make_shared<const ssc::PreparedPresentation>(
                ssc::preparePresentation(track, request, stationIndex, cancel));
        },
        [stationIndex](const std::atomic<bool>* cancel) {
            return ssc::stationQueue(stationIndex, cancel);
        },
        std::move(publish));
}
```

The constructor starts its worker immediately. Keep the captured station fixed
for this pipeline's lifetime. `preparePresentation` performs synchronous work
and belongs on that worker, never inside a paint or UI callback.

Configure `ssc::Config::host` from `ssc::station(stationIndex).host`. Set tick and
error callbacks before `CoverMonitor::start()`. All monitor callbacks run on its
background thread. Copy `TrackInfo` or strings when dispatching asynchronously;
callback references are borrowed.

On each accepted feed update, on the serial executor:

1. Validate that the callback's session is still active.
2. Store `ssc::trackIdentity(track, stationIndex)` and pass it to
   `controller.trackChanged(identity)`.
3. Call `controller.remainingChanged(track.remainingSeconds)`.
4. Project settings into `MediaPreferences`, then call `ssc::mediaOptions()`
   with physical viewport pixels. Use `requestForTrack()` to bind track fields
   and submit through `pipeline.current(track, request)`.

`mediaOptions()` applies SST-only eligibility, the logo/backdrop dependency,
independent ratings selection and viewport caps. `MediaRequest`'s raw defaults
request art and ratings, so use this projection to honor the user's switches.
Do not hand-code a competing eligibility rule.

Ticks update remaining time only when both the session and live-track identity
match. `TrackInfo` lengths are already seconds; the feed's millisecond conversion
has already happened. The historical cover-change callback also reports metadata
changes and can have an empty URL for an ident: do not discard those events.

### Reject stale publications at the final dispatch

The publish callback receives `(frame, queued, cached, generation)` on the worker.
Capture the owning session weakly and capture the `Frame` by value. At execution
on the UI thread, reject it if the host is closing, the session expired or was
replaced, or `pipeline.generation() != generation`.

The pipeline checks its generation before invoking the callback, but the result
can become stale while waiting in the UI queue. The final check is mandatory.
`cached` indicates cache reuse; it does not grant an exception to these checks.

Pipeline generations and controller operation tokens are separate counters.
Never pass a pipeline generation directly to `resolverCompleted()` or
`assetReady()`. For the complete-presentation path, perform the session/pipeline
check first, then obtain a controller token for the accepted frame's track.
For independently outstanding same-track operations, call `newOperation()` when
request options change and retain that token through publication.

For an accepted current presentation:

- Choose text through `ssc::presentationText(frame.track, frame.media, station)`.
  `MediaResult::hasMetadata` determines canonical authority. A missing backdrop
  does not mean metadata is invalid. Convert UTF-8 through the platform's proper
  Unicode conversion before passing `std::wstring` text to the controller.
- Use `trackChanged()` to obtain the controller token and `resolverCompleted()`
  for text. The existing native album heading passes the chosen album as both
  the title and album arguments, with artist, track and authority alongside it.
- Convert nonempty cover/backdrop byte strings into
  `std::shared_ptr<const std::string>` and call `assetReady(token, image, false)`
  for the cover and `assetReady(token, image, true)` for the backdrop. Use a null
  reference for absent artwork; call `backdropChanged()` with actual presence.
- Supply validated logo bytes and its album through `setLogo()`. Compose rating
  images or text using native resources and submit their immutable image bytes
  through `setRatingContent()`, or follow the existing host's rating adapter.
  These methods have no operation-token argument: validate before calling them.

`PreparedPresentation` carries encoded binary images in `std::string`, not URLs
or nul-terminated text. Use `data()` and `size()` when decoding. `Frame` is a
`shared_ptr<const PreparedPresentation>` and can safely keep those bytes alive
through dispatch. `cacheable` controls cache admission, not whether a frame is
publishable; do not discard all non-cacheable fallback presentations.

For `queued=true`, update Coming Next through `queuedTrackIdentity()`,
`controller.comingNext.setQueue()`, `resolve()` and `setCover()`. Do not replace
the current artwork, countdown or live-track identity. Queue credit enrichment
must not create a new row identity. The pipeline publishes the first planned
queued item and prepares later items for cache reuse.

### Options, viewport and shutdown

Use `pipeline.options(newRequest)` to reprepare media without reconnecting the
feed or discarding the visible frame. Use `pipeline.viewport(width, height)`
when the physical viewport changes; it reprepares when portrait/landscape or
resolution class changes, rather than for every pixel resize. Independently
update controller settings and geometry so layout responds immediately.

`cancel()` permanently retires a pipeline: it sets the stopping state, signals
in-flight cancellation and clears pending jobs. It does not merely reset the
current request. `stop()` calls `cancel()` and joins the worker. The destructor
also stops. A station switch needs a new session and pipeline.

Retire the old session, invalidate publication guards, cancel acquisition, and
join monitor/pipeline workers on a retirement executor when responsiveness
matters. Keep session data and callback receivers alive until the joins finish;
drain or invalidate pending UI dispatches. Never join a worker from its own
callback. `CoverMonitor::stop()` also joins; use its cancellation token in any
additional callback-initiated acquisition so shutdown cannot wait out repeated
request timeouts. Keep cancellation-token owners alive for the full operation.

## Presentation and renderer contract

Drive a monotonic millisecond clock and advance the controller during serialized
updates/ticks. Native text measurement can occur between advances, as existing
hosts do. Drawing consumes a retained `FrameState`; it must not advance time or
change presentation state. `frame()` and `advance()` return references to the
controller's internal frame, not independently owned immutable snapshots: copy
the frame if another execution context needs a stable snapshot.

Draw the sampled image layers in order, using their opacity and scale, and honor
the frame's text, logo layout, rating visibility, countdown columns and rectangles.
Keep resources for every outgoing reference until the transition retires it.
Do not substitute a new two-image fade when the controller already supplies an
interrupted multi-layer mixture.

Use `viewportChanged()` and native text measurements in one consistent drawing
coordinate space. Frame rectangles have a top-left origin; AppKit converts at
the boundary. Media-request dimensions are physical pixels even when an adapter
draws in logical points. Match the chosen adapter's scale convention. Windows
and Linux use `CountdownSizing::ViewportRelative`; AppKit uses `Fixed`.

Use `measuredNext()` with the final, untrimmed text metrics. Consume
`nextCoverLayout` for reserved cover geometry independently of cover opacity.
Do not use an animated cover opacity as a layout measurement target. Reuse
`presentation_style.h`, `titleLogoSize()`, `titleLogoRect()` and
`image_alpha_bounds.h` for typography, logo bounds and placement. Cache decoded
resources and logo anchors rather than rescanning images on every frame.

For the infobox, measure the incoming `FrameState::infoLogo` resource and its
final `infoLogoLayout` presence, together with `infoCountdownWidth`. Submit the
complete final text/logo width and height through `measuredInfo()`. Do not feed
sampled `logoLayout`, logo opacity or countdown opacity back into measurement.
The controller retains the outgoing geometry while `infoMeasureReady` is false
and reserves the configured countdown row when remaining time is briefly unknown.
A progressive adapter must set `infoAssetsPending(true)` while waiting for a
requested logo, then submit the validated logo or final miss through `setLogo()`
before releasing the wait with `infoAssetsPending(false)`. Validate the current
operation at UI dispatch before either call.

Every visible-state change needs at least an opacity fade, and visible dimension
changes must animate. Preserve outgoing text and images through their exit.
The controller's None artwork effect still uses a short fade; Reduced Motion
may finish transitions immediately. Feed the host's OS/preference policy into
`PresentationSettings::reducedMotion`. Native controls outside the controller
must also follow the repository's motion rules.

Avoid repainting and remeasuring a settled frame when no displayed value changes.
Keep time updates sufficient for countdown and pointer-idle policy; do not stop
all ticking solely because `FrameState::animating` is false.

## Windows host contract

Reuse `CoverEngine::instance()` for an existing Windows host. Load its
`settings`, set a distinct log name before starting, and attach the drawing HWND
through `setWindow(hwnd)`. The mutable settings object is UI-thread-only; after
changing settings, persist through the host's store and call `repaint()`.

| Host event | Forward to |
| --- | --- |
| `WM_PAINT` | `onPaint(hwnd)` |
| `WM_TIMER` | `onTimer(hwnd, timerId)`; engine heartbeat ID is `kHeartbeat` |
| `SSC_WM_NEWCOVER` (`WM_APP + 1`) | `onNewCover(hwnd)` |
| `SSC_WM_NEWMEDIA` (`WM_APP + 2`) | `onNewMedia(hwnd)` |
| Player title update | `onTitleChanged(utf8Title)` |
| Playback stopped | `resetTitle()` and the host's existing stop/hide lifecycle |
| Pointer move/leave | `onPointerMove(hwnd, fullscreenAutoHide)` / `onPointerLeave(hwnd)` |

Use `start(true)` for the standalone live station clock and `start(false)` for
player-driven advancement. Player titles trigger confirmation with the feed;
they must not directly consume prefetched queue art, since an ident/jingle can
intervene. Set station through `setStation(index)` when the viewer selection or
player stream changes. Use existing click/key handlers for album layout and
backdrop cycling, and persist settings changed by an accepted album click.

Detach an active drawing window with `setWindow(nullptr)` before destroying it.
If multiple host windows exist, check `currentWindow()` first so destruction of
an inactive window does not detach the active one. Stop the engine at host
shutdown. Preserve existing COM initialization and native renderer lifetimes.

For a new progressive adapter, study `CoverEngine` rather than treating
`MediaWorkerState` as a ready-made session controller. The caller owns scheduling,
thread lifetime and state locks. Worker callbacks run outside the work mutex;
recheck epochs and backdrop selections under the publication lock and again at
UI dispatch. Preserve the established lock order: worker state, then publication
state. Copy callback payloads before dispatch; raw pointers and references are
borrowed. Windows currently uses this worker in production; AppKit/Qt use the
complete-presentation pipeline. Their scheduling and retry behavior differ.

## Settings, cache and transport requirements

- Read defaults and bounds from `ssccfg::settingsSchema(profile)` and
  `EngineSettings`. Do not invent platform-specific engine defaults. Map engine
  fields explicitly to `PresentationSettings` and `MediaPreferences`; the three
  structures serve different boundaries.
- Persist station IDs such as `sst`, translating them with `stationIndexForId()`
  and `validStationIndex()`. Indices are an in-memory detail. Use schema storage
  aliases for existing platform preferences; retain saved values and formats.
- Select editable descriptors using `ui && supported`; plugins additionally omit
  `desktopOnly`. Respect `enabledWhen` separately from `appliesWhen`. Disabling a
  control must not erase its saved value. Small single-choice sets use native
  radio/button groups; multiple selections use checkboxes.
- Preserve the Windows DE/US fallback when neither rating flag is set and the
  macOS/Linux empty-country selection behavior. Slider steps govern UI snapping,
  not whether an existing duration such as 1234 ms is valid.
- The schema exporter produces metadata, not live preferences. If changing schema
  definitions, regenerate `docs/configuration/settings-{windows,macos,linux}.json`
  with `settings_schema_export` and verify consistency.
- Use `mediaCacheKey()`, `sameBackdropConfig()`, `sameResolverConfig()` and
  `planQueueMedia()` where appropriate. Do not key reusable media only by album
  or merge the distinct backdrop and title-logo response variants. The pipeline
  bounds its cache by 64 entries and a 128 MiB encoded-byte budget; native resource
  caches need their own bounds.
- Use the shared retry-delay functions for progressive work. Do not assume the
  complete-presentation scheduler supplies every Windows retry/cycling/session
  behavior; preserve the scheduler of the host being extended.
- Acquire through shared transport/preparation. Keep trusted station/provider
  URL checks, cancellation, timeouts, native TLS certificate validation and image
  limits. Current desktop image probing is bounded to 16 MiB encoded data and
  4096 pixels per axis. Request viewport caps (8192) are a separate policy.
- Test transports are available through `Config::transport`,
  `MediaResolverConfig::transport` and `MediaPreparation::Transport`. Their
  signatures differ; read the header. `preparePresentation()` itself constructs
  the default resolver, so fixture loaders should compose preparation/resolver
  seams or return fixture frames rather than expecting a resolver argument there.
- The C ABI only wraps the monitor's URL notification and lifecycle. It does not
  expose prepared frames, resolver options, queue metadata or controller state.
  Copy its callback URL before returning and marshal it to the UI thread. Rich
  foreign-language integration requires a deliberate adapter, not C++ object
  pointers crossing an unsupported ABI boundary.

## Implementation sequence and acceptance criteria

1. Identify the existing host and its scheduler. Read its lifecycle, settings
   adapter and renderer before changing shared code. Keep common behavior in
   common sources and platform resources in the adapter.
2. Integrate a fixture presentation first. Verify text, artwork, countdown,
   queue content, geometry and motion without depending on live provider traffic.
3. Connect feed and media acquisition with lifetime guards and final publication
   checks. Verify option changes and station retirement while requests are active.
4. Run the relevant shared regression suites and affected host integration tests.
   Add focused tests for new behavior or regressions; do not mirror implementation
   details in tests. Exercise stale replies, same-track option changes, shutdown,
   interrupted exits, reduced motion and native decode limits when affected.
5. Build all affected consumers. If adding a compiled shared source, update every
   applicable explicit source list: `lib/CMakeLists.txt`, `winamp/CMakeLists.txt`,
   `desktop/24sevenfm_covers.vcxproj` and the foobar component's `.vcxproj`.
6. Complete the required local installation after native changes and report
   actual checks, installed hashes, running paths and any unavailable validation.

Portable/shared test commands from the checkout root on Windows, in a developer
shell with CMake/MSBuild available:

```powershell
cmake -S lib -B lib/build-tests -A x64 -DCOVERFETCH_BUILD_TESTS=ON -DCOVERFETCH_BUILD_EXAMPLE=OFF
cmake --build lib/build-tests --config Release
ctest --test-dir lib/build-tests -C Release --output-on-failure
```

Especially relevant sources are `lib/tests/test_media_preparation.cpp`,
`test_presentation_pipeline.cpp`, `test_presentation_controller.cpp`,
`test_media_policy.cpp`, `test_settings_schema.cpp`, `test_native_engine.cpp`
and `test_native_renderer.cpp`. Use existing fixtures and artificial clocks.
Platform host instructions are in `desktop/linux/README.md` and
`desktop/macos/README.md`; do not report those platforms as verified without
executing their checks.

Existing Windows release build commands:

```powershell
msbuild desktop/24sevenfm_covers.vcxproj /p:Configuration=Release /p:Platform=x64
cmake -S winamp -B winamp/build -A Win32
cmake --build winamp/build --config Release
msbuild foobar2000/foo_24sevenfm_covers/foo_24sevenfm_covers.vcxproj /p:Configuration=Release /p:Platform=x64
```

Winamp requires the 32-bit build. Native post-build packing requires PowerShell
7 and the project's UPX workflow; foobar builds require the vendored SDK/WTL
setup described in the root README.

After native changes, repository instructions require updating both the viewer
at `desktop/build/Release/24sevenfm_covers.exe` and the installed plugin at
`C:/Users/philk/OneDrive/tools/Winamp/Plugins/gen_24sevenfm_covers.dll`, plus any
actual installation used by running processes. Retain recoverable binary backups,
preserve settings, stop locked apps through verified process paths, replace the
files and restart apps that were running, restoring Winamp playback when applicable.
Verify installed hashes and restarted executable/plugin paths. Process-based
restarts are authorized; mouse/keyboard/window automation requires separate
explicit permission. Documentation-only changes do not require native deployment.

If committing, use Conventional Commits, sign every commit with the configured
identity and verify the signature. Do not disable signing to bypass a failure.

## Further reference

- [Shared presentation controller](adr/0009-shared-presentation-controller.md)
- [Shared media preparation and retained scheduler differences](adr/0010-shared-media-preparation.md)
- [Static settings schema](adr/0011-static-settings-schema.md)
- [Linux adapter](adr/0011-linux-desktop-adapter.md)
- [Configuration exports](configuration/README.md)
- [Provider API contract](vercel-backdrop.md)
- [Native diagnostics](debugging.md)
