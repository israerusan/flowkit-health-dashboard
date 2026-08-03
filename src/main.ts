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
import { RuntimeWatcher, type ProfileRunResult } from "./runtimeWatcher";
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
  DEVICE_RETENTION_MS,
  migrateSeen,
  pluginsKnownToAnyDevice,
  pruneDevices,
  SHARED_DEVICE,
} from "./devices";
import {
  AUTO_SNAPSHOT,
  deleteProfile,
  profileDelta,
  saveProfile,
  type PluginProfile,
  type ProfileDelta,
} from "./profiles";
import { LicenseManager } from "./license/LicenseManager";
import { SaveQueue, cloneState, isUsableCache, mapWithConcurrency } from "./persistence";
import {
  DEFAULT_SETTINGS,
  FlowKitHealthSettingTab,
  FlowKitHealthSettings,
} from "./settings";
import type {
  CachedPlugin,
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

/** Where a scan has got to, for a loading state that says something true. */
export interface ScanPhase {
  label: string;
  done?: number;
  total?: number;
}

export type ScanPhaseReporter = (phase: ScanPhase) => void;

/** One plugin that would not move, and why. */
export interface LifecycleFailure {
  id: string;
  error: unknown;
}

/**
 * What a bulk enable/disable actually did.
 *
 * `changed` used to be the whole return value, and it was appended to on faith:
 * the internal API call was optional-chained, so a build without those methods
 * resolved having done nothing and every caller reported a change that never
 * happened. Undo, saved sets and bisect all rest on this list being true.
 */
export interface LifecycleResult {
  changed: string[];
  failed: LifecycleFailure[];
}

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

/**
 * How many plugins a scan inspects on disk at once.
 *
 * Deliberately small. Each plugin means two `adapter.stat` calls, so this is
 * already up to eight outstanding filesystem operations — and the adapter
 * underneath may be a phone, a network share, or a folder a sync client is
 * currently walking, none of which get faster by being asked for more at once.
 * The win here is removing the serial chain, not saturating the disk.
 */
const SCAN_CONCURRENCY = 4;

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

  /**
   * A scan already running, and what it was permitted to do.
   *
   * Every startup with the dashboard left open ran the whole scan twice within
   * a second: Obsidian restores the tab, the view scans on open, and the
   * layout-ready background pass then scans the same vault again — two passes
   * over every plugin's files, two sets of scores built and thrown at the same
   * screen, and two writes to data.json. `inFlightFetch` only ever shared the
   * download; the local half, which is all of the work on a warm cache, was
   * duplicated in full.
   *
   * A later caller reuses this only when the running scan is permitted to do at
   * least as much as it asked for — a pass that may not touch the network
   * cannot stand in for one that was told to refetch.
   */
  private inFlightScan: {
    allowFetch: boolean;
    force: boolean;
    promise: Promise<{ results: PluginHealth[]; coverage: DataCoverage }>;
  } | null = null;

  /** Guards the background repository lookups against overlapping batches. */
  private repoLookupInFlight = false;

  /** When the last watcher-triggered local rescan ran. */
  private lastLocalRescan = 0;

  /** A rescan deferred by the throttle, so a burst still lands once it passes. */
  private trailingRescan: number | null = null;

  /**
   * One writer for data.json.
   *
   * `await saveSettings()` is used as a durability barrier where it genuinely
   * matters — the bisect recovery record is written before a single plugin is
   * switched off — so writes may be serialised and collapsed, but that
   * guarantee has to survive it. See `SaveQueue`.
   */
  private readonly saveQueue = new SaveQueue<FlowKitHealthSettings>(
    () => cloneState(this.settings),
    (state) => this.saveData(state)
  );

  /**
   * Set when `data.json` could not be read. Automatic saves are then suppressed
   * for the session: continuing to run on defaults is fine, but writing those
   * defaults back over a file that is merely locked, half-synced or briefly
   * unreadable would turn a recoverable problem into permanent data loss —
   * including the bisect recovery record for a vault that is currently half
   * switched off.
   */
  settingsUnreadable = false;

  /**
   * Which device this is.
   *
   * Deliberately NOT stored in `data.json`: that file is the thing being
   * synced, so an id kept in it would be the same on every machine and answer
   * nothing. It lives in `localStorage`, which Obsidian does not sync, and it
   * is the only piece of FlowKit's state that is per-device by design.
   *
   * Resolved once in `onload`, before anything reads the stores.
   */
  deviceId: string = SHARED_DEVICE;

  /** A bisect record that survived to disk in a shape we can't act on. */
  bisectSalvage: unknown = null;

  /** Why the last bisect transition failed, when one did. */
  bisectError: string | null = null;

  /** Set while a bisect round is being established; answers are refused until it clears. */
  private bisectApplying = false;

  /**
   * Mutes that lapsed during the last scan. Surfaced once, so a plugin
   * reappearing in the counts reads as an event rather than a glitch.
   */
  lapsedMutes: string[] = [];

  /**
   * This device's id, from `localStorage`, minted on first run.
   *
   * `localStorage` is per-device and not synced, which is the whole
   * requirement. It is reached directly because Obsidian's own per-device
   * helpers are not in the public typings, and it is wrapped because a webview
   * with storage disabled must degrade rather than fail: every such device
   * shares one bucket, which is precisely how FlowKit behaved before device
   * identity existed. Worse than the ideal, no worse than the past.
   */
  private resolveDeviceId(): string {
    const key = "flowkit-health-dashboard:device";
    try {
      const stored = window.localStorage.getItem(key);
      if (stored) return stored;
      // `typeof crypto`, not `crypto?.` — optional chaining does not protect
      // against an undeclared identifier, it only guards a null value.
      const minted =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `d${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
      window.localStorage.setItem(key, minted);
      return minted;
    } catch (err) {
      console.error("FlowKit: no per-device storage available", err);
      return SHARED_DEVICE;
    }
  }

  async onload(): Promise<void> {
    // Before loadSettings: the migration of the old single-device record files
    // it under this device, so the id has to exist first.
    this.deviceId = this.resolveDeviceId();
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

    // Reachable from the command palette, not just from a menu inside the
    // view: the flagship feature was previously findable only by someone who
    // already knew where to look, which is the wrong way round.
    this.addCommand({
      id: "bisect-plugins",
      name: "Find what's breaking my vault",
      callback: () => void this.runInDashboard((view) => view.commandBisect()),
    });

    this.addCommand({
      id: "profile-startup",
      name: "Profile plugin startup",
      callback: () => void this.runInDashboard((view) => view.commandProfile()),
    });

    this.addCommand({
      id: "save-plugin-set",
      name: "Save current plugin set",
      callback: () => void this.runInDashboard((view) => view.commandSaveSet()),
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
          //
          // The rescan is not conditional on the write. An observation that is
          // in memory is worth showing whether or not it reached disk, and
          // chaining them meant a read-only vault silently stopped updating the
          // dashboard as well as its history.
          this.saveQuietly();
          this.requestLocalRescan();
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
          this.saveQuietly();
          this.requestLocalRescan();
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
    if (this.settingsUnreadable) {
      new Notice(
        "FlowKit couldn't read its own settings file, so it has started with defaults and " +
          "won't save over it. Your history, licence and saved sets are still on disk.",
        12_000
      );
    }

    this.app.workspace.onLayoutReady(() => {
      // The catch matters more for what it lets through than for what it logs:
      // without it a rejected version check skipped the startup scan entirely
      // and escaped as an unhandled rejection. The scan is the part the user
      // notices, so it runs either way.
      void this.checkAppVersion()
        .catch((err) => {
          console.error("FlowKit: could not check the Obsidian version", err);
        })
        .then(() => this.backgroundScan());
    });
    this.registerInterval(
      window.setInterval(() => void this.backgroundScan(), MONITOR_INTERVAL_MS)
    );
  }

  /**
   * Set once Obsidian has torn this instance down.
   *
   * Read by the detached work that can still be in flight at that moment —
   * the repository lookups, which are up to six sequential network calls with
   * their own timeouts and can easily outlive a disable by half a minute. They
   * finished by writing settings and asking every view to rescan, on behalf of
   * a plugin that no longer exists.
   *
   * Deliberately NOT checked inside `saveSettings`. The settings tab flushes a
   * debounced licence write when it closes, which can legitimately land just
   * after a disable, and silently dropping the key somebody has just paid for
   * would be a worse bug than the one this fixes.
   */
  private unloaded = false;

  onunload(): void {
    this.unloaded = true;
    // Leaves of our view type are detached automatically by Obsidian, and the
    // error listeners went through registerDomEvent — but console.error,
    // setInterval and the plugin loader were monkey-patched, so those have to
    // be put back by hand.
    this.errorWatcher?.stop();
    this.runtimeWatcher?.stop();
    if (this.trailingRescan != null) {
      window.clearTimeout(this.trailingRescan);
      this.trailingRescan = null;
    }
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
    // Its own timestamp — see `appUpdateSeenAt`. Sharing `lastSeenChangeAt`
    // meant dismissing this banner also silently swallowed the unread changes
    // strip beside it.
    const seen = this.settings.appUpdateSeenAt ?? 0;
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

    // A search in progress owns this strip, exactly as it owns the dashboard.
    //
    // Without it, the one surface that is always on screen quoted a health
    // score for a vault FlowKit had itself switched half of off — and it is the
    // ONLY surface a user sees if they closed the dashboard, or restarted
    // Obsidian mid-search and their tab didn't come back. That is the person
    // most in need of being told: their vault is missing plugins, there is a
    // reason, and here is the way back.
    // Via the helper, not a hand-rolled test. `bisectOwnsPage()` was introduced
    // in 1.6.1 for precisely this question and this surface was left reading
    // `!search.done` directly — so the always-visible strip reported an
    // ordinary health score for a vault FlowKit had just recorded that it could
    // not put back.
    const search = this.settings.bisect;
    if (search && this.bisectOwnsPage()) {
      // Two different situations, and the stranded one is the more urgent:
      // a search still running has a way forward on screen, whereas a vault
      // whose plugins could not be put back is waiting on the user and says so
      // nowhere else once the dashboard is closed.
      const stranded = search.restoreFailed ?? [];
      this.statusBarEl.empty();
      this.statusBarEl.toggleClass("is-alert", true);
      if (stranded.length) {
        this.statusBarEl.setText(`Plugins not restored · ${stranded.length}`);
        this.statusBarEl.setAttr(
          "aria-label",
          `FlowKit could not switch ${stranded.join(", ")} back on after a plugin search. Open FlowKit to try again.`
        );
        return;
      }
      const off = search.disabled.length;
      this.statusBarEl.setText(`Plugin search · ${off} off`);
      this.statusBarEl.setAttr(
        "aria-label",
        `FlowKit is searching for what's breaking your vault — ${off} plugin${
          off === 1 ? "" : "s"
        } switched off for round ${search.round}. Open FlowKit to answer or stop.`
      );
      return;
    }

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
  /**
   * A search is in progress — as opposed to finished and waiting to be
   * acknowledged, which is an ordinary vault the user can be told about again.
   */
  private bisectInProgress(): boolean {
    const state = this.settings.bisect;
    return state != null && !state.done;
  }

  /**
   * The vault is not the user's own, whatever the search thinks it is doing.
   *
   * `bisectInProgress` goes false the instant a search reaches `done`, and
   * every guard keyed on it releases together — which is right when the search
   * finished cleanly and wrong on the one path where it didn't. `finishBisect`
   * and `cancelBisect` deliberately leave the session on disk when a plugin
   * refuses to switch back on, precisely because the vault is still missing
   * plugins; but the moment `done` was set, the dashboard stopped treating the
   * search as owning the page, and the trend chart and the change log both
   * started recording a vault FlowKit had just written down that it could not
   * put back.
   */
  private vaultUnrestored(): boolean {
    return this.settings.bisect != null && this.bisectError != null;
  }

  /** Depth of FlowKit-initiated plugin toggling currently in flight. */
  private vaultMutationDepth = 0;

  /**
   * Run something that deliberately toggles plugins, without the result being
   * recorded as your vault's history.
   *
   * Profiling switches every plugin off and on again and finishes exactly where
   * it started, but a scan landing halfway through sees a vault mid-surgery —
   * and would write down that eight plugins were disabled and one recovered.
   * Bisect taught this lesson once already; this is the general form, so the
   * next thing that moves plugins around doesn't have to learn it again.
   *
   * Deliberately NOT used for bulk fixes or switching plugin sets: those are
   * changes the user actually asked for, and recording them is the point.
   */
  private async withVaultMutation<T>(fn: () => Promise<T>): Promise<T> {
    this.vaultMutationDepth++;
    try {
      return await fn();
    } finally {
      this.vaultMutationDepth--;
    }
  }

  /** Whether this scan should keep its observations out of the history. */
  recordingSuspended(): boolean {
    return (
      this.bisectInProgress() || this.vaultUnrestored() || this.vaultMutationDepth > 0
    );
  }

  /** Whether the dashboard should still be showing the search rather than a report. */
  bisectOwnsPage(): boolean {
    return this.bisectInProgress() || this.vaultUnrestored();
  }

  async diffChanges(
    all: PluginHealth[],
    coverage: DataCoverage
  ): Promise<HealthChange[]> {
    // A vault with half its plugins deliberately switched off is not a vault
    // whose health changed. Without this, every plugin the search turns off
    // loses its trouble kinds and is reported as having RECOVERED — "FlowKit
    // Canary A is back to normal", about a plugin that is only quiet because
    // we silenced it — and every plugin it turns back on re-announces whatever
    // was already wrong with it. A search over forty plugins would manufacture
    // dozens of these and bury a month of real history.
    //
    // Worse than the noise: `notified` would be left describing the mid-search
    // vault, so restoring everything at the end re-reports the original trouble
    // as newly started.
    if (this.recordingSuspended()) return [];

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

  /** Acknowledge the Obsidian-update banner, and only that. */
  async markAppUpdateSeen(): Promise<void> {
    this.settings.appUpdateSeenAt = Date.now();
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
    //
    // A rejection here used to escape `onload` and stop the plugin loading at
    // all — a corrupt or momentarily unreadable data.json took the whole
    // dashboard with it. Start from defaults instead, and remember that we did,
    // because writing those defaults back would destroy the file we couldn't
    // read.
    let data: Partial<FlowKitHealthSettings> | null = null;
    try {
      data = (await this.loadData()) as Partial<FlowKitHealthSettings> | null;
    } catch (err) {
      console.error("FlowKit: could not read data.json", err);
      this.settingsUnreadable = true;
    }
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
    // Upgraded in place from the pre-1.7 flat map — see `migrateSeen`. Also the
    // guard against a hand-edited or sync-mangled value, since it validates the
    // shape of every bucket it keeps.
    this.settings.seenPlugins = migrateSeen(this.settings.seenPlugins, this.deviceId);
    // Claim the pre-device trend series for whichever machine upgrades first.
    //
    // Without this, `isThisDevice` had to accept unstamped readings to avoid
    // blanking the chart — and accepting them is what disabled the device
    // filter on every synced vault. Stamping once at migration lets the
    // predicate be strict, which is what makes the filter mean anything.
    if (Array.isArray(this.settings.history)) {
      for (const snapshot of this.settings.history) {
        if (snapshot && snapshot.device == null) snapshot.device = this.deviceId;
      }
    }
    // A half-written bisect can't be acted on: it would claim a set of plugins
    // to restore that it can't actually name. But it must not simply be
    // deleted, because the vault it describes may right now be half switched
    // off — and throwing the record away strands it with nothing left that
    // knows what "back to normal" meant. Keep it aside and offer the automatic
    // snapshot as a way out.
    const bisect = this.settings.bisect;
    if (
      bisect &&
      (!Array.isArray(bisect.candidates) ||
        !Array.isArray(bisect.originalEnabled) ||
        !Array.isArray(bisect.disabled))
    ) {
      this.bisectSalvage = bisect;
      this.settings.bisect = null;
    }
    // Rebuild the "couldn't put your plugins back" state from disk. Without
    // this the message, the page ownership and the recording suspension all
    // survived only until the user restarted — which is what somebody with a
    // half-restored vault does first.
    const live = this.settings.bisect;
    if (live && Array.isArray(live.restoreFailed) && live.restoreFailed.length) {
      this.bisectError = restoreFailureMessage(live.restoreFailed);
    }
    // The undo record is a convenience, not a recovery record: `bisect` itself
    // holds the way back. A malformed one is dropped rather than salvaged.
    const undo = this.settings.bisectUndo;
    if (
      undo &&
      (!Array.isArray(undo.candidates) ||
        !Array.isArray(undo.originalEnabled) ||
        !Array.isArray(undo.disabled))
    ) {
      this.settings.bisectUndo = null;
    }
    // The persisted community projection is read without further checking all
    // through `computeAll` — `cache?.plugins[id]` optional-chains the cache and
    // not the map inside it — so a sync-mangled object took the whole scan
    // down. Validate the entire contract or drop it: a half-valid cache is
    // worse than none, because it also suppresses the refetch that would
    // replace it, and reports coverage it doesn't have.
    if (this.settings.cache && !isUsableCache(this.settings.cache)) {
      console.error("FlowKit: the stored community cache was malformed; discarding it.");
      this.settings.cache = null;
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

  /**
   * Persist settings, one write at a time.
   *
   * Five different things write this file — the foreground scan, the six-hourly
   * background pass, both watchers, the detached repository lookups, and every
   * user action — and none of them coordinated. Overlapping `saveData` calls
   * can complete out of order, which means an older state can be the one that
   * lands last.
   *
   * Concurrent requests collapse into a single write, which is also what stops
   * one scan rewriting data.json several times. What must NOT collapse is the
   * promise: `await saveSettings()` is a durability barrier before the bisect
   * touches a plugin, so a caller is only resolved once a write that included
   * its mutations actually completed. Hence the revision counter rather than a
   * shared "there is a save pending" flag.
   */
  async saveSettings(): Promise<void> {
    // Refusing to write is the point: see `settingsUnreadable`. Silently
    // dropping the write is still better than overwriting the file, and the
    // dashboard says so rather than pretending the setting stuck.
    if (this.settingsUnreadable) return;
    await this.saveQueue.save();
  }

  /**
   * Save without making the caller responsible for the outcome.
   *
   * A write failure now rejects every caller the write would have covered,
   * which is the correct semantics and means a fire-and-forget `void save()`
   * would surface as an unhandled rejection — in a plugin whose own error
   * watcher is listening for exactly those. Background bookkeeping uses this;
   * anything that needs the write to have happened awaits `saveSettings`.
   */
  private saveQuietly(): void {
    void this.saveSettings().catch((err) => {
      console.error("FlowKit: could not save settings", err);
    });
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
    // With no dashboard on screen there is nothing to rescan, and consuming the
    // throttle window here meant the next observation — the one that lands
    // while the user is actually looking — could be held back by fifteen
    // seconds of work that never happened.
    if (!this.hasOpenDashboard()) return;
    const now = Date.now();
    if (now - this.lastLocalRescan < LOCAL_RESCAN_THROTTLE_MS) {
      // Leading edge already fired. Repainting here was pointless — `rerender()`
      // redraws the same PluginHealth objects, and every signal a watcher
      // observes lives inside those objects — so the observation was silently
      // dropped, which is the whole of what "background monitoring" is meant to
      // do. Hold one trailing pass instead.
      if (this.trailingRescan != null) return;
      const wait = LOCAL_RESCAN_THROTTLE_MS - (now - this.lastLocalRescan);
      this.trailingRescan = window.setTimeout(() => {
        this.trailingRescan = null;
        this.lastLocalRescan = Date.now();
        this.refreshViews(true, false);
      }, wait);
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

  /** Whether a dashboard is on screen for a rescan to land in. */
  private hasOpenDashboard(): boolean {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE_HEALTH)
      .some((leaf) => leaf.view instanceof HealthDashboardView);
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

  /**
   * Open the dashboard and run something in it. Commands can fire with no view
   * on screen, and every one of these acts on the current scan.
   */
  private async runInDashboard(
    fn: (view: HealthDashboardView) => Promise<void>
  ): Promise<void> {
    await this.activateView();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_HEALTH)) {
      if (leaf.view instanceof HealthDashboardView) {
        await fn(leaf.view);
        return;
      }
    }
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
    opts: { force?: boolean; allowFetch?: boolean; onPhase?: ScanPhaseReporter } = {}
  ): Promise<{ results: PluginHealth[]; coverage: DataCoverage }> {
    const { force = false, allowFetch = true, onPhase } = opts;
    // Reuse a scan already in flight when it covers this one. Deliberately not
    // when a progress reporter was passed: that caller is painting a loading
    // screen for the user, and silently attaching it to somebody else's scan
    // would leave the progress bar describing a stage it cannot see.
    const running = this.inFlightScan;
    if (
      running &&
      !onPhase &&
      (running.allowFetch || !allowFetch) &&
      (running.force || !force)
    ) {
      return running.promise;
    }
    const scan = this.runScan(force, allowFetch, onPhase);
    const entry = { allowFetch, force, promise: scan };
    this.inFlightScan = entry;
    try {
      return await scan;
    } finally {
      if (this.inFlightScan === entry) this.inFlightScan = null;
    }
  }

  private async runScan(
    force: boolean,
    allowFetch: boolean,
    onPhase?: ScanPhaseReporter
  ): Promise<{ results: PluginHealth[]; coverage: DataCoverage }> {
    // Reported, not invented. A progress line that names stages the code cannot
    // observe is worse than a spinner: it looks like information and is
    // theatre, and the one stage that genuinely takes seconds — downloading
    // ~3.7 MB of community data — is the one a fixed script would get wrong,
    // because most scans skip it entirely.
    const phase = (label: string, done?: number, total?: number): void =>
      onPhase?.({ label, done, total });
    const api = this.pluginsApi();
    const manifests = Object.values(api.manifests ?? {});
    const enabledSet = api.enabledPlugins ?? new Set<string>();

    // Every plugin any current device knows about, resolved ONCE, here.
    //
    // Two places decide which plugins' stored data is worth keeping, and in
    // 1.7.0 only one of them was taught that a synced vault has more than one
    // device's plugins in it. Resolving the set in a single place is the point:
    // the two sites cannot drift apart again because there is only one.
    const knownIds = pluginsKnownToAnyDevice(this.settings.seenPlugins, Date.now());
    for (const m of manifests) knownIds.add(m.id);

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
        phase("Downloading the community plugin directory…");
        // The SAME id set `pruneStores` uses, not this device's manifests.
        //
        // `pruneStores` learned in 1.7.0 that "not installed here" isn't
        // "uninstalled"; the fetch path 140 lines away did not, and passed only
        // this machine's plugins into `buildRemoteCache`'s keep-set and
        // `mergeRemoteCache`'s scope. So every refresh on the desktop deleted
        // the phone's rows from the shared cache — and the phone, which does
        // not refetch for 24h by default, then read a cache with its own
        // plugins missing: `classifyListing` returns "local" with no entry, so
        // each one got a "Local install — skipped community review" badge and a
        // one-click "Mute these", and every pending update silently vanished.
        const fetched = await this.fetchRemoteCache(coverage, knownIds);
        // Keep serving the previous projection when a refresh fails, rather
        // than dropping two of five columns because GitHub had a bad minute.
        if (fetched) cache = fetched;
      }
      coverage.stats = cache?.hadStats ?? false;
      coverage.list = cache?.hadList ?? false;
    }

    const now = Date.now();
    const rank = rankerFromDistribution(cache?.distribution);

    // A mute with an expiry has to actually expire, and the user has to be able
    // to find out that it did — otherwise a plugin silently rejoins the counts
    // and the change reads as a scoring glitch.
    // One scan used to rewrite data.json up to five times — expired mutes,
    // pruned stores, recorded events, then the view's snapshot and change diff.
    // On a synced vault that is five sync events for one Refresh. Collect the
    // bookkeeping and write it once, at the end.
    let dirty = false;

    const sweep = sweepMutes(this.settings.mutes, now, apiVersion);
    if (sweep.expired.length) {
      this.settings.mutes = sweep.active;
      this.lapsedMutes = sweep.expired;
      this.settings.ignored = this.settings.ignored.filter(
        (id) => !sweep.expired.includes(id)
      );
      dirty = true;
    }
    const mutes = this.settings.mutes;
    const watchedIds = new Set(this.settings.watched);

    // Uninstalling a plugin should also drop everything recorded about it,
    // rather than leaving it to accumulate in data.json indefinitely.
    if (this.pruneStores(knownIds)) dirty = true;

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

    // Every scoring input is read once, here, so that the rows below all
    // describe the same moment. They used to be read per plugin inside the
    // loop, which was harmless while the loop was strictly serial and stops
    // being harmless the moment any of it overlaps: a background repository
    // lookup landing mid-scan would give the first half of the table one set of
    // facts and the second half another.
    const errorLog = this.settings.errorLog;
    const repoActivity = this.settings.repoActivity;
    const observedMs = this.observedMs();
    const isMobile = Platform.isMobile;
    const scored = manifests.filter(
      (m) => enabledSet.has(m.id) || this.settings.showDisabled
    );

    // Bundle sizes are the one asynchronous input, and they were measured
    // strictly one plugin after another: on a large vault that is a couple of
    // hundred adapter round trips in series before anything renders. Run a few
    // at a time and write each result into its own slot, so row order stays
    // exactly the manifest order regardless of which stat finishes first.
    let inspected = 0;
    phase("Measuring what each plugin loads…", 0, scored.length);
    const bundles = await mapWithConcurrency(scored, SCAN_CONCURRENCY, async (m) => {
      const bytes = await this.measureBundle(m);
      phase("Measuring what each plugin loads…", ++inspected, scored.length);
      return bytes;
    });
    phase("Scoring…");

    const results: PluginHealth[] = scored.map((manifest, i) => {
      const cached = cache?.plugins[manifest.id];
      return computeHealth(
        {
          manifest,
          enabled: enabledSet.has(manifest.id),
          isMobile,
          repo: cached?.repo,
          remote: remoteFromCache(cached),
          bundleBytes: bundles[i],
          downloadPercentile: rank(cached?.downloads),
          listing: classifyListing(manifest.id, cache),
          errors: errorLog[manifest.id],
          observedMs,
          muted: manifest.id in mutes,
          mute: mutes[manifest.id],
          watched: watchedIds.has(manifest.id),
          runtime: runtime[manifest.id],
          repoActivity: repoActivity[manifest.id],
        },
        now
      );
    });
    this.settings.lastScanAt = now;
    // Recorded last, so an event is only ever written for a scan that actually
    // produced results — a scan that threw halfway would otherwise move the
    // baseline forward and lose the change it was in the middle of noticing.
    if (this.recordEvents(manifests, enabledSet, now)) dirty = true;
    if (dirty) await this.saveSettings();
    return { results, coverage };
  }

  /**
   * Forget everything recorded about plugins that are no longer installed.
   * Returns whether anything changed, so the caller can fold the write into the
   * scan's single save.
   */
  private pruneStores(installed: ReadonlySet<string>): boolean {
    let dirty = false;
    // "Not installed on this machine" is not "uninstalled".
    //
    // This deleted every stored reading for every plugin the current device
    // happened not to have — which, on a vault whose settings are synced but
    // whose plugins are not, is most of them. A phone would wipe the desktop's
    // error history, measured load times and repository readings on its first
    // scan; the desktop would wipe the phone's on its next. Nothing was ever
    // kept long enough to be worth having.
    //
    // The question that actually decides whether a record is dead is whether
    // ANY device has seen the plugin lately, and that is what is asked now.
    // Anything genuinely uninstalled everywhere still ages out, because the
    // device that had it stops listing it and its bucket eventually expires.
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
    // The community projection was the one store this never reached, so an
    // uninstalled plugin's row survived until a network fetch happened to
    // rebuild the cache — and, before the merge was scoped, not even then.
    // Pruned locally means it goes on the next scan, offline included.
    const cache = this.settings.cache;
    if (cache) {
      const keep = Object.keys(cache.plugins).filter((id) => installed.has(id));
      if (keep.length !== Object.keys(cache.plugins).length) {
        const plugins: Record<string, CachedPlugin> = {};
        for (const id of keep) plugins[id] = cache.plugins[id];
        this.settings.cache = { ...cache, plugins };
        dirty = true;
      }
    }
    // `notified` was never pruned at all. It is now carried forward for plugins
    // this scan couldn't see — which is what stops another device's trouble
    // state being forgotten and then re-announced — so it needs the same
    // expiry as everything else or it only ever grows.
    const notified = this.settings.notified;
    const liveIds = Object.keys(notified).filter((id) => installed.has(id));
    if (liveIds.length !== Object.keys(notified).length) {
      const next: Record<string, HealthChangeKind[]> = {};
      for (const id of liveIds) next[id] = notified[id];
      this.settings.notified = next;
      dirty = true;
    }
    return dirty;
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
    const fetched: RepoActivityMap = {};
    // Sequential on purpose: six parallel requests to one API is how a soft
    // rate limit becomes a hard one, and nothing here is time-critical.
    for (const id of wanted) {
      // Six calls with 10s timeouts each easily outlive a disable. Stop at the
      // boundary rather than mid-write.
      if (this.unloaded) return;
      const repo = byId.get(id)?.repo;
      if (!repo) continue;
      fetched[id] = await fetchRepoActivity(repo, now);
    }
    // Checked again after the last await: everything below writes settings and
    // asks every view to rescan, and by now this instance may be gone.
    if (this.unloaded) return;
    // Merged into whatever the map is NOW, not into the copy taken before these
    // requests went out. Each of them takes seconds; a scan finishing in the
    // meantime prunes the entries for plugins that have since been uninstalled,
    // and writing back the pre-request copy would put every one of them
    // straight back — an invariant undone by a slow network call.
    const installed = new Set(Object.keys(this.pluginsApi().manifests ?? {}));
    const merged: RepoActivityMap = { ...this.settings.repoActivity };
    for (const [id, activity] of Object.entries(fetched)) {
      if (!installed.has(id)) continue;
      merged[id] = activity;
    }
    this.settings.repoActivity = merged;
    await this.saveSettings();
    // The readings only reach the user through a rescan — and this one is
    // local-only, so a lookup landing can't trigger another download.
    this.refreshViews(true, false);
  }

  /**
   * Plugins competing for the same shortcut or command name.
   *
   * Read fresh on every SCAN, not on every render — which the comment here used
   * to claim and the view has never done. Walking the whole command registry
   * and the custom-key map on each repaint is real work for a signal that only
   * moves when the user opens Obsidian's hotkey settings, and a rebind is
   * followed by coming back to this tab, which is itself a rescan.
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
      // `Mod` is an alias, and which key it aliases decides whether two
      // bindings are the same physical chord.
      mod: Platform.isMacOS ? "Meta" : "Ctrl",
    });
  }

  /** Time one plugin's load by restarting it. Explicit, never automatic. */
  async measureLoad(id: string): Promise<number | null> {
    if (!this.runtimeWatcher) return null;
    const ms = await this.runtimeWatcher.measureLoad(id);
    if (ms != null) await this.saveSettings();
    return ms;
  }

  /** Every installed plugin's manifest, for the states that have no scan yet. */
  installedManifests(): Record<string, PluginManifest> {
    return this.pluginsApi().manifests ?? {};
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
  /**
   * Whether an operation whose safety rests on a recovery record may run.
   *
   * Bisect's entire safety argument is "the way back is written down before
   * anything moves". With settings unreadable, `saveSettings` is a no-op — so
   * that sentence becomes false while every step still reports success, and
   * FlowKit would switch half a vault off with nothing on disk that knows how
   * to put it back. Refusing is the only honest answer.
   */
  get canPersist(): boolean {
    return !this.settingsUnreadable;
  }

  async startBisect(candidates: string[], symptom?: string): Promise<BisectState | null> {
    // Enforced here as well as in the view, for the same reason FlowKit's own
    // id is filtered here rather than at the call site: everything below
    // overwrites the only two records of what the vault really looks like, so
    // no future caller may be able to reach it with a search already open.
    if (this.settings.bisect) return null;
    if (!this.canPersist) {
      new Notice(
        "FlowKit can't start a search while it can't save: the record of which plugins to " +
          "put back afterwards wouldn't survive a restart. Restart Obsidian and try again.",
        10_000
      );
      return null;
    }
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
    // A new search has no previous answer to take back, and a leftover record
    // would offer to restore a round belonging to a search that is over.
    this.settings.bisectUndo = null;
    await this.saveSettings();
    // The boolean matters. This used to return the session regardless, so
    // "a search was opened" and "its first experiment is actually set up" were
    // the same answer — and a caller could report a started search over a vault
    // that had never reached the round it was about to be asked about. The
    // record deliberately stays either way: it holds `originalEnabled`, which
    // is the only thing that knows how to put a half-moved vault back.
    const established = await this.applyBisectState(state);
    return established ? state : null;
  }

  /**
   * Answer the current round and move to the next.
   *
   * The new round is persisted BEFORE any plugin moves, and that ordering is
   * deliberate: the state is expressed as a target rather than a diff, so a
   * crash between the write and the toggles leaves a record that reconciles
   * itself on the next load. Writing after the toggles would leave the old
   * round on disk describing a vault that is no longer in it.
   */
  async answerBisect(gone: boolean): Promise<BisectState | null> {
    const current = this.settings.bisect;
    // An answer arriving mid-transition would be an answer about a vault that
    // is still being rearranged.
    if (!current || this.bisectApplying) return null;
    const next = bisectStep(current, gone);
    // Kept before the step is taken, and persisted with it, so the way back
    // survives the restart that reproducing a problem so often needs.
    this.settings.bisectUndo = current;
    this.settings.bisect = next;
    await this.saveSettings();
    await this.applyBisectState(next);
    return next;
  }

  /** Whether the last answer can still be taken back. */
  get bisectCanUndo(): boolean {
    return this.settings.bisectUndo != null && !this.bisectApplying;
  }

  /**
   * Take back the last answer and put the vault into the round it was asked
   * about.
   *
   * The search asks a yes/no question about something the user has to go and
   * observe for themselves, and answering it wrongly is an ordinary mistake —
   * you press "still happening" and realise a second later you hadn't actually
   * checked. Without this, that slip is unrecoverable and invisible: half the
   * candidates are gone, the search carries on with a straight face, and it
   * ends by naming a plugin that was never a suspect.
   */
  async undoBisectAnswer(): Promise<BisectState | null> {
    const previous = this.settings.bisectUndo;
    if (!previous || this.bisectApplying) return null;
    this.settings.bisect = previous;
    // One step only — see `bisectUndo`. Cleared as part of the same write, so
    // the record can never describe a round two answers ago.
    this.settings.bisectUndo = null;
    await this.saveSettings();
    await this.applyBisectState(previous);
    return previous;
  }

  /**
   * Abandon the search and put everything back.
   *
   * Restore first, then clear. The other order looks tidier and is the one
   * thing that must never happen: `originalEnabled` is the only record of what
   * this vault looked like, and erasing it before the plugins are actually back
   * on strands a half-disabled vault with nothing left that knows what normal
   * was.
   */
  async cancelBisect(): Promise<void> {
    const current = this.settings.bisect;
    if (!current || this.bisectApplying) return;
    this.bisectApplying = true;
    try {
      const { enable } = restoreState(current);
      const result = await this.enableMany(enable);
      if (result.failed.length) {
        // Written to the session, not just to a field: see `restoreFailed`.
        await this.noteRestoreFailure(current, result.failed);
        return;
      }
      this.settings.bisect = null;
      this.settings.bisectUndo = null;
      this.bisectError = null;
      await this.saveSettings();
    } finally {
      this.bisectApplying = false;
      this.refreshViews(true, false);
    }
  }

  /**
   * Finish a completed search, leaving the culprit switched off and everything
   * else back on. Keeping the culprit off is the whole point — re-enabling the
   * plugin we just proved is the problem, in order to offer to disable it,
   * would be pure ceremony.
   *
   * Expressed as one target state rather than "restore, then also disable one":
   * a failure partway through the second step would otherwise leave the culprit
   * running with the record already cleared.
   */
  async finishBisect(keepCulpritOff = true): Promise<void> {
    const current = this.settings.bisect;
    if (!current || this.bisectApplying) return;
    this.bisectApplying = true;
    try {
      const culprit = keepCulpritOff ? current.culprit : undefined;
      const enable = current.originalEnabled.filter((id) => id !== culprit);
      const on = await this.enableMany(enable);
      const off = culprit
        ? await this.disableMany([culprit])
        : { changed: [], failed: [] };
      const failed = [...on.failed, ...off.failed];
      if (failed.length) {
        await this.noteRestoreFailure(current, failed);
        return;
      }
      this.settings.bisect = null;
      this.settings.bisectUndo = null;
      this.bisectError = null;
      await this.saveSettings();
    } finally {
      this.bisectApplying = false;
      this.refreshViews(true, false);
    }
  }

  /**
   * Bring the vault to what this round needs, and confirm it got there.
   *
   * Expressed as a target rather than a diff so the session converges after an
   * Obsidian restart, or after the user toggles something by hand mid-search —
   * either of which would leave a diff-based approach quietly wrong about what
   * is running, and therefore wrong about the culprit.
   *
   * A failure here is not a partial success to report and move on from. If even
   * one plugin didn't move, the vault is not the set the next question is
   * about, and an answer given against it can convict an innocent plugin — so
   * the round is marked unestablished and the UI refuses to take an answer.
   */
  private async applyBisectState(state: BisectState): Promise<boolean> {
    const { enable, disable } = desiredState(state);
    this.bisectApplying = true;
    this.bisectError = null;
    try {
      const off = await this.disableMany(disable);
      const on = await this.enableMany(enable);
      const failed = [...off.failed, ...on.failed];
      if (failed.length) {
        this.bisectError =
          `FlowKit couldn't set your vault up for this round — ${failed
            .map((f) => f.id)
            .join(", ")} wouldn't switch. Answering now would be answering about ` +
          `the wrong set of plugins, so the search is paused. Try again, or stop and restore.`;
        return false;
      }
      return true;
    } finally {
      this.bisectApplying = false;
      this.refreshViews(true, false);
    }
  }

  /**
   * Whether the vault matches the round the persisted search is on.
   *
   * Deliberately a question and not a repair. Re-applying the round
   * automatically on startup looks like the obvious use of a target-shaped
   * state, and it is the wrong thing: FlowKit cannot tell an interrupted
   * transition from a user who went into Community Plugins, switched their
   * plugins back on by hand, and restarted to get out of a search that was
   * going badly. Silently undoing that — before they have even seen the
   * dashboard — is the worst thing this feature could do to somebody already
   * having a bad day. So the drift is surfaced, with both answers offered, and
   * neither is taken for them.
   */
  bisectDrifted(): boolean {
    const state = this.settings.bisect;
    if (!state || state.done) return false;
    const { enable, disable } = desiredState(state);
    return disable.some((id) => this.isEnabled(id)) || enable.some((id) => !this.isEnabled(id));
  }

  /** Put the vault back into the round, at the user's explicit request. */
  async resumeBisect(): Promise<boolean> {
    const state = this.settings.bisect;
    if (!state || state.done) return false;
    return this.applyBisectState(state);
  }

  /**
   * Record that the vault could not be put back, durably.
   *
   * The message is rebuilt from the persisted ids on load, so a restart no
   * longer erases the one fact the user most needs on the screen in front of
   * them.
   */
  private async noteRestoreFailure(
    state: BisectState,
    failed: LifecycleFailure[]
  ): Promise<void> {
    this.bisectError = restoreFailureMessage(failed);
    this.settings.bisect = { ...state, restoreFailed: failed.map((f) => f.id) };
    await this.saveSettings();
  }

  /** Whether a bisect transition is in flight, so the UI can lock its controls. */
  get bisectBusy(): boolean {
    return this.bisectApplying;
  }

  // --- plugin sets ----------------------------------------------------------

  /** Capture the current enabled set under a name. Returns whether it stuck. */
  async saveCurrentProfile(name: string): Promise<boolean> {
    if (!this.canPersist) return false;
    const enabled = [...(this.pluginsApi().enabledPlugins ?? new Set<string>())];
    this.settings.profiles = saveProfile(this.settings.profiles, name, enabled, Date.now());
    await this.saveSettings();
    return true;
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

  /**
   * Switch to a saved set. Returns what it actually changed, for Undo, plus
   * anything that refused to move so the caller can say so rather than
   * reporting a clean switch over a vault that is halfway there.
   */
  async applyProfile(
    profile: PluginProfile
  ): Promise<ProfileDelta & { failed: LifecycleFailure[] }> {
    const delta = this.deltaFor(profile);
    const disabled = await this.disableMany(delta.disable);
    const enabled = await this.enableMany(delta.enable);
    return {
      enable: enabled.changed,
      disable: disabled.changed,
      missing: delta.missing,
      failed: [...disabled.failed, ...enabled.failed],
    };
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
  private recordEvents(
    manifests: PluginManifest[],
    enabledSet: Set<string>,
    now: number
  ): boolean {
    // A bisect switches plugins off and on by design. Recording those as user
    // events would bury a month of real history under one search's noise, and
    // then offer the toggles back as "what changed in your vault".
    //
    // Keyed on the search still RUNNING, not merely existing: a finished search
    // sits in settings until the user acknowledges the result, and gating on
    // its mere presence meant a found-but-unacknowledged culprit switched off
    // change tracking indefinitely.
    if (this.recordingSuspended()) return false;

    // Diffed against what THIS device last saw, never against the shared union.
    //
    // The record used to be one flat map with no notion of whose view it was,
    // which is correct for exactly one device. With settings synced and plugins
    // not — a supported and common Obsidian configuration — a phone with six
    // plugins would diff against a desktop's forty, emit thirty-four
    // "uninstalled" events, and overwrite the map with its own six; the desktop
    // would then emit thirty-four "installed" events and overwrite it back.
    // A vault's change history would be nothing but that, forever.
    const everyDevice = this.settings.seenPlugins;
    const mine = everyDevice[this.deviceId];
    // A device that has never scanned this vault has no baseline of its own,
    // and every plugin on it would otherwise read as newly installed — the
    // fabricated-events mistake, one machine at a time. Its first pass records
    // silently, exactly as the very first pass on the first device did.
    const firstScanHere = mine == null;

    const { events, seen } = diffInstalled(
      mine ?? {},
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
      this.settings.eventBaselineSet && !firstScanHere
    );
    // Other devices' views are carried through untouched; only stale ones go.
    this.settings.seenPlugins = pruneDevices(
      { ...everyDevice, [this.deviceId]: seen },
      now
    );
    if (!this.settings.eventBaselineSet) {
      this.settings.eventBaselineSet = true;
      return true;
    }
    // Worth a write on its own: this device's baseline is what stops the next
    // scan announcing its whole plugin list.
    if (firstScanHere) return true;
    if (!events.length) return false;
    this.settings.events = pruneEvents([...this.settings.events, ...events], now);
    return true;
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
  ): Promise<ProfileRunResult | null> {
    if (!this.runtimeWatcher) return null;
    const watcher = this.runtimeWatcher;
    // Never profile ourselves. Restarting FlowKit mid-run orphans this very
    // loop inside an unloaded instance and silently discards every reading —
    // and we could not time our own load anyway, since we would not be
    // running to observe it.
    const safe = searchableCandidates(ids, this.manifest.id);
    const result = await this.withVaultMutation(() => watcher.profileAll(safe, onProgress));
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
    // other half of what we already knew is still the best data we have —
    // scoped to what is installed, so uninstalling something drops its cache
    // row rather than carrying it in every write for the life of the vault.
    const merged = mergeRemoteCache(this.settings.cache, built, installed);
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
    // The two files are independent, so there is no reason to wait for the
    // first before asking for the second.
    const stats = await Promise.all(
      ["main.js", "styles.css"].map(async (file) => {
        try {
          return await this.app.vault.adapter.stat(`${dir}/${file}`);
        } catch {
          // Missing styles.css is normal; an unreadable main.js just means no score.
          return null;
        }
      })
    );
    let total = 0;
    let sawAny = false;
    for (const stat of stats) {
      if (stat?.type !== "file") continue;
      total += stat.size;
      sawAny = true;
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

  /**
   * Where FlowKit's own settings live, vault-relative.
   *
   * Only ever shown to somebody whose `data.json` could not be read, which is
   * the one situation where "restart and hope" is not a repair and the user has
   * to go and look at the file themselves.
   */
  dataFilePath(): string {
    const dir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
    return `${dir}/data.json`;
  }

  /** Whether Obsidian currently has this plugin enabled. */
  isEnabled(id: string): boolean {
    return this.pluginsApi().enabledPlugins?.has(id) ?? false;
  }

  /**
   * Enable or disable a plugin via Obsidian's internal API, and confirm it
   * happened.
   *
   * Both halves matter. The call used to be optional-chained, so on any build
   * where those internals are absent or renamed it resolved successfully having
   * done nothing — and every caller went on to report a change that never
   * occurred. And the API resolving is not the same as the registry having
   * moved, which is the only thing bisect's next question is valid against.
   */
  async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    const api = this.pluginsApi();
    const fn = enabled ? api.enablePluginAndSave : api.disablePluginAndSave;
    if (typeof fn !== "function") {
      throw new Error(
        `Obsidian's plugin controls aren't available to FlowKit, so it can't ${
          enabled ? "enable" : "disable"
        } ${id}. Use Settings → Community plugins instead.`
      );
    }
    await fn.call(api, id);
    // Bounded settle. The registry projection is not documented to update
    // before the promise resolves, and reporting a successful change as a
    // failure is not a harmless conservatism here — it pauses a bisect and
    // tells the user to go and fix something by hand that is already fine.
    //
    // A single microtask was too narrow a bound for that argument to hold. It
    // covers a projection updated in an already-queued `then`, and nothing
    // else: a registry that settles on a timer, an animation frame, or any
    // continuation scheduled as a macrotask would be declared a failure while
    // the change was in fact seconds from completing. So the microtask is kept
    // as the fast path and one macrotask turn follows it. Still not a poll,
    // and still bounded — the point is to survive plausible ordering, not to
    // wait out a plugin that is genuinely wedged.
    if (this.isEnabled(id) !== enabled) await Promise.resolve();
    if (this.isEnabled(id) !== enabled) {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    if (this.isEnabled(id) !== enabled) {
      throw new Error(`${id} did not ${enabled ? "turn on" : "turn off"}.`);
    }
  }

  /**
   * Switch a set of plugins to `enabled`, one at a time, reporting per-plugin
   * outcomes rather than stopping at the first failure with the vault half
   * moved.
   *
   * Deliberately sequential. Plugin lifecycle calls mutate a shared registry
   * and can depend on each other; the win from parallelising them is small and
   * the failure mode is a vault in a state nobody asked for.
   */
  private async setMany(ids: string[], enabled: boolean): Promise<LifecycleResult> {
    const changed: string[] = [];
    const failed: LifecycleFailure[] = [];
    for (const id of ids) {
      if (this.isEnabled(id) === enabled) continue;
      try {
        await this.setPluginEnabled(id, enabled);
        changed.push(id);
      } catch (err) {
        console.error("FlowKit: could not change", id, err);
        failed.push({ id, error: err });
      }
    }
    return { changed, failed };
  }

  /**
   * Bulk-disable a set of plugins. `changed` is the ids that were verifiably
   * switched off — that's both the honest count to report and exactly what Undo
   * needs to re-enable, so undo can't switch on something the user had off.
   */
  async disableMany(ids: string[]): Promise<LifecycleResult> {
    return this.setMany(ids, false);
  }

  /** Re-enable a set of plugins (the Undo half of a bulk disable). */
  async enableMany(ids: string[]): Promise<LifecycleResult> {
    return this.setMany(ids, true);
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
    // A vault with half its plugins deliberately switched off has not become
    // less healthy, and this is the one recorder that never learned it. The
    // change log and the event log are both suspended during a search and a
    // profiling run; the trend was not, so a search that ran across a day
    // boundary wrote its own surgery into the ninety-day chart as a cliff — and
    // the reading is kept, because the day's entry is replaced rather than
    // appended to. Enforced here rather than at the two call sites, so the next
    // thing that records a snapshot cannot forget.
    if (this.recordingSuspended()) return;
    // Sorted, for the same reason `previousSnapshot` sorts and says why:
    // history survives in data.json across syncs and hand edits, so insertion
    // order is not chronological order. Both things below depend on it being
    // chronological — the same-day dedup reads the LAST entry, and the cap
    // trims from the FRONT — so one out-of-order tail from a sync merge and
    // today's reading is compared against a stale entry, appended instead of
    // replaced, and the cap then starts discarding the newest readings.
    const history = this.settings.history.slice().sort((a, b) => a.at - b.at);
    const stamped: HealthSnapshot = { ...snapshot, device: this.deviceId };

    // Scoped to this device, because a reading from another one is not a
    // reading about this vault as this machine sees it. With settings synced
    // and plugins not, the desktop's forty-plugin score and the phone's
    // six-plugin score were landing in one series — and, being on the same day,
    // silently overwriting each other. `online` and `model` already exist to
    // keep incomparable readings off one line; the device is the third such
    // condition and was the only one unguarded.
    const mine = (h: HealthSnapshot): boolean => this.isThisDevice(h);
    let replaced = false;
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      if (!mine(entry)) continue;
      if (!sameDay(entry.at, stamped.at)) break;
      // Never let a degraded offline reading overwrite a full one from the same
      // day — that turned a network hiccup into an apparent health event.
      if (entry.online && !stamped.online) return;
      history[i] = stamped;
      replaced = true;
      break;
    }
    if (!replaced) history.push(stamped);

    // Capped per device, so a second machine cannot halve the window the first
    // one keeps. The cap was a flat count over a series that now interleaves.
    //
    // Also aged out, which a flat count never needed to do: entries from a
    // device that has stopped syncing — and entries written before devices were
    // told apart — are added to by nothing, so a count-based cap alone would
    // hold its last ninety of them for the life of the vault. Nothing shows a
    // reading older than the 90-day Pro window anyway.
    const oldest = stamped.at - DEVICE_RETENTION_MS;
    const kept = new Map<string, HealthSnapshot[]>();
    for (const entry of history) {
      if (entry.at < oldest) continue;
      const key = entry.device ?? "";
      const bucket = kept.get(key) ?? [];
      bucket.push(entry);
      kept.set(key, bucket);
    }
    const trimmed: HealthSnapshot[] = [];
    for (const bucket of kept.values()) {
      trimmed.push(...bucket.slice(-MAX_HISTORY));
    }
    this.settings.history = trimmed.sort((a, b) => a.at - b.at);
    await this.saveSettings();
  }

  /**
   * Whether a stored reading was taken by this machine.
   *
   * Strict. It used to accept an unstamped reading as this device's, on the
   * reasoning that pre-1.7 readings came from the machine that had been
   * scanning all along and discarding them would blank a chart to prove a
   * point. That reasoning holds for one device and is exactly wrong for the
   * case the device split exists to fix: on a synced vault EVERY pre-1.7
   * reading is unstamped, so both machines claimed all of them and the filter
   * did nothing at all on precisely the vaults it was written for — for up to
   * ninety days. Three separate symptoms came out of that one predicate: a
   * fabricated cliff in the delta line, a second device that could never record
   * its own first reading because the other's same-day entry suppressed it, and
   * "Forget the others" deleting the stamped readings while keeping the
   * unstamped ones causing the mess.
   *
   * The chart is not blanked, because `loadSettings` stamps the legacy series
   * for whichever device upgrades first — which is the intended semantics.
   */
  isThisDevice(snapshot: HealthSnapshot): boolean {
    return snapshot.device === this.deviceId;
  }
}

/** What to say when plugins wouldn't go back the way they were. */
function restoreFailureMessage(failed: LifecycleFailure[] | string[]): string {
  const names = failed
    .map((f) => (typeof f === "string" ? f : f.id))
    .join(", ");
  return (
    `FlowKit couldn't switch ${names} back on. Your original setup is still ` +
    `recorded, so nothing is lost — try again, or turn ${
      failed.length === 1 ? "it" : "them"
    } on from Settings → Community plugins.`
  );
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
