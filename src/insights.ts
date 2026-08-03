// Turns a scored plugin set into a short, ranked list of actionable insights.
// Kept free of any Obsidian imports so the Node test suite can exercise it.
import type { PluginHealth } from "./types";

export type InsightTone = "bad" | "warn" | "good" | "info";

/** A bulk operation the dashboard can offer to apply to an insight's plugins. */
export type BulkAction =
  | "disable-unmaintained"
  | "disable-incompatible"
  | "mute-sideloaded";

export interface Insight {
  id: string;
  tone: InsightTone;
  /** lucide icon name */
  icon: string;
  title: string;
  detail: string;
  /** Plugin ids this insight refers to. */
  ids: string[];
  /**
   * The predicate this cohort was built from, so the table can be scoped to
   * exactly what the card counted. Previously the card mapped to a nearby
   * `FilterKey` instead, and "3 plugins score below 50" opened a table of
   * fifteen rows because the `attention` filter also matches anything with an
   * update available — the card broke its own promise on the first click.
   */
  match: (r: PluginHealth) => boolean;
  /** A one-click remedy, when one exists (Pro-gated in the UI). */
  action?: BulkAction;
  actionLabel?: string;
}

const names = (rows: PluginHealth[], max = 3): string => {
  const shown = rows.slice(0, max).map((r) => r.name);
  const extra = rows.length - shown.length;
  return extra > 0 ? `${shown.join(", ")} +${extra} more` : shown.join(", ");
};

// --- shared predicates ------------------------------------------------------
// The dashboard's filter dropdown and this insight builder must agree about what
// "incompatible" or "at risk" means. They used to carry separate copies, which
// let a row appear under a filter but not in the matching insight (and vice
// versa). One definition each, exported, used by both.

/** Declares a minimum Obsidian version we don't meet, or is desktop-only on mobile. */
export function isIncompatible(r: PluginHealth): boolean {
  return r.metrics.compatibility.value === 0;
}

/** Scores below the "needs a look" line. */
export function isAtRisk(r: PluginHealth): boolean {
  return r.overall != null && r.overall < 50;
}

/** Worth the user's attention — excluding anything they've explicitly muted. */
export function needsAttention(r: PluginHealth): boolean {
  if (r.muted) return false;
  return (
    isAtRisk(r) ||
    r.maintenanceStatus === "unmaintained" ||
    isIncompatible(r) ||
    r.updateAvailable
  );
}

/**
 * Build the ranked insight list. Muted plugins are ignored throughout so a user
 * who has acknowledged a plugin doesn't keep getting nagged about it. Returned
 * most-severe first.
 */
/** The cohort predicates, defined once and used for both the count and the click. */
const IS_DELISTED = (r: PluginHealth): boolean => !r.muted && r.listing === "delisted";
const IS_ERRORING = (r: PluginHealth): boolean =>
  !r.muted && r.enabled && (r.errors?.uncaught ?? 0) > 0;
const IS_INCOMPATIBLE = (r: PluginHealth): boolean =>
  !r.muted && r.enabled && isIncompatible(r);
const IS_UNMAINTAINED = (r: PluginHealth): boolean =>
  !r.muted && r.enabled && r.maintenanceStatus === "unmaintained";
const HAS_UPDATE = (r: PluginHealth): boolean => !r.muted && r.updateAvailable;
const IS_LOCAL = (r: PluginHealth): boolean => !r.muted && r.listing === "local";

