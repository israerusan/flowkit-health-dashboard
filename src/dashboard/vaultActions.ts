/** Everything the dashboard does to the vault: bulk fixes and undo, profiling, safe mode, the search, plugin sets, experiments, watch and mute. */
import { Notice, apiVersion } from "obsidian";
import type { PluginHealth } from "../types";
import type { BulkAction, Insight } from "../insights";
import { currentLoadMs } from "../runtime";
import { roundsNeeded, searchableCandidates } from "../bisect";
import { AUTO_SNAPSHOT, isNoop, type PluginProfile } from "../profiles";
import { BulkConfirmModal } from "../ui/BulkConfirmModal";
import { BisectStartModal } from "../ui/BisectModal";
import { MuteModal } from "../ui/MuteModal";
import { SaveProfileModal } from "../ui/ProfileModal";
import { describeFailed, rowsLabel } from "./format";
import { runBisectAction } from "./bisectPanel";
import type { HealthDashboardView } from "../view";

/**
 * Mute or unmute without rescanning. `muted` is pure passthrough — it changes
 * no score — so re-running the whole scorer (and possibly the network) for it
 * was pure latency on the most casual action in the product.
 */
export async function toggleMute(v: HealthDashboardView, r: PluginHealth): Promise<void> {
  if (r.muted) {
    await v.plugin.unmute(r.id);
    r.muted = false;
    r.mute = undefined;
    afterMuteChange(v);
    return;
  }
  // Muting asks for a span and a reason. A one-click permanent mute is a way
  // to make a real problem invisible forever, and the old menu item offered
  // nothing else — so a decision taken in a hurry outlived its reason with
  // nothing recorded about what the reason had been.
  new MuteModal(v.app, {
    pluginName: r.name,
    appVersion: apiVersion,
    onConfirm: (kind, reason) => {
      v.act(
        v.plugin.mute(r.id, kind, reason).then(() => {
          r.muted = true;
          r.mute = v.plugin.muteOf(r.id);
          afterMuteChange(v);
        }),
        `Couldn't mute ${r.name}`
      );
    },
  }).open();
}

/** Repaint after a mute change, without rescanning — it changes no score. */
export function afterMuteChange(v: HealthDashboardView): void {
  // It changes no score, but it changes every count and every finding: muted
  // rows are excluded from both.
  v.invalidateDerived();
  const s = v.summaryStats();
  v.plugin.updateStatusBar(
    s.avg,
    v.results.filter((x) => !x.muted)
  );
  const scrollTop = v.contentEl.scrollTop;
  const focusedId = v.focusedRowId();
  v.render();
  v.contentEl.scrollTop = scrollTop;
  v.restoreFocus(focusedId);
}

/**
 * Time every enabled plugin in one pass.
 *
 * Passive timing only ever catches the plugins Obsidian loads after FlowKit,
 * so on most vaults the column is mostly blank — which makes the whole
 * "why is my vault slow" answer partial. This fills it, at the cost of
 * genuinely restarting everything, so it is confirmed and it is Pro.
 */
/**
 * Enabled plugins that may be restarted for measurement — never FlowKit,
 * which cannot time its own load and would orphan the run by unloading it.
 */
export function profilableIds(v: HealthDashboardView): string[] {
  return searchableCandidates(
    v.results.filter((r) => r.enabled).map((r) => r.id),
    v.plugin.manifest.id
  );
}

/**
 * The plugins that still have no load time for the build now installed —
 * exactly the set "Profile the other N" counts, so the button cannot promise
 * one thing and do another.
 *
 * Distinct from `profilableIds`, which is every enabled plugin and is what
 * the Diagnose menu's "Profile startup" uses: that entry promises nothing
 * about a subset, and re-timing a plugin whose reading is old is the point
 * of it.
 */
export function unprofiledIds(v: HealthDashboardView): string[] {
  return searchableCandidates(
    v.results
      .filter(
        (r) => r.enabled && !r.muted && currentLoadMs(r.runtime, r.version) == null
      )
      .map((r) => r.id),
    v.plugin.manifest.id
  );
}

