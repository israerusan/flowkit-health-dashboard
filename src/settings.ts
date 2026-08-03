import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type FlowKitHealthPlugin from "./main";
import type { BisectState } from "./bisect";
import type { MuteMap } from "./mutes";
import { describeMute } from "./mutes";
import { AUTO_SNAPSHOT, type PluginProfile } from "./profiles";
import type { PluginEvent, SeenMap } from "./timeline";
import type { RepoActivityMap } from "./repoActivity";
import type { RuntimeProfiles } from "./runtime";
import type {
  AppVersionChange,
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
  /**
   * Plugin ids muted before 1.3, migrated into `mutes` on load and then left
   * alone. Kept so downgrading doesn't silently un-mute everything.
   */
  ignored: string[];
  /** Muted plugins, with the reason and the expiry the user chose. */
  mutes: MuteMap;
  /**
   * Plugins the user has asked to be told about specifically. A vault-wide
   * report is global noise; three plugins someone actually depends on is not.
   */
  watched: string[];
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
  /**
   * Vestigial. It once recorded that a free user had spent their single
   * report, back when Markdown export was rationed; it is neither written nor
   * read now — the Markdown report is free and unlimited, and only CSV is Pro.
   * Kept in the type so an existing `data.json` carrying it round-trips
   * unchanged rather than being silently rewritten.
   */
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
   * When the user last dismissed the Obsidian-update banner.
   *
   * Its own field. Both dismiss buttons used to write `lastSeenChangeAt`, which
   * gates the changes strip as well — so closing the update banner silently
   * marked every unread health change as seen, on the same render, and the
   * change log is read in exactly one place so they never came back.
   */
  appUpdateSeenAt: number | null;
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
  /**
   * Measure what plugins cost while running — load time and repeating timers.
   * Requires wrapping `setInterval` and Obsidian's plugin loader, so it is a
   * switch rather than an assumption.
   */
  trackRuntime: boolean;
  /** Measured load times, keyed by plugin id. Timers are session-only. */
  runtimeProfiles: RuntimeProfiles;
  /**
   * Ask GitHub's API whether a plugin's repository is archived or still being
   * pushed to. Off by default: it is the only thing here that talks to an API
   * rather than downloading a public file, and it names your plugins to it.
   */
  checkRepoActivity: boolean;
  /** Cached repository readings, keyed by plugin id. */
  repoActivity: RepoActivityMap;
  /** The Obsidian version the last scan ran against, to detect an update. */
  lastApiVersion: string | null;
  /** The most recent Obsidian update and what it broke, for the post-update view. */
  appVersionChange: AppVersionChange | null;
  /** When the last scan completed, so the dashboard can say how old it is. */
  lastScanAt: number | null;
  /**
   * An in-progress bisect. Persisted rather than held in memory because
   * reproducing a problem often means restarting Obsidian — and coming back to
   * a vault with half its plugins off and no record of which would be worse
   * than never having started.
   */
  bisect: BisectState | null;
  /**
   * The round as it stood before the last answer, so a mis-click is
   * recoverable.
   *
   * Bisect asks a question with two buttons and no way back, and each answer
   * permanently eliminates half the remaining candidates — so one slip means a
   * search that runs to completion and confidently names the wrong plugin, with
   * nothing on screen to suggest anything went wrong. One step is the whole
   * requirement: people notice a wrong click immediately, not four rounds
   * later, and a full history would invite unwinding into rounds whose vault
   * state has long since been overwritten.
   */
  bisectUndo: BisectState | null;
  /** What each plugin looked like on the last scan, to notice it changing. */
  seenPlugins: SeenMap;
  /** Installs, updates, removals and toggles, newest last. Pruned to 90 days. */
  events: PluginEvent[];
  /** Whether the install baseline has been taken; the first scan is silent. */
  eventBaselineSet: boolean;
  /** Saved sets of enabled plugins. */
  profiles: PluginProfile[];
}

export const DEFAULT_SETTINGS: FlowKitHealthSettings = {
  enableOnlineEnrichment: true,
  showDisabled: true,
  ignored: [],
  mutes: {},
  watched: [],
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
  appUpdateSeenAt: null,
  changeBaselineSet: false,
  trackErrors: true,
  trackConsoleErrors: true,
  watchingSince: null,
  errorLog: {},
  trackRuntime: true,
  runtimeProfiles: {},
  checkRepoActivity: false,
  repoActivity: {},
  lastApiVersion: null,
  appVersionChange: null,
  lastScanAt: null,
  bisect: null,
  bisectUndo: null,
  seenPlugins: {},
  events: [],
  eventBaselineSet: false,
  profiles: [],
};

