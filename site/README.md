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

The movie/TV/game-backdrop, DE/US-rating, cover-tint and album-credit resolvers are served by the
Vercel project at the repository root. The media features share `api/backdrop.js`; the
rating resolver returns exact Wikimedia Commons SVG URLs for FSK, MPA movie, and US TV
Parental Guidelines badges, with the text badge retained as the image-load fallback.
Available US TV content descriptors appear with their meanings on hover and keyboard
focus (`D` dialogue, `L` language, `S` sexual situations, `V` violence, and `FV`
fantasy violence).
Cover tint uses `api/tint.js`; missing queued `Artist` values use the allowlisted
`api/credit.js` album-page fallback. Their deployment, security
limits and environment variables are documented in `docs/vercel-backdrop.md`.
`player.html` uses `/api/backdrop`, `/api/tint`, and `/api/credit`, so a GitHub Pages deployment
needs absolute Vercel Function URLs in all three API meta tags or a same-domain proxy
for those paths.

## Local preview

For the interactive web player, start the static site and a persistent local Node API
together. The site stays on port 8099; the API runs separately on port 3000 and
allows only that local site origin. Production still deploys the same handlers as
Vercel Functions; the lightweight local adapter avoids rebuilding a Function worker
for every preview request. The script keeps both servers running until Ctrl+C:

```powershell
pwsh -File start_test_server.ps1
```

The launcher enables structured backdrop-provider timing by default. Each run keeps
`stdout.log` and `stderr.log` in a new session directory below `.vercel/logs/`; the
exact path is printed after startup. Pass `-NoApiDebug` to disable it (the former
`-NoVercelDebug` name remains an alias). Local API responses use `Cache-Control:
no-store`, so a browser cannot retain results across resolver edits.

On `localhost`, every completed backdrop request also writes `[backdrop resolver]`
to the browser console. Expanding the logged object shows the album, track, artist,
provider configuration and the resolver's raw JSON result, including successful
misses. Credentials and the request URL are deliberately omitted. Deployed players
do not emit this diagnostic log.

When the launcher runs inside a Codex task, it also binds a local title
backchannel to that task and prints a one-run pairing code. Click the current title
in the player, enter the code once, and the player queues its current metadata,
provider order, visible backdrop state and sanitized resolver result into the same
task. The queued request asks Codex to diagnose the case, add a regression fix when
one is justified, run the relevant tests, and then commit and push only a tested
change. A genuine provider miss remains a diagnosis rather than fabricated artwork.

The pairing code lives only in the API process and the browser tab's
`sessionStorage`; the browser never receives the Codex task ID or login. Both the
page and API origin must be loopback addresses, and the API continues to listen on
`127.0.0.1` only. Outside a Codex-launched shell, pass an explicit task UUID with
`-BackchannelThreadId`; pass `-NoBackchannel` to disable the feature entirely.
Deployed players never attach the title action and have no backchannel endpoint.

For deterministic metadata and rating previews, `previewAlbum` replaces the local
player's now-playing item; `previewTrack` and `previewArtist` are optional. These
parameters are inert outside `localhost`, `127.0.0.1`, and `::1`. The fixture does
not poll the station's now-playing or queue endpoints, while audio continues to use
the selected station's real stream. For example:

```text
http://localhost:8099/player.html?preset=1&station=sst&sstRatings=1&sstRatingCountries=US&previewAlbum=Family%20Guy&previewTrack=Main%20Title&previewArtist=Walter%20Murphy
```

### Player query parameters

`preset=1` makes the URL a complete, shareable configuration: the player starts
from its defaults and applies the other preset parameters instead of loading saved
browser settings. Without it, only `station`, `posterBlur`, and `borderRadius` are
read. The player normalizes its address bar to `preset=1` after loading, preserves
unrecognized parameters such as campaign tags, and never accepts `fanartKey` from
the URL.

| Parameter | Values | Effect |
|---|---|---|
| `preset` | `1` | Treat the URL as a complete settings preset. Required for the preset parameters below. |
| `station` | `sst`, `1980s`, `adagio`, `death`, `entranced` | Select the station. Also works without `preset=1`. |
| `layout` | `poster`, `fill` | Select the player layout. |
| `transition` | `none`, `crossfade`, `flipHorizontal`, `flipVertical` | Select or disable cover/content transitions. |
| `fade` | `500`–`2000` | Transition duration in milliseconds; out-of-range values are clamped. |
| `remaining` | `countdown`, `rolldown` | Enable and select the remaining-time display. |
| `remainingSize` | `small`, `medium`, `large` | Set the remaining-time size. |
| `comingNext` | `0`, `1` | Disable or enable the upcoming-track display. |
| `volume` | `0`–`1` | Set audio volume; out-of-range values are clamped. |
| `milkdrop` | `auto`, `aurora`, `mandala`, `tunnel` | Enable Milkdrop and select its preset. |
| `laser` | `0`, `1` | Disable or enable the 1980s.FM laser visualization. |
| `strobe` | `0`, `1` | Disable or enable laser strobe accents. |
| `smoke` | `0`, `1` | Disable or enable laser smoke. |
| `bpm` | `0`, `1` | Disable or enable the BPM display. |
| `analyzer` | `spectrum`, `oscilloscope` | Enable and select the audio analyzer. |
| `bars` | `8`–`64` | Set the spectrum bar count; out-of-range values are clamped. |
| `color` | `tinted`, `legacy` | Select the spectrum color mode. |
| `scope` | `line`, `dots`, `filled` | Select the oscilloscope style. |
| `sstBackdrops` | `0`, `1` | Disable or enable SST screen artwork. |
| `sstBackdropProviders` | comma-separated `fanart`, `tmdb`, `steamgriddb` | Select and order artwork providers. |
| `sstBackdropCover` | `show`, `hide` | Keep or hide the soundtrack cover when screen artwork is visible. |
| `sstRatings` | `0`, `1` | Disable or enable SST age ratings. |
| `sstRatingCountries` | comma-separated `DE`, `US` | Select rating countries. |
| `blur` | `0`–`200` | Set poster-background blur. Preset form of `posterBlur`. |
| `radius` | `0`–`500` | Set poster corner radius in thousandths of the cover side. Preset form of `borderRadius`. |

The compatibility parameters `posterBlur` (`0`–`200`) and `borderRadius`
(`0`–`500`) work on an ordinary URL without `preset=1`; URL normalization rewrites
them to `blur` and `radius`.

These visual-QA parameters work only on `localhost`, `127.0.0.1`, and `::1`:

| Parameter | Values | Effect |
|---|---|---|
| `previewAlbum` | text, max. 160 characters | Activate local now-playing preview and set its album or screen title. |
| `previewTrack` | text, max. 300 characters | Optionally set the preview track title. |
| `previewArtist` | text, max. 160 characters | Optionally set the preview artist/composer. |
| `simulateStationFailure` | presence flag | Force the station retry/outage state, regardless of its value. |

The local site server watches `site\` recursively. After a short debounce, every
source edit is rendered into `www\` automatically. The Node API separately watches
its loaded `api\` modules and restarts itself when resolver code changes.

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
