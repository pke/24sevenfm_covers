# Packaging / distribution

`build_artifacts.ps1` runs the unit tests, then (only if they pass) regenerates every
distribution file into `..\www\downloads\` (git-ignored) — the website links them directly,
so `www\` is the complete publishable unit and the download links/version labels in
`www\index.html` are rewritten to match. Artifacts are named **`<name>-<version>-<builddate>.<ext>`**
(Eclipse-style, e.g. `-1.0.0-20260710`); the `<ver>`/`<date>` below stand in for that suffix:

| Artifact | For | How the user installs |
|----------|-----|-----------------------|
| `foobar_24sevenfm_covers-<ver>-<date>.fb2k-component` | foobar2000 | Double-click, or Preferences → Components → Install… (native format, ~160 KB) |
| `winamp_24sevenfm_covers-<ver>-<date>.exe` | Winamp | Wizard: auto-detects / browse to folder, validates `winamp.exe`, installs to `Plugins\` (NSIS, ~100 KB) |
| `foobar_24sevenfm_covers-<ver>-<date>.exe` | foobar2000 | Wizard: auto-detects / browse to folder, validates `foobar2000.exe`, installs to `components\` (NSIS, ~100 KB) |
| `foobar_24sevenfm_covers-<ver>-<date>.zip` | foobar2000 | Manual: DLL + `README.txt` (copy into `components\`) |
| `winamp_24sevenfm_covers-<ver>-<date>.zip` | Winamp | Manual: DLL + `README.txt` (copy into `Plugins\`) |
| `<artifact>.sha256` | — | one SHA-256 sidecar per artifact above |

## Regenerate

```powershell
powershell -ExecutionPolicy Bypass -File build_artifacts.ps1
```

- Packages the already-built plugin DLLs (from `..\winamp\build\Release\` and `..\foobar2000\foo_24sevenfm_covers\build\Release\`).
- Add **`-Build`** to rebuild the plugins from source first (needs the VS 2026 CMake + MSBuild).

## Tools

- The **fb2k-component** and **zips** are made with built-in PowerShell (`Compress-Archive`) — no extra tools.
- The **Winamp installer** needs **[NSIS](https://nsis.sourceforge.io)** (`makensis.exe`). If NSIS isn't installed, the script builds everything else and skips just the `setup.exe` (with a warning).

## Verifying checksums

Each artifact has a matching `<artifact>.sha256` sidecar:

```powershell
Get-FileHash .\www\downloads\<file> -Algorithm SHA256    # compare against <file>.sha256
```
or, in Git Bash: `cd www/downloads && sha256sum -c <file>.sha256`

## Source scripts

- `winamp_24sevenfm_covers.nsi` — NSIS installer script (detect / browse / validate).
- `readme-winamp.txt`, `readme-foobar.txt` — the READMEs bundled into the manual-install zips.
