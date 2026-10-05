# IINA integration

The plugin follows the five 24seven.fm stations in the native macOS Covers viewer.
It recognizes the actual HTTP(S) stream hostname, forwards metadata changes and
pause/resume/stop, and leaves local files and unrelated radio stations alone.
Each IINA window has its own session. The viewer retains paused artwork and fades
out on stop; it does not take keyboard focus. Artwork and settings stay in the
existing Mac viewer rather than being duplicated in an IINA overlay.

Requires IINA 1.4 or newer and the viewer installed at either
`~/Applications/24seven.fm Covers.app` or `/Applications/24seven.fm Covers.app`.
The plugin needs IINA's `file-system` permission to run the viewer's native bridge;
stream URLs and titles are passed as literal arguments without a shell.

After building the Mac viewer and foobar2000 component, run:

```sh
sh desktop/macos/install-player-integrations.sh
```

The installer backs up existing extensions and IINA preferences and enables this
plugin while preserving other IINA settings. Close both players before running
it. For manual distribution, pack `24sevenfm-covers.iinaplugin` using IINA's bundled
`iina-plugin pack` command, open the resulting `.iinaplgz` and enable the plugin.

In the viewer, **View → Follow IINA / foobar2000** enables automatic following.
Selecting a station manually turns following off. Player-selected stations do
not overwrite the saved standalone station. The latest started player/window
owns the viewer; metadata and stops from other windows cannot interrupt it.

Tests: `npm run test:players`, the portable `player_follow_tests` target and the
Mac bridge protocol tests. The real-player E2E procedure is documented in
[the Mac README](../desktop/macos/README.md#player-integrations-and-e2e-tests).
