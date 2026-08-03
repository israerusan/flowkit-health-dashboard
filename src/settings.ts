import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type FlowKitHealthPlugin from "./main";
import type {
  HealthChange,
  HealthChangeKind,
  HealthSnapshot,
  PluginErrorRecord,
  RemoteCache,
} from "./types";
import {
  PRODUCT_NAME,
  PRO_FEATURES,
  PRO_PRICE,
  PURCHASE_URL,
  SUPPORT_EMAIL,
} from "./product";

export interface FlowKitHealthSettings {
  /** Fetch community download/maintenance stats. Off = fully local & offline. */
  enableOnlineEnrichment: boolean;
  /** Include disabled plugins in the dashboard. */
  showDisabled: boolean;
  /** Plugin ids the user has muted from the at-risk / unmaintained counts. */
  ignored: string[];
  /** Pro license key (offline-verified). Empty when unlicensed. */
  licenseKey: string;
  /** Pro: recompute automatically whenever the dashboard is opened. */
  autoRefreshOnOpen: boolean;
  /** Rolling history of vault-health snapshots for the trend tracker. */
  history: HealthSnapshot[];
  /**
   * A slim projection of the last successful community-data fetch. The two
   * source files total ~3.7 MB uncompressed and were re-downloaded on every
   * session; this keeps only the handful of fields we actually score on, so the
   * dashboard renders immediately and the network is a background upgrade.
   */
  cache: RemoteCache | null;
  /** Whether the first-run explainer has been dismissed. */
  seenIntro: boolean;
  /** Free users get one full report; this records that it's been spent. */
  usedFreeExport: boolean;
  /** Pro: check for newly-degraded plugins in the background once a day. */
  backgroundMonitoring: boolean;
  /**
   * Which kinds of trouble each plugin is currently in, so we only report a
   * transition once — and can tell when one clears. Was a flat `string[]` of
   * ids; migrated on load.
   */
  notified: Record<string, HealthChangeKind[]>;
  /** What changed and when. Capped; the newest entries are kept. */
  changeLog: HealthChange[];
  /** When the user last dismissed the "since you last looked" strip. */
  lastSeenChangeAt: number | null;
  /**
   * Whether the change baseline has been taken. The first scan after install or
   * upgrade records what is already wrong without reporting it as news.
   */
  changeBaselineSet: boolean;
  /** Watch for runtime errors and attribute them to the plugin that threw. */
  trackErrors: boolean;
  /** Also capture errors plugins catch and log themselves. */
  trackConsoleErrors: boolean;
  /** When error watching started, so "no errors" only counts once it means something. */
  watchingSince: number | null;
  /** Errors observed, keyed by plugin id. Local only; never transmitted. */
  errorLog: Record<string, PluginErrorRecord>;
}

export const DEFAULT_SETTINGS: FlowKitHealthSettings = {
  enableOnlineEnrichment: true,
  showDisabled: true,
  ignored: [],
  licenseKey: "",
  autoRefreshOnOpen: false,
  history: [],
  cache: null,
  seenIntro: false,
  usedFreeExport: false,
  backgroundMonitoring: true,
  notified: {},
  changeLog: [],
  lastSeenChangeAt: null,
  changeBaselineSet: false,
  trackErrors: true,
  trackConsoleErrors: true,
  watchingSince: null,
  errorLog: {},
};

export class FlowKitHealthSettingTab extends PluginSettingTab {
  plugin: FlowKitHealthPlugin;
  /** Live-updated so a rejected key can be explained without a full re-render. */
  private errorEl?: HTMLElement;

  constructor(app: App, plugin: FlowKitHealthPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderProSection(containerEl);

    new Setting(containerEl).setName("Dashboard").setHeading();

    new Setting(containerEl)
      .setName("Online enrichment")
      .setDesc(
        "Fetch popularity (download counts) and maintenance (last-updated) from " +
          "Obsidian's public community data. Turn off to stay fully offline; " +
          "those two metrics then show as unavailable."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableOnlineEnrichment)
          .onChange(async (value) => {
            this.plugin.settings.enableOnlineEnrichment = value;
            await this.plugin.saveSettings();
            // The one toggle that genuinely may need the network: switching
            // enrichment on with no cached data has nothing to show otherwise.
            this.plugin.refreshViews(true, value);
          })
      );

    new Setting(containerEl)
      .setName("Show disabled plugins")
      .setDesc("Include installed-but-disabled plugins in the dashboard.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showDisabled)
          .onChange(async (value) => {
            this.plugin.settings.showDisabled = value;
            await this.plugin.saveSettings();
            this.plugin.refreshViews(true);
          })
      );

