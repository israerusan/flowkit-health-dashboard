// "Which of these should I turn off first?" — kept free of any Obsidian import
// so the Node test suite exercises this exact code.
//
// The insight list says what is wrong. It does not say what to do first, and
// for a vault with nine findings that is the question the user actually has.
// Ranking by badness alone answers it wrongly: the worst-scoring plugin is
// often one they use every day, and the easy win is the broken one they had
// forgotten was installed.

import type { PluginHealth } from "./types";

export interface TriageCandidate {
  id: string;
  name: string;
  /** How much trouble this plugin is causing, roughly 0–100. */
  risk: number;
  /** How much the user would give up by turning it off, roughly 0–100. */
  cost: number;
  /** Risk per unit of loss — the order to act in. */
  ratio: number;
  /** Why it is on the list. */
  why: string;
  /** What switching it off would actually cost. */
  loss: string;
}

/** Below this there is nothing worth recommending a disable for. */
const MIN_RISK = 25;

/**
 * What this plugin is costing you right now.
 *
 * Weighted towards facts over scores: "cannot load" and "pulled from the
 * directory" are certainties, where a low overall is a blend that may be
 * dragged down by a metric the user doesn't care about.
 */
function riskOf(r: PluginHealth): { risk: number; why: string } {
  const reasons: Array<{ weight: number; text: string }> = [];

  if (r.metrics.compatibility.value === 0) {
    reasons.push({ weight: 45, text: "it can't load on this Obsidian, so it is doing nothing" });
  }
  if (r.listing === "delisted") {
    reasons.push({ weight: 40, text: "Obsidian pulled it from the community directory" });
  }
  const errors = r.errors?.uncaught ?? 0;
  if (errors > 0) {
    reasons.push({
      weight: Math.min(35, 5 + errors * 4),
      text: `it has thrown ${errors} unhandled error${errors === 1 ? "" : "s"} here`,
    });
  }
  if (r.maintenanceStatus === "unmaintained") {
    reasons.push({ weight: 15, text: "nothing has been released or pushed for a long time" });
  }
  const footprint = r.metrics.footprint.value;
  if (footprint != null && footprint < 50) {
    reasons.push({
      weight: Math.min(20, Math.round((50 - footprint) * 0.4)),
      text: "it is one of the heavier things your vault loads",
    });
  }

  const base = r.overall == null ? 0 : Math.max(0, (100 - r.overall) / 4);
  const risk = Math.min(100, base + reasons.reduce((n, x) => n + x.weight, 0));
  const top = [...reasons].sort((a, b) => b.weight - a.weight)[0];
  return { risk, why: top?.text ?? "its overall health is low" };
}

/**
 * What you would lose.
 *
 * A plugin that cannot load costs nothing to disable — it is already not
 * running, and saying so is the single most useful thing this ranking does.
 * Otherwise the proxy is surface area: commands you could be using, and hooks
 * it has registered.
 */
function costOf(r: PluginHealth): { cost: number; loss: string } {
  if (r.metrics.compatibility.value === 0) {
    return { cost: 0, loss: "nothing — it already isn't running" };
  }
  if (r.watched) {
    // The user has explicitly said this one matters. Never recommend it first.
    return { cost: 100, loss: "you're watching this one, so it stays" };
  }

  const commands = r.runtime?.commands ?? 0;
  const handlers = r.runtime?.handlers ?? 0;
  const cost = Math.min(100, commands * 6 + Math.min(30, handlers * 2));

  if (commands === 0 && handlers === 0) {
    // A profile always exists once runtime tracking is on, so its presence
    // proves nothing. `handlers` is the field that is only set when FlowKit
    // actually reached the plugin's own component — without it, "registers
    // nothing" and "we couldn't look" are indistinguishable, and claiming the
    // first would recommend disabling a plugin on no evidence at all.
    const looked = r.runtime?.handlers != null;
    return {
      cost,
      loss: looked
        ? "no commands and no registered hooks — it may not be doing much"
        : "unknown — FlowKit couldn't see what it registers",
    };
  }
  const parts: string[] = [];
  if (commands) parts.push(`${commands} command${commands === 1 ? "" : "s"}`);
  if (handlers) parts.push(`${handlers} registered hook${handlers === 1 ? "" : "s"}`);
  return { cost, loss: parts.join(" and ") };
}

/**
 * The plugins to turn off first: most trouble removed for least given up.
 *
 * Disabled and muted plugins are excluded — one is already off, and the other
 * is something the user has explicitly told us to stop suggesting.
 */
export function rankSafeDisable(rows: PluginHealth[], limit = 3): TriageCandidate[] {
  const candidates: TriageCandidate[] = [];
  for (const r of rows) {
    if (!r.enabled || r.muted) continue;
    const { risk, why } = riskOf(r);
    if (risk < MIN_RISK) continue;
    const { cost, loss } = costOf(r);
    candidates.push({
      id: r.id,
      name: r.name,
      risk: Math.round(risk),
      cost: Math.round(cost),
      // +25 rather than +1 so a plugin with one command isn't ranked as though
      // disabling it were free; the divisor is a smoothing constant, not a unit.
      ratio: risk / (1 + cost / 25),
      why,
      loss,
    });
  }
  return candidates.sort((a, b) => b.ratio - a.ratio).slice(0, limit);
}
