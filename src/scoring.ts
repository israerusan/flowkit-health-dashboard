import { apiVersion } from "obsidian";
import type { PluginManifest } from "obsidian";
import type {
  MaintenanceStatus,
  MetricScore,
  PluginHealth,
  RemotePluginStat,
} from "./types";

const DAY_MS = 86_400_000;

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Semver-ish compare. Returns -1, 0, or 1. Missing parts count as 0. */
export function compareVersion(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Everything the scorer needs about one plugin. */
export interface ScoreInput {
  manifest: PluginManifest;
  enabled: boolean;
  isMobile: boolean;
  /** Number of enabled plugins in the vault — a coarse startup-cost proxy. */
  enabledCount: number;
  /** owner/repo, when known — used as a quality signal. */
  repo?: string;
  /** Community stats for this plugin, when online. */
  remote?: RemotePluginStat;
  /**
   * Whether the plugin appears in Obsidian's community list. `null` when that
   * list is unavailable (offline / enrichment off).
   */
  inCommunityList?: boolean | null;
  /** User has muted this plugin. */
  muted?: boolean;
}

/**
 * Pick the highest published version from a community-stats entry. The entry
 * mixes `downloads`/`updated` fields with one numeric key per version, so we
 * keep only version-shaped keys (those starting with a digit).
 */
export function pickLatestVersion(
  remote: RemotePluginStat | undefined
): string | undefined {
  if (!remote) return undefined;
  let latest: string | undefined;
  for (const key of Object.keys(remote)) {
    if (!/^\d/.test(key)) continue; // skip "downloads", "updated"
    if (latest == null || compareVersion(key, latest) > 0) latest = key;
  }
  return latest;
}

const UNAVAILABLE = (detail: string): MetricScore => ({
  value: null,
  source: "unavailable",
  detail,
});

/**
 * Compatibility — MEASURED and fully local. Compares the plugin's declared
 * `minAppVersion` against the running Obsidian API version, and flags
 * desktop-only plugins running on mobile.
 */
function scoreCompatibility(i: ScoreInput): MetricScore {
  const m = i.manifest;
  if (m.isDesktopOnly && i.isMobile) {
    return {
      value: 0,
      source: "measured",
      detail: "Desktop-only plugin on a mobile device — will not load.",
    };
  }
  if (!m.minAppVersion) {
    return {
      value: 70,
      source: "estimated",
      detail: "No minimum app version declared; compatibility unverifiable.",
    };
  }
  if (compareVersion(m.minAppVersion, apiVersion) > 0) {
    return {
      value: 0,
      source: "measured",
      detail: `Requires Obsidian ${m.minAppVersion}, but you run ${apiVersion}.`,
    };
  }
  return {
    value: 100,
    source: "measured",
    detail: `Compatible — needs ${m.minAppVersion}, you run ${apiVersion}.`,
  };
}

/**
 * Popularity — MEASURED when online, from community download counts on a log
 * scale (1M+ downloads ≈ 100). Unavailable offline.
 */
function scorePopularity(i: ScoreInput): MetricScore {
  const downloads = i.remote?.downloads;
  if (downloads == null) {
    return UNAVAILABLE("Needs online community stats (enable enrichment).");
  }
  const score = clamp((Math.log10(Math.max(1, downloads)) / 6) * 100);
  return {
    value: Math.round(score),
    source: "measured",
    detail: `${downloads.toLocaleString()} community downloads.`,
  };
}

/**
 * Maintenance — MEASURED when online, from how recently the plugin was updated.
 * Fresh (≤90 days) ≈ 100, decaying to ~5 by 2 years. Unavailable offline.
 */
function scoreMaintenance(i: ScoreInput, now: number): MetricScore {
  const updated = i.remote?.updated;
  if (updated == null) {
    return UNAVAILABLE("Needs online community stats (enable enrichment).");
  }
  const ageDays = Math.max(0, (now - updated) / DAY_MS);
  let score: number;
  if (ageDays <= 90) score = 100;
  else if (ageDays >= 730) score = 5;
  else score = clamp(100 - ((ageDays - 90) / (730 - 90)) * 95);
  const months = Math.max(1, Math.round(ageDays / 30));
  return {
    value: Math.round(score),
    source: "measured",
    detail: `Last updated about ${months} month(s) ago.`,
  };
}

/**
 * Plain maintained / not verdict from the last-update timestamp. Shares its
 * thresholds with the maintenance score above, but collapses to a category
 * that's easy to scan.
 */
export function deriveMaintenanceStatus(
  updated: number | undefined,
  now: number
): MaintenanceStatus {
  if (updated == null) return "unknown";
  const ageDays = Math.max(0, (now - updated) / DAY_MS);
  if (ageDays <= 180) return "maintained";
  if (ageDays <= 540) return "aging";
  return "unmaintained";
}

/**
 * Performance — ESTIMATED. Obsidian exposes no per-plugin CPU/memory/startup
 * API to other plugins, so this is an honest heuristic, not a measurement.
 */
function scorePerformance(i: ScoreInput): MetricScore {
  if (!i.enabled) {
    return UNAVAILABLE("Disabled — no runtime cost.");
  }
  let score = 90;
  const notes: string[] = [];
  if (i.manifest.isDesktopOnly) {
    score -= 10;
    notes.push("uses desktop/native APIs");
  }
  if (i.enabledCount > 25) {
    score -= 15;
    notes.push(`${i.enabledCount} plugins enabled inflate startup`);
  } else if (i.enabledCount > 15) {
    score -= 5;
  }
  return {
    value: clamp(score),
    source: "estimated",
    detail: notes.length
      ? `Estimate — ${notes.join("; ")}.`
      : "Estimate — no direct profiling API is available.",
  };
}

/**
 * Quality — a composite (ESTIMATED). Blends manifest-metadata completeness with
 * whatever measured signals are available (compatibility, maintenance,
 * popularity). A well-documented, currently-maintained, widely-used, compatible
 * plugin scores high.
 */
function scoreQuality(i: ScoreInput, others: MetricScore[]): MetricScore {
  const m = i.manifest;
  let meta = 0;
  if (m.author) meta += 20;
  if (m.authorUrl) meta += 15;
  if (m.description && m.description.length > 20) meta += 20;
  // fundingUrl isn't in the public PluginManifest type but ships in real ones.
  if ((m as unknown as { fundingUrl?: unknown }).fundingUrl) meta += 10;
  if (m.minAppVersion) meta += 15;
  if (i.repo) meta += 20;
  meta = clamp(meta);

  const measured = others
    .map((s) => s.value)
    .filter((v): v is number => v != null);
  const measuredAvg = measured.length
    ? measured.reduce((a, b) => a + b, 0) / measured.length
    : null;

  const value =
    measuredAvg == null ? meta : Math.round(meta * 0.5 + measuredAvg * 0.5);
  return {
    value,
    source: "estimated",
    detail:
      measuredAvg == null
        ? "Composite of manifest completeness (offline)."
        : "Composite of manifest completeness and measured signals.",
  };
}

/** Run all five metrics and blend an overall score. */
export function computeHealth(i: ScoreInput, now: number): PluginHealth {
  const compatibility = scoreCompatibility(i);
  const popularity = scorePopularity(i);
  const maintenance = scoreMaintenance(i, now);
  const performance = scorePerformance(i);
  const quality = scoreQuality(i, [compatibility, popularity, maintenance]);

  const values = [quality, maintenance, performance, popularity, compatibility]
    .map((s) => s.value)
    .filter((v): v is number => v != null);
  const overall = values.length
    ? Math.round(values.reduce((a, b) => a + b, 0) / values.length)
    : null;

  const latestVersion = pickLatestVersion(i.remote);
  const updateAvailable =
    latestVersion != null &&
    compareVersion(i.manifest.version, latestVersion) < 0;
  const sideloaded =
    i.inCommunityList == null ? null : i.inCommunityList === false;

  return {
    id: i.manifest.id,
    name: i.manifest.name,
    author: i.manifest.author ?? "Unknown",
    version: i.manifest.version,
    enabled: i.enabled,
    repo: i.repo,
    maintenanceStatus: deriveMaintenanceStatus(i.remote?.updated, now),
    updateAvailable,
    latestVersion,
    sideloaded,
    muted: i.muted ?? false,
    overall,
    metrics: { quality, maintenance, performance, popularity, compatibility },
  };
}
