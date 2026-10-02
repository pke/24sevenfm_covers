# Packaging / distribution

`build_artifacts.ps1` runs the unit tests, then (only if they pass) regenerates every
distribution file into `..\www\downloads\` (git-ignored) and renders the website from
`..\site\` into `..\www\` (token substitution; local preview links to `downloads\`, a
`-ReleaseTag` build links to that GitHub release's assets — used by the local publisher).
Artifacts are named **`<name>-<version>-<builddate>.<ext>`**
(Eclipse-style, e.g. `-1.0.0-20260710`); the `<ver>`/`<date>` below stand in for that suffix:

| Artifact | For | How the user installs |
|----------|-----|-----------------------|
| `foobar_24sevenfm_covers-<ver>-<date>.fb2k-component` | foobar2000 | Double-click, or Preferences → Components → Install… (native format, ~160 KB) |
| `winamp_24sevenfm_covers-<ver>-<date>.exe` | Winamp | Wizard: auto-detects / browse to folder, validates `winamp.exe`, installs to `Plugins\` (NSIS, ~100 KB) |
| `foobar_24sevenfm_covers-<ver>-<date>.exe` | foobar2000 | Wizard: auto-detects / browse to folder, validates `foobar2000.exe`, installs to `components\` (NSIS, ~100 KB) |
| `foobar_24sevenfm_covers-<ver>-<date>.zip` | foobar2000 | Manual: DLL + `README.txt` (copy into `components\`) |
| `winamp_24sevenfm_covers-<ver>-<date>.zip` | Winamp | Manual: DLL + `README.txt` (copy into `Plugins\`) |
| `viewer_24sevenfm_covers-<ver>-<date>.exe` | DV | Desktop viewer installer |
| `viewer_24sevenfm_covers-<ver>-<date>.zip` | DV | Extract the viewer EXE and `README.txt` |
| `<artifact>.sha256` | — | one SHA-256 sidecar per artifact above |

## Regenerate

```powershell
powershell -ExecutionPolicy Bypass -File build_artifacts.ps1 -Build
```

- Packages the already-built plugin DLLs (from `..\winamp\build\Release\` and `..\foobar2000\foo_24sevenfm_covers\build\Release\`).
- Add **`-Build`** to rebuild both plugins and DV from source first (needs VS 2026 CMake + MSBuild).
- Native Release builds omit the debug overlay, histories, response capture and
  file logging. Add **`-Build -EnableDebugOverlay`** for a troubleshooting build.
  This sets `SSC_ENABLE_DEBUG_OVERLAY=1` consistently in all three native hosts;
  a normal `-Build` sets it to `0`. The web diagnostics panel is unaffected.
- All three native builds pack their EXE/DLL with pinned, checksum-verified UPX
  after linking. Packaging verifies packing again before signing, including
  unsigned CI builds. Unpacked binaries/maps remain beside each output in
  `unpacked/`. See the main [README](../README.md#building) for the build order.

## Code signing with Certum SimplySign

Signing is enabled by default. `signing.json` contains the public certificate thumbprint
and Certum's RFC 3161 timestamp URL. It contains no passwords, PINs, or private keys.
Before a signed build, connect SimplySign Desktop using the token from the phone app.
The certificate must be registered in the current user's Personal certificate store.
Run the build in that same Windows user account.

The script signs DV and both plugin binaries using SHA-256, then packages them. NSIS
signs and verifies each embedded uninstaller before embedding it; all three finished
installer EXEs are signed afterward. Every signature must be trusted, timestamped,
and match the configured publisher. Checksum generation runs last. Any signing,
timestamping, or verification failure stops the build without an unsigned fallback.

`-SigningThumbprint`, `-TimestampUrl`, and `-SignToolPath` override the public configuration
or SDK tool discovery. `-Unsigned` is an explicit development/CI option; these artifacts
cannot pass the release publication gate. Signed packaging requires NSIS and PowerShell 7,
which NSIS uses to run the uninstaller signer in a separate process.

If SignTool reports no matching certificate despite the certificate being visible,
connect/reconnect SimplySign Desktop first. If Windows cannot load `SimplySign KSP`,
repair the Certum installation as administrator and reconnect after any required restart.
Do not generate a replacement private key or try to make a PFX from the public certificate.

## Local release and website deployment

Commit and push the intended changes, then authenticate SimplySign Desktop and GitHub CLI
(`gh auth login`). From the repository root:

```powershell
# Build, sign, verify all downloads, and prepare notes without uploading.
./installer/publish_release.ps1

# Rebuild from the clean checkout, verify, upload a draft, then publish it.
./installer/publish_release.ps1 -Publish
```

The publisher requires a clean working tree and a commit already available on GitHub.
It builds all native apps, runs tests, and independently checks all seven artifacts,
their sidecars, installer signatures, and the signed payload inside every archive.
The default tag is `vYYYY.MM.DD-HHmmssfff`; `-Tag` can provide another numeric suffix.
`-Repo` and `-SiteUrl` can override the repository and website destination.

GitHub's **Native release build** workflow only validates development builds; it does
not publish unsigned releases. Publishing locally triggers **Deploy site** through the
`release: published` event. Use your local GitHub CLI login; a workflow `GITHUB_TOKEN`
does not trigger another workflow through release events. Existing site-only deployment
still uses the latest published release. Older downloads remain as originally published.

To recheck downloads without cloud-key access:

```powershell
./installer/verify_artifacts.ps1
```

The signer shown by Windows is **Open Source Developer Philipp Kursawe**. Signing identifies
the publisher and protects file integrity; it does not guarantee SmartScreen reputation.

## Native binary size analysis

Linker maps are optional and do not add bytes to the distributed binaries. Enable
`-DSSC_LINK_MAP=ON` when configuring the Winamp CMake build, or pass
`/p:SSCLinkMap=true` to the viewer/foobar MSBuild commands. Each map is written
beside its release binary. Keep the map and binary from the same link operation.

Copy the three binaries and their maps into a single analysis folder, then run:

```powershell
./installer/analyze_native_size.ps1 -InputDirectory <folder> -OutputDirectory <report-folder>
```

This writes `analysis.json`, a CSV of code symbols for each module, and import CSVs.
It reads PE sections and certificate sizes, checks the map's timestamp against the
binary, and groups surviving code by object, runtime library, and STL template family.
Code spans inferred from maps include alignment and any unnamed code before the next
symbol. Folded aliases share one span; application spans can include inlined STL code.
Treat these groups as attribution estimates, not predicted savings from deleting a class.

## Tools

- The **fb2k-component** and **zips** are made with built-in PowerShell (`Compress-Archive`) — no extra tools.
- All three installers need **[NSIS](https://nsis.sourceforge.io)** (`makensis.exe`). Missing NSIS stops signed packaging; `-Unsigned` development builds can skip installers.

## Verifying checksums

Each artifact has a matching `<artifact>.sha256` sidecar:

```powershell
Get-FileHash .\www\downloads\<file> -Algorithm SHA256    # compare against <file>.sha256
```
or, in Git Bash: `cd www/downloads && sha256sum -c <file>.sha256`

## Source scripts

- `winamp_24sevenfm_covers.nsi` — NSIS installer script (detect / browse / validate).
- `readme-winamp.txt`, `readme-foobar.txt` — the READMEs bundled into the manual-install zips.
