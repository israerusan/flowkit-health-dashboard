// Shared types for the FlowKit Health Dashboard.

import type { ListingStatus } from "./scoring";
import type { MuteRecord } from "./mutes";
import type { RepoActivity } from "./repoActivity";
import type { RuntimeProfile } from "./runtime";

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
 * - `active`       — no recent release, but its repository was pushed to in the
 *                    last 6 months: being worked on, just not tagged.
 * - `aging`        — no release in a while (6–18 months).
 * - `stable`       — no recent release, but many published versions and most
 *                    users on the newest: finished rather than abandoned.
 * - `unmaintained` — no release in over 18 months and no sign of maturity, or
 *                    an archived / deleted repository.
 * - `unknown`      — no release data (offline, or not a community plugin).
 */
export type MaintenanceStatus =
  | "maintained"
  | "active"
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
  /** Why and for how long, when muted. */
  mute?: MuteRecord;
  /**
   * User has asked to be told about this one specifically. A vault-wide report
   * is global noise; three plugins the user actually depends on are personal.
   */
  watched: boolean;
  /** What this plugin costs while running, as far as it could be measured. */
  runtime?: RuntimeProfile;
  /** Bytes of code and styles on disk, when they could be read. */
  bundleBytes?: number;
  /** What its repository says about itself, when the lookup is switched on. */
  repoActivity?: RepoActivity;
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
    reliability: MetricScore;
  };
  /** Errors attributed to this plugin, when any have been observed. */
  errors?: PluginErrorRecord;
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
  /**
   * Which scoring model produced `avg`. Readings from different models are not
   * comparable and must never share a trend line: 1.0.0 reweighted everything
   * and added hard caps, so plotting a 0.2.3 reading beside a 1.0.0 one draws a
   * cliff the user did not cause. Absent on pre-1.0.0 entries.
   */
  model?: number;
}

/**
 * A plugin crossing into — or back out of — trouble.
 *
 * The 90-day history stores five vault-wide aggregates and no plugin ids, so it
 * is structurally incapable of answering "which one changed?". This is the
 * record that can: it is what makes reopening the dashboard worth doing, and
 * `resolved` matters most, because the product otherwise has no vocabulary for
 * good news arriving over time.
 */
export type HealthChangeKind =
  | "error-started"
  | "delisted"
  | "became-incompatible"
  | "update-published"
  | "resolved";

/**
 * Obsidian itself moving, recorded separately from per-plugin trouble.
 *
 * This is the moment people actually open a plugin-health dashboard: something
 * stopped working right after an update and they want to know what. Keeping the
 * version transition means the answer can be "here is what changed *because of
 * that update*" rather than a general list of everything currently wrong.
 */
export interface AppVersionChange {
  at: number;
  from: string;
  to: string;
  /** Plugin ids that could load before and cannot now. */
  brokeIds: string[];
}

export interface HealthChange {
  at: number;
  id: string;
  name: string;
  kind: HealthChangeKind;
}

/**
 * Bumped whenever a change to scoring makes old `avg` values incomparable.
 *
 * 4 — Footprint stopped being bytes-on-disk alone: measured load time and fast
 * repeating timers now count, and Maintenance can be corrected by what the
 * plugin's repository says. Both move real scores, so old readings are kept but
 * start a fresh trend line rather than drawing a step the user didn't cause.
 *
 * 5 — Footprint also counts how long a plugin's timer callbacks block the
 * interface, which is the cost users actually feel.
 */
export const SCORING_MODEL = 5;

/**
 * Where an error came from.
 * - `uncaught` — an exception nobody handled.
 * - `rejection` — a promise rejection nobody handled.
 * - `console`   — the plugin caught it and logged it itself. Counted and shown,
 *                 but deliberately excluded from the reliability score.
 */
export type ErrorKind = "uncaught" | "rejection" | "console";

/** One distinct error, with how often it has recurred. */
export interface ErrorSignature {
  key: string;
  kind: ErrorKind;
  message: string;
  stack?: string;
  count: number;
  firstAt: number;
  lastAt: number;
}

/** Everything observed about one plugin's runtime failures. */
export interface PluginErrorRecord {
  /** Uncaught exceptions + unhandled rejections. This is what gets scored. */
  uncaught: number;
  /** console.error calls attributed to this plugin. Context only. */
  logged: number;
  firstAt: number;
  lastAt: number;
  signatures: ErrorSignature[];
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
  /** When this projection was last rebuilt, from whichever feeds answered. */
  at: number;
  plugins: Record<string, CachedPlugin>;
  /** Sorted download counts across the directory, for percentile ranking. */
  distribution: number[];
  /** Which feeds contributed, so a cached scan reports coverage honestly. */
  hadStats: boolean;
  hadList: boolean;
  /**
   * When each feed was last fetched SUCCESSFULLY.
   *
   * The two files fail independently and are merged independently, so one
   * timestamp for both was a claim the cache could not support: a run of
   * stats-only successes kept bumping `at` while the community list — which is
   * what delisting, repository links and sideload detection are read from —
   * quietly aged behind it, under a header saying the data was from an hour
   * ago. The dashboard now dates each half by its own fetch and quotes the
   * older of the two.
   *
   * Optional because a cache written by an earlier version has neither; the
   * header falls back to `at`, which is what it always used.
   */
  statsAt?: number;
  listAt?: number;
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
