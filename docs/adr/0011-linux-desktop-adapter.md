# Linux desktop adapter

Date: 2026-10-04. Status: implemented.

The available Linux environment is Ubuntu 24.04 x86-64 under WSL2 with WSLg.
Use Qt 6 Widgets/QPainter for native window/input handling, text measurement,
image resources, settings and rendering. It runs on Wayland, X11 and Qt's
offscreen test platform. QPainter uses a raster backing store; the host avoids
repainting and measuring text while the retained frame is idle. Native Linux
performance has not been benchmarked against WSLg. Optional comparison binaries
use the same Stage and controller with QOpenGLWidget and QRhiWidget targets;
see [renderer comparison](../../desktop/linux/RENDERING.md). The production
renderer remains raster. There is no second scene/animation policy.

The data flow is unchanged:

`CoverMonitor -> TrackInfo/MediaRequest -> PresentationPipeline/MediaPreparation
-> PreparedPresentation -> PresentationController -> FrameState -> Stage`

The existing portable worker remains compiled and regression-tested; the Linux
host uses the complete-frame scheduler, like AppKit. Qt callbacks marshal feed
and pipeline publications to the UI thread. Each callback validates session
identity and pipeline generation. Countdown ticks validate track identity.
Station switches cancel old pipelines and join their workers away from the UI
thread; destruction joins remaining work before the receiver is destroyed.

The Linux host delegates media policy, provider ordering, trusted URLs, credits,
normalization, cache keys, queue prefetch and all presentation timelines to the
existing shared components. Drawing reads `FrameState` without advancing time.
Coming Next measures final untrimmed text and consumes
extCoverLayout`.
Title logos use visible alpha bounds and the common `titleLogoSize`/`titleLogoRect`
policy, replacing the album row. That policy halves the full logo-to-composer
clearance, including panel padding and line spacing, in all native hosts.
Countdown uses the existing `ViewportRelative` sizing policy. No changes were
made to these shared state machines for the port.

Linux previously used a plain socket HTTP transport and a signature-only image
probe. `SSC_LINUX_NATIVE` selects libcurl with system TLS trust, no automatic
redirects, cancellation, timeout and a 16 MiB cap, plus GdkPixbuf's full decoder
with pre-allocation dimension limits. Dependencies and source files are selected
only for `CMAKE_SYSTEM_NAME=Linux`, leaving the Apple/Windows/mobile branches
intact. Qt separately checks dimensions before creating draw resources.

Qt settings remain independent of Windows/macOS storage. Test preferences are
temporary. Native platform differences, dependency/package instructions and
reproducible checks are in [desktop/linux/README.md](../../desktop/linux/README.md).
