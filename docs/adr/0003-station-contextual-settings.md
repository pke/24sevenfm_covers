# ADR 0003: Station-contextual settings with stable all-station controls

Date: 2026-08-24
Status: Accepted

## Context

The web player presents one station picker and one settings grid, but the settings
in that grid do not all have the same scope. Some features only make sense for a
particular station, while others apply unchanged when the listener switches among
the five 24seven.fm stations.

The relevant scopes are:

| Setting | Scope |
| --- | --- |
| Movie, TV and game backdrops, artwork providers, cover hiding and ratings | StreamingSoundtracks only |
| 80s laser show and its strobe/smoke options | 1980s.FM only |
| Spectrum analyzer and its configuration | All stations |
| Cover transition and duration | All stations |
| Remaining-time mode and size; “Coming next” as an independent option | All stations |

The current `Visualizations` fieldset mixes the all-station analyzer with the
1980s-only laser show and the StreamingSoundtracks-only ratings. The separate
`Experimental` fieldset contains the remaining StreamingSoundtracks-only artwork
controls. The UI therefore suggests that neighboring controls have the same
availability, even though the player silently gates their effects by station.

This has three undesirable consequences:

- A listener can enable an option on a station where it cannot have an effect and
  receive no immediate explanation.
- The station dependency must be learned from long notes rather than from the
  control hierarchy.
- New station-specific features can make the grid still more ambiguous because
  there is no visual or structural scope model to extend.

The settings are saved as one browser-local preference set. Station scope describes
where a feature is available; it does not mean that switching stations should reset
or rewrite the user's choices.

## Decision

Adopt Variant A: place a contextual **For this station** section first in the
settings flow and keep a stable **For all stations** section for settings whose
meaning does not depend on the selected station.

### Contextual station section

The contextual section is driven by the currently selected station and names that
station explicitly. It contains the complete control hierarchy for features that
can operate on that station:

- **StreamingSoundtracks:** movie/TV/game backdrops, provider priority and keys,
  hide-cover behavior, ratings and country choices.
- **1980s.FM:** the 80s laser show and its dependent strobe and smoke controls.
- **Adagio.FM, Death.FM and Entranced.FM:** an unobtrusive empty state stating that
  this station has no station-specific visual effects.

Dependent controls stay with their owning feature. Provider configuration must not
remain in a generic `Experimental` section after its master backdrop switch moves
into the StreamingSoundtracks context, and strobe/smoke controls must not be left in
the all-station visualization group after the laser switch moves into the 1980s.FM
context.

The selected station's display name is part of the contextual heading or immediate
subheading. Scope must remain understandable without color; color may reinforce the
connection but must not be its only signal.

### Stable all-station section

Controls that retain the same meaning across station switches remain rendered in a
stable all-station area. This includes at least:

- audio and volume;
- station-independent visualizations such as MilkDrop and the spectrum analyzer,
  including their dependent configuration;
- layout;
- cover transition and transition duration;
- remaining-time mode and size;
- “Coming next” as an independent option.

The all-station area must not be rebuilt, moved within the grid or temporarily
disabled merely because the station changes. A station switch changes the
contextual section only.

`Spectrum` is explicitly an all-station setting. Its enabled state, analyzer type,
bar count and visual mode are not copied per station and do not reset on a station
switch. Transition and remaining-time preferences follow the same rule.

### Capability model

Station applicability must be represented declaratively rather than inferred from
control labels or duplicated conditionals. The station definitions should expose
the capabilities needed by both behavior and settings presentation, for example
backdrop/rating capability on StreamingSoundtracks and laser capability on
1980s.FM. Global features are not repeated as capabilities on every station.

The UI uses that shared capability model to select the contextual panel. Runtime
feature gating uses the same source of truth, so a control cannot be shown for a
station on which the engine refuses to run it. A future station feature extends the
capability model and adds one contextual group; it does not require redesigning the
global grid.

### Persistence and station changes

Station-specific option values remain ordinary persisted preferences:

- Switching away from a station stops the feature's visible/runtime effect but does
  not turn its checkbox off, clear provider choices or delete subordinate values.
- Returning to that station restores the previously selected controls and allows
  the feature to operate again.
- An unavailable feature must not perform background work. In particular, non-SST
  stations must not send titles to the artwork/rating resolver, and non-1980s
  stations must not run the laser scene.
- Global options continue to apply immediately before, during and after a station
  switch.

This is one global preference value per feature with station-scoped applicability,
not a separate settings profile for every station.

### Sparse semantic settings and share URLs

Persisted settings use short semantic values instead of a Boolean master key plus
a second key that explains how the enabled feature should render. Optional feature
keys are sparse: when a feature is off, its key is absent rather than set to
`false`, `0` or the string `off`.

The web settings covered by this regrouping use these canonical values:

| Key | Value while enabled | Meaning when absent |
| --- | --- | --- |
| `remaining` | `countdown` or `rolldown` | Remaining time is off |
| `comingNext` | `true` | “Coming next” is off |
| `sstBackdrops` | Ordered, non-empty provider ID list | SST backdrops are off |
| `sstRatings` | Non-empty country ID list | SST ratings are off |

Dependent presentation values remain independent so disabling their feature does
not erase the user's last configuration. In particular, `remainingSize` remains
stored as `small`, `medium` or `large` when `remaining` is removed, and `sstCover`
may retain `show` or `hide` while SST backdrops are unavailable or disabled. The
optional `fanartKey` also remains independent and browser-local.

