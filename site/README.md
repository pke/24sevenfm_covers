# site — website source

Source of the project website. This folder is **not** what gets served — the
release workflow (and `installer\build_artifacts.ps1` locally) renders it into
`www\` (git-ignored), which is the GitHub Pages root. The page is plain static
HTML: no JS-driven content, no framework, no build system beyond token
substitution.

```
├─ index.html      single page with {{TOKEN}} placeholders (see below)
├─ css/style.css   mobile-first; dark by default, light via OS preference
├─ img/            logo/favicon/social artwork + screenshots
└─ shoot.ps1       sets up demo mode + launches the players for hand screenshots
```

## Tokens

`index.html` contains `{{TOKEN}}` placeholders that the render step fills in;
rendering **fails loudly** if any token is left over:

| Token | Value |
|-------|-------|
| `{{VER_WINAMP}}` / `{{VER_FOOBAR}}` / `{{VER_VIEWER}}` | per-module versions from the version headers |
| `{{URL_*}}` (7) | download links — GitHub release assets, or `downloads/…` in a local preview |
| `{{SIZE_*}}` (7) | artifact sizes, measured from the files just built |
| `{{SITE_URL}}` | absolute site base URL for `og:image` (empty locally) |
| `{{UPDATED}}` / `{{RELEASE_TAG}}` | footer "Last updated" line |

## Releasing (CI)

The **Release** workflow (`.github/workflows/release.yml`, run manually from the
Actions tab) provisions the foobar2000 SDK + WTL from their pinned archives
(cached), runs the test gate, builds all three binaries, publishes a GitHub
release tagged `vYYYY.MM.DD-<run>` with all artifacts + `.sha256` sidecars, then
renders this site against those release URLs and deploys it to GitHub Pages.
The site is therefore always exactly in step with the newest release.

## Local preview

```powershell
powershell -File installer\build_artifacts.ps1          # or -Build to recompile first
```

renders the page into `www\index.html` with links pointing at `www\downloads\`
(the locally packaged artifacts) and "local preview" in the footer. Open
`www\index.html` in a browser.

## Screenshots

`img/poster.svg`, `img/fill.svg` and the per-plugin artworks are hand-made
mockups. To replace them with real captures, run **from an interactive desktop
session** (`N`, fullscreen and window capture all need a visible desktop):

```powershell
powershell -File site\shoot.ps1
```

It copies the covers you keep in the repo's `demo\` folder (film-soundtrack art +
`demo.txt`) into `%TEMP%\24seven.fm-covers-demo\`, sets
a screenshot-friendly viewer INI, then launches the viewer, Winamp and
foobar2000. Each app finds that folder and runs in **demo mode** — showing those
covers with no live station — so you can frame and grab the shots by hand (`N`
cycles covers, double-click / `F` for fullscreen). Delete the folder and restart
an app to return to the live station. `-NoLaunch` only (re)builds the folder;
`-Winamp` / `-Foobar` pin host paths if auto-detect misses them.
