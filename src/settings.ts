import { App, PluginSettingTab, Setting } from "obsidian";
import type FlowKitHealthPlugin from "./main";

export interface FlowKitHealthSettings {
  /** Fetch community download/maintenance stats. Off = fully local & offline. */
  enableOnlineEnrichment: boolean;
  /** Include disabled plugins in the dashboard. */
  showDisabled: boolean;
  /** Plugin ids the user has muted from the at-risk / unmaintained counts. */
  ignored: string[];
}

export const DEFAULT_SETTINGS: FlowKitHealthSettings = {
  enableOnlineEnrichment: true,
  showDisabled: true,
  ignored: [],
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
}
