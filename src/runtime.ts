// What a plugin costs while it is *running*, as opposed to how big it is on
// disk. Kept free of any Obsidian import so the Node test suite exercises it.
//
// Bundle size was the only cost signal FlowKit had, and it is a bad one on its
// own: a 60 KB plugin polling every 250 ms is worse for your vault than a
// 400 KB one that loads and then sits idle. This module adds the two runtime
// costs that can actually be measured from inside another plugin — how long it
// took to load, and whether it is holding a fast repeating timer — and blends
// them with size so the worst observed cost is the one that shows.

/** Everything observed about one plugin's runtime cost. */
export interface RuntimeProfile {
  /**
   * Milliseconds the plugin took to load, when FlowKit witnessed the load.
   * Absent for plugins that were already loaded before FlowKit started, which
   * is most of them on a cold vault — hence `loadVersion`, so a stale reading
   * from an older build is never presented as current.
   */
  loadMs?: number;
  /** The plugin version `loadMs` was measured for. */
  loadVersion?: string;
  /** When the load was timed. */
  loadAt?: number;
  /**
   * Shortest repeating-timer period seen from this plugin, in milliseconds.
   * Observed by watching `setInterval`, so it only covers timers created after
   * FlowKit loaded — absence is never treated as evidence of idleness.
   */
  minIntervalMs?: number;
  /** How many repeating timers this plugin currently holds. */
  timers?: number;
  /**
   * Longest single SYNCHRONOUS run of one of those timer callbacks, in
   * milliseconds.
   *
   * This is the number that actually explains a laggy vault. Obsidian's UI is
   * single-threaded, so a callback that takes 180 ms is 180 ms in which nothing
   * you type appears — and a plugin can hold a slow callback on a slow timer
   * and still look cheap by every other measure here.
   *
   * Synchronous is the honest word, and the limit is deliberate. The wrapper
   * that produces this sits in front of every timer tick in the vault, so it
   * times the callback and stops — a callback that returns a promise is
   * measured up to that return. Following the promise would mean measuring
   * network latency and scheduling delay as though they were time the interface
   * spent frozen, which is the opposite of what this number is for.
   */
  maxTickMs?: number;
  /** How many callback runs that maximum was drawn from. */
  ticks?: number;
  /** Commands it has registered. Context for "what would I lose", not scored. */
  commands?: number;
  /** Registered event/DOM/interval cleanups on its component. Context only. */
  handlers?: number;
}

export type RuntimeProfiles = Record<string, RuntimeProfile>;

/** Where the footprint size curve is anchored: 50 KB scores 100, each 10× costs 40. */
export const FOOTPRINT_BASE_BYTES = 50_000;

/** A load this fast is free as far as this metric is concerned. */
const LOAD_BASE_MS = 50;

/** Timers slower than this are housekeeping, not polling. */
const IDLE_PERIOD_MS = 60_000;

/** The fastest period we bother to distinguish; anything quicker scores the same. */
const HOT_PERIOD_MS = 100;

/** Most a repeating timer can take off the footprint score. */
const MAX_POLL_PENALTY = 45;

/**
 * A callback finishing inside this is imperceptible. Chosen to match the frame
 * budget people actually feel: below ~16 ms nothing drops, and a callback is
 * competing with rendering for the same single thread.
 */
const TICK_FREE_MS = 16;

/** A single callback run this long is a visible freeze. */
const TICK_BAD_MS = 250;

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Human-readable byte size. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Human-readable timer period. */
export function formatPeriod(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) {
    const s = ms / 1000;
    return `${s % 1 === 0 ? s : s.toFixed(1)} s`;
  }
  const mins = Math.round(ms / 60_000);
  return `${mins} minute${mins === 1 ? "" : "s"}`;
}

/** 0–100 from bytes loaded at startup. */
export function sizeScore(bytes: number): number {
  return clamp(100 - 40 * Math.log10(bytes / FOOTPRINT_BASE_BYTES));
}

/** 0–100 from how long the plugin took to load. */
export function loadScore(ms: number): number {
  if (ms <= LOAD_BASE_MS) return 100;
  return clamp(100 - 40 * Math.log10(ms / LOAD_BASE_MS));
}

/**
 * How much a repeating timer costs the footprint score. A timer that fires once
 * a minute or slower costs nothing; one firing ten times a second costs the
 * most this can take off.
 */
export function pollPenalty(periodMs: number): number {
  if (!Number.isFinite(periodMs) || periodMs >= IDLE_PERIOD_MS) return 0;
  const period = Math.max(HOT_PERIOD_MS, periodMs);
  const span = Math.log10(IDLE_PERIOD_MS / HOT_PERIOD_MS);
  return Math.round(MAX_POLL_PENALTY * (Math.log10(IDLE_PERIOD_MS / period) / span));
}

/**
 * 0–100 from the longest single run of a repeating callback.
 *
 * Scored on its own axis rather than folded into the polling penalty, because
 * the two are independent failures: a slow callback on a slow timer still
 * freezes the UI every time it fires, and a fast timer doing nothing costs
 * almost nothing. Blocking the thread for a quarter of a second bottoms out.
 */
export function tickScore(ms: number): number {
  if (ms <= TICK_FREE_MS) return 100;
  if (ms >= TICK_BAD_MS) return 0;
  return Math.round(
    100 * (1 - (ms - TICK_FREE_MS) / (TICK_BAD_MS - TICK_FREE_MS))
  );
}

