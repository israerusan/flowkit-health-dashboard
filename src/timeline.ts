// What changed in your vault, and when. Kept free of any Obsidian import so the
// Node test suite exercises this exact code.
//
// FlowKit already knew both halves of the most useful sentence it could say —
// when each plugin's version changed, and when each plugin started throwing
// errors — and never put them together. "Templater has thrown 40 errors" is a
// fact. "Templater started throwing errors two hours after it updated to 2.4.1"
// is a diagnosis, and it is the same data.

export type PluginEventKind = "installed" | "updated" | "removed" | "enabled" | "disabled";

export interface PluginEvent {
  /** When FlowKit NOTICED the change — an upper bound, not when it happened. */
  at: number;
  /**
   * When FlowKit last confirmed the previous state, so the change is known to
   * have happened somewhere in `(since, at]`.
   *
   * The distinction matters more than it looks. A plugin updates, breaks
   * thirty seconds later, and FlowKit does not scan until the error itself
   * triggers a rescan — so `at` lands *after* the errors started and a
   * strictly-ordered comparison concludes the update cannot be responsible.
   * Anchoring to the start of the window is what lets the correlation fire in
   * the one case people actually care about. Absent on the first event
   * recorded for a plugin.
   */
  since?: number;
  id: string;
  name: string;
  kind: PluginEventKind;
  /** Previous version, for an update. */
  from?: string;
  /** New version, for an install or update. */
  to?: string;
}

/** What we remember about a plugin between scans, to notice it changing. */
export interface SeenPlugin {
  version: string;
  enabled: boolean;
  at: number;
}

export type SeenMap = Record<string, SeenPlugin>;

/** One plugin as this scan sees it. */
export interface ObservedPlugin {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
}

export interface TimelineDiff {
  events: PluginEvent[];
  seen: SeenMap;
}

/**
 * Diff this scan's installed set against the last one.
 *
 * The first run records a baseline and emits nothing: announcing every plugin
 * as newly "installed" the day the feature ships would fabricate forty events
 * that never happened, which is exactly the mistake the change log was fixed
 * for in 1.2.0.
 */
export function diffInstalled(
  previous: SeenMap,
  observed: ObservedPlugin[],
  at: number,
  /** False on the very first run, so the baseline is recorded silently. */
  emit = true
): TimelineDiff {
  const events: PluginEvent[] = [];
  const seen: SeenMap = {};

  for (const plugin of observed) {
    const before = previous[plugin.id];
    seen[plugin.id] = { version: plugin.version, enabled: plugin.enabled, at };

    if (!emit) continue;

    if (!before) {
      events.push({ at, id: plugin.id, name: plugin.name, kind: "installed", to: plugin.version });
      continue;
    }
    if (before.version !== plugin.version) {
      events.push({
        at,
        // The old version was still there at `before.at`, so the update landed
        // somewhere between then and now.
        since: before.at,
        id: plugin.id,
        name: plugin.name,
        kind: "updated",
        from: before.version,
        to: plugin.version,
      });
    }
    if (before.enabled !== plugin.enabled) {
      events.push({
        at,
        since: before.at,
        id: plugin.id,
        name: plugin.name,
        kind: plugin.enabled ? "enabled" : "disabled",
      });
    }
  }

  if (emit) {
    const present = new Set(observed.map((p) => p.id));
    for (const [id, before] of Object.entries(previous)) {
      if (present.has(id)) continue;
      events.push({ at, id, name: id, kind: "removed", from: before.version });
    }
  }

  return { events, seen };
}

/**
 * How long after a change the errors have to start for the two to be worth
 * connecting.
 *
 * Three days is deliberately generous: a plugin can update on Monday and only
 * break on Wednesday when you next touch the feature it broke. It is also short
 * enough that "it updated some time last month" never gets presented as a
 * cause, which would be the failure mode worth avoiding — a wrong culprit is
 * worse than no culprit.
 */
export const CORRELATION_WINDOW_MS = 3 * 86_400_000;

export interface Correlation {
  id: string;
  name: string;
  /** The change that preceded the errors. */
  event: PluginEvent;
  /** When the errors started. */
  errorsFrom: number;
  /** Gap between noticing the change and the first error, floored at zero. */
  gapMs: number;
  /**
   * The errors began inside the window in which the change happened, so the
   * order of the two is genuinely unknown. Reported rather than smoothed over:
   * "two hours after" is a claim, and this is the case where we cannot make it.
   */
  approximate: boolean;
}

/** One plugin's error history, reduced to what the correlation needs. */
export interface ErrorOnset {
  id: string;
  name: string;
  /** When the first error was recorded, or undefined if there are none. */
  firstAt?: number;
  uncaught: number;
}

/**
 * Changes that are followed by errors.
 *
 * Strictly *after*, and strictly within the window. Errors that were already
 * happening before the update are not evidence about the update — that is the
 * whole difference between a correlation and a coincidence, and getting it
 * wrong would have FlowKit blaming an author for a bug that predates their
 * release.
 */
export function correlate(
  events: PluginEvent[],
  onsets: ErrorOnset[],
  now: number,
  windowMs = CORRELATION_WINDOW_MS
): Correlation[] {
  const out: Correlation[] = [];
  for (const onset of onsets) {
    if (onset.firstAt == null || onset.uncaught === 0) continue;
    // The most recent qualifying change, so an old install doesn't outrank
    // yesterday's update.
    const firstAt = onset.firstAt;
    const candidates = events
      .filter((e) => {
        if (e.id !== onset.id) return false;
        if (e.kind !== "updated" && e.kind !== "installed") return false;
        // Anchored to the START of the window the change happened in, not to
        // the moment we noticed it — see PluginEvent.since.
        const from = e.since ?? e.at;
        return firstAt >= from && firstAt - from <= windowMs;
      })
      .sort((a, b) => b.at - a.at);
    const event = candidates[0];
    if (!event) continue;
    out.push({
      id: onset.id,
      name: onset.name,
      event,
      errorsFrom: firstAt,
      gapMs: Math.max(0, firstAt - event.at),
      approximate: firstAt < event.at,
    });
  }
  // Most recent first — the one still fresh in the user's memory.
  return out.sort((a, b) => b.errorsFrom - a.errorsFrom).filter((c) => c.errorsFrom <= now);
}

/** "two hours", "3 days" — the gap, in words. */
export function describeGap(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 1) return "minutes";
  if (hours < 24) {
    const h = Math.round(hours);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** One line for a recorded change. */
export function describeEvent(event: PluginEvent): string {
  switch (event.kind) {
    case "installed":
      return `installed${event.to ? ` at v${event.to}` : ""}`;
    case "updated":
      return `updated ${event.from ? `v${event.from} → ` : ""}v${event.to ?? "?"}`;
    case "removed":
      return "uninstalled";
    case "enabled":
      return "enabled";
    default:
      return "disabled";
  }
}

/** Drop events past the retention window, newest kept. */
export function pruneEvents(events: PluginEvent[], now: number, keepDays = 90): PluginEvent[] {
  const cutoff = now - keepDays * 86_400_000;
  return events.filter((e) => e.at >= cutoff);
}
