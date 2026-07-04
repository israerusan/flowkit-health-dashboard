import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type { MaintenanceStatus, MetricScore, PluginHealth } from "./types";
import type FlowKitHealthPlugin from "./main";

export const VIEW_TYPE_HEALTH = "flowkit-health-dashboard";

type MetricKey = keyof PluginHealth["metrics"];
type SortKey = "name" | "overall" | MetricKey;
type FilterKey =
  | "all"
  | "attention"
  | "unmaintained"
  | "incompatible"
  | "update"
  | "disabled"
  | "muted";

const METRIC_COLUMNS: Array<{ key: MetricKey; label: string }> = [
  { key: "quality", label: "Quality" },
  { key: "maintenance", label: "Maintenance" },
  { key: "performance", label: "Performance" },
  { key: "popularity", label: "Popularity" },
  { key: "compatibility", label: "Compatibility" },
];

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "All plugins" },
  { key: "attention", label: "Needs attention" },
  { key: "unmaintained", label: "Unmaintained" },
  { key: "incompatible", label: "Incompatible" },
  { key: "update", label: "Update available" },
  { key: "disabled", label: "Disabled" },
  { key: "muted", label: "Muted" },
];

const MAINTENANCE_META: Record<
  MaintenanceStatus,
  { label: string; tone: "good" | "warn" | "bad" | "unknown"; hint: string }
> = {
  maintained: {
    label: "Maintained",
    tone: "good",
    hint: "Updated within the last 6 months.",
  },
  aging: { label: "Aging", tone: "warn", hint: "No update in 6–18 months." },
  unmaintained: {
    label: "Unmaintained",
    tone: "bad",
    hint: "No update in over 18 months — likely abandoned.",
  },
  unknown: {
    label: "Unknown",
    tone: "unknown",
    hint: "No update data (offline, or not a community plugin).",
  },
};

/** Map a 0–100 score to a qualitative band used for colour coding. */
function band(value: number | null): "good" | "warn" | "bad" | "unknown" {
  if (value == null) return "unknown";
  if (value >= 80) return "good";
  if (value >= 50) return "warn";
  return "bad";
}

function isIncompatible(r: PluginHealth): boolean {
  return r.metrics.compatibility.value === 0;
}

/** A plugin worth the user's attention (excluding ones they've muted). */
function needsAttention(r: PluginHealth): boolean {
  if (r.muted) return false;
  return (
    (r.overall != null && r.overall < 50) ||
    r.maintenanceStatus === "unmaintained" ||
    isIncompatible(r) ||
    r.updateAvailable
  );
}

export class HealthDashboardView extends ItemView {
  private plugin: FlowKitHealthPlugin;
  private results: PluginHealth[] = [];
  private online = false;
  private loading = false;

  // View controls
  private search = "";
  private filter: FilterKey = "all";
  private sortKey: SortKey = "overall";
  private sortDir: 1 | -1 = -1;

  constructor(leaf: WorkspaceLeaf, plugin: FlowKitHealthPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_HEALTH;
  }

  getDisplayText(): string {
    return "Plugin Health";
  }

  getIcon(): string {
    return "activity";
  }

  async onOpen(): Promise<void> {
    await this.refresh(false);
  }

  /** Recompute all scores and re-render. Pass `force` to re-download data. */
  async refresh(force = false): Promise<void> {
    this.loading = true;
    this.render();
    const { results, online } = await this.plugin.computeAll(force);
    this.results = results;
    this.online = online;
    this.loading = false;
    this.render();
  }

  // --- data shaping ---------------------------------------------------------