export function startProfileAll(v: HealthDashboardView, ids: string[]): void {
  if (v.plugin.profiling) {
    new Notice("Profiling is already running — wait for it to finish.");
    return;
  }
  // Same guard, milder consequence: profiling restarts every plugin in turn
  // and restores each to the state it found it in — which mid-search is the
  // search's state, not the user's — so it doesn't destroy the record, but it
  // does churn a vault that is deliberately half off and make the round's
  // question meaningless while it runs.
  // Via the helper, not a hand-rolled `!done`. `bisectOwnsPage()` exists for
  // exactly this question, and the hand-rolled version misses the case it was
  // introduced for: a search that reached `done` but could NOT put the
  // plugins back is deliberately left on disk, and this guard opened the
  // moment `done` was set — so profiling would cheerfully restart forty
  // plugins on top of a vault FlowKit had just recorded it was unable to
  // restore, and then "restore each to the state it found it in", which is
  // the broken state. The status bar was fixed for this in 1.6.1; this was
  // the other site reading the flag directly.
  if (v.plugin.bisectOwnsPage()) {
    new Notice(
      "Finish or stop the plugin search first — profiling would restart the plugins it has switched off.",
      8000
    );
    return;
  }
  // Safe mode is the same situation by a different route: the vault is
  // deliberately minimal, so every plugin profiling "restores" it restores to
  // off, and the run measures a vault nobody is using.
  if (v.plugin.settings.safeMode) {
    new Notice(
      "Leave safe mode first — profiling would only measure the plugins safe mode has left running.",
      8000
    );
    return;
  }
  if (!v.plugin.isPro) {
    v.openUpgrade("profile");
    return;
  }
  new BulkConfirmModal(v.app, {
    title: `Profile ${ids.length} plugins?`,
    intro:
      `FlowKit will switch each plugin off and straight back on, one at a time, and ` +
      `time how long each takes to load. Expect this to take a few seconds and for the ` +
      `interface to flicker while it runs.`,
    rows: [
      {
        name: "Everything restarts",
        detail:
          "Anything a plugin is holding in memory but hasn't written is lost, and views they own will reload. Nothing is uninstalled and nothing stays off.",
      },
      {
        name: "Do it when you're not mid-note",
        detail: "Finish what you're writing first. This is a measurement, not a repair.",
      },
    ],
    confirmLabel: `Profile ${ids.length}`,
    onConfirm: () => void runProfileAll(v, ids),
  }).open();
}

export async function runProfileAll(v: HealthDashboardView, ids: string[]): Promise<void> {
  const notice = new Notice(`Profiling 0 of ${ids.length}…`, 0);
  try {
    const result = await v.plugin.profileAll(ids, (done, total, id) => {
      notice.setMessage(`Profiling ${done} of ${total} — ${id}`);
    });
    notice.hide();
    if (!result) {
      new Notice("Runtime measurement is switched off — turn it on in settings first.");
      return;
    }
    // A plugin left in the wrong state is not a footnote to a success
    // message. The run stops on it, and it is the only thing worth saying.
    if (result.stranded) {
      const err = result.stranded;
      const name = v.results.find((r) => r.id === err.pluginId)?.name ?? err.pluginId;
      new Notice(
        `Profiling stopped: FlowKit couldn't switch ${name} back ${
          err.wasEnabled ? "on" : "off"
        }. Set it from Settings → Community plugins, or restart Obsidian — this change wasn't saved, so a restart undoes it.`,
        0
      );
      await v.refresh(false, false);
      return;
    }
    new Notice(
      result.failed.length
        ? `Profiled ${result.measured} plugins. ${result.failed.length} couldn't be measured.`
        : `Profiled ${result.measured} plugins.`,
      6000
    );
    await v.refresh(false, false);
  } catch (err) {
    notice.hide();
    console.error("FlowKit: profiling failed", err);
    new Notice("Profiling stopped early — see the console.");
    await v.refresh(false, false);
  }
}

