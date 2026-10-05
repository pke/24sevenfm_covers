# Linux Desktop Viewer

Native Qt 6 Widgets viewer using the same `CoverMonitor`, `TrackInfo`,
`MediaPreparation`, `PresentationPipeline` and `PresentationController` as the
other native hosts. Qt measures text and draws the immutable `FrameState` with
QPainter; it owns windows, input, image resources and preferences. It does not
implement another artwork, countdown or Coming Next state machine.

Supports all five stations, poster/fill, cover transitions (crossfade and two flip
axes), countdown sizes and rolling digits, Coming Next, fullscreen, settings,
SST backdrops/title logos/ratings, provider ordering and a personal fanart.tv key.
This is a cover viewer, not an audio player.

## Build and run (Ubuntu 24.04 / Debian with Qt 6.2+)

```sh
sudo apt-get update
sudo apt-get install build-essential cmake ninja-build pkg-config \
  libcurl4-openssl-dev libgdk-pixbuf-2.0-dev qt6-base-dev libqt6opengl6-dev \
  qt6-image-formats-plugins qt6-wayland libqt6svg6
sh desktop/linux/build.sh
desktop/build/linux/24sevenfm_covers
```

No source download occurs during CMake configuration. Doctest and station logos
are already in the repository. Set `SSC_LINUX_BUILD_DIR` to build elsewhere;
for WSL, a directory on its Linux filesystem speeds up compilation:

```sh
SSC_LINUX_BUILD_DIR="$HOME/24sevenfm-linux-build" sh desktop/linux/build.sh
"$HOME/24sevenfm-linux-build/24sevenfm_covers"
```

The script runs the portable regression suite, Linux decoder/render/settings
integration tests and real loopback HTTP tests. `SSC_LIVE_TEST=1` additionally
checks HTTPS, feeds and image decoding for all five stations. Internet failures
remain visible; live tests are not silently skipped or part of offline CTest.

`cpack` creates `24sevenfm-covers-1.0.0-linux-x86_64.tar.gz` in the build directory.
Extract and run its `bin/24sevenfm_covers`, or install locally:

```sh
cmake --install desktop/build/linux --prefix "$HOME/.local"
```

The archive is a **dynamically linked Linux x86-64 build**, not an AppImage.
An Ubuntu 24.04 compatible glibc and runtime packages `libqt6widgets6t64`,
`libcurl4t64`, `libgdk-pixbuf-2.0-0`, `qt6-qpa-plugins`,
`qt6-image-formats-plugins` are required; Wayland additionally needs `qt6-wayland`.
Build locally on older distributions. ARM64 can be built natively with the same
script but is not implied to have been tested.

## Controls and preferences

- F11 or double-click: fullscreen; Escape: leave fullscreen.
- Ctrl+, or right-click: settings. The canvas button fades after pointer inactivity.
- Ctrl+R: refresh feed; Ctrl+Q: quit.
- Radio button groups select station, layout, countdown size and transition.
  Checkboxes enable optional features; provider order uses Up/Down buttons.
- The Linux-only Renderer tab selects Raster (default), direct OpenGL,
  pixel-matched OpenGL, RHI/OpenGL or RHI/Vulkan. Selection is saved for the next
  start; “Restart viewer” applies it. Uninstalled companions are disabled.
  A failed GPU process or detected software fallback recovers to Raster with a
  visible explanation, without overwriting the requested setting.
  `--renderer raster` is a one-launch recovery override; `--renderer-check`
  verifies initialization without network access and prints the actual backend.

New or missing preferences use the common Windows reference defaults: Fill layout,
countdown off, Small countdown size, rolling digits off and Coming Next off. Both
the viewer and settings controls read these defaults from the shared schema. Saved
user preferences continue to take precedence.

Preferences and window geometry use Qt's native INI store at
`~/.config/dudesoft/24sevenfm-covers.conf`. The optional key is stored there with
owner-only permissions. No Windows INI or macOS preferences are imported or
overwritten. Tests use a temporary preferences directory.

## Native boundaries and platform differences

- Linux HTTPS uses libcurl, system certificate trust and proxy environment settings,
  cancellation, timeouts, transparent chunking/compression and a 16 MiB body cap.
  Redirects are returned to the caller instead of followed across trusted hosts.
- GdkPixbuf verifies full image decoding with dimensions checked before allocation;
  Qt checks the same 4096 px limit before loading native draw resources.
