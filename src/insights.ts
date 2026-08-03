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
export function buildInsights(results: PluginHealth[]): Insight[] {
  const live = results.filter((r) => !r.muted);
  const insights: Insight[] = [];

  const incompatible = live.filter((r) => r.enabled && isIncompatible(r));
  if (incompatible.length) {
    insights.push({
      id: "incompatible",
      tone: "bad",
      icon: "alert-triangle",
      title: `${incompatible.length} incompatible plugin${incompatible.length > 1 ? "s" : ""} won't load`,
      detail: `${names(incompatible)} require a newer Obsidian or won't run here.`,
      ids: incompatible.map((r) => r.id),
      action: "disable-incompatible",
      actionLabel: "Disable these",
    });
  }

  // Enabled-only, like every other cohort here. Offering to "disable" plugins
  // that are already disabled inflated the count and did nothing.
  const unmaintained = live.filter(
    (r) => r.enabled && r.maintenanceStatus === "unmaintained"
  );
  if (unmaintained.length) {
    insights.push({
      id: "unmaintained",
      tone: "bad",
      icon: "clock-alert",
      title: `${unmaintained.length} plugin${unmaintained.length > 1 ? "s have" : " has"} no recent release`,
      // Deliberately an observation, not a verdict. Release age alone cannot
      // establish abandonment — plenty of good plugins are simply finished.
      detail: `No recorded update in 18+ months: ${names(unmaintained)}. Worth checking whether they still work for you.`,
      ids: unmaintained.map((r) => r.id),
      action: "disable-unmaintained",
      actionLabel: "Review and disable",
    });
  }

  const atRisk = live.filter((r) => r.enabled && isAtRisk(r));
  if (atRisk.length) {
    insights.push({
      id: "at-risk",
      tone: "warn",
      icon: "heart-pulse",
      title: `${atRisk.length} plugin${atRisk.length > 1 ? "s score" : " scores"} below 50`,
      detail: `Low overall health: ${names(atRisk)}.`,
      ids: atRisk.map((r) => r.id),
    });
  }

  const updates = live.filter((r) => r.updateAvailable);
  if (updates.length) {
    insights.push({
      id: "updates",
      tone: "warn",
      icon: "arrow-up-circle",
      title: `${updates.length} update${updates.length > 1 ? "s" : ""} available`,
      detail: `Newer versions published for ${names(updates)}.`,
      ids: updates.map((r) => r.id),
    });
  }

  const sideloaded = live.filter((r) => r.sideloaded === true);
  if (sideloaded.length) {
    insights.push({
      id: "sideloaded",
      tone: "warn",
      icon: "shield-alert",
      title: `${sideloaded.length} sideloaded plugin${sideloaded.length > 1 ? "s" : ""} skipped review`,
      detail: `Not in Obsidian's community list: ${names(sideloaded)}.`,
      ids: sideloaded.map((r) => r.id),
      action: "mute-sideloaded",
      actionLabel: "Mute these",
    });
  }

  const enabledCount = live.filter((r) => r.enabled).length;
  if (enabledCount > 25) {
    insights.push({
      id: "bloat",
      tone: "info",
      icon: "gauge",
      title: `${enabledCount} plugins enabled`,
      detail:
        "A large plugin set slows Obsidian startup. Disabling ones you rarely use speeds launch.",
      ids: [],
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
      ids: [],
    });
  }

  return insights;
}
