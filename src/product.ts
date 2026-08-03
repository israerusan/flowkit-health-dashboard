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
 * What Pro unlocks.
 *
 * Reordered in 1.4.0, and the reason is worth keeping. The headline used to be
 * "bulk fixes in one click", which asks somebody to pay for the difference
 * between one click and three — a thirty-second job they can do in Obsidian's
 * own settings. Bulk fixes are free now. What is left is the set of things a
 * user genuinely cannot do by hand: an automated binary search, a full startup
 * profile, switching twenty plugins at once and back again, and being told the
 * moment something starts failing while they weren't looking.
 *
 * The complete diagnosis stays free, as it has since 1.0.0.
 */
export const PRO_FEATURES: string[] = [
  "Find what's breaking your vault — an automated binary search that isolates the culprit in five rounds instead of twenty minutes of manual toggling, and puts everything back afterwards",
  "Profile every plugin's startup cost in one pass — the complete answer to 'why is my vault slow', with real milliseconds",
  "Save and switch plugin sets — a Writing set, a Minimal set, a known-good set to fall back to",
  "Background monitoring — get told when a plugin starts erroring, turns incompatible, or is pulled from the directory",
  "Full stack traces for every error — see exactly where a plugin broke, and file a bug report worth reading",
  "90 days of vault-health history and CSV export",
];

/** One-line pitch, reused across upsell surfaces. */
export const PRO_TAGLINE = `${PRO_PRICE}, no subscription, no account. Verified offline, on every device you own.`;

/** Contextual upsell copy, keyed by the feature the user reached for. */
export const PRO_UPSELL: Record<string, string> = {
  errors: "Stack traces are a Pro feature — FlowKit already knows which plugin threw, Pro shows you where.",
  bisect:
    "Bisect is a Pro feature. It is the one thing here you genuinely can't do by hand in half a minute — twenty minutes of disabling plugins in halves, done in five questions, with your exact setup restored afterwards.",
  profile:
    "Profiling every plugin's startup cost is a Pro feature. FlowKit times the loads it happens to witness for free; this measures all of them.",
  profiles:
    "Saved plugin sets are a Pro feature — switch twenty plugins on and eighteen off in one action, and back again.",
  export: "CSV export is a Pro feature. Markdown reports are free and unlimited.",
  history: "The full 90-day history is a Pro feature.",
  monitoring: "Background monitoring is a Pro feature.",
};
