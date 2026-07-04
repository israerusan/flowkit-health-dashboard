import { App, PluginSettingTab, Setting } from "obsidian";
import type FlowKitHealthPlugin from "./main";
import type { HealthSnapshot } from "./types";
import { PRO_FEATURES, PRO_PRICE, PURCHASE_URL } from "./product";

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
  /** Pro: rolling history of vault-health snapshots for the trend tracker. */
  history: HealthSnapshot[];
}

export const DEFAULT_SETTINGS: FlowKitHealthSettings = {
  enableOnlineEnrichment: true,
  showDisabled: true,
  ignored: [],
  licenseKey: "",
  autoRefreshOnOpen: false,
  history: [],
};

export class FlowKitHealthSettingTab extends PluginSettingTab {
  plugin: FlowKitHealthPlugin;

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
          })
      );

    const autoRefresh = new Setting(containerEl)
      .setName("Auto-refresh on open")
      .setDesc(
        this.plugin.isPro
          ? "Recompute every time the dashboard opens, instead of showing the last scan."
          : "Pro — recompute automatically each time the dashboard opens."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoRefreshOnOpen && this.plugin.isPro)
          .setDisabled(!this.plugin.isPro)
          .onChange(async (value) => {
            this.plugin.settings.autoRefreshOnOpen = value;
            await this.plugin.saveSettings();
          })
      );
    if (!this.plugin.isPro) autoRefresh.settingEl.addClass("flowkit-locked-setting");

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
            this.plugin.refreshLicense();
            // Re-render so the banner/status reflect the new state.
            this.display();
          });
        text.inputEl.addClass("flowkit-license-input");
      });

    if (!pro) {
      new Setting(containerEl)
        .setName("Get a license")
        .setDesc("One-time purchase — supports ongoing development.")
        .addButton((btn) =>
          btn
            .setButtonText("Buy FlowKit Pro")
            .setCta()
            .onClick(() => window.open(PURCHASE_URL, "_blank"))
        );

      if (this.plugin.settings.licenseKey && this.plugin.licenseError) {
        containerEl.createDiv({
          cls: "flowkit-license-error",
          text: this.plugin.licenseError,
        });
      }
    }
  }
}
