# site — website source

Source of the project website. This folder is **not** what gets served — the
release workflow (and `installer\build_artifacts.ps1` locally) renders it into
`www\` (git-ignored), which is the GitHub Pages root. The page is plain static
HTML: no JS-driven content, no framework, no build system beyond token
substitution.

```
├─ index.html      landing page with {{TOKEN}} placeholders (see below)
├─ privacy.html    privacy policy (linked from every footer)
├─ code-signing.html  why the downloads are unsigned + how to verify them
├─ css/style.css   mobile-first; dark by default, light via OS preference
├─ img/            logo/favicon/social artwork + screenshots
└─ shoot.ps1       sets up demo mode + launches the players for hand screenshots
```

Every `*.html` in this folder is rendered to `www\` — adding a page needs no build
change.

## Tokens

The pages contain `{{TOKEN}}` placeholders that the render step fills in;
rendering **fails loudly** if any token is left over:

| Token | Value |
|-------|-------|
| `{{VER_WINAMP}}` / `{{VER_FOOBAR}}` / `{{VER_VIEWER}}` | per-module versions from the version headers |
| `{{VER_*}}` (3) | per-module versions, parsed from the artifact filenames |
| `{{URL_*}}` (7) | download links — GitHub release assets, or `downloads/…` in a local preview |
| `{{SIZE_*}}` (7) | artifact sizes, from the release assets (or the files just built) |
| `{{SITE_URL}}` | absolute site base URL for `og:image` (empty locally) |
| `{{UPDATED}}` / `{{RELEASE_TAG}}` | footer "Last updated" line |

## Rendering

`installer\render_site.ps1` is the **only** renderer, and it takes the artifact list
as input rather than reading the filesystem. That one seam is what lets the site
ship two ways:

| Caller | Artifact list from | Result |
|--------|--------------------|--------|
| `build_artifacts.ps1` | the files it just packaged into `www\downloads` | local preview, or a release build |
| `deploy-site.yml` | the newest GitHub release's assets (API) | site-only deploy, no build |

Versions come from the artifact **filenames**, never the version headers: the page
must advertise what is actually downloadable. After a version bump the headers run
ahead of the newest release, so a site-only deploy that trusted them would offer a
version that 404s.

## Deploying

Two workflows, both ending in a GitHub Pages deploy:

- **Deploy site** (`.github/workflows/deploy-site.yml`) — runs on any push touching
  `site\`, and on demand. Reads the newest release's assets and renders against
  them. No MSBuild, no NSIS, no new release: a typo fix is live in seconds. This is
  the normal way to change the site.
- **Release** (`.github/workflows/release.yml`, manual) — runs the test gate, builds
  all three binaries from the vendored SDK, publishes a release tagged
  `vYYYY.MM.DD-<run>` with every artifact + `.sha256` sidecar, then renders and
  deploys the site against that new release.

Both use the same renderer, so they cannot drift. The site tracks the newest
release either way.

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
