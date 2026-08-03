import { requestUrl } from "obsidian";

// Is this plugin finished, or is it dead?
//
// The community stats file records releases and nothing else, so a plugin whose
// author has been fixing bugs on `main` for six months without cutting a tag is
// indistinguishable from one whose author walked away in 2021. The stability
// carve-out papers over that with a maturity heuristic — many releases, users on
// the newest — which is a fair guess and no more than a guess.
//
// The repository knows. `pushed_at` says when code last moved, `archived` says
// the author has formally stopped, and the open-issue count is context for both.
// This is the one place FlowKit talks to an API rather than downloading a public
// file, so it is off by default, budgeted per scan, and cached for a week.

/** What one repository says about itself. */
export interface RepoActivity {
  /** When FlowKit last asked. */
  at: number;
  /** Last push to the default branch, epoch ms. */
  pushedAt?: number;
  openIssues?: number;
  archived?: boolean;
  stars?: number;
  /**
   * Set when the lookup failed. Cached like a success so a 404 (repo renamed or
   * deleted) isn't re-requested every scan for the rest of the week — and a
   * deleted repository is itself a finding.
   */
  failed?: "missing" | "error";
}

export type RepoActivityMap = Record<string, RepoActivity>;

/** How long a repository reading is served before FlowKit asks again. */
export const REPO_TTL_MS = 7 * 86_400_000;

/**
 * How many repositories one scan may look up. GitHub allows 60 unauthenticated
 * requests an hour per IP for the whole machine, not per plugin, so this stays
 * deliberately small: the lookups that matter are for the handful of plugins
 * whose maintenance verdict is actually in doubt, and a week of caching means
 * even a large vault fills in within a few sessions.
 */
export const REPO_BUDGET_PER_SCAN = 6;

/** Give up on a wedged request rather than holding the scan open. */
const TIMEOUT_MS = 10_000;

/** Repositories only move on the scale of days; a stale reading is fine. */
export function isStale(entry: RepoActivity | undefined, now: number): boolean {
  return !entry || now - entry.at > REPO_TTL_MS;
}

/**
 * Which plugins are worth a lookup, most doubtful first.
 *
 * Deliberately not "everything with a repo". A plugin released last month is
 * not in doubt, and spending the request budget on it would starve the ones
 * where the answer changes what the user is told.
 */
export function selectForLookup(
  rows: Array<{ id: string; repo?: string; inDoubt: boolean; enabled: boolean }>,
  cache: RepoActivityMap,
  now: number,
  budget = REPO_BUDGET_PER_SCAN
): string[] {
  return rows
    .filter((r) => r.repo && r.inDoubt && isStale(cache[r.id], now))
    // Enabled plugins first: a disabled one isn't affecting anything today.
    .sort((a, b) => Number(b.enabled) - Number(a.enabled))
    .slice(0, budget)
    .map((r) => r.id);
}

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

/** The shape we read out of GitHub's repository payload. */
interface RepoPayload {
  pushed_at?: string;
  open_issues_count?: number;
  archived?: boolean;
  stargazers_count?: number;
}

/**
 * Ask GitHub about one repository. Never throws: every failure becomes a cached
 * `failed` reading, because a scan must not be able to fail because a plugin's
 * repository was renamed.
 */
export async function fetchRepoActivity(
  repo: string,
  now: number
): Promise<RepoActivity> {
  // `owner/name`, nothing else. The value comes from a downloaded community
  // file, so it is not to be interpolated into a URL unchecked.
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { at: now, failed: "missing" };
  const url = `https://api.github.com/repos/${repo}`;
  let res: Awaited<ReturnType<typeof requestUrl>> | null;
  try {
    res = await withTimeout(requestUrl({ url, throw: false }), TIMEOUT_MS);
  } catch (err) {
    console.error("FlowKit: repository lookup failed", repo, err);
    return { at: now, failed: "error" };
  }
  if (res == null) return { at: now, failed: "error" };
  if (res.status === 404) return { at: now, failed: "missing" };
  if (res.status !== 200) return { at: now, failed: "error" };

  try {
    const data = res.json as RepoPayload;
    const pushed = data.pushed_at ? Date.parse(data.pushed_at) : NaN;
    return {
      at: now,
      pushedAt: Number.isFinite(pushed) ? pushed : undefined,
      openIssues: typeof data.open_issues_count === "number" ? data.open_issues_count : undefined,
      archived: data.archived === true,
      stars: typeof data.stargazers_count === "number" ? data.stargazers_count : undefined,
    };
  } catch (err) {
    console.error("FlowKit: could not read the repository payload", repo, err);
    return { at: now, failed: "error" };
  }
}

/** Forget repositories for plugins that are no longer installed. */
export function pruneRepoActivity(
  cache: RepoActivityMap,
  installed: ReadonlySet<string>
): RepoActivityMap {
  const out: RepoActivityMap = {};
  for (const [id, entry] of Object.entries(cache)) {
    if (installed.has(id)) out[id] = entry;
  }
  return out;
}
