import { Platform, Plugin, WorkspaceLeaf } from "obsidian";
import type { PluginManifest } from "obsidian";
import { HealthDashboardView, VIEW_TYPE_HEALTH } from "./view";
import { buildDownloadRanker, classifyListing, computeHealth } from "./scoring";
import {
  describeFailure,
  fetchCommunityList,
  fetchRemoteStats,
} from "./dataSources";
import { LicenseManager } from "./license/LicenseManager";
import {
  DEFAULT_SETTINGS,
  FlowKitHealthSettingTab,
  FlowKitHealthSettings,
} from "./settings";
import type {
  CommunityList,
  DataCoverage,
  HealthSnapshot,
  PluginHealth,
  RemoteStats,
} from "./types";

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

type AppInternals = {
  plugins: InternalPluginsApi;
  setting?: InternalSettingApi;
};

/** Cap on stored trend snapshots — plenty for a readable history. */
const MAX_HISTORY = 90;

export default class FlowKitHealthPlugin extends Plugin {
  settings: FlowKitHealthSettings = DEFAULT_SETTINGS;

  /** Pro entitlement, derived from the license key on load / change. */
  isPro = false;
  licenseEmail?: string;
  licenseError?: string;

  /** Session cache of the (multi-MB) community data, so reopening the view or
   *  re-scoring doesn't re-download it. Cleared on an explicit Refresh. */
  private remoteCache: { stats: RemoteStats | null; list: CommunityList | null } | null =
    null;

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
  }

  onunload(): void {
    // Leaves of our view type are detached automatically by Obsidian.
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
  refreshViews(rescan = false): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_HEALTH)) {
      const view = leaf.view;
      if (!(view instanceof HealthDashboardView)) continue;
      if (rescan) void view.refresh();
      else view.rerender();
    }
  }

  /** Reveal the dashboard in the right sidebar, creating it if needed. */
  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null =
      workspace.getLeavesOfType(VIEW_TYPE_HEALTH)[0] ?? null;

    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: VIEW_TYPE_HEALTH, active: true });
    }
    // `void` the reveal so no-floating-promises is satisfied (revealLeaf gained a
    // Promise return in 1.7.2; we don't consume it).
    if (leaf) void this.app.workspace.revealLeaf(leaf);
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
   * @param forceRefresh re-download community data instead of using the cache.
   */
  async computeAll(
    forceRefresh = false
  ): Promise<{ results: PluginHealth[]; coverage: DataCoverage }> {
    const api = this.pluginsApi();
    const manifests = Object.values(api.manifests ?? {});
    const enabledSet = api.enabledPlugins ?? new Set<string>();

    let stats: RemoteStats | null = null;
    let list: CommunityList | null = null;
    const coverage: DataCoverage = {
      stats: false,
      list: false,
      disabled: !this.settings.enableOnlineEnrichment,
    };

    if (this.settings.enableOnlineEnrichment) {
      if (forceRefresh || !this.remoteCache) {
        const [statsRes, listRes] = await Promise.all([
          fetchRemoteStats(),
          fetchCommunityList(),
        ]);
        if (!statsRes.ok) {
          coverage.error = describeFailure(statsRes.reason, statsRes.status);
        } else if (!listRes.ok) {
          coverage.error = describeFailure(listRes.reason, listRes.status);
        }
        // Only remember a scan that produced something. Caching a total failure
        // would pin the whole session offline: `{stats:null,list:null}` is
        // truthy, so every later non-forced call would short-circuit on it.
        if (statsRes.ok || listRes.ok) {
          this.remoteCache = {
            stats: statsRes.ok ? statsRes.data : null,
            list: listRes.ok ? listRes.data : null,
          };
        } else {
          this.remoteCache = null;
        }
      }
      stats = this.remoteCache?.stats ?? null;
      list = this.remoteCache?.list ?? null;
      coverage.stats = stats != null;
      coverage.list = list != null;
    } else {
      // Enrichment turned off — drop any cached data so re-enabling refetches.
      this.remoteCache = null;
    }

    const now = Date.now();
    const ignored = new Set(this.settings.ignored);
    const ranker = buildDownloadRanker(stats);
    const results: PluginHealth[] = [];
    for (const manifest of manifests) {
      const enabled = enabledSet.has(manifest.id);
      if (!enabled && !this.settings.showDisabled) continue;

      results.push(
        computeHealth(
          {
            manifest,
            enabled,
            isMobile: Platform.isMobile,
            repo: list?.[manifest.id]?.repo,
            remote: stats?.[manifest.id],
            bundleBytes: await this.measureBundle(manifest),
            downloadPercentile: ranker(stats?.[manifest.id]?.downloads),
            listing: classifyListing(manifest.id, stats, list),
            muted: ignored.has(manifest.id),
          },
          now
        )
      );
    }
    return { results, coverage };
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

  /** Toggle a plugin's muted state and persist it. */
  async toggleIgnore(id: string): Promise<void> {
    const set = new Set(this.settings.ignored);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    this.settings.ignored = [...set];
    await this.saveSettings();
  }

  /**
   * Mute several plugins at once, persisting a single time. Returns the ids
   * that weren't already muted, so Undo only unmutes what this action did.
   */
  async muteMany(ids: string[]): Promise<string[]> {
    const set = new Set(this.settings.ignored);
    const changed = ids.filter((id) => !set.has(id));
    for (const id of changed) set.add(id);
    if (changed.length) {
      this.settings.ignored = [...set];
      await this.saveSettings();
    }
    return changed;
  }

  /** Unmute a set of plugins (the Undo half of a bulk mute). */
  async unmuteMany(ids: string[]): Promise<string[]> {
    const set = new Set(this.settings.ignored);
    const changed = ids.filter((id) => set.has(id));
    for (const id of changed) set.delete(id);
    if (changed.length) {
      this.settings.ignored = [...set];
      await this.saveSettings();
    }
    return changed;
  }

  isIgnored(id: string): boolean {
    return this.settings.ignored.includes(id);
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
   * Record a vault-health snapshot for the trend tracker (Pro only). To keep
   * the history compact, it replaces the last entry when it's from the same
   * calendar day, and otherwise appends — capping the list to a recent window.
   */
  async recordSnapshot(snapshot: HealthSnapshot): Promise<void> {
    if (!this.isPro) return;
    const history = this.settings.history.slice();
    const last = history[history.length - 1];
    if (last && sameDay(last.at, snapshot.at)) {
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
