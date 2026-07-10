# gen_24sevenfm_covers — Winamp 5.x cover-art panel

A Winamp 5.x **general-purpose plugin** that shows the cover art of the track
currently playing on **Streaming Soundtracks (24seven.fm)** in a dockable window.
It reuses the cross-platform `ssc::CoverMonitor` library (`../lib`) to watch the
station's "now playing" feed, downloads the cover over HTTP, and renders it with
**Direct2D** (GPU-accelerated), including crossfade/flip transitions and a
countdown overlay.

> A visualization (`vis_`) plugin was tried first, but Winamp calls vis plugins
> on a background thread, so their window can never dock. A general-purpose
> plugin's `init()` runs on Winamp's UI thread, which is what lets the gen_ff
> embed frame dock/snap. That's why this is a `gen_` plugin.

## Build (must be 32-bit — Winamp 5.x is a 32-bit app)

```powershell
cmake -S winamp -B winamp/build -A Win32
cmake --build winamp/build --config Release
```

Output: `winamp/build/Release/gen_24sevenfm_covers.dll` (x86).

> Configuring without `-A Win32` yields a 64-bit DLL that Winamp ignores; CMake
> prints a warning in that case.

The DLL is **self-contained**: the C runtime is statically linked (`/MT`), so it
needs no VC++ redistributable. It depends only on system DLLs
(`d2d1, dwrite, ole32, ws2_32, comctl32, user32, gdi32, kernel32`) plus WIC,
which is loaded on demand via COM.

**Requires Windows 7 or later** (Direct2D / DirectWrite). There is no software
fallback — on a system without Direct2D the window stays blank (the log notes
`Direct2D init FAILED`); the rest of the plugin still runs.

## Install

1. Copy `gen_24sevenfm_covers.dll` into Winamp's `Plugins` folder.
2. Relaunch Winamp — general-purpose plugins load automatically at startup (no
   "Start" step).
3. Play the station (Ctrl+L → `http://streamingsoundtracks.com/listen.pls`). The
   cover window appears while tuned in and hides otherwise. Drag it by the frame
   title bar to dock/move it like any Winamp window.

## Options

**Ctrl+P → Plug-ins → General Purpose → 24seven.fm Covers → Configure:**

- **Show remaining time overlay** — a live `m:ss` countdown in the top-right corner.
- **Animate the countdown digits** — roll changed digits over (odometer style); off = instant updates.
- **Transition** — how one cover gives way to the next: *None* (instant cut),
  *Crossfade* (GPU alpha-blend), *Flip horizontal*, or *Flip vertical* (a card flip
  where the new cover is the "backside" of the old one).
- **Duration** — transition length, 500 ms–2 s in 100 ms steps (ignored for *None*).

Settings persist to `24seven.fm-covers.ini` in Winamp's settings directory.

## How it works

| Piece | Role |
|-------|------|
| `winampGetGeneralPurposePlugin` | entry point Winamp calls to discover the plugin |
| `init` (UI thread) | creates the gen_ff embed frame + child window, starts Direct2D, starts `ssc::CoverMonitor` |
| monitor callbacks | (library's own thread) download the new cover; a per-second tick feeds the countdown |
| `d2d_renderer` | WIC decodes the JPEG → Direct2D draws it (GPU bilinear scaling); DirectWrite draws the overlay |
| `d2d_transitions` | the cover-to-cover effects (crossfade / flip), given the two bitmaps + a 0–1 progress |
| `WM_TIMER` | gating (show/hide vs. the stream) + drives the transition animation |
| `quit` | stops the monitor, tears down the window and Direct2D |

Networking needs no TLS — the station serves the JSON feed and images over plain
HTTP:80.

## Files

| File | Role |
|------|------|
| `gen_24sevenfm_covers.cpp` | the plugin: window, embedding, gating, options dialog |
| `gen.h` | minimal Winamp general-purpose plugin SDK struct |
| `gen_24sevenfm_covers.rc`, `gen_resource.h` | the options dialog |
| `CMakeLists.txt` | 32-bit, static-CRT, size-optimized build |

The Direct2D renderer (`d2d_renderer.{h,cpp}`, `d2d_transitions.*`, `d2d_rolldigits.*`) and the
cover engine now live in `../shared/` — they are compiled into all three front-ends.

Runtime log (for troubleshooting): `%TEMP%\24seven.fm-covers.log`.
