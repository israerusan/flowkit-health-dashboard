# Changelog

All notable changes to FlowKit Plugin Health Dashboard are documented here. This
project follows [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-08-03

### Errors, traced back to the plugin that caused them

FlowKit now watches for runtime errors and works out which plugin they came
from, by reading the stack trace. "Obsidian's been weird lately" becomes
"Templater threw 40 errors this week, and here's the one that keeps repeating."

- **New Reliability metric**, weighted 25% — the only score here derived from
  watching a plugin actually run rather than reading its metadata.
- **Errors a plugin catches and logs itself are shown but never scored.** A
  plugin that reports its failures honestly shouldn't rank below one that
  swallows them.
- **Reliability stays blank until FlowKit has watched for a few hours.** A
  plugin that hasn't thrown in ninety seconds isn't thereby reliable.
- Errors that can't be traced to a specific installed plugin are discarded
  rather than blamed on something.
- New "Throwing errors" filter, a row badge with the count, and the messages in
  each plugin's detail panel.
- **Pro** adds the full stack traces, and background monitoring now also tells
  you when a plugin *starts* erroring.

Everything stays on your machine. Stack traces can quote file paths and note
titles, so nothing is ever transmitted; you can turn the watcher off or clear
the log in settings.

### Changed

- Weights are now Compatibility 25%, Reliability 25%, Maintenance 25%,
  Footprint 15%, Hygiene 5%, Popularity 5%. Because that changes what a score
  means, trend history from 1.0.0 is kept but starts a fresh line — the same
  guard added in 1.0.0.

## [1.0.0] - 2026-08-03

The scoring model is rebuilt, the free tier now includes the complete
diagnosis, and Pro is about acting on it rather than seeing it.

### The score means something now

- **"Performance" is gone; "Footprint" replaces it.** The old metric was driven
  by how many plugins your vault had enabled, so every enabled plugin got the
  *same* score — you could sort by that column and watch nothing move. Footprint
  measures what each plugin actually loads at startup, read from disk.
- **Overall is a weighted blend** — Compatibility 30%, Maintenance 30%,
  Footprint 20%, Hygiene 10%, Popularity 10% — and tells you how much data it
  was built from. Previously it was a flat average of whatever happened to be
  available, so the same plugin could score 73 online and 93 offline.
- **A plugin that can't load is capped at 20**, and one removed from the
  community directory at 30. They used to sit in the 70s.
- **Disabling a plugin no longer changes its score.** It could previously go
  *up*.
- **"Quality" is now "Manifest hygiene"** and only measures the manifest. It
  used to fold in the other metrics and then get averaged beside them, which
  quietly counted them twice — and it gave points for having a donate link.
- **Popularity is a rank, not a raw count.** The old curve put 56% of the entire
  directory in the red; a niche plugin is not a worse plugin.
- **Plugins that are finished are no longer called abandoned.** Ones with a long
  release history whose users are on the newest version now read "Stable".
  Calendar was previously flagged for bulk-disabling.
- **New: plugins removed from the community directory are called out** — a
  different and more serious thing than one you installed yourself.

### Fixed

- False "Update" badges on Calendar, Linter, Periodic Notes, Clipper and Khoj,
  caused by beta releases being read as the latest version.
- The dashboard could get stuck on its loading spinner, needing an Obsidian
  restart.
- One offline moment could pin the whole session to "Offline" until you
  restarted, silently dropping two of five columns.
- The header claimed "full metrics" even when half the community data was
  missing.
- Typing a license key was effectively broken — the field was destroyed after
  each character.
- Searching jumped your cursor to the end of the box and rebuilt the whole page
  on every keystroke.
- Exporting twice in the same second failed; plugin names containing `|` broke
  the report table.

### Free tier

- **The complete "What to fix" list**, not one item and a lock.
- **Select any row to see why it scored what it did** — every metric, its
  weight, and its evidence.
- **A 30-day health trend**, recorded whether or not you open the dashboard.
- **Opens in a main tab**, with a card layout on narrow screens and phones.
- **A status-bar readout** that turns red when something needs attention.
- **One full Markdown report**, no strings.
- Auto-refresh on open, previously Pro.
- Keyboard-operable table, screen-reader labels, and higher-contrast score chips.
- The dashboard opens instantly — community data is cached instead of
  re-downloading ~3.7 MB every session.

### Pro — now $9 one-time (was $6)

- **Bulk fixes with a review step and undo.** You see exactly what will change
  before it changes, and can put it back.
- **Background monitoring** — get told when a plugin turns incompatible, goes
  stale, or is pulled from the directory.
- **Unlimited reports**, as a real document with the findings, not a bare grid.
- **90 days of history**, where free keeps the last 30.

### Note for existing Pro users

Your saved trend history was recorded by the old scoring model and isn't
comparable to the new one, so the chart starts fresh rather than drawing a step
you didn't cause. Old readings are kept, just not plotted.

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
