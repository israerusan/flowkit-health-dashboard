import { apiVersion } from "obsidian";
import type { PluginManifest } from "obsidian";
import type {
  CachedPlugin,
  MaintenanceStatus,
  MetricScore,
  PluginHealth,
  RemoteCache,
  RemotePluginStat,
} from "./types";

const DAY_MS = 86_400_000;

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

/** A version key that names a stable release — no prerelease tag, no build metadata. */
const STABLE_VERSION_KEY = /^\d+\.\d+(?:\.\d+)?$/;

/** Split `v1.2.3-beta.1` into its numeric parts and its prerelease tag. */
function parseVersion(value: string): { parts: number[]; pre: string } {
  const trimmed = String(value ?? "").trim().replace(/^v/i, "");
  const cut = trimmed.search(/[-+]/);
  const core = cut === -1 ? trimmed : trimmed.slice(0, cut);
  const pre = cut === -1 ? "" : trimmed.slice(cut + 1);
  return { parts: core.split(".").map((x) => parseInt(x, 10) || 0), pre };
}

/**
 * Semver-ish compare. Returns -1, 0, or 1. Missing parts count as 0, a leading
 * `v` is ignored, and a prerelease sorts below its own release (1.0.0-beta <
 * 1.0.0) — which is what stops a `-beta` key in the community stats from being
 * read as a newer version than the stable release the user actually has.
 */
