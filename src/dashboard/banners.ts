/** The notices above the report: what changed, what an update broke, recovery sessions, coverage and the one-off banners. */
import { Notice, setIcon } from "obsidian";
import type { HealthChange } from "../types";
import { describeEvent, describeGap } from "../timeline";
import { LAST_KNOWN_GOOD, isNoop } from "../profiles";
import { compareHealth } from "../experiments";
import { describeFailed, describeChange, describeWhen } from "./format";
import { undoLastBulk, startExperiment, applyProfile } from "./vaultActions";
import type { HealthDashboardView } from "../view";

/**
 * What moved since the user last looked.
 *
 * This is the answer to the product's structural problem — that it was a
 * report you read once. Every other section renders the same thing on every
 * visit; this one is the only part of the screen that is new.
 */
export function renderChanges(v: HealthDashboardView, root: HTMLElement): void {
  const unseen = v.plugin.unseenChanges();
  const since = v.plugin.settings.lastSeenChangeAt;
  const events = v.plugin.eventsSince(since ?? 0);
  if (!unseen.length && !events.length) return;
  const box = root.createDiv({ cls: "flowkit-changes" });
  const head = box.createDiv({ cls: "flowkit-changes-head" });
  setIcon(head.createSpan({ cls: "flowkit-changes-icon" }), "history");
  head.createSpan({
    cls: "flowkit-changes-title",
    text: since ? `Since ${describeWhen(since)}` : "Since you last looked",
  });
  const dismiss = head.createEl("button", { cls: "flowkit-changes-dismiss", text: "×" });
  dismiss.setAttr("aria-label", "Mark these as seen");
  dismiss.onclick = () => {
    v.act(
      v.plugin.markChangesSeen().then(() => v.render()),
      "Couldn't mark those as seen"
    );
  };

  // Newest first, and the ones that matter before the merely informational.
  const ranked = [...unseen].sort((a, b) => {
    const weight = (k: HealthChange["kind"]): number =>
      k === "resolved" ? 2 : k === "update-published" ? 1 : 0;
    return weight(a.kind) - weight(b.kind) || b.at - a.at;
  });
  const list = box.createDiv({ cls: "flowkit-changes-list" });
  const total = ranked.length + events.length;
  for (const change of ranked.slice(0, 3)) {
    const line = list.createDiv({
      cls: `flowkit-change is-${change.kind === "resolved" ? "good" : "bad"}`,
    });
    line.createSpan({ cls: "flowkit-change-name", text: change.name });
    line.createSpan({ cls: "flowkit-change-what", text: ` ${describeChange(change.kind)}` });
  }
  for (const event of events.slice(0, Math.max(0, 3 - ranked.length))) {
    const line = list.createDiv({ cls: "flowkit-change is-info" });
    line.createSpan({ cls: "flowkit-change-name", text: event.name });
    line.createSpan({ cls: "flowkit-change-what", text: ` ${describeEvent(event)}` });
  }
  if (total > 3) {
    list.createDiv({
      cls: "flowkit-changes-more",
      text: `+${total - 3} more`,
    });
  }
}

/**
 * Say when nothing the user does here will stick.
 *
 * FlowKit refuses to write over a data.json it couldn't read, which is the
 * right call — but silently refusing is not: the licence key would appear to
 * activate, the mute would appear to take, and none of it would survive a
 * restart.
 */
export function renderUnreadable(v: HealthDashboardView, root: HTMLElement): void {
  if (!v.plugin.settingsUnreadable) return;
  const box = root.createDiv({ cls: "flowkit-coverage-note is-bad" });
  box.setAttr("role", "alert");
  setIcon(box.createSpan({ cls: "flowkit-coverage-icon" }), "file-warning");
  const body = box.createDiv({ cls: "flowkit-coverage-body" });
  body.createDiv({
    text:
      "FlowKit couldn't read its settings file, so it is running on defaults and will not " +
      "save anything this session — your licence, history and saved sets are untouched on disk.",
  });
  // "Restart Obsidian" was the only advice offered, and for the case this
  // banner actually describes it is not advice at all: a file that is
  // malformed is still malformed after a restart, so the user restarts,
  // sees the same banner, and has been sent in a circle. A restart is worth
  // trying once — the file may only have been locked by a sync client — but
  // the way out of the other case is knowing which file to go and look at.
  body.createDiv({
    cls: "flowkit-detail-muted",
    text:
      `If it was only locked — a sync client mid-write, say — restarting Obsidian clears it. ` +
      `If the banner comes back, the file itself is damaged: close Obsidian and rename ` +
      `${v.plugin.dataFilePath()} to keep a copy, and FlowKit will start fresh. You lose ` +
      `your history and saved sets; your licence key can be pasted back in.`,
  });
  const copy = box.createEl("button", { text: "Copy the file path" });
  copy.onclick = () => {
    v.act(
      navigator.clipboard
        .writeText(v.plugin.dataFilePath())
        .then(() => new Notice("Path copied.")),
      "Couldn't copy the path"
    );
  };
}

