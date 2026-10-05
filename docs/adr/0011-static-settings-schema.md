# ADR 0011: Static engine settings schema

Date: 2026-10-04

## Decision

The shared C++ layer publishes the native viewer configuration independently of a
running engine, window, preferences store, network, or platform SDK. The interface
is `shared/settings_schema.h`:

```cpp
const auto& descriptors = ssccfg::settingsSchema(ssccfg::Profile::MacOS);
const auto* duration = ssccfg::findSetting("fadeMs", ssccfg::Profile::MacOS);
```

`shared/settings_schema_json.h` additionally exposes `settingsSchemaJson(profile)`.
The standalone `settings_schema_export [windows|macos|linux]` executable writes that
versioned UTF-8 JSON document to stdout. Unknown arguments fail with exit status 2.
Build with `cmake -S lib -B <build>` and
`cmake --build <build> --target settings_schema_export` (add `--config Release` for
multi-configuration generators). It does not link a renderer or initialize the
engine. `COVERFETCH_BUILD_SETTINGS_SCHEMA=OFF` omits this tool.

The export is metadata, not current user preferences. It contains no listener key
or other saved value. `fanartClientKey` is explicitly sensitive, uses a password
control, and has an empty default.

## Contract

There are 19 engine properties and two explicitly host-owned properties. Each
descriptor has a canonical key, profile-specific legacy storage key, label, group,
type, default, UI visibility, supported flag, owner, and desktop-only flag.
Depending on type it also carries bounds, slider step, unit, maximum length,
choices, minimum selection count, uniqueness and ordering, and dependencies.

* Canonical keys stay stable across hosts; for example `showRemaining` maps to
  Windows `showRemaining` and macOS/Linux `countdown`. `rollDigits` maps to Windows
  `roll`. `layout` maps to `poster` in macOS/Linux. Native adapters retain their
  existing bool/integer/string storage representations and settings locations.
* `ui && supported` selects editable properties for a profile. Plugins additionally
  omit `desktopOnly` controls, notably station selection (the player supplies it).
* Choices use stable string values; numeric choices are parsed as integers. Station
  choices are generated from `stations.h`, persisted as station IDs, and translated
  to indices only inside the engine. Ordered providers use unique CSV IDs.
* `enabledWhen` is an AND of comparisons against canonical values represented as
  strings (`true`, `false`, decimal integer, or station ID). Supported operators are
  `equal` and `not-equal`; an empty list means no dependency. Disabling a control
  never clears its saved value. `comingNext` deliberately has no countdown dependency.
* `appliesWhen` separately describes semantic eligibility. Windows historically
  allows some SST-only options to remain editable while another station plays;
  macOS disables them. This distinction is preserved.
* `control` suggests checkboxes, native radio groups, sliders, ordered checkbox
  lists, or password fields. For ordered lists `selectable=false` means reorder-only.
* `ratingCountryMinimumSelections` retains Windows' at-least-one-country rule;
  macOS/Linux permit neither country. The UI slider step is not a persistence
  constraint: valid existing durations such as 1234 ms still load unchanged.
* `posterBlur`, `borderRadius`, and `fanartClientKeyVerifiedAt` are non-UI properties.
  The timestamp is derived state, not a user-editable setting. Window position/size,
  fullscreen, reload, key verification and debugging commands are native window
  state or actions rather than configurable engine values, and are not exported.

The JSON root has `schemaVersion: 1`. Future consumers should ignore unknown
properties. Changing key meanings or incompatible representations requires a
schema version change; adding settings does not.

## Integration and compatibility

`engine_settings.h` owns the portable `EngineSettings` object. Boolean/integer
declarations generate both member defaults and schema metadata, and drive the
existing Windows persistence loop. `CoverEngine::Settings` remains an alias, so
hosts keep their source-level API. Provider validation consumes the exported
choices. INI I/O stays behind `_WIN32` and `ConfigStore` stays platform-free.

Windows slider bounds, steps, snapping and key length now use these definitions.
macOS registers its defaults directly from its profile and takes slider bounds and
ticks from it. Registering defaults does not overwrite saved NSUserDefaults values.
All platforms now use the Windows reference defaults: fill layout, countdown off,
small countdown size, rolling digits off and Coming Next off. No profile may override
engine defaults. Previously saved user preferences continue to take precedence.
Slider steps stay 100 ms on Windows and 250 ms on macOS.

The Linux adapter reads fallback values directly from the shared schema, both in
the renderer adapter and settings controls, without writing them to QSettings.
Its current UI offers provider reordering but no selection, and no duration setting.

Native UIs still own widget construction, localization, platform events, storage
encoding, and window operations. `alwaysOnTop` (macOS/Linux) and `reducedMotion`
(Linux preference combined with OS policy) are host-owned. This change does not
regenerate native resource layouts or migrate users' preference files. Native
rendering and animation behavior, including countdown sizing and Next-card layout,
are untouched.

## Validation

Portable tests compare every saved engine option against the schema, verify the
native UI inventory, unique keys, dependencies, profile defaults and aliases,
numeric clamps versus UI snapping, first-run station handling, provider validation,
secret normalization, and deterministic parseable JSON. Existing native and common
regression suites continue to run alongside these tests.

Initial schema verification on 2026-10-04: 236/236 Windows tests, 141/141 macOS tests, macOS live
TLS/feed/image smoke and the native UI check, plus the six schema tests (454
assertions) compiled directly with GCC in Ubuntu 24.04/WSL. All three checked-in
JSON files exactly match the exporter. Windows DV and Winamp release binaries and
the macOS application were built, backed up and installed, with matching installed
hashes and running viewer paths verified. Windows INI and macOS preferences stayed
unchanged.

The macOS UI check was also made independent of scheduling and physical pointer
position: its nominal 150 ms callback was observed arriving at 313 ms, after the
250 ms Next animation. It now checks an offscreen start followed by inward motion,
while the controller suite verifies intermediate timing. The hover fixture sends
mouse-enter before asserting visible controls. Neither adjustment changes product
animation or rendering behavior.

Follow-up: Windows is the reference for **all startup defaults**, including macOS
and Linux. The schema regression now compares every property's default across all
three profiles. The native macOS UI check asserts Windows first-run values before
setting up its visual fixtures. The Linux adapter test checks both missing defaults
and explicit saved overrides in the model and native controls. Verification:
236 Windows tests, 141 macOS tests plus native UI, 140 Linux CTest entries, and the
rebuilt Linux adapter suite (7 cases, 82 assertions). All passed; Windows INI and
macOS saved preferences remained unchanged. Generated JSON exports were refreshed.
