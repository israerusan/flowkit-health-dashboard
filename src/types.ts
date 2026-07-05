// Shared types for the FlowKit Health Dashboard.

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
 * A plain, categorical read on whether a plugin is still being maintained —
 * easier to scan than the 0–100 maintenance score.
 * - `maintained`   — updated recently (≤6 months).
 * - `aging`        — no update in a while (6–18 months).
 * - `unmaintained` — likely abandoned (>18 months).
 * - `unknown`      — no update data (offline, or not a community plugin).
 */
export type MaintenanceStatus =
  | "maintained"
  | "aging"
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
   * Whether the plugin is absent from Obsidian's community list (a trust
   * signal — sideloaded plugins skip community review). `null` when unknown
   * (offline / enrichment off).
   */
  sideloaded: boolean | null;
  /** User has muted this plugin from the at-risk / unmaintained counts. */
  muted: boolean;
  /** Average of the available metric values, or `null` if none are available. */
  overall: number | null;
  metrics: {
    quality: MetricScore;
    maintenance: MetricScore;
    performance: MetricScore;
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
