/** The plugin table: rows, score chips, the per-plugin reasoning panel and its row menu. */
import { Menu, setIcon } from "obsidian";
import type { MetricScore, PluginHealth } from "../types";
import { WEIGHTS } from "../scoring";
import { conflictsFor, describeConflict } from "../conflicts";
import { describeMute } from "../mutes";
import { currentLoadMs, formatBytes, formatPeriod, pollPenalty } from "../runtime";
import { describeEvent } from "../timeline";
import { findKnownIssues } from "../issueSearch";
import {
  type Tone,
  type MetricKey,
  type SortKey,
  METRIC_COLUMNS,
  MAINTENANCE_META,
  band,
  describeWhen,
} from "./format";
import { measureLoad, toggleWatch, toggleMute } from "./vaultActions";
import { copyBugReport, redactor } from "./exports";
import type { HealthDashboardView } from "../view";

/**
 * The errors traced to one plugin.
 *
 * Free sees the diagnosis — which errors, how many, how recently — because
 * that is the whole point of the feature and matches how the rest of the tier
 * split works. Pro gets the stack traces, which is what you need to file a
 * useful bug report or decide whether it's your setup or their code.
 */
export function renderErrorDetail(v: HealthDashboardView, panel: HTMLElement, r: PluginHealth): void {
  const rec = r.errors;
  if (!rec || !rec.signatures.length) return;

  const box = panel.createDiv({ cls: "flowkit-detail-errors" });
  const head = box.createDiv({ cls: "flowkit-detail-errors-head" });
  setIcon(head.createSpan({ cls: "flowkit-detail-errors-icon" }), "bug");
  head.createSpan({
    text: `${rec.uncaught} unhandled${rec.logged ? `, ${rec.logged} logged` : ""} — most recent first`,
  });

  const shown = [...rec.signatures].sort((a, b) => b.lastAt - a.lastAt).slice(0, 5);
  for (const sig of shown) {
    const item = box.createDiv({ cls: "flowkit-error-item" });
    const line = item.createDiv({ cls: "flowkit-error-line" });
    line.createSpan({
      cls: `flowkit-error-kind is-${sig.kind}`,
      text: sig.kind === "console" ? "logged" : sig.kind,
    });
    line.createSpan({ cls: "flowkit-error-message", text: sig.message });
    if (sig.count > 1) {
      line.createSpan({ cls: "flowkit-error-count", text: `×${sig.count}` });
    }

    // A user staring at an error message is one search away from the thread
    // where three other people described it and the author already answered —
    // and they almost never make that search, because copying a stack trace
    // into GitHub is friction at the exact moment they are already annoyed.
    if (r.repo) {
      const lookup = item.createDiv({ cls: "flowkit-error-lookup" });
      const ask = lookup.createEl("button", { text: "Is this a known issue?" });
      ask.onclick = () =>
        v.act(
          lookUpIssue(v, r, sig.message, lookup, ask),
          "Couldn't search that issue tracker"
        );
    }

    if (!sig.stack) continue;
    if (v.plugin.isPro) {
      const details = item.createEl("details", { cls: "flowkit-error-stack" });
      details.createEl("summary", { text: "Stack trace" });
      details.createEl("pre").createEl("code", { text: sig.stack });
    } else {
      const locked = item.createDiv({ cls: "flowkit-error-locked" });
      setIcon(locked.createSpan({ cls: "flowkit-lock-icon" }), "lock");
      const btn = locked.createEl("button", { text: "See the stack trace with Pro" });
      btn.onclick = () => v.openUpgrade("errors");
    }
  }
}

/**
 * Who else is claiming this plugin's shortcuts.
 *
 * Deliberately not scored. Neither plugin is at fault for a collision, and
 * docking one of them for it would be inventing a defect — but the user still
 * needs to know, because Obsidian's own UI never says which binding wins.
 */