    // Free, as of 1.0.0. It was a Pro bullet describing a preference checkbox,
    // which made the other Pro features look equally thin.
    new Setting(containerEl)
      .setName("Re-download community data on open")
      .setDesc(
        "Fetch fresh popularity and maintenance data every time the dashboard " +
          "opens. Off is faster and uses the cached scan; Refresh always refetches."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoRefreshOnOpen)
          .onChange(async (value) => {
            this.plugin.settings.autoRefreshOnOpen = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("Error tracking").setHeading();

    const tracked = Object.keys(this.plugin.settings.errorLog).length;
    new Setting(containerEl)
      .setName("Watch for plugin errors")
      .setDesc(
        "Attribute runtime errors to the plugin that threw them. Everything " +
          "stays on this device — error messages and stack traces are never sent anywhere."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.trackErrors).onChange(async (value) => {
          this.plugin.settings.trackErrors = value;
          if (value && this.plugin.settings.watchingSince == null) {
            this.plugin.settings.watchingSince = Date.now();
          }
          await this.plugin.saveSettings();
          new Notice("Reload Obsidian for this to take effect.");
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("Include errors plugins log themselves")
      .setDesc(
        "Most plugins catch their errors and write them to the console instead " +
          "of letting them surface. These are shown for context but never counted " +
          "against a plugin's score — reporting a failure honestly shouldn't cost points."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.trackConsoleErrors)
          .setDisabled(!this.plugin.settings.trackErrors)
          .onChange(async (value) => {
            this.plugin.settings.trackConsoleErrors = value;
            await this.plugin.saveSettings();
            new Notice("Reload Obsidian for this to take effect.");
          })
      );

    new Setting(containerEl)
      .setName("Recorded errors")
      .setDesc(
        tracked
          ? `Errors recorded for ${tracked} plugin(s). Clearing also restarts the observation window.`
          : "Nothing recorded yet."
      )
      .addButton((btn) =>
        btn
          .setButtonText("Clear")
          .setDisabled(tracked === 0)
          .onClick(async () => {
            await this.plugin.clearErrorLog();
            this.display();
          })
      );

    const monitoring = new Setting(containerEl)
      .setName("Background monitoring")
      .setDesc(
        this.plugin.isPro
          ? "Check quietly for plugins that turn incompatible, go stale, or get pulled from the directory, and tell you when they do."
          : `Pro — get told when a plugin turns incompatible, goes stale, or is removed from the community directory. ${PRO_PRICE}.`
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.backgroundMonitoring && this.plugin.isPro)
          .setDisabled(!this.plugin.isPro)
          .onChange(async (value) => {
            this.plugin.settings.backgroundMonitoring = value;
            await this.plugin.saveSettings();
          })
      );
    if (!this.plugin.isPro) monitoring.settingEl.addClass("flowkit-locked-setting");

    const muted = this.plugin.settings.ignored;
    new Setting(containerEl)
      .setName("Muted plugins")
      .setDesc(
        muted.length
          ? `${muted.length} plugin(s) muted from the at-risk counts: ${muted.join(", ")}`
          : "None. Mute a plugin from the dashboard's row menu to hide it from the at-risk and unmaintained counts."
      )
      .addButton((btn) =>
        btn
          .setButtonText("Clear all")
          .setDisabled(muted.length === 0)
          .onClick(async () => {
            this.plugin.settings.ignored = [];
            await this.plugin.saveSettings();
            this.plugin.refreshViews(true);
            this.display();
          })
      );
  }

  private renderProSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("FlowKit Pro").setHeading();

    const pro = this.plugin.isPro;
    const banner = containerEl.createDiv({
      cls: `flowkit-pro-banner ${pro ? "is-pro" : "is-free"}`,
    });
    if (pro) {
      banner.createEl("strong", { text: "✓ Pro active" });
      banner.createSpan({
        text: this.plugin.licenseEmail
          ? ` — licensed to ${this.plugin.licenseEmail}. Thank you!`
          : " — thank you for supporting FlowKit!",
      });
    } else {
      banner.createEl("strong", { text: `Unlock FlowKit Pro (${PRO_PRICE})` });
      banner.createDiv({
        cls: "flowkit-pro-lead",
        text: "The full diagnosis is free, and stays free. Pro is for acting on it:",
      });
      const list = banner.createEl("ul", { cls: "flowkit-pro-list" });
      for (const f of PRO_FEATURES) list.createEl("li", { text: f });
    }

    new Setting(containerEl)
      .setName("License key")
      .setDesc(
        pro
          ? "Your Pro license is verified and active on this device."
          : "Paste the license key from your purchase email to unlock Pro."
      )
      .addText((text) => {
        text
          .setPlaceholder("payload.signature")
          .setValue(this.plugin.settings.licenseKey)
          .onChange(async (value) => {
            this.plugin.settings.licenseKey = value.trim();
            await this.plugin.saveSettings();
            // Verification is offline and takes microseconds, so re-check every
            // keystroke — but only rebuild the tab when Pro actually FLIPS.
            // display() empties containerEl, which would destroy the very input
            // being typed into and drop focus after the first character.
            const flipped = this.plugin.refreshLicense();
            if (flipped) {
              this.plugin.refreshViews(true);
              this.display();
            } else {
              this.renderLicenseError();
            }
          });
        text.inputEl.addClass("flowkit-license-input");
      });

    this.errorEl = containerEl.createDiv({ cls: "flowkit-license-error" });
    this.renderLicenseError();

    if (!pro) {
      new Setting(containerEl)
        .setName("Get a license")
        .setDesc(
          "Checkout is hosted on my Buy Me a Coffee page. Your key is emailed " +
            "automatically within seconds — no account, no server, no subscription."
        )
        .addButton((btn) =>
          btn
            .setButtonText(`Unlock Pro — ${PRO_PRICE}`)
            .setCta()
            .onClick(() => window.open(PURCHASE_URL, "_blank"))
        );

      const trust = containerEl.createDiv({ cls: "flowkit-pro-trust" });
      trust.createDiv({
        text: "Verified offline. One payment, every device you own, forever.",
      });
      const lost = trust.createDiv();
      lost.appendText("Lost your key or need a refund? ");
      lost.createEl("a", {
        text: SUPPORT_EMAIL,
        href: `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
          `${PRODUCT_NAME} licence`
        )}`,
      });
    }
  }

  /** Show why a pasted key was rejected, without rebuilding the whole tab. */
  private renderLicenseError(): void {
    if (!this.errorEl) return;
    this.errorEl.empty();
    const key = this.plugin.settings.licenseKey;
    if (!key || this.plugin.isPro || !this.plugin.licenseError) return;
    this.errorEl.setText(this.plugin.licenseError);
  }
}
