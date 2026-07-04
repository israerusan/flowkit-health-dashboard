import { Platform, Plugin, WorkspaceLeaf } from "obsidian";
import type { PluginManifest } from "obsidian";
import { HealthDashboardView, VIEW_TYPE_HEALTH } from "./view";
import { computeHealth } from "./scoring";
import { fetchCommunityList, fetchRemoteStats } from "./dataSources";
import {
  DEFAULT_SETTINGS,
  FlowKitHealthSettingTab,
  FlowKitHealthSettings,
} from "./settings";
import type { CommunityList, PluginHealth, RemoteStats } from "./types";

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

export default class FlowKitHealthPlugin extends Plugin {
  settings: FlowKitHealthSettings = DEFAULT_SETTINGS;

  /** Session cache of the (multi-MB) community data, so reopening the view or
   *  re-scoring doesn't re-download it. Cleared on an explicit Refresh. */
  private remoteCache: { stats: RemoteStats | null; list: CommunityList | null } | null =
    null;

  async onload(): Promise<void> {
    await this.loadSettings();

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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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
    if (leaf) workspace.revealLeaf(leaf);
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

  isIgnored(id: string): boolean {
    return this.settings.ignored.includes(id);
  }
}