export function renderConflictDetail(v: HealthDashboardView, panel: HTMLElement, r: PluginHealth): void {
  const mine = conflictsFor(v.conflicts, r.id);
  if (!mine.length) return;

  const box = panel.createDiv({ cls: "flowkit-detail-conflicts" });
  const head = box.createDiv({ cls: "flowkit-detail-errors-head" });
  setIcon(head.createSpan({ cls: "flowkit-detail-errors-icon" }), "keyboard");
  head.createSpan({
    text: `${mine.length} clash${mine.length === 1 ? "" : "es"} with other plugins`,
  });
  for (const conflict of mine.slice(0, 5)) {
    box.createDiv({
      cls: "flowkit-conflict-line",
      text: describeConflict(conflict, r.id),
    });
  }
  const fix = box.createEl("button", { text: "Open Obsidian's hotkey settings" });
  fix.onclick = () => v.plugin.openHotkeySettings();
}

/**
 * Search a plugin's own issue tracker for this error.
 *
 * On demand only, and never as part of a scan: GitHub's search API allows
 * roughly ten unauthenticated requests a minute, which is ample for a button
 * somebody presses and useless for anything automatic.
 */
export async function lookUpIssue(
  v: HealthDashboardView,
  r: PluginHealth,
  message: string,
  host: HTMLElement,
  trigger: HTMLButtonElement
): Promise<void> {
  trigger.disabled = true;
  trigger.setText("Looking…");
  // The button is already in its pending state, so anything that throws from
  // here on has to put it back or the row keeps a dead "Looking…" control for
  // the life of the view. Building the redactor is inside the try for exactly
  // that reason — it reads the whole vault and is the one step here that can
  // fail before any request is made.
  let result: Awaited<ReturnType<typeof findKnownIssues>>;
  try {
    result = await findKnownIssues(r.repo, message, redactor(v));
  } catch (err) {
    trigger.disabled = false;
    trigger.setText("Is this a known issue?");
    throw err;
  }
  trigger.remove();

  if (!result.ok) {
    host.createSpan({
      cls: "flowkit-error-lookup-note",
      text:
        result.reason === "rate-limited"
          ? "GitHub is rate-limiting searches right now — try again in a minute."
          : result.reason === "nothing-searchable"
            ? "Nothing in this message can be searched without sending your own file names, so FlowKit didn't send it."
            : "Couldn't search that repository.",
    });
    return;
  }
  if (!result.issues.length) {
    const none = host.createDiv({ cls: "flowkit-error-lookup-note" });
    none.appendText("Nothing matching in their tracker. ");
    const open = none.createEl("a", {
      text: "Open a new issue",
      href: `https://github.com/${r.repo}/issues/new`,
    });
    open.setAttr("target", "_blank");
    return;
  }

  const list = host.createDiv({ cls: "flowkit-error-issues" });
  for (const issue of result.issues.slice(0, 3)) {
    const line = list.createDiv({ cls: "flowkit-error-issue" });
    line.createSpan({
      cls: `flowkit-issue-state is-${issue.state}`,
      text: issue.state,
    });
    const link = line.createEl("a", { text: issue.title, href: issue.url });
    link.setAttr("target", "_blank");
    if (issue.comments) {
      line.createSpan({
        cls: "flowkit-issue-comments",
        text: ` · ${issue.comments} comment${issue.comments === 1 ? "" : "s"}`,
      });
    }
  }
}

export function renderTable(v: HealthDashboardView, root: HTMLElement, rows: PluginHealth[]): void {
  const wrap = root.createDiv({ cls: "flowkit-table-wrap" });
  const table = wrap.createEl("table", { cls: "flowkit-health-table" });
  table.createEl("caption", {
    cls: "flowkit-sr-only",
    text: "Installed plugins scored on compatibility, reliability, maintenance, footprint, manifest hygiene and popularity. Select a row to see why it scored what it did.",
  });
  const thead = table.createEl("thead").createEl("tr");
  sortableTh(v, thead, "Plugin", "name");
  sortableTh(
    v,
    thead,
    "Overall",
    "overall",
    true,
    "Weighted blend of the six metrics, renormalised over what was available."
  );
  for (const col of METRIC_COLUMNS) {
    sortableTh(v, thead, col.label, col.key, true, col.hint);
  }
  thead.createEl("th", { text: "", cls: "num" });

  const tbody = table.createEl("tbody");
  for (const r of rows) {
    renderRow(v, tbody, r);
    if (v.expandedId === r.id) renderDetail(v, tbody, r);
  }
}

