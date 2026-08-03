import { Notice, Platform, Plugin, WorkspaceLeaf, apiVersion } from "obsidian";
import type { PluginManifest } from "obsidian";
import { HealthDashboardView, VIEW_TYPE_HEALTH } from "./view";
import {
  buildRemoteCache,
  classifyListing,
  computeHealth,
  deriveMaintenanceStatus,
  mergeRemoteCache,
  rankerFromDistribution,
  remoteFromCache,
} from "./scoring";
import {
  describeFailure,
  fetchCommunityList,
  fetchRemoteStats,
} from "./dataSources";
import { ErrorWatcher } from "./errorWatcher";
import { pruneErrorLog } from "./errors";
import { diffTrouble, sameKinds } from "./changes";
import { RuntimeWatcher } from "./runtimeWatcher";
import { pruneProfiles, type RuntimeProfiles } from "./runtime";
import { buildMute, migrateMutes, sweepMutes, type MuteRecord } from "./mutes";
import {
  fetchRepoActivity,
  pruneRepoActivity,
  REPO_BUDGET_PER_SCAN,
  selectForLookup,
  type RepoActivityMap,
} from "./repoActivity";
import { findConflicts, type Conflict, type CommandRow, type Hotkey } from "./conflicts";
import {
  beginBisect,
  bisectStep,
  desiredState,
  restoreState,
  searchableCandidates,
  type BisectState,
} from "./bisect";
import {
  correlate,
  diffInstalled,
  pruneEvents,
  type Correlation,
  type PluginEvent,
} from "./timeline";
import {
  AUTO_SNAPSHOT,
  deleteProfile,
  profileDelta,
  saveProfile,
  type PluginProfile,
  type ProfileDelta,
} from "./profiles";
import { LicenseManager } from "./license/LicenseManager";
import {
  DEFAULT_SETTINGS,
  FlowKitHealthSettingTab,
  FlowKitHealthSettings,
} from "./settings";
import type {
  DataCoverage,
  HealthChange,
  HealthChangeKind,
  HealthSnapshot,
  PluginHealth,
  RemoteCache,
} from "./types";
import { SCORING_MODEL } from "./types";

/** Obsidian's internal plugin registry — not in the public typings. */
interface InternalPluginsApi {
  manifests: Record<string, PluginManifest>;
  enabledPlugins: Set<string>;
  enablePluginAndSave?: (id: string) => Promise<boolean>;
  disablePluginAndSave?: (id: string) => Promise<boolean>;
}

/** Obsidian's internal settings window. */
interface InternalSettingApi {
  open: () => void;
  openTabById: (id: string) => void;
}

/** One entry in Obsidian's command registry. */
interface InternalCommand {
  id?: string;
  name?: string;
  hotkeys?: Hotkey[];
}

type AppInternals = {
  plugins: InternalPluginsApi;
  setting?: InternalSettingApi;
  commands?: { commands?: Record<string, InternalCommand> };
  hotkeyManager?: { customKeys?: Record<string, Hotkey[]> };
};

/** Cap on stored trend snapshots — plenty for a readable history. */
const MAX_HISTORY = 90;

/**
 * How long the persisted community projection is served before a refresh is
 * attempted. Download counts and release dates move on the scale of days, so a
 * day-old reading is not meaningfully worse than a fresh one — and it means the
 * dashboard paints instantly instead of blocking on ~3.7 MB of JSON.
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** How often the background pass runs while Obsidian stays open. */
const MONITOR_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Cap on the recorded change log. */
const MAX_CHANGES = 60;

/**
 * How often a watcher may trigger a re-score while a dashboard is open.
 *
 * Rescoring is local and cheap, but it stats every plugin's files and writes a
 * snapshot, so it is not free enough to run on every observed error during a
 * burst.
 */
const LOCAL_RESCAN_THROTTLE_MS = 15_000;

/** A displayed scan older than this is refreshed when the view is next looked at. */
const STALE_SCAN_MS = 30_000;

export default class FlowKitHealthPlugin extends Plugin {
  settings: FlowKitHealthSettings = DEFAULT_SETTINGS;

  /** Pro entitlement, derived from the license key on load / change. */
  isPro = false;
  licenseEmail?: string;
  licenseError?: string;

  // The session-only cache of the raw multi-MB feeds is gone: the slim
  // projection in `settings.cache` survives restarts, which is what actually
  // makes the dashboard open instantly.

  /** Always-visible health readout in the status bar. */
  private statusBarEl: HTMLElement | null = null;

  /** Attributes runtime errors to the plugin that threw them. */
  private errorWatcher: ErrorWatcher | null = null;

  /** Measures what plugins cost while running: load time and repeating timers. */
  private runtimeWatcher: RuntimeWatcher | null = null;

  /** Shared between concurrent scans, so one cold start means one download. */
  private inFlightFetch: Promise<RemoteCache | null> | null = null;

  /** Guards the background repository lookups against overlapping batches. */
  private repoLookupInFlight = false;

  /** When the last watcher-triggered local rescan ran. */
  private lastLocalRescan = 0;

  /**
   * Mutes that lapsed during the last scan. Surfaced once, so a plugin
   * reappearing in the counts reads as an event rather than a glitch.
   */
  lapsedMutes: string[] = [];

  async onload(): Promise<void> {
    await this.loadSettings();
    this.refreshLicense();

    this.registerView(
      VIEW_TYPE_HEALTH,
      (leaf) => new HealthDashboardView(leaf, this)
    );

    this.addRibbonIcon("activity", "Open FlowKit Health Dashboard", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-health-dashboard",
      name: "Open health dashboard",
      callback: () => void this.activateView(),
    });

    this.addSettingTab(new FlowKitHealthSettingTab(this.app, this));

    if (this.settings.trackErrors) {
      if (this.settings.watchingSince == null) {
        this.settings.watchingSince = Date.now();
        await this.saveSettings();
      }
      this.errorWatcher = new ErrorWatcher(this, {
        installedIds: () => new Set(Object.keys(this.pluginsApi().manifests ?? {})),
        log: () => this.settings.errorLog,
        onChange: () => {
          // Re-score, not just repaint: an error that just landed changes
          // Reliability, and repainting the previous scan hides it.
          void this.saveSettings().then(() => this.requestLocalRescan());
        },
      });
      this.errorWatcher.start(this.settings.trackConsoleErrors);
    }

