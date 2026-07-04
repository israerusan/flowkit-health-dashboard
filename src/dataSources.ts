import { requestUrl } from "obsidian";
import type { CommunityList, CommunityListEntry, RemoteStats } from "./types";

// Obsidian's own public data. `requestUrl` bypasses CORS, so these load fine
// from inside a plugin. Both are optional: if we're offline the dashboard
// still works with local-only metrics.
const STATS_URL =
  "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json";
const LIST_URL =
  "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json";

/** Community download counts + last-updated timestamps, keyed by plugin id. */
export async function fetchRemoteStats(): Promise<RemoteStats | null> {
  try {
    const res = await requestUrl({ url: STATS_URL, throw: false });
    if (res.status !== 200) return null;
    return res.json as RemoteStats;
  } catch {
    return null;
  }
}

/** The community-plugins list, reshaped into a map keyed by plugin id. */
export async function fetchCommunityList(): Promise<CommunityList | null> {
  try {
    const res = await requestUrl({ url: LIST_URL, throw: false });
    if (res.status !== 200) return null;
    const arr = res.json as CommunityListEntry[];
    const map: CommunityList = {};
    for (const entry of arr) map[entry.id] = entry;
    return map;
  } catch {
    return null;
  }
}
