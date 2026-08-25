# ADR 0005: Tabbed settings and explicit feature state

Date: 2026-08-24
Status: Accepted

## Context

ADR 0003 established the distinction between station-specific and global settings.
The resulting stacked sections make that scope visible, but leave a long main page
and give stations without contextual options an empty settings panel. Backdrops and
ratings also encode activation in a non-empty option list. That makes the feature's
on/off state inseparable from its retained configuration.

The settings need three clear concerns:

- common presentation settings: layout, cover transition, remaining time and the
  upcoming-track display;
- settings owned by the selected station: SST artwork/ratings or the 1980s laser
  show;
- station-independent visualizations.

Audio controls operate the player rather than its visual presentation, and the
share action operates on the complete setup.

## Decision

### Settings tabs

The main-page settings use an accessible tab interface in this order:

1. **Common** — layout, transition and duration, remaining-time mode and size, and
   the upcoming-track switch;
2. **Station** — the settings supported by the currently selected station;
3. **Visualizations** — MilkDrop, analyzer, BPM and their dependent options.

Common is selected initially. Audio and volume remain outside and above the tabs.
Share setup remains outside and below the tabs because it applies to all three.
The tab panels are the same real controls when settings are moved into the
fullscreen overlay; the player does not create a second form.

The tab list follows the ARIA tabs pattern: tabs and panels are linked with
`aria-controls` and `aria-labelledby`, only the selected tab is in the normal tab
sequence, and Left/Right/Home/End move and activate tabs.

Within a tab, each optional feature uses one compact master checkbox immediately
to the left of its title. Its dependent controls expand only while the feature is
enabled; retained values are not presented as an `Off` or `None` choice. The
provider list is shown directly within enabled Backdrops, followed by the
hide-cover option. Analyzer details are contextual: Spectrum shows bars and color,
while Oscilloscope shows style.
The controls use short labels rather than explanatory paragraphs, except for
concise safety information such as the laser strobe warning.

### Conditional Station tab

The Station tab exists only when the selected station exposes at least one
station-settings capability:

- StreamingSoundtracks exposes soundtrack artwork and ratings;
- 1980s.FM exposes the laser show;
- Adagio.FM, Death.FM and Entranced.FM expose no station settings and therefore
  have no Station tab or empty-state panel.

Its visible and accessible label is the selected station's short name (`SST` or
`1980s.FM`); it does not repeat a generic `Station` prefix.

The same declarative station capability model controls both tab availability and
runtime feature gating. Switching between SST and 1980s keeps the tab in place and
changes its contextual panel. When a station without settings is selected while
the Station tab is active, Common becomes active before the Station tab is removed.
Returning to SST or 1980s restores the tab without resetting any option values.

Tab changes, conditional-tab insertion/removal and dependent-option expansion use
opacity and geometry transitions. Outgoing content remains rendered until its exit
transition completes. With `prefers-reduced-motion: reduce`, the same semantic
changes occur without animation.

### Explicit feature state

Features whose activation is independent from retained options use named objects:

```json
{
  "sstBackdrops": {
    "enabled": false,
    "options": {
      "providers": ["fanart", "tmdb", "steamgriddb"],
      "cover": "hide"
    }
  },
  "sstRatings": {
    "enabled": false,
    "options": {
      "countries": ["DE", "US"]
    }
  },
  "transition": {
    "enabled": true,
    "options": {
      "style": 1,
      "durationMs": 1000
    }
  },
  "remainingTime": {
    "enabled": false,
    "options": {
      "mode": "countdown",
      "size": "small"
    }
  }
}
```

This is preferred to an ESLint-style tuple such as `[0, { options }]`: named
properties are self-describing, avoid positional meaning and leave room for future
feature metadata. `enabled` is a Boolean. Turning a feature off stops its runtime
work and collapses its subordinate controls, but preserves provider priority,
cover behavior and rating countries. `fanartKey` remains an independent local-only
setting and is never included in share URLs.

Transition labels are written out as **Crossfade**, **Flip horizontal** and
**Flip vertical**. A user selection briefly demonstrates that animation on the
selected control; the preview is omitted when reduced motion is requested. The
chosen transition and duration govern both cover changes and rating changes so
the visible content shares one motion language.

Share URLs use separate activation and option parameters for the same reason. For
example, `sstBackdrops=1` enables the feature while
`sstBackdropProviders=tmdb,fanart` configures its providers. Hiding the cover is
the default; `sstBackdropCover=show` explicitly keeps it visible. Ratings use
`sstRatings=1` and `sstRatingCountries=US`.

### Persistence boundary

The browser-local settings key changes to `24sevenfm-covers.player.v2`. The player
does not read or migrate `24sevenfm-covers.player` and does not translate legacy
property names. Existing browser preferences therefore reset once to the new
defaults. This deliberate reset keeps legacy shapes out of the runtime and test
surface; v2 data is still coerced defensively when it is corrupt or partial.

## Consequences

- The default page is shorter and the main settings have stable, explicit scope.
- Stations with no contextual choices no longer present a dead-end tab or empty
  message.
- Backdrops and ratings can be disabled without erasing their configuration.
- Transitions and remaining time use the same explicit activation model and do
  not need sentinel radio choices.
- Progressive disclosure reduces the initial number of visible controls while
  preserving every configured value.
- A one-time preference reset is accepted in exchange for removing migration code.
- Adding a station feature requires a capability and contextual panel; adding a
  global visualization does not change station definitions.
- ADR 0003's capability and runtime-gating direction remains valid, while its
  stacked presentation, empty station panels, sparse SST feature values and legacy
  migration decision are superseded by this ADR.
