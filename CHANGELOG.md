# Changelog

All notable changes to FlowKit Plugin Health Dashboard are documented here. This
project follows [Semantic Versioning](https://semver.org/).

## [0.2.2] - 2026-07-05

### Changed
- **Renamed to "FlowKit Health Dashboard"** (was "FlowKit Plugin Health
  Dashboard") and reworded the description. Obsidian's community-plugin review
  rejects the words "Obsidian" and "plugin" anywhere in the manifest name,
  description, or id — even for a plugin whose job is scoring add-ons — so both
  had to drop "plugin". The ribbon tooltip and command name were updated to
  match; the plugin id, license binding, and settings are unchanged.

### Internal
- Corrected the manifest-contract test to enforce the review bot's actual rule
  (no "obsidian"/"plugin" substring in name/description/id, no exception), so
  this class of failure is caught locally from now on.

## [0.2.1] - 2026-07-05

### Internal
- **`npm run lint` now runs `eslint-plugin-obsidianmd` — the exact ruleset
  Obsidian's automated community-plugin review uses** — as a hard gate
  (`eslint . --max-warnings 0`), so review failures are caught locally before a
  release instead of after (a failed review delists the plugin). Added a
  **manifest-contract test** and a reusable **release checklist** in `docs/`.

### Fixed
- Issues surfaced by the new lint gate (no behavior change): the gauge arc's
  transition moved from an inline JS style to a `styles.css` rule; removed an
  unnecessary `TFile` cast and a floating promise; narrowed the loaded-settings
  type; and switched the esbuild config off the `builtin-modules` package to
  Node's built-in `module.builtinModules`.