/**
 * The reasoning behind one plugin's score, inline under its row. Before this
 * the numbers were terminal: a user could see 43 and had nowhere to go to
 * find out why, or what to do about it.
 */
export function renderDetail(v: HealthDashboardView, tbody: HTMLElement, r: PluginHealth, after?: HTMLElement): void {
  const tr = tbody.createEl("tr", { cls: "flowkit-detail-row" });
  // Inserted directly beneath its own row when opened in place; appended when
  // the table is being built in order.
  if (after?.nextSibling) tbody.insertBefore(tr, after.nextSibling);
  else if (after) tbody.appendChild(tr);
  const td = tr.createEl("td");
  td.setAttr("colspan", String(METRIC_COLUMNS.length + 3));
  const panel = td.createDiv({ cls: "flowkit-detail" });

  const head = panel.createDiv({ cls: "flowkit-detail-head" });
  head.createDiv({
    cls: "flowkit-detail-title",
    text: `Why ${r.name} scores ${r.overall ?? "—"}`,
  });
  head.createDiv({
    cls: "flowkit-detail-sub",
    text: `${Math.round(r.confidence * 100)}% confidence · ${
      r.metrics.compatibility.value === 0
        ? "capped because it can't load here"
        : r.listing === "delisted"
          ? "capped because it was removed from the directory"
          : "weighted blend of the metrics below"
    }`,
  });

  const list = panel.createDiv({ cls: "flowkit-detail-metrics" });
  for (const col of METRIC_COLUMNS) {
    const m = r.metrics[col.key];
    const row = list.createDiv({ cls: "flowkit-detail-metric" });
    row.createSpan({ cls: "flowkit-detail-metric-name", text: col.label });
    row.createSpan({
      cls: "flowkit-detail-metric-weight",
      text: `${Math.round(WEIGHTS[col.key] * 100)}%`,
    });
    row.createSpan({
      cls: `flowkit-detail-metric-value tone-${band(m.value)}`,
      text: m.value == null ? "—" : String(m.value),
    });
    row.createSpan({ cls: "flowkit-detail-metric-detail", text: m.detail });
  }

  renderConflictDetail(v, panel, r);
  renderErrorDetail(v, panel, r);

  const facts = panel.createDiv({ cls: "flowkit-detail-facts" });
  facts.createDiv({
    text: `Installed v${r.version}${
      r.latestVersion && r.latestVersion !== r.version
        ? ` · latest published v${r.latestVersion}`
        : ""
    } · by ${r.author}`,
  });
  if (r.compatibilityForecast) {
    const forecast = r.compatibilityForecast;
    facts.createDiv({
      cls: `flowkit-detail-forecast tone-${forecast.status === "safe" ? "good" : forecast.status === "unknown" ? "unknown" : "warn"}`,
      text: `Next-release forecast (${forecast.targetVersion}): ${forecast.detail}`,
    });
  }

  // What it costs and what it does, side by side — the two halves of the
  // question "should I turn this off".
  const runtime = r.runtime;
  const runtimeParts: string[] = [];
  if (r.bundleBytes) runtimeParts.push(`${formatBytes(r.bundleBytes)} on disk`);
  const loadMs = currentLoadMs(runtime, r.version);
  if (loadMs != null) {
    runtimeParts.push(`loaded in ${Math.round(loadMs)} ms`);
  }
  if (runtime?.minIntervalMs != null) {
    const period = formatPeriod(runtime.minIntervalMs);
    runtimeParts.push(
      pollPenalty(runtime.minIntervalMs) > 0
        ? `repeating timer every ${period}`
        : `slowest-cost timer every ${period}`
    );
  }
  if (runtime?.commands) {
    runtimeParts.push(`${runtime.commands} command${runtime.commands === 1 ? "" : "s"}`);
  }
  if (runtime?.handlers) {
    runtimeParts.push(`${runtime.handlers} registered hooks`);
  }
  if (runtimeParts.length) facts.createDiv({ text: runtimeParts.join(" · ") });
  // Keyed on whether there is a load time for THIS build, not on whether one
  // was ever recorded. A plugin that updated since it was timed has a reading
  // that Footprint correctly ignores — and the panel used to then show
  // neither the time nor this hint, so the row simply went quiet about the
  // one number the user came here for.
  if (r.enabled && v.plugin.runtimeTracking && loadMs == null) {
    facts.createDiv({
      cls: "flowkit-detail-muted",
      text:
        runtime?.loadMs != null
          ? `Load time was measured for v${runtime.loadVersion}, not the version you have installed. Use “Measure load time” for a current number.`
          : "Load time not measured — FlowKit only times loads it witnesses. Use “Measure load time” to get a real number.",
    });
  }

  const repo = r.repoActivity;
  if (repo) {
    const bits: string[] = [];
    if (repo.archived) bits.push("repository archived by its author");
    else if (repo.failed === "missing") bits.push("repository no longer exists");
    else if (repo.pushedAt) bits.push(`last push ${describeWhen(repo.pushedAt)}`);
    if (repo.openIssues != null) {
      bits.push(`${repo.openIssues} open issue${repo.openIssues === 1 ? "" : "s"}`);
    }
    if (bits.length) facts.createDiv({ text: `GitHub: ${bits.join(" · ")}` });
  }

  if (r.muted && r.mute) {
    facts.createDiv({
      cls: "flowkit-detail-muted",
      text: `Muted ${describeMute(r.mute, Date.now())}`,
    });
  }

  // Its own history. When something broke, "what changed" is the first
  // question, and it used to be unanswerable from inside the product.
  const history = v.plugin.eventsFor(r.id);
  if (history.length) {
    const box = panel.createDiv({ cls: "flowkit-detail-history" });
    box.createDiv({ cls: "flowkit-detail-history-head", text: "Recent changes" });
    for (const event of history.slice(0, 4)) {
      box.createDiv({
        cls: "flowkit-history-line",
        text: `${describeWhen(event.at)} — ${describeEvent(event)}`,
      });
    }
  }

  const actions = panel.createDiv({ cls: "flowkit-detail-actions" });
  if (!v.isSelf(r)) {
    const toggle = actions.createEl("button", {
      text: r.enabled ? "Disable" : "Enable",
    });
    toggle.onclick = () => {
      v.act(
        v.plugin.setPluginEnabled(r.id, !r.enabled).then(() => v.refresh(false, false)),
        `Couldn't ${r.enabled ? "disable" : "enable"} ${r.name}`
      );
    };
  }
  if (r.enabled) {
    const settings = actions.createEl("button", { text: "Open its settings" });
    settings.onclick = () => v.plugin.openPluginSettings(r.id);
  }
  if (r.repo) {
    const gh = actions.createEl("button", { text: "Open on GitHub" });
    gh.onclick = () => window.open(`https://github.com/${r.repo}`, "_blank");
  }
  if (r.errors?.signatures.length) {
    const report = actions.createEl("button", { cls: "mod-cta", text: "Copy bug report" });
    // Through `act`, not a bare `void`. Assembling the report builds a
    // redactor over every name in the vault, and when that threw the button
    // did nothing at all — no clipboard, no message, no console line, because
    // the rejection escaped into the one listener that is told to ignore
    // FlowKit's own frames. Silence is the worst available failure here.
    report.onclick = () => v.act(copyBugReport(v, r), "Couldn't build the bug report");
  }
  const watch = actions.createEl("button", {
    text: r.watched ? "Stop watching" : "Watch this",
  });
  watch.onclick = () => {
    v.act(toggleWatch(v, r), `Couldn't change whether ${r.name} is watched`);
  };
  const mute = actions.createEl("button", {
    text: r.muted ? "Unmute" : "Mute from counts…",
  });
  mute.onclick = () => {
    v.act(toggleMute(v, r), `Couldn't change the mute on ${r.name}`);
  };
}

