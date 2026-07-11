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

`installer\build_artifacts.ps1` builds every artifact directly into `www\downloads\`
(git-ignored) and rewrites the download links and version labels in `index.html` to the
names it just built (the version labels are matched via the `data-ver` attributes on the
`.meta` spans — keep those when editing). So: run the script, then publish `www\` as-is.

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