export function compareVersion(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.parts.length, pb.parts.length);
  for (let i = 0; i < len; i++) {
    const x = pa.parts[i] ?? 0;
    const y = pb.parts[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1; // a is the release, b is a prerelease of it
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/**
 * How each metric contributes to Overall. Fixed and explicit, rather than the
 * flat mean of whatever happened to be non-null: that let the same unchanged
 * plugin score 73 online and 93 offline, and printed "Grade A" off a network
 * hiccup. Weights are renormalised over the metrics actually available, and the
 * coverage is reported to the user as a confidence figure.
 */
export const WEIGHTS = {
  compatibility: 0.3,
  maintenance: 0.3,
  footprint: 0.2,
  hygiene: 0.1,
  popularity: 0.1,
} as const;

export type MetricKey = keyof typeof WEIGHTS;

/** Where a plugin stands relative to Obsidian's community directory. */
export type ListingStatus = "listed" | "delisted" | "local" | "unknown";

/** Everything the scorer needs about one plugin. */
export interface ScoreInput {
  manifest: PluginManifest;
  enabled: boolean;
  isMobile: boolean;
  /** owner/repo, when known from the community list. */
  repo?: string;
  /** Community stats for this plugin, when online. */
  remote?: RemotePluginStat;
  /**
   * Bytes on disk for the plugin's own code and styles. The only per-plugin
   * cost signal Obsidian actually exposes to us.
   */
  bundleBytes?: number;
  /**
   * This plugin's download count as a rank within the whole directory (0–1).
   * Absolute download counts are a popularity contest with a brutal
   * distribution; a rank at least means the median sits at 50.
   */
  downloadPercentile?: number;
  /** Where the plugin sits relative to the community directory. */
  listing?: ListingStatus;
  /** User has muted this plugin. */
  muted?: boolean;
}

/**
 * Pick the highest published *stable* version from a community-stats entry. The
 * entry mixes `downloads`/`updated` fields with one numeric key per version, so
 * we keep only strictly version-shaped keys.
 *
 * Prereleases are excluded deliberately: plugins like Calendar, Linter and
 * Periodic Notes publish `-beta` builds into the same object, and counting one
 * as "latest" shows an Update badge for a release the user can't install from
 * the community browser.
 */
export function pickLatestVersion(
  remote: RemotePluginStat | undefined
): string | undefined {
  if (!remote) return undefined;
  let latest: string | undefined;
  for (const key of Object.keys(remote)) {
    if (!STABLE_VERSION_KEY.test(key)) continue; // skip "downloads", "updated", "1.0.0-beta"
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
    // Was a fabricated `70~`. There is no evidence here either way, and an
    // invented number three inches above a legend claiming compatibility is
    // "measured" is exactly the kind of thing that costs trust. The absent
    // field is counted once, in manifest hygiene.
    return UNAVAILABLE("No minimum app version declared — compatibility unverifiable.");
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
 * Popularity — MEASURED when online, as a percentile rank within the directory
 * rather than an absolute log of downloads.
 *
 * The old curve was `log10(downloads)/6`, measured against the live 6,253-entry
 * stats file: 56% of the whole directory scored below 50 (red) and only 4.5%
 * could reach 80 (green). A well-maintained, fully-compatible niche plugin was
 * dragged ~15 points below a sloppier mega-plugin for the crime of being niche.
 * A rank puts the median at 50, and popularity is weighted at only 10% because
 * download count measures marketing reach, not whether a plugin is safe to keep.
 */
function scorePopularity(i: ScoreInput): MetricScore {
  const downloads = i.remote?.downloads;
  if (downloads == null || i.downloadPercentile == null) {
    return UNAVAILABLE("Needs online community stats (enable enrichment).");
  }
  const pct = Math.round(clamp(i.downloadPercentile * 100));
  return {
    value: pct,
    source: "measured",
    detail: `${downloads.toLocaleString()} downloads — more than ${pct}% of the directory.`,
  };
}

/** How many stable versions this plugin has published, per the stats entry. */
export function releaseCount(remote: RemotePluginStat | undefined): number {
  if (!remote) return 0;
  return Object.keys(remote).filter((k) => STABLE_VERSION_KEY.test(k)).length;
}

/**
 * What share of a plugin's downloads sit on its newest release. A high share
 * means its users migrated and stayed — evidence the current build works.
 */
export function migrationRate(remote: RemotePluginStat | undefined): number | null {
  if (!remote) return null;
  const total = remote.downloads;
  const latest = pickLatestVersion(remote);
  if (total == null || total <= 0 || latest == null) return null;
  const onLatest = remote[latest];
  if (onLatest == null) return null;
  return clamp(onLatest / total, 0, 1);
}

/**
 * A plugin whose age reflects maturity rather than neglect: many published
 * releases, and its users successfully migrated to the newest one.
 *
 * Without this, maintenance is a pure function of `updated` and 540 days flips
 * the verdict — which, measured against the live stats file, puts 1,153 of
 * 6,253 plugins (18.4%) in the "abandoned" bucket, Calendar among them
 * (last release 2021, 2.96M downloads). Offering to bulk-disable Calendar is
 * one-star-review advice.
 */
export function isMatureStable(remote: RemotePluginStat | undefined): boolean {
  const rate = migrationRate(remote);
  return releaseCount(remote) >= 8 && rate != null && rate >= 0.5;
}

/**
 * Maintenance — MEASURED when online, from how recently the plugin was updated,
 * with a carve-out for mature plugins that are simply finished.
 */
function scoreMaintenance(i: ScoreInput, now: number): MetricScore {
  const updated = i.remote?.updated;
  if (updated == null) {
    return UNAVAILABLE("Needs online community stats (enable enrichment).");
  }
  const ageDays = Math.max(0, (now - updated) / DAY_MS);
  const months = Math.max(1, Math.round(ageDays / 30));

  let score: number;
  if (ageDays <= 90) score = 100;
  else if (ageDays >= 730) score = 5;
  else score = clamp(100 - ((ageDays - 90) / (730 - 90)) * 95);

  if (ageDays > 540 && isMatureStable(i.remote)) {
    score = Math.max(score, 60);
    return {
      value: Math.round(score),
      source: "measured",
      detail: `No release in about ${months} months, but ${releaseCount(
        i.remote
      )} published versions and most users on the newest — looks finished, not abandoned.`,
    };
  }

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
  now: number,
  remote?: RemotePluginStat
): MaintenanceStatus {
  if (updated == null) return "unknown";
  const ageDays = Math.max(0, (now - updated) / DAY_MS);
  if (ageDays <= 180) return "maintained";
  if (ageDays <= 540) return "aging";
  return isMatureStable(remote) ? "stable" : "unmaintained";
}

/** Human-readable byte size for the footprint tooltip. */
function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Where the footprint curve is anchored: 50 KB scores 100, each 10× costs 40. */
const FOOTPRINT_BASE_BYTES = 50_000;

/**
 * Footprint — MEASURED, from the plugin's own code and stylesheet on disk.
 *
 * This replaces the old "Performance" metric, which read exactly two inputs:
 * `isDesktopOnly` and the vault-wide count of enabled plugins. Because the
 * second is identical for every row, every enabled non-desktop-only plugin in a
 * 30-plugin vault scored exactly 75 — a literal constant down a sortable
 * column, carrying a fifth of Overall. A user could click the header, watch
 * nothing reorder, and have proof in four seconds that 20% of the score was
 * fabricated.
 *
 * Bundle size is not runtime cost, and this does not claim to be: it is what
 * Obsidian actually lets a plugin observe about another plugin, it is local,
 * offline and mobile-safe, and it differs by two to three orders of magnitude
 * across a real vault. The vault-wide startup point still exists — as a
 * vault-level insight, where it belongs.
 */
function scoreFootprint(i: ScoreInput): MetricScore {
  if (!i.enabled) {
    // Deliberately a real value, not `unavailable`. Dropping a metric from the
    // denominator moved Overall in an arbitrary direction, so the same healthy
    // plugin scored 92 enabled and 97 disabled — turning a plugin off and
    // watching its health improve reads as a plain bug.
    return {
      value: 100,
      source: "measured",
      detail: "Disabled — not loaded at startup.",
    };
  }
  if (i.bundleBytes == null || i.bundleBytes <= 0) {
    return UNAVAILABLE("Couldn't read this plugin's files on disk.");
  }
  const score = clamp(
    100 - 40 * Math.log10(i.bundleBytes / FOOTPRINT_BASE_BYTES)
  );
  return {
    value: Math.round(score),
    source: "measured",
    detail: `${formatBytes(i.bundleBytes)} of code and styles loaded at startup.`,
  };
}

/**
 * Manifest hygiene — MEASURED, and manifest-only.
 *
 * Formerly "Quality", which was half manifest metadata and half the average of
 * compatibility, popularity and maintenance. Overall then averaged it alongside
 * those same three, so they were silently double-counted: the five "peer"
 * columns had effective weights of 23.3/23.3/23.3/20/10. A composite must never
 * be displayed as a peer of its own inputs.
 *
 * `authorUrl` and `fundingUrl` are gone too — a donate link is not evidence of
 * software quality. What is left is four things a publisher either did or
 * didn't do, which is all this can honestly claim to measure. It is worth 10%.
 */
function scoreHygiene(i: ScoreInput): MetricScore {
  const m = i.manifest;
  const missing: string[] = [];
  let score = 0;
  if (m.author) score += 25;
  else missing.push("no author");
  if (m.description && m.description.length > 20) score += 25;
  else missing.push("no real description");
  if (m.minAppVersion) score += 25;
  else missing.push("no minimum app version");
  if (i.repo) score += 25;
  else missing.push("no public repository");

  return {
    value: clamp(score),
    source: "measured",
    detail: missing.length
      ? `Manifest completeness — ${missing.join(", ")}.`
      : "Manifest declares everything Obsidian asks for.",
  };
}

/**
 * Where a plugin sits relative to the community directory, read from the
 * persisted projection.
 *
 * `delisted` — present in the stats feed but absent from the current list, i.e.
 * Obsidian pulled it, potentially for a security or policy reason. Cross-
 * referencing the two live files finds 12 such ids today, at zero extra cost.
 * That is the single highest-value thing this product can tell a user, and it
 * used to be flattened into the same yellow "Sideloaded" chip as a personal
 * BRAT install — complete with a one-click button to silence it.
 */
export function classifyListing(
  id: string,
  cache: RemoteCache | null | undefined
): ListingStatus {
  if (!cache || !cache.hadList) return "unknown";
  const entry = cache.plugins[id];
  if (entry?.listed) return "listed";
  if (cache.hadStats && entry) return "delisted";
  return "local";
}

/**
 * Reduce the two multi-megabyte community feeds to the handful of fields we
 * actually score on, so the result is small enough to keep in plugin data and
 * the dashboard can paint before the network answers.
 */
export function buildRemoteCache(
  stats: Record<string, RemotePluginStat> | null,
  list: Record<string, { repo?: string }> | null,
  at: number,
  /** Installed plugin ids. Only these are kept — see below. */
  keep: Set<string>
): RemoteCache {
  const plugins: Record<string, CachedPlugin> = {};
  const all: number[] = [];

  if (stats) {
    for (const [id, entry] of Object.entries(stats)) {
      if (!entry) continue;
      // The distribution is built from the WHOLE directory, because that is
      // what a percentile means — but only installed plugins are stored.
      if (typeof entry.downloads === "number") all.push(entry.downloads);
      if (!keep.has(id)) continue;
      const latest = pickLatestVersion(entry);
      plugins[id] = {
        downloads: entry.downloads,
        updated: entry.updated,
        latest,
        latestDownloads: latest ? entry[latest] : undefined,
        releases: releaseCount(entry),
      };
    }
    all.sort((a, b) => a - b);
  }

  if (list) {
    for (const [id, entry] of Object.entries(list)) {
      if (!keep.has(id)) continue;
      const existing = plugins[id] ?? {};
      existing.repo = entry?.repo;
      existing.listed = true;
      plugins[id] = existing;
    }
  }

  return {
    at,
    plugins,
    distribution: quantiles(all),
    hadStats: stats != null,
    hadList: list != null,
  };
}

/**
 * Reduce a sorted series to 101 evenly-spaced samples.
 *
 * Storing all 6,253 directory download counts made the persisted cache about
 * 1 MB, and `saveSettings` rewrites the whole settings object — on every scan,
 * every mute, and once per keystroke in the license field. A percentile only
 * ever renders as a whole number, so 101 samples carry every bit of precision
 * the UI can show.
 */
function quantiles(sorted: number[], buckets = 100): number[] {
  if (sorted.length <= buckets + 1) return sorted;
  const out: number[] = [];
  for (let i = 0; i <= buckets; i++) {
    out.push(sorted[Math.round((i / buckets) * (sorted.length - 1))]);
  }
  return out;
}

/**
 * Fold a fresh (possibly partial) fetch into what we already had, so one feed
 * failing can't discard the other's data. The two files are separate requests,
 * and a 500 on the list alone would otherwise wipe every repo link, every
 * delisted detection, and 25 hygiene points per plugin — for up to a day.
 */
export function mergeRemoteCache(
  previous: RemoteCache | null,
  fresh: RemoteCache
): RemoteCache {
  if (!previous) return fresh;
  const merged: RemoteCache = {
    at: fresh.at,
    plugins: {},
    distribution: fresh.hadStats ? fresh.distribution : previous.distribution,
    hadStats: fresh.hadStats || previous.hadStats,
    hadList: fresh.hadList || previous.hadList,
  };
  const ids = new Set([
    ...Object.keys(previous.plugins),
    ...Object.keys(fresh.plugins),
  ]);
  for (const id of ids) {
    const before = previous.plugins[id] ?? {};
    const now = fresh.plugins[id] ?? {};
    merged.plugins[id] = {
      // Stats-derived fields: take the fresh ones only if stats actually loaded.
      downloads: fresh.hadStats ? now.downloads : before.downloads,
      updated: fresh.hadStats ? now.updated : before.updated,
      latest: fresh.hadStats ? now.latest : before.latest,
      latestDownloads: fresh.hadStats ? now.latestDownloads : before.latestDownloads,
      releases: fresh.hadStats ? now.releases : before.releases,
      // List-derived fields likewise.
      repo: fresh.hadList ? now.repo : before.repo,
      listed: fresh.hadList ? now.listed : before.listed,
    };
  }
  return merged;
}

/**
 * Rebuild the scorer's view of one plugin from the cached projection. Keeps
 * `computeHealth` unaware of whether its inputs came from the network or disk.
 */
export function remoteFromCache(
  cached: CachedPlugin | undefined
): RemotePluginStat | undefined {
  if (!cached) return undefined;
  const remote: RemotePluginStat = {
    downloads: cached.downloads,
    updated: cached.updated,
  };
  if (cached.latest) {
    remote[cached.latest] = cached.latestDownloads ?? 0;
    // The maturity signal only needs the release count and the newest release's
    // share, so synthesise enough distinct keys to carry the count forward.
    // `cached.latest` is itself one of the counted releases, hence -1: without
    // it every plugin gained a phantom version and the maturity threshold
    // silently became 7 instead of 8.
    const filler = Math.max(0, (cached.releases ?? 0) - 1);
    for (let i = 0; i < filler; i++) {
      const key = `0.0.${i}`;
      if (!(key in remote)) remote[key] = 0;
    }
  }
  return remote;
}

/** Percentile lookup over a pre-sorted distribution from the cache. */
export function rankerFromDistribution(
  distribution: number[] | undefined
): (downloads: number | undefined) => number | undefined {
  if (!distribution || !distribution.length) return () => undefined;
  return (downloads) => {
    if (downloads == null) return undefined;
    let lo = 0;
    let hi = distribution.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (distribution[mid] < downloads) lo = mid + 1;
      else hi = mid;
    }
    return lo / distribution.length;
  };
}

/** Overall can rise no higher than this when a plugin cannot load at all. */
const INCOMPATIBLE_CAP = 20;
/** …or when Obsidian has pulled it from the directory. */
const DELISTED_CAP = 30;

/** Run all five metrics and blend a weighted, confidence-reported overall. */
export function computeHealth(i: ScoreInput, now: number): PluginHealth {
  const listing = i.listing ?? "unknown";
  const compatibility = scoreCompatibility(i);
  const popularity = scorePopularity(i);
  const maintenance = scoreMaintenance(i, now);
  const footprint = scoreFootprint(i);
  const hygiene = scoreHygiene(i);

  const metrics = { compatibility, maintenance, footprint, hygiene, popularity };

  // Weighted mean, renormalised over whatever is actually available. The
  // available weight doubles as the confidence figure shown to the user.
  let weighted = 0;
  let coverage = 0;
  for (const key of Object.keys(WEIGHTS) as MetricKey[]) {
    const value = metrics[key].value;
    if (value == null) continue;
    weighted += value * WEIGHTS[key];
    coverage += WEIGHTS[key];
  }

  let overall: number | null = coverage > 0 ? Math.round(weighted / coverage) : null;

  // A *missing* signal must never flatter a plugin. Offline, an abandoned
  // plugin used to score higher than it did online — the metric that would have
  // condemned it simply left the denominator. Cap at the score it would earn
  // with a neutral maintenance reading.
  if (overall != null && maintenance.value == null) {
    const neutral = Math.round(
      (weighted + 50 * WEIGHTS.maintenance) / (coverage + WEIGHTS.maintenance)
    );
    overall = Math.min(overall, neutral);
  }

  // Hard gates. Averages let a plugin that literally cannot load still score 72
  // and wear a warn-yellow chip; these are risk facts, not quantities to blend.
  if (overall != null && compatibility.value === 0) {
    overall = Math.min(overall, INCOMPATIBLE_CAP);
  }
  if (overall != null && listing === "delisted") {
    overall = Math.min(overall, DELISTED_CAP);
  }

  const latestVersion = pickLatestVersion(i.remote);
  const updateAvailable =
    latestVersion != null &&
    compareVersion(i.manifest.version, latestVersion) < 0;

  return {
    id: i.manifest.id,
    name: i.manifest.name,
    author: i.manifest.author ?? "Unknown",
    version: i.manifest.version,
    enabled: i.enabled,
    repo: i.repo,
    maintenanceStatus: deriveMaintenanceStatus(i.remote?.updated, now, i.remote),
    updateAvailable,
    latestVersion,
    listing,
    muted: i.muted ?? false,
    overall,
    confidence: coverage,
    metrics,
  };
}
