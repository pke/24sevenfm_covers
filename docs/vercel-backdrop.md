# Vercel artwork resolvers

ADR 0001 is implemented by `api/backdrop.js` and `api/tint.js`; the web player's
queued-credit fallback is `api/credit.js`. Vercel discovers all three as Node.js
Functions and installs the root `package.json`. The backdrop API
returns a selected CDN URL and RGB tint and can optionally return DE/US media
certifications; the tint API downloads a bounded station
cover on cache miss and returns only its RGB tint. The credit API reads the public
Open Graph title of an allowlisted station album page only when `GetQueue` omits
`Artist`. None of the endpoints proxies image
bytes to the browser.

`ratings=DE,US` adds a `certifications` array to the response. `art=0` skips artwork
and tint resolution, allowing the Ratings visualization to use the same media match
without paying for unused image-provider work. Rating lookup is best-effort: a TMDB
certification failure returns an empty array and does not fail otherwise valid art.

## Project settings

Set the Vercel project's Root Directory to the repository root and add these
environment variables for Production (and Preview when needed):

The root `.vercelignore` is an allowlist for `api`, the Node dependency manifests
and `vercel.json`; the native applications, SDKs and separately published website
are not part of this server deployment.

| Variable | Required | Purpose |
|---|---:|---|
| `TMDB_API_KEY` | one TMDB credential | TMDB v3 application key; a legacy v4 token stored under this name is auto-detected |
| `TMDB_READ_TOKEN` | one TMDB credential | alternative v4 Read Access Token |
| `FANART_API_KEY` | recommended | fanart.tv project key |
| `STEAMGRIDDB_API_KEY` | recommended for game art | key generated under SteamGridDB Preferences → API |
| `BACKDROP_MEDIA_OVERRIDES` | optional | JSON title-to-type map (`game`, `movie`, `tv`, or `screen`) for ambiguous albums |
| `BACKDROP_ALLOWED_ORIGINS` | yes for cross-origin use | comma-separated exact site origins, applied to all three endpoints |
| `TINT_ALLOWED_HOSTS` | optional | exact cover hosts; defaults to the five station domains |
| `ALBUM_CREDIT_ALLOWED_HOSTS` | optional | exact album-page hosts; defaults to the five station domains |

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
when `Album` explicitly names that kind of soundtrack. For known multi-film
compilations such as `The Wings Of A Film` and `Music For A Darkened Theatre,
Vol. 1/2`, the resolver uses the movie-name prefix before the first colon in `Track`.
For `Great British TV Themes`, whose station metadata can omit the printed dash
between programme and cue, it tries progressively shorter track prefixes and accepts
only an exact TMDB TV-title match. `Television's Greatest Hits` volumes use the same
exact-TV-title strategy, with the volume and decade wording left as compilation
metadata. More generally, an album containing `Theme From`
or `Themes From`, or ending in `Music For Film`, is treated as a screen compilation:
the resolver uses the work-name prefix before the spaced dash in `Track` and accepts
only an exact TMDB film/TV-title match. Thus `Remington Steele - Laura's Theme`
resolves as `Remington Steele`, and `Interview With The Vampire - Born To Darkness /
Louis' Revenge` resolves as `Interview With The Vampire`, without an album-name-
specific exception.

`Every Note Paints A Picture` is also recognized as a track-titled screen-score
anthology. Its marketing title has no generic compilation marker, so this is an
explicit album contract: a track such as `Wilde` is searched as the work title and
must still match a TMDB title exactly.

A trailing `: Series N`, `- Season N`, or `– Staffel N` is parsed as structured TV
metadata. The suffix is removed for title search and supplies a `tv` hint. When TMDB
returns multiple exact series with the same title, an exact `Artist` person and that
person's `Original Music Composer` credit may select the matching series. For example,
`Doctor Who: Series 9` plus `Murray Gold` resolves to the 2005 series rather than the
same-named 1963 series. Artwork remains series-level; the season number is not treated
as part of the TMDB title.

