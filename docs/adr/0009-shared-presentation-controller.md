# Shared native presentation controller

Status: implemented, tested and installed (2026-10-04).

Each native view owns a `ssc::PresentationController`. AppKit's `SSCStage` and the
Windows `CoverEngine` advance it on their serialized event executor; Windows
publishers use the existing publication mutex. Window switches retain separate
controller instances. Drawing reads a `FrameState` and does not advance the
production presentation clock.

The controller coordinates small artwork, metadata, title-logo, countdown,
layout and overlay state machines. Its monotonic clock is injectable. Track and
operation identities reject stale results; provider/viewport operations do not
restart the track introduction or countdown. Existing Windows resolver mailboxes
retain their epoch checks before forwarding assets. macOS checks the pipeline
generation and session before accepting prepared assets, and track identity before
accepting countdown ticks.

`FrameState` contains retained image references, text, opacity, scale, clip and
top-left-origin rectangles. Adapters measure native text and return target sizes.
AppKit converts the common geometry to its bottom-left coordinate system.
DirectWrite/WIC/Direct2D and AppKit/ImageIO remain responsible for native resources;
window levels, menus, settings persistence and input remain host responsibilities.

Artwork interruptions preserve the complete sampled mixture, including an
interrupted flip's scale. Outgoing references retire after the exit completes.
Digit columns retain their sampled layers during interruption, so unchanged digits
do not move. Logo visibility and its reserved layout row have separate timelines.
Coming Next retains its outgoing text and cover. Reduced Motion completes the
transitions; the None artwork option uses a short opacity fade.

The legacy Direct2D drawing entry point still accepts scalar arguments for isolated
renderer tests. Native applications supply the common FrameState. Its optional
legacy animation state is not the production source of presentation decisions.

## Stable measurement targets (2026-10-04)

Coming Next now passes only untrimmed native text metrics to
`PresentationController::measuredNext`. The controller computes the final card
size from content and cover presence. Cover opacity is never a measurement input:
feeding an animated value back into another transition repeatedly restarted the
size animation and made the entering card wobble. The full geometry is prepared
while invisible; a cover that arrives while visible animates its reserved column
and the card dimensions once over 250 ms. Both adapters consume `nextCoverLayout`
for the column and image dimensions, independently of image opacity. Windows no
longer advances Coming Next a second time after advancing the common frame.

Countdown sizing is an explicit common presentation policy. The Windows host
selects `ViewportRelative`, preserving its existing .048/.062/.080 size choices
against client height in fill mode and proposed cover side in poster mode. Client
pixels already include DPI scaling. AppKit retains its established 20/32/48 logical
point choices through `Fixed`. Resize/size changes interpolate in the common
controller; no preferences or saved size values are migrated.

Regression tests verify stable dimensions and monotone entry on every sampled
frame, completion of a single late-cover resize despite continuous measurement,
all three countdown sizes through 4K, Reduced Motion and the actual Windows host
settings path. AppKit's native UI check also compares card dimensions at entry,
150 ms and after completion.

Verification for this correction: Windows 230/230 and Apple Silicon 135/135 tests
passed, along with the macOS live smoke and extended native UI checks. Desktop,
Winamp and macOS installations were updated with binary/settings backups and hash
verification; Windows INI and macOS preference values remained unchanged. Evidence
is in `.codex/native-backups/presentation-fix-20261004-052004/`.

## Verification

Title-logo alignment follow-up: a transparent crop can still contain an asymmetric
decorative flare, such as the long line to the right of the Dune: Part Two lettering.
`image_alpha_bounds.h` now derives a horizontal lettering anchor from columns with
at least 15% of the maximum occupied height (using the existing alpha threshold).
Small isolated marks and shifts below 2% retain geometric centring; larger shifts
are bounded to 12.5% of image width so the artwork stays inside the stage. The
entire original crop and scale are retained. Native decoders cache the anchor with
their image resource, and the common `titleLogoRect` places that anchor on the
panel centre. There are no album-name exceptions or per-frame image scans.

Regression coverage includes left/right tails, scale and row-stride changes,
balanced/thin logos, Windows cached decoding after target recreation, and native
AppKit/Qt decoding without losing the decorative tail.

Logo fix verification (2026-10-04): 241/241 Windows and 145/145 macOS tests
passed, together with the native AppKit UI check. The actual Fanart Dune asset has
visible horizontal bounds [9,775) and substantial lettering bounds [9,656), giving
an anchor of 0.422324 and a 59.5-source-pixel shift to the right at unchanged scale.
The Qt adapter and its regression fixture are updated, but its build could not
start: both WSL launch attempts failed with `CreateVm/ERROR_TIMEOUT`.

- Controller: 12 cases / 86 assertions cover artificial-clock interruption,
  stale operations, independent views, resource lifetime, settings changes,
  ratings, geometry and Reduced Motion.
- Windows: 219/219 CTest tests passed. After the final Direct2D cache cleanup,
  native engine tests passed 27 cases / 767 assertions and native renderer tests
  passed 9 cases / 1026 assertions. Fullscreen tests verify frame invariance
  across drawing when the image bytes are unchanged.
- Apple Silicon: 125/125 tests and the live TLS/feed/image/cancellation smoke test
  passed. Native UI checks passed for poster/fill, settings, window levels,
  odometer pixels, queue text sizing and motion, resize, controls, station logos
  and provider changes. The installed app quit and restarted normally.
- Windows DV, Winamp and foobar binaries built successfully. The DV was installed
  at `desktop/build/Release/24sevenfm_covers.exe` and restarted. The Winamp plugin
  was installed at `C:/Users/philk/OneDrive/tools/Winamp/Plugins/gen_24sevenfm_covers.dll`;
  Winamp was not running. Both installed hashes match their builds. Viewer settings
  are unchanged; replaced binaries and settings were backed up under
  `.codex/native-backups/presentation-install-20261004-044529/`.
- macOS was installed at `/Users/pkursawe/Applications/24seven.fm Covers.app`
  and restarted. Windows process/path and installation evidence is recorded in
  `desktop/build/presentation-windows-running.json` and
  `desktop/build/presentation-windows-install.json`.
- Interactive Windows visual verification remains unperformed after the user
  stopped Computer Use; installation was completed using process control.
