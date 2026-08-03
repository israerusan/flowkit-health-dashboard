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
import type { LifecycleFailure, ScanPhase } from "./main";
import {
  buildInsights,
  isAtRisk,
  isIncompatible,
  needsAttention,
  type BulkAction,
  type Insight,
} from "./insights";
import { WEIGHTS } from "./scoring";
import { clearCooldown } from "./dataSources";
import { totalUncaught } from "./errors";
import { conflictsFor, describeConflict, type Conflict } from "./conflicts";
import { describeMute } from "./mutes";
import {
  currentLoadMs,
  formatBytes,
  formatPeriod,
  pollPenalty,
  startupCost,
} from "./runtime";
import { rankSafeDisable } from "./triage";
import {
  describeRound,
  remainingText,
  roundsNeeded,
  searchableCandidates,
} from "./bisect";
import { describeEvent, describeGap } from "./timeline";
import { AUTO_SNAPSHOT, isNoop, type PluginProfile } from "./profiles";
import { findKnownIssues, redactUserContent } from "./issueSearch";
import { BulkConfirmModal } from "./ui/BulkConfirmModal";
import { BisectStartModal } from "./ui/BisectModal";
import { MuteModal } from "./ui/MuteModal";
import { SaveProfileModal } from "./ui/ProfileModal";
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
  | "heavy"
  | "watched"
  | "disabled"
  | "muted";

