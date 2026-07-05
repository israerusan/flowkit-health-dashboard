# Changelog

All notable changes to FlowKit Plugin Health Dashboard are documented here. This
project follows [Semantic Versioning](https://semver.org/).

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
