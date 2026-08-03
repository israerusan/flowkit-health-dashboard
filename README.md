# FlowKit Health Dashboard

> **Something in your vault is broken, slow, or throwing errors. Find out which
> plugin is doing it.**

Obsidian tells you nothing about what your plugins are doing to it. When typing
starts lagging, when a shortcut silently stops working, when the app throws an
error that names no one — the only tool you have is disabling things by hand
until it goes away.

FlowKit is the tool for that afternoon.

| The question | What FlowKit does |
|---|---|
| **"Something's broken and I don't know what."** | Finds it by elimination — switches off half your plugins, asks if it's still happening, halves again. Seven questions for forty plugins, and your exact setup restored afterwards. |
| **"Why is my vault so slow?"** | Times every plugin's load, and catches the ones holding a timer that blocks the interface every time it fires. |
| **"This started recently."** | Records every install and update, and tells you when a plugin started erroring right after one of them. |
| **"Why did this error happen?"** | Traces runtime errors back to the plugin that threw them, and searches that plugin's issue tracker for it. |
| **"Is this shortcut broken?"** | Finds the plugins claiming the same hotkey, where one of them silently never fires. |
| **"What should I clean up?"** | Scores everything installed, and ranks what to disable first by trouble removed per feature lost. |

Everything runs locally. The **complete diagnosis is free** — Pro is for the
work you can't reasonably do by hand.

<!-- SCREENSHOT SLOT — drop a real Obsidian capture here to lift conversions.
     ![FlowKit dashboard: vault-health gauge, letter grade, and the ranked plugin scorecard](docs/assets/hero.png)
     Suggested shot: the dashboard in a main tab showing the "What to fix" list
     with a row expanded to its reasoning panel. Save as docs/assets/hero.png -->


## Find what's breaking your vault

The standard advice in every Obsidian support thread is *"disable half your
plugins and see if it goes away."* It's correct. It's also twenty minutes of
tedious clicking that most people abandon halfway through, having lost track of
which half they were on and which plugins were off to begin with.

FlowKit runs those rounds:

```
Finding what's breaking your vault        14 plugins still possible · round 2 of 7
Testing for: typing lags in long notes

FlowKit has switched off 7 plugins. Reproduce what you were seeing, then
tell it whether the problem is still there.

  ▸ Currently switched off (7)

  [ The problem is gone ]  [ Still happening ]            [ Stop and restore ]
```

- **Your setup is saved before it starts**, and every plugin the search
  switched off goes back on when it ends — including if you stop halfway
  through, or restart Obsidian mid-search. The session survives a restart,
  because reproducing a problem often needs one. Anything you switch on
  yourself while it runs is left exactly as you left it: the search undoes its
  own work, not yours.
- **The last suspect is actually tested before it's accused.** Narrowing to one
  plugin isn't proof — so FlowKit switches that one off and asks once more. This
  is why *"no plugin is responsible"* is an answer it can give you, pointing at
  a theme, a CSS snippet or Obsidian itself rather than blaming something
  innocent.
- **Nothing is uninstalled**, at any point.

## "It started right after that update"

FlowKit records every install, update, removal and toggle as it sees them. It
already knew when each plugin's version changed, and separately when each plugin
started throwing errors. Putting the two together produces the most useful
sentence it can say:

> **Templater** started throwing errors **2 hours** after it updated v2.4.0 → v2.4.1.

Stated as a sequence, not a cause — because that's what it is. It's usually
where to look first.

## Metrics

| Metric | What it measures | Weight | Source |
|---|---|---:|---|
| **Compatibility** | `minAppVersion` vs. your Obsidian version; desktop-only on mobile | 25% | Measured (local) |
| **Reliability** | Errors the plugin actually threw, on your machine | 25% | Measured (local) |
| **Maintenance** | How recently it was released, corrected by whether its repository is still moving | 25% | Measured (online) |
| **Footprint** | What it costs to run: code loaded at startup, measured load time, and fast repeating timers | 15% | Measured (local) |
| **Manifest hygiene** | What the plugin's manifest declares | 5% | Measured (local) |
| **Popularity** | Download rank within the directory — context, not health | 5% | Measured (online) |

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