const METRIC_COLUMNS: Array<{ key: MetricKey; label: string; hint: string }> = [
  {
    key: "compatibility",
    label: "Compatibility",
    hint: "Whether it can run on your Obsidian, on this device. Weighted 25%.",
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
    hint: "What it costs to run: code loaded at startup, measured load time, and any fast repeating timer. Weighted 15%.",
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
  { key: "heavy", label: "Heaviest to run" },
  { key: "watched", label: "Watching" },
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
  active: {
    label: "Active",
    tone: "good",
    hint: "No recent release, but its repository was pushed to in the last 6 months — being worked on, just not tagged.",
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

/**
 * How long typing is allowed to run ahead of the table.
 *
 * Short enough that the list still feels live, long enough that a burst of
 * keystrokes is one rebuild rather than six.
 */
const SEARCH_DEBOUNCE_MS = 90;

/**
 * Leading characters that make a spreadsheet read a CSV cell as a formula.
 *
 * Every value in the exported CSV is a plugin manifest field, which is
 * attacker-controlled for anyone who sideloads — and `showDisabled` defaults
 * on, so a plugin that has never been enabled, and whose code has therefore
 * never run in the renderer, still reaches that file.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** What is shown where a grade would be when there isn't the signal for one. */
const GRADE_WITHHELD: { letter: string; tone: Tone; verdict: string } = {
  letter: "—",
  tone: "unknown",
  verdict: "Not enough signal to grade this vault yet.",
};

export class HealthDashboardView extends ItemView {
  private plugin: FlowKitHealthPlugin;
  private results: PluginHealth[] = [];
  private coverage: DataCoverage = { stats: false, list: false, disabled: false };
  private loading = false;
  /** Set when a scan threw, so the view offers a way out instead of a dead spinner. */
  private scanError: string | null = null;
  /** In-flight guard: two concurrent scans would race results and double-write. */
  private refreshing = false;
  /** A scan requested while one was in flight, to be run once it finishes. */
  private pendingRefresh = false;
  /**
   * What that queued scan is allowed to do.
   *
   * Kept as two independent flags, because they are two independent questions:
   * `force` means ignore the cache, `allowFetch` means the network may be
   * touched at all. The queued scan used to be hardcoded to `refresh(false,
   * false)`, so pressing Retry on a failed download while any other scan was
   * running silently downgraded it to a local rescan — the one request in the
   * product that exists specifically to go back online.
   */
  private pendingForce = false;
  private pendingAllowFetch = false;
  /** The results region, rebuilt on its own when search/filter/sort change. */
  private rowsEl: HTMLElement | null = null;
  /** Live "N of M" readout in the toolbar. */
  private countEl: HTMLElement | null = null;
  /** The row whose reasoning panel is open, if any. */
  private expandedId: string | null = null;
  /** The last bulk action, so it can be undone for the rest of the session. */
  private lastBulk: { label: string; revert: () => Promise<void> } | null = null;
  /** Plugins competing for the same shortcut or command name, read per scan. */
  private conflicts: Conflict[] = [];
  /** Mutes that lapsed since the last render, shown once. */
  private lapsedMutes: string[] = [];

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
  /** The pending debounced search rebuild, owned by the view so it can be killed. */
  private searchTimer: number | null = null;
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
    // Re-score whenever this tab is brought back into view and what it is
    // showing has gone stale.
    //
    // Obsidian restores open tabs, so on a cold start this view's first scan
    // runs seconds after launch — before any plugin has polled, thrown, or done
    // anything the runtime signals measure. Without this, a dashboard that was
    // left open faithfully reports a vault with no timers and no errors for as
    // long as it stays open, and the only other pass runs every six hours.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf !== this.leaf) return;
        if (!this.plugin.scanIsStale()) return;
        void this.refresh(false, false);
      })
    );
    await this.refresh(this.plugin.settings.autoRefreshOnOpen);
  }

  /**
   * An explicit Retry overrides the rate-limit backoff — the user is telling us
   * to try now, and they can see the result themselves.
   */
  private forceRetry(): void {
    clearCooldown();
    void this.refresh(true);
  }

  private cancelSearchFlush(): void {
    if (this.searchTimer == null) return;
    window.clearTimeout(this.searchTimer);
    this.searchTimer = null;
  }

  async onClose(): Promise<void> {
    this.cancelSearchFlush();
  }

  /** Re-render from the results already in hand, without rescanning. */
  rerender(): void {
    this.render();
  }

  /**
   * Run a click handler's async work so that a failure reaches the user.
   *
   * Every one of these paths can genuinely fail — a read-only or synced
   * `data.json` rejects the write, and the plugin lifecycle calls throw when
   * Obsidian's internals are missing or the registry doesn't settle. They were
   * written as `void promise.then(...)`, which means the failure took the
   * `then` with it: the button appeared to do nothing, no message was shown,
   * nothing was written to the console, and the rejection escaped as an
   * unhandled one — inside the plugin whose job is to notice exactly that
   * happening to somebody else.
   *
   * `saveQuietly` in main.ts already established the rule for background work.
   * This is the same rule for work a user asked for, where saying nothing is
   * the worse half of the failure.
   */
  private act(work: Promise<unknown>, failure: string): void {
    void work.catch((err) => {
      console.error("FlowKit: action failed —", failure, err);
      new Notice(`${failure} — see the console for details.`, 8000);
    });
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
    // same snapshot. Queue it rather than dropping it: an action taken during
    // an in-flight scan (disable a plugin while Refresh is running) would
    // otherwise complete for real and then render pre-action state.
    if (this.refreshing) {
      this.pendingRefresh = true;
      this.pendingForce ||= force;
      this.pendingAllowFetch ||= allowFetch;
      return;
    }
    this.refreshing = true;

    const firstRun = this.results.length === 0;
    let scrollTop = 0;
    let focusedId: string | null = null;

    try {
      this.scanError = null;
      // Only blank the view when there is nothing to keep. Otherwise dim the
      // rows in place, so acting on a plugin doesn't throw the user back to the
      // top of the page with no evidence anything happened.
      if (firstRun) {
        this.loading = true;
        this.render();
      } else {
        this.contentEl.addClass("is-busy");
      }
      scrollTop = this.contentEl.scrollTop;
      focusedId = this.focusedRowId();

      const { results, coverage } = await this.plugin.computeAll({
        force,
        allowFetch,
        // Only worth wiring up on the run that actually shows a loading screen.
        // Every other scan repaints in place and never renders this.
        onPhase: firstRun ? (p) => this.showPhase(p) : undefined,
      });
      this.results = results;
      this.coverage = coverage;
      // Read fresh each scan: hotkeys change the moment the user rebinds one,
      // and a stale conflict list is worse than no conflict list.
      this.conflicts = this.plugin.detectConflicts();
      this.invalidateDerived();
      this.indexRows();
      const lapsed = this.plugin.takeLapsedMutes();
      if (lapsed.length) this.lapsedMutes = lapsed;
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
      // The whole result set, including muted plugins: their state is preserved
      // so unmuting later doesn't re-announce old trouble as new.
      await this.plugin.diffChanges(this.results, coverage);
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
      // The scoped finding is a snapshot of the previous scan — its title and
      // count are already stale. Re-resolve it, and drop it if the cohort it
      // named no longer exists, so the chip can't assert a count the table
      // below it contradicts.
      if (this.scopeInsight) {
        const id = this.scopeInsight.id;
        this.scopeInsight = this.insights().find((i) => i.id === id) ?? null;
      }
      this.render();
      // Put the user back exactly where they were.
      if (!firstRun) {
        this.contentEl.scrollTop = scrollTop;
        this.restoreFocus(focusedId);
      }
      if (this.pendingRefresh) {
        // Cleared before the follow-up starts, so a request arriving during it
        // is queued again rather than swallowed by this one.
        this.pendingRefresh = false;
        const queuedForce = this.pendingForce;
        const queuedFetch = this.pendingAllowFetch;
        this.pendingForce = false;
        this.pendingAllowFetch = false;
        await this.refresh(queuedForce, queuedFetch);
      }
    }
  }

  /**
   * Mute or unmute without rescanning. `muted` is pure passthrough — it changes
   * no score — so re-running the whole scorer (and possibly the network) for it
   * was pure latency on the most casual action in the product.
   */
  private async toggleMute(r: PluginHealth): Promise<void> {
    if (r.muted) {
      await this.plugin.unmute(r.id);
      r.muted = false;
      r.mute = undefined;
      this.afterMuteChange();
      return;
    }
    // Muting asks for a span and a reason. A one-click permanent mute is a way
    // to make a real problem invisible forever, and the old menu item offered
    // nothing else — so a decision taken in a hurry outlived its reason with
    // nothing recorded about what the reason had been.
    new MuteModal(this.app, {
      pluginName: r.name,
      appVersion: apiVersion,
      onConfirm: (kind, reason) => {
        this.act(
          this.plugin.mute(r.id, kind, reason).then(() => {
            r.muted = true;
            r.mute = this.plugin.muteOf(r.id);
            this.afterMuteChange();
          }),
          `Couldn't mute ${r.name}`
        );
      },
    }).open();
  }

  /** Repaint after a mute change, without rescanning — it changes no score. */
  private afterMuteChange(): void {
    // It changes no score, but it changes every count and every finding: muted
    // rows are excluded from both.
    this.invalidateDerived();
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
      if (row.dataset.pluginId !== id) continue;
      // The `tr` carries the id but isn't focusable — focus() on it is a no-op.
      // The row's disclosure control is the plugin name button.
      const target = row.querySelector<HTMLElement>("button.flowkit-plugin-name");
      target?.focus();
      return;
    }
  }

  // --- data shaping ---------------------------------------------------------

  /**
   * The findings, built from this scan plus the vault-level evidence that isn't
   * a property of any single plugin.
   */
  private insights(): Insight[] {
    const cached = this.derived.insights;
    if (cached) return cached;
    const built = buildInsights(this.results, { conflicts: this.conflicts });
    this.derived.insights = built;
    return built;
  }

  /**
   * Everything derived from the current results, computed once.
   *
   * A single render used to walk the whole result set a dozen times: the hero,
   * the tiles, the status-bar update and both export paths each rebuilt the
   * same summary, and the findings were rebuilt twice more.
   *
   * Deliberately NOT keyed on "a scan happened". Mute and watch toggle the row
   * objects in place without rescanning — that is the whole reason those
   * actions feel instant — so a scan-generation key would serve a stale hero
   * count and a stale findings list after the two most common actions in the
   * product. Everything that can change a derived value calls `invalidate()`.
   */
  private derived: { stats?: SummaryStats; insights?: Insight[] } = {};

  private invalidateDerived(): void {
    this.derived = {};
  }

  private summaryStats(): SummaryStats {
    const cached = this.derived.stats;
    if (cached) return cached;
    const stats = this.computeSummaryStats();
    this.derived.stats = stats;
    return stats;
  }

  private computeSummaryStats(): SummaryStats {
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

  /**
   * Per-scan indexes for the things the render path asks for row by row.
   *
   * The search haystack was rebuilt and lowercased for every plugin on every
   * keystroke, and the conflict list was scanned linearly once per row per
   * render. Neither changes between scans.
   */
  private haystacks = new Map<string, string>();
  private clashCounts = new Map<string, number>();

  private indexRows(): void {
    this.haystacks.clear();
    this.clashCounts.clear();
    for (const r of this.results) {
      this.haystacks.set(r.id, `${r.name} ${r.author} ${r.id}`.toLowerCase());
      this.clashCounts.set(r.id, conflictsFor(this.conflicts, r.id).length);
    }
  }

  private visibleRows(): PluginHealth[] {
    const q = this.search.trim().toLowerCase();
    const filtered = this.results.filter((r) => {
      if (q) {
        const hay = this.haystacks.get(r.id) ?? `${r.name} ${r.author} ${r.id}`.toLowerCase();
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
        case "heavy":
          // The triage view: only things actually running can be slowing you
          // down, and a disabled plugin scores 100 here by definition.
          return r.enabled;
        case "watched":
          return r.watched;
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
      // "Heaviest to run" is a question, not a cohort — it only answers it if
      // the table is actually ordered by cost when you get there.
      if (scope === "heavy") {
        this.sortKey = "footprint";
        this.sortDir = 1;
      }
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
      this.renderLoading(root);
      return;
    }

    // A failed scan is a banner when there is a previous report to keep, and
    // only takes the page when there is nothing behind it.
    //
    // It used to replace the dashboard unconditionally. So a rejected write on
    // a synced vault — the commonest way this fails, and one that has nothing
    // to do with the scores — threw away a complete, still-accurate diagnosis
    // the user was reading, and replaced it with a retry button. The last good
    // answer is the most useful thing on screen at the moment something goes
    // wrong; the header already says when it was taken.
    if (this.scanError) {
      const card = root.createDiv({ cls: "flowkit-health-error" });
      card.setAttr("role", "alert");
      setIcon(card.createSpan({ cls: "flowkit-error-icon" }), "alert-triangle");
      const body = card.createDiv();
      const stale = this.results.length > 0;
      body.createEl("strong", {
        text: stale ? "That refresh didn't finish." : "The scan didn't finish.",
      });
      body.createDiv({ cls: "flowkit-error-detail", text: this.scanError });
      if (stale) {
        body.createDiv({
          cls: "flowkit-error-detail",
          text: "Everything below is the last scan that did — see the header for when that was.",
        });
      }
      const retry = card.createEl("button", { cls: "mod-cta", text: "Try again" });
      retry.onclick = () => this.forceRetry();
      if (!stale) return;
    }

    if (this.results.length === 0) {
      this.renderNothingToScore(root);
      return;
    }

    // A running bisect owns the page — and now actually does, rather than
    // saying so in a comment above a function that rendered the whole dashboard
    // underneath it anyway. Every number below is measured against a vault that
    // is, right now, deliberately half switched off: that is not the user's
    // setup, and presenting it as a health report is the one thing this product
    // is supposed not to do.
    //
    // Scoped to a round in progress, not to the session existing. Once the
    // search is finished the vault is real again, and the user needs the
    // evidence — the culprit's row, its errors, its history — to decide whether
    // to leave it off.
    // …and it keeps owning the page when the search is over but the vault has
    // not actually been put back. That path sets `bisectError` and leaves the
    // session on disk on purpose; rendering the full report over it would show
    // a health score for a vault that is still missing plugins FlowKit has just
    // said it could not restore, and bury the buttons that retry.
    if (this.plugin.bisectOwnsPage()) {
      this.renderUnreadable(root);
      this.renderBisect(root);
      this.renderSalvage(root);
      return;
    }
    this.renderSalvage(root);
    this.renderUnreadable(root);
    this.renderBisect(root);
    this.renderAppUpdate(root);
    this.renderChanges(root);
    this.renderCorrelations(root);
    this.renderLapsedMutes(root);
    this.renderIntro(root);
    this.renderHero(root);
    this.renderCoverageNotice(root);
    this.renderUndoBar(root);
    // The to-do list, then the evidence. It used to sit below four stat tiles
    // and a trend chart, which is a spreadsheet-first ordering for a product
    // whose entire value is the ranked list of what to do — and on a phone it
    // put the answer a full screen below the question.
    this.renderInsights(root);
    this.renderSummary(root);
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

  /**
   * The first scan, with the shape of the answer already on screen.
   *
   * A centred spinner over a blank page gives the user nothing to judge
   * progress by, so on a large vault a scan that is working looks identical to
   * one that has hung. The skeleton says how many rows are coming, and the line
   * underneath says what is actually happening — reported by the scan itself,
   * so it can't describe a stage that isn't running.
   */
  private renderLoading(root: HTMLElement): void {
    const box = root.createDiv({ cls: "flowkit-loading" });
    const head = box.createDiv({ cls: "flowkit-loading-head" });
    setIcon(head.createSpan({ cls: "flowkit-spin" }), "loader-2");
    this.phaseEl = head.createSpan({
      cls: "flowkit-loading-label",
      text: this.phase?.label ?? "Reading your plugin list…",
    });
    // The phase text is rewritten in place as the scan moves, which is a change
    // only a sighted user was told about. On a large vault the download stage
    // alone can hold this screen for several seconds, so silence here is
    // indistinguishable from a plugin that has hung.
    this.phaseEl.setAttr("role", "status");
    this.phaseEl.setAttr("aria-live", "polite");
    this.phaseBarEl = box.createDiv({ cls: "flowkit-loading-bar" });
    this.phaseFillEl = this.phaseBarEl.createDiv({ cls: "flowkit-loading-fill" });
    this.paintPhase();

    const skeleton = box.createDiv({ cls: "flowkit-skeleton" });
    // Sized from what is installed, so the page doesn't reflow into something a
    // different height the moment real rows arrive.
    const rows = Math.min(
      8,
      Math.max(3, Object.keys(this.plugin.installedManifests()).length)
    );
    for (let i = 0; i < rows; i++) {
      const line = skeleton.createDiv({ cls: "flowkit-skeleton-row" });
      line.createDiv({ cls: "flowkit-skeleton-name" });
      for (let c = 0; c < 4; c++) line.createDiv({ cls: "flowkit-skeleton-chip" });
    }
  }

  private phase: ScanPhase | null = null;
  private phaseEl: HTMLElement | null = null;
  private phaseBarEl: HTMLElement | null = null;
  private phaseFillEl: HTMLElement | null = null;

  private showPhase(phase: ScanPhase): void {
    this.phase = phase;
    if (!this.phaseEl) return;
    this.phaseEl.setText(phase.label);
    this.paintPhase();
  }

  private paintPhase(): void {
    const p = this.phase;
    const bar = this.phaseBarEl;
    const fill = this.phaseFillEl;
    if (!bar || !fill) return;
    // Only claim a proportion when there is one. An indeterminate stage gets a
    // sweeping bar rather than a made-up percentage.
    if (p?.total && p.total > 0 && p.done != null) {
      bar.removeClass("is-indeterminate");
      fill.setCssProps({ "--flowkit-progress": `${Math.round((p.done / p.total) * 100)}%` });
      return;
    }
    bar.addClass("is-indeterminate");
    fill.setCssProps({ "--flowkit-progress": "0%" });
  }

  /**
   * Nothing to score — which is three different situations, and telling them
   * apart is the difference between an answer and a dead end.
   */
  private renderNothingToScore(root: HTMLElement): void {
    const installed = Object.keys(this.plugin.installedManifests()).length;
    const box = root.createDiv({ cls: "flowkit-blank" });
    setIcon(box.createSpan({ cls: "flowkit-blank-icon" }), installed ? "eye-off" : "plug");
    if (installed > 0) {
      box.createDiv({
        cls: "flowkit-blank-title",
        text: `All ${installed} of your plugins are switched off.`,
      });
      box.createDiv({
        cls: "flowkit-blank-body",
        text: "FlowKit is only showing enabled plugins. Turn on “Show disabled plugins” to score them too.",
      });
      const btn = box.createEl("button", { cls: "mod-cta", text: "Show disabled plugins" });
      btn.onclick = () => {
        this.plugin.settings.showDisabled = true;
        this.act(
          this.plugin.saveSettings().then(() => this.refresh(false, false)),
          "Couldn't save that setting"
        );
      };
      return;
    }
    box.createDiv({
      cls: "flowkit-blank-title",
      text: "No community plugins installed.",
    });
    box.createDiv({
      cls: "flowkit-blank-body",
      text: "There is nothing to score yet — which is its own kind of clean bill of health. FlowKit starts reporting as soon as you install something.",
    });
  }

  /** Rebuild only the results region. Cheap enough to run on every keystroke. */
  private renderRows(): void {
    const host = this.rowsEl;
    if (!host) return;
    host.empty();

    const rows = this.visibleRows();
    // An open panel whose row is no longer in the table stops being an open
    // panel. Keeping the id meant the selection survived invisibly and the row
    // sprang open again by itself when a filter was cleared, a search was
    // deleted, or an uninstalled plugin came back — a disclosure the user never
    // asked for a second time.
    if (this.expandedId && !rows.some((r) => r.id === this.expandedId)) {
      this.expandedId = null;
    }
    if (this.countEl) {
      this.countEl.setText(
        rows.length === this.results.length
          ? `${rows.length} plugin${rows.length === 1 ? "" : "s"}`
          : `${rows.length} of ${this.results.length}`
      );
    }

    if (rows.length === 0) {
      // Say which of the three things produced nothing, because the way out is
      // different for each: a filter with no members is good news, a search
      // with no hits is a typo, and both used to render the same sentence.
      const empty = host.createDiv({ cls: "flowkit-blank" });
      setIcon(empty.createSpan({ cls: "flowkit-blank-icon" }), this.search ? "search-x" : "check-circle");
      if (this.search) {
        empty.createDiv({
          cls: "flowkit-blank-title",
          text: `Nothing matches “${this.search}”.`,
        });
        empty.createDiv({
          cls: "flowkit-blank-body",
          text: "FlowKit searches plugin names, authors and ids.",
        });
      } else {
        const label = this.scopeInsight
          ? this.scopeInsight.title
          : (FILTERS.find((f) => f.key === this.filter)?.label ?? this.filter);
        empty.createDiv({
          cls: "flowkit-blank-title",
          text: `No plugins are in “${label}”.`,
        });
        empty.createDiv({
          cls: "flowkit-blank-body",
          text: "Nothing to do here — that is the good outcome for this one.",
        });
      }
      if (this.search || this.filter !== "all" || this.scopeInsight) {
        const clear = empty.createEl("button", { text: "Show all plugins" });
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
    //
    // Dated by the OLDER of the two feeds, not by the last time either of them
    // answered. They fail and merge independently, so a run of stats-only
    // successes kept refreshing one shared timestamp while the community list
    // — where delisting, repository links and sideload detection come from —
    // aged silently underneath it. The honest headline age is the age of the
    // stalest thing being shown.
    const cache = this.plugin.settings.cache;
    const feedAges = [cache?.statsAt, cache?.listAt].filter(
      (v): v is number => typeof v === "number"
    );
    const cachedAt = feedAges.length ? Math.min(...feedAges) : cache?.at;
    const age = cachedAt ? ` · community data from ${describeWhen(cachedAt)}` : "";
    // Two different ages, and they are genuinely different: the scan is local
    // and current, the community data behind it may be a day old. Saying only
    // one of them is how a fresh-looking page ends up quoting stale numbers.
    const scannedAt = this.plugin.settings.lastScanAt;
    const scanned = scannedAt ? `Scanned ${describeWhen(scannedAt)}` : "Scanned just now";
    status.setText(
      this.loading
        ? "Scoring…"
        : full
          ? `${scanned} · all signals${age}`
          : this.coverage.stats || this.coverage.list
            ? `${scanned} · some signals unavailable${age}`
            : `${scanned} · local signals only`
    );
    status.addClass(full ? "is-online" : "is-offline");

    if (!this.loading && this.results.length > 0) {
      const exportBtn = actions.createEl("button", { cls: "flowkit-health-btn" });
      setIcon(exportBtn.createSpan(), "download");
      // "Share" reads as social. Everything behind this button writes a file or
      // fills the clipboard.
      exportBtn.createSpan({ text: " Export" });
      // No padlock here. It used to appear for a free user who had exported
      // once, and it gated nothing: the Markdown report is free and unlimited
      // by design — it is the diagnosis, and the diagnosis is what stays free.
      // A lock on a door that isn't locked is worse than either a real gate or
      // no gate at all, because the reader stops believing the other locks.
      exportBtn.onclick = (evt) => this.onExportClick(evt);
    }

    // No standing upsell button here any more. It counted plugins a bulk fix
    // could change, and bulk fixes are free — so it advertised something the
    // reader already had. The upgrade path now runs through the capability the
    // user actually reached for, which is the only context that earns the ask.

    // The diagnostic entry point. It leads with bisect deliberately: that is
    // the thing somebody with a broken vault came here to do, and burying it in
    // a row menu would hide the only feature nothing else in the ecosystem has.
    // The diagnostic entry point carries the accent, because it is the one
    // thing here nothing else in the ecosystem does — and it used to sit in the
    // same flat grey as Refresh, which is a row of four equal buttons and no
    // answer to "where do I start".
    if (!this.loading && this.results.length > 0) {
      const tools = actions.createEl("button", {
        cls: "flowkit-health-btn flowkit-tools-btn mod-cta",
      });
      setIcon(tools.createSpan(), "stethoscope");
      tools.createSpan({ text: " Diagnose" });
      tools.setAttr("aria-label", "Find what's breaking your vault, profile startup, or switch plugin sets");
      tools.onclick = (evt) => this.openToolsMenu(evt);
    }

    const refreshBtn = actions.createEl("button", { cls: "flowkit-health-btn" });
    setIcon(refreshBtn.createSpan(), "refresh-cw");
    refreshBtn.createSpan({ text: " Refresh" });
    refreshBtn.disabled = this.loading;
    refreshBtn.onclick = () => void this.refresh(true);
  }

  private openToolsMenu(evt: MouseEvent): void {
    const menu = new Menu();

    menu.addItem((item) =>
      item
        .setTitle(
          this.plugin.isPro
            ? "Find what's breaking my vault…"
            : "Find what's breaking my vault… (Pro)"
        )
        .setIcon("search-check")
        .onClick(() => this.startBisect())
    );

    menu.addItem((item) =>
      item
        .setTitle(this.plugin.isPro ? "Profile startup…" : "Profile startup… (Pro)")
        .setIcon("timer")
        .onClick(() => this.startProfileAll(this.profilableIds()))
    );

    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(this.plugin.isPro ? "Save this plugin set…" : "Save this plugin set… (Pro)")
        .setIcon("bookmark")
        .onClick(() => this.saveProfile())
    );

    const profiles = this.plugin.settings.profiles;
    for (const profile of profiles) {
      menu.addItem((item) =>
        item
          .setTitle(`Switch to “${profile.name}”`)
          .setIcon("layers")
          .onClick(() => this.applyProfile(profile))
      );
    }

    menu.showAtMouseEvent(evt);
  }

  /**
   * Whether this scan has the signal behind it to put a letter on.
   *
   * One decision, in one place, because there are four surfaces that print a
   * grade — the hero, Copy summary, the Markdown report and the CSV — and three
   * of them used to compute one unconditionally. The screen would say "not
   * enough signal to grade this vault" while the report the user pasted into
   * someone else's issue tracker confidently said "Grade B".
   *
   * The guard is not a pure weight threshold: Reliability is local, so offline
   * coverage reaches 0.70 on its own and would clear any threshold low enough
   * to be meaningful. Require the data whose absence it was written about.
   */
  private canGrade(s: SummaryStats): boolean {
    return s.confidence > GRADE_MIN_CONFIDENCE && this.coverage.stats;
  }

  /** The grade for this scan, or the withheld one. */
  private gradeNow(s: SummaryStats): { letter: string; tone: Tone; verdict: string } {
    return this.canGrade(s) ? gradeFor(s.avg) : GRADE_WITHHELD;
  }

  private renderHero(root: HTMLElement): void {
    const s = this.summaryStats();
    const graded = this.canGrade(s);
    const grade = this.gradeNow(s);
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
    if (watching > 0) parts.push(`watching ${describeWatched(watching)}`);
    text.createEl("p", { cls: "flowkit-hero-sub", text: parts.join(" · ") });

    // Only advice the reader can act on. This said "turn on online enrichment"
    // unconditionally — including to somebody who has it on and is offline or
    // rate-limited, directly above the coverage notice explaining that GitHub
    // couldn't be reached. When enrichment is already on, that notice owns the
    // explanation and the Retry button, so say nothing here.
    if (!graded && this.coverage.disabled) {
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
      this.act(
        this.plugin.markChangesSeen().then(() => this.render()),
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
   * A search in progress.
   *
   * Deliberately the loudest thing on the page while it runs: the vault is
   * currently in a state the user did not choose, and every number below is
   * measured against that state rather than their real setup.
   */
  private renderBisect(root: HTMLElement): void {
    const state = this.plugin.bisect;
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
        ? (this.results.find((r) => r.id === state.culprit)?.name ?? state.culprit)
        : null;
      const body = box.createDiv({ cls: "flowkit-bisect-body" });
      // "It's X" would be a claim of proof, and elimination doesn't give you
      // one: a symptom can need two plugins together, disabling one can break
      // another, and some plugins don't fully unload without a restart. The
      // search narrows honestly; the sentence should too.
      // The last clause is conditional, because on the failed-restore path it
      // was a flat contradiction of the error box rendered directly beneath it:
      // "everything else is back on", above "FlowKit couldn't switch X back on".
      const restored = this.plugin.bisectError
        ? " It is off now — but FlowKit could not switch everything else back on; see below."
        : " It is off now; everything else is back on.";
      body.setText(
        culprit
          ? `${culprit} is the one. With it switched off the problem went away, and with it on it came back — that is as close to proof as switching things off can get.${restored}`
          : "The problem survived with every candidate switched off, so no installed plugin is causing it. Worth looking at your theme, CSS snippets, or Obsidian itself."
      );
      if (this.plugin.bisectError) {
        const warn = box.createDiv({ cls: "flowkit-bisect-error" });
        setIcon(warn.createSpan({ cls: "flowkit-bisect-error-icon" }), "alert-triangle");
        warn.createSpan({ text: this.plugin.bisectError });
      }
      const actions = box.createDiv({ cls: "flowkit-bisect-actions" });
      const done = actions.createEl("button", { cls: "mod-cta", text: culprit ? "Keep it off" : "Restore everything" });
      // `false` when there is nothing to keep off: passing `true` happened to
      // be harmless only because `culprit` is falsy downstream, which is the
      // kind of accidental correctness that stops being correct on the next
      // edit.
      done.onclick = () =>
        void this.runBisectAction(() => this.plugin.finishBisect(culprit != null));
      if (culprit) {
        const restore = actions.createEl("button", { text: "Turn it back on too" });
        restore.onclick = () => void this.runBisectAction(() => this.plugin.finishBisect(false));
      }
      // Undo belongs here most of all, and this branch returned before ever
      // offering it — so the search could be un-answered on every round except
      // the one that produces the accusation. That is the answer people are
      // likeliest to get wrong (it is given after the longest wait, on the
      // smallest difference) and the only one whose mistake has a name attached
      // to it. Going back re-establishes the round and asks again.
      if (this.plugin.bisectCanUndo) {
        const back = actions.createEl("button", {
          cls: "flowkit-bisect-undo",
          text: culprit ? "That's not it — go back" : "Go back a step",
        });
        back.setAttr(
          "aria-label",
          "Take back the last answer and test that round again"
        );
        back.onclick = () =>
          void this.runBisectAction(async () => {
            const restored = await this.plugin.undoBisectAnswer();
            if (restored) new Notice("Went back a step — test this round again.");
          });
      }
      for (const btn of Array.from(actions.querySelectorAll("button"))) {
        btn.disabled = this.bisectBusy || this.plugin.bisectBusy;
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
    if (this.plugin.bisectDrifted()) {
      const drift = box.createDiv({ cls: "flowkit-bisect-error" });
      setIcon(drift.createSpan({ cls: "flowkit-bisect-error-icon" }), "help-circle");
      drift.createSpan({
        text:
          "Your plugins don't match the round this search was on — either it was interrupted, " +
          "or they were changed by hand. Answering now would be answering about a different set.",
      });
      const choose = box.createDiv({ cls: "flowkit-bisect-actions" });
      const resume = choose.createEl("button", { cls: "mod-cta", text: "Put them back and carry on" });
      resume.onclick = () => void this.runBisectAction(() => this.plugin.resumeBisect());
      const abandon = choose.createEl("button", { text: "Stop the search" });
      abandon.onclick = () => void this.runBisectAction(() => this.plugin.cancelBisect());
      for (const btn of [resume, abandon]) {
        btn.disabled = this.bisectBusy || this.plugin.bisectBusy;
      }
      return;
    }

    box.createDiv({ cls: "flowkit-bisect-body", text: describeRound(state) });

    const off = state.disabled
      .map((id) => this.results.find((r) => r.id === id)?.name ?? id)
      .sort((a, b) => a.localeCompare(b));
    const list = box.createEl("details", { cls: "flowkit-bisect-list" });
    list.createEl("summary", { text: `Currently switched off (${off.length})` });
    list.createDiv({ text: off.join(", ") });

    // A round that could not be established is not a round. Answering it would
    // be answering about a set of plugins the vault is not actually in, and
    // this search's whole output is a name it puts in front of the user.
    const blocked = this.plugin.bisectError;
    if (blocked) {
      const warn = box.createDiv({ cls: "flowkit-bisect-error" });
      setIcon(warn.createSpan({ cls: "flowkit-bisect-error-icon" }), "alert-triangle");
      warn.createSpan({ text: blocked });
    }

    const actions = box.createDiv({ cls: "flowkit-bisect-actions" });
    // Every control locks together for the duration of a transition. Locking
    // only the button that was pressed still lets "the problem is gone" and
    // "still happening" interleave into two different next rounds.
    const busy = this.bisectBusy || this.plugin.bisectBusy;
    const gone = actions.createEl("button", { cls: "mod-cta", text: "The problem is gone" });
    gone.onclick = () => void this.answerBisect(true);
    const still = actions.createEl("button", { text: "Still happening" });
    still.onclick = () => void this.answerBisect(false);
    // The way back from a mis-click.
    //
    // Both buttons above are irreversible and each throws away half the
    // remaining suspects — so pressing one before you had actually checked
    // produces a search that finishes normally and names the wrong plugin, with
    // nothing anywhere to suggest it went wrong. This is the cheapest possible
    // guard against the most likely mistake in the feature. Placed before Stop,
    // which is pushed to the far end of the row.
    if (this.plugin.bisectCanUndo) {
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
        void this.runBisectAction(async () => {
          const restored = await this.plugin.undoBisectAnswer();
          if (restored) new Notice("Went back a step — test this round again.");
        });
    }

    const stop = actions.createEl("button", { cls: "flowkit-bisect-stop", text: "Stop and restore" });
    stop.onclick = () => void this.runBisectAction(() => this.plugin.cancelBisect());
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
  private renderSalvage(root: HTMLElement): void {
    if (!this.plugin.bisectSalvage) return;
    const snapshot = this.plugin.settings.profiles.find((p) => p.name === AUTO_SNAPSHOT);
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
        this.plugin.bisectSalvage = null;
        void this.runApplyProfile(snapshot);
      };
    }
    const dismiss = actions.createEl("button", { text: "Dismiss" });
    dismiss.onclick = () => {
      this.plugin.bisectSalvage = null;
      this.render();
    };
  }

  /**
   * Say when nothing the user does here will stick.
   *
   * FlowKit refuses to write over a data.json it couldn't read, which is the
   * right call — but silently refusing is not: the licence key would appear to
   * activate, the mute would appear to take, and none of it would survive a
   * restart.
   */
  private renderUnreadable(root: HTMLElement): void {
    if (!this.plugin.settingsUnreadable) return;
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
        `${this.plugin.dataFilePath()} to keep a copy, and FlowKit will start fresh. You lose ` +
        `your history and saved sets; your licence key can be pasted back in.`,
    });
    const copy = box.createEl("button", { text: "Copy the file path" });
    copy.onclick = () => {
      this.act(
        navigator.clipboard
          .writeText(this.plugin.dataFilePath())
          .then(() => new Notice("Path copied.")),
        "Couldn't copy the path"
      );
    };
  }

  /** Set while this view is driving a bisect transition. */
  private bisectBusy = false;

  /** Run a bisect transition with every control locked for its duration. */
  private async runBisectAction(fn: () => Promise<unknown>): Promise<void> {
    if (this.bisectBusy) return;
    this.bisectBusy = true;
    this.render();
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
      this.bisectBusy = false;
      await this.refresh(false, false);
    }
  }

  private async answerBisect(gone: boolean): Promise<void> {
    await this.runBisectAction(async () => {
      const next = await this.plugin.answerBisect(gone);
      if (next?.done && next.culprit && !this.plugin.bisectError) {
        const name = this.results.find((r) => r.id === next.culprit)?.name ?? next.culprit;
        new Notice(`Found it: ${name}.`, 8000);
      }
    });
  }

  /**
   * Changes that were followed by errors.
   *
   * FlowKit already stored both halves of this and never put them together.
   * "Templater has thrown 40 errors" is a fact; "Templater started throwing
   * errors two hours after it updated to 2.4.1" is a diagnosis, and it is the
   * same data.
   */
  private renderCorrelations(root: HTMLElement): void {
    const found = this.plugin.correlations(this.results);
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
  private renderAppUpdate(root: HTMLElement): void {
    const change = this.plugin.recentAppUpdate();
    if (!change) return;

    // Re-resolve against the current scan rather than trusting the recorded
    // list: the user may have already updated or removed one of them, and a
    // banner naming a plugin that is fine now is worse than no banner.
    const broke = this.results.filter(
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
      this.act(
        // Only this banner. It used to share `markChangesSeen` with the "since
        // you last looked" strip, so closing one silently closed the other —
        // permanently, because the change log is read in exactly one place.
        this.plugin.markAppUpdateSeen().then(() => this.render()),
        "Couldn't mark that as seen"
      );
    };

    const body = box.createDiv({ cls: "flowkit-appupdate-body" });
    if (!broke.length) {
      // "all your plugins" is only true when disabled ones are being shown;
      // otherwise this scan never looked at them.
      const scope = this.plugin.settings.showDisabled
        ? `all ${this.results.length} of your plugins`
        : `your ${this.results.length} enabled plugins`;
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
    show.onclick = () => this.applyScope("incompatible");
  }

  /**
   * Mutes that ran out.
   *
   * A mute with an expiry is only honest if its expiry is visible. Without
   * this, a plugin quietly rejoins the counts and the user reads it as the
   * score wobbling rather than as a decision they made lapsing on schedule.
   */
  private renderLapsedMutes(root: HTMLElement): void {
    if (!this.lapsedMutes.length) return;
    const names = this.lapsedMutes.map(
      (id) => this.results.find((r) => r.id === id)?.name ?? id
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
      this.lapsedMutes = [];
      this.render();
    };
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
      this.act(this.plugin.saveSettings(), "Couldn't save that");
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
      again.onclick = () => this.forceRetry();
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
        this.act(
          this.plugin.saveSettings().then(() => this.refresh(true)),
          "Couldn't turn on online enrichment"
        );
      };
      return;
    }

    const missing = !stats && !list ? "Popularity, Maintenance and sideload detection" : !stats ? "Popularity and Maintenance" : "sideload detection and repository links";
    body.createDiv({ text: `${error ?? "Couldn't reach GitHub."} ${missing} unavailable for this scan.` });
    const btn = note.createEl("button", { text: "Retry" });
    btn.onclick = () => this.forceRetry();
  }

  private renderSummary(root: HTMLElement): void {
    const s = this.summaryStats();
    const summary = root.createDiv({ cls: "flowkit-health-summary" });
    // "Plugins 31" beside a hero reading "Across 27 plugins" is two different
    // denominators on one screen with nothing to explain the gap — and in a
    // product whose whole argument is that its numbers are honest, that is the
    // paper cut that costs the most. Muted rows are excluded from every count
    // and every finding, so say so where the difference shows up.
    const muted = this.results.length - s.count;
    this.statTile(
      summary,
      "Plugins",
      muted > 0 ? `${s.count} of ${this.results.length}` : String(this.results.length),
      "unknown",
      "all",
      muted > 0
        ? `${s.count} counted towards your vault's health; ${muted} muted and excluded.`
        : undefined
    );
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

    this.renderStartupCost(root);
  }

  /**
   * "Why is my vault slow?", as a question the dashboard can answer.
   *
   * Everything needed for this was already measured and shown one row at a
   * time, where nobody adds it up. Stated as a vault total with a way into the
   * ordered list, the same data becomes a performance triage tool rather than a
   * maintenance checklist.
   */
  private renderStartupCost(root: HTMLElement): void {
    const enabled = this.results.filter((r) => r.enabled && !r.muted);
    if (enabled.length === 0) return;

    const cost = startupCost(
      enabled.map((r) => ({
        id: r.id,
        enabled: true,
        bytes: r.bundleBytes,
        // So a load timed against an older build is left out of the total
        // rather than quoted as current — the same rule Footprint applies.
        version: r.version,
      })),
      Object.fromEntries(enabled.map((r) => [r.id, r.runtime ?? {}]))
    );

    const bar = root.createDiv({ cls: "flowkit-startup" });
    setIcon(bar.createSpan({ cls: "flowkit-startup-icon" }), "gauge");
    const parts = [`${enabled.length} plugins load at startup`];
    if (cost.bytes > 0) parts.push(`${formatBytes(cost.bytes)} of code`);
    if (cost.measuredCount > 0) {
      parts.push(
        `${Math.round(cost.measuredMs)} ms measured across ${cost.measuredCount}`
      );
    }
    if (cost.polling > 0) {
      parts.push(`${cost.polling} running a fast repeating timer`);
    }
    bar.createSpan({ cls: "flowkit-startup-text", text: parts.join(" · ") });

    // Say how partial the measurement is. "142 ms across 3" beside "38 plugins
    // enabled" invites the reading that the other 35 are free.
    // The label and the action are now the SAME list. They were computed
    // separately and differed by construction: the count excluded muted and
    // already-measured plugins, the click passed every enabled one — so
    // "Profile the other 12" opened a modal saying "Profile 38 plugins?" and
    // then restarted all 38, including the 26 it had just said it would leave
    // alone.
    const unprofiled = this.unprofiledIds();
    if (this.plugin.runtimeTracking && unprofiled.length > 0) {
      const profile = bar.createEl("button", {
        text: `Profile the other ${unprofiled.length}`,
      });
      profile.setAttr(
        "aria-label",
        "Restart each unmeasured plugin in turn and time how long it takes to load"
      );
      profile.onclick = () => this.startProfileAll(unprofiled);
    }

    // Named for what it does. As "Why is my vault slow?" it promised a
    // diagnosis and delivered a sort order, which is a small overclaim in the
    // one place the product is otherwise scrupulous about not making them.
    const btn = bar.createEl("button", { text: "Show the most expensive" });
    btn.setAttr("aria-label", "Order the table by what each plugin costs to run");
    btn.onclick = () => this.applyScope("heavy");
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
  private profilableIds(): string[] {
    return searchableCandidates(
      this.results.filter((r) => r.enabled).map((r) => r.id),
      this.plugin.manifest.id
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
  private unprofiledIds(): string[] {
    return searchableCandidates(
      this.results
        .filter(
          (r) => r.enabled && !r.muted && currentLoadMs(r.runtime, r.version) == null
        )
        .map((r) => r.id),
      this.plugin.manifest.id
    );
  }

  private startProfileAll(ids: string[]): void {
    // Same guard, milder consequence: profiling restarts every plugin in turn
    // and restores each to the state it found it in — which mid-search is the
    // search's state, not the user's — so it doesn't destroy the record, but it
    // does churn a vault that is deliberately half off and make the round's
    // question meaningless while it runs.
    if (this.plugin.bisect && !this.plugin.bisect.done) {
      new Notice("Finish or stop the plugin search first — profiling would restart the plugins it has switched off.", 8000);
      return;
    }
    if (!this.plugin.isPro) {
      this.openUpgrade("profile");
      return;
    }
    new BulkConfirmModal(this.app, {
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
      onConfirm: () => void this.runProfileAll(ids),
    }).open();
  }

  private async runProfileAll(ids: string[]): Promise<void> {
    const notice = new Notice(`Profiling 0 of ${ids.length}…`, 0);
    try {
      const result = await this.plugin.profileAll(ids, (done, total, id) => {
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
        const name = this.results.find((r) => r.id === err.pluginId)?.name ?? err.pluginId;
        new Notice(
          `Profiling stopped: FlowKit couldn't switch ${name} back ${
            err.wasEnabled ? "on" : "off"
          }. Set it from Settings → Community plugins, or restart Obsidian — this change wasn't saved, so a restart undoes it.`,
          0
        );
        await this.refresh(false, false);
        return;
      }
      new Notice(
        result.failed.length
          ? `Profiled ${result.measured} plugins. ${result.failed.length} couldn't be measured.`
          : `Profiled ${result.measured} plugins.`,
        6000
      );
      await this.refresh(false, false);
    } catch (err) {
      notice.hide();
      console.error("FlowKit: profiling failed", err);
      new Notice("Profiling stopped early — see the console.");
      await this.refresh(false, false);
    }
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
    filter: FilterKey,
    hint?: string
  ): void {
    const tile = parent.createEl("button", { cls: "flowkit-stat" });
    tile.setAttr("aria-label", hint ?? `${value} ${label} — show them`);
    if (hint) tile.setAttr("title", hint);
    // Label first: as a one-line pill it reads "Updates 3", not "3 Updates".
    tile.createSpan({ cls: "flowkit-stat-label", text: label });
    tile.createSpan({ cls: `flowkit-stat-value tone-${tone}`, text: value });
    tile.onclick = () => this.applyScope(filter);
  }

  // --- insights -------------------------------------------------------------

  private renderInsights(root: HTMLElement): void {
    const insights = this.insights();
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

    this.renderStartHere(section);

    // The complete diagnosis, for everyone.
    //
    // This used to show insights[0] and then a lock card. It converted nobody:
    // every input the hidden insights are built from was already free — the
    // badges, the chips — and the filter dropdown ships a dedicated option for
    // each hidden cohort, so any user could reconstruct the whole list in five
    // seconds and conclude the gate was artificial. What Pro sells now is
    // applying the fixes, not being told what they are.
    for (const ins of insights) this.renderInsightCard(section, ins);

    if (this.plugin.isPro) return;

    // The ask, framed around the one question this list cannot answer.
    //
    // A ranked to-do list tells you what is wrong with each plugin. It says
    // nothing about the problem that has no single culprit — the lag, the
    // freeze, the thing that started last Tuesday — and that is exactly the
    // problem people install a plugin-health tool to solve. So the pitch is
    // the search, on this vault's real numbers.
    const enabled = this.results.filter((r) => r.enabled).length;
    if (enabled < 2) return;

    const lock = section.createDiv({ cls: "flowkit-insight-lock" });
    const body = lock.createDiv({ cls: "flowkit-insight-lock-body" });
    setIcon(body.createSpan({ cls: "flowkit-lock-icon" }), "search-check");
    const txt = body.createDiv();
    txt.createEl("strong", {
      text: "Something wrong that isn't on this list?",
    });
    txt.createDiv({
      cls: "flowkit-lock-sub",
      text:
        `FlowKit can find it by elimination — switching off half your plugins, asking whether the problem is still there, ` +
        `and halving until one is left. That's ${roundsNeeded(enabled)} questions to search your ${enabled} enabled plugins, ` +
        `instead of an evening of it. Everything it switches off goes back on afterwards. Pro, ${PRO_PRICE}.`,
    });
    const btn = lock.createEl("button", { cls: "flowkit-health-btn flowkit-upgrade-btn" });
    btn.setText("See how it works");
    btn.onclick = () => this.openUpgrade("bisect");
  }

  /**
   * The order to act in.
   *
   * The findings say what is wrong; for a vault with nine of them, that still
   * isn't an answer. Ranking by badness alone answers it wrongly — the
   * worst-scoring plugin is often the one used every day, while the easy win is
   * the broken thing the user forgot was installed. This ranks by trouble
   * removed per feature given up, and says what each one would cost.
   */
  private renderStartHere(section: HTMLElement): void {
    const ranked = rankSafeDisable(this.results, 3);
    // Below three findings there is no ordering problem to solve, and a "start
    // here" list in front of a two-item list is furniture.
    if (ranked.length < 2) return;

    const box = section.createDiv({ cls: "flowkit-starthere" });
    const head = box.createDiv({ cls: "flowkit-starthere-head" });
    setIcon(head.createSpan({ cls: "flowkit-section-icon" }), "list-ordered");
    head.createSpan({ cls: "flowkit-starthere-title", text: "Disable these first" });
    head.createSpan({
      cls: "flowkit-starthere-sub",
      text: "Most trouble removed for the least you'd give up",
    });

    const list = box.createEl("ol", { cls: "flowkit-starthere-list" });
    for (const c of ranked) {
      const li = list.createEl("li");
      const name = li.createEl("button", {
        cls: "flowkit-plugin-name",
        text: c.name,
      });
      name.setAttr("aria-label", `${c.name} — open its reasoning`);
      name.onclick = () => {
        this.expandedId = c.id;
        // Scoped by id rather than by searching its name: a plugin whose name
        // is a substring of another's would otherwise take you to a list of
        // two, which is not what the card promised.
        this.applyScope({
          id: `plugin:${c.id}`,
          tone: "info",
          icon: "plug",
          title: c.name,
          detail: "",
          ids: [c.id],
          match: (r: PluginHealth) => r.id === c.id,
        });
      };
      li.createDiv({ cls: "flowkit-starthere-why", text: `Because ${c.why}.` });
      li.createDiv({ cls: "flowkit-starthere-loss", text: `You'd lose: ${c.loss}.` });
    }
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
        ? `${errors} error${errors === 1 ? "" : "s"} traced to a plugin in ${describeWatched(watched)} of watching`
        : "error watching is off",
      `${live.filter((r) => r.maintenanceStatus === "unmaintained").length} without a release in 18 months`,
    ];
    const list = card.createEl("ul", { cls: "flowkit-allclear-list" });
    for (const c of checks) list.createEl("li", { text: c });
  }

  private renderInsightCard(parent: HTMLElement, ins: Insight): void {
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
    // Free since 1.4.0. Charging for this asked people to pay for the
    // difference between one click and three — a thirty-second job they can do
    // in Obsidian's own settings, which is why it converted nobody. What Pro
    // sells now is the work that genuinely can't be done by hand: the search,
    // the profile, the saved sets.
    if (ins.action && ins.ids.length) {
      const btn = card.createEl("button", { cls: "flowkit-insight-action" });
      btn.setText(ins.actionLabel ?? "Apply");
      btn.onclick = () => this.runBulk(ins);
    }
  }

  /** Show what a bulk action will do, then do it — and keep a way back. */
  private runBulk(ins: Insight): void {
    if (!ins.action || !ins.ids.length) return;
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

      // A user staring at an error message is one search away from the thread
      // where three other people described it and the author already answered —
      // and they almost never make that search, because copying a stack trace
      // into GitHub is friction at the exact moment they are already annoyed.
      if (r.repo) {
        const lookup = item.createDiv({ cls: "flowkit-error-lookup" });
        const ask = lookup.createEl("button", { text: "Is this a known issue?" });
        ask.onclick = () => void this.lookUpIssue(r, sig.message, lookup, ask);
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
   * Who else is claiming this plugin's shortcuts.
   *
   * Deliberately not scored. Neither plugin is at fault for a collision, and
   * docking one of them for it would be inventing a defect — but the user still
   * needs to know, because Obsidian's own UI never says which binding wins.
   */
  private renderConflictDetail(panel: HTMLElement, r: PluginHealth): void {
    const mine = conflictsFor(this.conflicts, r.id);
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
    fix.onclick = () => this.plugin.openHotkeySettings();
  }

  /**
   * Search a plugin's own issue tracker for this error.
   *
   * On demand only, and never as part of a scan: GitHub's search API allows
   * roughly ten unauthenticated requests a minute, which is ample for a button
   * somebody presses and useless for anything automatic.
   */
  private async lookUpIssue(
    r: PluginHealth,
    message: string,
    host: HTMLElement,
    trigger: HTMLButtonElement
  ): Promise<void> {
    trigger.disabled = true;
    trigger.setText("Looking…");
    const result = await findKnownIssues(r.repo, message);
    trigger.remove();

    if (!result.ok) {
      host.createSpan({
        cls: "flowkit-error-lookup-note",
        text:
          result.reason === "rate-limited"
            ? "GitHub is rate-limiting searches right now — try again in a minute."
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
        // Redacted, because this is the text the product tells the user to
        // paste into a stranger's issue tracker. Error messages quote the file
        // being touched, and in a note-taking app the file name IS the content
        // — "Patients/Alice Nguyen HIV results.md" is not incidental detail.
        lines.push(
          `- \`${redactUserContent(sig.message)}\` — seen ${sig.count}×, last ${describeWhen(sig.lastAt)}`
        );
        // The stack is the Pro line: it is the part an author can act on. It is
        // also, by construction, a list of absolute paths carrying the OS
        // username and the vault name on every frame.
        if (this.plugin.isPro && sig.stack) {
          lines.push("");
          lines.push("```");
          lines.push(redactUserContent(sig.stack));
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
      // Says what was included, because the user is about to publish it, and
      // "paste it into an issue" was the whole of the previous disclosure.
      new Notice(
        "Bug report copied. File names and paths are redacted — check it before you post it.",
        8000
      );
    } catch (err) {
      console.error("FlowKit: clipboard write failed", err);
      new Notice("Couldn't copy to the clipboard — see the console.");
    }
  }

  /** A short vault summary that fits in a chat message. */
  private async copySummary(): Promise<void> {
    const s = this.summaryStats();
    const grade = this.gradeNow(s);
    const insights = this.insights();
    const lines = [
      `${PRODUCT_NAME}: vault health ${s.avg ?? "—"}/100${
        this.canGrade(s) ? ` (Grade ${grade.letter})` : " (not enough signal to grade)"
      } across ${s.count} plugins.`,
    ];
    for (const ins of insights.slice(0, 3)) lines.push(`• ${ins.title}`);
    const watching = this.plugin.observedMs();
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
      const { changed, failed } = await this.plugin.disableMany(ids);
      if (changed.length) {
        this.lastBulk = {
          label: `Disabled ${changed.length} plugin${changed.length === 1 ? "" : "s"}`,
          revert: async () => {
            const back = await this.plugin.enableMany(changed);
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
    // Two exclusions, both about comparability:
    //  - offline readings, where a missing signal looked like an improvement;
    //  - readings from an older scoring model, which are a different scale.
    // Applied before the window is cut, so the upsell below can count what the
    // window actually costs the reader rather than what these filters removed.
    // …and a third: readings taken on another device. Where `data.json` is
    // synced and the installed plugins are not, a phone with six plugins and a
    // desktop with forty were drawing one polyline between two different
    // vaults' health.
    const comparable = this.plugin.settings.history
      .filter(
        (h): h is HealthSnapshot & { avg: number } =>
          h.avg != null &&
          h.online !== false &&
          h.model === SCORING_MODEL &&
          this.plugin.isThisDevice(h)
      )
      .sort((a, b) => a.at - b.at);
    const history = comparable.filter((h) => h.at >= cutoff);

    const section = root.createDiv({ cls: "flowkit-trends" });
    const head = section.createDiv({ cls: "flowkit-section-head" });
    setIcon(head.createSpan({ cls: "flowkit-section-icon" }), "trending-up");
    head.createSpan({
      cls: "flowkit-section-title",
      text: `Vault health trend · ${windowDays} days`,
    });

    const usable = history;

    if (usable.length === 0) {
      // "From tomorrow" is only true if tomorrow's reading would be plottable.
      // Snapshots carry `online: coverage.stats`, which is permanently false
      // while enrichment is off, and the chart drops anything with
      // `online === false` — so a privacy-minded user with ninety stored
      // readings was told to come back tomorrow, every day, forever.
      const stored = this.plugin.settings.history.length;
      section.createDiv({
        cls: "flowkit-trends-empty",
        text: this.coverage.disabled
          ? stored > 0
            ? `${stored} reading${stored === 1 ? "" : "s"} recorded, but none can be plotted: with online enrichment off, a score is built from local signals only and isn't comparable with one that wasn't. Turn enrichment on and the trend starts building.`
            : "With online enrichment off, readings aren't comparable enough to plot. Turn it on and the trend starts building."
          : "FlowKit records one reading a day. Your trend appears here from tomorrow.",
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

    // Only ask when the window is actually costing the reader something.
    //
    // This compared against the WHOLE history, including readings the chart
    // dropped for being offline or scored on an older model — so a free user
    // three weeks in, with two network hiccups behind them, was told they had
    // five readings saved and offered ninety days to see them. The number in
    // an upsell has to be a number the purchase would change.
    const beyondWindow = comparable.length - usable.length;
    if (!this.plugin.isPro && beyondWindow > 0) {
      const more = section.createDiv({ cls: "flowkit-trends-more" });
      more.appendText(
        `${beyondWindow} older reading${beyondWindow === 1 ? "" : "s"} sit${
          beyondWindow === 1 ? "s" : ""
        } outside this 30-day window. `
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
    // Coalesced to one rebuild per animation frame's worth of typing. The
    // results region is a full table — every cell, badge, tooltip, aria string
    // and handler — and rebuilding all of it between two keystrokes is what
    // makes a search box feel like it is dragging on a large vault. The value
    // is read from the element at flush time, so the input stays authoritative
    // and nothing is lost if two keystrokes land inside one window.
    // The timer is held on the view, not in this closure. A full render — a
    // scan landing, a mute, a watch — replaces this input, and a timer captured
    // here would still fire afterwards, read the detached element, and write
    // its value back over the current search. Several renders inside one
    // debounce window would leave several of them queued.
    this.cancelSearchFlush();
    const flush = (): void => {
      this.searchTimer = null;
      this.search = input.value;
      // Typing is its own scope; drop any finding scope so the two can't fight.
      this.scopeInsight = null;
      this.renderRows();
      this.renderScopeChip();
    };
    input.oninput = () => {
      if (this.searchTimer != null) return;
      this.searchTimer = window.setTimeout(flush, SEARCH_DEBOUNCE_MS);
    };
    // Committing shouldn't wait out the timer.
    const commit = (): void => {
      this.cancelSearchFlush();
      flush();
    };
    input.onkeydown = (evt) => {
      if (evt.key === "Enter") commit();
    };
    input.onblur = () => {
      if (this.searchTimer != null) commit();
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
      text: "Installed plugins scored on compatibility, reliability, maintenance, footprint, manifest hygiene and popularity. Select a row to see why it scored what it did.",
    });
    const thead = table.createEl("thead").createEl("tr");
    this.sortableTh(thead, "Plugin", "name");
    this.sortableTh(
      thead,
      "Overall",
      "overall",
      true,
      "Weighted blend of the six metrics, renormalised over what was available."
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
  private renderDetail(tbody: HTMLElement, r: PluginHealth, after?: HTMLElement): void {
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

    this.renderConflictDetail(panel, r);
    this.renderErrorDetail(panel, r);

    const facts = panel.createDiv({ cls: "flowkit-detail-facts" });
    facts.createDiv({
      text: `Installed v${r.version}${
        r.latestVersion && r.latestVersion !== r.version
          ? ` · latest published v${r.latestVersion}`
          : ""
      } · by ${r.author}`,
    });

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
    if (r.enabled && this.plugin.runtimeTracking && loadMs == null) {
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
    const history = this.plugin.eventsFor(r.id);
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
    const toggle = actions.createEl("button", {
      text: r.enabled ? "Disable" : "Enable",
    });
    toggle.onclick = () => {
      this.act(
        this.plugin.setPluginEnabled(r.id, !r.enabled).then(() => this.refresh(false, false)),
        `Couldn't ${r.enabled ? "disable" : "enable"} ${r.name}`
      );
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
    const watch = actions.createEl("button", {
      text: r.watched ? "Stop watching" : "Watch this",
    });
    watch.onclick = () => {
      void this.toggleWatch(r);
    };
    const mute = actions.createEl("button", {
      text: r.muted ? "Unmute" : "Mute from counts…",
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
    // The header sorts, so it must be a control — it was a bare <th> with an
    // onclick, reachable only by mouse.
    th.setAttr(
      "aria-sort",
      this.sortKey === key ? (this.sortDir === 1 ? "ascending" : "descending") : "none"
    );
    const btn = th.createEl("button", { cls: "flowkit-sort-btn", text: label });
    if (hint) {
      btn.setAttr("title", hint);
      btn.setAttr("aria-label", `${label} — ${hint}. Sort by this.`);
    }
    btn.onclick = () => this.toggleSort(key);
    if (this.sortKey === key) {
      // Inside the button, so the arrow isn't announced as separate content.
      btn.createSpan({
        cls: "flowkit-sort-arrow",
        text: this.sortDir === -1 ? " ▼" : " ▲",
      });
    }
  }

  private renderRow(tbody: HTMLElement, r: PluginHealth): void {
    const tr = tbody.createEl("tr");
    if (!r.enabled) tr.addClass("is-disabled");
    if (r.muted) tr.addClass("is-muted");

    const expanded = this.expandedId === r.id;
    if (expanded) tr.addClass("is-expanded");
    tr.dataset.pluginId = r.id;
    // Opening one row's reasoning used to rebuild every row in the table, which
    // is both the most common interaction here and the most wasteful thing the
    // view did — and it visibly flickered on a large vault. Nothing about the
    // other rows changes, so touch only this one and its panel.
    const toggle = () => this.toggleDetail(r, tr);
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
      this.badge(nameRow, status.label, status.tone, status.hint);
    }
    // The one repository fact worth a badge: an archived repo is the author
    // saying, on the record, that nothing more is coming.
    if (r.repoActivity?.archived) {
      this.badge(
        nameRow,
        "Archived",
        "bad",
        "Its author has archived the repository — no further fixes are planned."
      );
    }
    // Conflicts belong on the row, not only in the panel: a shortcut that
    // silently doesn't fire is exactly the kind of thing nobody goes looking
    // for, because they've assumed it's their own mistake.
    const clashes = this.clashCounts.get(r.id) ?? 0;
    if (clashes > 0 && r.enabled) {
      this.badge(
        nameRow,
        clashes === 1 ? "Clash" : `${clashes} clashes`,
        "warn",
        "Shares a shortcut or command name with another plugin — only one of them answers."
      );
    }
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
    const meta = nameCell.createDiv({ cls: "flowkit-plugin-meta" });
    // Disabled is already carried by the row's own dimming; saying it again in
    // text encoded one state twice. Muted likewise.
    meta.setText(`${r.author} · v${r.version}`);

    // Overall is a blend, so it isn't "measured" — but marking it `estimated`
    // put the ~ honesty mark on 100% of rows, which made it mean nothing. Every
    // metric it blends is now measured; what varies is coverage, and that is
    // already reported as confidence.
    this.scoreCell(
      tr,
      r.overall,
      "measured",
      `Weighted blend of the six metrics in this row · ${Math.round(r.confidence * 100)}% of signals available.`,
      "Overall"
    );
    for (const col of METRIC_COLUMNS) {
      const metric = r.metrics[col.key];
      this.scoreCell(tr, metric.value, metric.source, metric.detail, col.label, col.key);
    }

    const actionCell = tr.createEl("td", { cls: "num flowkit-actions" });
    const menuBtn = actionCell.createEl("button", { cls: "flowkit-menu-btn" });
    setIcon(menuBtn, "more-vertical");
    menuBtn.setAttr("aria-label", "Plugin actions");
    menuBtn.onclick = (evt) => this.openRowMenu(evt, r);
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
  private toggleDetail(r: PluginHealth, tr: HTMLElement): void {
    const host = this.rowsEl;
    const wasOpen = this.expandedId === r.id;
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
      this.expandedId = null;
      return;
    }
    this.expandedId = r.id;
    tr.addClass("is-expanded");
    tr.querySelector<HTMLElement>("button.flowkit-plugin-name")?.setAttr(
      "aria-expanded",
      "true"
    );
    const parent = tr.parentElement;
    if (!parent) return;
    this.renderDetail(parent, r, tr);
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
        // Not an `async` menu callback: Obsidian's menu does not promise to
        // handle a rejected one, so a plugin that refuses to switch produced
        // nothing — no change, no message, no console line.
        .onClick(() =>
          this.act(
            this.plugin
              .setPluginEnabled(r.id, !r.enabled)
              .then(() => this.refresh(false, false)),
            `Couldn't ${r.enabled ? "disable" : "enable"} ${r.name}`
          )
        )
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

    if (r.enabled && this.plugin.runtimeTracking) {
      menu.addItem((item) =>
        item
          .setTitle("Measure load time")
          .setIcon("timer")
          .onClick(() => void this.measureLoad(r))
      );
    }

    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(r.watched ? "Stop watching" : "Watch this plugin")
        .setIcon(r.watched ? "star-off" : "star")
        .onClick(() => void this.toggleWatch(r))
    );
    menu.addItem((item) =>
      item
        .setTitle(r.muted ? "Unmute plugin" : "Mute from counts…")
        .setIcon(r.muted ? "bell" : "bell-off")
        .onClick(() => void this.toggleMute(r))
    );

    menu.showAtMouseEvent(evt);
  }

  /**
   * Time one plugin's load by restarting it.
   *
   * Confirmed first, and honest about the cost: this genuinely turns the plugin
   * off and on again, so anything holding unsaved in-memory state loses it.
   * That is the price of a real number instead of a file size.
   */
  private async measureLoad(r: PluginHealth): Promise<void> {
    new BulkConfirmModal(this.app, {
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
        void this.plugin
          .measureLoad(r.id)
          .then(async (ms) => {
            if (ms == null) {
              new Notice("Couldn't measure that one — see the console.");
              return;
            }
            new Notice(`${r.name} loaded in ${Math.round(ms)} ms.`);
            await this.refresh(false, false);
          })
          .catch(async (err) => {
            console.error("FlowKit: measurement failed", err);
            new Notice(
              `FlowKit couldn't switch ${r.name} back on after measuring it. Turn it on from Settings → Community plugins, or restart Obsidian.`,
              0
            );
            await this.refresh(false, false);
          });
      },
    }).open();
  }

  /**
   * Open a search.
   *
   * Candidates are the enabled plugins, worst-scoring first — bisect halves
   * either way, so the order doesn't change how many rounds it takes, but it
   * does mean the first half switched off is the half most likely to contain
   * the problem, and a lucky first answer ends the search early.
   */
  /**
   * Command-palette entry points.
   *
   * The dashboard's own menu was the only way to reach any of this, which
   * means it could not be searched for or bound to a key — and the palette is
   * where most people look first. Each ensures there is a scan to act on,
   * since a command can open the view and fire before it has scanned.
   */
  async commandBisect(): Promise<void> {
    if (!this.results.length) await this.refresh(false, false);
    this.startBisect();
  }

  async commandProfile(): Promise<void> {
    if (!this.results.length) await this.refresh(false, false);
    this.startProfileAll(this.profilableIds());
  }

  async commandSaveSet(): Promise<void> {
    if (!this.results.length) await this.refresh(false, false);
    this.saveProfile();
  }

  private startBisect(): void {
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
    if (this.plugin.bisect) {
      new Notice(
        "A search is already running — finish it or stop and restore before starting another.",
        8000
      );
      this.render();
      return;
    }
    if (!this.plugin.isPro) {
      this.openUpgrade("bisect");
      return;
    }
    // FlowKit is filtered out before the count and the round estimate, so the
    // modal promises a search over the plugins that will actually be tested.
    const candidates = searchableCandidates(
      this.results
        .filter((r) => r.enabled)
        .sort((a, b) => (a.overall ?? 100) - (b.overall ?? 100))
        .map((r) => r.id),
      this.plugin.manifest.id
    );

    if (candidates.length < 2) {
      new Notice("Bisect needs at least two enabled plugins to search.");
      return;
    }

    // Checked before the modal, not after it. Offering to start a search and
    // then refusing at the moment of confirmation is the same information
    // delivered at the worst point.
    if (!this.plugin.canPersist) {
      new Notice(
        "FlowKit can't start a search while it can't save its settings: the record of which " +
          "plugins to switch back on afterwards wouldn't survive a restart. Restart Obsidian first.",
        10_000
      );
      return;
    }

    new BisectStartModal(this.app, {
      candidateCount: candidates.length,
      maxRounds: roundsNeeded(candidates.length),
      snapshotName: AUTO_SNAPSHOT,
      onConfirm: (symptom) => {
        void this.runBisectAction(async () => {
          await this.plugin.startBisect(candidates, symptom || undefined);
        });
      },
    }).open();
  }

  private saveProfile(): void {
    if (!this.plugin.isPro) {
      this.openUpgrade("profiles");
      return;
    }
    const count = this.results.filter((r) => r.enabled).length;
    new SaveProfileModal(this.app, {
      count,
      existing: this.plugin.settings.profiles,
      onConfirm: (name) => {
        this.act(
          this.plugin.saveCurrentProfile(name).then((stored) => {
            // Reporting a save that FlowKit refused to make is the small
            // version of the same lie the banner exists to prevent.
            new Notice(
              stored
                ? `Saved “${name}”.`
                : `Couldn't save “${name}” — FlowKit can't write its settings file this session.`,
              stored ? undefined : 8000
            );
            this.render();
          }),
          `Couldn't save “${name}”`
        );
      },
    }).open();
  }

  /** Switch to a saved set, after showing exactly what it would change. */
  private applyProfile(profile: PluginProfile): void {
    // Switching sets mid-search would silently replace the round's plugin set
    // with a different one, and the next answer would then be about a vault the
    // search never asked a question about.
    if (this.plugin.bisect && !this.plugin.bisect.done) {
      new Notice("Finish or stop the plugin search first — switching sets would change the plugins it is testing.", 8000);
      return;
    }
    if (!this.plugin.isPro) {
      this.openUpgrade("profiles");
      return;
    }
    const delta = this.plugin.deltaFor(profile);
    if (isNoop(delta)) {
      new Notice(`“${profile.name}” is already what you're running.`);
      return;
    }
    const name = (id: string): string =>
      this.results.find((r) => r.id === id)?.name ?? id;
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

    new BulkConfirmModal(this.app, {
      title: `Switch to “${profile.name}”?`,
      intro: `${delta.enable.length} on, ${delta.disable.length} off. Nothing is uninstalled, and you can undo this straight after.`,
      rows,
      confirmLabel: "Switch",
      onConfirm: () => void this.runApplyProfile(profile),
    }).open();
  }

  private async runApplyProfile(profile: PluginProfile): Promise<void> {
    const applied = await this.plugin.applyProfile(profile);
    if (applied.enable.length || applied.disable.length) {
      this.lastBulk = {
        label: `Switched to “${profile.name}”`,
        revert: async () => {
          // The exact inverse of what was actually changed, not of what was
          // requested — so undo can't switch on something that was already off.
          const off = await this.plugin.disableMany(applied.enable);
          const on = await this.plugin.enableMany(applied.disable);
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
    await this.refresh(false, false);
  }

  /** Star or unstar a plugin, without rescanning — it changes no score. */
  private async toggleWatch(r: PluginHealth): Promise<void> {
    const watching = await this.plugin.toggleWatch(r.id);
    r.watched = watching;
    this.invalidateDerived();
    new Notice(
      watching
        ? `Watching ${r.name} — FlowKit will lead with it when something changes.`
        : `No longer watching ${r.name}.`
    );
    const scrollTop = this.contentEl.scrollTop;
    const focusedId = this.focusedRowId();
    this.render();
    this.contentEl.scrollTop = scrollTop;
    this.restoreFocus(focusedId);
  }

  private scoreCell(
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
        "removed from the community directory at 30. Click a column to " +
        "sort; use the ⋮ menu to enable/disable, open, watch, or mute.",
    });

    // Said in the product, not only in the README. A letter grade is a
    // confident-looking artifact and people read it as a verdict on the
    // software, which is a claim this cannot support and has never made.
    const limits = legend.createDiv({ cls: "flowkit-legend-limits" });
    limits.createEl("strong", { text: "What this score is not: " });
    limits.createSpan({
      text:
        "it is not a judgement of whether a plugin is any good, whether its " +
        "code is safe, or whether you should keep it. It measures whether it " +
        "can run here, whether it has thrown errors on this machine, whether " +
        "it is still being worked on, and what it costs to load. A plugin you " +
        "love can score badly for being finished; a plugin you never use can " +
        "score perfectly. Popularity is context, not health — a niche plugin " +
        "is not a worse plugin. Treat a low score as a reason to look, not a " +
        "reason to uninstall.",
    });
  }

  // --- upgrade + export -----------------------------------------------------

  /** The one way to reach the upgrade path, from anywhere in the view. */
  private openUpgrade(
    feature?: "bisect" | "profile" | "profiles" | "export" | "history" | "monitoring" | "errors"
  ): void {
    // Built from this vault, not from the catalogue. The headline used to
    // count fixable plugins, which is now a free capability — so it promised
    // something the buyer already had.
    const enabled = this.results.filter((r) => r.enabled).length;
    const headline =
      feature === "bisect" && enabled > 1
        ? `Isolate the culprit among your ${enabled} plugins in ${roundsNeeded(enabled)} questions.`
        : feature === "profile" && enabled > 0
          ? `Time all ${enabled} of your enabled plugins in one pass.`
          : undefined;
    new UpgradeModal(this.app, {
      feature,
      headline,
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
    // No re-render. It existed only to repaint the Export button's padlock,
    // and a full render throws the reader back to the top of the page — after
    // an action that changed nothing on screen.
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
    const grade = this.gradeNow(s);
    const lines: string[] = [];
    lines.push("# Plugin Health Report");
    lines.push("");
    lines.push(
      `> Generated by FlowKit on ${when} · ${this.coverage.stats ? "online" : "local signals only"} · ${rows.length} plugin(s)`
    );
    lines.push("");
    // The report leaves the vault, so it has to be at least as careful as the
    // screen. Withholding on screen and printing a confident letter into
    // somebody else's issue tracker is the worse half of the same mistake.
    lines.push(
      this.canGrade(s)
        ? `**Vault health: ${s.avg == null ? "—" : s.avg}/100 (Grade ${grade.letter})** — ${grade.verdict}`
        : `**Vault health: ${s.avg == null ? "—" : s.avg}/100 — ungraded.** ${grade.verdict}`
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
    const insights = this.insights();
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
        "capped at 20; one removed from the community directory at 30. " +
        "Footprint is what a plugin costs to run: code loaded at startup, " +
        "measured load time where FlowKit witnessed the load, and any fast " +
        "repeating timer it holds."
    );
    lines.push("");
    // The report is the artefact that leaves the vault, so the caveat has to
    // travel with it. A letter grade quoted out of context in someone's issue
    // tracker is exactly the misreading this paragraph exists to prevent.
    lines.push(
      "*This is not a judgement of whether a plugin is any good, whether its " +
        "code is safe, or whether it should be uninstalled. It measures whether " +
        "a plugin can run on this setup, whether it has thrown errors on this " +
        "machine, whether it is still being worked on, and what it costs to " +
        "load. A finished plugin can score badly for being finished.*"
    );
    lines.push("");
    // What Pro actually is, as of 1.4.0. This footer still advertised bulk
    // fixes and unlimited reports — both free for a year — which meant the one
    // artefact that leaves the vault, into other people's issue trackers, was
    // selling a version of the product that no longer exists.
    lines.push(
      this.plugin.isPro
        ? `Generated by ${PRODUCT_NAME}.`
        : `Generated by ${PRODUCT_NAME}. The diagnosis above is free. Pro (${PRO_PRICE}) adds the search for what's breaking your vault, full startup profiling, saved plugin sets, background monitoring, stack traces and CSV export.`
    );
    lines.push("");
    return lines.join("\n");
  }

  private buildReportCsv(rows: PluginHealth[]): string {
    // Quoted AND defanged. A leading =, +, - or @ makes a spreadsheet treat the
    // cell as a formula on open, and every value below is a plugin manifest
    // field — attacker-controlled for anyone who sideloads. `showDisabled`
    // defaults on, so a plugin that has never been enabled, and whose code has
    // therefore never run, still reaches this file.
    const esc = (v: string) =>
      `"${(FORMULA_LEAD.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;
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
      r.repoActivity?.archived ? "Archived" : "",
      r.enabled ? "" : "Disabled",
      r.muted ? "Muted" : "",
      r.watched ? "Watching" : "",
    ]
      .filter(Boolean)
      .join(", ");
  }
}

/** Name the plugins that would not move, rather than pointing at the console. */
function describeFailed(failed: LifecycleFailure[]): string {
  const names = failed.map((f) => f.id).join(", ");
  return `${names} wouldn't switch — change ${
    failed.length === 1 ? "it" : "them"
  } from Settings → Community plugins.`;
}

function rowsLabel(n: number): string {
  return `${n} plugin${n === 1 ? "" : "s"}`;
}

/** How long error-watching has been running, in words. */
function describeWatched(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  if (days < 1) {
    const hours = Math.max(1, Math.floor(ms / 3_600_000));
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${days} day${days === 1 ? "" : "s"}`;
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
