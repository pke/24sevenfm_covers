# 24seven.fm Covers

Cover-art for the **24seven.fm** family of internet radio stations — Streaming Soundtracks,
1980s.FM, Adagio.FM, Death.FM, and Entranced.FM. A shared, host-agnostic C++ engine drives
three Windows front-ends plus a cross-platform core library:

| Component | Directory | Output | Build system |
|-----------|-----------|--------|--------------|
| **Desktop viewer** | `desktop/` | `24sevenfm_covers.exe` (x64, self-contained) | MSBuild (`.vcxproj` / `.sln`) |
| **Winamp plugin** | `winamp/` | `gen_24sevenfm_covers.dll` (x86 / 32-bit) | CMake |
| **foobar2000 component** | `foobar2000/foo_24sevenfm_covers/` | `foo_24sevenfm_covers.dll` (x64) | MSBuild (`.vcxproj`) |
| **Core library** | `lib/` | `coverfetch` static lib (cross-platform) | CMake |

All three front-ends share the same **Direct2D renderer** (`shared/d2d_*.cpp`), the **cover
engine** (`shared/cover_engine.*` — cover preload, crossfade/flip transitions, remaining-time
countdown), the **options page** (`shared/options_*`), and the **networking/parse library**
(`lib/`). The library alone (`lib/`) is portable C++11 and already cross-compiles for Android/iOS.

## Repository layout

```
├─ desktop/          Standalone desktop viewer (24sevenfm_covers.{cpp,rc,vcxproj,sln}, viewer_*)
├─ shared/           Host-agnostic engine, Direct2D renderer (d2d_*), options page, version.h
├─ winamp/           Winamp gen_ plugin (host glue only)
├─ foobar2000/
│   ├─ foo_24sevenfm_covers/   foobar component project + glue
│   ├─ sdk/          foobar2000 SDK      (vendored, git-ignored — see Prerequisites)
│   ├─ wtl/          WTL headers         (vendored, git-ignored)
│   └─ wtl.props     Injects WTL onto the include path at build time
├─ lib/              Cross-platform networking/parse library (+ tests, example)
│   └─ tests/        doctest unit tests
├─ installer/        Packaging: build_artifacts.ps1, NSIS script, readmes
└─ dist/             Generated artifacts (git-ignored)
```

## Prerequisites

- **Visual Studio 2026** (Community is fine) with the **Desktop development with C++** workload,
  which provides the **v145** platform toolset, **CMake**, **MSBuild**, and the **Windows 10 SDK**.
  All commands below assume you run them from a *Developer / x64 Native Tools Command Prompt for
  VS 2026* so `cmake` and `msbuild` are on `PATH`.
- **No external *runtime* dependencies.** Everything links only Windows system DLLs
  (`d2d1`, `windowscodecs` (WIC, via COM), `dwrite`, `ole32`, `winhttp` (HTTPS/TLS), `comctl32`,
  `shell32`, plus `user32`/`gdi32`/`kernel32`). The desktop viewer statically links the C runtime (`/MT`),
  so it needs **no VC++ redistributable**. **Requires Windows 7 or later** (Direct2D/DirectWrite).
