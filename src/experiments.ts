// Health experiments and regression detection, kept free of Obsidian imports.
import type { PluginEvent } from "./timeline";
import type { PluginHealth } from "./types";

export interface HealthReading {
  at: number;
  avg: number | null;
  atRisk: number;
  updates: number;
  count: number;
  confidence: number;
  plugins: Record<string, { name: string; version: string; enabled: boolean; overall: number | null }>;
}
export type HealthReadingMap = Record<string, HealthReading>;
export interface HealthExperiment { id: string; name: string; startedAt: number; baseline: HealthReading; after?: HealthReading; completedAt?: number; }
export interface ExperimentPluginDelta { id: string; name: string; before: number | null; after: number | null; delta: number | null; versionChanged: boolean; }
export interface ExperimentComparison { avgDelta: number | null; atRiskDelta: number; updatesDelta: number; comparable: boolean; worsened: ExperimentPluginDelta[]; improved: ExperimentPluginDelta[]; changed: ExperimentPluginDelta[]; }
export interface PluginRegression { id: string; name: string; at: number; fromVersion: string; toVersion: string; fromOverall: number; toOverall: number; delta: number; reason: "update" | "health-drop"; }
const DEFAULT_REGRESSION_THRESHOLD = 10;

export function captureHealthReading(results: PluginHealth[], at: number): HealthReading {
  const active = results.filter((r) => !r.muted);
  const scored = active.map((r) => r.overall).filter((v): v is number => v != null);
  return { at, avg: scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null, atRisk: active.filter((r) => r.overall != null && r.overall < 50).length, updates: active.filter((r) => r.updateAvailable).length, count: active.length, confidence: active.length ? active.reduce((a, r) => a + r.confidence, 0) / active.length : 0, plugins: Object.fromEntries(results.map((r) => [r.id, { name: r.name, version: r.version, enabled: r.enabled, overall: r.overall }])) };
}

export function compareHealth(before: HealthReading, after: HealthReading): ExperimentComparison {
  const changed: ExperimentPluginDelta[] = [];
  for (const [id, next] of Object.entries(after.plugins)) {
    const prior = before.plugins[id];
    if (!prior) { changed.push({ id, name: next.name, before: null, after: next.overall, delta: next.overall, versionChanged: true }); continue; }
    const delta = prior.overall == null || next.overall == null ? null : next.overall - prior.overall;
    if (delta !== 0 || prior.version !== next.version || prior.enabled !== next.enabled) changed.push({ id, name: next.name, before: prior.overall, after: next.overall, delta, versionChanged: prior.version !== next.version });
  }
  const numeric = changed.filter((x): x is ExperimentPluginDelta & { delta: number } => x.delta != null);
  return { avgDelta: before.avg == null || after.avg == null ? null : after.avg - before.avg, atRiskDelta: after.atRisk - before.atRisk, updatesDelta: after.updates - before.updates, comparable: before.confidence > 0 && after.confidence > 0, worsened: numeric.filter((x) => x.delta < 0).sort((a, b) => a.delta - b.delta), improved: numeric.filter((x) => x.delta > 0).sort((a, b) => b.delta - a.delta), changed };
}

function hasRecentUpdate(events: PluginEvent[], id: string, from: number, at: number): boolean { return events.some((e) => e.id === id && (e.kind === "updated" || e.kind === "installed") && e.at >= from && e.at <= at); }

export function detectRegressions(previous: HealthReadingMap, current: PluginHealth[], events: PluginEvent[], at: number, threshold = DEFAULT_REGRESSION_THRESHOLD): PluginRegression[] {
  const out: PluginRegression[] = [];
  for (const row of current) {
    if (!row.enabled || row.overall == null) continue;
    const prior = previous[row.id]; const old = prior?.plugins[row.id];
    if (!prior || !old?.enabled || old.overall == null) continue;
    const delta = row.overall - old.overall;
    if (delta > -Math.abs(threshold)) continue;
    const updated = old.version !== row.version;
    out.push({ id: row.id, name: row.name, at, fromVersion: old.version, toVersion: row.version, fromOverall: old.overall, toOverall: row.overall, delta, reason: updated || hasRecentUpdate(events, row.id, prior.at, at) ? "update" : "health-drop" });
  }
  return out.sort((a, b) => a.delta - b.delta);
}

export function isLastKnownGood(results: PluginHealth[], minimumAverage = 70): boolean {
  const active = results.filter((r) => !r.muted && r.enabled); if (!active.length) return false;
  const scored = active.map((r) => r.overall).filter((v): v is number => v != null);
  return scored.length > 0 && scored.reduce((a, b) => a + b, 0) / scored.length >= minimumAverage && active.every((r) => r.metrics.compatibility.value !== 0 && r.listing !== "delisted" && (r.errors?.uncaught ?? 0) === 0);
}
export const REGRESSION_THRESHOLD = DEFAULT_REGRESSION_THRESHOLD;