export function sortableTh(
  v: HealthDashboardView,
  tr: HTMLElement,
  label: string,
  key: SortKey,
  num = false,
  hint?: string
): void {
  const th = tr.createEl("th", { cls: num ? "num sortable" : "sortable" });
  th.setAttr("scope", "col");
  // The header sorts, so it must be a control — it was a bare <th> with an
  // onclick, reachable only by mouse.
  th.setAttr(
    "aria-sort",
    v.sortKey === key ? (v.sortDir === 1 ? "ascending" : "descending") : "none"
  );
  const btn = th.createEl("button", { cls: "flowkit-sort-btn", text: label });
  if (hint) {
    btn.setAttr("title", hint);
    btn.setAttr("aria-label", `${label} — ${hint}. Sort by this.`);
  }
  btn.onclick = () => v.toggleSort(key);
  if (v.sortKey === key) {
    // Inside the button, so the arrow isn't announced as separate content.
    btn.createSpan({
      cls: "flowkit-sort-arrow",
      text: v.sortDir === -1 ? " ▼" : " ▲",
    });
  }
}

export function renderRow(v: HealthDashboardView, tbody: HTMLElement, r: PluginHealth): void {
  const tr = tbody.createEl("tr");
  if (!r.enabled) tr.addClass("is-disabled");
  if (r.muted) tr.addClass("is-muted");

  const expanded = v.expandedId === r.id;
  if (expanded) tr.addClass("is-expanded");
  tr.dataset.pluginId = r.id;
  // Opening one row's reasoning used to rebuild every row in the table, which
  // is both the most common interaction here and the most wasteful thing the
  // view did — and it visibly flickered on a large vault. Nothing about the
  // other rows changes, so touch only this one and its panel.
  const toggle = () => toggleDetail(v, r, tr);
  // A convenience target for the mouse only. The row is NOT given
  // role="button": a button containing its own buttons and a ⋮ menu is a
  // nested-interactive trap, and screen readers would announce the whole row
  // as one control. The real control is the plugin name below.
  tr.onclick = (evt) => {
    if ((evt.target as HTMLElement).closest("button")) return;
    toggle();
  };

  const nameCell = tr.createEl("td", { cls: "flowkit-name" });
  const nameRow = nameCell.createDiv({ cls: "flowkit-name-row" });
  const nameBtn = nameRow.createEl("button", {
    cls: "flowkit-plugin-name",
    text: r.name,
  });
  nameBtn.setAttr("aria-expanded", String(expanded));
  nameBtn.setAttr(
    "aria-label",
    `${r.name}${r.enabled ? "" : ", disabled"}${r.muted ? ", muted" : ""} — scores ${
      r.overall ?? "unknown"
    }. Show the reasoning.`
  );
  nameBtn.onclick = toggle;

  // Good state is silent. Every healthy row used to carry a "Maintained"
  // badge, so the badge system marked the normal case and nothing stood out.
  // "Muted" is gone too — the row is already dimmed for it.
  if (r.watched) {
    const star = nameRow.createSpan({ cls: "flowkit-watch-star" });
    setIcon(star, "star");
    star.setAttr("aria-label", "You're watching this plugin");
    star.setAttr("title", "You're watching this plugin");
  }

  const status = MAINTENANCE_META[r.maintenanceStatus];
  if (r.maintenanceStatus === "unmaintained") {
    badge(v, nameRow, status.label, status.tone, status.hint);
  }
  // The one repository fact worth a badge: an archived repo is the author
  // saying, on the record, that nothing more is coming.
  if (r.repoActivity?.archived) {
    badge(
      v,
      nameRow,
      "Archived",
      "bad",
      "Its author has archived the repository — no further fixes are planned."
    );
  }
  // Conflicts belong on the row, not only in the panel: a shortcut that
  // silently doesn't fire is exactly the kind of thing nobody goes looking
  // for, because they've assumed it's their own mistake.
  const clashes = v.clashCounts.get(r.id) ?? 0;
  if (clashes > 0 && r.enabled) {
    badge(
      v,
      nameRow,
      clashes === 1 ? "Clash" : `${clashes} clashes`,
      "warn",
      "Shares a shortcut or command name with another plugin — only one of them answers."
    );
  }
  if (r.updateAvailable) {
    badge(
      v,
      nameRow,
      "Update",
      "warn",
      `Newer version available${r.latestVersion ? ` (v${r.latestVersion})` : ""}.`
    );
  }
  const errs = r.errors?.uncaught ?? 0;
  if (errs > 0) {
    badge(
      v,
      nameRow,
      `${errs} error${errs === 1 ? "" : "s"}`,
      "bad",
      "Unhandled errors traced to this plugin while FlowKit has been watching."
    );
  }
  if (r.listing === "delisted") {
    badge(
      v,
      nameRow,
      "Delisted",
      "bad",
      "Was in Obsidian's community directory and has since been removed."
    );
  } else if (r.listing === "local") {
    // Neutral: installing outside the directory is a choice, not a fault.
    badge(
      v,
      nameRow,
      "Local install",
      "unknown",
      "Not in Obsidian's community list — installed manually or via BRAT, so it skipped community review."
    );
  }
  const meta = nameCell.createDiv({ cls: "flowkit-plugin-meta" });
  // Disabled is already carried by the row's own dimming; saying it again in
  // text encoded one state twice. Muted likewise.
  meta.setText(`${r.author} · v${r.version}`);

  // Overall is a blend, so it isn't "measured" — but marking it `estimated`
  // put the ~ honesty mark on 100% of rows, which made it mean nothing. Every
  // metric it blends is now measured; what varies is coverage, and that is
  // already reported as confidence.
  scoreCell(
    v,
    tr,
    r.overall,
    "measured",
    `Weighted blend of the six metrics in this row · ${Math.round(r.confidence * 100)}% of signals available.`,
    "Overall"
  );
  for (const col of METRIC_COLUMNS) {
    const metric = r.metrics[col.key];
    scoreCell(v, tr, metric.value, metric.source, metric.detail, col.label, col.key);
  }

  const actionCell = tr.createEl("td", { cls: "num flowkit-actions" });
  const menuBtn = actionCell.createEl("button", { cls: "flowkit-menu-btn" });
  setIcon(menuBtn, "more-vertical");
  menuBtn.setAttr("aria-label", "Plugin actions");
  menuBtn.onclick = (evt) => openRowMenu(v, evt, r);
}

