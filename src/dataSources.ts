import { requestUrl } from "obsidian";
import type { CommunityList, CommunityListEntry, RemoteStats } from "./types";

// Obsidian's own public data. `requestUrl` bypasses CORS, so these load fine
// from inside a plugin. Both are optional: if we're offline the dashboard
// still works with local-only metrics.
const STATS_URL =
  "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json";
const LIST_URL =
  "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json";

/** Give up on a wedged request rather than leaving the view spinning forever. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Why a fetch failed, so the UI can say something truer than "Offline". A
 * blocked corporate proxy, a GitHub outage, and a malformed payload all need
 * different words — and only `network` is worth suggesting a retry for.
 */
export type FetchFailure = "http" | "network" | "parse" | "timeout";

export type FetchOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; reason: FetchFailure; status?: number };

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

/** Fetch and parse one JSON document, classifying every failure mode. */
async function fetchJson<T>(url: string): Promise<FetchOutcome<T>> {
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

/** Community download counts + last-updated timestamps, keyed by plugin id. */
export function fetchRemoteStats(): Promise<FetchOutcome<RemoteStats>> {
  return fetchJson<RemoteStats>(STATS_URL);
}

/** The community-plugins list, reshaped into a map keyed by plugin id. */
export async function fetchCommunityList(): Promise<FetchOutcome<CommunityList>> {
  const res = await fetchJson<CommunityListEntry[]>(LIST_URL);
  if (!res.ok) return res;
  if (!Array.isArray(res.data)) return { ok: false, reason: "parse" };
  const map: CommunityList = {};
  for (const entry of res.data) map[entry.id] = entry;
  return { ok: true, data: map };
}

/** One-line, human-facing reason a fetch failed. */
export function describeFailure(reason: FetchFailure, status?: number): string {
  switch (reason) {
    case "timeout":
      return "GitHub didn't respond in time.";
    case "http":
      return `GitHub returned an unexpected response${status ? ` (${status})` : ""}.`;
    case "parse":
      return "GitHub's community data couldn't be read.";
    default:
      return "Couldn't reach GitHub.";
  }
}
