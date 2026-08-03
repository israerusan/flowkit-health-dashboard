// Attribution and scoring for runtime errors, kept free of any Obsidian import
// so the Node test suite exercises this exact code.
//
// This is the one genuinely per-plugin *reliability* signal available to us.
// Everything else the dashboard scores is metadata about a plugin; this is the
// plugin actually misbehaving on this machine, today.

import type { ErrorKind, PluginErrorRecord } from "./types";

/**
 * Obsidian loads each plugin's code with a `//# sourceURL=plugin:<id>` marker,
 * so stack frames from inside a plugin name it directly. That is the reliable
 * path — but it is an implementation detail, not a documented API, so we also
 * match the on-disk location (`.obsidian/plugins/<id>/main.js`) and fall back
 * to no attribution rather than guessing.
 */
const SOURCE_URL_FRAME = /\bplugin:([a-z0-9][a-z0-9._-]*)/gi;
const PLUGIN_PATH_FRAME = /[/\\]plugins[/\\]([^/\\]+)[/\\]/g;

/**
 * Which installed plugin a stack trace belongs to, or null when nothing in it
 * points at plugin code (Obsidian's own internals, a theme, or FlowKit's own
 * listener frames).
 *
 * Frames are examined top-down so the innermost plugin wins: when plugin A
 * calls into plugin B's exported helper and it throws, the frame nearest the
 * throw is B's, and B is the one with the bug.
 */
export function attributeStack(
  stack: string | undefined,
  installed: ReadonlySet<string>,
  /**
   * Plugin ids to look straight past — in practice, FlowKit's own.
   *
   * This matters whenever the stack is captured from inside FlowKit rather than
   * at the point something went wrong. A thrown `Error` records its stack where
   * it was thrown, so FlowKit never appears in it; but a stack synthesised
   * inside one of our own wrappers — the `setInterval` hook, or `console.error`
   * called with a bare string — has FlowKit's frames sitting on top of the
   * caller's. Without this, the innermost-wins rule below faithfully picks the
   * innermost plugin and that plugin is always us: every timer in the vault
   * gets recorded against FlowKit and no other plugin is ever measured.
   */
  ignore?: ReadonlySet<string>
): string | null {
  if (!stack) return null;
  for (const line of stack.split("\n")) {
    for (const pattern of [SOURCE_URL_FRAME, PLUGIN_PATH_FRAME]) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        const id = match[1];
        if (ignore?.has(id)) continue;
        if (installed.has(id)) return id;
      }
    }
  }
  return null;
}

/**
 * A stable key for "the same error happening again", so a plugin throwing in a
 * loop is one entry with a count rather than ten thousand rows. The message
 * plus the first plugin-owned frame is specific enough to separate distinct
 * bugs and loose enough to survive changing line numbers between versions.
 */
export function errorSignature(message: string, stack?: string): string {
  const firstFrame = (stack ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("at ") && /plugin:|[/\\]plugins[/\\]/.test(l));
  // Numbers are stripped so line/column drift doesn't fragment the count.
  const normalisedFrame = (firstFrame ?? "").replace(/\d+/g, "#");
  return `${message.slice(0, 200)}::${normalisedFrame}`;
}

/** Longest message worth keeping; some plugins throw entire JSON documents. */
const MAX_MESSAGE = 300;
/** Distinct signatures kept per plugin before the least recent is dropped. */
export const MAX_SIGNATURES_PER_PLUGIN = 12;

export interface ObservedError {
  pluginId: string;
  kind: ErrorKind;
  message: string;
  stack?: string;
  at: number;
}

/**
 * Fold one observed error into a plugin's record. Returns a NEW record — the
 * caller decides whether to persist, so a burst of errors doesn't mean a burst
 * of writes to data.json.
 */
export function recordError(
  existing: PluginErrorRecord | undefined,
  observed: ObservedError
): PluginErrorRecord {
  const record: PluginErrorRecord = existing
    ? { ...existing, signatures: existing.signatures.map((s) => ({ ...s })) }
    : {
        uncaught: 0,
        logged: 0,
        firstAt: observed.at,
        lastAt: observed.at,
        signatures: [],
      };

  if (observed.kind === "console") record.logged += 1;
  else record.uncaught += 1;
  record.lastAt = observed.at;
  if (observed.at < record.firstAt) record.firstAt = observed.at;

  const key = errorSignature(observed.message, observed.stack);
  const hit = record.signatures.find((s) => s.key === key);
  if (hit) {
    hit.count += 1;
    hit.lastAt = observed.at;
  } else {
    record.signatures.push({
      key,
      kind: observed.kind,
      message: observed.message.slice(0, MAX_MESSAGE),
      stack: observed.stack?.slice(0, 2000),
      count: 1,
      firstAt: observed.at,
      lastAt: observed.at,
    });
    if (record.signatures.length > MAX_SIGNATURES_PER_PLUGIN) {
      // Drop the least recently seen, not the oldest: a bug that fired once a
      // year ago matters less than one still firing.
      record.signatures.sort((a, b) => a.lastAt - b.lastAt);
      record.signatures.shift();
    }
  }
  return record;
}

/**
 * How long we must have been watching before "no errors" means anything. A
 * plugin that has not thrown in ninety seconds is not thereby reliable.
 */
export const MIN_OBSERVATION_MS = 6 * 60 * 60 * 1000;

/**
 * Errors per day, from the uncaught count only.
 *
 * `console.error` is deliberately excluded from the score. Plenty of
 * well-behaved plugins log routine failures that way — a retried fetch, a
 * missing optional file — and penalising them for reporting honestly would
 * reward the plugins that swallow their errors silently. Logged errors are
 * still counted and shown, as context.
 */
export function errorRatePerDay(
  record: PluginErrorRecord | undefined,
  observedMs: number
): number {
  if (!record || observedMs <= 0) return 0;
  const days = Math.max(1 / 24, observedMs / 86_400_000);
  return record.uncaught / days;
}

/**
 * 0–100 reliability from the error rate. Zero uncaught errors is 100; roughly
 * one a day lands in the 70s; a plugin throwing on every keystroke bottoms out.
 */
export function reliabilityScore(ratePerDay: number): number {
  if (ratePerDay <= 0) return 100;
  const raw = 100 - 40 * Math.log10(1 + ratePerDay * 3);
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/** Total errors recorded across every plugin, for the summary tile. */
export function totalUncaught(log: Record<string, PluginErrorRecord>): number {
  return Object.values(log).reduce((sum, r) => sum + r.uncaught, 0);
}

/**
 * Forget plugins that are no longer installed, so uninstalling something also
 * clears its history rather than leaving it to accumulate in data.json forever.
 */
export function pruneErrorLog(
  log: Record<string, PluginErrorRecord>,
  installed: ReadonlySet<string>
): Record<string, PluginErrorRecord> {
  const out: Record<string, PluginErrorRecord> = {};
  for (const [id, record] of Object.entries(log)) {
    if (installed.has(id)) out[id] = record;
  }
  return out;
}
