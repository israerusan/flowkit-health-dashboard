import { requestUrl } from "obsidian";
import type { CommunityList, CommunityListEntry, RemoteStats } from "./types";

// Obsidian's own public data, from two hosts serving byte-identical content.
//
// raw.githubusercontent.com is the canonical source but rate-limits
// unauthenticated clients per IP and answers 403 when it trips — and these two
// files are ~1.8 MB each, so a few scans in quick succession is enough to hit
// it. jsDelivr mirrors the same repo from a CDN built for exactly this, so it
// is tried whenever GitHub refuses.
const SOURCES: Array<{ host: string; stats: string; list: string }> = [
  {
    host: "GitHub",
    stats:
      "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json",
    list: "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json",
  },
  {
    host: "jsDelivr",
    stats:
      "https://cdn.jsdelivr.net/gh/obsidianmd/obsidian-releases@master/community-plugin-stats.json",
    list: "https://cdn.jsdelivr.net/gh/obsidianmd/obsidian-releases@master/community-plugins.json",
  },
];

/** Give up on a wedged request rather than leaving the view spinning forever. */
const FETCH_TIMEOUT_MS = 15_000;

/** How long to stop trying after being rate-limited, so we don't make it worse. */
const RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Set when a host rate-limits us. Hammering a limiter is how a temporary block
 * becomes a longer one, and the persisted cache means there is almost always
 * something to show in the meantime.
 */
let cooldownUntil = 0;

/**
 * Why a fetch failed, so the UI can say something truer than "Offline". A
 * blocked corporate proxy, a rate limit, a GitHub outage, and a malformed
 * payload all need different words — and only some are worth retrying.
 */
export type FetchFailure =
  | "http"
  | "rate-limited"
  | "network"
  | "parse"
  | "timeout"
  | "cooling-down";

export type FetchOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; reason: FetchFailure; status?: number };

/** Treat as "the server is refusing us for now", not "the data is wrong". */
function isRateLimit(status: number): boolean {
  return status === 403 || status === 429;
}

/** Resolve `null` if `promise` hasn't settled within `ms`, clearing the timer either way. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = window.setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

/** Fetch and parse one JSON document from one host, classifying every failure. */
async function fetchOnce<T>(url: string): Promise<FetchOutcome<T>> {
  let res: Awaited<ReturnType<typeof requestUrl>> | null;
  try {
    res = await withTimeout(requestUrl({ url, throw: false }), FETCH_TIMEOUT_MS);
  } catch (err) {
    console.error("FlowKit: request failed", url, err);
    return { ok: false, reason: "network" };
  }
  if (res == null) {
    console.error("FlowKit: request timed out", url);
    return { ok: false, reason: "timeout" };
  }
  if (isRateLimit(res.status)) {
    console.error("FlowKit: rate-limited", url, res.status);
    return { ok: false, reason: "rate-limited", status: res.status };
  }
  if (res.status !== 200) {
    console.error("FlowKit: unexpected status", url, res.status);
    return { ok: false, reason: "http", status: res.status };
  }
  try {
    return { ok: true, data: res.json as T };
  } catch (err) {
    console.error("FlowKit: could not parse response", url, err);
    return { ok: false, reason: "parse" };
  }
}

/**
 * Try each mirror in turn. A rate limit or an outage on one host is not a
 * reason to give up on data that is served identically somewhere else.
 */
async function fetchMirrored<T>(pick: (s: (typeof SOURCES)[number]) => string): Promise<FetchOutcome<T>> {
  if (Date.now() < cooldownUntil) {
    return { ok: false, reason: "cooling-down" };
  }
  let last: FetchOutcome<T> = { ok: false, reason: "network" };
  for (const source of SOURCES) {
    const res = await fetchOnce<T>(pick(source));
    if (res.ok) return res;
    last = res;
    // A parse failure means we reached the host and the payload was wrong;
    // another mirror of the same file won't be different.
    if (res.reason === "parse") break;
  }
  if (!last.ok && last.reason === "rate-limited") {
    cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
  }
  return last;
}

/** Community download counts + last-updated timestamps, keyed by plugin id. */
export function fetchRemoteStats(): Promise<FetchOutcome<RemoteStats>> {
  return fetchMirrored<RemoteStats>((s) => s.stats);
}

/** The community-plugins list, reshaped into a map keyed by plugin id. */
export async function fetchCommunityList(): Promise<FetchOutcome<CommunityList>> {
  const res = await fetchMirrored<CommunityListEntry[]>((s) => s.list);
  if (!res.ok) return res;
  if (!Array.isArray(res.data)) return { ok: false, reason: "parse" };
  const map: CommunityList = {};
  for (const entry of res.data) map[entry.id] = entry;
  return { ok: true, data: map };
}

/** Clear the rate-limit cooldown, for an explicit user-initiated retry. */
export function clearCooldown(): void {
  cooldownUntil = 0;
}

/** One-line, human-facing reason a fetch failed. */
export function describeFailure(reason: FetchFailure, status?: number): string {
  switch (reason) {
    case "timeout":
      return "The community data servers didn't respond in time.";
    case "rate-limited":
      return "GitHub and the backup mirror are both rate-limiting this connection right now.";
    case "cooling-down":
      return "Waiting for a rate limit to clear before trying again.";
    case "http":
      return `The community data servers returned an unexpected response${status ? ` (${status})` : ""}.`;
    case "parse":
      return "The community data couldn't be read.";
    default:
      return "Couldn't reach the community data servers.";
  }
}
