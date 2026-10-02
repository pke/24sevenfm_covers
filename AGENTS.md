# Project instructions

## UI motion

- UI elements must not appear or disappear abruptly. Use at least an opacity fade for every visible-state transition.
- Animate visual size and dimension changes instead of snapping directly to the new geometry.
- Keep outgoing content rendered until its exit transition has completed; do not clear or remove it before the fade can be seen.
- Respect `prefers-reduced-motion`; motion may be reduced or disabled when the user requests it.

## Version control

- Use Conventional Commits for every commit message (for example, `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, or `chore:`).

## Local native app updates

- After native changes, build and update both the desktop viewer (DV) and the installed Winamp plugin; completing only source edits or separate build outputs is insufficient.
- Update the viewer at `desktop/build/Release/24sevenfm_covers.exe` and the Winamp plugin at `C:/Users/philk/OneDrive/tools/Winamp/Plugins/gen_24sevenfm_covers.dll`. If a running app uses another installation, update that actual installation too.
- Running apps must also receive the update. Close them gracefully when their executable or plugin is locked, replace the files, and restart apps that were running, restoring Winamp playback when applicable. The user has authorized these restarts; do not ask again.
- Preserve settings, retain a recoverable copy of replaced binaries, and verify the installed file hashes and restarted process/plugin paths.
