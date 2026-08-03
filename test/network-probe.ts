// Checks the two remote APIs FlowKit depends on still answer the way it expects.
//
// Deliberately NOT part of `npm test`: it needs the network, it is rate-limited,
// and it fails on a train. Run it by hand (`npm run probe:network`) before a
// release, or when something that reads GitHub starts behaving oddly.
//
// The unit tests cover our logic; this covers the assumption underneath it —
// that `pushed_at`, `archived` and the issue-search payload still exist and
// still mean what the code thinks. That is the one failure mode no amount of
// local testing can see, and it happens without warning.

import { fetchRepoActivity, isStale, REPO_TTL_MS } from "../src/repoActivity";
import { findKnownIssues, searchTerms } from "../src/issueSearch";
import { repoVerdict } from "../src/scoring";

// Both modules guard their requests with a `window.setTimeout` race. Obsidian
// always has a window; Node does not, so supply one before anything is called.
// (Module bodies run after imports are evaluated, and neither module touches
// `window` until one of its functions is invoked.)
(globalThis as unknown as { window: unknown }).window = {
  setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
  clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

let checks = 0;
const problems: string[] = [];

function ok(name: string, cond: boolean, detail = ""): void {
  checks++;
  if (cond) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    problems.push(name);
  }
}

const NOW = Date.now();

console.log("\nRepository activity — the signal that separates finished from abandoned");

{
  // A large, unambiguously active repository.
  const active = await fetchRepoActivity("blacksmithgu/obsidian-dataview", NOW);
  ok("an active repo answers", active.failed == null, JSON.stringify(active.failed ?? "ok"));
  ok(
    "pushed_at parses to a sane timestamp",
    active.pushedAt != null && active.pushedAt > 0 && active.pushedAt <= NOW + 86_400_000,
    active.pushedAt ? new Date(active.pushedAt).toISOString().slice(0, 10) : "missing"
  );
  ok("open issue count is present", typeof active.openIssues === "number", String(active.openIssues));
  ok("archived is a boolean", typeof active.archived === "boolean", String(active.archived));
  ok("a fresh reading is not stale", !isStale(active, NOW));
  ok(
    "and goes stale after the TTL",
    isStale(active, NOW + REPO_TTL_MS + 1000),
    `${REPO_TTL_MS / 86_400_000} days`
  );
  console.log(`    verdict: ${String(repoVerdict(active, NOW))}`);
}

{
  // A repository that does not exist must be a cached, non-throwing failure —
  // a deleted repo is itself a finding, not an error.
  const missing = await fetchRepoActivity("obsidianmd/definitely-not-a-real-repo-xyz", NOW);
  ok("a deleted repo reports missing", missing.failed === "missing", String(missing.failed));
  ok("and reads as 'gone'", repoVerdict(missing, NOW) === "gone");
}

{
  // Never interpolate an unvalidated repo string into a URL.
  const bogus = await fetchRepoActivity("../../etc/passwd", NOW);
  ok("a malformed repo name is rejected without a request", bogus.failed === "missing");
}

console.log("\nIssue search — 'is this a known issue?'");

{
  const terms = searchTerms(
    "Cannot read properties of undefined (reading 'path') at C:\\Users\\me\\.obsidian\\plugins\\x\\main.js:1042:9"
  );
  console.log(`    query terms: ${terms}`);
  ok("machine-specific noise is stripped", !/Users|1042|main\.js/.test(terms), terms);

  const found = await findKnownIssues("blacksmithgu/obsidian-dataview", "Cannot read properties of undefined");
  if (!found.ok) {
    ok(
      "search answered",
      found.reason === "rate-limited",
      `failed: ${found.reason}${found.reason === "rate-limited" ? " (expected when run repeatedly)" : ""}`
    );
  } else {
    ok("search answered", true, `${found.issues.length} issue(s)`);
    ok(
      "every result has a title and a usable url",
      found.issues.every((i) => i.title.length > 0 && /^https:\/\/github\.com\//.test(i.url))
    );
    ok(
      "state is normalised to open/closed",
      found.issues.every((i) => i.state === "open" || i.state === "closed")
    );
    ok(
      "open issues sort ahead of closed ones",
      found.issues.map((i) => (i.state === "closed" ? 1 : 0)).every((v, idx, arr) => idx === 0 || arr[idx - 1] <= v)
    );
    for (const issue of found.issues.slice(0, 3)) {
      console.log(`    [${issue.state}] ${issue.title.slice(0, 70)} (${issue.comments} comments)`);
    }
  }

  const noRepo = await findKnownIssues(undefined, "anything");
  ok("a plugin with no repository is handled", !noRepo.ok && noRepo.reason === "no-repo");

  const empty = await findKnownIssues("blacksmithgu/obsidian-dataview", "   ");
  ok("an empty message searches for nothing", empty.ok && empty.issues.length === 0);
}

console.log(
  problems.length
    ? `\n✗ ${problems.length} of ${checks} probes failed: ${problems.join(", ")}\n`
    : `\n✓ all ${checks} network probes passed\n`
);
process.exit(problems.length ? 1 : 0);