/**
 * Open or close one row's reasoning, in place.
 *
 * Invariants the full rebuild used to give for free, now kept by hand:
 * exactly one panel is open, the row's `aria-expanded` matches, and the panel
 * is removed if the row it belongs to leaves the table. `renderRows` still
 * recreates the open panel from `expandedId`, so a filter, sort or rescan
 * lands in the same state this leaves behind.
 */
export function toggleDetail(v: HealthDashboardView, r: PluginHealth, tr: HTMLElement): void {
  const host = v.rowsEl;
  const wasOpen = v.expandedId === r.id;
  // Close whatever is open, wherever it is.
  if (host) {
    for (const open of Array.from(host.querySelectorAll<HTMLElement>(".flowkit-detail-row"))) {
      open.remove();
    }
    for (const row of Array.from(host.querySelectorAll<HTMLElement>("tr.is-expanded"))) {
      row.removeClass("is-expanded");
      row
        .querySelector<HTMLElement>("button.flowkit-plugin-name")
        ?.setAttr("aria-expanded", "false");
    }
  }
  if (wasOpen) {
    v.expandedId = null;
    return;
  }
  v.expandedId = r.id;
  tr.addClass("is-expanded");
  tr.querySelector<HTMLElement>("button.flowkit-plugin-name")?.setAttr(
    "aria-expanded",
    "true"
  );
  const parent = tr.parentElement;
  if (!parent) return;
  renderDetail(v, parent, r, tr);
}

