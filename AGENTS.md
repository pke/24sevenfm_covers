# Project instructions

## UI motion

- UI elements must not appear or disappear abruptly. Use at least an opacity fade for every visible-state transition.
- Animate visual size and dimension changes instead of snapping directly to the new geometry.
- Keep outgoing content rendered until its exit transition has completed; do not clear or remove it before the fade can be seen.
- Respect `prefers-reduced-motion`; motion may be reduced or disabled when the user requests it.