/** Show what a bulk action will do, then do it — and keep a way back. */
export function runBulk(v: HealthDashboardView, ins: Insight): void {
  if (!ins.action || !ins.ids.length) return;
  const action: BulkAction = ins.action;
  const affected = v.results.filter((r) => ins.ids.includes(r.id));
  const disabling = action !== "mute-sideloaded";
  // Only rows the action would actually change — disabling something already
  // disabled is a no-op that used to be counted and reported anyway.
  const rows = disabling ? affected.filter((r) => r.enabled) : affected.filter((r) => !r.muted);

  if (!rows.length) {
    new Notice("Nothing to change — those plugins are already in that state.");
    return;
  }

  new BulkConfirmModal(v.app, {
    title: disabling ? "Disable these plugins?" : "Mute these plugins?",
    intro: disabling
      ? `FlowKit will turn off ${rows.length} plugin${rows.length === 1 ? "" : "s"}. Nothing is uninstalled, and you can undo this straight after.`
      : `FlowKit will hide ${rows.length} plugin${rows.length === 1 ? "" : "s"} from the at-risk counts. Their scores stay visible.`,
    rows: rows.map((r) => ({
      name: r.name,
      detail: bulkReason(v, r, action),
    })),
    caveat: disabling
      ? "A plugin with no recent release isn't necessarily broken — some are simply finished. Cancel and disable them individually from the row menu if you'd rather keep some."
      : undefined,
    confirmLabel: disabling
      ? `Disable ${rows.length}`
      : `Mute ${rows.length}`,
    // Through `act`, like every other action a user asked for: `applyBulk`
    // ends in a settings write, and on a read-only or sync-locked vault a
    // bare `void` meant the button reported nothing at all — see `act`.
    onConfirm: () =>
      v.act(
        applyBulk(v, action, rows.map((r) => r.id)),
        disabling ? "Couldn't disable those plugins" : "Couldn't mute those plugins"
      ),
  }).open();
}

/** The evidence for one row appearing in a bulk list. */
export function bulkReason(v: HealthDashboardView, r: PluginHealth, action: BulkAction): string {
  if (action === "disable-incompatible") {
    return r.metrics.compatibility.detail;
  }
  if (action === "disable-unmaintained") {
    return r.metrics.maintenance.detail || "No recorded update in over 18 months.";
  }
  return "Not in Obsidian's community list.";
}

export async function applyBulk(v: HealthDashboardView, action: BulkAction, ids: string[]): Promise<void> {
  if (action === "mute-sideloaded") {
    const changed = await v.plugin.muteMany(ids);
    v.lastBulk = {
      label: `Muted ${changed.length} plugin${changed.length === 1 ? "" : "s"}`,
      revert: async () => {
        await v.plugin.unmuteMany(changed);
      },
    };
    new Notice(`Muted ${changed.length} plugin${changed.length === 1 ? "" : "s"}.`);
  } else {
    const { changed, failed } = await v.plugin.disableMany(ids);
    if (changed.length) {
      v.lastBulk = {
        label: `Disabled ${changed.length} plugin${changed.length === 1 ? "" : "s"}`,
        revert: async () => {
          const back = await v.plugin.enableMany(changed);
          if (back.failed.length) throw new Error(describeFailed(back.failed));
        },
      };
    }
    // Report what happened, not what was asked for. A count that includes
    // plugins which refused to move is the kind of small lie that is only
    // discovered when the user goes looking for the plugin they were told
    // was off.
    new Notice(
      failed.length
        ? `Disabled ${changed.length} of ${rowsLabel(ids.length)}. ${describeFailed(failed)}`
        : `Disabled ${changed.length} plugin${changed.length === 1 ? "" : "s"}.`,
      failed.length ? 10_000 : undefined
    );
  }
  await v.refresh(false, false);
}

export async function undoLastBulk(v: HealthDashboardView): Promise<void> {
  const last = v.lastBulk;
  if (!last) return;
  try {
    await last.revert();
    // Only forget the undo once it actually succeeded — clearing it first
    // removed the user's way back while leaving the change in place.
    v.lastBulk = null;
    new Notice("Reverted.");
  } catch (err) {
    console.error("FlowKit: undo failed", err);
    new Notice("Couldn't undo that — see the console. The Undo button is still there.");
  }
  await v.refresh(false, false);
}

