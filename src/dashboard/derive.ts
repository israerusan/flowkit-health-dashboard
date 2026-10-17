/**
 * What the dashboard derives from a scan: the vault summary, whether it can be
 * graded, and which rows a filter, search or finding shows in what order.
 * Pure, so the numbers on the tiles and the rows behind them can be tested
 * against each other.
 */
import { isAtRisk, isIncompatible, needsAttention, type Insight } from "../insights";
import type { PluginHealth } from "../types";
import { GRADE_MIN_CONFIDENCE, type FilterKey, type SortKey, type SummaryStats } from "./format";

export function computeSummaryStats(results: readonly PluginHealth[]): SummaryStats {
  const active = results.filter((r) => !r.muted);
  const scored = active
    .map((r) => r.overall)
    .filter((n): n is number => n != null);
  const avg = scored.length
    ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length)
    : null;
  const confidence = active.length
    ? active.reduce((a, r) => a + r.confidence, 0) / active.length
    : 0;
  return {
    count: active.length,
    avg,
    atRisk: active.filter(isAtRisk).length,
    unmaintained: active.filter((r) => r.maintenanceStatus === "unmaintained")
      .length,
    updates: active.filter((r) => r.updateAvailable).length,
    confidence,
  };
}

/**
 * Whether this scan has the signal behind it to put a letter on.
 *
 * One decision, in one place, because there are four surfaces that print a
 * grade — the hero, Copy summary, the Markdown report and the CSV — and three
 * of them used to compute one unconditionally. The screen would say "not
 * enough signal to grade this vault" while the report the user pasted into
 * someone else's issue tracker confidently said "Grade B".
 *
 * The guard is not a pure weight threshold: Reliability is local, so offline
 * coverage reaches 0.70 on its own and would clear any threshold low enough
 * to be meaningful. Require the data whose absence it was written about.
 */
export function canGrade(s: SummaryStats, statsOnline: boolean): boolean {
  return s.confidence > GRADE_MIN_CONFIDENCE && statsOnline;
}

/** Whether one row belongs to a filter's cohort. */
export function matchesFilter(r: PluginHealth, filter: FilterKey): boolean {
  // Muted plugins are excluded from every count and every finding, but no
  // filter branch excluded them — so a filter could show rows the tile that
  // led there had deliberately not counted.
  if (r.muted && filter !== "all" && filter !== "muted") return false;
  switch (filter) {
    case "attention":
      return needsAttention(r);
    case "unmaintained":
      return r.maintenanceStatus === "unmaintained";
    case "incompatible":
      return isIncompatible(r);
    case "erroring":
      return (r.errors?.uncaught ?? 0) > 0;
    case "delisted":
      return r.listing === "delisted";
    case "sideloaded":
      return r.listing === "local";
    case "update":
      return r.updateAvailable;
    case "heavy":
      // The triage view: only things actually running can be slowing you
      // down, and a disabled plugin scores 100 here by definition.
      return r.enabled;
    case "watched":
      return r.watched;
    case "disabled":
      return !r.enabled;
    case "muted":
      return r.muted;
    default:
      return true;
  }
}

export interface RowQuery {
  search: string;
  filter: FilterKey;
  /** When set, the table is scoped to exactly the cohort a finding counted. */
  scope: Pick<Insight, "match"> | null;
  sortKey: SortKey;
  sortDir: 1 | -1;
  /** Precomputed lowercase "name author id" per plugin id, if available. */
  haystacks?: ReadonlyMap<string, string>;
}

/** The rows a table shows for a search, filter or finding, in display order. */
export function visibleRows(results: readonly PluginHealth[], q: RowQuery): PluginHealth[] {
  const needle = q.search.trim().toLowerCase();
  const filtered = results.filter((r) => {
    if (needle) {
      const hay = q.haystacks?.get(r.id) ?? `${r.name} ${r.author} ${r.id}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    // A finding scopes the table to exactly the rows it counted.
    if (q.scope) return q.scope.match(r);
    return matchesFilter(r, q.filter);
  });

  const dir = q.sortDir;
  return filtered.sort((a, b) => {
    if (q.sortKey === "name") return dir * a.name.localeCompare(b.name);
    const av = sortValue(a, q.sortKey);
    const bv = sortValue(b, q.sortKey);
    if (av == null && bv == null) return 0;
    if (av == null) return 1; // nulls always last
    if (bv == null) return -1;
    return dir * (av - bv);
  });
}

function sortValue(r: PluginHealth, key: SortKey): number | null {
  if (key === "overall") return r.overall;
  if (key === "name") return null;
  return r.metrics[key].value;
}