Star Trek soundtrack compilations may put a series abbreviation immediately after a
delimited `Star Trek` prefix. In that restricted position the resolver expands `TOS`,
`TNG`, `DS9`, `VOY`, `ENT`, `PIC`, `SNW`, and `DIS`/`DSC` to their canonical TV titles
and requires an exact TMDB match. Remaining volume, episode and cue text is ignored;
an unprefixed abbreviation or a normal title such as `Star Trek: The Motion Picture`
is not rewritten.

Otherwise TMDB's matched result supplies `movie` versus `tv`, and SteamGridDB
supplies `game`.

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

`site/player.html` points at `/api/backdrop`, `/api/tint`, and `/api/credit`. The browser has no
direct metadata-provider or pixel-reading fallback, so all three routes must be
reachable. The relative URLs are correct when Vercel serves
the rendered website and function on the same domain. If the static site remains
on GitHub Pages, change all three API meta tags to the absolute Vercel project URL and
add that origin to the page's `connect-src` CSP. Also keep the public site origin
in `BACKDROP_ALLOWED_ORIGINS`.

The resolver returns direct Wikimedia Commons original-file URLs for the coloured
FSK 0/6/12/16/18 and MPA G/PG/PG-13/R/NC-17 SVGs. The browser accepts only those
ten exact `https://upload.wikimedia.org` URLs, and the player's `img-src` CSP permits
that host. Unsupported ratings, including US TV ratings, continue to use text badges.

## Abuse protection

`/api/tint` is deliberately not a general image fetcher. It accepts only HTTPS/443
URLs on the exact configured station hosts, only 200 px `/images/cover/<file>` or
40 px `/images/cover/040/<file>` paths, and rejects URL credentials, query strings,
fragments and redirects outside that same policy. Fetches have a 4 second deadline,
2 MB transfer ceiling, supported-image MIME check and 4 MP decode ceiling. Invalid
requests are `no-store`; successful RGB responses are cached at the edge for six
months.

`/api/credit` is likewise not a general HTML proxy. It accepts only HTTPS/443 album
pages on the exact configured station hosts, requires the fixed
`/modules.php?name=Album&asin=<safe-id>` shape, rejects credentials, extra parameters,
fragments and every redirect, and stops after 3 seconds or 256 KB. A successful
credit is cached for six months; a page without matching Open Graph metadata is
cached for 15 minutes.

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
node --test api/*.test.js
```

After deployment, verify a known soundtrack without printing any configured key:

```powershell
curl.exe --get "https://YOUR-DOMAIN/api/backdrop" --data-urlencode "title=Arrival"
curl.exe --get "https://YOUR-DOMAIN/api/backdrop" --data-urlencode "title=Hades" --data-urlencode "media_hint=game"
curl.exe --get "https://YOUR-DOMAIN/api/backdrop" --data-urlencode "title=Game Of Thrones" --data-urlencode "providers=tmdb" --data-urlencode "ratings=DE,US" --data-urlencode "art=0"
curl.exe --get "https://YOUR-DOMAIN/api/tint" --data-urlencode "url=https://streamingsoundtracks.com/images/cover/040/B000FBFTCS.jpg"
curl.exe --get "https://YOUR-DOMAIN/api/credit" --data-urlencode "album=JFK (2013)" --data-urlencode "url=https://streamingsoundtracks.com/modules.php?name=Album&asin=B00GHJ08XC"
```

The responses should name a movie, TV series, or game and return a trusted TMDB,
fanart.tv, or SteamGridDB image URL,
include three tint channels, and carry a six-month `s-maxage` cache directive for
an artwork hit. A response without a backdrop uses a 15-minute `s-maxage` instead.
The tint response should contain only `{ "tint": [r, g, b] }`, and the credit response
only `{ "artist": "Joel Goodman" }`. Also verify that a
localhost image URL receives `400 invalid_image_url`, and a localhost album URL
receives `400 invalid_album_url`, without an upstream request.
