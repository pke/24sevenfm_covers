# site — website source

Source of the project website. This folder is **not** what gets served — the
release workflow (and `installer\build_artifacts.ps1` locally) renders it into
`www\` (git-ignored), which is the GitHub Pages root. The page is plain static
HTML: no JS-driven content, no framework, no build system beyond token
substitution and build-time partial expansion.

```
├─ index.html      landing page with {{TOKEN}} placeholders (see below)
├─ player.html     web player: live covers + optional audio, all in the browser
├─ privacy.html    privacy policy (linked from every footer)
├─ _partials/      shared HTML inserted by render_site.ps1
├─ css/style.css   mobile-first; dark by default, light via OS preference
├─ css/player.css  player-page styles (stage, layouts, transitions, controls)
├─ js/theme.js     shared optional persistence for the CSS-first theme toggle
├─ js/player.js    the web-player engine
├─ img/            logo/favicon/social artwork + screenshots
├─ tests/          Playwright canary for the DEPLOYED player (daily + after each
│                  deploy via .github/workflows/player-canary.yml; not shipped)
├─ humans.txt      credits (humanstxt.org convention; token-stamped like robots.txt)
└─ shoot.ps1       sets up demo mode + launches the players for hand screenshots
```

Every `*.html` in this folder is rendered to `www\` — adding a page needs no build
change.

## Partials

Shared markup lives in `_partials\*.html` and is included at render time with
`{{> name}}`; for example, `{{> theme-toggle}}` reads
`_partials\theme-toggle.html`. Subdirectories and recursive includes are supported.
Missing partials, malformed directives, and include cycles fail the render. Partials
may contain the release tokens documented below and are never published separately.

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

The movie/TV/game-backdrop, DE/US-rating and cover-tint resolvers are served by the
Vercel project at the repository root. The media features share `api/backdrop.js`; the
rating resolver returns exact Wikimedia Commons SVG URLs for FSK and MPA movie badges.
Cover tint uses `api/tint.js`. Their deployment, security
limits and environment variables are documented in `docs/vercel-backdrop.md`.
`player.html` uses `/api/backdrop` and `/api/tint`, so a GitHub Pages deployment
needs absolute Vercel Function URLs in both API meta tags or a same-domain proxy
for those paths.

## Local preview

For the interactive web player, start the static site and the Vercel Functions
together. The site stays on port 8099; the API runs separately on port 3000 and
allows only that local site origin. The script uses an installed `vercel` CLI or
falls back to `pnpm dlx`/`npx`, then keeps both servers running until Ctrl+C:

```powershell
pwsh -File start_test_server.ps1
```

The local site server watches `site\` recursively. After a short debounce, every
source edit is rendered into `www\` automatically; reloading port 8099 therefore
always uses the latest source without restarting either server.

Only generated `www\player.html` points at the local API. The committed template
and every deployment continue to use `https://24covers-api.vercel.app`.

Run the deterministic browser tests separately from `site\tests`:

```powershell
npm run test:local
```

The test runner renders into a unique temporary directory and binds two dynamically
allocated loopback ports for the player and sandbox fixture. It never writes to `www\`
or uses the development ports 8099 and 3000, so it cannot alter a running preview.

To package the native downloads as well, run:

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