/**
 * Time one plugin's load by restarting it.
 *
 * Confirmed first, and honest about the cost: this genuinely turns the plugin
 * off and on again, so anything holding unsaved in-memory state loses it.
 * That is the price of a real number instead of a file size.
 */
export async function measureLoad(v: HealthDashboardView, r: PluginHealth): Promise<void> {
  if (v.plugin.profiling) {
    new Notice("Profiling is running — wait for it to finish before measuring one plugin.");
    return;
  }
  new BulkConfirmModal(v.app, {
    title: `Measure ${r.name}?`,
    intro:
      "FlowKit will turn this plugin off and straight back on, and time how " +
      "long it takes to load. There is no other way to measure a plugin that " +
      "was already running before FlowKit started.",
    rows: [
      {
        name: r.name,
        detail:
          "It restarts, so anything it is holding in memory but hasn't saved is lost. Views it owns will reload.",
      },
    ],
    caveat:
      "Not something to run on a plugin you're in the middle of using — finish the note first.",
    confirmLabel: "Measure it",
    onConfirm: () => {
      void v.plugin
        .measureLoad(r.id)
        .then(async (ms) => {
          if (ms == null) {
            new Notice("Couldn't measure that one — see the console.");
            return;
          }
          new Notice(`${r.name} loaded in ${Math.round(ms)} ms.`);
          await v.refresh(false, false);
        })
        .catch(async (err) => {
          console.error("FlowKit: measurement failed", err);
          new Notice(
            `FlowKit couldn't switch ${r.name} back on after measuring it. Turn it on from Settings → Community plugins, or restart Obsidian.`,
            0
          );
          await v.refresh(false, false);
        });
    },
  }).open();
}

export function startExperiment(v: HealthDashboardView): void {
  if (v.refuseDuringSearch("the baseline would be measured on the plugins it has switched off")) return;
  if (v.plugin.settings.healthExperiment) {
    new Notice("A health experiment is already active — compare it after changing your setup.");
    return;
  }
  if (!v.plugin.canPersist) {
    new Notice("FlowKit can't save an experiment while its settings file is unreadable.", 8000);
    return;
  }
  v.act(
    v.plugin.startHealthExperiment("Before/after health check", v.results).then((started) => {
      if (started) new Notice("Baseline saved. Change your plugin setup, then compare the result.");
      v.render();
    }),
    "Couldn't start the health experiment"
  );
}

