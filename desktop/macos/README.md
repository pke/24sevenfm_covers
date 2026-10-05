# macOS Desktop Viewer (Apple Silicon)

Native AppKit/Core Animation application using the existing C++ `coverfetch` and
media resolver. No Rosetta or third-party runtime is needed. macOS 13 or newer.

This macOS version supports all five stations, live cover/metadata/countdown,
crossfade and flip transitions, rolling countdown digits, queue cover previews,
animated poster/fill layouts, blurred poster backgrounds, fullscreen
(double-click or Control-Command-F), always-on-top, and optional SST backdrops, title
logos and rating badges. Settings include provider ordering and fanart.tv key
configuration, using native radio buttons and checkboxes. Window geometry
and preferences persist in `app.dudesoft.24sevenfm.covers`. macOS Reduce Motion is
respected. Like the Windows DV, this is a cover viewer, not an audio player.

The portable `PresentationPipeline` prepares complete media frames, preloads the
queue and owns a bounded cache. The AppKit adapter decodes and renders each frame.
Both native paths use `MediaPreparation` for request construction, credits and
validated assets. The progressive resolver worker is also portable C++, with
native publication callbacks. [ADR 0010](../../docs/adr/0010-shared-media-preparation.md)
records the acquisition boundary and the remaining session-policy differences.
Windows and macOS use the same per-view `PresentationController` for artwork,
metadata/title logos, countdown digits, measured layout and overlay visibility.
`CoverEngine` and `SSCStage` serialize events and render immutable `FrameState`
values through Direct2D and AppKit. Native text measurement and resource decoding
stay in the adapters. See [ADR 0009](../../docs/adr/0009-shared-presentation-controller.md). The web
player currently implements the presentation contract in JavaScript, not C++/Wasm.

The poster infobox contains album, composer, track and countdown, with a dark
background and artwork-derived text tint. Coming next occupies the upper trailing
edge (left for RTL). Settings stay above the cover window while the app is active,
without inheriting its global always-on-top behavior. View → Keep Window on Top
and the corresponding settings checkbox control the same preference.
The canvas Settings button fades after the shared native two-second idle timeout.
Coming next uses the shared 250 ms transition duration; rating visibility uses
350 ms fades and a ten-second track introduction. Track labels omit the total
duration; remaining time has its own countdown row.
Settings use a native sidebar with Station, Display, Artwork and Providers panes.
Display contains layout and window options. Age ratings have their own group in
Artwork, with indented native checkboxes for the independent country selections.
Station buttons use bundled station logos from `shared/resources/stations`,
with 12 pt horizontal padding and the system selection background. Windows uses
the same source images. Title logos share placement centred on the infobox's
top edge, with half their height outside and the other half reserved inside.
Providers use a native draggable table, with up/down buttons for keyboard access.
Viewport changes select portrait/landscape and resolution variants through the
portable pipeline, retaining the current frame until its replacement is ready.
Changing ratings updates a separately cached overlay, leaving the current artwork
and its preparation pipeline intact. Badges share Windows' bottom-right placement.

The bundle icon is generated from `desktop/24sevenfm_covers.ico`, preserving the
Windows DV motif. That checked-in ICO currently contains at most 64×64 pixels;
larger macOS representations are scaled. Supply a recovered original using
`-DSSC_APP_ICON_SOURCE=/path/to/original.png` to generate genuinely high-resolution
representations without changing the icon design.

## Build, test and run on the Mac

Requires Xcode (or the Command Line Tools), CMake and Ninja on PATH. The script also
looks in `/opt/homebrew/bin` and `/usr/local/bin`.

```sh
sh desktop/macos/build-install.sh
```

The script builds `desktop/build/macos/24sevenfm_covers.app` for **arm64**, runs all
portable tests and a live HTTPS/feed/image/cancellation smoke test, verifies local
ad-hoc signing, installs to `~/Applications/24seven.fm Covers.app`, compares SHA-256,
and opens the application in the logged-in user's desktop session. Existing bundles
are backed up under `~/Library/Application Support/24seven.fm Covers/Backups/`;
preferences are preserved. It gracefully quits an existing viewer before replacement.
Ad-hoc signing is for local use; this is not a notarized distribution build.

## Build remotely from Windows

Enable Remote Login for the short macOS account name and authorize an SSH key first.
Connect once interactively to verify/trust the Mac's host key. Then:

```powershell
./desktop/macos/build-remote.ps1 -MacHost <host-or-IP> -MacUser <short-account-name> -IdentityFile <private-key-path>
```

Only tracked or non-ignored source files from `lib`, `shared`, and `desktop/macos`
are uploaded, including current uncommitted changes. Each invocation uses a separate
directory under `~/dev/24sevenfm-covers-builds/`; it never resets a remote checkout.
It uses non-interactive, identity-only SSH with strict host-key checking. Keys and
host-specific credentials are not stored in this repository.

## Verification

```sh
"$HOME/Applications/24seven.fm Covers.app/Contents/MacOS/24sevenfm_covers" --smoke-test
```

For visual QA, quit the viewer, then run its executable with
`SSC_UI_CHECK_DIR=/absolute/output/directory` in the environment. After receiving a
live cover it saves layout/settings screenshots and verifies window levels and
stable odometer glyph positions. `check-ui.sh` runs this check and reopens the
normal viewer. QA uses an isolated preferences suite.

The shared Apple HTTP backend uses NSURLSession and system TLS trust, rejects
automatic redirects, bounds responses to 16 MiB and supports cancellation. The
ImageIO decoder checks dimensions before decoding and shares the existing 4096px
image limit. Linux uses libcurl and GdkPixbuf; Android retains the socket transport.
Windows keeps WinHTTP. See the [Linux viewer](../linux/README.md).