export function buildInsights(results: PluginHealth[]): Insight[] {
  const live = results.filter((r) => !r.muted);
  const insights: Insight[] = [];

  // Plugins already named by a more specific finding above. The "scores below
  // 50" card used to re-list every plugin the cards above it had just covered,
  // so a single broken plugin generated four findings and the list read as
  // padding.
  const claimed = new Set<string>();
  const claim = (rows: PluginHealth[]): void => {
    for (const r of rows) claimed.add(r.id);
  };

  // Ranked first, above even "won't load": a plugin Obsidian has pulled from
  // the directory may have been pulled for a security or policy reason, and the
  // user has it installed right now. Deliberately carries no mute action.
  const delisted = live.filter(IS_DELISTED);
  if (delisted.length) {
    claim(delisted);
    insights.push({
      id: "delisted",
      tone: "bad",
      icon: "shield-x",
      title: `${delisted.length} plugin${delisted.length > 1 ? "s are" : " is"} no longer in the community directory`,
      detail: `${names(delisted)} ${delisted.length > 1 ? "were" : "was"} listed once but ${delisted.length > 1 ? "have" : "has"} since been removed. Worth checking why before keeping ${delisted.length > 1 ? "them" : "it"}.`,
      ids: delisted.map((r) => r.id),
      match: IS_DELISTED,
    });
  }

  // Ranked high because it is the only finding here derived from watching the
  // plugin actually run, and the only one the user has probably already felt.
  const erroring = live
    .filter(IS_ERRORING)
    .sort((a, b) => (b.errors?.uncaught ?? 0) - (a.errors?.uncaught ?? 0));
  if (erroring.length) {
    claim(erroring);
    const total = erroring.reduce((n, r) => n + (r.errors?.uncaught ?? 0), 0);
    insights.push({
      id: "erroring",
      tone: "bad",
      icon: "bug",
      title: `${erroring.length} plugin${erroring.length > 1 ? "s are" : " is"} throwing errors`,
      detail: `${total} unhandled error${total === 1 ? "" : "s"} traced back to ${names(erroring)}. This is happening in your vault right now.`,
      ids: erroring.map((r) => r.id),
      match: IS_ERRORING,
    });
  }

  const incompatible = live.filter(IS_INCOMPATIBLE);
  if (incompatible.length) {
    claim(incompatible);
    insights.push({
      id: "incompatible",
      tone: "bad",
      icon: "alert-triangle",
      title: `${incompatible.length} incompatible plugin${incompatible.length > 1 ? "s" : ""} won't load`,
      detail: `${names(incompatible)} require a newer Obsidian or won't run here.`,
      ids: incompatible.map((r) => r.id),
      match: IS_INCOMPATIBLE,
      action: "disable-incompatible",
      actionLabel: "Disable these",
    });
  }

  // Enabled-only, like every other cohort here. Offering to "disable" plugins
  // that are already disabled inflated the count and did nothing.
  const unmaintained = live.filter(IS_UNMAINTAINED);
  if (unmaintained.length) {
    claim(unmaintained);
    insights.push({
      id: "unmaintained",
      tone: "bad",
      icon: "clock-alert",
      title: `${unmaintained.length} plugin${unmaintained.length > 1 ? "s have" : " has"} no recent release`,
      // Deliberately an observation, not a verdict. Release age alone cannot
      // establish abandonment — plenty of good plugins are simply finished.
      detail: `No recorded update in 18+ months: ${names(unmaintained)}. Worth checking whether they still work for you.`,
      ids: unmaintained.map((r) => r.id),
      match: IS_UNMAINTAINED,
      action: "disable-unmaintained",
      actionLabel: "Review and disable",
    });
  }

  // Only plugins no card above has already explained.
  const atRisk = live.filter((r) => r.enabled && isAtRisk(r) && !claimed.has(r.id));
  if (atRisk.length) {
    const atRiskIds = new Set(atRisk.map((r) => r.id));
    insights.push({
      id: "at-risk",
      tone: "warn",
      icon: "heart-pulse",
      title: `${atRisk.length} other plugin${atRisk.length > 1 ? "s score" : " scores"} below 50`,
      detail: `Low overall health, for reasons not already listed above: ${names(atRisk)}.`,
      ids: atRisk.map((r) => r.id),
      match: (r) => atRiskIds.has(r.id),
    });
  }

  // Updates and local installs are orthogonal — a plugin can need an update AND
  // be erroring — so they are deliberately not deduplicated against `claimed`.
  const updates = live.filter(HAS_UPDATE);
  if (updates.length) {
    insights.push({
      id: "updates",
      tone: "warn",
      icon: "arrow-up-circle",
      title: `${updates.length} update${updates.length > 1 ? "s" : ""} available`,
      detail: `Newer versions published for ${names(updates)}.`,
      ids: updates.map((r) => r.id),
      match: HAS_UPDATE,
    });
  }

  const local = live.filter(IS_LOCAL);
  if (local.length) {
    insights.push({
      id: "sideloaded",
      tone: "warn",
      icon: "shield-alert",
      title: `${local.length} plugin${local.length > 1 ? "s were" : " was"} installed outside the directory`,
      detail: `Not in Obsidian's community list, so ${local.length > 1 ? "they" : "it"} skipped community review: ${names(local)}.`,
      ids: local.map((r) => r.id),
      match: IS_LOCAL,
      action: "mute-sideloaded",
      actionLabel: "Mute these",
    });
  }

  // Ranked last and given real ids, so it is clickable like everything else.
  // It used to ship `ids: []`, which made it the one card in the list that did
  // nothing when clicked and could never be resolved — for a 40-plugin vault it
  // was permanent furniture, which teaches people to stop reading the list.
  const enabled = live.filter((r) => r.enabled);
  if (enabled.length > 25) {
    const heaviest = [...enabled]
      .sort((a, b) => (a.metrics.footprint.value ?? 101) - (b.metrics.footprint.value ?? 101))
      .slice(0, 10);
    const heaviestIds = new Set(heaviest.map((r) => r.id));
    insights.push({
      id: "bloat",
      tone: "info",
      icon: "gauge",
      title: `${enabled.length} plugins enabled`,
      detail: `A large plugin set slows startup. The heaviest are ${names(heaviest)} — disabling ones you rarely use speeds launch.`,
      ids: heaviest.map((r) => r.id),
      match: (r) => heaviestIds.has(r.id),
    });
  }

  if (!insights.length) {
    insights.push({
      id: "healthy",
      tone: "good",
      icon: "check-circle",
      title: "Everything looks healthy",
      detail:
        "No incompatible, abandoned, or low-scoring plugins found. Nice and tidy.",
      // Names no plugins, so it scopes to none. (It is never clickable either —
      // the card only becomes a control when `ids` is non-empty.)
      ids: [],
      match: () => false,
    });
  }

  return insights;
}
