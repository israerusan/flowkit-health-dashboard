/** What leaves the vault: the Markdown and CSV reports, the copied summary and bug reports. */
import { Menu, Notice, Platform, TFile, apiVersion } from "obsidian";
import type { PluginHealth } from "../types";
import { buildRedactor } from "../issueSearch";
import { PRODUCT_NAME } from "../product";
import { FILTERS, describeWatched, describeWhen } from "./format";
import { buildReportCsv, buildReportMarkdown, type ReportInput } from "./report";
import type { HealthDashboardView } from "../view";

/**
 * A redactor that knows this vault's own file and folder names.
 *
 * Built per action rather than cached: it is used by two buttons a user
 * presses occasionally, and a cached copy would go stale the moment somebody
 * renamed the note the error is about — which is exactly the note whose name
 * must not be published.
 */
export function redactor(v: HealthDashboardView): (text: string) => string {
  const names = new Set<string>();
  for (const file of v.app.vault.getAllLoadedFiles()) {
    if (file.name) names.add(file.name);
    if (file.path) names.add(file.path);
    const basename = (file as { basename?: string }).basename;
    if (basename) names.add(basename);
  }
  return buildRedactor(names);
}

/**
 * A paste-ready bug report for one plugin.
 *
 * The user was going to file that issue anyway, badly, from memory. Every
 * field here is something FlowKit already holds, and the report carries a
 * footer to exactly the audience worth reaching — plugin authors and the
 * power users reading their issue trackers.
 */
export async function copyBugReport(v: HealthDashboardView, r: PluginHealth): Promise<void> {
  const redact = redactor(v);
  const lines: string[] = [];
  lines.push(`**${r.name}** v${r.version}`);
  if (r.latestVersion && r.latestVersion !== r.version) {
    lines.push(`Latest published: v${r.latestVersion}`);
  }
  lines.push(`Obsidian ${apiVersion} · ${Platform.isMobile ? "mobile" : "desktop"}`);
  lines.push("");

  const rec = r.errors;
  if (rec?.signatures.length) {
    const watched = Math.max(1, Math.round(v.plugin.observedMs() / 86_400_000));
    lines.push(
      `${rec.uncaught} unhandled error${rec.uncaught === 1 ? "" : "s"} recorded over ${watched} day${watched === 1 ? "" : "s"}:`
    );
    lines.push("");
    for (const sig of [...rec.signatures].sort((a, b) => b.lastAt - a.lastAt).slice(0, 5)) {
      // Redacted, because this is the text the product tells the user to
      // paste into a stranger's issue tracker. Error messages quote the file
      // being touched, and in a note-taking app the file name IS the content
      // — "Patients/Alice Nguyen HIV results.md" is not incidental detail.
      lines.push(
        `- \`${redact(sig.message)}\` — seen ${sig.count}×, last ${describeWhen(sig.lastAt)}`
      );
      // The stack is the Pro line: it is the part an author can act on. It is
      // also, by construction, a list of absolute paths carrying the OS
      // username and the vault name on every frame.
      if (v.plugin.isPro && sig.stack) {
        lines.push("");
        lines.push("```");
        lines.push(redact(sig.stack));
        lines.push("```");
      }
    }
    if (!v.plugin.isPro) {
      lines.push("");
      lines.push("_Stack traces available with FlowKit Pro._");
    }
  } else {
    lines.push(`Overall health ${r.overall ?? "—"}. No errors recorded.`);
  }

  lines.push("");
  lines.push(`— collected by ${PRODUCT_NAME} for Obsidian`);

  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    // Says what was included, because the user is about to publish it, and
    // "paste it into an issue" was the whole of the previous disclosure.
    //
    // And says what is NOT covered, because "file names and paths are
    // redacted" was an absolute claim the redactor does not make: a name
    // under four characters is only matched inside quotes, deliberately, so
    // that a folder called "lib" cannot blank every module path in the
    // report. That is a defensible trade-off and an indefensible thing to
    // leave unsaid one keystroke before the text is posted in public.
    new Notice(
      "Bug report copied. Your file and folder names are redacted — except a very short " +
        "name used as an ordinary word, which FlowKit can't tell apart from one. Read it " +
        "before you post it.",
      10_000
    );
  } catch (err) {
    console.error("FlowKit: clipboard write failed", err);
    new Notice("Couldn't copy to the clipboard — see the console.");
  }
}

