import { App, Modal, Setting } from "obsidian";
import type { PluginProfile } from "../profiles";

export interface SaveProfileOptions {
  /** How many plugins are enabled right now. */
  count: number;
  existing: PluginProfile[];
  onConfirm: (name: string) => void;
}

/** Capture the current enabled set under a name. */
export class SaveProfileModal extends Modal {
  private name = "";

  constructor(
    app: App,
    private opts: SaveProfileOptions
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText("Save this plugin set");
    contentEl.addClass("flowkit-bulk-modal");

    contentEl.createDiv({
      cls: "flowkit-bulk-intro",
      text: `Records which ${this.opts.count} plugins are enabled right now, so you can come back to exactly this later.`,
    });

    new Setting(contentEl).setName("Name").addText((text) => {
      text.setPlaceholder("e.g. Writing, Minimal, Known good").onChange((value) => {
        this.name = value;
      });
      text.inputEl.addClass("flowkit-profile-name");
    });

    if (this.opts.existing.length) {
      const list = contentEl.createEl("ul", { cls: "flowkit-bulk-list" });
      for (const profile of this.opts.existing) {
        const li = list.createEl("li");
        li.createSpan({ cls: "flowkit-bulk-name", text: profile.name });
        li.createDiv({
          cls: "flowkit-bulk-detail",
          text: `${profile.ids.length} plugins — saving under this name would replace it`,
        });
      }
    }

    const actions = contentEl.createDiv({ cls: "flowkit-bulk-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const save = actions.createEl("button", { cls: "mod-cta", text: "Save" });
    save.addEventListener("click", () => {
      const trimmed = this.name.trim();
      if (!trimmed) return;
      this.close();
      this.opts.onConfirm(trimmed);
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
