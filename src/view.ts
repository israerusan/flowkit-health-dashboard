import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type {
  DataCoverage,
  HealthSnapshot,
  MaintenanceStatus,
  MetricScore,
  PluginHealth,
} from "./types";
import { SCORING_MODEL } from "./types";
import type FlowKitHealthPlugin from "./main";
import {
  buildInsights,
  isAtRisk,
  isIncompatible,
  needsAttention,
  type BulkAction,
  type Insight,
} from "./insights";
import { WEIGHTS } from "./scoring";
import { BulkConfirmModal } from "./ui/BulkConfirmModal";
import { UpgradeModal } from "./ui/UpgradeModal";
import { PRODUCT_NAME, PRO_PRICE } from "./product";

export const VIEW_TYPE_HEALTH = "flowkit-health-dashboard";

type Tone = "good" | "warn" | "bad" | "unknown";
type MetricKey = keyof PluginHealth["metrics"];
type SortKey = "name" | "overall" | MetricKey;
type FilterKey =
  | "all"
  | "attention"
  | "unmaintained"
  | "incompatible"
  | "erroring"
  | "delisted"
  | "sideloaded"
  | "update"
  | "disabled"
  | "muted";

const METRIC_COLUMNS: Array<{ key: MetricKey; label: string; hint: string }> = [
  {
    key: "compatibility",
    label: "Compatibility",
    hint: "Whether it can run on your Obsidian, on this device. Weighted 30%.",
  },
  {
    key: "reliability",
    label: "Reliability",
    hint: "Errors this plugin actually threw on this machine. Weighted 25%.",
  },
  {
    key: "maintenance",
    label: "Maintenance",
    hint: "How recently it was released, allowing for plugins that are simply finished. Weighted 25%.",
  },
  {
    key: "footprint",
    label: "Footprint",
    hint: "Code and styles loaded at startup, measured on disk. Weighted 15%.",
  },
  {
    key: "hygiene",
    label: "Hygiene",
    hint: "What the plugin's manifest declares. Weighted 5%.",
  },
  {
    key: "popularity",
    label: "Popularity",
    hint: "Download rank within the directory — context, not health. Weighted 5%.",
  },
];

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "All plugins" },
  { key: "attention", label: "Needs attention" },
  { key: "unmaintained", label: "No recent release" },
  { key: "incompatible", label: "Incompatible" },
  { key: "erroring", label: "Throwing errors" },
  { key: "delisted", label: "Delisted" },
  { key: "sideloaded", label: "Local installs" },
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
    hint: "Released within the last 6 months.",
  },
  aging: { label: "Aging", tone: "warn", hint: "No release in 6–18 months." },
  stable: {
    label: "Stable",
    tone: "good",
    hint: "No recent release, but many published versions and most users on the newest — finished, not abandoned.",
  },
  unmaintained: {
    label: "No recent release",
    tone: "warn",
    hint: "No recorded release in over 18 months, and no sign it has settled into maturity.",
  },
  unknown: {
    label: "Unknown",
    tone: "unknown",
    hint: "No release data (offline, or not a community plugin).",
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
  /** Mean share of metric weight available across the scored plugins (0–1). */
  confidence: number;
}

/**
 * Below this, the letter grade is withheld. A grade is a confident-sounding
 * artifact; printing "A" off two of five signals is how the dashboard used to
 * announce "your vault is in excellent shape" because the network was down.
 */
const GRADE_MIN_CONFIDENCE = 0.6;