/** A short vault summary that fits in a chat message. */
export async function copySummary(v: HealthDashboardView): Promise<void> {
  const s = v.summaryStats();
  const grade = v.gradeNow(s);
  const insights = v.insights();
  const lines = [
    `${PRODUCT_NAME}: vault health ${s.avg ?? "—"}/100${
      v.canGrade(s) ? ` (Grade ${grade.letter})` : " (not enough signal to grade)"
    } across ${s.count} plugins.`,
  ];
  for (const ins of insights.slice(0, 3)) lines.push(`• ${ins.title}`);
  const watching = v.plugin.observedMs();
  if (watching > 0) {
    lines.push(`Watching for plugin errors for ${describeWatched(watching)}.`);
  }
  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    new Notice("Summary copied.");
  } catch (err) {
    console.error("FlowKit: clipboard write failed", err);
    new Notice("Couldn't copy to the clipboard — see the console.");
  }
}

export function onExportClick(v: HealthDashboardView, evt: MouseEvent): void {
  const menu = new Menu();
  // Copy is always free and unlimited. Never ration the thing that carries
  // your name outward.
  menu.addItem((item) =>
    item
      .setTitle("Copy summary")
      .setIcon("clipboard-copy")
      .onClick(() => void copySummary(v))
  );
  menu.addSeparator();
  menu.addItem((item) =>
    item
      .setTitle("Export Markdown report")
      .setIcon("file-text")
      .onClick(() => void exportReport(v, "md"))
  );
  menu.addItem((item) =>
    item
      .setTitle(v.plugin.isPro ? "Export CSV" : "Export CSV (Pro)")
      .setIcon("table")
      .onClick(() => {
        if (!v.plugin.isPro) {
          v.openUpgrade("export");
          return;
        }
        void exportReport(v, "csv");
      })
  );
  menu.showAtMouseEvent(evt);
}

export async function exportReport(v: HealthDashboardView, format: "md" | "csv"): Promise<void> {
  const rows = v.visibleRows();
  const content =
    format === "md" ? buildReportMarkdown(reportInput(v, rows)) : buildReportCsv(rows);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  let created: TFile | null = null;
  let createdPath = "";
  try {
    const path = await uniquePath(v, `Plugin Health Report ${stamp}`, format);
    createdPath = path;
    // A leading BOM keeps Excel from mangling non-ASCII plugin names in the
    // CSV. Built with fromCharCode rather than written literally, so the
    // source stays free of invisible whitespace.
    created = await v.app.vault.create(
      path,
      format === "csv" ? String.fromCharCode(0xfeff) + content : content
    );
    new Notice(`Exported health report to “${path}”.`);
  } catch (err) {
    console.error("FlowKit: export failed", err);
    new Notice("Could not create the report file — see the console.");
    return;
  }

  // Opening the note is a separate concern: the file is already written, so a
  // failure here must not be reported as "could not create the report".
  if (format === "md" && created) {
    try {
      await v.app.workspace.getLeaf(true).openFile(created);
    } catch (err) {
      console.error("FlowKit: could not open the report", err);
      new Notice(`Report saved to “${createdPath}”, but it couldn't be opened.`);
    }
  }
  // No re-render. It existed only to repaint the Export button's padlock,
  // and a full render throws the reader back to the top of the page — after
  // an action that changed nothing on screen.
}

/**
 * A path that doesn't already exist. The stamp is second-resolution, so two
 * exports inside the same second used to collide and throw.
 */
export async function uniquePath(v: HealthDashboardView, base: string, format: string): Promise<string> {
  let path = `${base}.${format}`;
  let n = 2;
  while (await v.app.vault.adapter.exists(path)) {
    path = `${base} (${n++}).${format}`;
  }
  return path;
}

/** What the table is scoped to (a finding, or a filter), or "" for everything. */
export function scopeLabel(v: HealthDashboardView): string {
  if (v.scopeInsight) return v.scopeInsight.title;
  if (v.filter !== "all") return FILTERS.find((f) => f.key === v.filter)?.label ?? v.filter;
  return "";
}

/** The report's inputs, read off the view at export time. */
function reportInput(v: HealthDashboardView, rows: PluginHealth[]): ReportInput {
  const stats = v.summaryStats();
  return {
    rows,
    stats,
    graded: v.canGrade(stats),
    grade: v.gradeNow(stats),
    online: v.coverage.stats,
    scope: scopeLabel(v),
    search: v.search,
    insights: v.insights(),
    isPro: v.plugin.isPro,
    generatedAt: new Date(),
  };
}
