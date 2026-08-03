// Central product metadata and marketing copy. Keeping these in one place keeps
// the license binding, the upsell surfaces, and the settings copy consistent —
// LicenseManager, scripts/generate-license.mjs, and every CTA read from here.

/** Signed into every license payload; a key only unlocks the product it names. */
export const PRODUCT_ID = "flowkit-health-dashboard";

export const PRODUCT_NAME = "FlowKit Health Dashboard";
export const PRO_NAME = "FlowKit Pro";

/** One-time price. Kept in one place so every surface stays consistent. */
export const PRO_PRICE = "$9 one-time";

/**
 * Where "Unlock Pro" sends people. Deliberately NOT the same as the manifest's
 * `fundingUrl`: when the donate heart and the buy button lead to the same page,
 * every surface codes the price as a tip.
 */
export const PURCHASE_URL = "https://buymeacoffee.com/vaultspotlight/e/560206";

/** Where a buyer goes when the key doesn't arrive, or they want a refund. */
export const SUPPORT_EMAIL = "iavila01@gmail.com";

/**
 * What Pro unlocks, framed as capability rather than withheld information. The
 * complete diagnosis is free; Pro buys acting on it safely, keeping a record,
 * and being told when something changes.
 */
export const PRO_FEATURES: string[] = [
  "Bulk fixes in one click — review exactly what will change, apply it, undo if you disagree",
  "Background monitoring — get told when a plugin turns incompatible, goes stale, or is pulled from the directory",
  "Unlimited reports — Markdown and CSV, as a document you can hand to someone",
  "90 days of vault-health history, instead of the last 30",
];

/** One-line pitch, reused across upsell surfaces. */
export const PRO_TAGLINE = `${PRO_PRICE}, no subscription, no account. Verified offline, on every device you own.`;

/** Contextual upsell copy, keyed by the feature the user reached for. */
export const PRO_UPSELL: Record<string, string> = {
  bulk: "Applying fixes in one click is a Pro feature.",
  export: "Unlimited report export is a Pro feature.",
  history: "The full 90-day history is a Pro feature.",
  monitoring: "Background monitoring is a Pro feature.",
};
