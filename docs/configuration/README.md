# Native configuration metadata

These JSON files are generated from the shared engine schema. Do not edit them
independently of `shared/settings_schema.h` and `shared/engine_settings.h`.
See [ADR 0011](../adr/0011-static-settings-schema.md) for the contract and layer boundary.

After building the `settings_schema_export` CMake target, run the executable with
`windows`, `macos`, or `linux` and save its UTF-8 stdout as `settings-<profile>.json`.
The default profile is Windows. No viewer instance or user settings are needed.

Consumers should use `ui && supported`, additionally filtering `desktopOnly` for
plugins. Host-owned options are explicitly marked. These files describe defaults
and constraints; they never contain personal configuration or credentials.