export function badge(v: HealthDashboardView, parent: HTMLElement, label: string, tone: Tone, hint: string): void {
  const el = parent.createSpan({
    cls: `flowkit-status-badge tone-${tone}`,
    text: label,
  });
  el.setAttr("title", hint);
  el.setAttr("aria-label", hint);
}

export function openRowMenu(v: HealthDashboardView, evt: MouseEvent, r: PluginHealth): void {
  const menu = new Menu();

  if (!v.isSelf(r)) {
    menu.addItem((item) =>
      item
        .setTitle(r.enabled ? "Disable plugin" : "Enable plugin")
        .setIcon(r.enabled ? "power-off" : "power")
        // Not an `async` menu callback: Obsidian's menu does not promise to
        // handle a rejected one, so a plugin that refuses to switch produced
        // nothing — no change, no message, no console line.
        .onClick(() =>
          v.act(
            v.plugin
              .setPluginEnabled(r.id, !r.enabled)
              .then(() => v.refresh(false, false)),
            `Couldn't ${r.enabled ? "disable" : "enable"} ${r.name}`
          )
        )
    );
  }

  if (r.enabled) {
    menu.addItem((item) =>
      item
        .setTitle("Open plugin settings")
        .setIcon("settings")
        .onClick(() => v.plugin.openPluginSettings(r.id))
    );
  }

  if (r.repo) {
    menu.addItem((item) =>
      item
        .setTitle("Open on GitHub")
        .setIcon("github")
        .onClick(() => window.open(`https://github.com/${r.repo}`, "_blank"))
    );
  }

  if (r.errors?.signatures.length) {
    menu.addItem((item) =>
      item
        .setTitle("Copy bug report")
        .setIcon("clipboard-list")
        .onClick(() => v.act(copyBugReport(v, r), "Couldn't build the bug report"))
    );
  }

  // Never on FlowKit's own row: measuring restarts the plugin, and
  // restarting FlowKit from FlowKit loads a second instance of it.
  if (r.enabled && v.plugin.runtimeTracking && !v.isSelf(r)) {
    menu.addItem((item) =>
      item
        .setTitle("Measure load time")
        .setIcon("timer")
        .onClick(() => void measureLoad(v, r))
    );
  }

  menu.addSeparator();
  menu.addItem((item) =>
    item
      .setTitle(r.watched ? "Stop watching" : "Watch this plugin")
      .setIcon(r.watched ? "star-off" : "star")
      .onClick(() =>
        v.act(toggleWatch(v, r), `Couldn't change whether ${r.name} is watched`)
      )
  );
  menu.addItem((item) =>
    item
      .setTitle(r.muted ? "Unmute plugin" : "Mute from counts…")
      .setIcon(r.muted ? "bell" : "bell-off")
      .onClick(() => v.act(toggleMute(v, r), `Couldn't change the mute on ${r.name}`))
  );

  menu.showAtMouseEvent(evt);
}