    if (this.settings.trackRuntime) {
      this.runtimeWatcher = new RuntimeWatcher(this.app, {
        installedIds: () => new Set(Object.keys(this.pluginsApi().manifests ?? {})),
        store: () => this.settings.runtimeProfiles,
        versionOf: (id) => this.pluginsApi().manifests?.[id]?.version,
        onChange: () => {
          // The first flush lands ~5s after startup, by which time a polling
          // plugin has actually polled — which is the only reason the runtime
          // signals ever appear on a dashboard opened at launch.
          void this.saveSettings().then(() => this.requestLocalRescan());
        },
      });
      // Started before anything else touches the plugin registry, so the
      // remaining plugins Obsidian loads after us are timed rather than missed.
      this.runtimeWatcher.start();
    }

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("flowkit-status-item");
    this.statusBarEl.addEventListener("click", () => void this.activateView());

    // Everything below is why the plugin exists after the first week. Until
    // now it registered a ribbon icon and one command and nothing else, so
    // plugin health was a curiosity satisfied exactly once: install, see a
    // grade, disable two things, never reopen.
    this.app.workspace.onLayoutReady(() => {
      void this.checkAppVersion().then(() => this.backgroundScan());
    });
    this.registerInterval(
      window.setInterval(() => void this.backgroundScan(), MONITOR_INTERVAL_MS)
    );
  }

  onunload(): void {
    // Leaves of our view type are detached automatically by Obsidian, and the
    // error listeners went through registerDomEvent — but console.error,
    // setInterval and the plugin loader were monkey-patched, so those have to
    // be put back by hand.
    this.errorWatcher?.stop();
    this.runtimeWatcher?.stop();
  }

  /**
   * Did Obsidian itself change under us?
   *
   * This is the moment people open a plugin-health dashboard: something stopped
   * working straight after an update. Recording the transition — and which
   * plugins could load before and can't now — is what lets the answer be "here
   * is what that update broke" instead of a general list of what is wrong.
   */
  private async checkAppVersion(): Promise<void> {
    const previous = this.settings.lastApiVersion;
    if (previous === apiVersion) return;

    if (previous == null) {
      // First run since this feature shipped: record the baseline silently,
      // exactly as the change log does. Announcing an "update" that is really
      // just FlowKit noticing for the first time would be a fabricated event.
      this.settings.lastApiVersion = apiVersion;
      await this.saveSettings();
      return;
    }

    // Scan BEFORE recording the new version. `computeAll` persists on its own
    // when it prunes, and a save landing between the two would leave the new
    // version stored with no record of what the update did — so the one scan
    // that could have answered "what did that break" never happens.
    const { results } = await this.computeAll({ allowFetch: false });
    const broke = results.filter(
      (r) => r.enabled && r.metrics.compatibility.value === 0
    );
    this.settings.lastApiVersion = apiVersion;
    this.settings.appVersionChange = {
      at: Date.now(),
      from: previous,
      to: apiVersion,
      brokeIds: broke.map((r) => r.id),
    };
    await this.saveSettings();
    if (broke.length) {
      new Notice(
        `FlowKit: Obsidian ${apiVersion} can't run ${broke.length} of your plugin${
          broke.length === 1 ? "" : "s"
        } — ${broke.slice(0, 3).map((r) => r.name).join(", ")}.`,
        10_000
      );
    }
    this.refreshViews(true);
  }

  /** Whether the Obsidian-update banner still has something to say. */
  recentAppUpdate(): typeof this.settings.appVersionChange {
    const change = this.settings.appVersionChange;
    if (!change) return null;
    const seen = this.settings.lastSeenChangeAt ?? 0;
    return change.at > seen ? change : null;
  }

  /**
   * Score the vault without opening anything: keeps the daily trend reading
   * honest whether or not the user visits, updates the status bar, and (Pro)
   * reports plugins that have newly gone bad.
   */
  private async backgroundScan(): Promise<void> {
    try {
      // Monitoring is the one thing that legitimately needs the network without
      // the user present: "this plugin was pulled from the directory" is a fact
      // that exists only in the community list, so a pass that can't fetch can
      // never report it. Gated on the user having explicitly switched
      // monitoring on, and on enrichment being allowed at all; for everyone
      // else this pass is purely local and works from whatever is cached.
      const monitoring =
        this.isPro &&
        this.settings.backgroundMonitoring &&
        this.settings.enableOnlineEnrichment;
      const { results, coverage } = await this.computeAll({ allowFetch: monitoring });
      const active = results.filter((r) => !r.muted);
      const scored = active.map((r) => r.overall).filter((v): v is number => v != null);
      const avg = scored.length
        ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length)
        : null;
      const confidence = active.length
        ? active.reduce((a, r) => a + r.confidence, 0) / active.length
        : 0;

      await this.recordSnapshot({
        at: Date.now(),
        avg,
        count: active.length,
        atRisk: active.filter((r) => r.overall != null && r.overall < 50).length,
        unmaintained: active.filter((r) => r.maintenanceStatus === "unmaintained").length,
        updates: active.filter((r) => r.updateAvailable).length,
        online: coverage.stats,
        confidence,
        model: SCORING_MODEL,
      });

      this.updateStatusBar(avg, active);
      if (this.isPro && this.settings.backgroundMonitoring) {
        await this.reportRegressions(results, coverage);
      } else {
        // Still record the transitions — the dashboard leads with them for
        // everyone; only the Notice is Pro.
        await this.diffChanges(results, coverage);
      }
    } catch (err) {
      // A background pass must never surface as a broken plugin.
      console.error("FlowKit: background scan failed", err);
    }
  }

  /**
   * A quiet, always-visible health readout that opens the dashboard.
   *
   * Named, not vague. "3 to fix" is a red badge with no content, and a red
   * badge with no content is one people learn to stop seeing within a week —
   * whereas "1 won't load · 2 errors" is a sentence you can act on or dismiss
   * without opening anything.
   */
  updateStatusBar(avg: number | null, active: PluginHealth[]): void {
    if (!this.statusBarEl) return;
    const enabled = active.filter((r) => r.enabled);
    const wontLoad = enabled.filter((r) => r.metrics.compatibility.value === 0).length;
    const delisted = enabled.filter((r) => r.listing === "delisted").length;
    const erroring = enabled.filter((r) => (r.errors?.uncaught ?? 0) > 0).length;
    const updates = active.filter((r) => r.updateAvailable).length;

    // Ordered by how much it matters, and capped at two clauses: a status bar
    // shares a strip with everything else in Obsidian, and a four-part readout
    // gets truncated into nonsense on a narrow window.
    const urgentParts: string[] = [];
    if (wontLoad) urgentParts.push(`${wontLoad} won't load`);
    if (delisted) urgentParts.push(`${delisted} delisted`);
    if (erroring) urgentParts.push(`${erroring} erroring`);
    const parts = urgentParts.length ? urgentParts : [];
    if (updates && parts.length < 2) parts.push(`${updates} update${updates === 1 ? "" : "s"}`);

    const urgent = urgentParts.length > 0;
    this.statusBarEl.empty();
    this.statusBarEl.toggleClass("is-alert", urgent);
    this.statusBarEl.setText(
      parts.length
        ? `Plugins: ${parts.slice(0, 2).join(" · ")}`
        : `Plugin health: ${avg == null ? "—" : avg}`
    );
    this.statusBarEl.setAttr(
      "aria-label",
      parts.length
        ? `${parts.join(", ")} — open FlowKit`
        : "Open FlowKit Health Dashboard"
    );
  }

  /**
   * Tell a Pro user when an enabled plugin has newly crossed into trouble —
   * most valuable right after an Obsidian update, which is exactly when nobody
   * thinks to go looking.
   */
  /** Kinds that mean something is wrong, as opposed to merely newsworthy. */
  private static readonly BAD_KINDS: HealthChangeKind[] = [
    "error-started",
    "delisted",
    "became-incompatible",
  ];

  /** Which kinds of trouble a plugin is in right now. */
  private troubleKinds(r: PluginHealth): HealthChangeKind[] {
    const kinds: HealthChangeKind[] = [];
    if (!r.enabled) return kinds;
    if ((r.errors?.uncaught ?? 0) > 0) kinds.push("error-started");
    if (r.listing === "delisted") kinds.push("delisted");
    if (r.metrics.compatibility.value === 0) kinds.push("became-incompatible");
    if (r.updateAvailable) kinds.push("update-published");
    return kinds;
  }

  /**
   * Which kinds this scan was actually able to judge. Absence of evidence is
   * not evidence of recovery: `delisted` and `update-published` both need the
   * community feeds, so a scan taken with enrichment off would otherwise
   * "resolve" every delisting and announce it as good news.
   */
  private evaluableKinds(coverage: DataCoverage): Set<HealthChangeKind> {
    const set = new Set<HealthChangeKind>(["error-started", "became-incompatible"]);
    if (coverage.list) set.add("delisted");
    if (coverage.stats) set.add("update-published");
    return set;
  }

  /**
   * Diff this scan against the last one and append what moved.
   *
   * This used to live inline, fire a Notice, and then throw the transition
   * away — so the product knew exactly what had changed and kept none of it.
   * Recorded for everyone; only the Notice stays Pro.
   */
  async diffChanges(
    all: PluginHealth[],
    coverage: DataCoverage
  ): Promise<HealthChange[]> {
    const previous = this.settings.notified;
    const { fresh, current } = diffTrouble(
      previous,
      all.map((r) => ({
        id: r.id,
        name: r.name,
        muted: r.muted,
        kinds: this.troubleKinds(r),
      })),
      this.evaluableKinds(coverage),
      Date.now()
    );

    // First run after install or upgrade: record the baseline silently. Without
    // this, every pre-existing problem and every pending update is emitted as
    // having happened "since you last looked" — so the feature's first
    // impression on every upgrading user would be a list of events that never
    // occurred.
    if (!this.settings.changeBaselineSet) {
      this.settings.changeBaselineSet = true;
      this.settings.notified = current;
      await this.saveSettings();
      return [];
    }

    if (!fresh.length && sameKinds(previous, current)) return [];

    this.settings.notified = current;
    this.settings.changeLog = [...this.settings.changeLog, ...fresh].slice(-MAX_CHANGES);
    await this.saveSettings();
    return fresh;
  }

  /** Changes the user hasn't acknowledged yet, newest last. */
  unseenChanges(): HealthChange[] {
    const since = this.settings.lastSeenChangeAt ?? 0;
    return this.settings.changeLog.filter((c) => c.at > since);
  }

  /** Mark the "since you last looked" strip as read. */
  async markChangesSeen(): Promise<void> {
    this.settings.lastSeenChangeAt = Date.now();
    await this.saveSettings();
  }

  private async reportRegressions(
    all: PluginHealth[],
    coverage: DataCoverage
  ): Promise<void> {
    const fresh = await this.diffChanges(all, coverage);
    const worrying = fresh.filter((c) => c.kind !== "resolved" && c.kind !== "update-published");
    if (!worrying.length) return;

    // Watched plugins are named first. A notice that leads with the plugin the
    // user told us they depend on is worth reading; one that leads with
    // whichever id sorted first is the same global noise as before.
    worrying.sort((a, b) => Number(this.isWatched(b.id)) - Number(this.isWatched(a.id)));
    const names = worrying.slice(0, 3).map((c) => c.name).join(", ");
    new Notice(
      `FlowKit: ${worrying.length} plugin${worrying.length === 1 ? "" : "s"} need${
        worrying.length === 1 ? "s" : ""
      } a look — ${names}${worrying.length > 3 ? ` +${worrying.length - 3} more` : ""}.`,
      8000
    );
  }

  async loadSettings(): Promise<void> {
    // `loadData()` is typed `any`; narrow it before merging so the assignment is type-safe.
    const data = (await this.loadData()) as Partial<FlowKitHealthSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    // A hand-edited or sync-mangled data.json can carry `null` where an array
    // belongs; every read below assumes array methods exist, so coerce once here
    // rather than defending at each call site.
    if (!Array.isArray(this.settings.ignored)) this.settings.ignored = [];
    if (!Array.isArray(this.settings.history)) this.settings.history = [];
    // `notified` was a flat id list before the change log existed. Migrating to
    // an empty map is deliberate: the old shape recorded only that a plugin was
    // *some* kind of bad, so there is nothing to translate into per-kind state,
    // and starting clean costs at most one duplicate notification.
    if (!this.settings.notified || Array.isArray(this.settings.notified)) {
      this.settings.notified = {};
    }
    if (!Array.isArray(this.settings.changeLog)) this.settings.changeLog = [];
    if (!this.settings.errorLog || typeof this.settings.errorLog !== "object") {
      this.settings.errorLog = {};
    }
    if (!Array.isArray(this.settings.watched)) this.settings.watched = [];
    if (!Array.isArray(this.settings.events)) this.settings.events = [];
    if (!Array.isArray(this.settings.profiles)) this.settings.profiles = [];
    if (!this.settings.seenPlugins || typeof this.settings.seenPlugins !== "object") {
      this.settings.seenPlugins = {};
    }
    // A half-written bisect is worse than none: it would claim a set of
    // plugins to restore that it can't actually name.
    const bisect = this.settings.bisect;
    if (
      bisect &&
      (!Array.isArray(bisect.candidates) ||
        !Array.isArray(bisect.originalEnabled) ||
        !Array.isArray(bisect.disabled))
    ) {
      this.settings.bisect = null;
    }
    if (!this.settings.runtimeProfiles || typeof this.settings.runtimeProfiles !== "object") {
      this.settings.runtimeProfiles = {};
    }
    if (!this.settings.repoActivity || typeof this.settings.repoActivity !== "object") {
      this.settings.repoActivity = {};
    }
    // Mutes gained a reason and an expiry in 1.3. The old flat id list becomes
    // indefinite mutes with no reason, which is exactly what they were —
    // inventing an expiry for them would silently un-mute settled decisions.
    this.settings.mutes = migrateMutes(
      this.settings.ignored,
      this.settings.mutes,
      Date.now()
    );
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * Re-verify the stored license key and update the Pro entitlement flags.
   * Returns whether `isPro` actually flipped, so callers can rebuild UI only
   * when entitlement really moved rather than on every keystroke.
   */
  refreshLicense(): boolean {
    const wasPro = this.isPro;
    const key = this.settings.licenseKey?.trim();
    if (!key) {
      this.isPro = false;
      this.licenseEmail = undefined;
      this.licenseError = undefined;
      return wasPro !== this.isPro;
    }
    const result = LicenseManager.verify(key);
    this.isPro = result.valid;
    this.licenseEmail = result.valid ? result.email : undefined;
    this.licenseError = result.valid ? undefined : result.error;
    return wasPro !== this.isPro;
  }

  /**
   * Push a settings or entitlement change into any open dashboard. Without this
   * a user who pastes a license key, or toggles a setting, sits looking at a
   * stale view and concludes nothing happened — at precisely the moment they
   * have just paid.
   */
  /**
   * Re-score from live local signals after a watcher observed something.
   *
   * The watchers used to only re-RENDER, which redraws the previous scan's
   * numbers. That made the dashboard a photograph taken at startup: the runtime
   * signals it now depends on — timers, callback cost, error counts — are all
   * things that do not exist yet a second after Obsidian loads, so a restored
   * dashboard tab would faithfully display a vault with no timers and no errors
   * for as long as it stayed open. The background pass runs every six hours,
   * which is no help at all to somebody watching the screen.
   *
   * Local-only and never fetching: nothing a watcher observes is a question the
   * network could answer.
   */
  requestLocalRescan(): void {
    const now = Date.now();
    if (now - this.lastLocalRescan < LOCAL_RESCAN_THROTTLE_MS) {
      // Too soon to re-score, but the newest counts are still worth painting.
      this.refreshViews();
      return;
    }
    this.lastLocalRescan = now;
    this.refreshViews(true, false);
  }

  /** Whether the displayed scan is old enough to be worth redoing. */
  scanIsStale(): boolean {
    const last = this.settings.lastScanAt ?? 0;
    return Date.now() - last > STALE_SCAN_MS;
  }

  refreshViews(rescan = false, allowFetch = false): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_HEALTH)) {
      const view = leaf.view;
      if (!(view instanceof HealthDashboardView)) continue;
      // Rescanning defaults to local-only. Flipping "show disabled plugins" or
      // clearing the mute list changes nothing the network could answer, and
      // each of those toggles used to be able to pull ~3.7 MB — which is how a
      // few settings clicks turn into a rate limit.
      if (rescan) void view.refresh(false, allowFetch);
      else view.rerender();
    }
  }

  /**
   * Reveal the dashboard, creating it if needed.
   *
   * Opens in a main tab, not the right sidebar. An eight-column scorecard in a
   * ~300px sidebar was hostile at the only width most users ever saw it at —
   * and `getRightLeaf` can return null on mobile, where this silently did
   * nothing at all.
   */
  async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_HEALTH)[0] ?? null;
    if (existing) {
      void workspace.revealLeaf(existing);
      return;
    }

    const leaf: WorkspaceLeaf | null =
      workspace.getLeaf("tab") ?? workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("Couldn't open the dashboard — no place to put it.");
      return;
    }
    await leaf.setViewState({ type: VIEW_TYPE_HEALTH, active: true });
    // `void` the reveal so no-floating-promises is satisfied (revealLeaf gained a
    // Promise return in 1.7.2; we don't consume it).
    void workspace.revealLeaf(leaf);
  }

  /** Obsidian's plugin registry, defaulted so a shape change degrades to an empty scan. */
  private pluginsApi(): InternalPluginsApi {
    const api = (this.app as unknown as AppInternals).plugins;
    if (!api || typeof api !== "object") {
      console.error("FlowKit: Obsidian's internal plugin registry is unavailable.");
      return { manifests: {}, enabledPlugins: new Set<string>() };
    }
    return api;
  }

  /**
   * Score every installed community plugin. Returns which enrichment sources
   * loaded so the UI can label its confidence honestly — the two community
   * files fail independently.
   *
   * @param opts.force re-download community data instead of using the cache.
   * @param opts.allowFetch whether this scan may touch the network at all. The
   *   background pass sets it false: it runs unprompted, so it works from
   *   whatever is already cached and leaves fetching to something the user
   *   actually asked for.
   */
  async computeAll(
    opts: { force?: boolean; allowFetch?: boolean } = {}
  ): Promise<{ results: PluginHealth[]; coverage: DataCoverage }> {
    const { force = false, allowFetch = true } = opts;
    const api = this.pluginsApi();
    const manifests = Object.values(api.manifests ?? {});
    const enabledSet = api.enabledPlugins ?? new Set<string>();

    const coverage: DataCoverage = {
      stats: false,
      list: false,
      disabled: !this.settings.enableOnlineEnrichment,
    };

    let cache: RemoteCache | null = null;
    if (this.settings.enableOnlineEnrichment) {
      cache = this.settings.cache;
      const stale = !cache || Date.now() - cache.at > CACHE_TTL_MS;
      if (allowFetch && (force || stale)) {
        const fetched = await this.fetchRemoteCache(
          coverage,
          new Set(manifests.map((m) => m.id))
        );
        // Keep serving the previous projection when a refresh fails, rather
        // than dropping two of five columns because GitHub had a bad minute.
        if (fetched) cache = fetched;
      }
      coverage.stats = cache?.hadStats ?? false;
      coverage.list = cache?.hadList ?? false;
    }

    const now = Date.now();
    const rank = rankerFromDistribution(cache?.distribution);
    const installedIds = new Set(manifests.map((m) => m.id));

    // A mute with an expiry has to actually expire, and the user has to be able
    // to find out that it did — otherwise a plugin silently rejoins the counts
    // and the change reads as a scoring glitch.
    const sweep = sweepMutes(this.settings.mutes, now, apiVersion);
    if (sweep.expired.length) {
      this.settings.mutes = sweep.active;
      this.lapsedMutes = sweep.expired;
      this.settings.ignored = this.settings.ignored.filter(
        (id) => !sweep.expired.includes(id)
      );
      await this.saveSettings();
    }
    const mutes = this.settings.mutes;
    const watchedIds = new Set(this.settings.watched);

    // Uninstalling a plugin should also drop everything recorded about it,
    // rather than leaving it to accumulate in data.json indefinitely.
    await this.pruneStores(installedIds);

    if (
      this.settings.checkRepoActivity &&
      this.settings.enableOnlineEnrichment &&
      allowFetch
    ) {
      // Deliberately NOT awaited. Up to six sequential API calls, each with its
      // own timeout, is a minute of spinner in the worst case — for a signal
      // that is cached for a week and changes on the scale of months. This scan
      // uses whatever is already cached; the lookups land in the background and
      // refresh the view when they do. It cannot loop: a fresh reading is not
      // stale, so the next scan selects nothing.
      void this.refreshRepoActivity(manifests, enabledSet, cache, now);
    }

    // Live timers are session state, so the snapshot is the source of truth
    // whenever the watcher is running; the persisted store is the fallback.
    const runtime: RuntimeProfiles =
      this.runtimeWatcher?.snapshot() ?? this.settings.runtimeProfiles;

    const results: PluginHealth[] = [];
    for (const manifest of manifests) {
      const enabled = enabledSet.has(manifest.id);
      if (!enabled && !this.settings.showDisabled) continue;

      const cached = cache?.plugins[manifest.id];
      const remote = remoteFromCache(cached);
      results.push(
        computeHealth(
          {
            manifest,
            enabled,
            isMobile: Platform.isMobile,
            repo: cached?.repo,
            remote,
            bundleBytes: await this.measureBundle(manifest),
            downloadPercentile: rank(cached?.downloads),
            listing: classifyListing(manifest.id, cache),
            errors: this.settings.errorLog[manifest.id],
            observedMs: this.observedMs(),
            muted: manifest.id in mutes,
            mute: mutes[manifest.id],
            watched: watchedIds.has(manifest.id),
            runtime: runtime[manifest.id],
            repoActivity: this.settings.repoActivity[manifest.id],
          },
          now
        )
      );
    }
    this.settings.lastScanAt = now;
    // Recorded last, so an event is only ever written for a scan that actually
    // produced results — a scan that threw halfway would otherwise move the
    // baseline forward and lose the change it was in the middle of noticing.
    await this.recordEvents(manifests, enabledSet, now);
    return { results, coverage };
  }

  /** Forget everything recorded about plugins that are no longer installed. */
  private async pruneStores(installed: Set<string>): Promise<void> {
    let dirty = false;
    const errors = pruneErrorLog(this.settings.errorLog, installed);
    if (Object.keys(errors).length !== Object.keys(this.settings.errorLog).length) {
      this.settings.errorLog = errors;
      dirty = true;
    }
    const profiles = pruneProfiles(this.settings.runtimeProfiles, installed);
    if (
      Object.keys(profiles).length !== Object.keys(this.settings.runtimeProfiles).length
    ) {
      this.settings.runtimeProfiles = profiles;
      dirty = true;
    }
    const repos = pruneRepoActivity(this.settings.repoActivity, installed);
    if (Object.keys(repos).length !== Object.keys(this.settings.repoActivity).length) {
      this.settings.repoActivity = repos;
      dirty = true;
    }
    if (dirty) await this.saveSettings();
  }

  /**
   * Ask GitHub about the repositories whose maintenance verdict is genuinely in
   * doubt.
   *
   * Deliberately not "every plugin with a repo". GitHub allows 60
   * unauthenticated requests an hour for the whole machine — shared with every
   * other plugin the user has installed — so the budget goes to the handful
   * where the answer changes what the user is told, and a week of caching means
   * even a large vault fills in over a few sessions.
   */
  private async refreshRepoActivity(
    manifests: PluginManifest[],
    enabledSet: Set<string>,
    cache: RemoteCache | null,
    now: number
  ): Promise<void> {
    // One batch at a time. Two scans in quick succession would otherwise both
    // see the same stale entries and issue the same requests twice.
    if (this.repoLookupInFlight) return;
    this.repoLookupInFlight = true;
    try {
      await this.doRefreshRepoActivity(manifests, enabledSet, cache, now);
    } catch (err) {
      // A background lookup must never surface as a broken plugin.
      console.error("FlowKit: repository lookups failed", err);
    } finally {
      this.repoLookupInFlight = false;
    }
  }

  private async doRefreshRepoActivity(
    manifests: PluginManifest[],
    enabledSet: Set<string>,
    cache: RemoteCache | null,
    now: number
  ): Promise<void> {
    const rows = manifests.map((m) => {
      const cached = cache?.plugins[m.id];
      const status = deriveMaintenanceStatus(cached?.updated, now, remoteFromCache(cached));
      return {
        id: m.id,
        repo: cached?.repo,
        // A plugin released this quarter is not in doubt; spending a request on
        // it would starve the ones where the verdict could actually flip.
        inDoubt: status === "aging" || status === "stable" || status === "unmaintained",
        enabled: enabledSet.has(m.id),
      };
    });
    const wanted = selectForLookup(
      rows,
      this.settings.repoActivity,
      now,
      REPO_BUDGET_PER_SCAN
    );
    if (!wanted.length) return;

    const byId = new Map(rows.map((r) => [r.id, r]));
    const next: RepoActivityMap = { ...this.settings.repoActivity };
    // Sequential on purpose: six parallel requests to one API is how a soft
    // rate limit becomes a hard one, and nothing here is time-critical.
    for (const id of wanted) {
      const repo = byId.get(id)?.repo;
      if (!repo) continue;
      next[id] = await fetchRepoActivity(repo, now);
    }
    this.settings.repoActivity = next;
    await this.saveSettings();
    // The readings only reach the user through a rescan — and this one is
    // local-only, so a lookup landing can't trigger another download.
    this.refreshViews(true, false);
  }

  /**
   * Plugins competing for the same shortcut or command name.
   *
   * Read fresh on every render rather than cached: hotkeys change the moment
   * the user rebinds one, and a stale conflict list is worse than none.
   */
  detectConflicts(): Conflict[] {
    const internals = this.app as unknown as AppInternals;
    const registry = internals.commands?.commands;
    if (!registry) return [];
    const manifests = this.pluginsApi().manifests ?? {};
    const installed = new Set(Object.keys(manifests));
    const names: Record<string, string> = {};
    for (const [id, manifest] of Object.entries(manifests)) names[id] = manifest.name;

    const commands: CommandRow[] = [];
    for (const [id, cmd] of Object.entries(registry)) {
      if (!cmd) continue;
      commands.push({ id, name: cmd.name ?? id, hotkeys: cmd.hotkeys });
    }
    return findConflicts({
      commands,
      customKeys: internals.hotkeyManager?.customKeys ?? {},
      installed,
      names,
    });
  }

  /** Time one plugin's load by restarting it. Explicit, never automatic. */
  async measureLoad(id: string): Promise<number | null> {
    if (!this.runtimeWatcher) return null;
    const ms = await this.runtimeWatcher.measureLoad(id);
    if (ms != null) await this.saveSettings();
    return ms;
  }

  /** Whether runtime measurement is switched on and running. */
  get runtimeTracking(): boolean {
    return this.runtimeWatcher != null;
  }

  // --- bisect ---------------------------------------------------------------

  get bisect(): BisectState | null {
    return this.settings.bisect;
  }

  /**
   * Begin a search, capturing the current set first.
   *
   * The snapshot is not optional and not a preference: it is what makes the
   * whole operation reversible, and a user who has just been told "this will
   * switch off half your plugins" needs the way back to already exist rather
   * than to be offered.
   */
  async startBisect(candidates: string[], symptom?: string): Promise<BisectState> {
    // Enforced here rather than at the call site, so no future caller can hand
    // this a list containing FlowKit and switch off the search itself.
    const searchable = searchableCandidates(candidates, this.manifest.id);
    const enabled = [...(this.pluginsApi().enabledPlugins ?? new Set<string>())];
    this.settings.profiles = saveProfile(
      this.settings.profiles,
      AUTO_SNAPSHOT,
      enabled,
      Date.now()
    );
    const state = beginBisect(searchable, enabled, Date.now(), symptom);
    this.settings.bisect = state;
    await this.saveSettings();
    await this.applyBisectState(state);
    return state;
  }

  /** Answer the current round and move to the next. */
  async answerBisect(gone: boolean): Promise<BisectState | null> {
    const current = this.settings.bisect;
    if (!current) return null;
    const next = bisectStep(current, gone);
    this.settings.bisect = next;
    await this.saveSettings();
    await this.applyBisectState(next);
    return next;
  }

  /** Abandon the search and put everything back. */
  async cancelBisect(): Promise<void> {
    const current = this.settings.bisect;
    if (!current) return;
    const { enable } = restoreState(current);
    this.settings.bisect = null;
    await this.saveSettings();
    await this.enableMany(enable);
    this.refreshViews(true, false);
  }

  /**
   * Finish a completed search, leaving the culprit switched off and everything
   * else back on. Keeping the culprit off is the whole point — re-enabling the
   * plugin we just proved is the problem, in order to offer to disable it,
   * would be pure ceremony.
   */
  async finishBisect(keepCulpritOff = true): Promise<void> {
    const current = this.settings.bisect;
    if (!current) return;
    const culprit = current.culprit;
    const enable = current.originalEnabled.filter(
      (id) => !(keepCulpritOff && culprit && id === culprit)
    );
    this.settings.bisect = null;
    await this.saveSettings();
    await this.enableMany(enable);
    if (keepCulpritOff && culprit) await this.disableMany([culprit]);
    this.refreshViews(true, false);
  }

  /**
   * Bring the vault to what this round needs.
   *
   * Expressed as a target rather than a diff so the session converges after an
   * Obsidian restart, or after the user toggles something by hand mid-search —
   * either of which would leave a diff-based approach quietly wrong about what
   * is running, and therefore wrong about the culprit.
   */
  private async applyBisectState(state: BisectState): Promise<void> {
    const { enable, disable } = desiredState(state);
    await this.disableMany(disable);
    await this.enableMany(enable);
    this.refreshViews(true, false);
  }

  // --- plugin sets ----------------------------------------------------------

  /** Capture the current enabled set under a name. */
  async saveCurrentProfile(name: string): Promise<void> {
    const enabled = [...(this.pluginsApi().enabledPlugins ?? new Set<string>())];
    this.settings.profiles = saveProfile(this.settings.profiles, name, enabled, Date.now());
    await this.saveSettings();
  }

  async removeProfile(name: string): Promise<void> {
    this.settings.profiles = deleteProfile(this.settings.profiles, name);
    await this.saveSettings();
  }

  /** What applying a profile would change, for the review step. */
  deltaFor(profile: PluginProfile): ProfileDelta {
    const api = this.pluginsApi();
    return profileDelta(
      profile,
      new Set(Object.keys(api.manifests ?? {})),
      api.enabledPlugins ?? new Set<string>()
    );
  }

  /** Switch to a saved set. Returns what it actually changed, for Undo. */
  async applyProfile(profile: PluginProfile): Promise<ProfileDelta> {
    const delta = this.deltaFor(profile);
    const disabled = await this.disableMany(delta.disable);
    const enabled = await this.enableMany(delta.enable);
    return { enable: enabled, disable: disabled, missing: delta.missing };
  }

  // --- change timeline ------------------------------------------------------

  /**
   * Record installs, updates, removals and toggles since the last scan.
   *
   * The first run after this shipped records a baseline silently. Announcing
   * every installed plugin as newly "installed" the day the feature lands would
   * fabricate forty events that never happened — the same mistake the change
   * log was fixed for in 1.2.0.
   */
  private async recordEvents(
    manifests: PluginManifest[],
    enabledSet: Set<string>,
    now: number
  ): Promise<void> {
    // A bisect switches plugins off and on by design. Recording those as user
    // events would bury a month of real history under one search's noise, and
    // then offer the toggles back as "what changed in your vault".
    if (this.settings.bisect) return;

    const { events, seen } = diffInstalled(
      this.settings.seenPlugins,
      // Built from every installed manifest, not from the scored rows: with
      // "show disabled plugins" off, the rows exclude disabled ones, and every
      // plugin the user switched off would be recorded as uninstalled.
      manifests.map((m) => ({
        id: m.id,
        name: m.name,
        version: m.version,
        enabled: enabledSet.has(m.id),
      })),
      now,
      this.settings.eventBaselineSet
    );
    this.settings.seenPlugins = seen;
    if (!this.settings.eventBaselineSet) {
      this.settings.eventBaselineSet = true;
      await this.saveSettings();
      return;
    }
    if (!events.length) return;
    this.settings.events = pruneEvents([...this.settings.events, ...events], now);
    await this.saveSettings();
  }

  /**
   * Changes that were followed by errors — the most useful sentence this
   * product can produce, from two things it already stored separately.
   */
  correlations(results: PluginHealth[], now = Date.now()): Correlation[] {
    return correlate(
      this.settings.events,
      results.map((r) => ({
        id: r.id,
        name: r.name,
        firstAt: r.errors?.firstAt,
        uncaught: r.errors?.uncaught ?? 0,
      })),
      now
    );
  }

  /** Everything recorded about one plugin, newest first. */
  eventsFor(id: string): PluginEvent[] {
    return this.settings.events.filter((e) => e.id === id).sort((a, b) => b.at - a.at);
  }

  /** Profile every enabled plugin's load, reporting progress as it goes. */
  async profileAll(
    ids: string[],
    onProgress?: (done: number, total: number, id: string) => void
  ): Promise<{ measured: number; failed: string[] } | null> {
    if (!this.runtimeWatcher) return null;
    const result = await this.runtimeWatcher.profileAll(ids, onProgress);
    await this.saveSettings();
    return result;
  }

  /**
   * Download both community feeds and reduce them to the slim projection we
   * persist. Returns null when nothing usable came back.
   */
  private async fetchRemoteCache(
    coverage: DataCoverage,
    installed: Set<string>
  ): Promise<RemoteCache | null> {
    // Share one fetch between concurrent callers. The background pass fires on
    // layout-ready and the view scans on open, so a cold start could otherwise
    // issue four requests for the same ~3.7 MB within a second of each other —
    // which is a good way to get told 403.
    if (this.inFlightFetch) {
      const shared = await this.inFlightFetch;
      if (!shared) coverage.error = describeFailure("network");
      return shared;
    }
    const run = this.doFetchRemoteCache(coverage, installed);
    this.inFlightFetch = run;
    try {
      return await run;
    } finally {
      this.inFlightFetch = null;
    }
  }

  private async doFetchRemoteCache(
    coverage: DataCoverage,
    installed: Set<string>
  ): Promise<RemoteCache | null> {
    const [statsRes, listRes] = await Promise.all([
      fetchRemoteStats(),
      fetchCommunityList(),
    ]);
    if (!statsRes.ok) {
      coverage.error = describeFailure(statsRes.reason, statsRes.status);
    } else if (!listRes.ok) {
      coverage.error = describeFailure(listRes.reason, listRes.status);
    }
    if (!statsRes.ok && !listRes.ok) return null;

    const built = buildRemoteCache(
      statsRes.ok ? statsRes.data : null,
      listRes.ok ? listRes.data : null,
      Date.now(),
      installed
    );
    // Merge rather than replace: when only one of the two feeds answered, the
    // other half of what we already knew is still the best data we have.
    const merged = mergeRemoteCache(this.settings.cache, built);
    this.settings.cache = merged;
    await this.saveSettings();
    return merged;
  }

  /**
   * Bytes of code and styles this plugin loads at startup. Read from the vault
   * adapter, so it works offline and on mobile and needs no new dependency.
   * Returns undefined when the files can't be read — the metric then reports
   * itself unavailable rather than guessing.
   */
  private async measureBundle(
    manifest: PluginManifest
  ): Promise<number | undefined> {
    const dir = (manifest as PluginManifest & { dir?: string }).dir;
    if (!dir) return undefined;
    let total = 0;
    let sawAny = false;
    for (const file of ["main.js", "styles.css"]) {
      try {
        const stat = await this.app.vault.adapter.stat(`${dir}/${file}`);
        if (stat?.type === "file") {
          total += stat.size;
          sawAny = true;
        }
      } catch {
        // Missing styles.css is normal; an unreadable main.js just means no score.
      }
    }
    return sawAny ? total : undefined;
  }

  /** How long error watching has been running, or 0 when it's off. */
  observedMs(): number {
    if (!this.settings.trackErrors || this.settings.watchingSince == null) return 0;
    return Math.max(0, Date.now() - this.settings.watchingSince);
  }

  /** Forget everything observed so far and start the clock again. */
  async clearErrorLog(): Promise<void> {
    this.settings.errorLog = {};
    this.settings.watchingSince = this.settings.trackErrors ? Date.now() : null;
    await this.saveSettings();
    this.refreshViews(true);
  }

  /** Whether Obsidian currently has this plugin enabled. */
  isEnabled(id: string): boolean {
    return this.pluginsApi().enabledPlugins?.has(id) ?? false;
  }

  /** Enable or disable a plugin via Obsidian's internal API. */
  async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    const api = this.pluginsApi();
    if (enabled) await api.enablePluginAndSave?.(id);
    else await api.disablePluginAndSave?.(id);
  }

  /**
   * Bulk-disable a set of plugins. Returns the ids that were actually enabled
   * beforehand — that's both the honest count to report and exactly what Undo
   * needs to re-enable, so undo can't switch on something the user had off.
   */
  async disableMany(ids: string[]): Promise<string[]> {
    const changed: string[] = [];
    for (const id of ids) {
      if (!this.isEnabled(id)) continue;
      await this.setPluginEnabled(id, false);
      changed.push(id);
    }
    return changed;
  }

  /** Re-enable a set of plugins (the Undo half of a bulk disable). */
  async enableMany(ids: string[]): Promise<string[]> {
    const changed: string[] = [];
    for (const id of ids) {
      if (this.isEnabled(id)) continue;
      await this.setPluginEnabled(id, true);
      changed.push(id);
    }
    return changed;
  }

  /** Open Obsidian's settings window to a plugin's own tab, if it has one. */
  openPluginSettings(id: string): void {
    const setting = (this.app as unknown as AppInternals).setting;
    setting?.open();
    setting?.openTabById(id);
  }

  /** Where a shortcut clash actually gets resolved. */
  openHotkeySettings(): void {
    const setting = (this.app as unknown as AppInternals).setting;
    setting?.open();
    setting?.openTabById("hotkeys");
  }

  /**
   * Mute a plugin for a chosen span, with an optional note.
   *
   * "Forever" is still offered, because sometimes it is the honest answer — but
   * it is now one of three choices rather than the only one, and the other two
   * mean a decision taken today can't quietly outlive the reason for it.
   */
  async mute(
    id: string,
    kind: "30d" | "until-update" | "forever",
    reason?: string
  ): Promise<void> {
    this.settings.mutes = {
      ...this.settings.mutes,
      [id]: buildMute(kind, Date.now(), apiVersion, reason),
    };
    await this.saveSettings();
  }

  async unmute(id: string): Promise<void> {
    const next = { ...this.settings.mutes };
    delete next[id];
    this.settings.mutes = next;
    this.settings.ignored = this.settings.ignored.filter((x) => x !== id);
    await this.saveSettings();
  }

  /** The live mute record for a plugin, if any. */
  muteOf(id: string): MuteRecord | undefined {
    return this.settings.mutes[id];
  }

  /**
   * Mute several plugins at once, persisting a single time. Returns the ids
   * that weren't already muted, so Undo only unmutes what this action did.
   */
  async muteMany(
    ids: string[],
    kind: "30d" | "until-update" | "forever" = "forever",
    reason?: string
  ): Promise<string[]> {
    const changed = ids.filter((id) => !(id in this.settings.mutes));
    if (!changed.length) return changed;
    const next = { ...this.settings.mutes };
    const now = Date.now();
    for (const id of changed) next[id] = buildMute(kind, now, apiVersion, reason);
    this.settings.mutes = next;
    await this.saveSettings();
    return changed;
  }

  /** Unmute a set of plugins (the Undo half of a bulk mute). */
  async unmuteMany(ids: string[]): Promise<string[]> {
    const changed = ids.filter((id) => id in this.settings.mutes);
    if (!changed.length) return changed;
    const next = { ...this.settings.mutes };
    for (const id of changed) delete next[id];
    this.settings.mutes = next;
    this.settings.ignored = this.settings.ignored.filter((id) => !changed.includes(id));
    await this.saveSettings();
    return changed;
  }

  isIgnored(id: string): boolean {
    return id in this.settings.mutes;
  }

  /** Star a plugin so FlowKit leads with it whenever something about it moves. */
  async toggleWatch(id: string): Promise<boolean> {
    const set = new Set(this.settings.watched);
    const watching = !set.has(id);
    if (watching) set.add(id);
    else set.delete(id);
    this.settings.watched = [...set];
    await this.saveSettings();
    return watching;
  }

  isWatched(id: string): boolean {
    return this.settings.watched.includes(id);
  }

  /** Mutes that lapsed on the last scan, consumed once by the view. */
  takeLapsedMutes(): string[] {
    const lapsed = this.lapsedMutes;
    this.lapsedMutes = [];
    return lapsed;
  }

  // --- Pro: health-trend history ------------------------------------------

  /**
   * The most recent snapshot recorded before `at`, for delta display. Sorted
   * rather than trusting insertion order — history survives in data.json across
   * syncs and hand edits, and an out-of-order entry would silently pick the
   * wrong baseline for every delta the user sees.
   */
  previousSnapshot(at: number): HealthSnapshot | null {
    const prior = this.settings.history
      .filter((s) => s.at < at)
      .sort((a, b) => a.at - b.at);
    return prior.length ? prior[prior.length - 1] : null;
  }

  /**
   * Record a vault-health snapshot for the trend tracker. To keep the history
   * compact, it replaces the last entry when it's from the same calendar day,
   * and otherwise appends — capping the list to a recent window.
   *
   * Recorded for everyone, not just Pro. Recording was previously gated, so a
   * new buyer had to open the dashboard on two separate calendar days before
   * the headline feature they had just paid for rendered anything but "check
   * back after a few scans" — squarely inside the post-purchase-regret window
   * of a one-time sale. It also makes the strongest upsell there is: a free
   * user already sitting on months of their own history.
   */
  async recordSnapshot(snapshot: HealthSnapshot): Promise<void> {
    const history = this.settings.history.slice();
    const last = history[history.length - 1];
    if (last && sameDay(last.at, snapshot.at)) {
      // Never let a degraded offline reading overwrite a full one from the same
      // day — that turned a network hiccup into an apparent health event.
      if (last.online && !snapshot.online) return;
      history[history.length - 1] = snapshot;
    } else {
      history.push(snapshot);
    }
    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }
    this.settings.history = history;
    await this.saveSettings();
  }
}

function sameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}
