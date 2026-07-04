# FlowKit Plugin Health Dashboard

An Obsidian plugin that scores every installed community plugin on five signals,
so you can tell at a glance which plugins are healthy and which are risks.

## Metrics

| Metric | What it measures | Source |
|---|---|---|
| **Quality** | Composite of manifest completeness + the measured signals below | Estimated |
| **Maintenance** | How recently the plugin was updated | Measured (online) |
| **Performance** | Startup/runtime cost heuristic | Estimated |
| **Popularity** | Community download count (log scale) | Measured (online) |
| **Compatibility** | `minAppVersion` vs. your Obsidian version; desktop-only on mobile | Measured (local) |

Each plugin also gets a blended **Overall** score, and the header shows a
vault-wide average plus unmaintained and at-risk counts.

### Maintained or not

Beyond the 0–100 maintenance score, every plugin carries a plain
maintained/not badge derived from how long ago it was last updated:

| Badge | Meaning |
|---|---|
| **Maintained** | Updated within the last 6 months |
| **Aging** | No update in 6–18 months |
| **Unmaintained** | No update in over 18 months — likely abandoned |
| **Unknown** | No update data (offline, or not a community plugin) |

Scores are honest about confidence: **Compatibility** is fully local and always
available; **Popularity** and **Maintenance** come from Obsidian's public
community data when online; **Performance** and **Quality** are heuristics
(marked with `~`) because Obsidian exposes no direct per-plugin profiling API.

### Extra signals

Each plugin row also surfaces:

- **Update available** — a newer version is published than the one you have
  (derived from the community stats' per-version data). The header shows an
  **Updates** count.
- **Sideloaded** — the plugin isn't in Obsidian's community list, so it skipped
  community review. A trust signal, shown when online.

## At a glance

The top of the dashboard shows a **vault-health gauge** with a letter grade
(A–F) and a one-line verdict, backed by tiles for plugin count, available
updates, unmaintained plugins, and at-risk plugins.

Below it, **Insights** turns the scores into a short, ranked to-do list — the
incompatible plugins that won't load, the ones that look abandoned, the updates
waiting, the sideloaded ones that skipped review — most urgent first.

## Free vs Pro

FlowKit is useful for free forever, and a one-time **Pro** unlock adds the
power-user tooling. Pro is verified fully offline (a signed license key — no
account, no server, no telemetry).

### Free

- The full **five-metric scorecard** and blended overall for every plugin
- **Vault-health gauge**, letter grade, and summary tiles
- The **top Insight** — your single most important thing to fix
- **Search, filter, sort**, and the per-row menu (enable/disable, open settings,
  open on GitHub, mute)
- Fully **offline-capable**; online enrichment is optional

### Pro ($6 one-time)

- **Full Insights** — the complete ranked list, not just the top item
- **One-click bulk actions** — disable all incompatible/abandoned plugins, or
  mute all sideloaded ones, straight from an insight
- **Export reports** — Markdown *and* CSV of the full scorecard
- **Health trends** — FlowKit records your vault health over time and shows the
  delta since the last scan, with a sparkline
- **Auto-refresh on open** — always see a fresh scan

Enter your license key under **Settings → FlowKit Pro** to unlock.

## Usage

- Click the **activity** ribbon icon, or run the command
  **"Open Plugin Health Dashboard"** — the dashboard opens in the right sidebar.
- **Search** by name/author, **filter** (needs attention, unmaintained,
  incompatible, update available, disabled, muted), and **click any column** to
  sort. Hover any score for the reasoning behind it.
- **Row menu (⋮)** — enable/disable the plugin, open its settings, open its
  GitHub repo, or mute it from the counts.
- **Insights** — act on the ranked list; Pro adds one-click bulk fixes.
- **Export** *(Pro)* writes the current (filtered) report to a Markdown note or a
  CSV file in your vault.
- **Refresh** re-scores and re-downloads community data on demand.

## Settings

- **FlowKit Pro** — paste your license key to unlock Pro features (verified
  offline). Shows your Pro status and what it unlocks.
- **Online enrichment** — fetch popularity + maintenance from Obsidian's public
  community data. Turn off to stay fully offline (those two metrics then show as
  unavailable). Local-first: no telemetry, no accounts.
- **Show disabled plugins** — include installed-but-disabled plugins.
- **Auto-refresh on open** *(Pro)* — recompute every time the dashboard opens.
- **Muted plugins** — plugins you've muted from the at-risk / unmaintained
  counts; clear the list here.

## Development

```bash
npm install
npm run dev     # watch build → main.js
npm run build   # typecheck + production build
npm test        # run the scoring engine test suite
```

The test suite (`test/`) executes the real scoring code against mock plugin
data — verifying compatibility, popularity, maintenance, performance, quality,
the blended overall, the maintained/not status, update-available detection, the
sideload flag, the offline license verifier, and the insights engine — so the
core logic is checked even without a live Obsidian vault.

### Licensing (author-only)

Pro is gated by an offline Ed25519 license key (`src/shared/verifyLicense.mjs`
verifies against the public key in `src/license/publicKey.ts`). To mint a key
for a customer you need the private signing key at
`scripts/.license-private.key` (gitignored — **back it up; it can't be
regenerated**):

```bash
npm run license:generate -- customer@email.com
```

Copy `main.js`, `manifest.json`, and `styles.css` into
`<vault>/.obsidian/plugins/flowkit-health-dashboard/` to test in Obsidian, or
symlink the repo there during development.

## How scoring works

See [`src/scoring.ts`](src/scoring.ts) — each metric is a small, documented
function returning a value plus a `measured | estimated | unavailable` source
tag. Data sources live in [`src/dataSources.ts`](src/dataSources.ts).