### What this score is *not*

It is not a judgement of whether a plugin is any good, whether its code is safe,
or whether you should uninstall it. It measures four things: whether a plugin
**can run on your setup**, whether it has **thrown errors on your machine**,
whether it is **still being worked on**, and **what it costs to load**.

A plugin you love can score badly for being finished. A plugin you never open
can score perfectly. Popularity is context, not health — a niche plugin is not a
worse plugin. **Treat a low score as a reason to look, not a reason to act.**
The dashboard says this too, under the table, and every exported report carries
it — a letter grade quoted out of context is exactly the misreading it exists to
prevent.

### Footprint — what a plugin costs to run

Bundle size on its own is a misleading cost signal: a 60 KB plugin polling four
times a second is worse for your vault than a 400 KB one that loads and sits
idle. Footprint blends three measurements and reports **the worst of them**,
because these are alternative ways of being expensive, not components of one
quantity:

| Signal | How it's measured |
|---|---|
| **Code loaded at startup** | `main.js` + `styles.css`, read from disk |
| **Load time** | Timed for real, for every plugin load FlowKit witnesses |
| **Repeating timers** | Watched as they're created; a timer firing every minute or slower costs nothing |
| **Timer callback cost** | How long each of those callbacks actually runs for |

That last one is the number that explains a laggy vault. Obsidian's interface is
single-threaded, so a callback taking 180 ms is 180 ms in which nothing you type
appears — and a plugin can hold a slow callback on a *slow* timer and look cheap
by every other measure here.

**A plugin FlowKit couldn't observe is never penalised for it.** Load time and
timers can only ever *lower* a score, and only when they were actually measured
— absence of evidence is never treated as evidence of idleness.

FlowKit times every plugin Obsidian loads after it, and every plugin you enable
from anywhere afterwards. That's a partial sample on most vaults, and the
startup strip says so rather than quoting a total that implies the rest are
free. **Profile startup** fills in the gaps by restarting each remaining plugin
in turn and timing it — explicit, confirmed, and it tells you exactly what it's
about to do first. Single plugins can be measured the same way from the row
menu.

### Plugins that fight each other

Two perfectly healthy plugins bound to the same shortcut means one of them
**silently never fires**, and nothing in Obsidian's own UI tells you which. No
per-plugin score could ever surface that, because neither plugin is at fault —
so FlowKit reports it as a vault-level finding, badges both rows, lists the
clashes in each plugin's panel, and links straight to the hotkey settings.

Duplicate **command names** across plugins are reported too: they're
indistinguishable in the command palette.

None of this is scored. Docking a plugin for a collision it didn't choose would
be inventing a defect.

### When Obsidian itself updates

This is the moment people actually open a plugin-health dashboard: a release
landed and something stopped working. FlowKit notices the version change,
re-checks everything against the new Obsidian, and **leads the dashboard with
what that update broke** — by name, with a way straight to them. When nothing
broke, it says that instead, which is worth just as much.

### Reliability — errors, traced back to the plugin that threw them

When something in Obsidian throws, FlowKit reads the stack trace, works out
which plugin the failing code belongs to, and records it. Over time that turns
"Obsidian's been weird lately" into "Templater has thrown 40 errors this week,
here's the one that keeps repeating."

- **Uncaught exceptions and unhandled rejections** are what the score is built
  from.
- **Errors a plugin catches and logs itself** are recorded and shown for
  context, but deliberately *never* counted against its score — a plugin that
  reports its failures honestly shouldn't rank below one that swallows them.
- Reliability reads **unavailable** until FlowKit has been watching for a few
  hours. A plugin that hasn't thrown in ninety seconds isn't thereby reliable.
- Errors that can't be traced to a specific installed plugin are **discarded**,
  not guessed at.

All of it stays on your machine. Error messages and stack traces can quote file
paths and note titles, so they are never transmitted anywhere, and you can turn
the whole thing off or clear the log in settings.

### Maintained or not

Beyond the 0–100 maintenance score, every plugin carries a plain
maintained/not badge derived from how long ago it was last updated:

