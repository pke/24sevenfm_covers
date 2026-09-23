# Stage diagnostics

`D` toggles the stage panel in the web player and the shared Windows renderer
(viewer, Winamp, foobar2000), including fullscreen. Give the native stage keyboard
focus by clicking it. Typing in an input does not toggle diagnostics. `Esc`, Close,
or a click outside dismisses the panel. Entry/exit and geometry changes animate;
the web reduced-motion preference and Windows client-area animation setting are
respected. Outgoing content remains mounted throughout its fade.

The report contains current/raw and resolved metadata, current/requested artwork,
image dimensions, layout/viewport, enabled features, queue/cache state, and the
last 30 requests and 30 events. The native renderer also reports decoded-cache
memory and cover/backdrop pixel dimensions. Image decode events include duration
and dimensions without decoding an additional time for the report.

**Freeze** retains an exact snapshot; **Resume** resumes updates. Selecting text
also pauses updates. **Copy snapshot** copies the complete frozen/displayed report
as JSON, including responses; the web panel initially collapses API response
bodies for readability. URL query credentials and credential fields are redacted
before retention. Non-JSON bodies are omitted; JSON bodies over 64 KiB are marked
as truncated. No credentials, disk history or additional diagnostic image
downloads are needed. Closing the panel does not clear the bounded session log.

## Timing semantics

All durations are milliseconds measured using a monotonic clock. Client request
times are measured in the client, and API processing times on the server. These
are separate clocks: do not subtract wall-clock timestamps to infer network
latency, and do not add parallel phases to obtain total elapsed time.

- `headersMs`: from request start through receipt of response headers (not a
  separate DNS/TLS measurement). Unknown transports expose `null`.
- `downloadMs`: from request start through the complete response body, including
  `headersMs`. Byte counts measure the received/decoded body, not TLS or HTTP
  framing overhead. The web `parseMs` measures JSON parsing; native
  `diagnosticParseMs` measures the diagnostic copy's parse, not production parsing.
- API `totalMs`: handler work through construction of the response, excluding
  serialization, platform startup/queueing and the client's network transit.
- Tint `analysisMs`: image metadata/decode and colour analysis. The actual preview
  URL, byte count, format, dimensions and success/fallback/error are recorded.
  For example TMDB uses its `w92` preview rather than the displayed large backdrop.
- `resolution` / `logoResolution`: measurements **at cache creation**, with their
  original `recordedAt`. A hit retains those historical measurements. The current
  handler's cache outcome (`miss`, `hit`, `coalesced`, `reload`) and total remain
  separate. Provider spans include offsets relative to their creation operation.
- HTTP/CDN cache data is reported only when response headers expose it. A missing
  header is `unknown`, never an inferred hit. A CDN-cached JSON response also
  retains its original server timestamp. Local client caches are separate.

## API opt-in

`/api/media`, `/api/tint` and `/api/credit` accept `diagnostics=1` and append a
`diagnostics` object. Omission or `0` preserves the public response shape; other
values return HTTP 400. This is a response projection: diagnostics and ordinary
requests share provider work and the same metadata/variant caches. Normal clients
request the projection so a failure preceding the opening of the panel is visible.
The API deployment must support this option before the new tint client ships.

The object includes `requestId`, `recordedAt`, `totalMs`, bounded `spans`, `images`,
`selections`, and applicable cache outcomes/creation measurements. It never returns
provider authorization headers or full private provider responses. Selection data
is limited to the chosen image and candidate counts.

## Why a poster can still contain text

Fanart selection is **prefer-textless**, not a strict exclusion filter. In the
absence of a trusted `lang: "00"` candidate it may select another poster. Empty or
missing language remains unknown; it no longer sets `containsText: false`.
Diagnostics preserve the chosen ID, URL, raw language, likes, candidate counts and
`textless-candidate` / `no-textless-candidate` selection reason. A labelled `00`
image can still be mislabelled by the provider; this is metadata, not OCR.
See [Fanart's language contract](https://fanart.tv/api-docs/api-v3/).

TMDB currently uses `poster_path` / `backdrop_path` from resolved media. The
selection trace labels this `default-path`, with text/language unknown. TMDB's
poster default can fall back to the original language. Selecting only images
without a language would require its `/images?include_image_language=null`
endpoint; absence of a language still does not verify the pixels.
See [TMDB image languages](https://developer.themoviedb.org/docs/image-languages).

## Validation

API/data tests: `npm run test:api`.
Local UI tests: `site/tests/run_local.ps1 -PlaywrightArguments @('--grep','debug ')`.
The runner uses isolated temporary builds and ports, leaving the development
preview untouched. `PLAYER_TEST_CHANNEL=msedge` or `chrome` can select an installed
browser for local validation; bundled Chromium remains the default.
`PLAYER_TEST_BROWSER=firefox` selects Firefox when installed through Playwright.
Native tests: configure `lib` with `COVERFETCH_BUILD_TESTS=ON`, build, then run CTest.
