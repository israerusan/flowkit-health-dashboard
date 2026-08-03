import { apiVersion } from "obsidian";
import type { PluginManifest } from "obsidian";
import {
  errorRatePerDay,
  MIN_OBSERVATION_MS,
  reliabilityScore,
} from "./errors";
import { readFootprint, type RuntimeProfile } from "./runtime";
import type { MuteRecord } from "./mutes";
import type { RepoActivity } from "./repoActivity";
import type {
  CachedPlugin,
  MaintenanceStatus,
  MetricScore,
  PluginErrorRecord,
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
  compatibility: 0.25,
  /**
   * Errors this plugin actually threw on this machine. Weighted alongside
   * compatibility and maintenance because it is the only signal here that
   * observes the plugin *running* rather than describing it.
   */
  reliability: 0.25,
  maintenance: 0.25,
  footprint: 0.15,
  hygiene: 0.05,
  popularity: 0.05,
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
  /** Runtime errors attributed to this plugin, when any have been seen. */
  errors?: PluginErrorRecord;
  /** How long FlowKit has been watching for errors, in ms. */
  observedMs?: number;
  /** User has muted this plugin. */
  muted?: boolean;
  /** The live mute record, when muted. */
  mute?: MuteRecord;
  /** User is watching this plugin specifically. */
  watched?: boolean;
  /**
   * What the plugin costs while running — load time and repeating timers.
   * Bundle size alone said a 60 KB plugin polling four times a second was
   * cheaper than a 400 KB one that loads and sits idle.
   */
  runtime?: RuntimeProfile;
  /**
   * What the plugin's repository says about itself. This is what separates
   * "finished" from "abandoned" — release dates alone cannot.
   */
  repoActivity?: RepoActivity;
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
 * Why a community-derived metric is missing.
 *
 * "Enable enrichment" is only useful advice when enabling it would actually
 * help. A plugin installed outside the directory has no download counts and no
 * release history to fetch, so telling its owner to switch something on sends
 * them to a setting that cannot change the answer.
 */
function missingStatsReason(i: ScoreInput): string {
  if (i.listing === "local") {
    return "Installed outside the community directory, so there are no download or release figures to read.";
  }
  if (i.listing === "delisted") {
    return "No longer in the community directory, so its figures are no longer published.";
  }
  return "Needs online community stats (enable enrichment).";
}

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
 * A rank puts the median at 50, and popularity carries the smallest weight of
 * any metric here (5%, see `WEIGHTS`) because download count measures marketing
 * reach, not whether a plugin is safe to keep.
 */
function scorePopularity(i: ScoreInput): MetricScore {
  const downloads = i.remote?.downloads;
  if (downloads == null || i.downloadPercentile == null) {
    return UNAVAILABLE(missingStatsReason(i));
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

/** A repository is "active" if code moved within this window. */
const REPO_ACTIVE_DAYS = 180;
/** …and dormant once nothing has moved for this long. */
const REPO_DORMANT_DAYS = 730;

/**
 * What the repository says, reduced to a verdict.
 *
 * `null` means it said nothing decisive — a push nine months ago is neither
 * evidence of life nor of death, and must leave the release-based reading
 * exactly as it was.
 */
export type RepoVerdict = "archived" | "gone" | "active" | "dormant" | null;

export function repoVerdict(
  activity: RepoActivity | undefined,
  now: number
): RepoVerdict {
  if (!activity) return null;
  if (activity.archived) return "archived";
  if (activity.failed === "missing") return "gone";
  if (activity.pushedAt == null) return null;
  const days = Math.max(0, (now - activity.pushedAt) / DAY_MS);
  if (days <= REPO_ACTIVE_DAYS) return "active";
  if (days >= REPO_DORMANT_DAYS) return "dormant";
  return null;
}

/** How long ago the repository last moved, in words. */
function pushedAgo(activity: RepoActivity | undefined, now: number): string {
  if (!activity?.pushedAt) return "a while ago";
  const days = Math.max(0, Math.round((now - activity.pushedAt) / DAY_MS));
  if (days <= 1) return "today";
  if (days < 60) return `${days} days ago`;
  const months = Math.round(days / 30);
  if (months < 24) return `${months} months ago`;
  return `about ${Math.round(months / 12)} years ago`;
}

/**
 * Maintenance — MEASURED when online, from how recently the plugin was
 * released, corrected by what its repository says.
 *
 * Release age on its own cannot tell "finished" from "abandoned", and the
 * maturity carve-out that stands in for the difference (many releases, users on
 * the newest) is a fair guess and no more than a guess. When the repository has
 * been asked, it overrules: an archived repo is a decision the author published,
 * and a repo pushed to last week is a plugin still being worked on whatever its
 * tag history says.
 */
function scoreMaintenance(i: ScoreInput, now: number): MetricScore {
  const verdict = repoVerdict(i.repoActivity, now);
  const updated = i.remote?.updated;

  if (updated == null) {
    // No release data — but a repository lookup can still be decisive, and an
    // archived repository is worth saying even offline.
    if (verdict === "archived") {
      return {
        value: 5,
        source: "measured",
        detail: "The author has archived its repository — it is no longer being worked on.",
      };
    }
    if (verdict === "gone") {
      return {
        value: 10,
        source: "measured",
        detail: "Its repository no longer exists on GitHub.",
      };
    }
    return UNAVAILABLE(missingStatsReason(i));
  }

  const ageDays = Math.max(0, (now - updated) / DAY_MS);
  const months = Math.max(1, Math.round(ageDays / 30));

  let score: number;
  if (ageDays <= 90) score = 100;
  else if (ageDays >= 730) score = 5;
  else score = clamp(100 - ((ageDays - 90) / (730 - 90)) * 95);

  if (verdict === "archived") {
    return {
      value: Math.min(Math.round(score), 10),
      source: "measured",
      detail: `The author has archived its repository — no more fixes are coming. Last release about ${months} months ago.`,
    };
  }
  if (verdict === "gone") {
    return {
      value: Math.min(Math.round(score), 20),
      source: "measured",
      detail: `Its repository no longer exists on GitHub. Last release about ${months} months ago.`,
    };
  }
  if (verdict === "active" && ageDays > 180) {
    // Code is moving; the tag history just doesn't show it. This is the case
    // the release-only reading got most wrong, and the one users disputed.
    return {
      value: Math.max(Math.round(score), 65),
      source: "measured",
      detail: `No release in about ${months} months, but its repository was updated ${pushedAgo(
        i.repoActivity,
        now
      )} — still being worked on.`,
    };
  }
  if (verdict === "dormant" && ageDays > 540) {
    // Overrules the maturity carve-out: many published versions means nothing
    // if nobody has touched the code in two years.
    return {
      value: Math.min(Math.round(score), 25),
      source: "measured",
      detail: `No release in about ${months} months, and nothing pushed to its repository since ${pushedAgo(
        i.repoActivity,
        now
      )}.`,
    };
  }

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
 * Plain maintained / not verdict. Shares its thresholds with the maintenance
 * score above, but collapses to a category that's easy to scan — and defers to
 * the repository whenever it was asked.
 */
export function deriveMaintenanceStatus(
  updated: number | undefined,
  now: number,
  remote?: RemotePluginStat,
  repoActivity?: RepoActivity
): MaintenanceStatus {
  const verdict = repoVerdict(repoActivity, now);
  if (verdict === "archived" || verdict === "gone") return "unmaintained";
  if (updated == null) return verdict === "active" ? "active" : "unknown";
  const ageDays = Math.max(0, (now - updated) / DAY_MS);
  if (ageDays <= 180) return "maintained";
  // A repository pushed to this year outranks any release-age bucket below.
  if (verdict === "active") return "active";
  if (ageDays <= 540) return "aging";
  if (verdict === "dormant") return "unmaintained";
  return isMatureStable(remote) ? "stable" : "unmaintained";
}

/**
 * Reliability — MEASURED, and the only metric that watches the plugin run.
 *
 * Reports itself unavailable until FlowKit has been watching long enough for
 * silence to mean something: a plugin that hasn't thrown in ninety seconds is
 * not thereby reliable, and a fabricated 100 would be exactly the kind of
 * confident-looking nonsense the rest of this rework removed.
 */
function scoreReliability(i: ScoreInput): MetricScore {
  const observed = i.observedMs ?? 0;
  const record = i.errors;

  // The observation window exists so that SILENCE means something: a plugin
  // that hasn't thrown in ninety seconds is not thereby reliable. It was
  // applied to failures too, which is the opposite mistake — errors already
  // observed are positive evidence, available immediately and not improved by
  // waiting. A row reading "13 errors" beside a blank Reliability and an
  // overall of 72 is the product contradicting itself in three inches.
  if (observed < MIN_OBSERVATION_MS && (record?.uncaught ?? 0) === 0) {
    return UNAVAILABLE(
      "FlowKit hasn't been watching long enough to judge this yet."
    );
  }
  const rate = errorRatePerDay(record, observed);
  const value = reliabilityScore(rate);

  if (!record || record.uncaught === 0) {
    const logged = record?.logged ?? 0;
    return {
      value,
      source: "measured",
      detail: logged
        ? `No unhandled errors. It logged ${logged} error${logged === 1 ? "" : "s"} itself, which it appears to be handling.`
        : "No errors observed while FlowKit has been watching.",
    };
  }

  const per = rate >= 1 ? `about ${Math.round(rate)} a day` : "occasionally";
  return {
    value,
    source: "measured",
    detail: `${record.uncaught} unhandled error${
      record.uncaught === 1 ? "" : "s"
    } — ${per}. Last seen ${describeAge(Date.now() - record.lastAt)}.`,
  };
}

/** Rough age phrasing for error recency. */
function describeAge(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 1) return "in the last hour";
  if (hours < 24) return `${Math.round(hours)} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/**
 * Footprint — MEASURED, from what the plugin loads and what it does afterwards.
 *
 * This replaces the old "Performance" metric, which read exactly two inputs:
 * `isDesktopOnly` and the vault-wide count of enabled plugins. Because the
 * second is identical for every row, every enabled non-desktop-only plugin in a
 * 30-plugin vault scored exactly 75 — a literal constant down a sortable
 * column, carrying a fifth of Overall.
 *
 * For one version it was bundle size alone, which is honest about what it reads
 * and misleading about what it means: a 60 KB plugin polling four times a
 * second is worse for a vault than a 400 KB one that loads and sits idle, and
 * the metric said the opposite. It now also carries measured load time and
 * observed repeating timers, blended by taking the WORST of the three — see
 * `readFootprint`. Every added signal can only lower a score, and only when it
 * was actually observed, so a plugin is never marked expensive on a guess.
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
  const reading = readFootprint(i.bundleBytes, i.runtime, i.manifest.version);
  if (reading.value == null) return UNAVAILABLE(reading.detail);
  return { value: reading.value, source: "measured", detail: reading.detail };
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
 * didn't do, which is all this can honestly claim to measure — hence the
 * smallest weight the model has (5%, see `WEIGHTS`).
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
    // Dated per feed, so a merge can carry each half's real age forward.
    statsAt: stats != null ? at : undefined,
    listAt: list != null ? at : undefined,
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
  fresh: RemoteCache,
  /**
   * Installed plugin ids. Anything else is dropped.
   *
   * `buildRemoteCache` has always kept only installed plugins, and the merge
   * then quietly put the rest back: it unioned both key sets, so every plugin
   * the user had ever installed survived every refresh — rewritten on a full
   * fetch as an object of `undefined` fields, and carried through every clone
   * and every whole-file write for the life of the vault. `pruneStores` learned
   * this for the error log, the runtime profiles and the repository readings;
   * the cache was the one store it could not reach.
   */
  installed?: ReadonlySet<string>
): RemoteCache {
  if (!previous) return fresh;
  const merged: RemoteCache = {
    at: fresh.at,
    plugins: {},
    distribution: fresh.hadStats ? fresh.distribution : previous.distribution,
    hadStats: fresh.hadStats || previous.hadStats,
    hadList: fresh.hadList || previous.hadList,
    // Each half keeps the time IT was last fetched. Taking `fresh.at` for both
    // is how a stale community list spent days wearing a fresh timestamp.
    statsAt: fresh.hadStats ? fresh.statsAt : previous.statsAt,
    listAt: fresh.hadList ? fresh.listAt : previous.listAt,
  };
  const ids = new Set([
    ...Object.keys(previous.plugins),
    ...Object.keys(fresh.plugins),
  ]);
  for (const id of ids) {
    if (installed && !installed.has(id)) continue;
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
  const reliability = scoreReliability(i);

  const metrics = {
    compatibility,
    reliability,
    maintenance,
    footprint,
    hygiene,
    popularity,
  };

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

  // Summing six fractional weights leaves float noise (0.7500000000000001),
  // which would show up in the displayed confidence percentage.
  coverage = Math.round(coverage * 10_000) / 10_000;

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
    maintenanceStatus: deriveMaintenanceStatus(
      i.remote?.updated,
      now,
      i.remote,
      i.repoActivity
    ),
    updateAvailable,
    latestVersion,
    listing,
    muted: i.muted ?? false,
    mute: i.mute,
    watched: i.watched ?? false,
    overall,
    confidence: coverage,
    metrics,
    errors: i.errors,
    runtime: i.runtime,
    bundleBytes: i.bundleBytes,
    repoActivity: i.repoActivity,
  };
}
