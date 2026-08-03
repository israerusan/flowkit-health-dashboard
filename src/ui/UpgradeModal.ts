import { App, Modal, Notice } from "obsidian";
import {
  PRODUCT_NAME,
  PRO_FEATURES,
  PRO_NAME,
  PRO_PRICE,
  PRO_TAGLINE,
  PRO_UPSELL,
  PURCHASE_URL,
  SUPPORT_EMAIL,
} from "../product";

export interface UpgradeContext {
  /** Which locked feature the user reached for, if any. */
  feature?: keyof typeof PRO_UPSELL;
  /** A line built from this vault's real numbers, e.g. "Fix 17 issues…". */
  headline?: string;
  /** Verify a pasted key; returns true when it activated. */
  activate: (key: string) => Promise<boolean>;
}

/**
 * The single upgrade surface.
 *
 * Every locked control used to call `window.open(PURCHASE_URL)` directly, so
 * clicking the greyed-out Export button while exploring the toolbar ejected the
 * user out of Obsidian into a checkout page they had not asked for. Nothing
 * leaves the app now without a second, deliberate click — and a user who
 * already has a key can activate it here rather than being sent to settings.
 */
export class UpgradeModal extends Modal {
  constructor(
    app: App,
    private ctx: UpgradeContext
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText(`${PRO_NAME} — ${PRO_PRICE}`);
    contentEl.addClass("flowkit-upgrade");

    if (this.ctx.headline) {
      contentEl.createDiv({ cls: "flowkit-upgrade-headline", text: this.ctx.headline });
    }
    const lead = this.ctx.feature ? PRO_UPSELL[this.ctx.feature] : undefined;
    if (lead) contentEl.createDiv({ cls: "flowkit-upgrade-lead", text: lead });

    const list = contentEl.createEl("ul", { cls: "flowkit-upgrade-list" });
    for (const f of PRO_FEATURES) list.createEl("li", { text: f });

    contentEl.createDiv({ cls: "flowkit-upgrade-tagline", text: PRO_TAGLINE });

    // Activation, without a round-trip through the settings pane.
    const keyRow = contentEl.createDiv({ cls: "flowkit-upgrade-key" });
    const input = keyRow.createEl("input", {
      type: "text",
      placeholder: "Already have a key? Paste it here",
    });
    const apply = keyRow.createEl("button", { text: "Activate" });
    const status = contentEl.createDiv({ cls: "flowkit-upgrade-status" });
    // Announced: this div is the only feedback a rejected key produces, and it
    // appears by being written into rather than by anything moving.
    status.setAttr("role", "status");
    status.setAttr("aria-live", "polite");

    const activate = (): void => {
      const key = input.value.trim();
      if (!key) return;
      // The `.catch` is the point. `activate` awaits `saveSettings()`, which
      // genuinely rejects on a read-only or sync-locked vault — and without a
      // handler the `.then` simply never ran: no notice, no status text, not
      // even a console line. Somebody who had just paid clicked Activate and
      // got nothing at all, twice, with no way to tell whether the key was bad
      // or the disk was. This is the last screen before a refund request.
      void this.ctx
        .activate(key)
        .then((ok) => {
          if (ok) {
            new Notice(`${PRO_NAME} activated. Thank you!`);
            this.close();
          } else {
            status.setText("That key didn't verify. Check it was copied in full.");
          }
        })
        .catch((err) => {
          console.error("FlowKit: could not activate the licence key", err);
          status.setText(
            "Your key couldn't be saved — FlowKit can't write its settings file right now. " +
              "The key itself may well be fine; try again, or restart Obsidian."
          );
        });
    };

    apply.addEventListener("click", activate);
    // Pasting a key and pressing Enter is what everybody does.
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        activate();
      }
    });

    const actions = contentEl.createDiv({ cls: "flowkit-upgrade-actions" });
    const buy = actions.createEl("button", {
      cls: "mod-cta",
      text: `Open checkout — ${PRO_PRICE}`,
    });
    // The only thing in the plugin that opens an external page.
    buy.addEventListener("click", () => window.open(PURCHASE_URL, "_blank"));

    const footer = contentEl.createDiv({ cls: "flowkit-upgrade-footer" });
    footer.createDiv({
      text: "Checkout is hosted on my Buy Me a Coffee page. Your key is emailed automatically within seconds.",
    });
    const help = footer.createDiv();
    help.appendText("Key didn't arrive, or want a refund? ");
    help.createEl("a", {
      text: SUPPORT_EMAIL,
      href: `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
        `${PRODUCT_NAME} licence`
      )}`,
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
