# Packaging / distribution

`build_artifacts.ps1` regenerates every distribution file into `..\dist\`:

| Artifact | For | How the user installs |
|----------|-----|-----------------------|
| `foo_24sevencover.fb2k-component` | foobar2000 | Double-click, or Preferences → Components → Install… (native format, ~160 KB) |
| `24sevenCover-Winamp-Setup.exe` | Winamp | Wizard: auto-detects / browse to folder, validates `winamp.exe`, installs to `Plugins\` (NSIS, ~100 KB) |
| `24sevenCover-foobar2000.zip` | foobar2000 | Manual: DLL + `README.txt` (copy into `components\`) |
| `24sevenCover-Winamp.zip` | Winamp | Manual: DLL + `README.txt` (copy into `Plugins\`) |
| `<artifact>.sha256` | — | one SHA-256 sidecar per artifact above |

## Regenerate

```powershell
powershell -ExecutionPolicy Bypass -File build_artifacts.ps1
```

- Packages the already-built plugin DLLs (from `..\winamp\build\Release\` and `..\foobar2000\foo_24sevencover\build\Release\`).
- Add **`-Build`** to rebuild the plugins from source first (needs the VS 2026 CMake + MSBuild).

## Tools

- The **fb2k-component** and **zips** are made with built-in PowerShell (`Compress-Archive`) — no extra tools.
- The **Winamp installer** needs **[NSIS](https://nsis.sourceforge.io)** (`makensis.exe`). If NSIS isn't installed, the script builds everything else and skips just the `setup.exe` (with a warning).

## Verifying checksums

Each artifact has a matching `<artifact>.sha256` sidecar:

```powershell
Get-FileHash .\dist\<file> -Algorithm SHA256    # compare against <file>.sha256
```
or, in Git Bash: `cd dist && sha256sum -c <file>.sha256`

## Source scripts

- `winamp_24sevencover.nsi` — NSIS installer script (detect / browse / validate).
- `readme-winamp.txt`, `readme-foobar.txt` — the READMEs bundled into the manual-install zips.
