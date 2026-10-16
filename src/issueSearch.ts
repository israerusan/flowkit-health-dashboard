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

import { isRepoSlug } from "./repoActivity";

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

/**
 * Regex metacharacters, escaped so a note called `C++ (2024)` matches literally.
 *
 * A hyphen is escaped as `\x2d` rather than `\-`, and that is not a style
 * choice. These patterns carry the `u` flag — they have to, for `\p{L}` to mean
 * anything — and under `u` the only legal identity escapes are the syntax
 * characters. `\-` is not one of them, so `new RegExp("my\\-note", "u")` is a
 * SyntaxError, and this function was producing exactly that.
 *
 * The consequence was total rather than partial. `buildRedactor` compiles every
 * vault name up front, so ONE hyphenated file or folder anywhere in the vault
 * threw before a single pattern was built — and a hyphen is the commonest
 * character in a note filename there is (`2026-10-16.md` is what Obsidian's own
 * daily-note plugin produces by default). Both callers construct the redactor
 * as their first act, so "Is this a known issue?" stuck on "Looking…" forever
 * and "Copy bug report" did nothing at all, silently, on very nearly every real
 * vault. Neither leaked anything — the throw happens before any text is
 * assembled — but the two features were dead.
 *
 * `\x2d` is legal under `u`, means the literal hyphen, and stays safe if this
 * ever ends up inside a character class.
 */
function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "\\x2d");
}

/**
 * How many names go into one compiled alternation.
 *
 * The names were compiled one regex per name and applied with one `replace`
 * per name, so redacting a single string cost a full pass over it for every
 * file in the vault. Measured on a 30,000-name vault and one 1.9 KB stack
 * trace: 67 ms per string, where this scan is 21 ms. `copyBugReport` redacts up
 * to ten strings, so the button froze Obsidian for the better part of a second
 * on a vault that size — longer on a bigger one, since the old cost was
 * names × text.
 *
 * Chunked rather than one giant pattern only so that a pathological vault
 * cannot hit an engine limit on pattern size; the size itself makes almost no
 * difference to the time.
 */
const REDACT_CHUNK = 1024;

/**
 * …and the most characters, which is the limit that actually binds.
 *
 * A count alone is not a bound on pattern size: 1,024 names averaging 40
 * characters is a 40 KB pattern, and 1,024 deep paths in a vault with long
 * folder names is several times that. No engine limit was reached in testing
 * and none may exist in practice — but this function compiles the patterns up
 * front, so a throw here does not degrade the feature, it kills it, exactly as
 * the hyphen escape did. A byte budget costs one extra chunk and removes the
 * question. Chunk size makes almost no difference to the time.
 */
const REDACT_CHUNK_CHARS = 32_000;

/**
 * Cut a length-sorted name list into chunks small enough to compile, by both
 * count and total characters. A single name longer than the budget still gets
 * its own chunk rather than being dropped — nothing here may silently stop
 * redacting something.
 */
function chunkNames(names: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const name of names) {
    // +1 for the `|` that will join it.
    const cost = name.length + 1;
    if (current.length && (current.length >= REDACT_CHUNK || chars + cost > REDACT_CHUNK_CHARS)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(name);
    chars += cost;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * Shortest name redacted on sight, anywhere it appears.
 *
 * Below this a name is only redacted inside quotes — see `buildRedactor`.
 */
const SAFE_NAME_LENGTH = 4;

/** The quote characters an error message puts around a note's name. */
const QUOTE = `["'\`“”‘’]`;

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
  const trimmed = [...new Set(names)].map((name) => name.trim()).filter(Boolean);
  // A single short token is too collision-prone to redact on sight — a note
  // called "and", or a folder called "lib", would gut every message in the
  // vault and take `markdown-it/lib/token` with it. Names containing a space
  // are inherently specific, so they are matched at any length.
  const wanted = trimmed
    .filter((name) => name.length >= SAFE_NAME_LENGTH || /\s/.test(name))
    .sort((a, b) => b.length - a.length);

  // …but a short name is unambiguous when it is QUOTED, and that is exactly how
  // an error message names a note: `Failed to open note "HIV"`. A vault with
  // `HIV.md` in it supplies "HIV.md" and the path, both long enough to match —
  // and "HIV", which the filter above drops, so the one spelling that actually
  // appeared in the message was the one published. In a note-taking app a
  // three-letter title can be the most sensitive string in the vault.
  //
  // Quoted-only is what keeps this from undoing the filter: a path segment or a
  // bare word in prose is left alone, so module paths and ordinary error text
  // survive as before, and the cost is occasionally blanking a quoted
  // three-letter property name that happens to share a note's title. Blanking
  // `reading 'src'` is a far smaller harm than publishing a diagnosis.
  const shortNames = trimmed
    .filter((name) => name.length >= 2 && name.length < SAFE_NAME_LENGTH && !/\s/.test(name))
    .sort((a, b) => b.length - a.length);

  // Each chunk becomes one alternation inside a LOOKAHEAD, which is what makes
  // this both fast and no weaker than the per-name version it replaces.
  //
  // A plain alternation would be fast and subtly weaker. `(?:short|longer)`
  // consumes what it matches, so once a short name matches at position 8 the
  // scan resumes past it — and a longer name starting at position 16, inside
  // what the short one swallowed, is never looked for. With a vault containing
  // the folder "Project Alice" and the note "Alice Nguyen HIV results", the
  // message "Failed: Project Alice Nguyen HIV results" came out as
  // "Failed: … Nguyen HIV results": the folder redacted, the note published.
  // The per-name loop got that right by accident of running the longest name
  // first over the whole string.
  //
  // A zero-width lookahead consumes nothing, so the scan asks every position
  // "what is the longest name starting HERE?" and collects the answers. The
  // overlaps are then resolved explicitly below, longest wins — which is the
  // rule the old loop implemented by construction, now stated rather than
  // emergent.
  const patterns: RegExp[] = [];
  for (const chunk of chunkNames(wanted)) {
    patterns.push(new RegExp(`(?=(${chunk.map(escapeLiteral).join("|")}))`, "giu"));
  }
  // The short names, each required to sit between a pair of quotes. The
  // capture is the name alone, so the quotes survive and `"HIV"` becomes `"…"`.
  for (const chunk of chunkNames(shortNames)) {
    patterns.push(
      new RegExp(`(?<=${QUOTE})(?=(${chunk.map(escapeLiteral).join("|")})${QUOTE})`, "giu")
    );
  }

  return (text: string): string => {
    /** [start, end) of one name found in the text. */
    const found: Array<[number, number]> = [];
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const hit = match[1];
        if (match.index == null || !hit) continue;
        found.push([match.index, match.index + hit.length]);
      }
    }
    if (!found.length) return redactMachinePaths(text);

    // Longest first, leftmost to break ties; keep a span only if nothing
    // already kept overlaps it. The list is short — it is the number of names
    // appearing in one error message, not the number in the vault — so the
    // quadratic check costs nothing worth avoiding.
    const length = ([start, end]: [number, number]): number => end - start;
    found.sort((a, b) => length(b) - length(a) || a[0] - b[0]);
    const kept: Array<[number, number]> = [];
    for (const span of found) {
      if (kept.some(([start, end]) => span[0] < end && start < span[1])) continue;
      kept.push(span);
    }
    kept.sort((a, b) => a[0] - b[0]);

    let out = "";
    let at = 0;
    for (const [start, end] of kept) {
      out += text.slice(at, start) + REDACTED;
      at = end;
    }
    return redactMachinePaths(out + text.slice(at));
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
  if (!isRepoSlug(repo)) return { ok: false, reason: "no-repo" };
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