The previous `showRemaining`/`roll`, `showComingNext`,
`tmdbBackdrops`/`enabledProviders`/`providerOrder`, `hideCover`, and
`ratingsEnabled`/country-Boolean shapes are read once as a compatibility migration
and saved back in the canonical schema. The runtime consumes only the canonical
values after loading.

The current canonical, non-secret settings are always serialized into the address
bar. A plain player route first loads the browser-local preferences and compatible
legacy URL overrides, then immediately replaces its current history entry with the
equivalent canonical `preset=1` URL. Every subsequent station or settings change
updates both persistence and that URL with `history.replaceState`; it does not add a
history entry per interaction. Unrelated query parameters and the fragment remain
intact. The copy-link control is therefore a convenience for copying the already
shareable current experience, not a separate serialization mode.

A URL marked with `preset=1` starts from application defaults rather than the
recipient's local preferences, then applies the serialized keys; omitted optional
feature keys are therefore reliably off. This makes a compact URL reproduce the
sender's experience without filling it with explicit false values. `fanartKey` and
any future credential or private value are never serialized. Applying a shared
preset does not silently overwrite the recipient's saved preferences merely by
opening the link.

### Motion and retained content

A station change must not make the contextual settings appear, disappear or resize
abruptly.

The contextual host retains both outgoing and incoming panels for the duration of
the change. The outgoing panel fades out while the incoming panel fades in, and the
host animates from the old measured height to the new measured height. Outgoing
markup is removed from layout or marked `hidden` only after its exit transition has
completed. It may become `inert` and `aria-hidden` as soon as it is no longer the
active semantic panel so users cannot interact with stale controls during the fade.

Rapid consecutive station changes cancel or supersede the prior visual transition
without exposing an intermediate station's controls. The final selected station is
the only interactive context.

When `prefers-reduced-motion: reduce` is active, the visual fade and geometry
animation may be disabled. The semantic switch, persistence rules and runtime
gating remain unchanged.

### Embedded and fullscreen settings

The player continues to maintain one real set of controls. The fullscreen options
overlay moves the existing station picker and settings nodes through the current
portal mechanism; it must not clone station-context panels or keep a second copy in
sync.

The order inside every settings surface is:

1. station picker;
2. current-station context;
3. all-station settings.

On the normal page the stage may remain between the station picker and the detailed
settings for presentation purposes, but the settings panel itself starts with the
named current-station context before the all-station grid. In fullscreen, where the
controls are presented as one overlay, the three groups appear consecutively in the
order above.

## Consequences

- Station dependencies become visible in headings and grouping instead of being
  buried in explanatory notes.
- Listeners cannot mistake the all-station analyzer, transitions or countdown for
  station-specific preferences.
- The large artwork-provider UI appears only in the StreamingSoundtracks context,
  reducing clutter on the other four stations.
- Users can configure a station-specific feature only while that station is
  selected. Its saved state remains intact while unavailable.
- The contextual area changes height substantially between StreamingSoundtracks,
  1980s.FM and the empty state, so retained crossfades and height animation are
  functional requirements rather than optional polish.
- Existing local-storage values are migrated into the sparse semantic schema. The
  preference meaning remains compatible, but obsolete Boolean/master keys are not
  written again.
- Notes can become shorter because they explain feature behavior and privacy rather
  than carrying the primary burden of communicating station scope.

## Verification

Automated browser coverage should verify:

- each of the five station choices selects the correct contextual content;
- backdrops/ratings never resolve outside StreamingSoundtracks and the laser never
  activates outside 1980s.FM;
- spectrum, transition and remaining-time values survive every station switch and
  remain effective on every station;
- hidden station-specific values survive a switch away and back;
- disabling an optional feature removes its key without removing dependent settings
  such as `remainingSize`;
- the address bar is immediately canonicalized and stays synchronized after every
  station or settings change without growing browser history;
- its `preset=1` URL reproduces the sparse non-secret settings from defaults, does not
  read or overwrite saved recipient preferences merely by opening, and never includes
  `fanartKey`;
- the outgoing panel is still rendered during its fade, the host height interpolates
  rather than snapping, and rapid switching ends on the final station;
- reduced-motion mode removes or shortens the visual transition without breaking
  panel state or accessibility;
- the same control nodes and values are present after entering and leaving the
  fullscreen options overlay; and
- the layout remains usable at desktop and narrow mobile widths without horizontal
  overflow.

## Alternatives considered

- **Variant B: scope badges in the existing grid.** This is the smallest markup
  change and keeps every control visible, but the mixed hierarchy remains and users
  can still interact with irrelevant controls. Badges would need to be repeated on
  every new dependent option.
- **Variant C: one persistent card per station plus a shared area.** This makes all
  station-specific preferences configurable at once, but consumes substantial space
  for mostly irrelevant stations and competes with the selected-station model already
  established by the player.
- **Disable unavailable controls in place.** This preserves the current layout but
  leaves large disabled sections, especially the backdrop providers, and explains
  scope only after the listener encounters a disabled option.
- **Store complete settings profiles per station.** Rejected because spectrum,
  transition and remaining time are intentionally unbound. Duplicating those values
  would make station changes surprising and complicate persistence without adding a
  useful capability.

## Implementation status

Implemented in the web player on 2026-08-24. The deterministic local browser suite
passes 93 tests; 16 live-contract or platform-specific timing tests are intentionally
skipped in local mode.
