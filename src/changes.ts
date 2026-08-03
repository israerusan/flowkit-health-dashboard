// Change detection between two scans, kept free of any Obsidian import so the
// Node test suite exercises this exact code.
//
// This is what makes the dashboard worth reopening: every other section renders
// the same thing on every visit.

import type { HealthChange, HealthChangeKind } from "./types";

/** Kinds that mean something is wrong, as opposed to merely newsworthy. */
export const BAD_KINDS: HealthChangeKind[] = [
  "error-started",
  "delisted",
  "became-incompatible",
];

/** One plugin's state, reduced to what the diff needs. */
export interface TroubleRow {
  id: string;
  name: string;
  muted: boolean;
  kinds: HealthChangeKind[];
}

export interface TroubleDiff {
  fresh: HealthChange[];
  current: Record<string, HealthChangeKind[]>;
}

/**
 * Diff this scan's trouble state against the last one.
 *
 * @param evaluable which kinds this scan could actually judge. Absence of
 *   evidence is not evidence of recovery: `delisted` and `update-published`
 *   both need the community feeds, so a scan taken with enrichment off would
 *   otherwise "resolve" every delisting and announce it as good news.
 */
export function diffTrouble(
  previous: Record<string, HealthChangeKind[]>,
  rows: TroubleRow[],
  evaluable: Set<HealthChangeKind>,
  at: number
): TroubleDiff {
  const current: Record<string, HealthChangeKind[]> = {};
  const fresh: HealthChange[] = [];
  const isBad = (k: HealthChangeKind): boolean => BAD_KINDS.includes(k);

  for (const r of rows) {
    const before = previous[r.id] ?? [];
    // Only judge what this scan could see; carry the rest forward untouched.
    const observed = r.kinds.filter((k) => evaluable.has(k));
    const carried = before.filter((k) => !evaluable.has(k));
    const kinds = [...new Set([...observed, ...carried])];
    if (kinds.length) current[r.id] = kinds;

    // A muted plugin keeps its state but never generates news — the user has
    // explicitly said they don't want to hear about it. Preserving the state is
    // what stops unmuting later from re-announcing old trouble as new.
    if (r.muted) continue;

    const beforeSet = new Set(before);
    for (const kind of kinds) {
      if (!beforeSet.has(kind)) fresh.push({ at, id: r.id, name: r.name, kind });
    }
    // "Resolved" is only about genuine trouble clearing. Counting
    // `update-published` here meant installing an update — the single most
    // common transition in any vault — announced "is back to normal".
    if (before.some(isBad) && !kinds.some(isBad)) {
      fresh.push({ at, id: r.id, name: r.name, kind: "resolved" });
    }
  }
  return { fresh, current };
}

/** Whether two trouble maps describe the same state. */
export function sameKinds(
  a: Record<string, HealthChangeKind[]>,
  b: Record<string, HealthChangeKind[]>
): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((id) => (a[id] ?? []).join("|") === (b[id] ?? []).join("|"));
}