export function startSafeMode(v: HealthDashboardView): void {
  // Checked before the Pro gate, like a running search in startBisect: the
  // answer to "a search is running" is not a checkout page.
  if (v.refuseDuringSearch("safe mode would save the search's half-off set as your original one")) return;
  if (!v.plugin.isPro) {
    v.openUpgrade("profiles");
    return;
  }
  if (v.plugin.settings.safeMode) {
    new Notice("Safe mode is already active — restore the original set first.");
    return;
  }
  // Safe mode keeps the watched plugins on, and until a scan has landed
  // FlowKit doesn't know which those are. Confirming then switched off
  // everything but FlowKit, under a dialog that said "the other 0".
  if (v.refreshing || v.results.length === 0) {
    new Notice("Wait for the scan to finish — safe mode keeps your watched plugins on, and FlowKit doesn't know which those are yet.");
    return;
  }
  const keep = v.results
    .filter((r) => r.enabled && r.watched)
    .map((r) => r.id);
  // The dialog states the plan main will carry out, from the live plugin
  // registry. Counting the scan instead assumed FlowKit was a watched row
  // and was off by one (or by everything, before the first scan).
  const plan = v.plugin.planSafeMode(keep);
  const kept = plan.session.keepEnabled.filter((id) => id !== v.plugin.manifest.id);
  if (plan.disable.length === 0) {
    new Notice("Nothing to switch off — only FlowKit and your watched plugins are on.");
    return;
  }
  const nameOf = (id: string): string => v.results.find((r) => r.id === id)?.name ?? id;
  const rows = [
    {
      name: "Nothing is uninstalled",
      detail: "Safe mode only changes enabled state. Restore the original set when you are done testing.",
    },
  ];
  if (kept.length) rows.push({ name: "Stays on", detail: kept.map(nameOf).join(", ") });
  new BulkConfirmModal(v.app, {
    title: "Start safe mode?",
    intro: `FlowKit will keep ${
      kept.length ? `itself and ${kept.length} watched plugin${kept.length === 1 ? "" : "s"}` : "only itself"
    } on, and switch off the other ${plan.disable.length} enabled plugin${
      plan.disable.length === 1 ? "" : "s"
    }. Your original set is saved and can be restored.`,
    rows,
    confirmLabel: "Start safe mode",
    onConfirm: () => {
      v.act(
        v.plugin.startSafeMode(keep).then((result) => {
          if (!result) {
            new Notice("Safe mode didn't start — FlowKit can't save its settings right now, or a search is running.", 8000);
            return;
          }
          // An Undo from before safe mode would be reversed by "Restore
          // original set" without a word; it no longer describes this vault.
          v.lastBulk = null;
          new Notice(
            result.failed.length
              ? `Safe mode started with failures: ${describeFailed(result.failed)}`
              : "Safe mode started. Reproduce the problem, then restore your original set.",
            result.failed.length ? 10000 : undefined
          );
          void v.refresh(false, false);
        }),
        "Couldn't start safe mode"
      );
    },
  }).open();
}

export function startBisect(v: HealthDashboardView): void {
  // A search already running is checked FIRST — before the Pro gate, so a
  // free user isn't sent to a checkout page as the answer to "you already
  // have one of these open".
  //
  // Starting a second search is the one action in this plugin that destroys
  // user state irreversibly. `main.startBisect` captures the CURRENTLY
  // enabled set as both the AUTO_SNAPSHOT profile and the new session's
  // `originalEnabled` — and mid-search that set is missing every plugin the
  // first search switched off. Both records of the real vault are overwritten
  // in the same breath, and nothing else holds it: the timeline is suppressed
  // while a search runs, so those plugins are simply orphaned, under a modal
  // that has just promised "your current set is saved first".
  if (v.plugin.bisect) {
    new Notice(
      "A search is already running — finish it or stop and restore before starting another.",
      8000
    );
    v.render();
    return;
  }
  if (!v.plugin.isPro) {
    v.openUpgrade("bisect");
    return;
  }
  // FlowKit is filtered out before the count and the round estimate, so the
  // modal promises a search over the plugins that will actually be tested.
  const candidates = searchableCandidates(
    v.results
      .filter((r) => r.enabled)
      .sort((a, b) => (a.overall ?? 100) - (b.overall ?? 100))
      .map((r) => r.id),
    v.plugin.manifest.id
  );

  if (candidates.length < 2) {
    new Notice("Bisect needs at least two enabled plugins to search.");
    return;
  }

  // Checked before the modal, not after it. Offering to start a search and
  // then refusing at the moment of confirmation is the same information
  // delivered at the worst point.
  if (!v.plugin.canPersist) {
    new Notice(
      "FlowKit can't start a search while it can't save its settings: the record of which " +
        "plugins to switch back on afterwards wouldn't survive a restart. Restart Obsidian first.",
      10_000
    );
    return;
  }

  new BisectStartModal(v.app, {
    candidateCount: candidates.length,
    maxRounds: roundsNeeded(candidates.length),
    snapshotName: AUTO_SNAPSHOT,
    onConfirm: (symptom) => {
      void runBisectAction(v, async () => {
        await v.plugin.startBisect(candidates, symptom || undefined);
        v.lastBulk = null;
      });
    },
  }).open();
}