/**
 * Changes that were followed by errors.
 *
 * FlowKit already stored both halves of this and never put them together.
 * "Templater has thrown 40 errors" is a fact; "Templater started throwing
 * errors two hours after it updated to 2.4.1" is a diagnosis, and it is the
 * same data.
 */
export function renderCorrelations(v: HealthDashboardView, root: HTMLElement): void {
  const found = v.plugin.correlations(v.results);
  if (!found.length) return;

  const box = root.createDiv({ cls: "flowkit-correlation" });
  const head = box.createDiv({ cls: "flowkit-correlation-head" });
  setIcon(head.createSpan({ cls: "flowkit-correlation-icon" }), "git-compare");
  head.createSpan({
    cls: "flowkit-correlation-title",
    text: found.length === 1 ? "This looks related" : "These look related",
  });

  for (const c of found.slice(0, 3)) {
    const line = box.createDiv({ cls: "flowkit-correlation-line" });
    line.createSpan({ cls: "flowkit-change-name", text: c.name });
    // "2 hours after" is a claim about ordering. When the errors began inside
    // the window the change happened in, that ordering isn't known, and
    // asserting it would be the kind of confident wrongness this product is
    // supposed to be the opposite of.
    line.createSpan({
      text: c.approximate
        ? ` started throwing errors around the time it ${describeEvent(c.event)}.`
        : ` started throwing errors ${describeGap(c.gapMs)} after it ${describeEvent(c.event)}.`,
    });
  }
  box.createDiv({
    cls: "flowkit-correlation-note",
    // Said plainly, because the inference is genuinely weak — it is a
    // sequence, not a cause, and presenting it as proof would be the exact
    // kind of confident wrongness the scoring rework removed everywhere else.
    text: "That is a sequence, not proof. It is usually where to look first.",
  });
}

/**
 * What the last Obsidian update did to this vault.
 *
 * This is the moment somebody opens a plugin-health dashboard: an update
 * landed and something stopped working. Every other section can answer "what
 * is wrong"; only this one answers "what did *that* change", which is the
 * question actually being asked — and it leads the page for exactly as long
 * as it is news.
 */
export function renderAppUpdate(v: HealthDashboardView, root: HTMLElement): void {
  const change = v.plugin.recentAppUpdate();
  if (!change) return;

  // Re-resolve against the current scan rather than trusting the recorded
  // list: the user may have already updated or removed one of them, and a
  // banner naming a plugin that is fine now is worse than no banner.
  const broke = v.results.filter(
    (r) => change.brokeIds.includes(r.id) && r.metrics.compatibility.value === 0
  );
  const box = root.createDiv({
    cls: `flowkit-appupdate ${broke.length ? "is-bad" : "is-good"}`,
  });
  const head = box.createDiv({ cls: "flowkit-appupdate-head" });
  setIcon(head.createSpan({ cls: "flowkit-appupdate-icon" }), broke.length ? "alert-octagon" : "check-circle");
  head.createSpan({
    cls: "flowkit-appupdate-title",
    text: `Obsidian updated — ${change.from} → ${change.to}`,
  });
  const dismiss = head.createEl("button", {
    cls: "flowkit-changes-dismiss",
    text: "×",
  });
  dismiss.setAttr("aria-label", "Mark this as seen");
  dismiss.onclick = () => {
    v.act(
      // Only this banner. It used to share `markChangesSeen` with the "since
      // you last looked" strip, so closing one silently closed the other —
      // permanently, because the change log is read in exactly one place.
      v.plugin.markAppUpdateSeen().then(() => v.render()),
      "Couldn't mark that as seen"
    );
  };

  const body = box.createDiv({ cls: "flowkit-appupdate-body" });
  if (!broke.length) {
    // "all your plugins" is only true when disabled ones are being shown;
    // otherwise this scan never looked at them.
    const scope = v.plugin.settings.showDisabled
      ? `all ${v.results.length} of your plugins`
      : `your ${v.results.length} enabled plugins`;
    body.setText(
      `FlowKit re-checked ${scope} against ${change.to}. Nothing that worked before has stopped loading.`
    );
    return;
  }
  body.setText(
    `${broke.length} plugin${broke.length === 1 ? "" : "s"} can no longer load on this version: ${broke
      .map((r) => r.name)
      .join(", ")}. Check for updates first — an incompatible plugin is usually one release behind, not broken.`
  );
  const show = box.createEl("button", { cls: "mod-cta", text: "Show these" });
  show.onclick = () => v.applyScope("incompatible");
}

