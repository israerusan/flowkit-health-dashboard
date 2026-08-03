import {
  ItemView,
  Menu,
  Notice,
  Platform,
  TFile,
  WorkspaceLeaf,
  apiVersion,
  setIcon,
} from "obsidian";
import type {
  DataCoverage,
  HealthChange,
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
import { totalUncaught } from "./errors";
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
  /** In-flight guard: two concurrent scans would race results and double-write. */
  private refreshing = false;
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
  // Ascending: worst first. The whole product exists to surface the plugin you
  // should worry about, and it used to open sorted best-first, putting that
  // plugin at the bottom of the list, below the fold.
  private sortDir: 1 | -1 = 1;
  /** When set, the table is scoped to exactly the cohort a finding counted. */
  private scopeInsight: Insight | null = null;
  private toolbarEl: HTMLElement | null = null;
  private filterSelect: HTMLSelectElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private scopeChipEl: HTMLElement | null = null;

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

  /**
   * Recompute all scores and re-render.
   *
   * @param force re-download community data instead of using the cache.
   * @param allowFetch whether this rescan may touch the network at all. Acting
   *   on a single row must never do so: with the 24h cache TTL, muting one
   *   plugin could otherwise trigger a multi-megabyte download behind a
   *   full-page spinner, which made the paid bulk flow the slowest thing here.
   */
  async refresh(force = false, allowFetch = true): Promise<void> {
    // A second concurrent scan would race `this.results` and double-write the
    // same snapshot. The full-page spinner used to hide this by making a second
    // click unlikely; now that the page stays interactive, guard it properly.
    if (this.refreshing) return;
    this.refreshing = true;
    this.scanError = null;

    // Only blank the view when there is nothing to keep. Otherwise dim the
    // rows in place, so acting on a plugin doesn't throw the user back to the
    // top of the page with no evidence anything happened.
    const firstRun = this.results.length === 0;
    if (firstRun) {
      this.loading = true;
      this.render();
    } else {
      this.contentEl.addClass("is-busy");
    }

    const scrollTop = this.contentEl.scrollTop;
    const focusedId = this.focusedRowId();

    try {
      const { results, coverage } = await this.plugin.computeAll({ force, allowFetch });
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
      // Record what moved since the last scan, so reopening the dashboard can
      // lead with it rather than rendering an identical screen.
      await this.plugin.diffChanges(this.results.filter((r) => !r.muted));
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
      this.refreshing = false;
      this.contentEl.removeClass("is-busy");
      this.render();
      // Put the user back exactly where they were.
      if (!firstRun) {
        this.contentEl.scrollTop = scrollTop;
        this.restoreFocus(focusedId);
      }
    }
  }

  /**
   * Mute or unmute without rescanning. `muted` is pure passthrough — it changes
   * no score — so re-running the whole scorer (and possibly the network) for it
   * was pure latency on the most casual action in the product.
   */
  private async toggleMute(r: PluginHealth): Promise<void> {
    await this.plugin.toggleIgnore(r.id);
    r.muted = !r.muted;
    const s = this.summaryStats();
    this.plugin.updateStatusBar(
      s.avg,
      this.results.filter((x) => !x.muted)
    );
    const scrollTop = this.contentEl.scrollTop;
    const focusedId = this.focusedRowId();
    this.render();
    this.contentEl.scrollTop = scrollTop;
    this.restoreFocus(focusedId);
  }

  /** The plugin id of the row currently holding focus, if any. */
  private focusedRowId(): string | null {
    const active = this.contentEl.ownerDocument.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    const row = active.closest<HTMLElement>("[data-plugin-id]");
    return row?.dataset.pluginId ?? null;
  }

  /** Return focus to the row the user was on before the re-render. */
  private restoreFocus(id: string | null): void {
    if (!id) return;
    // Matched by data value rather than interpolated into a selector, so a
    // plugin id containing quotes can't break the lookup.
    const rows = this.contentEl.querySelectorAll<HTMLElement>("[data-plugin-id]");
    for (const row of Array.from(rows)) {
      if (row.dataset.pluginId === id) {
        row.focus();
        return;
      }
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
      // A finding scopes the table to exactly the rows it counted.
      if (this.scopeInsight) return this.scopeInsight.match(r);
      // Muted plugins are excluded from every count and every finding, but no
      // filter branch excluded them — so a filter could show rows the tile that
      // led there had deliberately not counted.
      if (r.muted && this.filter !== "all" && this.filter !== "muted") return false;
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
      this.sortDir = 1; // worst first, for scores as well as names
    }
    this.renderRows();
  }

  /**
   * Point the table at a cohort and take the user to it.
   *
   * Everything used to route through `render()`, which empties `contentEl` and
   * drops you back at the top of the page — so clicking a finding filtered a
   * table ~800px below the fold with no indication anything had happened.
   */
  private applyScope(scope: FilterKey | Insight): void {
    if (typeof scope === "string") {
      this.filter = scope;
      this.scopeInsight = null;
    } else {
      this.scopeInsight = scope;
      this.filter = "all";
    }
    this.search = "";
    if (this.searchInput) this.searchInput.value = "";
    if (this.filterSelect) this.filterSelect.value = this.filter;
    this.renderRows();
    this.renderScopeChip();
    this.toolbarEl?.scrollIntoView({
      block: "start",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }

  /** Show what the table is currently scoped to, with a one-click way out. */
  private renderScopeChip(): void {
    const host = this.scopeChipEl;
    if (!host) return;
    host.empty();
    const active = this.scopeInsight || this.filter !== "all" || this.search;
    if (!active) return;

    const label = this.scopeInsight
      ? this.scopeInsight.title
      : this.filter !== "all"
        ? (FILTERS.find((f) => f.key === this.filter)?.label ?? this.filter)
        : `matching “${this.search}”`;
    const chip = host.createDiv({ cls: "flowkit-scope-chip" });
    chip.createSpan({ cls: "flowkit-scope-label", text: label });
    const clear = chip.createEl("button", { text: "×" });
    clear.setAttr("aria-label", "Clear filter");
    clear.onclick = () => this.applyScope("all");
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

    this.renderChanges(root);
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
      if (this.search || this.filter !== "all" || this.scopeInsight) {
        const clear = empty.createEl("button", { text: "Clear filters" });
        clear.onclick = () => this.applyScope("all");
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
    // Say how old the data is. The cache TTL is 24h and re-download-on-open is
    // off by default, so the normal case is reading day-old numbers under a
    // green "Online" label — the one place left where the product, whose whole
    // differentiator is honest provenance, overstated itself.
    const cachedAt = this.plugin.settings.cache?.at;
    const age = cachedAt ? ` · community data from ${describeWhen(cachedAt)}` : "";
    status.setText(
      this.loading
        ? "Scoring…"
        : full
          ? `Online — all signals${age}`
          : this.coverage.stats || this.coverage.list
            ? `Online — some signals unavailable${age}`
            : "Local signals only"
    );
    status.addClass(full ? "is-online" : "is-offline");

    if (!this.loading && this.results.length > 0) {
      const exportBtn = actions.createEl("button", { cls: "flowkit-health-btn" });
      setIcon(exportBtn.createSpan(), "download");
      exportBtn.createSpan({ text: " Share" });
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
    // The guard exists to stop a confident letter appearing when the online
    // signals are missing. A pure weight threshold no longer does that: since
    // Reliability is local, offline coverage now reaches 0.70 on its own, which
    // would clear any threshold low enough to be meaningful. Require the data
    // whose absence the guard was written about.
    const graded = s.confidence > GRADE_MIN_CONFIDENCE && this.coverage.stats;
    const grade = graded
      ? gradeFor(s.avg)
      : {
          letter: "—",
          tone: "unknown" as Tone,
          verdict: "Not enough signal to grade this vault yet.",
        };
    const hero = root.createDiv({ cls: "flowkit-hero" });

    // No ring. A 116px SVG arc drew one number four different ways (arc, digits,
    // letter, sentence) and could collapse to a giant "—" when confidence was
    // low. The score stays; the ceremony around it doesn't.
    const scoreBlock = hero.createDiv({ cls: "flowkit-hero-score" });
    scoreBlock.createDiv({
      cls: `flowkit-hero-number tone-${grade.tone}`,
      text: s.avg == null ? "—" : String(s.avg),
    });
    scoreBlock.createDiv({
      cls: `flowkit-hero-grade tone-${grade.tone}`,
      text: `Grade ${grade.letter}`,
    });

    const text = hero.createDiv({ cls: "flowkit-hero-text" });
    text.createEl("h3", { text: grade.verdict });

    // The floor under the mean. An average hides the single delisted or erroring
    // plugin that is the entire reason to open this, so name the worst one.
    const worst = this.results
      .filter((r) => !r.muted && r.overall != null)
      .sort((a, b) => (a.overall ?? 100) - (b.overall ?? 100))[0];
    const parts = [`Across ${s.count} plugin${s.count === 1 ? "" : "s"}`];
    if (worst && worst.overall != null) parts.push(`worst: ${worst.name} ${worst.overall}`);
    parts.push(`${Math.round(s.confidence * 100)}% of scoring signals available`);
    const watching = this.plugin.observedMs();
    if (watching > 0) {
      const days = Math.floor(watching / 86_400_000);
      parts.push(days >= 1 ? `watching ${days} day${days === 1 ? "" : "s"}` : "watching since today");
    }
    text.createEl("p", { cls: "flowkit-hero-sub", text: parts.join(" · ") });

    if (!graded) {
      text.createEl("p", {
        cls: "flowkit-hero-hint",
        text: "Turn on online enrichment for maintenance and popularity data, and a letter grade.",
      });
    }
  }

  /**
   * What moved since the user last looked.
   *
   * This is the answer to the product's structural problem — that it was a
   * report you read once. Every other section renders the same thing on every
   * visit; this one is the only part of the screen that is new.
   */
  private renderChanges(root: HTMLElement): void {
    const unseen = this.plugin.unseenChanges();
    if (!unseen.length) return;

    const since = this.plugin.settings.lastSeenChangeAt;
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
      void this.plugin.markChangesSeen().then(() => this.render());
    };

    // Newest first, and the ones that matter before the merely informational.
    const ranked = [...unseen].sort((a, b) => {
      const weight = (k: HealthChange["kind"]): number =>
        k === "resolved" ? 2 : k === "update-published" ? 1 : 0;
      return weight(a.kind) - weight(b.kind) || b.at - a.at;
    });
    const list = box.createDiv({ cls: "flowkit-changes-list" });
    for (const change of ranked.slice(0, 3)) {
      const line = list.createDiv({
        cls: `flowkit-change is-${change.kind === "resolved" ? "good" : "bad"}`,
      });
      line.createSpan({ cls: "flowkit-change-name", text: change.name });
      line.createSpan({ cls: "flowkit-change-what", text: ` ${describeChange(change.kind)}` });
    }
    if (ranked.length > 3) {
      list.createDiv({
        cls: "flowkit-changes-more",
        text: `+${ranked.length - 3} more`,
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
    // Relabelled: it clicks through to the `attention` filter, which is broader
    // than "scores below 50" — so the tile now says what it actually shows.
    const attention = this.results.filter((r) => needsAttention(r)).length;
    this.statTile(
      summary,
      "Needs attention",
      String(attention),
      attention > 0 ? "bad" : "good",
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
    // Label first: as a one-line pill it reads "Updates 3", not "3 Updates".
    tile.createSpan({ cls: "flowkit-stat-label", text: label });
    tile.createSpan({ cls: `flowkit-stat-value tone-${tone}`, text: value });
    tile.onclick = () => this.applyScope(filter);
  }

  // --- insights -------------------------------------------------------------

  private renderInsights(root: HTMLElement): void {
    const insights = buildInsights(this.results);
    const section = root.createDiv({ cls: "flowkit-insights" });

    const head = section.createDiv({ cls: "flowkit-section-head" });
    setIcon(head.createSpan({ cls: "flowkit-section-icon" }), "lightbulb");
    head.createSpan({ cls: "flowkit-section-title", text: "What to fix" });

    // When nothing is wrong, state the negative results. A diagnosis that finds
    // nothing used to render as four green words, so the user never saw the
    // work that was done — and this is the state most vaults are in most of the
    // time, which made it the least designed screen in the product.
    if (insights.length === 1 && insights[0].id === "healthy") {
      this.renderAllClear(section);
      return;
    }

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

  /** The good case, stated as the checks that passed rather than as an absence. */
  private renderAllClear(section: HTMLElement): void {
    const live = this.results.filter((r) => !r.muted);
    const card = section.createDiv({ cls: "flowkit-allclear" });
    const head = card.createDiv({ cls: "flowkit-allclear-head" });
    setIcon(head.createSpan({ cls: "flowkit-allclear-icon" }), "check-circle");
    head.createSpan({
      cls: "flowkit-allclear-title",
      text: `Checked ${live.length} plugin${live.length === 1 ? "" : "s"}. Nothing needs your attention.`,
    });

    const watched = this.plugin.observedMs();
    const errors = totalUncaught(this.plugin.settings.errorLog);
    const checks = [
      `${live.filter((r) => r.listing === "delisted").length} pulled from the community directory`,
      `${live.filter((r) => isIncompatible(r)).length} incompatible with Obsidian ${apiVersion}`,
      watched > 0
        ? `${errors} errors traced to a plugin in ${Math.max(1, Math.floor(watched / 86_400_000))} day${Math.floor(watched / 86_400_000) === 1 ? "" : "s"} of watching`
        : "error watching is off",
      `${live.filter((r) => r.maintenanceStatus === "unmaintained").length} without a release in 18 months`,
    ];
    const list = card.createEl("ul", { cls: "flowkit-allclear-list" });
    for (const c of checks) list.createEl("li", { text: c });
  }

  private renderInsightCard(parent: HTMLElement, ins: Insight, pro: boolean): void {
    const card = parent.createDiv({ cls: `flowkit-insight tone-${ins.tone}` });
    setIcon(card.createSpan({ cls: "flowkit-insight-icon" }), ins.icon);
    const body = card.createDiv({ cls: "flowkit-insight-body" });
    body.createDiv({ cls: "flowkit-insight-title", text: ins.title });
    body.createDiv({ cls: "flowkit-insight-detail", text: ins.detail });

    // An insight that names plugins should be able to show you exactly them —
    // scoped by the same predicate the count was built from.
    if (ins.ids.length) {
      card.addClass("is-clickable");
      card.setAttr("tabindex", "0");
      card.setAttr("role", "button");
      card.setAttr(
        "aria-label",
        `${ins.title} — show these ${ins.ids.length} plugin${ins.ids.length === 1 ? "" : "s"}`
      );
      const go = () => this.applyScope(ins);
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

  /**
   * A paste-ready bug report for one plugin.
   *
   * The user was going to file that issue anyway, badly, from memory. Every
   * field here is something FlowKit already holds, and the report carries a
   * footer to exactly the audience worth reaching — plugin authors and the
   * power users reading their issue trackers.
   */
  private async copyBugReport(r: PluginHealth): Promise<void> {
    const lines: string[] = [];
    lines.push(`**${r.name}** v${r.version}`);
    if (r.latestVersion && r.latestVersion !== r.version) {
      lines.push(`Latest published: v${r.latestVersion}`);
    }
    lines.push(`Obsidian ${apiVersion} · ${Platform.isMobile ? "mobile" : "desktop"}`);
    lines.push("");

    const rec = r.errors;
    if (rec?.signatures.length) {
      const watched = Math.max(1, Math.round(this.plugin.observedMs() / 86_400_000));
      lines.push(
        `${rec.uncaught} unhandled error${rec.uncaught === 1 ? "" : "s"} recorded over ${watched} day${watched === 1 ? "" : "s"}:`
      );
      lines.push("");
      for (const sig of [...rec.signatures].sort((a, b) => b.lastAt - a.lastAt).slice(0, 5)) {
        lines.push(`- \`${sig.message}\` — seen ${sig.count}×, last ${describeWhen(sig.lastAt)}`);
        // The stack is the Pro line: it is the part an author can act on.
        if (this.plugin.isPro && sig.stack) {
          lines.push("");
          lines.push("```");
          lines.push(sig.stack);
          lines.push("```");
        }
      }
      if (!this.plugin.isPro) {
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
      new Notice("Bug report copied — paste it into an issue.");
    } catch (err) {
      console.error("FlowKit: clipboard write failed", err);
      new Notice("Couldn't copy to the clipboard — see the console.");
    }
  }

  /** A short vault summary that fits in a chat message. */
  private async copySummary(): Promise<void> {
    const s = this.summaryStats();
    const grade = gradeFor(s.avg);
    const insights = buildInsights(this.results);
    const lines = [
      `${PRODUCT_NAME}: vault health ${s.avg ?? "—"}/100 (Grade ${grade.letter}) across ${s.count} plugins.`,
    ];
    for (const ins of insights.slice(0, 3)) lines.push(`• ${ins.title}`);
    const watching = this.plugin.observedMs();
    if (watching > 0) {
      lines.push(`Watching for plugin errors for ${Math.max(1, Math.floor(watching / 86_400_000))} days.`);
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      new Notice("Summary copied.");
    } catch (err) {
      console.error("FlowKit: clipboard write failed", err);
      new Notice("Couldn't copy to the clipboard — see the console.");
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
    await this.refresh(false, false);
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
    await this.refresh(false, false);
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
    this.toolbarEl = bar;

    const searchWrap = bar.createDiv({ cls: "flowkit-search" });
    setIcon(searchWrap.createSpan({ cls: "flowkit-search-icon" }), "search");
    const input = searchWrap.createEl("input", {
      type: "text",
      placeholder: "Search plugins…",
    });
    input.value = this.search;
    this.searchInput = input;
    // The input element survives now, so there is no refocus-and-jump-the-caret
    // hack. Typing in the middle of a query stays put, and IME composition is
    // no longer torn down mid-word.
    input.oninput = () => {
      this.search = input.value;
      // Typing is its own scope; drop any finding scope so the two can't fight.
      this.scopeInsight = null;
      this.renderRows();
      this.renderScopeChip();
    };

    const select = bar.createEl("select", { cls: "flowkit-filter dropdown" });
    for (const f of FILTERS) {
      const opt = select.createEl("option", { value: f.key, text: f.label });
      if (f.key === this.filter) opt.selected = true;
    }
    this.filterSelect = select;
    select.onchange = () => this.applyScope(select.value as FilterKey);

    this.countEl = bar.createSpan({ cls: "flowkit-result-count" });
    this.scopeChipEl = bar.createDiv({ cls: "flowkit-scope-host" });
    this.renderScopeChip();
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
      void this.plugin.setPluginEnabled(r.id, !r.enabled).then(() => this.refresh(false, false));
    };
    if (r.enabled) {
      const settings = actions.createEl("button", { text: "Open its settings" });
      settings.onclick = () => this.plugin.openPluginSettings(r.id);
    }
    if (r.repo) {
      const gh = actions.createEl("button", { text: "Open on GitHub" });
      gh.onclick = () => window.open(`https://github.com/${r.repo}`, "_blank");
    }
    if (r.errors?.signatures.length) {
      const report = actions.createEl("button", { cls: "mod-cta", text: "Copy bug report" });
      report.onclick = () => void this.copyBugReport(r);
    }
    const mute = actions.createEl("button", {
      text: r.muted ? "Unmute" : "Mute from counts",
    });
    mute.onclick = () => {
      void this.toggleMute(r);
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
    tr.dataset.pluginId = r.id;
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
          await this.refresh(false, false);
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

    if (r.errors?.signatures.length) {
      menu.addItem((item) =>
        item
          .setTitle("Copy bug report")
          .setIcon("clipboard-list")
          .onClick(() => void this.copyBugReport(r))
      );
    }

    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(r.muted ? "Unmute plugin" : "Mute from counts")
        .setIcon(r.muted ? "bell" : "bell-off")
        .onClick(() => void this.toggleMute(r))
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
          await this.refresh(false, false);
          return true;
        }
        return this.plugin.isPro;
      },
    }).open();
  }

  private onExportClick(evt: MouseEvent): void {
    const menu = new Menu();
    // Copy is always free and unlimited. Never ration the thing that carries
    // your name outward.
    menu.addItem((item) =>
      item
        .setTitle("Copy summary")
        .setIcon("clipboard-copy")
        .onClick(() => void this.copySummary())
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Export Markdown report")
        .setIcon("file-text")
        .onClick(() => void this.exportReport("md"))
    );
    menu.addItem((item) =>
      item
        .setTitle(this.plugin.isPro ? "Export CSV" : "Export CSV (Pro)")
        .setIcon("table")
        .onClick(() => {
          if (!this.plugin.isPro) {
            this.openUpgrade("export");
            return;
          }
          void this.exportReport("csv");
        })
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

/** Plain-English wording for one recorded transition. */
function describeChange(kind: HealthChange["kind"]): string {
  switch (kind) {
    case "error-started":
      return "started throwing errors";
    case "delisted":
      return "was removed from the community directory";
    case "became-incompatible":
      return "stopped being compatible with your Obsidian";
    case "update-published":
      return "published an update";
    default:
      return "is back to normal";
  }
}

/** A short, relative-ish description of a past timestamp for the trend delta. */
function describeWhen(at: number): string {
  const hours = (Date.now() - at) / 3_600_000;
  if (hours < 1) return "just now";
  if (hours < 24) return `${Math.round(hours)} hours ago`;
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days <= 0) return "earlier today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(at).toLocaleDateString();
}
