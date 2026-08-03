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
 * switches back on everything the search switched off.
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
    // "Exactly as it was" is the one claim this modal must not make, and it is
    // the claim `restoreState` explicitly declines to honour: a search only
    // ever switches plugins OFF, so undoing it is entirely the switching-back-on
    // side — and it deliberately does not reverse anything the user turned on
    // themselves mid-search. Consent copy has to describe the guarantee the
    // code actually gives, not the tidier one.
    steps.createEl("li", {
      text: "Stop at any point and every plugin the search switched off goes back on — including if you restart Obsidian mid-search. Anything you switch on yourself along the way is left alone.",
    });
    steps.createEl("li", {
      text: "Some plugins only fully unload after a restart. If the symptom seems not to change, restart and answer again.",
    });
    // Said before the first click, not implied by the wording of the result.
    //
    // Elimination finds ONE plugin that reproduces the problem on its own. It
    // cannot find two plugins that are only broken together, and against that
    // kind of fault it will still run to completion and still name somebody —
    // which is the one way this feature can be confidently wrong. The finishing
    // copy hedges carefully; the consent step said nothing at all, which is the
    // wrong way round for a claim a user is about to act on.
    steps.createEl("li", {
      text: "It looks for one plugin acting alone. If two only misbehave together, the search can still end up naming just one of them — so treat the answer as where to look first.",
    });
    steps.createEl("li", {
      text: "Answered the wrong way by mistake? Each round offers to undo the previous answer.",
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