| Badge | Meaning |
|---|---|
| **Maintained** | Released within the last 6 months |
| **Active** | No recent release, but its repository was pushed to in the last 6 months — being worked on, just not tagged |
| **Aging** | No release in 6–18 months |
| **Stable** | No recent release, but many published versions and most users on the newest — finished, not abandoned |
| **No recent release** | Nothing in over 18 months and no sign of maturity, or an archived / deleted repository |
| **Unknown** | No release data (offline, or not a community plugin) |

Release age alone cannot establish abandonment, and this is deliberately worded
so it doesn't pretend otherwise. Plenty of excellent plugins are simply done.

**The repository can settle it.** With **Check repository activity** switched on
(off by default), FlowKit asks GitHub whether a plugin's repo is archived or
still being pushed to — the one signal that genuinely separates *finished* from
*abandoned*:

- an **archived** repository is the author saying, on the record, that nothing
  more is coming: it outranks the maturity carve-out entirely
- a repo **pushed to this year** reads as **Active**, however old its newest tag
- a repo **untouched for two years** overrules the carve-out the other way —
  many published versions means nothing if nobody has touched the code

Only plugins whose verdict is genuinely in doubt are looked up, a few per scan,
cached for a week. Nothing is sent but a repository name, which is already
public. It is off by default because it is the one thing here that talks to an
API rather than downloading a public file.

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

**What to fix comes first** — a short, ranked to-do list: the incompatible
plugins that won't load, the ones pulled from the directory, the ones throwing
errors, the shortcut clashes, the updates waiting. Selecting any finding scopes
the table to exactly the plugins it counted. Underneath it sit the vault-health
score, the tiles, the trend, and the full scorecard as evidence.

### Disable these first

Knowing what is wrong still isn't knowing what to do first. Ranking by badness
answers it wrongly — the worst-scoring plugin is often the one you use daily,
while the easy win is the broken thing you forgot was installed.

FlowKit ranks by **trouble removed per feature given up**, and says what each
one would cost you: *"You'd lose: 6 commands and 4 registered hooks"*, or, for
a plugin that can't load at all, *"nothing — it already isn't running."*
Anything you're **watching** is never recommended first.

### Why is my vault slow?

The startup cost of the whole vault in one line — plugins loading, total code,
measured milliseconds, how many are running a fast repeating timer — and one
click to order the table by what each plugin actually costs to run.

### Mute with a reason and an end date

