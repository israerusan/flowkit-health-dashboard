import { App, Modal, Setting } from "obsidian";

export type MuteKind = "30d" | "until-update" | "forever";

export interface MuteOptions {
  pluginName: string;
  /** The Obsidian version the "until Obsidian updates" option is anchored to. */
  appVersion: string;
  onConfirm: (kind: MuteKind, reason?: string) => void;
}

/**
 * Muting, with a reason and an end date.
 *
 * A one-click permanent mute is a way to make a real problem invisible forever,
 * and the previous menu item offered nothing else — so six months later nobody
 * remembers why a plugin is muted or whether the reason still holds. The three
 * spans here are the three honest answers: I'll deal with it later, it's fine on
 * *this* Obsidian, and I've decided.
 */
export class MuteModal extends Modal {
  private kind: MuteKind = "30d";
  private reason = "";

  constructor(
    app: App,
    private opts: MuteOptions
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText(`Mute ${this.opts.pluginName}`);
    contentEl.addClass("flowkit-mute-modal");

    contentEl.createDiv({
      cls: "flowkit-bulk-intro",
      text:
        "Muted plugins keep their scores but drop out of every count, finding " +
        "and notification. Its score stays visible in the table.",
    });

    new Setting(contentEl)
      .setName("For how long")
      .addDropdown((drop) => {
        drop
          .addOption("30d", "30 days")
          .addOption("until-update", `Until Obsidian updates from ${this.opts.appVersion}`)
          .addOption("forever", "Indefinitely")
          .setValue(this.kind)
          .onChange((value) => {
            this.kind = value as MuteKind;
          });
      });

    new Setting(contentEl)
      .setName("Reason")
      .setDesc("Optional, and for you — it is shown next to the plugin later.")
      .addText((text) => {
        text
          .setPlaceholder("e.g. author knows, fix is on main")
          .onChange((value) => {
            this.reason = value;
          });
        // No re-render on change, so the field survives being typed into.
        text.inputEl.addClass("flowkit-mute-reason");
      });

    const actions = contentEl.createDiv({ cls: "flowkit-bulk-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());

    const confirm = actions.createEl("button", { cls: "mod-cta", text: "Mute" });
    confirm.addEventListener("click", () => {
      this.close();
      this.opts.onConfirm(this.kind, this.reason.trim() || undefined);
    });
    confirm.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
