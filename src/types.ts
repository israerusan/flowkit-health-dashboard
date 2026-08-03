// Shared types for the FlowKit Health Dashboard.

import type { ListingStatus } from "./scoring";

export type { ListingStatus };

/**
 * How much to trust a metric value.
 * - `measured`   — derived from a real, authoritative signal (e.g. app version,
 *                  community download counts).
 * - `estimated`  — a heuristic; Obsidian exposes no direct signal, so we infer.
 * - `unavailable`— we could not produce a value (e.g. offline, or plugin disabled).
 */
export type MetricSource = "measured" | "estimated" | "unavailable";

/** A single scored metric, 0–100, plus provenance so the UI can be honest. */
export interface MetricScore {
  /** 0–100, or `null` when the metric could not be computed. */
  value: number | null;
  source: MetricSource;
  /** One-line human explanation shown in the tooltip / detail column. */
  detail: string;
}

/**
 * A plain, categorical read on release activity — easier to scan than the 0–100
 * maintenance score.
 * - `maintained`   — released recently (≤6 months).
 * - `aging`        — no release in a while (6–18 months).
 * - `stable`       — no recent release, but many published versions and most
 *                    users on the newest: finished rather than abandoned.
 * - `unmaintained` — no release in over 18 months, and no sign of maturity.
 * - `unknown`      — no release data (offline, or not a community plugin).
 */
export type MaintenanceStatus =
  | "maintained"
  | "aging"
  | "stable"
  | "unmaintained"
  | "unknown";

/** The five headline metrics the dashboard shows, plus a blended overall. */
export interface PluginHealth {
  id: string;
  name: string;
  author: string;
  version: string;
  enabled: boolean;
  /** owner/repo on GitHub, when known from the community list. */
  repo?: string;
  /** Plain maintained/not read, derived from the last-update timestamp. */
  maintenanceStatus: MaintenanceStatus;
  /** A newer version is published than the one installed. */
  updateAvailable: boolean;
  /** Latest published version, when known. */
  latestVersion?: string;
  /**
   * Where the plugin stands relative to Obsidian's community directory.
   * `delisted` (present in the stats file but pulled from the list) is a very
   * different thing from `local` (never listed — a personal or BRAT install),
   * and collapsing both into one "sideloaded" warning buried the more serious
   * of the two.
   */
  listing: ListingStatus;
  /** User has muted this plugin from the at-risk / unmaintained counts. */
  muted: boolean;
  /** Weighted blend of the available metrics, or `null` if none are available. */
  overall: number | null;
  /**
   * Share of the total metric weight that was actually available (0–1). Shown
   * to the user so a score built on two of five signals doesn't read as
   * confidently as one built on all five.
   */
  confidence: number;
  metrics: {
    hygiene: MetricScore;
    maintenance: MetricScore;
    footprint: MetricScore;
    popularity: MetricScore;
    compatibility: MetricScore;
  };
}

/**
 * One plugin's entry in Obsidian's community download-stats file. Alongside
 * `downloads` and `updated`, the object also carries one numeric key per
 * published version (e.g. `"0.5.64": 1234`), hence the index signature.
 */
export interface RemotePluginStat {
  downloads?: number;
  /** Last-update timestamp in epoch milliseconds. */
  updated?: number;
  /** Per-version download counts; keys are version strings. */
  [versionOrField: string]: number | undefined;
}

/** Keyed by plugin id. */
export type RemoteStats = Record<string, RemotePluginStat>;

/**
 * Which enrichment sources actually loaded for a scan. The two community files
 * fail independently — stats drives Popularity/Maintenance, the list drives
 * sideload detection and repo links — so "online" is not one boolean. Calling a
 * half-loaded scan "full metrics" is the kind of small lie that costs trust.
 */
export interface DataCoverage {
  /** community-plugin-stats.json loaded. */
  stats: boolean;
  /** community-plugins.json loaded. */
  list: boolean;
  /** Enrichment is deliberately switched off in settings. */
  disabled: boolean;
  /** Why enrichment is incomplete, when it failed rather than being off. */
  error?: string;
}

/**
 * A point-in-time reading of overall vault health, used by the Pro trend
 * tracker. Stored in plugin data; the list is capped to a recent window.
 */
export interface HealthSnapshot {
  /** Epoch milliseconds. */
  at: number;
  /** Vault-wide average overall score, or null if nothing was scorable. */
  avg: number | null;
  /** Number of (non-muted) plugins scored. */
  count: number;
  atRisk: number;
  unmaintained: number;
  updates: number;
  /**
   * Whether community data was available for this reading. Without it, a scan
   * taken on a train (two of five signals) sat on the same polyline as a full
   * one and fabricated a celebratory jump.
   */
  online?: boolean;
  /** Share of metric weight available, mirroring PluginHealth.confidence. */
  confidence?: number;
}

/**
 * The scored fields of one community plugin, kept between sessions. Storing
 * this rather than the raw feeds is what lets the dashboard paint immediately:
 * the two source files are ~3.7 MB uncompressed, and re-fetching them was
 * previously the first thing that happened on every open.
 */
export interface CachedPlugin {
  downloads?: number;
  updated?: number;
  latest?: string;
  /** Downloads sitting on the newest release, for the maturity signal. */
  latestDownloads?: number;
  releases?: number;
  repo?: string;
  listed?: boolean;
}

export interface RemoteCache {
  /** When this projection was built. */
  at: number;
  plugins: Record<string, CachedPlugin>;
  /** Sorted download counts across the directory, for percentile ranking. */
  distribution: number[];
  /** Which feeds contributed, so a cached scan reports coverage honestly. */
  hadStats: boolean;
  hadList: boolean;
}

/** One plugin's entry in Obsidian's community-plugins list. */
export interface CommunityListEntry {
  id: string;
  name: string;
  author: string;
  description: string;
  repo: string;
}

export type CommunityList = Record<string, CommunityListEntry>;
