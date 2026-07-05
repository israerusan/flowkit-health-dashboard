import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type { MaintenanceStatus, MetricScore, PluginHealth } from "./types";
import type FlowKitHealthPlugin from "./main";
import { buildInsights, type BulkAction, type Insight } from "./insights";
import { PRO_PRICE, PURCHASE_URL } from "./product";

export const VIEW_TYPE_HEALTH = "flowkit-health-dashboard";

type Tone = "good" | "warn" | "bad" | "unknown";
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
  { label: string; tone: Tone; hint: string }
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
function band(value: number | null): Tone {
  if (value == null) return "unknown";
  if (value >= 80) return "good";
  if (value >= 50) return "warn";
  return "bad";
}

/** A letter grade + verdict for the vault-wide average. */
function gradeFor(avg: number | null): { letter: string; tone: Tone; verdict: string } {
  if (avg == null) {
    return {
      letter: "—",
      tone: "unknown",
      verdict:
        "Not enough data to grade yet — enable online enrichment for full metrics.",
    };
  }
  if (avg >= 90)
    return { letter: "A", tone: "good", verdict: "Your vault is in excellent shape." };
  if (avg >= 80)
    return {
      letter: "B",
      tone: "good",
      verdict: "Healthy overall, with a couple of things to watch.",
    };
  if (avg >= 70)
    return { letter: "C", tone: "warn", verdict: "Solid, but a few plugins need attention." };
  if (avg >= 60)
    return {
      letter: "D",
      tone: "bad",
      verdict: "Several plugins are dragging your vault down.",
    };
  return { letter: "F", tone: "bad", verdict: "Your plugin set needs some cleanup." };
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

function svgEl<K extends keyof SVGElementTagNameMap>(
  parent: Element,
  tag: K,
  attrs: Record<string, string | number>
): SVGElementTagNameMap[K] {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  parent.appendChild(el);
  return el;
}

interface SummaryStats {
  count: number;
  avg: number | null;
  atRisk: number;
  unmaintained: number;
  updates: number;
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
    await this.refresh(this.plugin.isPro && this.plugin.settings.autoRefreshOnOpen);
  }

  /** Recompute all scores and re-render. Pass `force` to re-download data. */
  async refresh(force = false): Promise<void> {
    this.loading = true;
    this.render();
    const { results, online } = await this.plugin.computeAll(force);
    this.results = results;
    this.online = online;
    this.loading = false;
    // Pro: record a trend snapshot of this scan.
    if (this.plugin.isPro) {
      const s = this.summaryStats();
      await this.plugin.recordSnapshot({
        at: Date.now(),
        avg: s.avg,
        count: s.count,
        atRisk: s.atRisk,
        unmaintained: s.unmaintained,
        updates: s.updates,
      });
    }
    this.render();
  }

  // --- data shaping ---------------------------------------------------------

  private summaryStats(): SummaryStats {
    const active = this.results.filter((r) => !r.muted);
    const scored = active
      .map((r) => r.overall)
      .filter((v): v is number => v != null);
    const avg = scored.length
      ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length)
      : null;
    return {
      count: active.length,
      avg,
      atRisk: active.filter((r) => r.overall != null && r.overall < 50).length,
      unmaintained: active.filter((r) => r.maintenanceStatus === "unmaintained")
        .length,
      updates: active.filter((r) => r.updateAvailable).length,
    };
  }

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
      const empty = root.createDiv({ cls: "flowkit-health-empty" });
      setIcon(empty.createSpan({ cls: "flowkit-spin" }), "loader-2");
      empty.createSpan({ text: " Gathering plugin data…" });
      return;
    }

    if (this.results.length === 0) {
      root.createDiv({
        cls: "flowkit-health-empty",
        text: "No installed community plugins found.",
      });
      return;
    }

    this.renderHero(root);
    this.renderSummary(root);
    this.renderInsights(root);
    if (this.plugin.isPro) this.renderTrends(root);
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
    const titleWrap = header.createDiv({ cls: "flowkit-title-wrap" });
    titleWrap.createEl("h2", { text: "Plugin Health" });
    if (this.plugin.isPro) {
      titleWrap.createSpan({ cls: "flowkit-pro-pill", text: "PRO" });
    }

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
      const exportBtn = actions.createEl("button", { cls: "flowkit-health-btn" });
      setIcon(exportBtn.createSpan(), "download");
      exportBtn.createSpan({ text: " Export" });
      if (!this.plugin.isPro) setIcon(exportBtn.createSpan({ cls: "flowkit-lock" }), "lock");
      exportBtn.onclick = (evt) => this.onExportClick(evt);
    }

    if (!this.plugin.isPro && !this.loading) {
      const up = actions.createEl("button", { cls: "flowkit-health-btn flowkit-upgrade-btn" });
      setIcon(up.createSpan(), "sparkles");
      up.createSpan({ text: " Upgrade" });
      up.onclick = () => this.openUpgrade();
    }

    const refreshBtn = actions.createEl("button", { cls: "flowkit-health-btn" });
    setIcon(refreshBtn.createSpan(), "refresh-cw");
    refreshBtn.createSpan({ text: " Refresh" });
    refreshBtn.disabled = this.loading;
    refreshBtn.onclick = () => void this.refresh(true);
  }

  private renderHero(root: HTMLElement): void {
    const s = this.summaryStats();
    const grade = gradeFor(s.avg);
    const hero = root.createDiv({ cls: "flowkit-hero" });

    // Circular gauge.
    const gauge = hero.createDiv({ cls: "flowkit-gauge" });
    const size = 116;
    const stroke = 12;
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const pct = s.avg == null ? 0 : Math.max(0, Math.min(100, s.avg)) / 100;
    const svg = svgEl(gauge, "svg", {
      viewBox: `0 0 ${size} ${size}`,
      width: size,
      height: size,
    });
    svgEl(svg, "circle", {
      cx: size / 2,
      cy: size / 2,
      r,
      fill: "none",
      "stroke-width": stroke,
      class: "flowkit-gauge-track",
    });
    svgEl(svg, "circle", {
      cx: size / 2,
      cy: size / 2,
      r,
      fill: "none",
      "stroke-width": stroke,
      "stroke-linecap": "round",
      "stroke-dasharray": `${(c * pct).toFixed(2)} ${c.toFixed(2)}`,
      transform: `rotate(-90 ${size / 2} ${size / 2})`,
      class: `flowkit-gauge-arc tone-${grade.tone}`,
    });
    // The reveal transition lives in styles.css (.flowkit-gauge-arc) rather than an
    // inline style assignment (obsidianmd/no-static-styles-assignment).
    const label = gauge.createDiv({ cls: "flowkit-gauge-label" });
    label.createDiv({
      cls: `flowkit-gauge-score tone-${grade.tone}`,
      text: s.avg == null ? "—" : String(s.avg),
    });
    label.createDiv({ cls: "flowkit-gauge-grade", text: `Grade ${grade.letter}` });

    const text = hero.createDiv({ cls: "flowkit-hero-text" });
    text.createEl("h3", { text: grade.verdict });
    text.createEl("p", {
      cls: "flowkit-hero-sub",
      text: `Vault health across ${s.count} plugin${s.count === 1 ? "" : "s"} · ${
        this.online ? "measured + estimated signals" : "local signals only"
      }.`,
    });
  }

  private renderSummary(root: HTMLElement): void {
    const s = this.summaryStats();
    const summary = root.createDiv({ cls: "flowkit-health-summary" });
    this.statTile(summary, "Plugins", String(this.results.length), "unknown");
    this.statTile(summary, "Updates", String(s.updates), s.updates > 0 ? "warn" : "good");
    this.statTile(
      summary,
      "Unmaintained",
      String(s.unmaintained),
      s.unmaintained > 0 ? "bad" : "good"
    );
    this.statTile(summary, "At risk", String(s.atRisk), s.atRisk > 0 ? "bad" : "good");
  }

  private statTile(parent: HTMLElement, label: string, value: string, tone: Tone): void {
    const tile = parent.createDiv({ cls: "flowkit-stat" });
    tile.createDiv({ cls: `flowkit-stat-value tone-${tone}`, text: value });
    tile.createDiv({ cls: "flowkit-stat-label", text: label });
  }

  // --- insights -------------------------------------------------------------

  private renderInsights(root: HTMLElement): void {
    const insights = buildInsights(this.results);
    const section = root.createDiv({ cls: "flowkit-insights" });

    const head = section.createDiv({ cls: "flowkit-section-head" });
    setIcon(head.createSpan({ cls: "flowkit-section-icon" }), "lightbulb");
    head.createSpan({ cls: "flowkit-section-title", text: "What to fix" });
    if (!this.plugin.isPro) head.createSpan({ cls: "flowkit-pro-tag", text: "PRO" });

    if (this.plugin.isPro) {
      for (const ins of insights) this.renderInsightCard(section, ins, true);
      return;
    }

    // Free: show the single most-important insight, then a locked teaser.
    this.renderInsightCard(section, insights[0], false);
    const remaining = insights.length - 1;
    const hasActions = insights.some((i) => i.action);
    if (remaining > 0 || hasActions) {
      const lock = section.createDiv({ cls: "flowkit-insight-lock" });
      const body = lock.createDiv({ cls: "flowkit-insight-lock-body" });
      setIcon(body.createSpan({ cls: "flowkit-lock-icon" }), "lock");
      const txt = body.createDiv();
      txt.createEl("strong", {
        text:
          remaining > 0
            ? `Unlock ${remaining} more insight${remaining === 1 ? "" : "s"} + one-click fixes`
            : "Unlock one-click bulk fixes",
      });
      txt.createDiv({
        cls: "flowkit-lock-sub",
        text: `FlowKit Pro (${PRO_PRICE}) adds bulk actions, export, and trends.`,
      });
      const btn = lock.createEl("button", { cls: "flowkit-health-btn flowkit-upgrade-btn" });
      btn.setText("Unlock Pro");
      btn.onclick = () => this.openUpgrade();
    }
  }

  private renderInsightCard(parent: HTMLElement, ins: Insight, pro: boolean): void {
    const card = parent.createDiv({ cls: `flowkit-insight tone-${ins.tone}` });
    setIcon(card.createSpan({ cls: "flowkit-insight-icon" }), ins.icon);
    const body = card.createDiv({ cls: "flowkit-insight-body" });
    body.createDiv({ cls: "flowkit-insight-title", text: ins.title });
    body.createDiv({ cls: "flowkit-insight-detail", text: ins.detail });
    if (pro && ins.action && ins.ids.length) {
      const btn = card.createEl("button", { cls: "flowkit-insight-action" });
      btn.setText(ins.actionLabel ?? "Apply");
      btn.onclick = () => void this.runBulk(ins);
    }
  }

  private async runBulk(ins: Insight): Promise<void> {
    if (!this.plugin.isPro || !ins.action || !ins.ids.length) return;
    const action: BulkAction = ins.action;
    let count = 0;
    if (action === "disable-unmaintained" || action === "disable-incompatible") {
      count = await this.plugin.disableMany(ins.ids);
      new Notice(`Disabled ${count} plugin${count === 1 ? "" : "s"}.`);
    } else if (action === "mute-sideloaded") {
      count = await this.plugin.muteMany(ins.ids);
      new Notice(`Muted ${count} plugin${count === 1 ? "" : "s"}.`);
    }
    await this.refresh();
  }

  // --- trends (Pro) ---------------------------------------------------------

  private renderTrends(root: HTMLElement): void {
    const history = this.plugin.settings.history;
    const section = root.createDiv({ cls: "flowkit-trends" });
    const head = section.createDiv({ cls: "flowkit-section-head" });
    setIcon(head.createSpan({ cls: "flowkit-section-icon" }), "trending-up");
    head.createSpan({ cls: "flowkit-section-title", text: "Vault health trend" });

    const points = history
      .map((h) => h.avg)
      .filter((v): v is number => v != null);
    if (points.length < 2) {
      section.createDiv({
        cls: "flowkit-trends-empty",
        text: "Trends build up as FlowKit records your vault health over time. Check back after a few scans.",
      });
      return;
    }

    const latest = history[history.length - 1];
    const prev = this.plugin.previousSnapshot(latest.at);
    const row = section.createDiv({ cls: "flowkit-trends-row" });
    this.renderSparkline(row, points);

    const delta = row.createDiv({ cls: "flowkit-trends-delta" });
    if (prev && prev.avg != null && latest.avg != null) {
      const d = latest.avg - prev.avg;
      const tone: Tone = d > 0 ? "good" : d < 0 ? "bad" : "unknown";
      const sign = d > 0 ? "▲" : d < 0 ? "▼" : "—";
      delta.createSpan({
        cls: `flowkit-delta tone-${tone}`,
        text: `${sign} ${Math.abs(d)}`,
      });
      delta.createSpan({
        cls: "flowkit-delta-sub",
        text: ` since ${describeWhen(prev.at)}`,
      });
    } else {
      delta.createSpan({ cls: "flowkit-delta-sub", text: `${points.length} scans recorded` });
    }
  }

  private renderSparkline(parent: HTMLElement, values: number[]): void {
    const w = 180;
    const h = 40;
    const pad = 3;
    const max = Math.max(...values, 100);
    const min = Math.min(...values, 0);
    const span = Math.max(1, max - min);
    const step = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
    const pts = values
      .map((v, i) => {
        const x = pad + i * step;
        const y = pad + (1 - (v - min) / span) * (h - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    const svg = svgEl(parent, "svg", {
      viewBox: `0 0 ${w} ${h}`,
      width: w,
      height: h,
      class: "flowkit-sparkline",
    });
    svgEl(svg, "polyline", {
      points: pts,
      fill: "none",
      "stroke-width": 2,
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
      class: "flowkit-sparkline-line",
    });
    // Highlight the last point.
    const lastVal = values[values.length - 1];
    const lx = pad + (values.length - 1) * step;
    const ly = pad + (1 - (lastVal - min) / span) * (h - pad * 2);
    svgEl(svg, "circle", { cx: lx, cy: ly, r: 3, class: "flowkit-sparkline-dot" });
  }

  // --- toolbar + table ------------------------------------------------------

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
      this.render();
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
    const wrap = root.createDiv({ cls: "flowkit-table-wrap" });
    const table = wrap.createEl("table", { cls: "flowkit-health-table" });
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

  private sortableTh(tr: HTMLElement, label: string, key: SortKey, num = false): void {
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

  private badge(parent: HTMLElement, label: string, tone: Tone, hint: string): void {
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

  // --- upgrade + export -----------------------------------------------------

  private openUpgrade(): void {
    window.open(PURCHASE_URL, "_blank");
  }

  private onExportClick(evt: MouseEvent): void {
    if (!this.plugin.isPro) {
      new Notice("Report export is a FlowKit Pro feature.");
      this.openUpgrade();
      return;
    }
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("Export Markdown report")
        .setIcon("file-text")
        .onClick(() => void this.exportReport("md"))
    );
    menu.addItem((item) =>
      item
        .setTitle("Export CSV")
        .setIcon("table")
        .onClick(() => void this.exportReport("csv"))
    );
    menu.showAtMouseEvent(evt);
  }

  private async exportReport(format: "md" | "csv"): Promise<void> {
    const rows = this.visibleRows();
    const content =
      format === "md" ? this.buildReportMarkdown(rows) : this.buildReportCsv(rows);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const path = `Plugin Health Report ${stamp}.${format}`;
    try {
      const file = await this.app.vault.create(path, content);
      if (format === "md") {
        await this.app.workspace.getLeaf(true).openFile(file);
      }
      new Notice(`Exported health report to “${path}”.`);
    } catch (err) {
      console.error("FlowKit: export failed", err);
      new Notice("Could not create the report file — see the console.");
    }
  }

  private buildReportMarkdown(rows: PluginHealth[]): string {
    const when = new Date().toLocaleString();
    const cell = (v: number | null) => (v == null ? "—" : String(v));
    const s = this.summaryStats();
    const grade = gradeFor(s.avg);
    const lines: string[] = [];
    lines.push("# Plugin Health Report");
    lines.push("");
    lines.push(
      `> Generated by FlowKit on ${when} · ${this.online ? "online" : "offline"} · ${rows.length} plugin(s)`
    );
    lines.push("");
    lines.push(
      `**Vault health: ${s.avg == null ? "—" : s.avg}/100 (Grade ${grade.letter})** — ${grade.verdict}`
    );
    lines.push("");
    lines.push(
      "| Plugin | Version | Status | Overall | Quality | Maintenance | Performance | Popularity | Compatibility |"
    );
    lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const r of rows) {
      const m = r.metrics;
      const flags = this.flagText(r);
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

  private buildReportCsv(rows: PluginHealth[]): string {
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const num = (v: number | null) => (v == null ? "" : String(v));
    const header = [
      "Plugin",
      "Id",
      "Author",
      "Version",
      "Enabled",
      "Status",
      "Overall",
      "Quality",
      "Maintenance",
      "Performance",
      "Popularity",
      "Compatibility",
    ];
    const lines = [header.map(esc).join(",")];
    for (const r of rows) {
      const m = r.metrics;
      lines.push(
        [
          esc(r.name),
          esc(r.id),
          esc(r.author),
          esc(r.version),
          r.enabled ? "yes" : "no",
          esc(this.flagText(r)),
          num(r.overall),
          num(m.quality.value),
          num(m.maintenance.value),
          num(m.performance.value),
          num(m.popularity.value),
          num(m.compatibility.value),
        ].join(",")
      );
    }
    return lines.join("\n");
  }

  private flagText(r: PluginHealth): string {
    return [
      MAINTENANCE_META[r.maintenanceStatus].label,
      r.updateAvailable ? "Update" : "",
      r.sideloaded === true ? "Sideloaded" : "",
      r.enabled ? "" : "Disabled",
      r.muted ? "Muted" : "",
    ]
      .filter(Boolean)
      .join(", ");
  }
}

/** A short, relative-ish description of a past timestamp for the trend delta. */
function describeWhen(at: number): string {
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days <= 0) return "earlier today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(at).toLocaleDateString();
}
