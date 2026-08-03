import { App, Modal, Setting } from "obsidian";

export interface BisectStartOptions {
  /** How many plugins would be searched. */
  candidateCount: number;
  /** Rounds this will take at most. */
  maxRounds: number;
  /** Whether the user's set will be captured first. */
  snapshotName: string;
  onConfirm: (symptom: string) => void;
}

/**
 * The setup step.
 *
 * Bisect turns plugins off, which is alarming if you don't know it puts them
 * back. Everything the user needs to not be alarmed is stated before the first
 * click: how many rounds, what gets saved, and that cancelling at any point
 * restores exactly what they had.
 */
export class BisectStartModal extends Modal {
  private symptom = "";

  constructor(
    app: App,
    private opts: BisectStartOptions
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText("Find what's breaking your vault");
    contentEl.addClass("flowkit-bisect-modal");

    contentEl.createDiv({
      cls: "flowkit-bulk-intro",
      text:
        `FlowKit will switch off half your plugins, ask whether the problem is still there, ` +
        `and keep halving until one is left. That is at most ${this.opts.maxRounds} question${
          this.opts.maxRounds === 1 ? "" : "s"
        } to search ${this.opts.candidateCount} plugins.`,
    });

    const steps = contentEl.createEl("ul", { cls: "flowkit-bisect-steps" });
    steps.createEl("li", {
      text: `Your current set is saved first, as “${this.opts.snapshotName}”.`,
    });
    steps.createEl("li", {
      text: "Nothing is uninstalled. Plugins are only switched off, the same as doing it by hand.",
    });
    steps.createEl("li", {
      text: "Stop at any point and everything goes back exactly as it was — including if you restart Obsidian mid-search.",
    });
    steps.createEl("li", {
      text: "Some plugins only fully unload after a restart. If the symptom seems not to change, restart and answer again.",
    });

    new Setting(contentEl)
      .setName("What are you looking for?")
      .setDesc("Optional, and for you — FlowKit shows it back at each round so you test the same thing every time.")
      .addText((text) => {
        text
          .setPlaceholder("e.g. typing lags in long notes")
          .onChange((value) => {
            this.symptom = value;
          });
        text.inputEl.addClass("flowkit-bisect-symptom");
      });

    const actions = contentEl.createDiv({ cls: "flowkit-bulk-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const go = actions.createEl("button", { cls: "mod-cta", text: "Start" });
    go.addEventListener("click", () => {
      this.close();
      this.opts.onConfirm(this.symptom.trim());
    });
    go.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
