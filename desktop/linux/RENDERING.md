# Linux renderer comparison

The production viewer defaults to QWidget/QPainter; its Linux-only Renderer
settings tab selects the same GPU paths after restart. Opt-in benchmark executables
share `Stage::drawScene`, resource decoding, text measurement and the shared
PresentationController. No second layout or animation engine is introduced.

## Build

Use one Qt **6.7 or newer** installation for all three binaries (tested with
Qt 6.8.3); QRhiWidget is unavailable in Ubuntu 24.04's stock Qt 6.4. The regular
viewer still supports the existing Qt 6.2+ build. The optional comparison also
requires OpenGLWidgets, ShaderTools/qsb, Qt's GuiPrivate development headers,
Vulkan headers, and xkbcommon development headers.

```sh
cmake -S desktop/linux -B "$HOME/24sevenfm-render-build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DSSC_RENDER_BENCHMARKS=ON \
  -DCMAKE_PREFIX_PATH=/path/to/Qt/6.8.3/gcc_64
cmake --build "$HOME/24sevenfm-render-build" --parallel 4
python3 desktop/linux/benchmark_renderers.py \
  --build "$HOME/24sevenfm-render-build" \
  --output "$HOME/24sevenfm-render-results" --runs 3 --warmup 3 --seconds 8
```

Run inside the same Wayland session with no other builds or CPU-intensive work.
The script forces `QT_QPA_PLATFORM=wayland`, runs candidates sequentially,
rotates renderer order across repetitions, and records crashed candidates in
`failures.json`. Collection continues so one backend cannot hide the others.
Every measurement carries `exitCode`; `successful_exits` distinguishes stable
runs from data written before a teardown crash. Nonzero-exit measurements are
diagnostic only. `status.json` reports `allProcessesPassed` independently of
whether collection completed. No failed renderer is replaced with raster or offscreen.
The summary excludes failed processes, and the script exits nonzero if any fail.

After verifying the actual Qt OpenGL context and the hypervisor's host GPU,
a VM with hardware OpenGL but only software Vulkan can use this explicit subset:

```sh
SSC_REQUIRE_HARDWARE=1 python3 desktop/linux/benchmark_renderers.py \
  --build "$HOME/24sevenfm-render-build" \
  --output "$HOME/24sevenfm-render-results-hardware" \
  --runs 3 --warmup 3 --seconds 8 \
  --renderers raster opengl opengl-direct rhi-opengl
```

Record the unavailable Vulkan device separately. Omitting it is not a Vulkan
success or a silent API fallback; `status.json` lists the selected paths.

## Paths and interpretation

* `render_bench_raster`: the existing QWidget backing-store raster path.
* `render_bench_opengl`: QPainter drawing directly into QOpenGLWidget by
  default. Its OpenGL paint engine can differ in antialiasing, glyphs and image
  sampling; screenshot comparisons quantify this, rather than assuming parity.
* `SSC_GL_EXACT=1 render_bench_opengl`: identical QPainter raster image, then
  an OpenGL texture draw. This explicitly **hybrid** path preserves exact pixels;
  it does not accelerate the original scene's rasterization.
* `render_bench_rhi`: QRhiWidget, with a QPainter raster image uploaded and drawn
  by a textured quad. This is also explicitly **hybrid**, not a native RHI vector
  or glyph renderer. `SSC_RHI_BACKEND=vulkan` (default) or `opengl` selects the API
  before the window is created. A Vulkan failure aborts, rather than retrying GL.

All candidates run idle (including the real feed's once-per-second hidden
countdown), visible rolling countdown/Coming Next, cover+metadata changes,
and sinusoidal window resize. Images and metadata are deterministic; network
acquisition is excluded. Timed measurements use 680x820 logical pixels at DPR 1
except the resize scenario. Screenshot runs additionally use DPR 1.5.
For timed fractional scaling, repeat with a fresh output directory and
`--scale 1.5 --scenarios resize`. These options leave the common scene and
measurement procedure unchanged.

CPU percentage is process user+system CPU divided by wall time, with **100% =
one CPU core**; software graphics-driver worker threads are included. Paint
counts and callback elapsed durations include QPainter destruction/flush; RHI
includes rasterization, upload recording and draw command recording. The
RHI callback ends before QRhiWidget's later submission/composition work; that
work can affect paint cadence without appearing in the callback duration.
The legacy
JSON field `renderCpuMs` uses QElapsedTimer: it is wall-clock time spent inside
the render callback (including waits), not per-thread CPU accounting. p95 uses
the nearest-rank percentile. The CSV averages per-run p95 values (not a pooled
percentile). Paint intervals measure callback completion cadence and include
intentional idle gaps; they are **not** GPU execution time, compositor display
latency or missed-vsync measurements. No frames are forced solely to populate
idle timing statistics: zero paints means timing values are null.

The CSV also retains actual measured elapsed time (mean/min/max) and paints per
second. A virtual machine or host can stall far beyond the requested duration;
inspect these values before interpreting CPU percentages, and treat stalled
runs as diagnostic. Lower CPU accompanied by fewer delivered paints is not by
itself an improvement.

Each candidate logs its actual device/backend. OpenGL records GL_VENDOR,
GL_RENDERER and GL_VERSION; RHI records QRhi::backend and QRhiDriverInfo, with
`QT_LOGGING_RULES=qt.rhi.general=true` providing Vulkan driver/device detail.
`SSC_REQUIRE_HARDWARE=1` rejects recognized software renderers and CPU devices.
Also retain `vulkaninfo --summary`, `glxinfo -B`, WSLg versions and Windows GPU
information. A `/dev/dxg` node or a GPU in Windows is not evidence that the Linux
process uses it. GPU utilization/time are null when no validated per-process
hardware counter is available. No estimate is passed off as GPU time.

## Regression and screenshots

```sh
ctest --test-dir "$HOME/24sevenfm-render-build" --output-on-failure
QT_QPA_PLATFORM=wayland "$HOME/24sevenfm-render-build/linux_adapter_tests"
QT_QPA_PLATFORM=wayland SSC_RHI_BACKEND=vulkan \
  "$HOME/24sevenfm-render-build/render_bench_rhi" --visual /tmp/24seven-rhi-images
```

The visual mode captures the actual QWidget or GPU framebuffer and a native
QWidget raster reference of the same immutable frame. The upload paths reuse a
hidden QWidget calling the same `drawScene`, then convert its capture to RGBA.
Painting directly into QImage or QPixmap changed text pixels under WSLg, even
with matching format and DPI. The hidden QWidget preserves the baseline's
native text rendering; the regression test compares it against a visible Stage.
It covers poster, Coming Next/countdown,
rolling digits, interrupted cover/metadata transition, fill and resize. Logs
include mean absolute RGB error and differing pixel count. Screenshots and
readbacks run **outside** the timed benchmark. Shared and Linux regression tests
assert that hidden countdown updates do not flag animation, measure text or
paint, while the visible entrance/exit fade continues to animate.