A one-click permanent mute is a way to make a real problem invisible forever.
Mutes now last **30 days**, **until Obsidian next updates** (because "it's fine
on this version" is a claim about *this* version), or **indefinitely** — with an
optional note to yourself. Expired mutes lapse on their own, and FlowKit tells
you when one does rather than letting a plugin quietly rejoin the counts.

**Watch** a plugin to have FlowKit lead with it whenever something about it
moves. A vault-wide report is global noise; three plugins you actually depend on
is not.

## Free vs Pro

FlowKit is useful for free forever, and a one-time **Pro** unlock adds the
power-user tooling. Pro is verified fully offline (a signed license key — no
account, no server, no telemetry).

**The whole diagnosis is free.** Pro is for the work you can't reasonably do by
hand — an automated search, a full startup profile, switching twenty plugins at
once, and being told when something breaks while you weren't looking.

> **Changed in 1.4.0:** bulk fixes used to be the headline Pro feature. Charging
> for the difference between one click and three — a thirty-second job in
> Obsidian's own settings — was the weakest claim in the product, so **bulk
> fixes are now free**, review step and undo included. Existing keys unlock
> everything below; nothing anyone paid for was taken away.

### Free

- The **complete ranked "What to fix" list** — every finding, not a teaser
- **Bulk fixes in one click** — review exactly what will change and why, apply
  it together, undo if you disagree
- **Disable these first** — the ranked shortlist, with what each one would cost
- **Which plugins are throwing errors**, how many, how often, and the messages
- **"Is this a known issue?"** — search a plugin's own tracker for the error
- **Your vault's change history**, and when errors started right after an update
- **Shortcut and command-name clashes** between your plugins
- **What each plugin costs to run** — size, load time, timers and callback cost
- **What the last Obsidian update broke**, the moment it lands
- The full **six-metric scorecard**, weighted overall, and confidence figure
- **Select any row** to see why it scored what it did: each metric's value,
  weight, and evidence
- **Copy bug report** — a plugin's errors, versions and platform, paste-ready
  for an issue
- A **30-day health trend**, recorded whether or not you open the dashboard
- A **status-bar readout** that names what's wrong, not just that something is
- **Unlimited Markdown reports** and copy-to-clipboard summaries
- **Mute with a reason and an expiry**, and **watch** the plugins you depend on
- **Search, filter, sort**, and the per-row menu (enable/disable, open settings,
  open on GitHub, measure load time, watch, mute)
- Fully **offline-capable**; both online lookups are optional

### Pro ($9 one-time)

- **Find what's breaking your vault** — the automated binary search. Seven
  questions instead of an evening of manual toggling, with your exact setup
  restored afterwards
- **Profile startup** — time every enabled plugin in one pass, for the complete
  answer to "why is my vault slow" in real milliseconds
- **Saved plugin sets** — a Writing set, a Minimal set, a known-good set to fall
  back to; switch twenty plugins on and eighteen off in one action
- **Background monitoring** — get told when a plugin turns incompatible, goes
  stale, or is pulled from the community directory, leading with the plugins
  you're watching
- **Full stack traces** for every recorded error, and included in the copied bug
  report — see exactly where a plugin broke, and file something the author can
  act on
- **CSV export**, alongside the Markdown report that's free and unlimited
- **90 days of vault-health history**, instead of the last 30

#### Every action shows you what it will do first

Nothing changes until you have seen exactly what would change. Pressing a fix
opens a review screen listing **every affected plugin by name, each with the
specific evidence that put it there** — not a count, not a restatement of the
finding:

```
Disable these plugins?
FlowKit will turn off 3 plugins. Nothing is uninstalled, and you can
undo this straight after.

  Calendar        Requires Obsidian 1.9.0, but you run 1.8.4.
  Note Refactor   No recorded update in about 26 months.
  Kanban          Was in the community directory and has since been removed.

⚠ A plugin with no recent release isn't necessarily broken — some are simply
  finished. Cancel and disable them individually if you'd rather keep some.

                                        [ Cancel ]  [ Disable 3 ]
```

Afterwards an **Undo** bar stays on the page for the rest of the session, and
undo only ever re-enables what the action actually changed — it can't switch on
something you had already turned off yourself. Nothing is uninstalled, ever.

The same holds for everything that touches your setup: switching plugin sets
lists every plugin it would turn on and off (and names any the set references
that are no longer installed), profiling tells you it will restart everything
before it does, and bisect saves your current set before its first move.

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
- **Diagnose** in the header is the entry point when something is actually
  wrong: find what's breaking your vault, profile startup, and save or switch
  plugin sets.
- Start with **What to fix**. Selecting a finding filters the table to exactly
  the plugins it names.
- **Select any row** to open its reasoning panel: each metric's value, weight
  and evidence, plus enable/disable, open settings, GitHub, and mute.
- **Search** by name/author, **filter** (needs attention, no recent release,
  incompatible, delisted, local installs, update available, disabled, muted),
  and **click any column** to sort.
- **Export** writes a report — findings, scorecard and methodology — to a
  Markdown note or CSV. The Markdown report is free and unlimited; CSV is Pro.
- **Refresh** re-scores and re-downloads community data on demand. Otherwise the
  cached data is reused for a day so the dashboard opens instantly.

## Settings

- **FlowKit Pro** — paste your license key to unlock Pro features (verified
  offline). Shows your Pro status and what it unlocks.
- **Online enrichment** — fetch popularity + maintenance from Obsidian's public
  community data. Turn off to stay fully offline (those two metrics then show as
  unavailable). Local-first: no telemetry, no accounts.

  The two files come from `raw.githubusercontent.com`, falling back to the
  jsDelivr CDN mirror of the same repository when GitHub rate-limits the
  connection. Nothing is sent — these are plain public downloads — and the
  result is cached locally for a day.

### Every network call FlowKit can make

There are exactly three, all to GitHub, none of them telemetry, and each can be
switched off or simply not used:

| Call | When | Sends |
|---|---|---|
| Community plugin list + download stats | On open/refresh, cached a day. Off with **Online enrichment**. | Nothing — plain public file downloads |
| `api.github.com/repos/{owner}/{repo}` | Only with **Check repository activity** on (off by default), a few per scan, cached a week | A repository name that is already public |
| `api.github.com/search/issues` | Only when you press **"Is this a known issue?"** on a recorded error | That repository name and the error message text |

No accounts, no analytics, no identifiers, and nothing about your notes or vault
is ever transmitted. Error messages and stack traces stay on your machine — the
issue search sends only the message text of the error you explicitly asked it to
look up, and only when you press the button.
- **Check repository activity** — ask GitHub whether a plugin's repository is
  archived or still being pushed to, so *finished* and *abandoned* stop looking
  identical. **Off by default**: it is the only thing here that talks to an API
  rather than downloading a public file. Only plugins whose verdict is in doubt
  are looked up, a few per scan, cached for a week; nothing is sent but a
  repository name.
- **Measure what plugins cost while running** — time plugin loads and notice
  repeating timers, so Footprint reflects what a plugin *does* and not only how
  big it is. Only measurements FlowKit witnesses are used; a plugin it couldn't
  observe is never penalised for it.

  To do this it wraps `window.setInterval` and Obsidian's plugin loader while
  it runs, so it can see which plugin created a timer and how long each load
  and each callback takes. Both wrappers pass straight through to the originals,
  record nothing but timings, and are removed when FlowKit unloads. Turn this
  off and none of it happens. Nothing measured here leaves your machine.
- **Show disabled plugins** — include installed-but-disabled plugins.
- **Re-download community data on open** — off by default; the cached scan is
  reused for a day, and Refresh always refetches.
- **Background monitoring** *(Pro)* — check quietly for plugins that turn
  incompatible, go stale, or get pulled from the directory. This is the only
  feature that fetches community data without you asking; switch it off and
  FlowKit only ever goes online when you open or refresh the dashboard.
- **Muted plugins** — what's muted, why, and when each mute lapses; clear the
  list here.
- **Watched plugins** — the ones FlowKit leads with and never recommends for a
  bulk disable.
- **Other devices** *(only shown when there is more than one)* — how many
  machines share this vault's settings, and a way to forget the ones you no
  longer use.

## More than one device

Obsidian syncs your plugin **settings** and your installed **plugins** as two
separate options, so a desktop with forty plugins and a phone with six can share
one settings file. FlowKit keeps each device's view apart:

- **A plugin missing from this machine is absent, not uninstalled.** Its error
  history, measured load times and repository readings are kept as long as any
  device still has it — so your phone can't delete what your desktop recorded.
- **The change history only reports what happened on the device that saw it.**
  Without this, each machine reported every plugin the other had as
  "uninstalled" on every scan, forever.
- **The trend chart shows this device's own readings.** Two machines with
  different plugin sets do not have the same vault health, and averaging them
  into one line is the same mistake as plotting an offline reading beside a full
  one — which FlowKit already refuses to do.
- **A device that stops syncing is forgotten after 90 days**, or immediately
  from Settings → Other devices.

The device identity lives in local storage, not in the synced settings file —
which is the only place it could mean anything. If a device has no local storage
available, it shares one identity with any others in the same position, which is
exactly how FlowKit behaved before any of this existed.

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
carve-out and the repository signals that overrule it in both directions, the
runtime-cost blend (including that an unmeasured plugin is never penalised and
that a load time from an older build is ignored), the bisect state machine
(driven to completion for every possible culprit, plus the no-culprit case and
the restore path), the change timeline and its error correlation (including that
errors predating a change never correlate with it), plugin-set deltas, shortcut
and command-name clash detection, mute expiry and migration, the safe-disable
ranking, the
persisted-cache round trip, the maintained/not status, update-available
detection (including prerelease handling), the delisted-vs-local split, the
offline license verifier, and the insights engine — so the core logic is checked
even without a live Obsidian vault.

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