  private visibleRows(): PluginHealth[] {
    const q = this.search.trim().toLowerCase();
    const filtered = this.results.filter((r) => {
      if (q) {
        const hay = `${r.name} ${r.author} ${r.id}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      switch (this.filter) {
        case "attention":
          return needsAttention(r);
        case "unmaintained":
          return r.maintenanceStatus === "unmaintained";
        case "incompatible":
          return isIncompatible(r);
        case "update":
          return r.updateAvailable;
        case "disabled":
          return !r.enabled;
        case "muted":
          return r.muted;
        default:
          return true;
      }
    });

    const dir = this.sortDir;
    return filtered.sort((a, b) => {
      if (this.sortKey === "name") return dir * a.name.localeCompare(b.name);
      const av = this.sortValue(a);
      const bv = this.sortValue(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // nulls always last
      if (bv == null) return -1;
      return dir * (av - bv);
    });
  }

  private sortValue(r: PluginHealth): number | null {
    if (this.sortKey === "overall") return r.overall;
    if (this.sortKey === "name") return null;
    return r.metrics[this.sortKey].value;
  }

  private toggleSort(key: SortKey): void {
    if (this.sortKey === key) {
      this.sortDir = (this.sortDir * -1) as 1 | -1;
    } else {
      this.sortKey = key;
      this.sortDir = key === "name" ? 1 : -1;
    }
    this.render();
  }

  // --- rendering ------------------------------------------------------------

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("flowkit-health");

    this.renderHeader(root);

    if (this.loading) {
      root.createDiv({
        cls: "flowkit-health-empty",
        text: "Gathering plugin data…",
      });
      return;
    }

    if (this.results.length === 0) {
      root.createDiv({
        cls: "flowkit-health-empty",
        text: "No installed community plugins found.",
      });
      return;
    }

    this.renderSummary(root);
    this.renderToolbar(root);

    const rows = this.visibleRows();
    if (rows.length === 0) {
      root.createDiv({
        cls: "flowkit-health-empty",
        text: "No plugins match the current filter.",
      });
    } else {
      this.renderTable(root, rows);
    }
    this.renderLegend(root);
  }

  private renderHeader(root: HTMLElement): void {
    const header = root.createDiv({ cls: "flowkit-health-header" });
    header.createEl("h2", { text: "Plugin Health Dashboard" });

    const actions = header.createDiv({ cls: "flowkit-health-actions" });
    const status = actions.createSpan({ cls: "flowkit-health-status" });
    status.setText(
      this.loading
        ? "Scoring…"
        : this.online
          ? "Online — full metrics"
          : "Offline — local metrics only"
    );
    status.addClass(this.online ? "is-online" : "is-offline");

    if (!this.loading && this.results.length > 0) {
      const exportBtn = actions.createEl("button", {
        cls: "flowkit-health-btn",
      });
      setIcon(exportBtn.createSpan(), "download");
      exportBtn.createSpan({ text: " Export" });
      exportBtn.onclick = () => void this.exportReport();
    }

    const refreshBtn = actions.createEl("button", { cls: "flowkit-health-btn" });
    setIcon(refreshBtn.createSpan(), "refresh-cw");
    refreshBtn.createSpan({ text: " Refresh" });
    refreshBtn.disabled = this.loading;
    refreshBtn.onclick = () => void this.refresh(true);
  }

  private renderSummary(root: HTMLElement): void {
    const active = this.results.filter((r) => !r.muted);
    const scored = active
      .map((r) => r.overall)
      .filter((v): v is number => v != null);
    const avg = scored.length
      ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length)
      : null;
    const atRisk = active.filter((r) => r.overall != null && r.overall < 50).length;
    const unmaintained = active.filter(
      (r) => r.maintenanceStatus === "unmaintained"
    ).length;
    const updates = active.filter((r) => r.updateAvailable).length;

    const summary = root.createDiv({ cls: "flowkit-health-summary" });
    this.statTile(summary, "Plugins", String(this.results.length));
    this.statTile(summary, "Vault health", avg == null ? "—" : String(avg), band(avg));
    this.statTile(summary, "Updates", String(updates), updates > 0 ? "warn" : "good");
    this.statTile(
      summary,
      "Unmaintained",
      String(unmaintained),
      unmaintained > 0 ? "bad" : "good"
    );
    this.statTile(summary, "At risk", String(atRisk), atRisk > 0 ? "bad" : "good");
  }

  private statTile(
    parent: HTMLElement,
    label: string,
    value: string,
    tone: "good" | "warn" | "bad" | "unknown" = "unknown"
  ): void {
    const tile = parent.createDiv({ cls: "flowkit-stat" });
    tile.createDiv({ cls: `flowkit-stat-value tone-${tone}`, text: value });
    tile.createDiv({ cls: "flowkit-stat-label", text: label });
  }

  private renderToolbar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "flowkit-health-toolbar" });

    const searchWrap = bar.createDiv({ cls: "flowkit-search" });
    setIcon(searchWrap.createSpan({ cls: "flowkit-search-icon" }), "search");
    const input = searchWrap.createEl("input", {
      type: "text",
      placeholder: "Search plugins…",
    });
    input.value = this.search;
    input.oninput = () => {
      this.search = input.value;
      // Re-render only the table region would be nicer, but a full render keeps
      // the code simple and the list is small.
      this.render();
      // Restore focus/caret after the re-render.
      const next = this.contentEl.querySelector<HTMLInputElement>(
        ".flowkit-search input"
      );
      if (next) {
        next.focus();
        next.setSelectionRange(next.value.length, next.value.length);
      }
    };

    const select = bar.createEl("select", { cls: "flowkit-filter dropdown" });
    for (const f of FILTERS) {
      const opt = select.createEl("option", { value: f.key, text: f.label });
      if (f.key === this.filter) opt.selected = true;
    }
    select.onchange = () => {
      this.filter = select.value as FilterKey;
      this.render();
    };
  }

  private renderTable(root: HTMLElement, rows: PluginHealth[]): void {
    const table = root.createEl("table", { cls: "flowkit-health-table" });
    const thead = table.createEl("thead").createEl("tr");
    this.sortableTh(thead, "Plugin", "name");
    this.sortableTh(thead, "Overall", "overall", true);
    for (const col of METRIC_COLUMNS) {
      this.sortableTh(thead, col.label, col.key, true);
    }
    thead.createEl("th", { text: "", cls: "num" });

    const tbody = table.createEl("tbody");
    for (const r of rows) this.renderRow(tbody, r);
  }

  private sortableTh(
    tr: HTMLElement,
    label: string,
    key: SortKey,
    num = false
  ): void {
    const th = tr.createEl("th", { cls: num ? "num sortable" : "sortable" });
    th.createSpan({ text: label });
    if (this.sortKey === key) {
      th.createSpan({
        cls: "flowkit-sort-arrow",
        text: this.sortDir === -1 ? " ▼" : " ▲",
      });
    }
    th.onclick = () => this.toggleSort(key);
  }

  private renderRow(tbody: HTMLElement, r: PluginHealth): void {
    const tr = tbody.createEl("tr");
    if (!r.enabled) tr.addClass("is-disabled");
    if (r.muted) tr.addClass("is-muted");

    const nameCell = tr.createEl("td", { cls: "flowkit-name" });
    const nameRow = nameCell.createDiv({ cls: "flowkit-name-row" });
    nameRow.createSpan({ cls: "flowkit-plugin-name", text: r.name });

    const status = MAINTENANCE_META[r.maintenanceStatus];
    this.badge(nameRow, status.label, status.tone, status.hint);
    if (r.updateAvailable) {
      this.badge(
        nameRow,
        "Update",
        "warn",
        `Newer version available${r.latestVersion ? ` (v${r.latestVersion})` : ""}.`
      );
    }
    if (r.sideloaded === true) {
      this.badge(
        nameRow,
        "Sideloaded",
        "warn",
        "Not in Obsidian's community list — skips community review."
      );
    }
    if (r.muted) {
      this.badge(nameRow, "Muted", "unknown", "Excluded from the at-risk counts.");
    }

    const meta = nameCell.createDiv({ cls: "flowkit-plugin-meta" });
    meta.setText(`${r.author} · v${r.version}${r.enabled ? "" : " · disabled"}`);

    this.scoreCell(tr, r.overall, "measured");
    for (const col of METRIC_COLUMNS) {
      const metric = r.metrics[col.key];
      this.scoreCell(tr, metric.value, metric.source, metric.detail);
    }

    const actionCell = tr.createEl("td", { cls: "num flowkit-actions" });
    const menuBtn = actionCell.createEl("button", { cls: "flowkit-menu-btn" });
    setIcon(menuBtn, "more-vertical");
    menuBtn.setAttr("aria-label", "Plugin actions");
    menuBtn.onclick = (evt) => this.openRowMenu(evt, r);
  }

  private badge(
    parent: HTMLElement,
    label: string,
    tone: "good" | "warn" | "bad" | "unknown",
    hint: string
  ): void {
    const el = parent.createSpan({
      cls: `flowkit-status-badge tone-${tone}`,
      text: label,
    });
    el.setAttr("title", hint);
    el.setAttr("aria-label", hint);
  }

  private openRowMenu(evt: MouseEvent, r: PluginHealth): void {
    const menu = new Menu();

    menu.addItem((item) =>
      item
        .setTitle(r.enabled ? "Disable plugin" : "Enable plugin")
        .setIcon(r.enabled ? "power-off" : "power")
        .onClick(async () => {
          await this.plugin.setPluginEnabled(r.id, !r.enabled);
          await this.refresh();
        })
    );

    if (r.enabled) {
      menu.addItem((item) =>
        item
          .setTitle("Open plugin settings")
          .setIcon("settings")
          .onClick(() => this.plugin.openPluginSettings(r.id))
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

    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(r.muted ? "Unmute plugin" : "Mute from counts")
        .setIcon(r.muted ? "bell" : "bell-off")
        .onClick(async () => {
          await this.plugin.toggleIgnore(r.id);
          await this.refresh();
        })
    );

    menu.showAtMouseEvent(evt);
  }

  private scoreCell(
    tr: HTMLElement,
    value: number | null,
    source: MetricScore["source"],
    detail?: string
  ): void {
    const td = tr.createEl("td", { cls: "num" });
    const chip = td.createSpan({
      cls: `flowkit-chip tone-${band(value)} src-${source}`,
    });
    chip.setText(value == null ? "—" : String(value));
    if (source === "estimated") chip.createSpan({ cls: "flowkit-est", text: "~" });
    if (detail) {
      chip.setAttr("aria-label", detail);
      chip.setAttr("title", detail);
    }
  }

  private renderLegend(root: HTMLElement): void {
    const legend = root.createDiv({ cls: "flowkit-health-legend" });
    legend.createEl("strong", { text: "How to read this: " });
    legend.createSpan({
      text:
        "Scores are 0–100. Compatibility and (when online) Popularity and " +
        "Maintenance are measured. Performance and Quality are estimates — " +
        "marked with ~ — because Obsidian exposes no direct signal for them. " +
        "Click a column to sort; use the ⋮ menu to enable/disable, open, or mute.",
    });
  }

  // --- export ---------------------------------------------------------------

  private async exportReport(): Promise<void> {
    const rows = this.visibleRows();
    const md = this.buildReportMarkdown(rows);
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const path = `Plugin Health Report ${stamp}.md`;
    try {
      const file = await this.app.vault.create(path, md);
      await this.app.workspace.getLeaf(true).openFile(file as TFile);
      new Notice(`Exported health report to “${path}”.`);
    } catch (err) {
      console.error("FlowKit: export failed", err);
      new Notice("Could not create the report note — see the console.");
    }
  }

  private buildReportMarkdown(rows: PluginHealth[]): string {
    const when = new Date().toLocaleString();
    const cell = (v: number | null) => (v == null ? "—" : String(v));
    const lines: string[] = [];
    lines.push("# Plugin Health Report");
    lines.push("");
    lines.push(
      `> Generated by FlowKit on ${when} · ${this.online ? "online" : "offline"} · ${rows.length} plugin(s)`
    );
    lines.push("");
    lines.push(
      "| Plugin | Version | Status | Overall | Quality | Maintenance | Performance | Popularity | Compatibility |"
    );
    lines.push(
      "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |"
    );
    for (const r of rows) {
      const m = r.metrics;
      const flags = [
        MAINTENANCE_META[r.maintenanceStatus].label,
        r.updateAvailable ? "Update" : "",
        r.sideloaded === true ? "Sideloaded" : "",
        r.enabled ? "" : "Disabled",
        r.muted ? "Muted" : "",
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(
        `| ${r.name} | ${r.version} | ${flags} | ${cell(r.overall)} | ${cell(
          m.quality.value
        )} | ${cell(m.maintenance.value)} | ${cell(m.performance.value)} | ${cell(
          m.popularity.value
        )} | ${cell(m.compatibility.value)} |`
      );
    }
    lines.push("");
    return lines.join("\n");
  }
}