- **Only for building the foobar2000 component** — two vendored SDKs (see below).
- **Only for packaging the Winamp installer** — [NSIS](https://nsis.sourceforge.io) (`makensis.exe`).
- **Only for cross-compiling `lib/` to a phone** (optional) — the Android NDK / CMake.

### Vendored dependencies (obtain these once)

These are git-ignored (not committed) and must be placed in the tree before building the parts
that need them:

| Dependency | Put it in | Where to get it | Needed for |
|-----------|-----------|-----------------|------------|
| foobar2000 SDK | `foobar2000/sdk/` | <https://www.foobar2000.org/SDK> | foobar component |
| WTL (Windows Template Library) | `foobar2000/wtl/` | <https://sourceforge.net/projects/wtl/> | foobar component |
| doctest (single header) | `lib/tests/doctest.h` | already vendored | unit tests |

The **Winamp** plugin needs no external SDK — a minimal `winamp/gen.h` is included.

## Building

Open **`desktop\24sevenfm_covers.sln`** in Visual Studio for the desktop viewer, or use the command line:

### Desktop viewer — `24sevenfm_covers.exe` (x64, self-contained)

```bat
msbuild desktop\24sevenfm_covers.vcxproj /p:Configuration=Release /p:Platform=x64
:: -> desktop\build\Release\24sevenfm_covers.exe
```

### Winamp plugin — `gen_24sevenfm_covers.dll` (must be 32-bit; Winamp 5.x is a 32-bit app)

```bat
cmake -S winamp -B winamp\build -A Win32
cmake --build winamp\build --config Release
:: -> winamp\build\Release\gen_24sevenfm_covers.dll
```

### foobar2000 component — `foo_24sevenfm_covers.dll` (x64)

Needs the vendored SDK + WTL (above). The bundled SDK projects target older toolsets
(v142/v143), so override to **v145** and inject WTL onto the include path via `wtl.props`:

```bat
msbuild foobar2000\foo_24sevenfm_covers\foo_24sevenfm_covers.vcxproj ^
  /p:Configuration=Release /p:Platform=x64 ^
  /p:PlatformToolset=v145 ^
  /p:ForceImportAfterCppProps=%CD%\foobar2000\wtl.props
:: -> foobar2000\foo_24sevenfm_covers\build\Release\foo_24sevenfm_covers.dll
```

(`ForceImportAfterCppProps` must be an absolute path; it applies to the referenced SDK libraries too.)

### Core library `lib/` (cross-platform)

```bat
cmake -S lib -B lib\build
cmake --build lib\build --config Release
```

`lib/` builds on Windows (MSVC), and for Android/iOS via CMake toolchain files. On Windows it
uses **WinHTTP** for HTTPS/TLS (linked automatically); other platforms use a plain-socket client
and link `Threads`. A console demo (`coverfetch_example`) builds by default;
disable with `-DCOVERFETCH_BUILD_EXAMPLE=OFF`.

## Tests

Unit tests (doctest) cover the pure logic in `lib/` — cover-URL parsing, the JSON extractor,
chunked-HTTP decode, and the remaining-time math. They are **off by default**; enable and run
via CTest:

```bat
cmake -S lib -B lib\build-tests -A x64 -DCOVERFETCH_BUILD_TESTS=ON
cmake --build lib\build-tests --config Release
ctest --test-dir lib\build-tests -C Release --output-on-failure
```

The other layers (engine, Direct2D, plugins, viewer) are Windows GUI/host code and are verified
by launching the binary and checking its debug log. Each host writes a distinct file so their
logs don't interleave: `%TEMP%\24seven.fm-covers-winamp.log`, `-foobar.log`, and `-viewer.log`.

## Packaging / building the artifacts

One script — `installer\build_artifacts.ps1` — regenerates **every** distributable into a
freshly-cleaned `dist\`. It first runs the `lib/` unit tests and **aborts if any fail**, so a
release is never packaged from an unverified build.

```powershell
# Package the already-built binaries (runs the test gate, then packages):
powershell -ExecutionPolicy Bypass -File installer\build_artifacts.ps1

# Rebuild all three binaries from source first, then package (recommended for a release):
powershell -ExecutionPolicy Bypass -File installer\build_artifacts.ps1 -Build

# Bypass the test gate (packages an unverified build — not recommended):
powershell -ExecutionPolicy Bypass -File installer\build_artifacts.ps1 -SkipTests
```

`-Build` compiles the Winamp plugin (CMake, Win32), the foobar2000 component (MSBuild, x64, with
the `v145` + `wtl.props` overrides above) and the desktop viewer (MSBuild, x64) before packaging.
Without it, the three outputs must already exist under their `build\Release\` folders (the script
errors out naming any that are missing).

Each artifact is named `<name>-<version>-<builddate>.<ext>` and carries **its own module
version** (read from `winamp/gen_version.h`, `foobar2000/foo_24sevenfm_covers/foo_version.h`,
`desktop/viewer_version.h`), so the three front-ends version independently. Every artifact gets a
matching `.sha256` sidecar (`sha256sum -c` format).

| Artifact | Install method |
|----------|----------------|
| `foobar_24sevenfm_covers-<ver>-<date>.fb2k-component` | native foobar package — double-click to install |
| `winamp_24sevenfm_covers-<ver>-<date>.exe` | Winamp NSIS installer |
| `foobar_24sevenfm_covers-<ver>-<date>.exe` | foobar NSIS installer |
| `viewer_24sevenfm_covers-<ver>-<date>.exe` | desktop viewer NSIS installer |
| `winamp_…zip` / `foobar_…zip` / `viewer_…zip` | manual-install zips (binary + README) |

The three **NSIS installers** need [`makensis`](https://nsis.sourceforge.io) on `PATH` (or in the
default `Program Files` location); if it's absent the script skips just those three with a warning
and still produces the `.fb2k-component` and the zips. See [installer/README.md](installer/README.md)
for details.

## Versioning

The version and copyright/homepage are single-sourced in [`shared/version.h`](shared/version.h)
(`SSC_VER_*`, `SSC_COMPANY`, `SSC_COPYRIGHT`, `SSC_WEB`) and flow into every binary's `VERSIONINFO`,
the About screens, and the NSIS installer (via `build_artifacts.ps1`). A git hook
(`.githooks/post-commit`, enable with `git config core.hooksPath .githooks`) auto-bumps the version
from [Conventional Commits](https://www.conventionalcommits.org) — `fix:` → patch, `feat:` → minor,
`feat!`/`BREAKING CHANGE` → major.

## Security

Network responses (the JSON feed, the `CoverLink` URL, and cover images) are
treated as untrusted. On Windows all requests go over **HTTPS/TLS via WinHTTP**;
`CoverLink` is host-pinned to the station and rejected on control bytes (SSRF /
request-injection guards); responses are size-capped. See [SECURITY.md](SECURITY.md)
for the threat model, mitigations, and the two tracked open items (untrusted WIC
image decode; cleartext transport on non-Windows until native TLS lands).

## Runtime notes

- **Stations.** All five 24seven.fm stations share one API (`/soap/FM24sevenJSON.php`), each on
  its own host, so the same code serves any of them (`shared/stations.h`). The **plugins
  auto-follow** whichever family stream the player is tuned to — detected from the stream URL
  (`hi5.death.fm`, …) — and switch covers automatically. The **desktop viewer** has no player, so
  it exposes a *Station* tab in *Options…* to pick one (persisted per station id).
- The remaining-time **countdown** and cover **transitions** are configurable; the countdown
  overlay defaults to **off** — enable it in each host's options (Winamp: Prefs → Plug-ins →
  General Purpose → Configure; foobar: Preferences → Display; viewer: window system-menu or
  right-click → *Options…*).
- The station server is slow and drops connections under load; the library uses IPv4-only
  connects (an unroutable IPv6 AAAA record otherwise stalls the first request) and exponential
  backoff. Don't run two front-ends against the station at once — they share a log and double the
  server load.
