# foobar2000 macOS cover visualisation

This native arm64 component displays live cover artwork directly inside foobar2000.
It uses SDK new-track, dynamic-title, pause and stop callbacks. All five stations
are supported. Local files and other streams return the visualisation to idle.

Open **View → Visualisations → 24seven.fm Covers**. Double-click the cover to toggle
fullscreen. The menu reuses its existing window. For embedding, add
`24sevenfm-covers` in **View → Layout → Edit Layout**, for example:

```text
splitter horizontal style=thin
 playlist
 24sevenfm-covers
```

The SDK `ui_element_mac` returns a native `NSViewController`; the popup and layout
element render in the foobar2000 process and require no running desktop viewer.
They reuse the Mac viewer's AppKit stage and portable presentation pipeline,
including transitions, countdown, coming-next artwork and reduced motion.
Display/artwork preferences belong to foobar2000 and are stored in its native
`configStore` under `foo_24sevenfm_covers.*`. The desktop app is not required to
be installed. Open **Settings → Tools → 24seven.fm Covers**, **View → 24seven.fm
Covers Settings…**, or the panel's context menu. Changes apply immediately to
all cover panels; provider order, personal API key, artwork, layout, countdown,
transitions and ratings are configurable independently of the desktop viewer.
Pause retains artwork, including when opening another element during a pause;
stop fades to an idle caption. Hidden/removed views stop their feed workers.

Build with Xcode, CMake and Ninja:

```sh
sh foobar2000/macos/build.sh
sh desktop/macos/install-player-integrations.sh
```

The build uses the vendored SDK's Xcode projects for static libraries and CMake
for `foo_24sevenfm_covers.component`. It creates an ad-hoc signed arm64 bundle and
`desktop/build/foobar-macos/24sevenfm-covers-macos.fb2k-component`. The installer
backs up and verifies replacement files under
`~/Library/foobar2000-v2/user-components/foo_24sevenfm_covers/`.

`SSC_PLAYER_E2E=ON` is only for the separate test build. It adds an SDK driver that
creates a temporary playlist, mutes playback, executes play/pause/resume/stop and
removes the playlist and restores the previous volume on exit. The driver requires
`SSC_FOOBAR_TEST_DIR`. Normal builds leave this option off and contain no driver.
The driver calls the player's SDK; playback callbacks are not mocked. It also
executes the registered visualisation menu command and instantiates the layout
service, checks rendered pixels and saves PNGs from native views. See
[the real-player E2E procedure](../../desktop/macos/README.md#player-integrations-and-e2e-tests).
