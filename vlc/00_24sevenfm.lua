--[[
  00_24sevenfm.lua - VLC album-art fetcher for the 24seven.fm / Streaming Soundtracks
  family of internet radio stations. When VLC is playing one of the family streams it
  returns the now-playing cover art (the same art the stations show on their sites),
  which VLC then displays as the track's album art - in the playlist, the audio-mode
  background, and the cover thumbnail. Returns nil for anything else, so VLC's other
  art fetchers handle non-family media as usual.

  This is the cross-platform (Windows/macOS/Linux) companion to the Winamp and
  foobar2000 plugins - VLC add-ons are Lua, so there's nothing to compile. Because
  it's an art fetcher (not a UI plugin), there's no docked window, animation, poster
  mode or fullscreen; VLC shows the cover wherever it shows album art.

  INSTALL - drop this file into VLC's art-fetcher folder, then restart VLC:
    Windows:  %APPDATA%\vlc\lua\meta\art\
    macOS:    ~/Library/Application Support/org.videolan.vlc/lua/meta/art/
    Linux:    ~/.local/share/vlc/lua/meta/art/
  (or the lua\meta\art\ folder inside the VLC install directory).

  Part of https://github.com/pke/24sevenfm_covers. Not affiliated with 24seven.fm /
  Streaming Soundtracks.
--]]

-- The server exposes several cover sizes under /cover/<size>/ (500 = large, 040 = a
-- thumbnail); the bare CoverLink is a medium image. Request the large one, matching the
-- plugins' default (lib Config::coverSize = 500).
local COVER_SIZE = 500

-- Monotonic cache-buster for the now-playing URL. VLC's art-fetcher Lua sandbox exposes
-- neither os.* nor vlc.misc.*, so a per-session counter is the portable way to defeat any
-- HTTP caching of the (dynamic) endpoint.
local nonce = 0

-- The family stations. `match` is looked for in the stream URL; `host` serves both the
-- now-playing JSON and the cover images. Keep in sync with shared/stations.h.
local stations = {
    { match = "streamingsoundtracks", host = "streamingsoundtracks.com" },
    { match = "1980s.fm",             host = "1980s.fm"                 },
    { match = "adagio.fm",            host = "adagio.fm"                },
    { match = "death.fm",             host = "death.fm"                 },
    { match = "entranced.fm",         host = "entranced.fm"             },
}

-- VLC calls this to register the fetcher. We declare "local" scope deliberately: VLC
-- requests only LOCAL-scope art finding for a live radio stream, so a "network" fetcher
-- (like the built-in MusicBrainz one) is skipped and never runs. We still fetch over the
-- network below - "local" is just what makes VLC invoke us for a stream at all.
function descriptor()
    return { scope = "local" }
end

-- Which family station's host does this stream URL belong to? nil if it isn't ours.
local function station_host(url)
    if not url then return nil end
    url = string.lower(url)
    for _, s in ipairs(stations) do
        if string.find(url, s.match, 1, true) then return s.host end
    end
    return nil
end

-- GET the whole body over VLC's stream layer (handles http + https).
local function http_get(url)
    local s = vlc.stream(url)
    if not s then return nil end
    local body, chunk = "", s:read(65536)
    while chunk and #chunk > 0 do
        body = body .. chunk
        chunk = s:read(65536)
    end
    return body
end

-- VLC's art-fetch entry point. Returns a cover URL for a family stream, else nil.
function fetch_art()
    if vlc.item == nil then return nil end

    local host = station_host(vlc.item:uri())
    if not host then return nil end -- not a family stream; let VLC's other fetchers try

    -- The station serves its current track's now-playing state (incl. CoverLink) as a
    -- flat JSON object of quoted values. Cache-bust so we get the live track. Prefer
    -- HTTPS; fall back to HTTP where TLS isn't available.
    nonce = nonce + 1
    local path = "/soap/FM24sevenJSON.php?action=GetCurrentlyPlaying&_t=" .. tostring(nonce)
    -- Prefer HTTPS but fall back to HTTP: some stations have no working HTTPS (SST), and
    -- VLC's Lua stream can't always create an HTTPS access ("no suitable access module").
    local body = http_get("https://" .. host .. path)
    if not body or body == "" then body = http_get("http://" .. host .. path) end
    if not body or body == "" then
        vlc.msg.warn("[24seven.fm] no now-playing response from " .. host)
        return nil
    end

    -- Pull "CoverLink":"<url>" and un-escape JSON slashes (\/  ->  /).
    local cover = string.match(body, '"CoverLink"%s*:%s*"([^"]*)"')
    if not cover or cover == "" then return nil end
    cover = string.gsub(cover, "\\/", "/")

    -- Ask for the large variant: .../cover/ID.jpg -> .../cover/500/ID.jpg (first match only).
    cover = string.gsub(cover, "/cover/", "/cover/" .. COVER_SIZE .. "/", 1)

    -- Always hand VLC an HTTP cover URL. Every station serves the image over HTTP, and
    -- VLC's HTTPS support is unreliable here (SST has no HTTPS at all; VLC's Lua/access
    -- layer sometimes can't do HTTPS) - reliability beats HTTPS for low-sensitivity art
    -- (the host check below still applies).
    cover = string.gsub(cover, "^https://", "http://")

    -- Only trust a cover served from the station's own host - a hostile/compromised
    -- server shouldn't be able to point VLC at an arbitrary URL.
    if not string.find(string.lower(cover), string.lower(host), 1, true) then
        vlc.msg.warn("[24seven.fm] cover host mismatch, ignoring: " .. cover)
        return nil
    end

    vlc.msg.dbg("[24seven.fm] cover art: " .. cover)
    return cover
end