export function saveProfile(v: HealthDashboardView): void {
  if (v.refuseDuringSearch("the set saved would be the search's, not yours")) return;
  if (!v.plugin.isPro) {
    v.openUpgrade("profiles");
    return;
  }
  const count = v.results.filter((r) => r.enabled).length;
  new SaveProfileModal(v.app, {
    count,
    existing: v.plugin.settings.profiles,
    onConfirm: (name) => {
      v.act(
        v.plugin.saveCurrentProfile(name).then((stored) => {
          // Reporting a save that FlowKit refused to make is the small
          // version of the same lie the banner exists to prevent.
          new Notice(
            stored
              ? `Saved “${name}”.`
              : `Couldn't save “${name}” — FlowKit can't write its settings file this session.`,
            stored ? undefined : 8000
          );
          v.render();
        }),
        `Couldn't save “${name}”`
      );
    },
  }).open();
}

/** Switch to a saved set, after showing exactly what it would change. */
export function applyProfile(v: HealthDashboardView, profile: PluginProfile): void {
  // Switching sets mid-search would silently replace the round's plugin set
  // with a different one, and the next answer would then be about a vault the
  // search never asked a question about.
  // `bisectOwnsPage`, not `!done`: a search that finished but couldn't put
  // the plugins back is still on disk, and switching sets over it would
  // record and undo against a vault FlowKit has said it couldn't restore.
  if (v.refuseDuringSearch("switching sets would change the plugins it is testing")) return;
  if (!v.plugin.isPro) {
    v.openUpgrade("profiles");
    return;
  }
  const delta = v.plugin.deltaFor(profile);
  if (isNoop(delta)) {
    new Notice(`“${profile.name}” is already what you're running.`);
    return;
  }
  const name = (id: string): string =>
    v.results.find((r) => r.id === id)?.name ?? id;
  const rows = [
    ...delta.enable.map((id) => ({ name: name(id), detail: "Would be switched on." })),
    ...delta.disable.map((id) => ({ name: name(id), detail: "Would be switched off." })),
  ];
  // Named, not counted: a profile captured months ago can quietly no longer
  // mean what its name says, and this is the moment to find that out.
  if (delta.missing.length) {
    rows.push({
      name: `${delta.missing.length} no longer installed`,
      detail: `Recorded in this set but not in this vault: ${delta.missing.join(", ")}.`,
    });
  }

  new BulkConfirmModal(v.app, {
    title: `Switch to “${profile.name}”?`,
    intro: `${delta.enable.length} on, ${delta.disable.length} off. Nothing is uninstalled, and you can undo this straight after.`,
    rows,
    confirmLabel: "Switch",
    onConfirm: () => void runApplyProfile(v, profile),
  }).open();
}

export async function runApplyProfile(v: HealthDashboardView, profile: PluginProfile): Promise<void> {
  const applied = await v.plugin.applyProfile(profile);
  if (applied.enable.length || applied.disable.length) {
    v.lastBulk = {
      label: `Switched to “${profile.name}”`,
      revert: async () => {
        // The exact inverse of what was actually changed, not of what was
        // requested — so undo can't switch on something that was already off.
        const off = await v.plugin.disableMany(applied.enable);
        const on = await v.plugin.enableMany(applied.disable);
        const failed = [...off.failed, ...on.failed];
        if (failed.length) throw new Error(describeFailed(failed));
      },
    };
  }
  new Notice(
    applied.failed.length
      ? `Switched to “${profile.name}”, but not completely. ${describeFailed(applied.failed)}`
      : `Switched to “${profile.name}”.`,
    applied.failed.length ? 10_000 : undefined
  );
  await v.refresh(false, false);
}

/** Star or unstar a plugin, without rescanning — it changes no score. */
export async function toggleWatch(v: HealthDashboardView, r: PluginHealth): Promise<void> {
  const watching = await v.plugin.toggleWatch(r.id);
  r.watched = watching;
  v.invalidateDerived();
  new Notice(
    watching
      ? `Watching ${r.name} — FlowKit will lead with it when something changes.`
      : `No longer watching ${r.name}.`
  );
  const scrollTop = v.contentEl.scrollTop;
  const focusedId = v.focusedRowId();
  v.render();
  v.contentEl.scrollTop = scrollTop;
  v.restoreFocus(focusedId);
}
