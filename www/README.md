# www — project website

Static, self-contained site for 24seven.fm Covers. No build step, no external
dependencies — deploy by copying the folder to any web host.

```
├─ index.html      single page: hero, features, display modes, stations, downloads
├─ css/style.css   mobile-first; dark by default, light via OS preference or the ◐ toggle
├─ img/            logo/favicon (from desktop/24sevenfm_covers.ico) + screenshots
└─ shoot.ps1       captures real viewer screenshots (see below)
```

## Downloads

`index.html` links `downloads/<artifact>` using the current artifact names. When
publishing, run `installer\build_artifacts.ps1` and copy `dist\*` into `www\downloads\`
(git-ignored, like `dist\`). After a version bump, update the names/versions in the
Download section.

## Screenshots

`img/poster.svg` and `img/fill.svg` are hand-made mockups of the two display modes.
To replace them with real captures, run **from an interactive desktop session** (the
capture APIs need a visible window station, so it cannot run from an agent/service
context):

```powershell
powershell -File www\shoot.ps1
```

It launches the built viewer twice (poster, then fill mode), waits for a live cover,
captures the window into `img\poster.png` / `img\fill.png`, and tells you which two
`img` references to switch in `index.html`.
