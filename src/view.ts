import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type { DataCoverage, PluginHealth } from "./types";
import { SCORING_MODEL } from "./types";
import type { ScanPhase } from "./main";
import { buildInsights, type Insight } from "./insights";
import { clearCooldown } from "./dataSources";
import { conflictsFor, type Conflict } from "./conflicts";
import { roundsNeeded } from "./bisect";
import { UpgradeModal } from "./ui/UpgradeModal";
import type FlowKitHealthPlugin from "./main";
import {
  type Tone,
  type SortKey,
  type FilterKey,
  FILTERS,
  gradeFor,
  type SummaryStats,
  SEARCH_DEBOUNCE_MS,
  GRADE_WITHHELD,
  describeWhen,
} from "./dashboard/format";
import { canGrade, computeSummaryStats, visibleRows } from "./dashboard/derive";
import {
  renderChanges,
  renderCorrelations,
  renderAppUpdate,
  renderLapsedMutes,
  renderIntro,
  renderCoverageNotice,
  renderUnreadable,
  renderUndoBar,
  renderHealthSessions,
} from "./dashboard/banners";
import { renderHero, renderSummary, renderTrends, renderLegend } from "./dashboard/summary";
import { renderInsights } from "./dashboard/insights";
import { renderBisect, renderSalvage } from "./dashboard/bisectPanel";
import { renderTable } from "./dashboard/table";
import {
  profilableIds,
  startProfileAll,
  startExperiment,
  startSafeMode,
  startBisect,
  saveProfile,
  applyProfile,
} from "./dashboard/vaultActions";
import { onExportClick } from "./dashboard/exports";

export const VIEW_TYPE_HEALTH = "flowkit-health-dashboard";

/**
 * The dashboard view: lifecycle, the scan queue, page composition, the header
 * and the toolbar. The sections, the table, the search panel, the reports and
 * everything that changes the vault live in src/dashboard/, as functions that
 * take this view as their first argument. Members without `private` are the
 * state and helpers those modules share.
 */
export class HealthDashboardView extends ItemView {
  plugin: FlowKitHealthPlugin;
  results: PluginHealth[] = [];
  coverage: DataCoverage = { stats: false, list: false, disabled: false };
  private loading = false;
  /** Set when a scan threw, so the view offers a way out instead of a dead spinner. */
  private scanError: string | null = null;
  /** In-flight guard: two concurrent scans would race results and double-write. */
  refreshing = false;
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
  /** Callers waiting on the queued scan, told whether it produced fresh results. */
  private pendingWaiters: Array<(fresh: boolean) => void> = [];
  /** A failed history write is said once per session, not on every scan. */
  private historyWarned = false;
  /** The results region, rebuilt on its own when search/filter/sort change. */
  rowsEl: HTMLElement | null = null;
  /** Live "N of M" readout in the toolbar. */
  private countEl: HTMLElement | null = null;
  /** The row whose reasoning panel is open, if any. */
  expandedId: string | null = null;
  /** The last bulk action, so it can be undone for the rest of the session. */
  lastBulk: { label: string; revert: () => Promise<void> } | null = null;
  /** Plugins competing for the same shortcut or command name, read per scan. */
  conflicts: Conflict[] = [];
  /** Mutes that lapsed since the last render, shown once. */
  lapsedMutes: string[] = [];

