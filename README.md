# FlowKit Health Dashboard

> Know which of your add-ons still work, which have been pulled, and which are
> quietly weighing your vault down — and fix them without hunting through
> settings.

FlowKit scores every installed community plugin and turns the result into a
ranked, evidence-backed to-do list. Every finding tells you what it saw and
why it matters; select any row to see exactly how its score was built.

The **complete diagnosis is free**. Pro is for acting on it in one click,
keeping a record, and being told when something changes.

<!-- SCREENSHOT SLOT — drop a real Obsidian capture here to lift conversions.
     ![FlowKit dashboard: vault-health gauge, letter grade, and the ranked plugin scorecard](docs/assets/hero.png)
     Suggested shot: the dashboard in a main tab showing the "What to fix" list
     with a row expanded to its reasoning panel. Save as docs/assets/hero.png -->


## Metrics

| Metric | What it measures | Weight | Source |
|---|---|---:|---|
| **Compatibility** | `minAppVersion` vs. your Obsidian version; desktop-only on mobile | 30% | Measured (local) |
| **Maintenance** | How recently it was released, allowing for plugins that are simply finished | 30% | Measured (online) |
| **Footprint** | Code and styles the plugin loads at startup, read from disk | 20% | Measured (local) |
| **Manifest hygiene** | What the plugin's manifest declares | 10% | Measured (local) |
| **Popularity** | Download rank within the directory — context, not health | 10% | Measured (online) |

**Overall** is a weighted blend of those five, renormalised over whatever data
is actually available, and shown alongside a **confidence** figure so a score
built on three signals doesn't read like one built on five. Below 60%
confidence the letter grade is withheld rather than guessed.

Two things override the blend, because they are risk facts rather than
quantities worth averaging:

- a plugin that **can't load** on your setup is capped at **20**
- a plugin **removed from the community directory** is capped at **30**

A missing signal can never raise a score. Select any row in the dashboard to
see each metric's value, weight, and the evidence behind it.

### Maintained or not

Beyond the 0–100 maintenance score, every plugin carries a plain
maintained/not badge derived from how long ago it was last updated:

| Badge | Meaning |
|---|---|
| **Maintained** | Released within the last 6 months |
| **Aging** | No release in 6–18 months |
| **Stable** | No recent release, but many published versions and most users on the newest — finished, not abandoned |
| **No recent release** | Nothing in over 18 months, and no sign it has settled into maturity |
| **Unknown** | No release data (offline, or not a community plugin) |

Release age alone cannot establish abandonment, and this is deliberately worded
so it doesn't pretend otherwise. Plenty of excellent plugins are simply done.

### Extra signals

Each plugin row also surfaces:

- **Update available** — a newer *stable* version is published than the one you
  have. Prereleases are ignored, so a `-beta` build doesn't nag you about an
  update you can't install.
- **Delisted** — the plugin was in Obsidian's community directory and has since
  been removed. Worth knowing why before keeping it.
- **Local install** — never in the directory: installed manually or via BRAT, so
  it skipped community review. A neutral fact, not a fault.

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

The whole diagnosis is free. Pro is for *acting* on it.

### Free

- The **complete ranked "What to fix" list** — every finding, not a teaser
- The full **five-metric scorecard**, weighted overall, and confidence figure
- **Select any row** to see why it scored what it did: each metric's value,
  weight, and evidence
- **Vault-health gauge**, letter grade, and summary tiles that filter the table
- A **30-day health trend**, recorded whether or not you open the dashboard
- A **status-bar readout** that turns red when something needs attention
- **One full Markdown report**, no strings
- **Search, filter, sort**, and the per-row menu (enable/disable, open settings,
  open on GitHub, mute)
- Fully **offline-capable**; online enrichment is optional

### Pro ($9 one-time)

- **Bulk fixes in one click** — review exactly which plugins will change and
  why, apply it together, and **undo** if you disagree
- **Background monitoring** — get told when a plugin turns incompatible, goes
  stale, or is pulled from the community directory. Most useful right after an
  Obsidian update, which is when nobody thinks to look
- **Unlimited reports** — Markdown *and* CSV, as a document with the findings
  and methodology, not a bare grid of numbers
- **Full history** — 90 days of vault health, per-metric trends, exportable

Purchase: [Buy Me a Coffee — FlowKit Pro](https://buymeacoffee.com/vaultspotlight/e/560206). License keys are verified **offline** (Ed25519) — no account, server, or subscription, and one key works on every device you own.

Key didn't arrive, or want a refund? Email <iavila01@gmail.com>.

### Activate Pro

1. Purchase on [Buy Me a Coffee](https://buymeacoffee.com/vaultspotlight/e/560206).
2. Your license key is emailed to you **automatically, within seconds** — the whole thing is fully automated, no waiting on a human.
3. Obsidian → **Settings → FlowKit Pro** → paste the key. Pro unlocks immediately (offline verification).

## Install

**Community plugins (recommended):** open **Settings → Community plugins**, search **FlowKit**, and install it — one click, auto-updates.

**Manual install:** copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/flowkit-health-dashboard/` and enable it in Settings → Community plugins.

## Usage

- Click the **activity** ribbon icon, or run the command
  **"Open health dashboard"** — it opens in a main tab. On narrow panes and
  phones the table becomes one card per plugin.
- Start with **What to fix**. Selecting a finding filters the table to exactly
  the plugins it names.
- **Select any row** to open its reasoning panel: each metric's value, weight
  and evidence, plus enable/disable, open settings, GitHub, and mute.
- **Search** by name/author, **filter** (needs attention, no recent release,
  incompatible, delisted, local installs, update available, disabled, muted),
  and **click any column** to sort.
- **Export** writes a report — findings, scorecard and methodology — to a
  Markdown note or CSV. Free includes one; Pro is unlimited and adds CSV.
- **Refresh** re-scores and re-downloads community data on demand. Otherwise the
  cached data is reused for a day so the dashboard opens instantly.

## Settings

- **FlowKit Pro** — paste your license key to unlock Pro features (verified
  offline). Shows your Pro status and what it unlocks.
- **Online enrichment** — fetch popularity + maintenance from Obsidian's public
  community data. Turn off to stay fully offline (those two metrics then show as
  unavailable). Local-first: no telemetry, no accounts.
- **Show disabled plugins** — include installed-but-disabled plugins.
- **Re-download community data on open** — off by default; the cached scan is
  reused for a day, and Refresh always refetches.
- **Background monitoring** *(Pro)* — check quietly for plugins that turn
  incompatible, go stale, or get pulled from the directory.
- **Muted plugins** — plugins you've muted from the at-risk counts; clear the
  list here.

## Development

```bash
npm install
npm run dev     # watch build → main.js
npm run build   # typecheck + production build
npm test        # run the scoring engine test suite
```

The test suite (`test/`) executes the real scoring code against mock plugin
data — verifying compatibility, popularity, maintenance, footprint, hygiene,
the weighted overall and its confidence figure, the incompatible and delisted
caps, the guarantee that a missing signal never raises a score, the stability
carve-out, the persisted-cache round trip, the maintained/not status,
update-available detection (including prerelease handling), the
delisted-vs-local split, the offline license verifier, and the insights engine — so the
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
