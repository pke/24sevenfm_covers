# Vercel artwork resolvers

ADR 0001 is implemented by `api/backdrop.js` and `api/tint.js`. Vercel discovers
both as Node.js Functions and installs the root `package.json`. The backdrop API
returns a selected CDN URL and RGB tint; the tint API downloads a bounded station
cover on cache miss and returns only its RGB tint. Neither endpoint proxies image
bytes to the browser.

## Project settings

Set the Vercel project's Root Directory to the repository root and add these
environment variables for Production (and Preview when needed):

| Variable | Required | Purpose |
|---|---:|---|
| `TMDB_API_KEY` | one TMDB credential | TMDB v3 application key; a legacy v4 token stored under this name is auto-detected |
| `TMDB_READ_TOKEN` | one TMDB credential | alternative v4 Read Access Token |
| `FANART_API_KEY` | recommended | fanart.tv project key |
| `STEAMGRIDDB_API_KEY` | recommended for game art | key generated under SteamGridDB Preferences → API |
| `BACKDROP_MEDIA_OVERRIDES` | optional | JSON title-to-type map (`game`, `movie`, `tv`, or `screen`) for ambiguous albums |
| `BACKDROP_ALLOWED_ORIGINS` | yes for cross-origin use | comma-separated exact site origins, applied to both endpoints |
| `TINT_ALLOWED_HOSTS` | optional | exact cover hosts; defaults to the five station domains |

Do not configure both TMDB variables unless there is an operational reason; the
read token takes precedence. For the current public site, the CORS value is
`https://24sevenfm-covers.dudesoft.app`.

SteamGridDB does not require an approval application. Sign in, open
[Preferences → API](https://www.steamgriddb.com/profile/preferences/api), and generate a key.
For local Vercel development, add this to the ignored `.env.local` (copy
`.env.example` first only when `.env.local` does not already exist):

```dotenv
STEAMGRIDDB_API_KEY=your_generated_key
```

For the deployed project, add the same name and value in Vercel under **Project
Settings → Environment Variables** for Production and, if used, Preview, then
redeploy. Do not add the key to `site/js/player.js`, HTML, or a committed file.

## Media-type classification

The station's now-playing JSON contains separate `Album`, `Track`, and `Artist`
strings but no movie/TV/game type. The player sends that title metadata to this
resolver, which owns title matching and infers a narrow `game`, `movie`, or `tv` hint
when `Album` explicitly names that kind of soundtrack. For the known multi-film compilation
`The Wings Of A Film`, the resolver uses the movie-name prefix before the first colon
in `Track`. Otherwise TMDB's matched result supplies `movie` versus `tv`, and
SteamGridDB supplies `game`.

When TMDB has no exact title match, the resolver may use `Artist` as a conservative
composer fallback: it requires one exact TMDB person-name match, then considers only
that person's `Original Music Composer` crew credits. A work is accepted only when
its complete title occurs on word boundaries in `Album` and exactly one credit
matches. Cast credits, other music jobs, partial words, short one-word titles, and
ambiguous results remain misses.

For an unmarked title, the resolver tries the enabled catalog category that appears
first in the user's provider order. It accepts exact normalized SteamGridDB matches;
a partial game-search result is never enough. With the default order, an exact TMDB
movie/TV match wins an ambiguous title. Moving SteamGridDB above the screen providers
intentionally makes an exact game match win instead.

If a catalog ambiguity should be fixed for everyone rather than through provider
order, set an explicit server-side override, for example:

```dotenv
BACKDROP_MEDIA_OVERRIDES={"Prey":"game","Inspector Morse":"tv"}
```

This is the only deterministic answer for titles shared by different works; the
station feed itself cannot prove their type.

## Site/API routing

`site/player.html` points at `/api/backdrop` and `/api/tint`. The browser has no
direct metadata-provider or pixel-reading fallback, so both routes must be
reachable. The relative URLs are correct when Vercel serves
the rendered website and function on the same domain. If the static site remains
on GitHub Pages, change both API meta tags to the absolute Vercel project URL and
add that origin to the page's `connect-src` CSP. Also keep the public site origin
in `BACKDROP_ALLOWED_ORIGINS`.

## Abuse protection

`/api/tint` is deliberately not a general image fetcher. It accepts only HTTPS/443
URLs on the exact configured station hosts, only canonical
`/images/cover/<file>` thumbnail paths, and rejects URL credentials, query strings,
fragments and redirects outside that same policy. Fetches have a 4 second deadline,
2 MB transfer ceiling, supported-image MIME check and 4 MP decode ceiling. Invalid
requests are `no-store`; successful RGB responses are cached at the edge for six
months.

Before enabling Production, add one Vercel Firewall rate-limit rule for paths
starting with `/api/`. A conservative starting policy for this player is 20
requests per IP per 10-second fixed window, followed by HTTP 429. Monitor the
Firewall view and adjust only if legitimate station switching reaches the limit.
The Hobby plan supports one such rule with IP or JA4 as the counting key. Vercel's
automatic DDoS mitigation applies on every plan; CORS is not a substitute for
either control.

## Verification

Run the deterministic function tests from the repository root:

```powershell
node --test api/backdrop.test.js
```

After deployment, verify a known soundtrack without printing any configured key:

```powershell
curl.exe --get "https://YOUR-DOMAIN/api/backdrop" --data-urlencode "title=Arrival"
curl.exe --get "https://YOUR-DOMAIN/api/backdrop" --data-urlencode "title=Hades" --data-urlencode "media_hint=game"
curl.exe --get "https://YOUR-DOMAIN/api/tint" --data-urlencode "url=https://streamingsoundtracks.com/images/cover/B000FBFTCS.jpg"
```

The responses should name a movie, TV series, or game and return a trusted TMDB,
fanart.tv, or SteamGridDB image URL,
include three tint channels, and carry a six-month `s-maxage` cache directive.
The tint response should contain only `{ "tint": [r, g, b] }`. Also verify that a
localhost URL receives `400 invalid_image_url` without an upstream request.