/** How long typing a licence key runs ahead of the write to disk. */
const LICENSE_SAVE_DEBOUNCE_MS = 600;

export class FlowKitHealthSettingTab extends PluginSettingTab {
  plugin: FlowKitHealthPlugin;
  /** Live-updated so a rejected key can be explained without a full re-render. */
  private errorEl?: HTMLElement;
  /**
   * The pending licence-key write. Held on the tab rather than in the input's
   * closure, for the same reason the dashboard's search timer is held on the
   * view: `display()` replaces the input, and a timer captured in the old one
   * would still fire afterwards.
   */
  private licenseSaveTimer: number | null = null;

  constructor(app: App, plugin: FlowKitHealthPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  hide(): void {
    // Closing the settings window must not lose a key typed a moment ago.
    this.flushLicenseSave();
  }

  private queueLicenseSave(): void {
    if (this.licenseSaveTimer != null) window.clearTimeout(this.licenseSaveTimer);
    this.licenseSaveTimer = window.setTimeout(() => {
      this.licenseSaveTimer = null;
      this.saveLicenseNow();
    }, LICENSE_SAVE_DEBOUNCE_MS);
  }

  /** Write a pending licence edit now, if there is one. */
  private flushLicenseSave(): void {
    // Only when something is actually waiting — otherwise merely closing the
    // settings window would rewrite the whole file for nothing.
    if (this.licenseSaveTimer == null) return;
    window.clearTimeout(this.licenseSaveTimer);
    this.licenseSaveTimer = null;
    this.saveLicenseNow();
  }

  private saveLicenseNow(): void {
    void this.plugin.saveSettings().catch((err) => {
      console.error("FlowKit: could not save the licence key", err);
      new Notice("FlowKit couldn't save your licence key — see the console.", 8000);
    });
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

    new Setting(containerEl)
      .setName("Check repository activity")
      .setDesc(
        "Ask GitHub whether a plugin's repository has been archived or is still " +
          "being pushed to. This is what separates a plugin that is finished from " +
          "one that was abandoned — release dates alone can't. Only plugins whose " +
          "maintenance verdict is genuinely in doubt are looked up, a few per scan, " +
          "cached for a week. It sends nothing but the repository name, which is " +
          "already public."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.checkRepoActivity)
          .setDisabled(!this.plugin.settings.enableOnlineEnrichment)
          .onChange(async (value) => {
            this.plugin.settings.checkRepoActivity = value;
            await this.plugin.saveSettings();
            this.plugin.refreshViews(true, value);
          })
      );

    new Setting(containerEl).setName("Performance").setHeading();

    new Setting(containerEl)
      .setName("Measure what plugins cost while running")
      .setDesc(
        "Time plugin loads and notice repeating timers, so Footprint reflects " +
          "what a plugin does rather than only how big it is. Only measurements " +
          "FlowKit actually witnesses are used — a plugin it couldn't observe is " +
          "never penalised for it. Requires a reload to take effect."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.trackRuntime).onChange(async (value) => {
          this.plugin.settings.trackRuntime = value;
          if (!value) this.plugin.settings.runtimeProfiles = {};
          await this.plugin.saveSettings();
          new Notice("Reload Obsidian for this to take effect.");
          this.display();
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

    new Setting(containerEl).setName("Saved plugin sets").setHeading();

    const profiles = this.plugin.settings.profiles;
    // The automatic pre-search snapshot is an ordinary entry in this array, and
    // it is the ONLY thing the salvage panel can offer when a persisted search
    // turns out to be unreadable. "Clear all" deleted it like any other set,
    // with no warning, while a search might have half the vault switched off —
    // the same way to lose the record of the real plugin set that starting a
    // second search used to be, reached from a different button.
    const searchOpen = this.plugin.bisect != null || this.plugin.bisectSalvage != null;
    new Setting(containerEl)
      .setName("Profiles")
      .setDesc(
        profiles.length
          ? `${profiles.length} saved. Switching between them from the dashboard turns the right plugins on and the rest off — the one thing here that genuinely can't be done by hand in half a minute.${
              searchOpen
                ? ` A plugin search is open, so “${AUTO_SNAPSHOT}” is kept — it is how your vault gets put back.`
                : ""
            }`
          : "None yet. Save your current set from the dashboard, so there is always a recorded way back."
      )
      .addButton((btn) =>
        btn
          .setButtonText("Clear all")
          .setDisabled(profiles.length === 0)
          .onClick(async () => {
            this.plugin.settings.profiles = searchOpen
              ? profiles.filter((p) => p.name === AUTO_SNAPSHOT)
              : [];
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (profiles.length) {
      const list = containerEl.createEl("ul", { cls: "flowkit-settings-list" });
      for (const profile of profiles) {
        list.createEl("li", {
          text: `${profile.name} — ${profile.ids.length} plugin(s)`,
        });
      }
    }

    const events = this.plugin.settings.events.length;
    new Setting(containerEl)
      .setName("Change history")
      .setDesc(
        events
          ? `${events} recorded install, update and removal(s) over the last 90 days. This is what lets FlowKit say "it started erroring two hours after that update".`
          : "Nothing recorded yet. FlowKit notes installs, updates and removals as it sees them."
      )
      .addButton((btn) =>
        btn
          .setButtonText("Clear")
          .setDisabled(events === 0)
          .onClick(async () => {
            this.plugin.settings.events = [];
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
            this.display();
          })
      );

    new Setting(containerEl).setName("Muted and watched").setHeading();

    const mutes = Object.entries(this.plugin.settings.mutes);
    const now = Date.now();
    new Setting(containerEl)
      .setName("Muted plugins")
      .setDesc(
        mutes.length
          ? `${mutes.length} plugin(s) muted from the at-risk counts. Mutes with an expiry lapse on their own; FlowKit tells you when one does.`
          : "None. Mute a plugin from the dashboard's row menu to hide it from the at-risk and unmaintained counts."
      )
      .addButton((btn) =>
        btn
          .setButtonText("Clear all")
          .setDisabled(mutes.length === 0)
          .onClick(async () => {
            this.plugin.settings.mutes = {};
            this.plugin.settings.ignored = [];
            await this.plugin.saveSettings();
            this.plugin.refreshViews(true);
            this.display();
          })
      );

    if (mutes.length) {
      const list = containerEl.createEl("ul", { cls: "flowkit-settings-list" });
      for (const [id, rec] of mutes) {
        list.createEl("li", { text: `${id} — ${describeMute(rec, now)}` });
      }
    }

    const watched = this.plugin.settings.watched;
    new Setting(containerEl)
      .setName("Watched plugins")
      .setDesc(
        watched.length
          ? `Told about first, and never recommended for a bulk disable: ${watched.join(", ")}`
          : "None. Star a plugin from the dashboard's row menu to have FlowKit lead with it whenever something changes."
      )
      .addButton((btn) =>
        btn
          .setButtonText("Clear all")
          .setDisabled(watched.length === 0)
          .onClick(async () => {
            this.plugin.settings.watched = [];
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
          .onChange((value) => {
            this.plugin.settings.licenseKey = value.trim();
            // Verification is offline and takes microseconds, so re-check every
            // keystroke — but only rebuild the tab when Pro actually FLIPS.
            // display() empties containerEl, which would destroy the very input
            // being typed into and drop focus after the first character.
            const flipped = this.plugin.refreshLicense();
            // The WRITE is debounced, and that is a different question from the
            // check. Every save clones and rewrites the whole settings object —
            // cache, history, error log, runtime readings, saved sets — so
            // pasting a licence key character by character, or typing one out
            // on a phone, meant a full `data.json` rewrite per keystroke, and
            // one sync event each on a synced vault. A key that verifies is
            // written immediately; everything else waits until the typing
            // stops.
            if (flipped) {
              // A key that just verified is written at once — this is the
              // moment somebody has paid, and it must survive a crash.
              this.flushLicenseSave();
              this.saveLicenseNow();
              this.plugin.refreshViews(true);
              this.display();
              return;
            }
            this.queueLicenseSave();
            this.renderLicenseError();
          });
        text.inputEl.addClass("flowkit-license-input");
        // Leaving the field is a commit: waiting out a timer to persist
        // something the user has visibly finished typing is how a key looks
        // accepted and isn't there after a restart.
        text.inputEl.addEventListener("blur", () => this.flushLicenseSave());
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
