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
  | { ok: false; reason: "rate-limited" | "error" | "no-repo" | "nothing-searchable" };

const TIMEOUT_MS = 10_000;

/** What replaces anything that could name a note or a folder. */
const REDACTED = "…";

/** Characters that can appear in a name. Unicode, not `\w` — see below. */
const NAME_CHARS = "[\\p{L}\\p{N}\\p{M}_.\\-()']";

/** Regex metacharacters, escaped so a note called `C++ (2024)` matches literally. */
function escapeLiteral(value: string): string {
  return value.replace(/[-.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redact by KNOWING the vault, not by guessing what a path looks like.
 *
 * The previous version enumerated shapes — absolute paths, slash paths, a
 * closed list of extensions — and was wrong in both directions at once, which
 * is what a shape-based rule is always eventually wrong in:
 *
 *   - It LEAKED the commonest way a note is named. `Failed to open note "Alice
 *     Nguyen HIV results"` has no slash, no drive letter and no extension, so
 *     no rule touched it. Nor did `Patients\Alice Nguyen HIV results`. The
 *     Windows rule stopped at the first space, so `C:\…\Medical Records\Alice
 *     Nguyen HIV results` published everything after "Medical". And every rule
 *     used `\w`, which is ASCII — so a Japanese, Cyrillic, Greek or Hangul note
 *     title matched nothing at all.
 *   - It DESTROYED the diagnosis it exists to let people share. `Cannot find
 *     module markdown-it/lib/token` became `Cannot find module …`; `Expected
 *     1/2 but got 3/4` became `Expected …`; stack frames lost their module
 *     paths and their line structure — gutting the Pro feature that ships them.
 *
 * The question was never "does this look like a path". It is "is this one of
 * the user's own notes", and FlowKit can answer that exactly, because it can
 * enumerate the vault. So the names are matched literally, longest first, and
 * a much smaller set of shape rules is kept only for things that identify the
 * machine rather than the vault — absolute paths, URLs, and wiki links.
 *
 * @param names every file and folder name in the vault: basenames with and
 *   without extension, and full paths. Longest first so
 *   "Alice Nguyen HIV results" is replaced before "results".
 */
export function buildRedactor(
  names: Iterable<string>
): (text: string) => string {
  const patterns = [...new Set(names)]
    .map((name) => name.trim())
    // A single short token is too collision-prone to redact on sight — a note
    // called "and" would gut every message in the vault. Names containing a
    // space are inherently specific, so they are matched at any length.
    .filter((name) => name.length >= 4 || /\s/.test(name))
    .sort((a, b) => b.length - a.length)
    .map((name) => new RegExp(escapeLiteral(name), "giu"));

  return (text: string): string => {
    let out = text;
    for (const pattern of patterns) out = out.replace(pattern, REDACTED);
    return redactMachinePaths(out);
  };
}

/**
 * The rules that survive the rewrite: things naming the MACHINE, not the vault.
 *
 * Deliberately few, and each anchored so it cannot run away through the
 * sentence around it. Anything that identifies the user's own content is the
 * vault-name matcher's job above.
 */
function redactMachinePaths(text: string): string {
  return (
    text
      .replace(/https?:\/\/\S+/gu, REDACTED)
      // Windows and UNC absolute paths, INCLUDING spaces inside segments —
      // stopping at the first space is what published the tail of every path
      // with a "Medical Records" in it.
      .replace(
        new RegExp(`(?:[A-Za-z]:|\\\\\\\\)[\\\\/]${NAME_CHARS}*(?:[\\\\/ ]${NAME_CHARS}+)*`, "gu"),
        REDACTED
      )
      // POSIX absolute paths, likewise allowing spaces — and anchored to the
      // START of a path. Unanchored, the leading `/` matched the one inside
      // `markdown-it/lib/token` and `1/2`, so a module path and a fraction were
      // redacted as though they were somebody's filesystem.
      .replace(
        new RegExp(`(?:^|(?<=[\\s"'(\\[]))~?/${NAME_CHARS}+(?:[/ ]${NAME_CHARS}+)*`, "gu"),
        REDACTED
      )
      // Wiki links: the target is the entire payload.
      .replace(/\[\[[^\]]*\]\]/gu, REDACTED)
      // Email addresses.
      .replace(new RegExp(`${NAME_CHARS}+@${NAME_CHARS}+\\.${NAME_CHARS}+`, "gu"), REDACTED)
      .trim()
  );
}

/**
 * Redaction with no vault to consult.
 *
 * The machine-path rules only. Used where the vault genuinely isn't reachable;
 * every real call site passes the names.
 */
export function redactUserContent(text: string): string {
  return redactMachinePaths(text);
}

/**
 * Reduce an error message to something worth searching for.
 *
 * Everything that could name the user's own notes is redacted first; what is
 * left is stripped of the parts unique to this one machine (hex, ids, numbers),
 * because leaving those in guarantees zero results from a search that would
 * otherwise have found the thread immediately.
 */
export function searchTerms(
  message: string,
  redact: (text: string) => string = redactUserContent
): string {
  return redact(message)
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
  message: string,
  redact: (text: string) => string = redactUserContent
): Promise<IssueSearchOutcome> {
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, reason: "no-repo" };
  const terms = searchTerms(message, redact);
  // Distinct from "searched and found none". Returning an empty success made
  // the UI say "Nothing matching in their tracker" about a search that was
  // never run, which is a statement about the plugin's issue tracker that
  // FlowKit had no basis for.
  if (!terms) return { ok: false, reason: "nothing-searchable" };

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