- Shared countdown sizing is `ViewportRelative` (.048/.062/.080). Qt uses logical
  coordinates for high DPI drawing and physical dimensions for provider requests.
- Coming Next passes untrimmed text metrics to `measuredNext`. Its reserved cover
  column uses `nextCoverLayout`; image opacity never becomes a measurement target.
- Production rendering defaults to Qt's raster backing store. OpenGL companions
  are built by default; RHI companions additionally require Qt 6.7+, ShaderTools
  and GuiPrivate development files. `-DSSC_GPU_RENDERERS=OFF` builds raster only.
  Install/package all companion binaries together. The presentation/layout engine
  is shared across every path. Comparison binaries and pixel checks are documented in
  [RENDERING.md](RENDERING.md).
- Keep-on-top is a window manager hint. X11 window managers usually support it;
  Wayland compositors can ignore it. Fullscreen/positioning also follows compositor
  rules. Content fades use Qt graphics opacity effects so they also work on
  Wayland; native window decorations remain controlled by the compositor.
- Reduce Motion is always available explicitly. GNOME's `enable-animations=false`
  is read at startup. Other desktop environments do not share a universal setting;
  there is no claim of live cross-desktop accessibility preference monitoring.
- Poster backgrounds use a low-pass image filter. Presentation text uses the
  shared fractional sizes and Windows weights (album 600, artist 400, track and
  countdown 500). Segoe UI is preferred; WSL loads it from the existing Windows
  installation without copying or redistributing fonts. Other Linux installations
  fall back to Noto Sans or DejaVu Sans. Native text rasterization still differs.
- Title logos use the shared size/row policy and visible alpha bounds, replacing
  the album text. The countdown has no additional background inside the info box.
- Complete-frame scheduling follows the macOS pipeline. Windows-only progressive
  resolver retries/manual backdrop cycling remain the differences recorded in
  [ADR 0010](../../docs/adr/0010-shared-media-preparation.md).

## Reproducible visual and live checks

```sh
SSC_UI_CHECK_DIR="$PWD/desktop/build/linux-qa" \
  QT_QPA_PLATFORM=offscreen desktop/build/linux/linux_adapter_tests
# Actual desktop window (WSLg, X11 or Wayland), exits after its live capture:
desktop/build/linux/24sevenfm_covers --capture "$PWD/desktop/build/linux-live"
QT_QPA_PLATFORM=offscreen desktop/build/linux/24sevenfm_covers --smoke-test
```

The integration tests render poster/fill, rolling digits and Coming Next, check
that painting does not advance the controller, exercise late-cover geometry,
click native settings controls, round-trip preferences and enter/leave fullscreen.
Screenshots are captured from the same QWidget/QPainter implementation as the
application. Offscreen tests alone are not evidence of a desktop/compositor run.

## Verified on 2026-10-04

- Ubuntu 24.04 x86-64, WSL2/WSLg Wayland, GCC 13.3, Qt 6.4.2,
  libcurl 8.5.0, GdkPixbuf 2.42.10.
- 141/141 CTest entries passed (portable suite plus Linux adapter and transport
  bundles). The Linux bundles contain ten native adapter cases and five real
  loopback HTTP cases.
- Native adapter tests also passed with actual WSLg Wayland windows; screenshots
  cover settings, poster/fill, Coming Next, rolling digits and SST image overlays.
  Live Wayland captures contain real feed artwork and metadata. All five station
  HTTPS/feed/image checks and the shared API normalization check passed.
- Latest layout fixes: Windows policy 21/21 and Direct2D renderer 9/9 cases;
  Apple Silicon 142/142 CTest entries plus live smoke; eight browser logo cases.
  The initial port also passed the full Windows regression (230/230).
  Windows DV and installed Winamp plugin were backed up, rebuilt and hash-verified;
  the running DV was restarted at its original path, with unchanged INI hash.
  Winamp was not running. macOS was also backed up, updated and hash-verified.
- Local evidence: `desktop/build/linux-qa/`, `desktop/build/linux/`,
  `desktop/build/linux-windows-install.json`, and
  `.codex/native-backups/linux-port-20261004-154735/`. Current UI-fix evidence uses
  `desktop/build/linux-ui-fix-*.log` and `desktop/build/linux-ui-fix-qa/`.

Untested: a non-WSL physical Linux desktop, other distributions, ARM64 Linux and
compositor-specific keep-on-top behavior. These are not implied by the WSLg run.