  // View controls
  search = "";
  filter: FilterKey = "all";
  sortKey: SortKey = "overall";
  // Ascending: worst first. The whole product exists to surface the plugin you
  // should worry about, and it used to open sorted best-first, putting that
  // plugin at the bottom of the list, below the fold.
  sortDir: 1 | -1 = 1;
  /** When set, the table is scoped to exactly the cohort a finding counted. */
  scopeInsight: Insight | null = null;
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
  forceRetry(): void {
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
  act(work: Promise<unknown>, failure: string): void {
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
  async refresh(force = false, allowFetch = true): Promise<boolean> {
    // A second concurrent scan would race `this.results` and double-write the
    // same snapshot. Queue it rather than dropping it: an action taken during
    // an in-flight scan (disable a plugin while Refresh is running) would
    // otherwise complete for real and then render pre-action state.
    if (this.refreshing) {
      this.pendingRefresh = true;
      this.pendingForce ||= force;
      this.pendingAllowFetch ||= allowFetch;
      // Resolved once the queued scan has run. Resolving straight away let a
      // caller that needs the rescan ("Compare after changes") read the
      // previous one and record it as the result.
      return new Promise((resolve) => this.pendingWaiters.push(resolve));
    }
    this.refreshing = true;

    const firstRun = this.results.length === 0;
    let fresh = false;

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
      // Otherwise the status bar keeps quoting the last background pass — so
      // acting on a bulk fix left it reading "5 to fix" for hours afterwards.
      // Before the bookkeeping below, which can fail on its own.
      this.plugin.updateStatusBar(
        s.avg,
        this.results.filter((r) => !r.muted)
      );
      fresh = true;
      // The scan is done; what follows only records it. A rejected write here
      // (read-only or sync-locked vault) used to land in the scan's own catch,
      // so a current report was shown under "that refresh didn't finish", and
      // the steps after the failed one were skipped on every scan.
      try {
        await this.plugin.recordHealthReading(this.results);
        await this.plugin.updateLastKnownGood(this.results);
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
      } catch (err) {
        console.error("FlowKit: the scan finished, but its history couldn't be saved", err);
        if (!this.historyWarned) {
          this.historyWarned = true;
          new Notice(
            "FlowKit scanned your plugins but couldn't save the result to its history. " +
              "The report is current; trends and change tracking resume once the settings file can be written.",
            10_000
          );
        }
      }
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
        const scope = this.scopeInsight;
        // A single-plugin scope ("Disable these first") is not a finding, so it
        // can't be re-resolved from the findings; it holds while its plugin does.
        this.scopeInsight = scope.id.startsWith("plugin:")
          ? this.results.some((r) => scope.ids.includes(r.id))
            ? scope
            : null
          : (this.insights().find((i) => i.id === scope.id) ?? null);
      }
      // Read now, not before the scan. The user may have scrolled or moved to
      // another row while it ran, and putting them back where they were when
      // it started pulls them away from where they are.
      const scrollTop = this.contentEl.scrollTop;
      const focusedId = this.focusedRowId();
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
        const waiters = this.pendingWaiters.splice(0);
        const next = await this.refresh(queuedForce, queuedFetch);
        for (const resolve of waiters) resolve(next);
      }
    }
    return fresh;
  }



  /**
   * Whether this row is FlowKit itself. Its row offers nothing that switches
   * it off: doing that unloads the code running the action, which then
   * carries on in a dead instance (see main.setPluginEnabled).
   */
  isSelf(r: PluginHealth): boolean {
    return r.id === this.plugin.manifest.id;
  }

  /**
   * Refuse an action that reads or changes the plugin set while a search has
   * it half switched off. Whatever it recorded or restored would be the
   * search's set, not the user's.
   */
  refuseDuringSearch(why: string): boolean {
    if (!this.plugin.bisectOwnsPage()) return false;
    new Notice(`Finish or stop the plugin search first — ${why}.`, 8000);
    return true;
  }

  /** The plugin id of the row currently holding focus, if any. */
  focusedRowId(): string | null {
    const active = this.contentEl.ownerDocument.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    const row = active.closest<HTMLElement>("[data-plugin-id]");
    return row?.dataset.pluginId ?? null;
  }

  /** Return focus to the row the user was on before the re-render. */
  restoreFocus(id: string | null): void {
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
  insights(): Insight[] {
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

  invalidateDerived(): void {
    this.derived = {};
  }

  summaryStats(): SummaryStats {
    const cached = this.derived.stats;
    if (cached) return cached;
    const stats = computeSummaryStats(this.results);
    this.derived.stats = stats;
    return stats;
  }

  /**
   * Per-scan indexes for the things the render path asks for row by row.
   *
   * The search haystack was rebuilt and lowercased for every plugin on every
   * keystroke, and the conflict list was scanned linearly once per row per
   * render. Neither changes between scans.
   */
  private haystacks = new Map<string, string>();
  clashCounts = new Map<string, number>();

  private indexRows(): void {
    this.haystacks.clear();
    this.clashCounts.clear();
    for (const r of this.results) {
      this.haystacks.set(r.id, `${r.name} ${r.author} ${r.id}`.toLowerCase());
      this.clashCounts.set(r.id, conflictsFor(this.conflicts, r.id).length);
    }
  }

  visibleRows(): PluginHealth[] {
    return visibleRows(this.results, {
      search: this.search,
      filter: this.filter,
      scope: this.scopeInsight,
      sortKey: this.sortKey,
      sortDir: this.sortDir,
      haystacks: this.haystacks,
    });
  }

  toggleSort(key: SortKey): void {
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
  applyScope(scope: FilterKey | Insight): void {
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

  /**
   * Rebuild the page.
   *
   * Background rescans call this every few seconds while a watcher is busy,
   * and a rebuild replaces the search box. So the box's state is carried
   * across: text typed but not yet applied is applied rather than dropped,
   * and a focused box gets its focus and caret back. Element refs are cleared
   * first, so a branch that doesn't build the table (loading, bisect) can't
   * leave them pointing at detached nodes.
   */
  render(): void {
    const caret = this.captureSearchInput();
    this.rowsEl = null;
    this.countEl = null;
    this.toolbarEl = null;
    this.filterSelect = null;
    this.searchInput = null;
    this.scopeChipEl = null;
    this.renderPage();
    const input = this.searchInput as HTMLInputElement | null;
    if (caret && input) {
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(Math.min(caret.start ?? end, end), Math.min(caret.end ?? end, end));
    }
  }

  /** The search box's caret, if it has focus, after adopting any text not yet applied. */
  private captureSearchInput(): { start: number | null; end: number | null } | null {
    const input = this.searchInput;
    if (!input || !input.isConnected) return null;
    if (this.searchTimer != null) {
      this.cancelSearchFlush();
      this.search = input.value;
      this.scopeInsight = null;
    }
    if (input.ownerDocument.activeElement !== input) return null;
    return { start: input.selectionStart, end: input.selectionEnd };
  }

  private renderPage(): void {
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
      renderUnreadable(this, root);
      renderBisect(this, root);
      renderSalvage(this, root);
      return;
    }
    renderSalvage(this, root);
    renderUnreadable(this, root);
    renderBisect(this, root);
    renderAppUpdate(this, root);
    renderChanges(this, root);
    renderCorrelations(this, root);
    renderHealthSessions(this, root);
    renderLapsedMutes(this, root);
    renderIntro(this, root);
    renderHero(this, root);
    renderCoverageNotice(this, root);
    renderUndoBar(this, root);
    // The to-do list, then the evidence. It used to sit below four stat tiles
    // and a trend chart, which is a spreadsheet-first ordering for a product
    // whose entire value is the ranked list of what to do — and on a phone it
    // put the answer a full screen below the question.
    renderInsights(this, root);
    renderSummary(this, root);
    renderTrends(this, root);
    this.renderToolbar(root);

    // Everything above depends only on the scan; everything below depends on
    // the search/filter/sort. Keeping them apart is what lets a keystroke
    // rebuild ~40 table rows instead of the entire dashboard — which is what
    // used to destroy the search box mid-word and force the caret to the end.
    this.rowsEl = root.createDiv({ cls: "flowkit-rows" });
    this.renderRows();
    renderLegend(this, root);
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
    renderTable(this, host, rows);
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
      exportBtn.onclick = (evt) => onExportClick(this, evt);
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
    // Not while a search owns the page: everything in it either changes which
    // plugins are on or records the current set, and right now that set is
    // the search's, not the user's.
    if (!this.loading && this.results.length > 0 && !this.plugin.bisectOwnsPage()) {
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
        .onClick(() => startBisect(this))
    );

    menu.addItem((item) =>
      item
        .setTitle(this.plugin.isPro ? "Profile startup…" : "Profile startup… (Pro)")
        .setIcon("timer")
        .onClick(() => startProfileAll(this, profilableIds(this)))
    );

    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(this.plugin.isPro ? "Save this plugin set…" : "Save this plugin set… (Pro)")
        .setIcon("bookmark")
        .onClick(() => saveProfile(this))
    );

    menu.addItem((item) =>
      item
        .setTitle(this.plugin.isPro ? "Start safe mode…" : "Start safe mode… (Pro)")
        .setIcon("shield-check")
        .onClick(() => startSafeMode(this))
    );
    menu.addItem((item) =>
      item
        .setTitle("Start before/after health experiment")
        .setIcon("flask-conical")
        .onClick(() => startExperiment(this))
    );

    const profiles = this.plugin.settings.profiles;
    for (const profile of profiles) {
      menu.addItem((item) =>
        item
          .setTitle(`Switch to “${profile.name}”`)
          .setIcon("layers")
          .onClick(() => applyProfile(this, profile))
      );
    }

    menu.showAtMouseEvent(evt);
  }

  /** Whether this scan can be graded. The rule, and why, is in derive.canGrade. */
  canGrade(s: SummaryStats): boolean {
    return canGrade(s, this.coverage.stats);
  }

  /** The grade for this scan, or the withheld one. */
  gradeNow(s: SummaryStats): { letter: string; tone: Tone; verdict: string } {
    return this.canGrade(s) ? gradeFor(s.avg) : GRADE_WITHHELD;
  }






  /** Set while this view is driving a bisect transition. */
  bisectBusy = false;

















  // --- insights -------------------------------------------------------------














  // --- trends (Pro) ---------------------------------------------------------



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
    startBisect(this);
  }

  async commandProfile(): Promise<void> {
    if (!this.results.length) await this.refresh(false, false);
    startProfileAll(this, profilableIds(this));
  }

  async commandSaveSet(): Promise<void> {
    if (!this.results.length) await this.refresh(false, false);
    saveProfile(this);
  }

  async commandSafeMode(): Promise<void> {
    if (!this.results.length) await this.refresh(false, false);
    startSafeMode(this);
  }

  async commandExperiment(): Promise<void> {
    if (!this.results.length) await this.refresh(false, false);
    startExperiment(this);
  }










  // --- upgrade + export -----------------------------------------------------

  /** The one way to reach the upgrade path, from anywhere in the view. */
  openUpgrade(
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
        // Verified before it is saved. Saving first meant a failed write (a
        // read-only or sync-locked vault) skipped verification, and a valid key
        // stayed inactive for the rest of the session.
        const flipped = this.plugin.refreshLicense();
        try {
          await this.plugin.saveSettings();
        } catch (err) {
          console.error("FlowKit: could not save the licence key", err);
          if (this.plugin.isPro) {
            new Notice(
              "Pro is active for this session, but FlowKit couldn't save the key. Paste it again after a restart.",
              10_000
            );
          }
        }
        if (flipped && this.plugin.isPro) {
          await this.refresh(false, false);
          return true;
        }
        return this.plugin.isPro;
      },
    }).open();
  }







}
