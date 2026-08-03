# Changelog

All notable changes to FlowKit Plugin Health Dashboard are documented here. This
project follows [Semantic Versioning](https://semver.org/).

## [1.2.0] - 2026-08-03

A UX pass driven by an adversarial review — four independent critiques, each
one opposed and then judged, plus an outside roundtable. Most of what follows
are defects, not taste.

### Fixed

- **Findings lied about their contents.** Clicking "3 plugins score below 50"
  opened a table of a dozen mostly-fine plugins, because the card mapped to a
  nearby filter rather than to its own cohort. Every finding now scopes the
  table to exactly what it counted.
- **Muted plugins leaked into filtered views** even though they're excluded
  from every count and every finding.
- **The table opened best-first**, putting the single worst plugin — the reason
  the product exists — at the bottom of the list, below the fold. It now opens
  worst-first.
- **Every click threw you back to the top of the page.** Filtering, muting,
  enabling and disabling all rebuilt the whole view. They now update in place,
  keeping your scroll position and keyboard focus.
- **Muting a plugin could trigger a multi-megabyte download.** Single-plugin and
  bulk actions no longer touch the network at all.
- Column headers and plugin names are now real buttons — the table was
  mouse-only.

### New

- **"Since you last looked."** FlowKit now remembers what changed between
  visits — a plugin that started throwing errors, was pulled from the directory,
  or went back to normal — and leads with it. Previously it computed exactly
  this, showed a toast, and forgot it.
- **Copy bug report.** One click turns a plugin's recorded errors into a
  paste-ready issue: versions, platform, and each distinct error with counts and
  recency. Stack traces included with Pro.
- **Copy summary**, and **Markdown export is now free and unlimited** (CSV stays
  Pro). It was rationed to one per install, which is a strange thing to do to
  the only artefact that carries your name outward.
- **The all-clear screen is designed.** A vault with nothing wrong used to show
  four green words; it now states what was checked and found clean.
- The header says **how old the community data is** — the normal case was
  reading day-old numbers under a green "Online" label.

### Changed

- The hero loses its 116px ring, which drew one number four different ways and
  could collapse into a giant "—". The score and grade stay, plus the worst
  plugin by name — an average hides the one plugin you actually need to see.
- Stat tiles are one line instead of four cards.
- Healthy metrics recede; only exceptions carry colour. A row with one problem
  now shows one coloured chip instead of seven competing ones.
- **Popularity is no longer painted on the health scale.** Its own tooltip calls
  it "context, not health", but a good niche plugin still showed red for being
  niche.
- Good state is silent: no more "Maintained" badge on every healthy row.
- The locked bulk-fix button now shows you the exact set it would change, with
  evidence, before anything mentions money.

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
