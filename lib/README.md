# coverfetch — cross-platform cover watcher (Windows / iOS / Android)

A small C++11 library that watches the "currently playing" track on
[Streaming Soundtracks](http://streamingsoundtracks.com) (24seven.fm) and invokes
your callback with the **URL of the new cover** every time the cover changes.

It is a portable port of the SFML desktop demo in the parent folder: the SFML +
OpenGL rendering is dropped, and the "now playing" polling + refresh-timing logic
is kept and made dependency-free so it builds on Windows, iOS and Android.

## Data source

The reference app POSTed to a SOAP endpoint (`/soap/FM24seven.php`). That
endpoint is now **dead (HTTP 500)**. The station's own web player instead polls a
JSON endpoint, which this library uses:

```
GET http://streamingsoundtracks.com/soap/FM24sevenJSON.php?action=GetCurrentlyPlaying&_t=<cachebuster>
```

It returns the same data model the SOAP service used to, as flat JSON:

```json
{"Album":"Penny Dreadful","Track":"Let Me Die","Artist":"Abel Korzeniowski",
 "Length":"150572","PlayStart":"2026-07-08T05:24:57","SystemTime":"2026-07-08T05:26:56",
 "CoverLink":"https://streamingsoundtracks.com/images/cover/B00LR1YTT4.jpg",
 "ThumbnailLink":".../images/cover/040/B00LR1YTT4.jpg","SiteLink":"...","RequestedBy":"...","ListenerCount":"139"}
```

It is served over both **HTTP:80 and HTTPS:443**. On Windows the client uses
**WinHTTP**, so requests go over **TLS (443)** with certificate validation from
the OS store and no extra dependency. Other platforms use the dependency-free
plain-socket client (HTTP:80) until a native TLS path (NSURLSession / OkHttp) is
wired in.

**All 24seven.fm stations expose this same endpoint**, each on its own host —
`streamingsoundtracks.com`, `1980s.fm`, `adagio.fm`, `death.fm`, `entranced.fm`
(covers live on the same host as the JSON). Point `Config::host` at any of them to
switch stations; the cover-URL validation pins `CoverLink` to that host. The
station table shared by the front-ends is `shared/stations.h`.

## Files

| File | Purpose |
|------|---------|
| `coverfetch.h` / `.cpp` | The `ssc::CoverMonitor` C++ API (JSON parsing is built in) |
| `coverfetch_c.h` / `.cpp` | Plain **C ABI** wrapper (easy JNI / Swift binding) |
| `http_client.h` / `.cpp` | HTTP client: WinHTTP (TLS) on Windows, plain socket on POSIX |
| `example/main.cpp` | Console demo |
| `CMakeLists.txt` | Build for all three platforms |

Dependencies: **none** beyond the C++11 standard library and the OS libraries
(WinHTTP on Windows; sockets/threads elsewhere). No tinyxml2, no OpenSSL —
Windows TLS comes from WinHTTP.

## C++ usage

```cpp
#include "coverfetch.h"

ssc::CoverMonitor monitor([](const std::string& coverUrl, const ssc::TrackInfo& t) {
    // Runs on a background thread. Marshal to your UI thread before using it.
    myUi.loadCover(coverUrl);           // e.g. "http://streamingsoundtracks.com/images/cover/500/B00LR1YTT4.jpg"
});
monitor.start();
// ... app runs ...
monitor.stop();                          // also happens in the destructor
```

`CoverMonitor` polls once, fires the callback if the cover differs from the last
one, then sleeps until the current track is expected to end and polls again.

### C API (for JNI / Swift)

```c
#include "coverfetch_c.h"

static void on_cover(const char* url, void* user) { /* copy url, hop to UI thread */ }

ssc_monitor* m = ssc_monitor_create(on_cover, my_ctx, 500 /*cover size*/);
ssc_monitor_start(m);
// ...
ssc_monitor_destroy(m);   // stops + frees
```

## Refresh timing

Ported from [`24sevenfm_covers.cpp`](../desktop/24sevenfm_covers.cpp) and
verified against the live feed:

```
elapsed   = |SystemTime − PlayStart|      // seconds already played (server clock)
remaining = Length/1000 − elapsed         // seconds left in the track
sleep(remaining)                          // then re-poll (the track just ended)
```

**`Length` is in milliseconds** in the JSON feed (e.g. `150572` = 2:30), unlike
the old SOAP field — the library divides by 1000. `remaining` is clamped to
`[minPollSeconds, maxPollSeconds]`, and a failed fetch retries after
`errorRetrySeconds` (see `ssc::Config`). This mirrors the site's own player,
which refetches when its countdown hits 0 with a 30 s failsafe.

## Cover URL

`CoverLink` is a ready-to-use image URL (`.../images/cover/<ASIN>.jpg`). As in
the reference app, `/cover/` is rewritten to `/cover/<size>/` to request a
specific size — 500 (large, default), 40 (thumbnail). All sizes are confirmed to
exist. Set `Config::coverSize = 0` to use `CoverLink` unchanged.

## Building

```sh
cmake -S lib -B build          # from the repo root
cmake --build build
./build/coverfetch_example     # desktop demo
```

- **Windows**: MSVC or clang; uses WinHTTP (TLS), links `winhttp` automatically.
- **Android**: build with the NDK toolchain (`android.toolchain.cmake`); links
  `pthread`/libc (sockets are in libc). Add the `INTERNET` permission to the app
  manifest. Bind through `coverfetch_c.h`.
- **iOS**: add the three `.cpp` files to your target, or cross-build with an iOS
  CMake toolchain. Import `coverfetch_c.h` via a bridging header for Swift.

## Verification notes (2026-07-08)

- Host must be `streamingsoundtracks.com` (**no `www`**): `www.` 301-redirects.
- `GET /soap/FM24sevenJSON.php?action=GetCurrentlyPlaying` returns 200 JSON over
  plain HTTP; `POST /soap/FM24seven.php` (the old SOAP endpoint) returns 500.
- The timing formula was confirmed by polling as a track played out: `remaining`
  fell from 90 s to 74 s in step with `SystemTime − PlayStart`, and `Length/1000`
  matched the track duration.
- If the site changes the feed, point `Config::host`/`path`/`action` at the new
  URL; the parser reads the `Album/Artist/Track/Length/PlayStart/SystemTime/CoverLink`
  keys from a flat JSON object.
