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

/** What replaces anything that could name a note or a folder. */
const REDACTED = "…";

/**
 * Remove anything from error text that could name the user's own content.
 *
 * Error messages routinely quote the file being touched, and in a note-taking
 * app the FILE NAME IS THE CONTENT: "Patients/Alice Nguyen HIV results.md" and
 * "[[Divorce settlement draft]]" are not incidental detail, they are the most
 * sensitive strings on the machine. This text goes two places that leave it —
 * a GitHub search URL, and a clipboard bug report the product tells the user to
 * paste into somebody's issue tracker — so it is redacted before either.
 *
 * The rules that were here stripped absolute paths (`/Users/x/…`, `C:\…`) and
 * stopped, which is exactly backwards for Obsidian: every path this app handles
 * is vault-RELATIVE. `Patients/Alice Nguyen HIV results.md` survived all seven
 * replaces intact.
 *
 * Deliberately aggressive. A search that misses a thread costs the user a
 * click; a search that quietly puts a note title in somebody's server log
 * cannot be undone.
 */
export function redactUserContent(text: string): string {
  return (
    text
      .replace(/https?:\/\/\S+/g, REDACTED)
      // Windows absolute paths.
      .replace(/[A-Za-z]:\\[^\s"']+/g, REDACTED)
      // Wiki links — the note title is the entire payload.
      .replace(/\[\[[^\]]*\]\]/g, REDACTED)
      // Vault-relative paths, which is what Obsidian actually deals in. The
      // segment before the first slash may not contain spaces, so this cannot
      // run backwards through the sentence the path is quoted in and swallow
      // the error text itself — the ordinary messages that make a search worth
      // running survive this rule untouched. Later segments may contain
      // spaces, because note names do.
      .replace(/[\w.\-()']+(?:\/[\w.\-()' ]*)+/g, REDACTED)
      // POSIX absolute paths, AFTER the relative rule: run first, this matches
      // from the leading slash and leaves the top folder name — "Patients" —
      // sitting in the output, which is often the sensitive part.
      .replace(/~?\/[\w.\-()' /]+/g, REDACTED)
      // A bare file name with no folder in front of it. Bounded at five
      // preceding words: a name can contain spaces and there is no way to know
      // where it starts, so this errs towards taking too much. Losing a few
      // words of an error message costs the user a search result; keeping a few
      // words of a note title cannot be taken back.
      .replace(
        /(?:[\w.\-()']+ ){0,5}[\w.\-()']*\.(?:md|canvas|base|pdf|png|jpe?g|gif|webp|mp[34]|mov|docx?|xlsx?)\b/gi,
        REDACTED
      )
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Reduce an error message to something worth searching for.
 *
 * Everything that could name the user's own notes is redacted first; what is
 * left is stripped of the parts unique to this one machine (hex, ids, numbers),
 * because leaving those in guarantees zero results from a search that would
 * otherwise have found the thread immediately.
 */
export function searchTerms(message: string): string {
  return redactUserContent(message)
    .replace(/0x[0-9a-f]+/gi, " ")
    .replace(/\b\d[\w-]*\b/g, " ")
    .replace(/["'`…]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
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
