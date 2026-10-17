/** The plugin search panel, the salvage banner for an unreadable search record, and the transitions that drive a search. */
import { Notice, setIcon } from "obsidian";
import { describeRound, remainingText } from "../bisect";
import { AUTO_SNAPSHOT } from "../profiles";
import { runApplyProfile } from "./vaultActions";
import type { HealthDashboardView } from "../view";

/**
 * A search in progress.
 *
 * Deliberately the loudest thing on the page while it runs: the vault is
 * currently in a state the user did not choose, and every number below is
 * measured against that state rather than their real setup.
 */
export function renderBisect(v: HealthDashboardView, root: HTMLElement): void {
  const state = v.plugin.bisect;
  if (!state) return;

  const box = root.createDiv({ cls: "flowkit-bisect" });
  // Announced, not merely repainted. This panel is the whole interface for an
  // operation that switches plugins off — its round, its progress, its
  // failures and its result all arrive by replacing DOM, so without a live
  // region a screen-reader user starts a search that rearranges their vault
  // and is then told nothing at all about what it is doing.
  box.setAttr("role", "region");
  box.setAttr("aria-live", "polite");
  box.setAttr("aria-label", "Plugin search");
  const head = box.createDiv({ cls: "flowkit-bisect-head" });
  setIcon(head.createSpan({ cls: "flowkit-bisect-icon" }), "search-check");
  head.createSpan({
    cls: "flowkit-bisect-title",
    text: state.done ? "Search finished" : "Finding what's breaking your vault",
  });
  head.createSpan({ cls: "flowkit-bisect-progress", text: remainingText(state) });

  if (state.done) {
    const culprit = state.culprit
      ? (v.results.find((r) => r.id === state.culprit)?.name ?? state.culprit)
      : null;
    const body = box.createDiv({ cls: "flowkit-bisect-body" });
    // "It's X" would be a claim of proof, and elimination doesn't give you
    // one: a symptom can need two plugins together, disabling one can break
    // another, and some plugins don't fully unload without a restart. The
    // search narrows honestly; the sentence should too.
    // The last clause is conditional, because on the failed-restore path it
    // was a flat contradiction of the error box rendered directly beneath it:
    // "everything else is back on", above "FlowKit couldn't switch X back on".
    const restored = v.plugin.bisectError
      ? " It is off now — but FlowKit could not switch everything else back on; see below."
      : " It is off now; everything else is back on.";
    body.setText(
      culprit
        ? `${culprit} is the one. With it switched off the problem went away, and with it on it came back — that is as close to proof as switching things off can get.${restored}`
        : "The problem survived with every candidate switched off, so no installed plugin is causing it. Worth looking at your theme, CSS snippets, or Obsidian itself."
    );
    if (v.plugin.bisectError) {
      const warn = box.createDiv({ cls: "flowkit-bisect-error" });
      setIcon(warn.createSpan({ cls: "flowkit-bisect-error-icon" }), "alert-triangle");
      warn.createSpan({ text: v.plugin.bisectError });
    }
    const actions = box.createDiv({ cls: "flowkit-bisect-actions" });
    const done = actions.createEl("button", { cls: "mod-cta", text: culprit ? "Keep it off" : "Restore everything" });
    // `false` when there is nothing to keep off: passing `true` happened to
    // be harmless only because `culprit` is falsy downstream, which is the
    // kind of accidental correctness that stops being correct on the next
    // edit.
    done.onclick = () =>
      void runBisectAction(v, () => v.plugin.finishBisect(culprit != null));
    if (culprit) {
      const restore = actions.createEl("button", { text: "Turn it back on too" });
      restore.onclick = () => void runBisectAction(v, () => v.plugin.finishBisect(false));
    }
    // Undo belongs here most of all, and this branch returned before ever
    // offering it — so the search could be un-answered on every round except
    // the one that produces the accusation. That is the answer people are
    // likeliest to get wrong (it is given after the longest wait, on the
    // smallest difference) and the only one whose mistake has a name attached
    // to it. Going back re-establishes the round and asks again.
    if (v.plugin.bisectCanUndo) {
      const back = actions.createEl("button", {
        cls: "flowkit-bisect-undo",
        text: culprit ? "That's not it — go back" : "Go back a step",
      });
      back.setAttr(
        "aria-label",
        "Take back the last answer and test that round again"
      );
      back.onclick = () =>
        void runBisectAction(v, async () => {
          const restored = await v.plugin.undoBisectAnswer();
          if (restored) new Notice("Went back a step — test this round again.");
        });
    }
    for (const btn of Array.from(actions.querySelectorAll("button"))) {
      btn.disabled = v.bisectBusy || v.plugin.bisectBusy;
    }
    return;
  }

  if (state.symptom) {
    box.createDiv({
      cls: "flowkit-bisect-symptom",
      text: `Testing for: ${state.symptom}`,
    });
  }

  // The vault is not in the state this round describes — because Obsidian was
  // closed partway through switching plugins over, or because the user went
  // and changed things themselves. FlowKit cannot tell those apart, and the
  // second one is very often somebody deliberately getting out of a search
  // that was going badly. So it asks instead of deciding.
  if (v.plugin.bisectDrifted()) {
    const drift = box.createDiv({ cls: "flowkit-bisect-error" });
    setIcon(drift.createSpan({ cls: "flowkit-bisect-error-icon" }), "help-circle");
    drift.createSpan({
      text:
        "Your plugins don't match the round this search was on — either it was interrupted, " +
        "or they were changed by hand. Answering now would be answering about a different set.",
    });
    const choose = box.createDiv({ cls: "flowkit-bisect-actions" });
    const resume = choose.createEl("button", { cls: "mod-cta", text: "Put them back and carry on" });
    resume.onclick = () => void runBisectAction(v, () => v.plugin.resumeBisect());
    const abandon = choose.createEl("button", { text: "Stop the search" });
    abandon.onclick = () => void runBisectAction(v, () => v.plugin.cancelBisect());
    for (const btn of [resume, abandon]) {
      btn.disabled = v.bisectBusy || v.plugin.bisectBusy;
    }
    return;
  }

  box.createDiv({ cls: "flowkit-bisect-body", text: describeRound(state) });

  const off = state.disabled
    .map((id) => v.results.find((r) => r.id === id)?.name ?? id)
    .sort((a, b) => a.localeCompare(b));
  const list = box.createEl("details", { cls: "flowkit-bisect-list" });
  list.createEl("summary", { text: `Currently switched off (${off.length})` });
  list.createDiv({ text: off.join(", ") });

  // A round that could not be established is not a round. Answering it would
  // be answering about a set of plugins the vault is not actually in, and
  // this search's whole output is a name it puts in front of the user.
  const blocked = v.plugin.bisectError;
  if (blocked) {
    const warn = box.createDiv({ cls: "flowkit-bisect-error" });
    setIcon(warn.createSpan({ cls: "flowkit-bisect-error-icon" }), "alert-triangle");
    warn.createSpan({ text: blocked });
  }

  const actions = box.createDiv({ cls: "flowkit-bisect-actions" });
  // Every control locks together for the duration of a transition. Locking
  // only the button that was pressed still lets "the problem is gone" and
  // "still happening" interleave into two different next rounds.
  const busy = v.bisectBusy || v.plugin.bisectBusy;
  const gone = actions.createEl("button", { cls: "mod-cta", text: "The problem is gone" });
  gone.onclick = () => void answerBisect(v, true);
  const still = actions.createEl("button", { text: "Still happening" });
  still.onclick = () => void answerBisect(v, false);
  // The way back from a mis-click.
  //
  // Both buttons above are irreversible and each throws away half the
  // remaining suspects — so pressing one before you had actually checked
  // produces a search that finishes normally and names the wrong plugin, with
  // nothing anywhere to suggest it went wrong. This is the cheapest possible
  // guard against the most likely mistake in the feature. Placed before Stop,
  // which is pushed to the far end of the row.
  if (v.plugin.bisectCanUndo) {
    const back = actions.createEl("button", {
      cls: "flowkit-bisect-undo",
      text: "Undo last answer",
    });
    back.setAttr(
      "aria-label",
      "Take back the previous answer and put your plugins into the round it was asked about"
    );
    back.disabled = busy;
    back.onclick = () =>
      void runBisectAction(v, async () => {
        const restored = await v.plugin.undoBisectAnswer();
        if (restored) new Notice("Went back a step — test this round again.");
      });
  }

  const stop = actions.createEl("button", { cls: "flowkit-bisect-stop", text: "Stop and restore" });
  stop.onclick = () => void runBisectAction(v, () => v.plugin.cancelBisect());
  for (const btn of [gone, still]) btn.disabled = busy || blocked != null;
  stop.disabled = busy;
  if (busy) {
    box.createDiv({
      cls: "flowkit-bisect-note",
      text: "Switching plugins over for this round…",
    });
  }

  box.createDiv({
    cls: "flowkit-bisect-note",
    text: "Some plugins only fully unload after a restart. If nothing seems different, restart Obsidian and answer then — the search survives it.",
  });
}