export class HealthDashboardView extends ItemView {
  private plugin: FlowKitHealthPlugin;
  private results: PluginHealth[] = [];
  private coverage: DataCoverage = { stats: false, list: false, disabled: false };
  private loading = false;
  /** Set when a scan threw, so the view offers a way out instead of a dead spinner. */
  private scanError: string | null = null;
  /** The results region, rebuilt on its own when search/filter/sort change. */
  private rowsEl: HTMLElement | null = null;
  /** Live "N of M" readout in the toolbar. */
  private countEl: HTMLElement | null = null;
  /** The row whose reasoning panel is open, if any. */
  private expandedId: string | null = null;
  /** The last bulk action, so it can be undone for the rest of the session. */
  private lastBulk: { label: string; revert: () => Promise<void> } | null = null;

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
    await this.refresh(this.plugin.settings.autoRefreshOnOpen);
  }

  /** Re-render from the results already in hand, without rescanning. */
  rerender(): void {
    this.render();
  }

  /** Recompute all scores and re-render. Pass `force` to re-download data. */
  async refresh(force = false): Promise<void> {
    this.loading = true;
    this.scanError = null;
    this.render();
    try {
      const { results, coverage } = await this.plugin.computeAll({ force });
      this.results = results;
      this.coverage = coverage;
      const s = this.summaryStats();
      await this.plugin.recordSnapshot({
        at: Date.now(),
        avg: s.avg,
        count: s.count,
        atRisk: s.atRisk,
        unmaintained: s.unmaintained,
        updates: s.updates,
        online: coverage.stats,
        confidence: s.confidence,
        model: SCORING_MODEL,
      });
      // Otherwise the status bar keeps quoting the last background pass — so
      // acting on a bulk fix left it reading "5 to fix" for hours afterwards.
      this.plugin.updateStatusBar(
        s.avg,
        this.results.filter((r) => !r.muted)
      );
    } catch (err) {
      // A rejected saveData (read-only disk, sync conflict) used to escape here
      // and leave the view stuck on the spinner with Refresh disabled, needing
      // an Obsidian restart to clear.
      console.error("FlowKit: scan failed", err);
      this.scanError =
        err instanceof Error ? err.message : "Something went wrong during the scan.";
    } finally {
      this.loading = false;
      this.render();
    }
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
    const confidence = active.length
      ? active.reduce((a, r) => a + r.confidence, 0) / active.length
      : 0;
    return {
      count: active.length,
      avg,
      atRisk: active.filter(isAtRisk).length,
      unmaintained: active.filter((r) => r.maintenanceStatus === "unmaintained")
        .length,
      updates: active.filter((r) => r.updateAvailable).length,
      confidence,
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
        case "erroring":
          return (r.errors?.uncaught ?? 0) > 0;
        case "delisted":
          return r.listing === "delisted";
        case "sideloaded":
          return r.listing === "local";
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
    this.renderRows();
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

    if (this.scanError) {
      const card = root.createDiv({ cls: "flowkit-health-error" });
      setIcon(card.createSpan({ cls: "flowkit-error-icon" }), "alert-triangle");
      const body = card.createDiv();
      body.createEl("strong", { text: "The scan didn't finish." });
      body.createDiv({ cls: "flowkit-error-detail", text: this.scanError });
      const retry = card.createEl("button", { cls: "mod-cta", text: "Try again" });
      retry.onclick = () => void this.refresh(true);
      return;
    }

    if (this.results.length === 0) {
      root.createDiv({
        cls: "flowkit-health-empty",
        text: "No installed community plugins found.",
      });
      return;
    }

    this.renderIntro(root);
    this.renderHero(root);
    this.renderCoverageNotice(root);
    this.renderUndoBar(root);
    this.renderSummary(root);
    this.renderInsights(root);
    this.renderTrends(root);
    this.renderToolbar(root);

    // Everything above depends only on the scan; everything below depends on
    // the search/filter/sort. Keeping them apart is what lets a keystroke
    // rebuild ~40 table rows instead of the entire dashboard — which is what
    // used to destroy the search box mid-word and force the caret to the end.
    this.rowsEl = root.createDiv({ cls: "flowkit-rows" });
    this.renderRows();
    this.renderLegend(root);
  }

  /** Rebuild only the results region. Cheap enough to run on every keystroke. */
  private renderRows(): void {
    const host = this.rowsEl;
    if (!host) return;
    host.empty();

    const rows = this.visibleRows();
    if (this.countEl) {
      this.countEl.setText(
        rows.length === this.results.length
          ? `${rows.length} plugin${rows.length === 1 ? "" : "s"}`
          : `${rows.length} of ${this.results.length}`
      );
    }

    if (rows.length === 0) {
      const empty = host.createDiv({ cls: "flowkit-health-empty" });
      empty.createDiv({ text: "No plugins match the current filter." });
      if (this.search || this.filter !== "all") {
        const clear = empty.createEl("button", { text: "Clear filters" });
        clear.onclick = () => {
          this.search = "";
          this.filter = "all";
          this.render();
        };
      }
      return;
    }
    this.renderTable(host, rows);
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
    // The two community files fail independently, so "online" was never one
    // boolean — the header used to claim "full metrics" whenever stats loaded,
    // even with sideload detection and repo links silently missing.
    const full = this.coverage.stats && this.coverage.list;
    status.setText(
      this.loading
        ? "Scoring…"
        : full
          ? "Online — all signals"
          : this.coverage.stats || this.coverage.list
            ? "Online — some signals unavailable"
            : "Local signals only"
    );
    status.addClass(full ? "is-online" : "is-offline");

    if (!this.loading && this.results.length > 0) {
      const exportBtn = actions.createEl("button", { cls: "flowkit-health-btn" });
      setIcon(exportBtn.createSpan(), "download");
      exportBtn.createSpan({ text: " Export" });
      if (!this.plugin.isPro && this.plugin.settings.usedFreeExport) {
        setIcon(exportBtn.createSpan({ cls: "flowkit-lock" }), "lock");
      }
      exportBtn.onclick = (evt) => this.onExportClick(evt);
    }

    // Only ask once there is something to ask about, and never above an empty
    // dashboard. The old button rendered before the early returns, so the same
    // context-free "Upgrade" sat above "No installed community plugins found" —
    // loudest exactly where it was least earned.
    if (!this.plugin.isPro && !this.loading && this.results.length > 0) {
      const fixable = new Set(
        buildInsights(this.results)
          .filter((i) => i.action && i.ids.length)
          .flatMap((i) => i.ids)
      ).size;
      if (fixable > 0) {
        const up = actions.createEl("button", {
          cls: "flowkit-health-btn flowkit-upgrade-btn",
        });
        setIcon(up.createSpan(), "zap");
        up.createSpan({ text: ` Fix ${fixable} in one click` });
        up.onclick = () => this.openUpgrade("bulk");
      }
    }

    const refreshBtn = actions.createEl("button", { cls: "flowkit-health-btn" });
    setIcon(refreshBtn.createSpan(), "refresh-cw");
    refreshBtn.createSpan({ text: " Refresh" });
    refreshBtn.disabled = this.loading;
    refreshBtn.onclick = () => void this.refresh(true);
  }

  private renderHero(root: HTMLElement): void {
    const s = this.summaryStats();
    // Strictly greater: offline coverage lands on exactly 0.60 (compatibility
    // .30 + footprint .20 + hygiene .10), so `>=` let a vault with maintenance
    // and popularity entirely unmeasured still print a confident letter grade.
    const graded = s.confidence > GRADE_MIN_CONFIDENCE;
    const grade = graded
      ? gradeFor(s.avg)
      : {
          letter: "—",
          tone: "unknown" as Tone,
          verdict: "Not enough signal to grade this vault yet.",
        };
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
    const signals = Math.round(s.confidence * 5);
    text.createEl("p", {
      cls: "flowkit-hero-sub",
      text:
        `Across ${s.count} plugin${s.count === 1 ? "" : "s"} · ` +
        `${signals} of 5 signals available · ${Math.round(s.confidence * 100)}% confidence.`,
    });
    if (!graded) {
      text.createEl("p", {
        cls: "flowkit-hero-hint",
        text: "Turn on online enrichment for maintenance and popularity data, and a letter grade.",
      });
    }
  }

  /**
   * A one-time orientation. Landing on a wall of numbers with no idea what they
   * are or what to do next is how a first run ends in an uninstall.
   */
  private renderIntro(root: HTMLElement): void {
    if (this.plugin.settings.seenIntro) return;
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
      this.plugin.settings.seenIntro = true;
      void this.plugin.saveSettings();
      intro.remove();
    };
  }

  /**
   * Say plainly when enrichment is incomplete, and why. Silently dropping two of
   * five columns and relabelling the header is the kind of thing users notice
   * and mistrust.
   */
  private renderCoverageNotice(root: HTMLElement): void {
    const { stats, list, disabled, error } = this.coverage;

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
      again.onclick = () => void this.refresh(true);
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
        this.plugin.settings.enableOnlineEnrichment = true;
        void this.plugin.saveSettings().then(() => this.refresh(true));
      };
      return;
    }

    const missing = !stats && !list ? "Popularity, Maintenance and sideload detection" : !stats ? "Popularity and Maintenance" : "sideload detection and repository links";
    body.createDiv({ text: `${error ?? "Couldn't reach GitHub."} ${missing} unavailable for this scan.` });
    const btn = note.createEl("button", { text: "Retry" });
    btn.onclick = () => void this.refresh(true);
  }

  private renderSummary(root: HTMLElement): void {
    const s = this.summaryStats();
    const summary = root.createDiv({ cls: "flowkit-health-summary" });
    this.statTile(summary, "Plugins", String(this.results.length), "unknown", "all");
    this.statTile(
      summary,
      "Updates",
      String(s.updates),
      s.updates > 0 ? "warn" : "good",
      "update"
    );
    this.statTile(
      summary,
      "No recent release",
      String(s.unmaintained),
      s.unmaintained > 0 ? "warn" : "good",
      "unmaintained"
    );
    this.statTile(
      summary,
      "At risk",
      String(s.atRisk),
      s.atRisk > 0 ? "bad" : "good",
      "attention"
    );
  }

  /** A standing way back from the last bulk action, for the rest of the session. */
  private renderUndoBar(root: HTMLElement): void {
    if (!this.lastBulk) return;
    const bar = root.createDiv({ cls: "flowkit-undo-bar" });
    setIcon(bar.createSpan({ cls: "flowkit-undo-icon" }), "rotate-ccw");
    bar.createSpan({ cls: "flowkit-undo-label", text: this.lastBulk.label });
    const btn = bar.createEl("button", { text: "Undo" });
    btn.onclick = () => void this.undoLastBulk();
  }

  /** A stat tile that filters the table to the thing it counts. */
  private statTile(
    parent: HTMLElement,
    label: string,
    value: string,
    tone: Tone,
    filter: FilterKey
  ): void {
    const tile = parent.createEl("button", { cls: "flowkit-stat" });
    tile.setAttr("aria-label", `${value} ${label} — show them`);
    tile.createDiv({ cls: `flowkit-stat-value tone-${tone}`, text: value });
    tile.createDiv({ cls: "flowkit-stat-label", text: label });
    tile.onclick = () => {
      this.filter = filter;
      this.search = "";
      this.render();
    };
  }

  // --- insights -------------------------------------------------------------

  private renderInsights(root: HTMLElement): void {
    const insights = buildInsights(this.results);
    const section = root.createDiv({ cls: "flowkit-insights" });

    const head = section.createDiv({ cls: "flowkit-section-head" });
    setIcon(head.createSpan({ cls: "flowkit-section-icon" }), "lightbulb");
    head.createSpan({ cls: "flowkit-section-title", text: "What to fix" });

    // The complete diagnosis, for everyone.
    //
    // This used to show insights[0] and then a lock card. It converted nobody:
    // every input the hidden insights are built from was already free — the
    // badges, the chips — and the filter dropdown ships a dedicated option for
    // each hidden cohort, so any user could reconstruct the whole list in five
    // seconds and conclude the gate was artificial. What Pro sells now is
    // applying the fixes, not being told what they are.
    for (const ins of insights) this.renderInsightCard(section, ins, this.plugin.isPro);

    if (this.plugin.isPro) return;

    const actionable = insights.filter((i) => i.action && i.ids.length);
    if (!actionable.length) return;

    const affected = new Set(actionable.flatMap((i) => i.ids));
    const lock = section.createDiv({ cls: "flowkit-insight-lock" });
    const body = lock.createDiv({ cls: "flowkit-insight-lock-body" });
    setIcon(body.createSpan({ cls: "flowkit-lock-icon" }), "zap");
    const txt = body.createDiv();
    txt.createEl("strong", {
      text: `Apply ${affected.size} of these fixes in one click`,
    });
    txt.createDiv({
      cls: "flowkit-lock-sub",
      text: `Review what changes, apply it together, undo if you disagree — plus monitoring, reports and history. Pro, ${PRO_PRICE}.`,
    });
    const btn = lock.createEl("button", { cls: "flowkit-health-btn flowkit-upgrade-btn" });
    btn.setText("See what Pro adds");
    btn.onclick = () => this.openUpgrade("bulk");
  }

  /** The table filter that shows exactly the plugins an insight is about. */
  private filterForInsight(id: string): FilterKey | null {
    switch (id) {
      case "delisted":
        return "delisted";
      case "incompatible":
        return "incompatible";
      case "erroring":
        return "erroring";
      case "unmaintained":
        return "unmaintained";
      case "at-risk":
        return "attention";
      case "updates":
        return "update";
      case "sideloaded":
        return "sideloaded";
      default:
        return null;
    }
  }

  private renderInsightCard(parent: HTMLElement, ins: Insight, pro: boolean): void {
    const card = parent.createDiv({ cls: `flowkit-insight tone-${ins.tone}` });
    setIcon(card.createSpan({ cls: "flowkit-insight-icon" }), ins.icon);
    const body = card.createDiv({ cls: "flowkit-insight-body" });
    body.createDiv({ cls: "flowkit-insight-title", text: ins.title });
    body.createDiv({ cls: "flowkit-insight-detail", text: ins.detail });

    // An insight that names plugins should be able to show you them.
    const filter = ins.ids.length ? this.filterForInsight(ins.id) : null;
    if (filter) {
      card.addClass("is-clickable");
      card.setAttr("tabindex", "0");
      card.setAttr("role", "button");
      card.setAttr("aria-label", `${ins.title} — show these plugins`);
      const go = () => {
        this.filter = filter;
        this.search = "";
        this.render();
      };
      card.onclick = (evt) => {
        if ((evt.target as HTMLElement).closest("button")) return;
        go();
      };
      card.onkeydown = (evt) => {
        if (evt.key !== "Enter" && evt.key !== " ") return;
        if ((evt.target as HTMLElement) !== card) return;
        evt.preventDefault();
        go();
      };
    }
    if (ins.action && ins.ids.length) {
      const btn = card.createEl("button", { cls: "flowkit-insight-action" });
      if (pro) {
        btn.setText(ins.actionLabel ?? "Apply");
        btn.onclick = () => this.runBulk(ins);
      } else {
        // Shown, not hidden: the user should be able to see the capability they
        // would be buying, on their own vault's numbers.
        btn.addClass("is-locked");
        setIcon(btn.createSpan({ cls: "flowkit-lock-icon" }), "lock");
        btn.createSpan({ text: ` ${ins.actionLabel ?? "Apply"}` });
        btn.setAttr("aria-label", `${ins.actionLabel ?? "Apply"} — a Pro feature`);
        btn.onclick = () => this.openUpgrade("bulk");
      }
    }
  }

  /** Show what a bulk action will do, then do it — and keep a way back. */
  private runBulk(ins: Insight): void {
    if (!this.plugin.isPro || !ins.action || !ins.ids.length) return;
    const action: BulkAction = ins.action;
    const affected = this.results.filter((r) => ins.ids.includes(r.id));
    const disabling = action !== "mute-sideloaded";
    // Only rows the action would actually change — disabling something already
    // disabled is a no-op that used to be counted and reported anyway.
    const rows = disabling ? affected.filter((r) => r.enabled) : affected.filter((r) => !r.muted);

    if (!rows.length) {
      new Notice("Nothing to change — those plugins are already in that state.");
      return;
    }

    new BulkConfirmModal(this.app, {
      title: disabling ? "Disable these plugins?" : "Mute these plugins?",
      intro: disabling
        ? `FlowKit will turn off ${rows.length} plugin${rows.length === 1 ? "" : "s"}. Nothing is uninstalled, and you can undo this straight after.`
        : `FlowKit will hide ${rows.length} plugin${rows.length === 1 ? "" : "s"} from the at-risk counts. Their scores stay visible.`,
      rows: rows.map((r) => ({
        name: r.name,
        detail: this.bulkReason(r, action),
      })),
      caveat: disabling
        ? "A plugin with no recent release isn't necessarily broken — some are simply finished. Cancel and disable them individually from the row menu if you'd rather keep some."
        : undefined,
      confirmLabel: disabling
        ? `Disable ${rows.length}`
        : `Mute ${rows.length}`,
      onConfirm: () => void this.applyBulk(action, rows.map((r) => r.id)),
    }).open();
  }

  /**
   * The errors traced to one plugin.
   *
   * Free sees the diagnosis — which errors, how many, how recently — because
   * that is the whole point of the feature and matches how the rest of the tier
   * split works. Pro gets the stack traces, which is what you need to file a
   * useful bug report or decide whether it's your setup or their code.
   */
  private renderErrorDetail(panel: HTMLElement, r: PluginHealth): void {
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

      if (!sig.stack) continue;
      if (this.plugin.isPro) {
        const details = item.createEl("details", { cls: "flowkit-error-stack" });
        details.createEl("summary", { text: "Stack trace" });
        details.createEl("pre").createEl("code", { text: sig.stack });
      } else {
        const locked = item.createDiv({ cls: "flowkit-error-locked" });
        setIcon(locked.createSpan({ cls: "flowkit-lock-icon" }), "lock");
        const btn = locked.createEl("button", { text: "See the stack trace with Pro" });
        btn.onclick = () => this.openUpgrade("errors");
      }
    }
  }

  /** The evidence for one row appearing in a bulk list. */
  private bulkReason(r: PluginHealth, action: BulkAction): string {
    if (action === "disable-incompatible") {
      return r.metrics.compatibility.detail;
    }
    if (action === "disable-unmaintained") {
      return r.metrics.maintenance.detail || "No recorded update in over 18 months.";
    }
    return "Not in Obsidian's community list.";
  }

  private async applyBulk(action: BulkAction, ids: string[]): Promise<void> {
    if (action === "mute-sideloaded") {
      const changed = await this.plugin.muteMany(ids);
      this.lastBulk = {
        label: `Muted ${changed.length} plugin${changed.length === 1 ? "" : "s"}`,
        revert: async () => {
          await this.plugin.unmuteMany(changed);
        },
      };
      new Notice(`Muted ${changed.length} plugin${changed.length === 1 ? "" : "s"}.`);
    } else {
      const changed = await this.plugin.disableMany(ids);
      this.lastBulk = {
        label: `Disabled ${changed.length} plugin${changed.length === 1 ? "" : "s"}`,
        revert: async () => {
          await this.plugin.enableMany(changed);
        },
      };
      new Notice(`Disabled ${changed.length} plugin${changed.length === 1 ? "" : "s"}.`);
    }
    await this.refresh();
  }

  private async undoLastBulk(): Promise<void> {
    const last = this.lastBulk;
    if (!last) return;
    try {
      await last.revert();
      // Only forget the undo once it actually succeeded — clearing it first
      // removed the user's way back while leaving the change in place.
      this.lastBulk = null;
      new Notice("Reverted.");
    } catch (err) {
      console.error("FlowKit: undo failed", err);
      new Notice("Couldn't undo that — see the console. The Undo button is still there.");
    }
    await this.refresh();
  }

  // --- trends (Pro) ---------------------------------------------------------

  private renderTrends(root: HTMLElement): void {
    // Free sees the last 30 days; Pro sees the full retained window.
    const windowDays = this.plugin.isPro ? 90 : 30;
    const cutoff = Date.now() - windowDays * 86_400_000;
    const history = this.plugin.settings.history
      .filter((h) => h.at >= cutoff)
      .sort((a, b) => a.at - b.at);

    const section = root.createDiv({ cls: "flowkit-trends" });
    const head = section.createDiv({ cls: "flowkit-section-head" });
    setIcon(head.createSpan({ cls: "flowkit-section-icon" }), "trending-up");
    head.createSpan({
      cls: "flowkit-section-title",
      text: `Vault health trend · ${windowDays} days`,
    });

    // Two exclusions, both about comparability:
    //  - offline readings, where a missing signal looked like an improvement;
    //  - readings from an older scoring model, which are a different scale.
    const usable = history.filter(
      (h): h is HealthSnapshot & { avg: number } =>
        h.avg != null && h.online !== false && h.model === SCORING_MODEL
    );

    if (usable.length === 0) {
      section.createDiv({
        cls: "flowkit-trends-empty",
        text: "FlowKit records one reading a day. Your trend appears here from tomorrow.",
      });
      return;
    }
    if (usable.length === 1) {
      section.createDiv({
        cls: "flowkit-trends-empty",
        text: `First reading recorded: ${usable[0].avg}/100. The trend line builds from tomorrow.`,
      });
      return;
    }

    const latest = usable[usable.length - 1];
    // The baseline must come from the points actually drawn. Reading it back
    // out of the full history would quote a delta against a snapshot the chart
    // just excluded for being incomparable.
    const prev = usable[usable.length - 2];
    const row = section.createDiv({ cls: "flowkit-trends-row" });
    this.renderSparkline(row, usable);

    const delta = row.createDiv({ cls: "flowkit-trends-delta" });
    if (prev) {
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
      delta.createSpan({
        cls: "flowkit-delta-sub",
        text: `${usable.length} readings recorded`,
      });
    }

    if (!this.plugin.isPro && this.plugin.settings.history.length > usable.length) {
      const more = section.createDiv({ cls: "flowkit-trends-more" });
      more.appendText(
        `You have ${this.plugin.settings.history.length} readings saved. `
      );
      const link = more.createEl("button", { text: "See all 90 days with Pro" });
      link.onclick = () => this.openUpgrade("history");
    }
  }

  private renderSparkline(
    parent: HTMLElement,
    points: Array<HealthSnapshot & { avg: number }>
  ): void {
    const w = 180;
    const h = 40;
    const pad = 3;
    const values = points.map((p) => p.avg);
    // Auto-scale to the data. It used to force `max(...values, 100)` and
    // `min(...values, 0)`, pinning the span to at least 100 inside a 34px
    // drawing area — so real movement of a few points rendered as about one
    // pixel, and the headline trend feature drew a flat line.
    const lo = Math.max(0, Math.min(...values) - 3);
    const hi = Math.min(100, Math.max(...values) + 3);
    const span = Math.max(1, hi - lo);
    // Space by real elapsed time, so a gap in scanning looks like a gap.
    const t0 = points[0].at;
    const tSpan = Math.max(1, points[points.length - 1].at - t0);
    const pts = points
      .map((p) => {
        const x = pad + ((p.at - t0) / tSpan) * (w - pad * 2);
        const y = pad + (1 - (p.avg - lo) / span) * (h - pad * 2);
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
    const last = points[points.length - 1];
    const lx = pad + (w - pad * 2);
    const ly = pad + (1 - (last.avg - lo) / span) * (h - pad * 2);
    svgEl(svg, "circle", { cx: lx, cy: ly, r: 3, class: "flowkit-sparkline-dot" });
    svg.setAttribute(
      "aria-label",
      `Vault health from ${values[0]} to ${last.avg} over ${points.length} readings.`
    );
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
    // The input element survives now, so there is no refocus-and-jump-the-caret
    // hack. Typing in the middle of a query stays put, and IME composition is
    // no longer torn down mid-word.
    input.oninput = () => {
      this.search = input.value;
      this.renderRows();
    };

    const select = bar.createEl("select", { cls: "flowkit-filter dropdown" });
    for (const f of FILTERS) {
      const opt = select.createEl("option", { value: f.key, text: f.label });
      if (f.key === this.filter) opt.selected = true;
    }
    select.onchange = () => {
      this.filter = select.value as FilterKey;
      this.renderRows();
    };

    this.countEl = bar.createSpan({ cls: "flowkit-result-count" });
  }

  private renderTable(root: HTMLElement, rows: PluginHealth[]): void {
    const wrap = root.createDiv({ cls: "flowkit-table-wrap" });
    const table = wrap.createEl("table", { cls: "flowkit-health-table" });
    table.createEl("caption", {
      cls: "flowkit-sr-only",
      text: "Installed plugins scored on compatibility, maintenance, footprint, manifest hygiene and popularity. Select a row to see why it scored what it did.",
    });
    const thead = table.createEl("thead").createEl("tr");
    this.sortableTh(thead, "Plugin", "name");
    this.sortableTh(
      thead,
      "Overall",
      "overall",
      true,
      "Weighted blend of the five metrics, renormalised over what was available."
    );
    for (const col of METRIC_COLUMNS) {
      this.sortableTh(thead, col.label, col.key, true, col.hint);
    }
    thead.createEl("th", { text: "", cls: "num" });

    const tbody = table.createEl("tbody");
    for (const r of rows) {
      this.renderRow(tbody, r);
      if (this.expandedId === r.id) this.renderDetail(tbody, r);
    }
  }

  /**
   * The reasoning behind one plugin's score, inline under its row. Before this
   * the numbers were terminal: a user could see 43 and had nowhere to go to
   * find out why, or what to do about it.
   */
  private renderDetail(tbody: HTMLElement, r: PluginHealth): void {
    const tr = tbody.createEl("tr", { cls: "flowkit-detail-row" });
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

    this.renderErrorDetail(panel, r);

    const facts = panel.createDiv({ cls: "flowkit-detail-facts" });
    facts.createDiv({
      text: `Installed v${r.version}${
        r.latestVersion && r.latestVersion !== r.version
          ? ` · latest published v${r.latestVersion}`
          : ""
      } · by ${r.author}`,
    });

    const actions = panel.createDiv({ cls: "flowkit-detail-actions" });
    const toggle = actions.createEl("button", {
      text: r.enabled ? "Disable" : "Enable",
    });
    toggle.onclick = () => {
      void this.plugin.setPluginEnabled(r.id, !r.enabled).then(() => this.refresh());
    };
    if (r.enabled) {
      const settings = actions.createEl("button", { text: "Open its settings" });
      settings.onclick = () => this.plugin.openPluginSettings(r.id);
    }
    if (r.repo) {
      const gh = actions.createEl("button", { text: "Open on GitHub" });
      gh.onclick = () => window.open(`https://github.com/${r.repo}`, "_blank");
    }
    const mute = actions.createEl("button", {
      text: r.muted ? "Unmute" : "Mute from counts",
    });
    mute.onclick = () => {
      void this.plugin.toggleIgnore(r.id).then(() => this.refresh());
    };
  }

  private sortableTh(
    tr: HTMLElement,
    label: string,
    key: SortKey,
    num = false,
    hint?: string
  ): void {
    const th = tr.createEl("th", { cls: num ? "num sortable" : "sortable" });
    th.setAttr("scope", "col");
    if (hint) {
      th.setAttr("title", hint);
      th.setAttr("aria-label", `${label} — ${hint}`);
    }
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

    const expanded = this.expandedId === r.id;
    if (expanded) tr.addClass("is-expanded");
    // Operable by keyboard, and announced as the disclosure control it is.
    tr.setAttr("tabindex", "0");
    tr.setAttr("role", "button");
    tr.setAttr("aria-expanded", String(expanded));
    tr.setAttr("aria-label", `${r.name} — show why it scores ${r.overall ?? "unknown"}`);
    const toggle = () => {
      this.expandedId = expanded ? null : r.id;
      this.renderRows();
    };
    tr.onclick = (evt) => {
      // Don't hijack the row menu button or the panel's own controls.
      if ((evt.target as HTMLElement).closest("button")) return;
      toggle();
    };
    tr.onkeydown = (evt) => {
      if (evt.key !== "Enter" && evt.key !== " ") return;
      if ((evt.target as HTMLElement) !== tr) return;
      evt.preventDefault();
      toggle();
    };

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
    const errs = r.errors?.uncaught ?? 0;
    if (errs > 0) {
      this.badge(
        nameRow,
        `${errs} error${errs === 1 ? "" : "s"}`,
        "bad",
        "Unhandled errors traced to this plugin while FlowKit has been watching."
      );
    }
    if (r.listing === "delisted") {
      this.badge(
        nameRow,
        "Delisted",
        "bad",
        "Was in Obsidian's community directory and has since been removed."
      );
    } else if (r.listing === "local") {
      // Neutral: installing outside the directory is a choice, not a fault.
      this.badge(
        nameRow,
        "Local install",
        "unknown",
        "Not in Obsidian's community list — installed manually or via BRAT, so it skipped community review."
      );
    }
    if (r.muted) {
      this.badge(nameRow, "Muted", "unknown", "Excluded from the at-risk counts.");
    }

    const meta = nameCell.createDiv({ cls: "flowkit-plugin-meta" });
    meta.setText(`${r.author} · v${r.version}${r.enabled ? "" : " · disabled"}`);

    // Overall is a blend of measured and estimated inputs, so it is never itself
    // "measured" — claiming so overstated confidence on the headline number.
    this.scoreCell(
      tr,
      r.overall,
      "estimated",
      "Blended from the five metrics in this row.",
      "Overall"
    );
    for (const col of METRIC_COLUMNS) {
      const metric = r.metrics[col.key];
      this.scoreCell(tr, metric.value, metric.source, metric.detail, col.label);
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
    detail?: string,
    columnLabel?: string
  ): void {
    const td = tr.createEl("td", { cls: "num" });
    // Read by the narrow-width card layout, where the header row is hidden.
    if (columnLabel) td.setAttr("data-label", columnLabel);
    const tone = band(value);
    const chip = td.createSpan({
      cls: `flowkit-chip tone-${tone} src-${source}`,
    });
    chip.setText(value == null ? "—" : String(value));
    if (source === "estimated") chip.createSpan({ cls: "flowkit-est", text: "~" });
    // Colour alone carried the good/warn/bad reading, which is invisible to
    // anyone colour-blind and to a screen reader. Name the band in the label.
    const bandWord =
      tone === "good" ? "good" : tone === "warn" ? "needs a look" : tone === "bad" ? "poor" : "no data";
    const label = detail ? `${bandWord} — ${detail}` : bandWord;
    chip.setAttr("aria-label", label);
    if (detail) chip.setAttr("title", detail);
  }

  private renderLegend(root: HTMLElement): void {
    const legend = root.createDiv({ cls: "flowkit-health-legend" });
    legend.createEl("strong", { text: "How to read this: " });
    legend.createSpan({
      text:
        "Scores are 0–100. Overall is a weighted blend — Compatibility 25%, " +
        "Reliability 25%, Maintenance 25%, Footprint 15%, Hygiene 5%, " +
        "Popularity 5% — " +
        "renormalised over whatever data is actually available, with the " +
        "confidence figure above showing how much that was. A plugin that " +
        "can't load is capped at 20 regardless of its other scores, and one " +
        "removed from the community directory at 30. Popularity is context, " +
        "not health: a niche plugin isn't a worse plugin. Click a column to " +
        "sort; use the ⋮ menu to enable/disable, open, or mute.",
    });
  }

  // --- upgrade + export -----------------------------------------------------

  /** The one way to reach the upgrade path, from anywhere in the view. */
  private openUpgrade(
    feature?: "bulk" | "export" | "history" | "monitoring" | "errors"
  ): void {
    const insights = buildInsights(this.results);
    const affected = new Set(
      insights.filter((i) => i.action && i.ids.length).flatMap((i) => i.ids)
    );
    new UpgradeModal(this.app, {
      feature,
      headline: affected.size
        ? `Fix ${affected.size} plugin${affected.size === 1 ? "" : "s"} in this vault in one click.`
        : undefined,
      activate: async (key) => {
        this.plugin.settings.licenseKey = key;
        await this.plugin.saveSettings();
        const flipped = this.plugin.refreshLicense();
        if (flipped && this.plugin.isPro) {
          await this.refresh();
          return true;
        }
        return this.plugin.isPro;
      },
    }).open();
  }

  private onExportClick(evt: MouseEvent): void {
    // Free users get one full report. It is the only artefact this plugin
    // produces that leaves the app and gets seen by other people, so refusing
    // it outright was refusing the product's best piece of marketing.
    if (!this.plugin.isPro && this.plugin.settings.usedFreeExport) {
      this.openUpgrade("export");
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
    let created: TFile | null = null;
    let createdPath = "";
    try {
      const path = await this.uniquePath(`Plugin Health Report ${stamp}`, format);
      createdPath = path;
      // A leading BOM keeps Excel from mangling non-ASCII plugin names in the
      // CSV. Built with fromCharCode rather than written literally, so the
      // source stays free of invisible whitespace.
      created = await this.app.vault.create(
        path,
        format === "csv" ? String.fromCharCode(0xfeff) + content : content
      );
      if (!this.plugin.isPro) {
        this.plugin.settings.usedFreeExport = true;
        await this.plugin.saveSettings();
      }
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
        await this.app.workspace.getLeaf(true).openFile(created);
      } catch (err) {
        console.error("FlowKit: could not open the report", err);
        new Notice(`Report saved to “${createdPath}”, but it couldn't be opened.`);
      }
    }
    // The Export button's lock state depends on usedFreeExport.
    this.render();
  }

  /**
   * A path that doesn't already exist. The stamp is second-resolution, so two
   * exports inside the same second used to collide and throw.
   */
  private async uniquePath(base: string, format: string): Promise<string> {
    let path = `${base}.${format}`;
    let n = 2;
    while (await this.app.vault.adapter.exists(path)) {
      path = `${base} (${n++}).${format}`;
    }
    return path;
  }

  private buildReportMarkdown(rows: PluginHealth[]): string {
    const when = new Date().toLocaleString();
    const cell = (v: number | null) => (v == null ? "—" : String(v));
    // Plugin names legitimately contain pipes; unescaped they split the table.
    const md = (v: string) => v.replace(/\|/g, "\\|");
    const s = this.summaryStats();
    const grade = gradeFor(s.avg);
    const lines: string[] = [];
    lines.push("# Plugin Health Report");
    lines.push("");
    lines.push(
      `> Generated by FlowKit on ${when} · ${this.coverage.stats ? "online" : "local signals only"} · ${rows.length} plugin(s)`
    );
    lines.push("");
    lines.push(
      `**Vault health: ${s.avg == null ? "—" : s.avg}/100 (Grade ${grade.letter})** — ${grade.verdict}`
    );
    lines.push("");
    lines.push(
      `Built from ${Math.round(s.confidence * 100)}% of the available signals.` +
        (this.filter !== "all" || this.search
          ? ` Filtered view: ${FILTERS.find((f) => f.key === this.filter)?.label ?? this.filter}${
              this.search ? `, matching “${this.search}”` : ""
            }.`
          : "")
    );
    lines.push("");

    // The report never called buildInsights, so the one thing this product
    // produces that other people actually see was an uninterpreted grid of
    // numbers. Lead with the conclusions.
    const insights = buildInsights(this.results);
    lines.push("## What to fix");
    lines.push("");
    for (const ins of insights) {
      lines.push(`- **${md(ins.title)}** — ${md(ins.detail)}`);
    }
    lines.push("");
    lines.push("## Scorecard");
    lines.push("");
    lines.push(
      "| Plugin | Version | Status | Overall | Compatibility | Reliability | Maintenance | Footprint | Hygiene | Popularity |"
    );
    lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const r of rows) {
      const m = r.metrics;
      const flags = this.flagText(r);
      lines.push(
        `| ${md(r.name)} | ${md(r.version)} | ${md(flags)} | ${cell(r.overall)} | ${cell(
          m.compatibility.value
        )} | ${cell(m.reliability.value)} | ${cell(m.maintenance.value)} | ${cell(
          m.footprint.value
        )} | ${cell(m.hygiene.value)} | ${cell(m.popularity.value)} |`
      );
    }
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(
      "Overall is a weighted blend — Compatibility 25%, Reliability 25%, " +
        "Maintenance 25%, Footprint 15%, Hygiene 5%, Popularity 5% — " +
        "renormalised over the signals available. A plugin that can't load is " +
        "capped at 20; one removed from the community directory at 30."
    );
    lines.push("");
    lines.push(
      this.plugin.isPro
        ? `Generated by ${PRODUCT_NAME}.`
        : `Generated by ${PRODUCT_NAME}. Pro (${PRO_PRICE}) adds one-click bulk fixes with undo, background monitoring, unlimited reports, and 90 days of history.`
    );
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
      "Confidence",
      "Compatibility",
      "Reliability",
      "Errors",
      "Maintenance",
      "Footprint",
      "Hygiene",
      "Popularity",
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
          `${Math.round(r.confidence * 100)}%`,
          num(m.compatibility.value),
          num(m.reliability.value),
          String(r.errors?.uncaught ?? 0),
          num(m.maintenance.value),
          num(m.footprint.value),
          num(m.hygiene.value),
          num(m.popularity.value),
        ].join(",")
      );
    }
    return lines.join("\n");
  }

  private flagText(r: PluginHealth): string {
    return [
      MAINTENANCE_META[r.maintenanceStatus].label,
      r.updateAvailable ? "Update" : "",
      r.listing === "delisted" ? "Delisted" : "",
      r.listing === "local" ? "Local install" : "",
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
