import { requestUrl } from "obsidian";

// "Is this a known issue?"
//
// A user staring at an error message is one search away from an open thread
// where three other people have already described it and the author has already
// answered — and they almost never make that search, because copying a stack
// trace into GitHub is friction at exactly the moment they are already annoyed.
// FlowKit is holding the error, the repository, and the version. It can ask.
//
// On demand only. GitHub's search API allows about ten unauthenticated requests
// a minute, which is plenty for a button somebody presses and useless as
// something run automatically per scan.

export interface KnownIssue {
  title: string;
  url: string;
  state: "open" | "closed";
  comments: number;
  updatedAt?: number;
}

export type IssueSearchOutcome =
  | { ok: true; issues: KnownIssue[] }
  | { ok: false; reason: "rate-limited" | "error" | "no-repo" };

const TIMEOUT_MS = 10_000;

/**
 * Reduce an error message to something worth searching for.
 *
 * Paths, ids, hex and numbers are stripped: they are the parts unique to this
 * one machine, and leaving them in guarantees zero results from a search that
 * would otherwise have found the thread immediately.
 */
export function searchTerms(message: string): string {
  return message
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[A-Za-z]:\\[^\s"']+/g, " ")
    .replace(/\/[\w.-]+\/[^\s"']+/g, " ")
    .replace(/0x[0-9a-f]+/gi, " ")
    .replace(/\b\d[\w-]*\b/g, " ")
    .replace(/["'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 12)
    .join(" ");
}

interface IssuePayload {
  items?: Array<{
    title?: string;
    html_url?: string;
    state?: string;
    comments?: number;
    updated_at?: string;
  }>;
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

/**
 * Look for this error in a plugin's own issue tracker. Never throws: a failed
 * lookup is a disappointing button, not a broken plugin.
 */
export async function findKnownIssues(
  repo: string | undefined,
  message: string
): Promise<IssueSearchOutcome> {
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, reason: "no-repo" };
  const terms = searchTerms(message);
  if (!terms) return { ok: true, issues: [] };

  const query = `repo:${repo} is:issue ${terms}`;
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=5&sort=updated`;

  let res: Awaited<ReturnType<typeof requestUrl>> | null;
  try {
    res = await withTimeout(requestUrl({ url, throw: false }), TIMEOUT_MS);
  } catch (err) {
    console.error("FlowKit: issue search failed", repo, err);
    return { ok: false, reason: "error" };
  }
  if (res == null) return { ok: false, reason: "error" };
  if (res.status === 403 || res.status === 429) return { ok: false, reason: "rate-limited" };
  if (res.status !== 200) return { ok: false, reason: "error" };

  try {
    const data = res.json as IssuePayload;
    const issues: KnownIssue[] = (data.items ?? []).slice(0, 5).map((item) => {
      const updated = item.updated_at ? Date.parse(item.updated_at) : NaN;
      return {
        title: item.title ?? "(untitled)",
        url: item.html_url ?? `https://github.com/${repo}/issues`,
        state: item.state === "closed" ? "closed" : "open",
        comments: typeof item.comments === "number" ? item.comments : 0,
        updatedAt: Number.isFinite(updated) ? updated : undefined,
      };
    });
    // Open threads first: a closed issue is useful context, an open one is
    // where the user can add their own report.
    issues.sort((a, b) => Number(a.state === "closed") - Number(b.state === "closed"));
    return { ok: true, issues };
  } catch (err) {
    console.error("FlowKit: could not read the issue search payload", repo, err);
    return { ok: false, reason: "error" };
  }
}