/**
 * A bisect record that couldn't be read back, and the way out of it.
 *
 * The record used to be deleted on sight for being malformed. That is the
 * right call for any other setting and the wrong one for this: the vault it
 * describes may be half switched off right now, and deleting it removes the
 * only thing that knew what "back to normal" meant.
 */
export function renderSalvage(v: HealthDashboardView, root: HTMLElement): void {
  if (!v.plugin.bisectSalvage) return;
  const snapshot = v.plugin.settings.profiles.find((p) => p.name === AUTO_SNAPSHOT);
  const box = root.createDiv({ cls: "flowkit-bisect flowkit-bisect-salvage" });
  const head = box.createDiv({ cls: "flowkit-bisect-head" });
  setIcon(head.createSpan({ cls: "flowkit-bisect-icon" }), "life-buoy");
  head.createSpan({
    cls: "flowkit-bisect-title",
    text: "An unfinished search couldn't be read",
  });
  box.createDiv({
    cls: "flowkit-bisect-body",
    text: snapshot
      ? "FlowKit found a damaged record of a plugin search. If your vault has plugins switched off that you didn't switch off, this will put back the set it saved when the search started."
      : "FlowKit found a damaged record of a plugin search, and no snapshot to restore from. If plugins are switched off that you didn't switch off, turn them back on from Settings → Community plugins.",
  });
  const actions = box.createDiv({ cls: "flowkit-bisect-actions" });
  if (snapshot) {
    const restore = actions.createEl("button", {
      cls: "mod-cta",
      text: "Restore my plugins",
    });
    restore.onclick = () => {
      v.plugin.bisectSalvage = null;
      void runApplyProfile(v, snapshot);
    };
  }
  const dismiss = actions.createEl("button", { text: "Dismiss" });
  dismiss.onclick = () => {
    v.plugin.bisectSalvage = null;
    v.render();
  };
}

/** Run a bisect transition with every control locked for its duration. */
export async function runBisectAction(v: HealthDashboardView, fn: () => Promise<unknown>): Promise<void> {
  if (v.bisectBusy) return;
  v.bisectBusy = true;
  v.render();
  try {
    await fn();
  } catch (err) {
    // Deliberately not "the search is where it was". It may not be: a round
    // is persisted before it is applied, so a failure part-way through leaves
    // the recorded round ahead of the vault — which is exactly the state the
    // drift prompt and the pause exist to handle. Claiming nothing moved
    // would talk the user past both.
    console.error("FlowKit: bisect step failed", err);
    new Notice(
      "That step didn't finish. FlowKit has re-read your plugins — check the search panel before answering.",
      8000
    );
  } finally {
    v.bisectBusy = false;
    await v.refresh(false, false);
  }
}

export async function answerBisect(v: HealthDashboardView, gone: boolean): Promise<void> {
  await runBisectAction(v, async () => {
    const next = await v.plugin.answerBisect(gone);
    if (next?.done && next.culprit && !v.plugin.bisectError) {
      const name = v.results.find((r) => r.id === next.culprit)?.name ?? next.culprit;
      new Notice(`Found it: ${name}.`, 8000);
    }
  });
}
