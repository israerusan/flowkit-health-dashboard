import { Platform, Plugin, WorkspaceLeaf } from "obsidian";
import type { PluginManifest } from "obsidian";
import { HealthDashboardView, VIEW_TYPE_HEALTH } from "./view";
import { computeHealth } from "./scoring";
import { fetchCommunityList, fetchRemoteStats } from "./dataSources";
import { LicenseManager } from "./license/LicenseManager";
import {
  DEFAULT_SETTINGS,
  FlowKitHealthSettingTab,
  FlowKitHealthSettings,
} from "./settings";
import type {
  CommunityList,
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

    this.addRibbonIcon("activity", "Open Plugin Health Dashboard", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-health-dashboard",
      name: "Open Plugin Health Dashboard",
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
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Re-verify the stored license key and update the Pro entitlement flags. */
  refreshLicense(): void {
    const key = this.settings.licenseKey?.trim();
    if (!key) {
      this.isPro = false;
      this.licenseEmail = undefined;
      this.licenseError = undefined;
      return;
    }
    const result = LicenseManager.verify(key);
    this.isPro = result.valid;
    this.licenseEmail = result.valid ? result.email : undefined;
    this.licenseError = result.valid ? undefined : result.error;
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

  /**
   * Score every installed community plugin. Returns whether online enrichment
   * actually succeeded so the UI can label its confidence honestly.
   *
   * @param forceRefresh re-download community data instead of using the cache.
   */
  async computeAll(
    forceRefresh = false
  ): Promise<{ results: PluginHealth[]; online: boolean }> {
    const api = (this.app as unknown as AppInternals).plugins;
    const manifests = Object.values(api.manifests ?? {});
    const enabledSet = api.enabledPlugins ?? new Set<string>();
    const enabledCount = enabledSet.size;

    let stats: RemoteStats | null = null;
    let list: CommunityList | null = null;
    let online = false;
    if (this.settings.enableOnlineEnrichment) {
      if (forceRefresh || !this.remoteCache) {
        const [fetchedStats, fetchedList] = await Promise.all([
          fetchRemoteStats(),
          fetchCommunityList(),
        ]);
        this.remoteCache = { stats: fetchedStats, list: fetchedList };
      }
      stats = this.remoteCache.stats;
      list = this.remoteCache.list;
      online = stats != null;
    } else {
      // Enrichment turned off — drop any cached data so re-enabling refetches.
      this.remoteCache = null;
    }

    const now = Date.now();
    const ignored = new Set(this.settings.ignored);
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
            enabledCount,
            repo: list?.[manifest.id]?.repo,
            remote: stats?.[manifest.id],
            inCommunityList: list ? manifest.id in list : null,
            muted: ignored.has(manifest.id),
          },
          now
        )
      );
    }
    return { results, online };
  }

  /** Enable or disable a plugin via Obsidian's internal API. */
  async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    const api = (this.app as unknown as AppInternals).plugins;
    if (enabled) await api.enablePluginAndSave?.(id);
    else await api.disablePluginAndSave?.(id);
  }

  /** Bulk-disable a set of plugins (Pro bulk actions). Returns the count. */
  async disableMany(ids: string[]): Promise<number> {
    let count = 0;
    for (const id of ids) {
      await this.setPluginEnabled(id, false);
      count++;
    }
    return count;
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

  /** Mute several plugins at once, persisting a single time (Pro bulk action). */
  async muteMany(ids: string[]): Promise<number> {
    const set = new Set(this.settings.ignored);
    const before = set.size;
    for (const id of ids) set.add(id);
    this.settings.ignored = [...set];
    await this.saveSettings();
    return set.size - before;
  }

  isIgnored(id: string): boolean {
    return this.settings.ignored.includes(id);
  }

  // --- Pro: health-trend history ------------------------------------------

  /** The most recent snapshot recorded before `at`, for delta display. */
  previousSnapshot(at: number): HealthSnapshot | null {
    const prior = this.settings.history.filter((s) => s.at < at);
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
