/** Shared constants and wording for the dashboard: no state, no DOM beyond the SVG helper. */
import type { HealthChange, MaintenanceStatus, PluginHealth } from "../types";
import type { LifecycleFailure } from "../main";

export type Tone = "good" | "warn" | "bad" | "unknown";
export type MetricKey = keyof PluginHealth["metrics"];
export type SortKey = "name" | "overall" | MetricKey;
export type FilterKey =
  | "all"
  | "attention"
  | "unmaintained"
  | "incompatible"
  | "erroring"
  | "delisted"
  | "sideloaded"
  | "update"
  | "heavy"
  | "watched"
  | "disabled"
  | "muted";

export const METRIC_COLUMNS: Array<{ key: MetricKey; label: string; hint: string }> = [
  {
    key: "compatibility",
    label: "Compatibility",
    hint: "Whether it can run on your Obsidian, on this device. Weighted 25%.",
  },
  {
    key: "reliability",
    label: "Reliability",
    hint: "Errors this plugin actually threw on this machine. Weighted 25%.",
  },
  {
    key: "maintenance",
    label: "Maintenance",
    hint: "How recently it was released, allowing for plugins that are simply finished. Weighted 25%.",
  },
  {
    key: "footprint",
    label: "Footprint",
    hint: "What it costs to run: code loaded at startup, measured load time, and any fast repeating timer. Weighted 15%.",
  },
  {
    key: "hygiene",
    label: "Hygiene",
    hint: "What the plugin's manifest declares. Weighted 5%.",
  },
  {
    key: "popularity",
    label: "Popularity",
    hint: "Download rank within the directory — context, not health. Weighted 5%.",
  },
];

export const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "All plugins" },
  { key: "attention", label: "Needs attention" },
  { key: "unmaintained", label: "No recent release" },
  { key: "incompatible", label: "Incompatible" },
  { key: "erroring", label: "Throwing errors" },
  { key: "delisted", label: "Delisted" },
  { key: "sideloaded", label: "Local installs" },
  { key: "update", label: "Update available" },
  { key: "heavy", label: "Heaviest to run" },
  { key: "watched", label: "Watching" },
  { key: "disabled", label: "Disabled" },
  { key: "muted", label: "Muted" },
];

export const MAINTENANCE_META: Record<
  MaintenanceStatus,
  { label: string; tone: Tone; hint: string }
> = {
  maintained: {
    label: "Maintained",
    tone: "good",
    hint: "Released within the last 6 months.",
  },
  active: {
    label: "Active",
    tone: "good",
    hint: "No recent release, but its repository was pushed to in the last 6 months — being worked on, just not tagged.",
  },
  aging: { label: "Aging", tone: "warn", hint: "No release in 6–18 months." },
  stable: {
    label: "Stable",
    tone: "good",
    hint: "No recent release, but many published versions and most users on the newest — finished, not abandoned.",
  },
  unmaintained: {
    label: "No recent release",
    tone: "warn",
    hint: "No recorded release in over 18 months, and no sign it has settled into maturity.",
  },
  unknown: {
    label: "Unknown",
    tone: "unknown",
    hint: "No release data (offline, or not a community plugin).",
  },
};

/** Map a 0–100 score to a qualitative band used for colour coding. */
export function band(value: number | null): Tone {
  if (value == null) return "unknown";
  if (value >= 80) return "good";
  if (value >= 50) return "warn";
  return "bad";
}

/** A letter grade + verdict for the vault-wide average. */
export function gradeFor(avg: number | null): { letter: string; tone: Tone; verdict: string } {
  if (avg == null) {
    return {
      letter: "—",
      tone: "unknown",
      verdict:
        "Not enough data to grade yet — enable online enrichment for full metrics.",
    };
  }
  if (avg >= 90)
    return { letter: "A", tone: "good", verdict: "Your vault is in excellent shape." };
  if (avg >= 80)
    return {
      letter: "B",
      tone: "good",
      verdict: "Healthy overall, with a couple of things to watch.",
    };
  if (avg >= 70)
    return { letter: "C", tone: "warn", verdict: "Solid, but a few plugins need attention." };
  if (avg >= 60)
    return {
      letter: "D",
      tone: "bad",
      verdict: "Several plugins are dragging your vault down.",
    };
  return { letter: "F", tone: "bad", verdict: "Your plugin set needs some cleanup." };
}

export function svgEl<K extends keyof SVGElementTagNameMap>(
  parent: Element,
  tag: K,
  attrs: Record<string, string | number>
): SVGElementTagNameMap[K] {
  // Created by the parent, so a dashboard in a popout window builds its chart
  // in that window's document rather than the main one.
  return parent.createSvg(tag, { attr: attrs });
}

export interface SummaryStats {
  count: number;
  avg: number | null;
  atRisk: number;
  unmaintained: number;
  updates: number;
  /** Mean share of metric weight available across the scored plugins (0–1). */
  confidence: number;
}

/**
 * Below this, the letter grade is withheld. A grade is a confident-sounding
 * artifact; printing "A" off two of five signals is how the dashboard used to
 * announce "your vault is in excellent shape" because the network was down.
 */
export const GRADE_MIN_CONFIDENCE = 0.6;

/**
 * How long typing is allowed to run ahead of the table.
 *
 * Short enough that the list still feels live, long enough that a burst of
 * keystrokes is one rebuild rather than six.
 */
export const SEARCH_DEBOUNCE_MS = 90;

/**
 * Leading characters that make a spreadsheet read a CSV cell as a formula.
 *
 * Every value in the exported CSV is a plugin manifest field, which is
 * attacker-controlled for anyone who sideloads — and `showDisabled` defaults
 * on, so a plugin that has never been enabled, and whose code has therefore
 * never run in the renderer, still reaches that file.
 */
export const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** What is shown where a grade would be when there isn't the signal for one. */
export const GRADE_WITHHELD: { letter: string; tone: Tone; verdict: string } = {
  letter: "—",
  tone: "unknown",
  verdict: "Not enough signal to grade this vault yet.",
};


/** Name the plugins that would not move, rather than pointing at the console. */
export function describeFailed(failed: LifecycleFailure[]): string {
  const names = failed.map((f) => f.id).join(", ");
  return `${names} wouldn't switch — change ${
    failed.length === 1 ? "it" : "them"
  } from Settings → Community plugins.`;
}

export function rowsLabel(n: number): string {
  return `${n} plugin${n === 1 ? "" : "s"}`;
}

/** How long error-watching has been running, in words. */
export function describeWatched(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  if (days < 1) {
    const hours = Math.max(1, Math.floor(ms / 3_600_000));
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** Plain-English wording for one recorded transition. */
export function describeChange(kind: HealthChange["kind"]): string {
  switch (kind) {
    case "error-started":
      return "started throwing errors";
    case "delisted":
      return "was removed from the community directory";
    case "became-incompatible":
      return "stopped being compatible with your Obsidian";
    case "became-unmaintained":
      return "went stale";
    case "update-published":
      return "published an update";
    default:
      return "is back to normal";
  }
}

/** A short, relative-ish description of a past timestamp for the trend delta. */
export function describeWhen(at: number): string {
  const hours = (Date.now() - at) / 3_600_000;
  if (hours < 1) return "just now";
  if (hours < 24) return `${Math.round(hours)} hours ago`;
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days <= 0) return "earlier today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(at).toLocaleDateString();
}