export interface FootprintReading {
  /** 0–100, or null when nothing could be measured. */
  value: number | null;
  /** One-line explanation naming whichever cost actually drove the number. */
  detail: string;
  /** Whether a runtime cost (not just size) contributed. */
  sawRuntime: boolean;
}

/**
 * Blend size and runtime cost into one footprint reading.
 *
 * The blend is a MINIMUM, not a mean. These are alternative ways of being
 * expensive, not components of one quantity: a plugin that loads instantly but
 * polls four times a second has not earned an average of "fine" and "awful".
 * The worst measured cost is the cost.
 */
export function readFootprint(
  bytes: number | undefined,
  profile: RuntimeProfile | undefined,
  /** The installed version, so a load time measured for an older build is ignored. */
  version?: string
): FootprintReading {
  const parts: string[] = [];
  const scores: number[] = [];
  let sawRuntime = false;

  if (bytes != null && bytes > 0) {
    scores.push(sizeScore(bytes));
    parts.push(`${formatBytes(bytes)} of code and styles loaded at startup`);
  }

  const load = currentLoadMs(profile, version);
  if (load != null) {
    sawRuntime = true;
    scores.push(loadScore(load));
    parts.push(`took ${Math.round(load)} ms to load`);
  }

  const period = profile?.minIntervalMs;
  if (period != null && Number.isFinite(period)) {
    const penalty = pollPenalty(period);
    if (penalty > 0) {
      sawRuntime = true;
      // Applied to a full-marks baseline rather than to the size score, so a
      // small plugin that polls hard cannot hide behind being small.
      scores.push(clamp(100 - penalty));
      parts.push(`runs a timer every ${formatPeriod(period)}`);
    } else {
      parts.push(`its timers fire every ${formatPeriod(period)} or slower`);
    }
  }

  // The number that explains a laggy vault: Obsidian's UI is single-threaded,
  // so a callback taking 180 ms is 180 ms in which nothing the user types
  // appears. A plugin can hold a slow callback on a slow timer and look cheap
  // by every other measure here.
  const tick = profile?.maxTickMs;
  if (tick != null && Number.isFinite(tick) && tick > TICK_FREE_MS) {
    sawRuntime = true;
    scores.push(tickScore(tick));
    parts.push(
      `blocks the interface for ${Math.round(tick)} ms of work each time that timer fires`
    );
  }

  if (!scores.length) {
    return {
      value: null,
      detail: "Couldn't read this plugin's files on disk.",
      sawRuntime: false,
    };
  }

  return {
    value: Math.round(Math.min(...scores)),
    detail: `${sentence(parts)}.`,
    sawRuntime,
  };
}

/** Join clauses into one readable sentence, capitalised. */
function sentence(parts: string[]): string {
  const joined =
    parts.length <= 1
      ? (parts[0] ?? "")
      : `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/**
 * Fold a witnessed load into a profile. A load time is only kept when it was
 * measured for the version that is installed now — plugin authors ship
 * performance fixes, and quoting last month's number against this month's build
 * is the kind of stale claim the rest of this product exists to avoid.
 */
export function recordLoad(
  existing: RuntimeProfile | undefined,
  ms: number,
  version: string,
  at: number
): RuntimeProfile {
  return { ...(existing ?? {}), loadMs: Math.round(ms), loadVersion: version, loadAt: at };
}

/**
 * Drop profiles for plugins that are no longer installed, mirroring what the
 * error log does — otherwise data.json accumulates readings for things the user
 * removed months ago.
 */
export function pruneProfiles(
  profiles: RuntimeProfiles,
  installed: ReadonlySet<string>
): RuntimeProfiles {
  const out: RuntimeProfiles = {};
  for (const [id, profile] of Object.entries(profiles)) {
    if (installed.has(id)) out[id] = profile;
  }
  return out;
}

/**
 * Whether a recorded load time describes the build that is installed now.
 *
 * The same question `readFootprint` asks, extracted so every surface asks it
 * the same way. It used to be asked in two places and skipped in a third, and
 * the three then disagreed about the same plugin: after an update the row's
 * Footprint ignored the stale reading, the detail panel showed neither the time
 * nor the "not measured yet" hint, and the vault total went on adding
 * milliseconds measured against a build the user no longer runs.
 */
export function currentLoadMs(
  profile: RuntimeProfile | undefined,
  version?: string
): number | undefined {
  if (profile?.loadMs == null) return undefined;
  if (profile.loadVersion != null && version != null && profile.loadVersion !== version) {
    return undefined;
  }
  return profile.loadMs;
}

/**
 * Total startup weight across the enabled set, for the slow-vault triage view.
 *
 * @param rows each plugin's id, enabled state, bytes and INSTALLED version —
 *   the version so a load time measured for an older build is left out of the
 *   total rather than quoted as current.
 */
export function startupCost(
  rows: Array<{ id: string; enabled: boolean; bytes?: number; version?: string }>,
  profiles: RuntimeProfiles
): { bytes: number; measuredMs: number; measuredCount: number; polling: number } {
  let bytes = 0;
  let measuredMs = 0;
  let measuredCount = 0;
  let polling = 0;
  for (const row of rows) {
    if (!row.enabled) continue;
    bytes += row.bytes ?? 0;
    const profile = profiles[row.id];
    const load = currentLoadMs(profile, row.version);
    if (load != null) {
      measuredMs += load;
      measuredCount++;
    }
    if (profile?.minIntervalMs != null && pollPenalty(profile.minIntervalMs) > 0) polling++;
  }
  return { bytes, measuredMs, measuredCount, polling };
}
