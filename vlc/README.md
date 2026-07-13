# VLC cover art (24seven.fm)

`00_24sevenfm.lua` is a VLC **album-art fetcher** for the 24seven.fm / Streaming
Soundtracks family of internet radio stations. When VLC plays a family stream, it
returns the now-playing cover art and VLC shows it as the track's album art (playlist
thumbnail, audio-mode background, cover panel), updating as the track changes.

It's the cross-platform companion to the Winamp and foobar2000 plugins. VLC add-ons
are Lua, so there is **nothing to compile** and it runs on Windows, macOS and Linux.

Because it's an art fetcher (not a UI plugin) it has **no** docked window, crossfade
animation, poster mode or fullscreen - those are features of the C++ Direct2D renderer
the desktop viewer and the plugins share. VLC just displays the cover wherever it shows
album art.

## Install

Copy `00_24sevenfm.lua` into VLC's art-fetcher folder, then restart VLC:

| OS | Folder |
|----|--------|
| Windows | `%APPDATA%\vlc\lua\meta\art\` |
| macOS | `~/Library/Application Support/org.videolan.vlc/lua/meta/art/` |
| Linux | `~/.local/share/vlc/lua/meta/art/` |

(or the `lua\meta\art\` folder inside the VLC install directory). Create the folders if
they don't exist.

## How it works

`fetch_art()` checks the current input's URL against the family station hosts (kept in
sync with [`shared/stations.h`](../shared/stations.h)); for a match it fetches that
host's `GetCurrentlyPlaying` JSON, reads the `CoverLink` field, verifies the cover is
served from the station's own host, and returns it to VLC. For anything else it returns
`nil` so VLC's built-in fetchers (MusicBrainz, etc.) handle non-family media. The `00_`
filename prefix makes VLC try this fetcher first, so a family stream gets the real cover
rather than a metadata guess.

## Debugging

Run VLC with verbose logging to see the fetcher's messages
(`[24seven.fm] cover art: …` / warnings):

```
vlc -vv        # or Tools > Messages (set Verbosity to 2) in the GUI
```

If covers don't refresh per track, that's VLC's art-cache/refresh timing for streams
(the known limitation of the art-fetcher approach) rather than a fetch failure - the log
will show whether `fetch_art` is being re-invoked.