/** Persistent recovery and before/after tools that make remediation repeatable. */
export function renderHealthSessions(v: HealthDashboardView, root: HTMLElement): void {
  const safe = v.plugin.settings.safeMode;
  const knownGood = v.plugin.settings.profiles.find((p) => p.name === LAST_KNOWN_GOOD);
  const experiment = v.plugin.settings.healthExperiment;
  const regressions = v.plugin.settings.regressions.slice(-3).reverse();
  if (!safe && !knownGood && !experiment && !regressions.length) return;

  const box = root.createDiv({ cls: "flowkit-health-sessions" });
  const head = box.createDiv({ cls: "flowkit-section-head" });
  setIcon(head.createSpan({ cls: "flowkit-section-icon" }), "shield-check");
  head.createSpan({ cls: "flowkit-section-title", text: "Recovery and experiments" });

  if (safe) {
    const row = box.createDiv({ cls: "flowkit-session-row tone-warn" });
    row.createEl("strong", { text: "Safe mode is active" });
    row.createSpan({
      text: safe.restoreFailed?.length
        ? ` — restore needs attention for ${safe.restoreFailed.join(", ")}.`
        : ` — ${safe.keepEnabled.length} plugin${safe.keepEnabled.length === 1 ? "" : "s"} kept on.`,
    });
    const restore = row.createEl("button", { cls: "mod-cta", text: "Restore original set" });
    restore.onclick = () => {
      v.act(
        v.plugin.restoreSafeMode().then((result) => {
          if (!result) return;
          new Notice(
            result.failed.length
              ? `Safe mode restore incomplete: ${describeFailed(result.failed)}`
              : "Safe mode ended; your original plugin set is back.",
            result.failed.length ? 10000 : undefined
          );
          void v.refresh(false, false);
        }),
        "Couldn't restore safe mode"
      );
    };
  }

  if (knownGood && !safe) {
    const delta = v.plugin.deltaFor(knownGood);
    if (!isNoop(delta)) {
      const row = box.createDiv({ cls: "flowkit-session-row" });
      row.createEl("strong", { text: "Last known good" });
      row.createSpan({
        text: ` — ${knownGood.ids.length} plugins captured ${describeWhen(knownGood.at)}.`,
      });
      const restore = row.createEl("button", { text: "Restore it" });
      restore.onclick = () => applyProfile(v, knownGood);
    }
  }

  if (experiment) {
    const row = box.createDiv({ cls: "flowkit-session-row" });
    row.createEl("strong", { text: experiment.name });
    if (experiment.after) {
      const comparison = compareHealth(experiment.baseline, experiment.after);
      const delta = comparison.avgDelta;
      row.createSpan({
        text: ` — complete${delta == null ? "" : `; average ${delta >= 0 ? "+" : ""}${delta}`}.`,
      });
      const restart = row.createEl("button", { text: "Start another" });
      restart.onclick = () => {
        v.act(
          v.plugin.clearHealthExperiment().then(() => startExperiment(v)),
          "Couldn't reset the health experiment"
        );
      };
    } else {
      row.createSpan({ text: " — baseline saved; change your setup, then compare." });
      const finish = row.createEl("button", { text: "Compare after changes" });
      finish.onclick = () => {
        v.act(
          v.refresh(false, false).then(async (fresh) => {
            // A failed scan leaves the previous results in place, and those
            // are the "before". Comparing them would record no change at all.
            if (!fresh) {
              new Notice("FlowKit couldn't rescan, so nothing was compared. Try again in a moment.", 8000);
              return;
            }
            await v.plugin.finishHealthExperiment(v.results);
            v.render();
          }),
          "Couldn't complete the health experiment"
        );
      };
      const cancel = row.createEl("button", { text: "Cancel" });
      cancel.onclick = () => {
        v.act(
          v.plugin.clearHealthExperiment().then(() => v.render()),
          "Couldn't cancel the health experiment"
        );
      };
    }
  }

  if (regressions.length) {
    const row = box.createDiv({ cls: "flowkit-session-row tone-bad" });
    row.createEl("strong", { text: "Recent regressions" });
    row.createSpan({
      text: ` — ${regressions
        .map((r) => `${r.name} ${r.fromOverall}→${r.toOverall}`)
        .join(", ")}.`,
    });
  }
}