export function scoreCell(
  v: HealthDashboardView,
  tr: HTMLElement,
  value: number | null,
  source: MetricScore["source"],
  detail?: string,
  columnLabel?: string,
  metricKey?: MetricKey
): void {
  const td = tr.createEl("td", { cls: "num" });
  // Read by the narrow-width card layout, where the header row is hidden.
  if (columnLabel) td.setAttr("data-label", columnLabel);
  // Popularity is explicitly "context, not health" — in its own tooltip and
  // in the legend — yet it was painted on the same red/amber/green scale as
  // compatibility, so a good niche plugin showed a red chip for being niche.
  const tone: Tone = metricKey === "popularity" ? "unknown" : band(value);
  const chip = td.createSpan({
    cls: `flowkit-chip tone-${tone} src-${source}` +
      // Healthy supporting metrics recede; only exceptions hold colour, so
      // a row with one problem shows one coloured chip instead of seven.
      (tone === "good" && metricKey && metricKey !== "compatibility" ? " is-quiet" : ""),
  });
  chip.setText(value == null ? "—" : String(value));
  if (source === "estimated") chip.createSpan({ cls: "flowkit-est", text: "~" });
  // Colour alone carried the good/warn/bad reading, which is invisible to
  // anyone colour-blind and to a screen reader. Name the band in the label.
  const bandWord =
    metricKey === "popularity"
      ? "informational"
      : tone === "good"
        ? "good"
        : tone === "warn"
          ? "needs a look"
          : tone === "bad"
            ? "poor"
            : "no data";
  const label = detail ? `${bandWord} — ${detail}` : bandWord;
  chip.setAttr("aria-label", label);
  if (detail) chip.setAttr("title", detail);
}
