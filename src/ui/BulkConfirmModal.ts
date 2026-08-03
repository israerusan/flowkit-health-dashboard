import { App, Modal } from "obsidian";

export interface BulkConfirmRow {
  name: string;
  /** Why this plugin is in the list — the evidence, not a restatement. */
  detail: string;
}

export interface BulkConfirmOptions {
  title: string;
  /** One sentence stating exactly what the button will do. */
  intro: string;
  rows: BulkConfirmRow[];
  confirmLabel: string;
  /** Shown under the list when the action is destructive. */
  caveat?: string;
  onConfirm: () => void;
}

/**
 * A review step in front of every bulk action. The dashboard used to disable a
 * set of plugins the instant the button was pressed, with no list of what was
 * about to happen and no way back — which made the most powerful thing the
 * product does also the scariest. Naming each plugin and its evidence turns the
 * same operation into the reason to buy it.
 */
export class BulkConfirmModal extends Modal {
  constructor(
    app: App,
    private opts: BulkConfirmOptions
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText(this.opts.title);
    contentEl.addClass("flowkit-bulk-modal");

    contentEl.createDiv({ cls: "flowkit-bulk-intro", text: this.opts.intro });

    const list = contentEl.createEl("ul", { cls: "flowkit-bulk-list" });
    for (const row of this.opts.rows) {
      const li = list.createEl("li");
      li.createSpan({ cls: "flowkit-bulk-name", text: row.name });
      li.createDiv({ cls: "flowkit-bulk-detail", text: row.detail });
    }

    if (this.opts.caveat) {
      contentEl.createDiv({ cls: "flowkit-bulk-caveat", text: this.opts.caveat });
    }

    const actions = contentEl.createDiv({ cls: "flowkit-bulk-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());

    const confirm = actions.createEl("button", {
      cls: "mod-cta",
      text: this.opts.confirmLabel,
    });
    // Modal is not a Component, so there is no registerDomEvent here. onClose()
    // empties contentEl, which takes these buttons and their listeners with it.
    confirm.addEventListener("click", () => {
      this.close();
      this.opts.onConfirm();
    });
    confirm.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