/**
 * Mutes that ran out.
 *
 * A mute with an expiry is only honest if its expiry is visible. Without
 * this, a plugin quietly rejoins the counts and the user reads it as the
 * score wobbling rather than as a decision they made lapsing on schedule.
 */
export function renderLapsedMutes(v: HealthDashboardView, root: HTMLElement): void {
  if (!v.lapsedMutes.length) return;
  const names = v.lapsedMutes.map(
    (id) => v.results.find((r) => r.id === id)?.name ?? id
  );
  const box = root.createDiv({ cls: "flowkit-lapsed" });
  setIcon(box.createSpan({ cls: "flowkit-lapsed-icon" }), "bell-ring");
  box.createSpan({
    text: `Mute expired for ${names.join(", ")} — ${
      names.length === 1 ? "it is" : "they are"
    } back in the counts.`,
  });
  const ok = box.createEl("button", { text: "OK" });
  ok.onclick = () => {
    v.lapsedMutes = [];
    v.render();
  };
}

/**
 * A one-time orientation. Landing on a wall of numbers with no idea what they
 * are or what to do next is how a first run ends in an uninstall.
 */
export function renderIntro(v: HealthDashboardView, root: HTMLElement): void {
  if (v.plugin.settings.seenIntro) return;
  const intro = root.createDiv({ cls: "flowkit-intro" });
  intro.createEl("strong", { text: "Start with “What to fix”." });
  intro.createDiv({
    cls: "flowkit-intro-body",
    text:
      "The list below ranks what actually needs your attention — plugins that " +
      "can't load, ones pulled from the directory, ones with no recent release. " +
      "The table underneath is the evidence: select any row to see why it scored " +
      "what it did. Nothing here changes your vault until you say so.",
  });
  const done = intro.createEl("button", { text: "Got it" });
  done.onclick = () => {
    v.plugin.settings.seenIntro = true;
    v.act(v.plugin.saveSettings(), "Couldn't save that");
    intro.remove();
  };
}

/**
 * Say plainly when enrichment is incomplete, and why. Silently dropping two of
 * five columns and relabelling the header is the kind of thing users notice
 * and mistrust.
 */
export function renderCoverageNotice(v: HealthDashboardView, root: HTMLElement): void {
  const { stats, list, disabled, error } = v.coverage;

  // A refresh that failed while a cache exists still reports full coverage,
  // because the cached data really is complete — but the user pressed Refresh
  // and got the same numbers back, so say why.
  if (stats && list) {
    if (!error) return;
    const stale = root.createDiv({ cls: "flowkit-coverage-note" });
    setIcon(stale.createSpan({ cls: "flowkit-coverage-icon" }), "cloud-off");
    stale
      .createDiv({ cls: "flowkit-coverage-body" })
      .setText(`${error} Showing the last data FlowKit downloaded.`);
    const again = stale.createEl("button", { text: "Retry" });
    again.onclick = () => v.forceRetry();
    return;
  }

  const note = root.createDiv({ cls: "flowkit-coverage-note" });
  setIcon(note.createSpan({ cls: "flowkit-coverage-icon" }), disabled ? "wifi-off" : "cloud-off");
  const body = note.createDiv({ cls: "flowkit-coverage-body" });

  if (disabled) {
    body.createDiv({
      text: "Online enrichment is off — Popularity and Maintenance can't be measured.",
    });
    const btn = note.createEl("button", { text: "Turn on" });
    btn.onclick = () => {
      v.plugin.settings.enableOnlineEnrichment = true;
      v.act(
        v.plugin.saveSettings().then(() => v.refresh(true)),
        "Couldn't turn on online enrichment"
      );
    };
    return;
  }

  const missing = !stats && !list ? "Popularity, Maintenance and sideload detection" : !stats ? "Popularity and Maintenance" : "sideload detection and repository links";
  body.createDiv({ text: `${error ?? "Couldn't reach GitHub."} ${missing} unavailable for this scan.` });
  const btn = note.createEl("button", { text: "Retry" });
  btn.onclick = () => v.forceRetry();
}

/** A standing way back from the last bulk action, for the rest of the session. */
export function renderUndoBar(v: HealthDashboardView, root: HTMLElement): void {
  if (!v.lastBulk) return;
  const bar = root.createDiv({ cls: "flowkit-undo-bar" });
  setIcon(bar.createSpan({ cls: "flowkit-undo-icon" }), "rotate-ccw");
  bar.createSpan({ cls: "flowkit-undo-label", text: v.lastBulk.label });
  const btn = bar.createEl("button", { text: "Undo" });
  btn.onclick = () => void undoLastBulk(v);
}
