# Changelog

All notable changes to FlowKit Plugin Health Dashboard are documented here. This
project follows [Semantic Versioning](https://semver.org/).

## [1.7.0] - 2026-08-03

The known issue 1.6.1 shipped with, fixed.

Obsidian syncs your plugin **settings** and your installed **plugins** as two
separate options, and plenty of people turn on the first without the second — a
desktop with forty plugins and a phone with six, sharing one `data.json`. Every
per-plugin store FlowKit keeps was written on the assumption that "not installed"
means "gone", and under that configuration the assumption is false in the most
damaging way available.

What actually happened: the phone scanned, concluded that thirty-four plugins had
been uninstalled, deleted their error history, their measured load times and
their repository readings, and wrote thirty-four "uninstalled" events into the
vault's change history. The desktop then scanned, concluded the same about the
phone's six, and put its own thirty-four back as fresh installs. The two devices
took turns erasing each other's data and filling the timeline with events that
never happened, and nothing was ever kept long enough to be worth having.

### What each device saw is now recorded under that device

- **A plugin missing from this machine is absent, not uninstalled.** Whether a
  stored reading is still worth keeping is now decided by whether *any* current
  device has seen the plugin lately, not by whether this one has it installed.
  Anything genuinely gone everywhere still ages out.
- **The change history only reports what happened on the device that saw it.**
  Each machine diffs against its own previous view, so a plugin you don't have
  is simply not your business — while a plugin you really did uninstall is still
  reported, by you, immediately.
- **A device's first scan of a shared vault records a baseline silently**, the
  same way the very first scan on the very first device always has. Otherwise a
  phone joining the vault would announce its whole plugin list as newly
  installed — the fabricated-events mistake, one machine at a time.
- **Trouble state survives a scan that couldn't see the plugin.** The map that
  remembers which plugins are currently in trouble was rebuilt from only the
  rows each scan looked at, so each device forgot the other's plugins every pass
  and both re-announced everything as newly wrong on the next. This also fixes a
  single-device case: with "show disabled plugins" off, a plugin you switched
  off used to re-announce its old trouble as fresh the day it came back.
- **The trend chart shows this device's own readings.** Two machines with
  different plugin sets do not have the same vault health, and they were drawing
  one polyline between them — each silently overwriting the other's reading for
  the day. `online` and `model` already exist to keep incomparable readings off
  one line; the device was the third such condition and the only one unguarded.
  The 90-reading cap is now per device, so a second machine can't halve the
  window the first one keeps.
- **A device that stops syncing is forgotten after 90 days.** Without it the
  record only ever grows: every machine the vault has ever been opened on would
  pin storage in every other machine's settings forever. Settings → **Other
  devices** shows how many are sharing this vault and forgets the rest on demand;
  it stays hidden entirely until there is more than one.

The device identity lives in local storage, which Obsidian does not sync — the
only place it could mean anything. A device without durable local storage shares
one identity with any others in the same position, which is exactly how FlowKit
behaved before any of this existed: worse than the ideal, no worse than the past.

**Upgrading changes nothing on a single-device vault.** The existing record is
filed under this device, so the first scan afterwards diffs against exactly the
same data it would have before, and announces nothing.

## [1.6.1] - 2026-08-03

1.6.0 was reviewed by five specialists — robustness, performance, maintainability,
security and UI — each with a skeptic behind it whose only job was to kill its
findings, plus a critic asked what nobody had looked at. The verdict on 1.6.0 was
fair and uncomfortable: it had fixed *instances* rather than *classes*. Every
item in the first section below is the same bug as one 1.6.0 fixed, in the file
1.6.0 didn't open.

### Starting a second search could destroy the record of your real plugin set

- **A search can no longer be started while one is running.** Nothing prevented
  it. Starting a second search mid-first captures the *current* enabled set as
  both the automatic snapshot and the new session's "put it back like this" —
  and mid-search that set is missing every plugin the first search had switched
  off. Both records of the real vault were overwritten in the same breath, under
  a modal that had just promised "your current set is saved first", and nothing
  else held it. Those plugins were simply orphaned. Switching plugin sets and
  profiling startup are refused while a search is running too.
- **Settings → Saved plugin sets → "Clear all" no longer deletes the search's
  recovery snapshot.** It is an ordinary entry in that list, and it is the only
  thing the salvage panel can offer when a search record turns out to be
  unreadable. While a search is open it is now kept, and the description says so.

### The error watcher could keep running after FlowKit was unloaded

The exact defect fixed in the runtime watcher for 1.6.0, in its sibling.

- **A `console.error` wrapper that survives unload is now inert.** FlowKit
  declines to unhook a global another plugin has since wrapped, because pulling
  its own layer out would take the other one with it — but the layer left behind
  still held the watcher, the host, and through the host an unloaded plugin's
  settings. Every logged error in the vault went on being attributed and written
  into a dead instance's log, then flushed through a callback that saves
  `data.json` and asks for a rescan. A disabled plugin quietly kept rewriting
  its own settings file.
- **The wrapper is removed by identity, not by the marker every FlowKit wrapper
  carries** — so one instance can't restore over another's live wrapper.
- **Restoring hands back the original, not a bound copy of it**, which had been
  laminating another `.bind` onto a global on every disable/enable cycle.
- **The detached repository lookups stop at unload.** Up to six sequential
  network calls, each with its own timeout, easily outlive a disable — and they
  finished by writing settings and asking every view to rescan.

### Failures on the paid path, and other things that vanished

- **A licence key that can't be saved now says so.** The Activate button's
  promise had no rejection handler, so on a read-only or sync-locked vault the
  click produced nothing at all: no notice, no status text, not even a console
  line. Somebody who had just paid clicked it twice and got silence. Enter now
  activates too, and the status line is announced.
- **A failed Obsidian-version check no longer cancels the startup scan.**

### Error text that leaves this machine is redacted

- **File names and note titles are stripped from the issue search and the
  clipboard bug report.** The old rules stripped *absolute* paths, and every path
  Obsidian handles is vault-relative — so `Patients/Alice Nguyen HIV results.md`
  and `[[Divorce settlement draft]]` went out whole, one to GitHub's search API
  and one into a report the product tells you to paste into a stranger's issue
  tracker. In a note-taking app the file name is the content. Ordinary error
  messages are left untouched, so searches still match; the report now says what
  it redacted.

### Two shortcuts on the same key, reported as no conflict at all

- **`Mod` is resolved to what it actually means before chords are compared.**
  Obsidian's `Mod` is an alias — Ctrl on Windows and Linux, Meta on macOS — and
  it was compared verbatim, so a plugin binding `Mod+T` and one binding `Ctrl+T`
  were treated as two different chords and produced *no* conflict. On Windows
  they are the same keystroke and one of them silently never fires, which is the
  single case this feature exists to find. Every existing test used `Mod` on both
  sides, so the suite could not see it.

### Numbers and copy that disagreed with themselves

- **"Profile the other 12" profiles those 12.** The count excluded muted and
  already-measured plugins; the button passed every enabled one. It opened a
  modal saying "Profile 38 plugins?" and then restarted all 38.
- **A finished search that could not put your plugins back keeps the page.**
  Every guard released the instant a search reached "done", including on the
  path where the restore failed — so the full report rendered over a vault still
  missing plugins, and the trend chart and change log recorded it. The result
  sentence no longer says "everything else is back on" directly above the box
  explaining that it isn't.
- **The trend history is sorted before it is used.** Two things depended on it
  being chronological — the same-day replace reads the last entry, the cap trims
  the front — and one out-of-order entry from a sync merge made every later
  reading append instead of replace, then start discarding the newest.
- **Dismissing the Obsidian-update banner no longer marks your unread changes as
  seen.** Both × buttons wrote the same timestamp, and the change log is read in
  exactly one place, so they never came back.
- **The hero stops telling you to enable a setting that is already on**, directly
  above the notice explaining that GitHub couldn't be reached.
- **The trend panel stops promising a chart "from tomorrow"** to someone with
  enrichment off, for whom no reading will ever be plottable. It says why, and
  what to change.
- **CSV cells beginning `=`, `+`, `-` or `@` are defanged** so a spreadsheet
  doesn't execute a plugin's manifest field as a formula.
- **Undo works on the last answer too.** 1.6.0 added it to every round except the
  one that produces the accusation — the answer given after the longest wait, on
  the smallest difference, and the only one whose mistake has a name attached.

### Tests

Redaction is tested from both directions: six messages carrying private paths
must not leak, five ordinary errors must survive verbatim or the search stops
working. The error watcher now has the inertness and bind-lamination tests its
sibling got. Conflicts are tested with the two spellings of the same chord, on
both platforms. And a two-line contract test asserts `PRODUCT_ID` equals
`manifest.id` — they are the same today, they are used interchangeably, and if
they ever diverge FlowKit attributes every timer and every logged error in the
vault to itself.

### Known, not fixed

`data.json` can be synced between devices while the installed plugins are not —
a supported Obsidian configuration. `pruneStores` and `recordEvents` both assume
"not installed here" means "gone", so two devices with different plugin sets will
take turns deleting each other's stored readings and writing a flip-flopping
install/uninstall timeline. It needs a design, not a patch, and it is the most
likely place for the next serious bug in this codebase.

*(Fixed in 1.7.0.)*

## [1.6.0] - 2026-08-03

An adversarial-review release. Two outside models were asked to attack the
1.5.0 build with no brief except to find what is wrong with it; everything below
is either something they found and I could reproduce, or something the review
turned up on the way. Most of it is about the same thing: a diagnostic tool is
only worth the trust it asks for, and several places were quietly claiming more
than the code delivered.

### FlowKit could keep running after Obsidian had unloaded it

- **The timer and plugin-loader hooks are now inert once FlowKit stops.**
  FlowKit deliberately declines to unhook a global that another plugin has since
  wrapped, because pulling its own layer out would take the other plugin's with
  it — but the layer it left behind still held the watcher, its maps and the
  unloaded plugin's settings. Every timer created afterwards was attributed,
  recorded, and flushed through a callback that saves settings and rescans, on
  behalf of an instance that no longer existed. A wrapper that survives now
  passes straight through and observes nothing.
- **A wrapper is only ever removed by the instance that installed it.**
  Restoration tested for a marker every FlowKit wrapper carries rather than for
  its own, so during a reload one generation could replace another's live
  wrapper with its own stale predecessor — leaving the survivor blind.
- **A timer being cleared now updates the dashboard**, as creating one always
  did. A plugin that stopped polling went on being shown as a poller until
  something unrelated forced a re-score.

### Saving is honest about which write failed

- **A failed write no longer fails the callers queued behind it.** They
  inherited the rejection wholesale — told their state had not reached disk when
  it had never been attempted — and, worse, their snapshot was then left
  unwritten until something else happened to save. `await saveSettings()` is the
  durability barrier bisect leans on before it switches a plugin off, so
  "somebody else's write failed" now means "attempt mine".
- **Typing a licence key no longer rewrites the whole database per keystroke.**
  Every save clones and writes all of it — cache, history, error log, saved sets
  — so pasting a key in on a phone or a synced vault meant one full rewrite, and
  one sync event, per character. The check still runs on every keystroke; only
  the write waits, and a key that verifies is written at once.

### The community data says how old it actually is

- **Each feed is dated by its own fetch.** The two files fail independently and
  merge independently, but one timestamp covered both — so a run of stats-only
  successes kept refreshing it while the community list, which is where
  delisting, repository links and sideload detection come from, aged silently
  underneath. The header now quotes the older of the two.
- **Uninstalling a plugin drops its cached row.** The merge unioned the old and
  new key sets, so every plugin the vault had ever held survived every refresh
  and rode along in every subsequent write, forever.
- **The cache guard checks the records, not just the container.** It promised
  all-or-nothing and validated only the outer shape, so a sync-mangled row went
  into scoring — where a stringly-typed listing flag is the difference between
  "installed outside the directory" and "Obsidian pulled this".
- **A rate limit is respected even when the mirror then fails differently.** The
  backoff read only the last attempt's outcome, so the commonest shape of this
  failure — GitHub refuses, the mirror times out — set no cooldown at all.

### The search can be answered wrongly, so now it can be un-answered

- **Undo last answer.** Two buttons, each irreversible, each discarding half the
  remaining suspects: pressing one before you had actually checked produced a
  search that ran to completion and confidently named the wrong plugin, with
  nothing to suggest anything had gone wrong. One step back is offered every
  round, and it survives a restart.
- **The status bar says when a search is running.** It quoted a health score for
  a vault FlowKit had itself switched half of off — and it is the only surface
  left if the dashboard is closed or a restart didn't restore the tab.
- **The setup step no longer promises "exactly as it was".** A search only ever
  switches plugins off, and restoring deliberately does not reverse anything you
  turned on yourself while it ran. The code has said so for a version; the
  consent copy had not caught up.
- **It also says, before you start, that it looks for one plugin acting alone.**
  Against two plugins that only misbehave together the search still finishes and
  still names somebody, which is the one way this feature can be confidently
  wrong.
- **A step that fails no longer claims nothing moved.** A round is persisted
  before it is applied, so a failure part-way through leaves the record ahead of
  the vault — which is exactly what the drift prompt exists to handle, and the
  old message talked the user straight past it.
- **Starting a search reports whether the first round was actually established**,
  rather than reporting success for a session whose vault never reached it.

### Failures reach you instead of vanishing

- **Every action button now reports its own failure.** Enable, disable, mute,
  mark-as-seen, save-a-set, and both settings shortcuts were written so that a
  rejected write or a plugin that refused to move took the rest of the handler
  with it: no change, no message, nothing in the console, and an unhandled
  rejection — inside the plugin whose job is to notice exactly that.
- **A failed refresh keeps the report you were reading.** It replaced the whole
  dashboard with a retry button, so a rejected write on a synced vault threw
  away a complete and still-accurate diagnosis. It is a banner now, and only
  takes the page when there is nothing behind it.
- **The unreadable-settings banner says what to actually do.** "Restart
  Obsidian" does not repair a malformed file; it names the file, offers to copy
  the path, and says what restarting will and won't fix.
- **A plugin lifecycle change is given a little longer to settle.** One
  microtask covered a registry updated in an already-queued callback and nothing
  else, so a change that completed a moment later was reported as a failure —
  which pauses a search and sends the user to fix something by hand that is
  already fine.
- **Scan progress and the search panel are announced to screen readers.** Both
  are dynamic regions that were only ever repainted, so a screen-reader user
  could start an operation that rearranges their vault and be told nothing about
  what it was doing.

### The numbers agree with each other, and with the price list

- **The vault's startup total applies the same version rule the rows do.** After
  a plugin updated, its Footprint correctly ignored the load time measured
  against the old build while the headline went on adding it — and the detail
  panel showed neither the reading nor the offer to re-measure, so the row
  simply went quiet.
- **The trend history is no longer recorded mid-surgery.** The change log and
  the event log are both suspended while a search or a profiling run has the
  vault rearranged; the trend was not, so a search running across midnight wrote
  its own handiwork into the ninety-day chart as a cliff.
- **Opening Obsidian with the dashboard open scans once, not twice.** The
  restored tab scanned on open and the startup pass scanned again a moment
  later; only the download was ever shared.
- **The Export button's padlock is gone.** The Markdown report is free and
  unlimited — it is the diagnosis, and the diagnosis stays free — but a free
  user who exported once got a lock icon on a door that was never shut.
- **The exported report sells the product that exists.** Its footer still
  advertised bulk fixes and unlimited reports, both free for a version, and this
  is the one artefact that leaves the vault into other people's issue trackers.
- **The history upsell counts something the purchase would change**, rather than
  counting readings the chart had dropped for being offline or scored on an
  older model.

### Tests

The suite gained the adversarial cases it was missing: a wrapper still in the
chain after unload recording nothing, two watcher generations and wrapper
ownership, a cleared timer notifying its host, a failed write followed by a
newer one, alternating partial cache refreshes, uninstall across a merge, and
mangled cache records. One existing test was rewritten — it asserted that a
later wrapper survived unload, which blessed the leak instead of catching it.

## [1.5.0] - 2026-08-03

A hardening and polish release. No new features — this is the pass that makes
the diagnostic tools safe to trust, the numbers agree with each other, and the
dashboard feel like something built rather than assembled.

### The diagnostics can no longer change your vault behind your back

- **Every plugin FlowKit switches is now verified.** The internal Obsidian call
  used to be optional-chained: on any build where those methods are absent it
  resolved successfully having done nothing, and bulk fixes, saved sets, Undo
  and bisect all reported changes that never happened. FlowKit now requires the
  API, checks the registry afterwards, and reports exactly what moved.
- **Measuring a plugin's load time restores it, whatever happens.** If the
  restart failed halfway, the plugin was left switched off and the only word
  about it was "couldn't measure that one". Restoration now happens either way,
  in both directions — measuring a *disabled* plugin no longer leaves it
  running — and if it can't, profiling stops and names the plugin.
- **A search round that couldn't be set up is no longer answerable.** If any
  plugin refused to switch, the vault isn't the set the question is about, and
  an answer could convict an innocent plugin. FlowKit says so and pauses.
- **Stopping a search restores first and forgets second.** The recovery record
  used to be cleared before the plugins were actually back on, so a failure
  there left a half-disabled vault with nothing that knew what normal was.
- **A damaged search record is no longer deleted on sight** — it may describe a
  vault that is switched off right now. FlowKit keeps it and offers to restore
  the snapshot it took when the search began.
- **If your plugins don't match the round a search was on**, FlowKit asks
  rather than silently putting them back. It cannot tell an interrupted
  transition from someone who fixed their own vault by hand and restarted.
- **FlowKit will not start a search when it can't save.** The whole safety
  argument is that the way back is written down first.

### It cannot overwrite a settings file it failed to read

- An unreadable or corrupt `data.json` used to stop the plugin loading. FlowKit
  now starts on defaults, refuses to write for the session, and says so — so a
  file that is merely locked or mid-sync isn't replaced with an empty one.
- All settings writes go through one queue. Five separate things wrote that
  file with no coordination, and an older state could land last.
- A malformed community cache is discarded rather than taken down the scan
  with it.

### Numbers that agree with each other

- The exported report and Copy summary **withhold the letter grade under
  exactly the rule the dashboard uses**. The screen would say "not enough
  signal to grade this vault" while the report pasted into someone's issue
  tracker confidently said "Grade B".
- The Plugins tile counted muted plugins while the headline didn't, so one
  screen showed two different totals. It now reconciles them.
- The table described five metrics and scored six — Reliability was missing
  from the caption, the Overall tooltip, and the plugin description.
- Compatibility's tooltip said it was weighted 30%. It is 25%.
- "FlowKit re-checked all your plugins" is no longer said when disabled ones
  were never looked at.
- A finished search no longer says "It's X" as though elimination were proof.

### Faster on a large vault

- Plugin file sizes are read a few at a time instead of one after another —
  previously a couple of hundred filesystem round trips in series before
  anything appeared.
- One settings write per scan instead of up to five.
- Typing in the search box no longer rebuilds the whole table on every
  keystroke, and opening one plugin's reasoning no longer rebuilds every row.
- Vault totals and the findings list are computed once per change rather than
  a dozen times per repaint.
- Pressing Retry during another scan no longer silently downgrades it to an
  offline one.
- A runtime observation arriving inside the 15-second window is now picked up
  when the window passes, instead of being dropped.

### Looks like it was designed

- A **real loading state**: skeleton rows and a progress line reported by the
  scan itself, so a slow vault no longer looks like a hung one.
- **Three distinct empty states** — nothing installed, everything hidden by a
  setting, nothing matching a search — each with the way out.
- A running search now genuinely owns the page rather than sitting above a
  health report about a vault that is deliberately half switched off.
- Motion on row expansion, cards and buttons, fully removed under
  `prefers-reduced-motion`.
- A larger, quieter hero and header; **Diagnose** now carries the accent.
- "Share" is called **Export**, because that is what it does.

## [1.4.0] - 2026-08-03

FlowKit stops being a scorecard you read once and becomes the thing you open
when something is wrong.

### Find what's breaking your vault

"Disable half your plugins and see if it goes away" is the answer in every
Obsidian support thread. It is also correct, and twenty minutes of tedious
clicking that people abandon halfway through having forgotten which half they
were on. **FlowKit now runs those rounds.**

- Switches off half your plugins, asks whether the problem is still there, and
  keeps halving. Four questions searches sixteen plugins; seven searches forty.
- **Your exact setup is saved before it starts** and restored when it ends —
  including if you stop halfway, or restart Obsidian mid-search. The session
  survives a restart, because reproducing a problem often needs one.
- The last suspect is **actually tested before it's accused**, so
  *"no plugin is responsible"* is an answer this can reach — pointing you at a
  theme, a snippet, or Obsidian itself instead of blaming something innocent.
- Nothing is uninstalled at any point.

### "It started right after that update"

- FlowKit records **installs, updates, removals and toggles** as it sees them,
  and each plugin's panel now shows its own recent history.
- It already knew when a plugin's version changed and when that plugin started
  throwing errors, and never connected the two. It does now: **"Templater
  started throwing errors 2 hours after it updated to 2.4.1."**
- Stated as a sequence, not a cause — because that's what it is, and it's
  usually where to look first.

### Answering "why is my vault slow" properly

- **Profile startup** times every enabled plugin in one pass. Passive timing
  only ever catches the plugins Obsidian loads after FlowKit, so the column was
  mostly blank on real vaults; this fills it with real milliseconds.
- **Timer callbacks are now timed, not just counted.** *"This plugin blocks the
  interface for 180 ms every time its timer fires"* is the number that actually
  explains a laggy vault — and a plugin can hold a slow callback on a slow timer
  and look cheap by every other measure here.
- The startup strip says how many plugins are still **unmeasured**, instead of
  quoting a total that invites you to assume the rest are free.

### Saved plugin sets

- Save the current set as **Writing**, **Minimal**, **Known good**; switch
  between them in one action, with a review step and undo.
- Genuinely not doable by hand: switching twenty plugins on and eighteen off is
  several minutes of clicking that nobody does twice.

### Is this a known issue?

- From any recorded error, search that plugin's own issue tracker for it.
  Open threads first, with a link to file a new one when there's nothing.
- On demand only — never as part of a scan.

### Pro has changed, and bulk fixes are now free

The old headline asked people to pay for the difference between one click and
three — a thirty-second job anyone can do in Obsidian's own settings. That was
the weakest thing in the product and it converted nobody.

- **Bulk fixes, with the review step and undo, are free.**
- Pro is now the work you genuinely can't do by hand: **bisect**, **startup
  profiling**, **saved plugin sets**, **background monitoring**, **full stack
  traces**, 90-day history and CSV.
- **Existing keys unlock all of it.** Nothing anyone has already paid for was
  taken away.
- The standing "Fix N in one click" upsell button is gone — it advertised
  something the reader already had.

### Changed

- **The diagnostic tools are in the command palette** — "Find what's breaking my
  vault", "Profile plugin startup", "Save current plugin set" — so they can be
  searched for and bound to a key instead of living only in a menu inside the
  dashboard.
- **The dashboard re-scores while you watch it.** It used to scan once at
  startup and then only redraw, which meant a tab left open reported a vault
  with no timers and no errors indefinitely — precisely the signals this release
  adds, none of which exist a second after Obsidian loads.
- Timer callback cost feeds Footprint, so trend history from 1.3.x is kept but
  starts a fresh line — the same guard used in every scoring change since 1.0.0.

### Notes

Everything above was exercised in a live vault before release, against
purpose-built plugins that load slowly, poll, block the interface, throw, and
fight each other for a shortcut. That found ten defects — including a bisect
that could have switched off FlowKit mid-search, and a startup profiler that
reported success while discarding every measurement — all of which are fixed
here. The suite that ships with the source now covers each of them.

## [1.3.0] - 2026-08-03

FlowKit could tell you a plugin was big. It couldn't tell you a plugin was
*expensive*, that two of your plugins were fighting over the same shortcut, or
that the one it called "finished" had actually been abandoned. This release is
about the difference.

### Footprint now measures what a plugin costs to run

- **Load time**, timed for real. FlowKit times every plugin load it witnesses —
  which is every plugin Obsidian starts after it, and every plugin you enable
  from anywhere. For the rest there is **Measure load time** in the row menu: it
  restarts that plugin and times it, and says so first.
- **Repeating timers.** A plugin polling four times a second is worse for your
  vault than a large one that loads and sits idle, and the old metric said the
  opposite. FlowKit now notices fast repeating timers and names them in the
  score's evidence.
- Size, load time and polling are blended by taking **the worst of the three**,
  not the average — they are alternative ways of being expensive, not
  components of one quantity.
- **A plugin FlowKit couldn't observe is never penalised for it.** Every one of
  these signals can only lower a score, and only when it was actually measured.

### "Finished" and "abandoned" are no longer the same thing

- New setting, **off by default**: FlowKit can ask GitHub whether a plugin's
  repository has been **archived** or is still being **pushed to**. Release
  dates alone cannot tell a plugin that is done from one whose author left.
- An **archived repository** is the author saying on the record that nothing
  more is coming — it now outranks the maturity carve-out, badge and all.
- A repository **still being pushed to** reads as **Active**: being worked on,
  just not tagged. Previously these were filed as abandoned.
- A repository **untouched for two years** overrules the carve-out in the other
  direction — many published versions means nothing if nobody has touched it.
- Only plugins whose verdict is genuinely in doubt are looked up, a few per
  scan, cached for a week. It sends nothing but a repository name.

### Plugins that fight each other

- **Shortcut clashes.** Two plugins bound to the same chord means one of them
  silently never fires, and nothing in Obsidian's own UI tells you which. FlowKit
  now finds them, badges the rows, lists them in each plugin's panel, and links
  straight to the hotkey settings.
- **Duplicate command names**, which are indistinguishable in the palette.
- Deliberately **not scored**: neither plugin is at fault for a collision, and
  docking one of them for it would be inventing a defect.

### When Obsidian itself updates

- FlowKit notices the version change, re-checks everything against the new
  Obsidian, and leads the dashboard with **what that update broke** — the
  question people actually have when they open this. A clean result says so too.

### Acting on it

- **Disable these first.** A ranked shortlist ordered by trouble removed per
  feature given up, saying what each one would cost you. A plugin that can't
  load costs nothing to disable, and now says so.
- **"Why is my vault slow?"** — a startup-cost total for the vault and a
  one-click ordering of the table by what each plugin costs to run.
- **Mutes now have a reason and an end date**: 30 days, until Obsidian next
  updates, or indefinitely. Expired mutes lapse on their own and FlowKit tells
  you when one does, so a decision taken in a hurry can't quietly outlive its
  reason.
- **Watch a plugin** to have FlowKit lead with it whenever something about it
  moves — and never recommend it for a bulk disable.

### Changed

- **The status bar says what is wrong**, not that something is. "Plugins:
  1 won't load · 2 erroring" instead of "3 to fix" — a red badge with no content
  is one people stop seeing within a week.
- **"What to fix" is now the first thing on the page**, above the stat tiles and
  the trend chart. On a phone the answer used to sit a full screen below the
  question.
- The header says **when the last scan ran**, alongside how old the community
  data behind it is. They are different ages and it was only reporting one.
- The dashboard and every exported report now state plainly **what the score is
  not** — not a judgement of whether a plugin is good, safe, or worth keeping.
- Because Footprint and Maintenance both moved, **trend history from 1.2.x is
  kept but starts a fresh line**, the same guard used in 1.0.0 and 1.1.0.

## [1.2.1] - 2026-08-03

### Fixed

- **"GitHub returned an unexpected response (403)".** GitHub rate-limits
  unauthenticated downloads per IP, and the two community files are ~1.8 MB
  each, so a handful of scans in quick succession is enough to trip it. FlowKit
  now falls back to the jsDelivr mirror of the same data, backs off for 30
  minutes instead of hammering a limiter, and says plainly that it was
  rate-limited rather than blaming an "unexpected response".
- **Far fewer downloads.** Concurrent scans now share one fetch — a cold start
  could previously issue four requests for the same data within a second.
  Toggling "show disabled plugins" or clearing the mute list no longer
  re-downloads anything; neither changes data the network could answer.
- Retry now overrides the backoff, because an explicit Retry is you saying
  "try now".

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
