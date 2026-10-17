// The dashboard's pure modules: wording and grade bands (format), the summary
// and the rows behind each tile (derive), and the reports that leave the vault
// (report). The report half is a security control — a sideloaded manifest is
// attacker-controlled text — and had no test before.
import { band, describeFailed, describeWatched, describeWhen, gradeFor, FORMULA_LEAD } from "../src/dashboard/format";
import { canGrade, computeSummaryStats, matchesFilter, visibleRows, type RowQuery } from "../src/dashboard/derive";
import { buildReportCsv, buildReportMarkdown, escapeMarkdown, flagText, type ReportInput } from "../src/dashboard/report";
import type { MetricScore, PluginHealth } from "../src/types";

let passed = 0;
function eq<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`dashboard: ${label}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`);
  }
  passed++;
}
function ok(cond: unknown, label: string): void {
  if (!cond) throw new Error(`dashboard: ${label}`);
  passed++;
}

const metric = (value: number | null): MetricScore => ({ value, source: "measured", detail: "" });
function row(over: Partial<PluginHealth> & { id: string }): PluginHealth {
  return {
    name: over.id,
    author: "someone",
    version: "1.0.0",
    enabled: true,
    maintenanceStatus: "maintained",
    updateAvailable: false,
    listing: "listed",
    muted: false,
    watched: false,
    overall: 90,
    confidence: 1,
    metrics: {
      hygiene: metric(100),
      maintenance: metric(100),
      footprint: metric(100),
      popularity: metric(50),
      compatibility: metric(100),
      reliability: metric(100),
    },
    ...over,
  } as PluginHealth;
}

// ---- format: grade bands and wording ---------------------------------------
for (const [avg, letter] of [
  [100, "A"], [90, "A"], [89, "B"], [80, "B"], [79, "C"], [70, "C"], [69, "D"], [60, "D"], [59, "F"], [0, "F"],
] as const) {
  eq(gradeFor(avg).letter, letter, `grade for ${avg}`);
}
eq(gradeFor(null).letter, "—", "no average, no letter");
eq([band(80), band(79), band(50), band(49), band(null)], ["good", "warn", "warn", "bad", "unknown"], "score bands");

const now = Date.now();
eq(describeWhen(now - 10 * 60_000), "just now", "under an hour is just now");
eq(describeWhen(now - 2 * 3_600_000), "2 hours ago", "hours");
eq(describeWhen(now - 30 * 3_600_000), "yesterday", "one day back");
eq(describeWhen(now - 3 * 86_400_000), "3 days ago", "days");
eq(describeWhen(now - 10 * 86_400_000), new Date(now - 10 * 86_400_000).toLocaleDateString(), "a week or more is a date");
eq(describeWatched(20 * 60_000), "1 hour", "watching under an hour rounds up to one");
eq(describeWatched(5 * 3_600_000), "5 hours", "watching hours");
eq(describeWatched(86_400_000), "1 day", "watching one day");
ok(describeFailed([{ id: "a", error: null }]).startsWith("a wouldn't switch — change it"), "one failure named, singular");
ok(describeFailed([{ id: "a", error: null }, { id: "b", error: null }]).includes("change them"), "several failures, plural");

// ---- derive: the summary, and the rows behind each tile --------------------
const vault = [
  row({ id: "ok" }),
  row({ id: "stale", maintenanceStatus: "unmaintained", overall: 60 }),
  row({ id: "update", updateAvailable: true, overall: 80 }),
  row({ id: "broken", overall: 20, metrics: { ...row({ id: "x" }).metrics, compatibility: metric(0) } }),
  row({ id: "off", enabled: false, overall: null, confidence: 0.5 }),
  row({ id: "hushed", muted: true, maintenanceStatus: "unmaintained", updateAvailable: true, overall: 10 }),
];
const stats = computeSummaryStats(vault);
eq(stats.count, 5, "muted plugins are not counted");
eq(stats.avg, Math.round((90 + 60 + 80 + 20) / 4), "the average skips muted and unscored rows");
eq(stats.atRisk, 1, "at risk: below 50, muted excluded");
eq(stats.confidence, (1 + 1 + 1 + 1 + 0.5) / 5, "confidence is the mean over counted rows");

// Every tile's number is the number of rows its filter shows.
const show = (filter: RowQuery["filter"]) =>
  visibleRows(vault, { search: "", filter, scope: null, sortKey: "overall", sortDir: 1 }).map((r) => r.id);
eq(show("update").length, stats.updates, "the Updates tile matches its filter");
eq(show("unmaintained").length, stats.unmaintained, "the No recent release tile matches its filter");
eq(show("muted"), ["hushed"], "the muted filter shows muted rows");
ok(!show("attention").includes("hushed"), "a muted row is in no other cohort");
eq(show("heavy").includes("off"), false, "the heaviest-to-run view shows only running plugins");
eq(show("disabled"), ["off"], "the disabled filter");
ok(matchesFilter(vault[5], "all"), "a muted row is still in All");

eq(show("all"), ["hushed", "broken", "stale", "update", "ok", "off"], "worst first; unscored last");
eq(
  visibleRows(vault, { search: "", filter: "all", scope: null, sortKey: "overall", sortDir: -1 }).at(-1)?.id,
  "off",
  "unscored rows stay last when the order flips"
);
eq(
  visibleRows(vault, { search: "STA", filter: "all", scope: null, sortKey: "name", sortDir: 1 }).map((r) => r.id),
  ["stale"],
  "search is case-insensitive over name, author and id"
);
eq(
  visibleRows(vault, { search: "", filter: "disabled", scope: { match: (r) => r.id === "ok" }, sortKey: "name", sortDir: 1 }).map((r) => r.id),
  ["ok"],
  "a finding's scope replaces the filter"
);

ok(canGrade({ ...stats, confidence: 0.61 }, true), "graded above the confidence line with stats");
ok(!canGrade({ ...stats, confidence: 0.6 }, true), "not graded at the line");
ok(!canGrade({ ...stats, confidence: 0.95 }, false), "never graded without community stats");

// ---- report: Markdown and CSV that leave the vault -------------------------
const beacon = "![](https://evil.example/p.png)";
const escaped = escapeMarkdown(beacon);
ok(!/(^|[^\\])!\[/.test(escaped), "a manifest name can't become an image embed");
eq(escapeMarkdown("a|b"), "a\\|b", "pipes can't split the table");
eq(escapeMarkdown("<img src=x>"), "\\<img src=x\\>", "raw HTML is escaped");
eq(escapeMarkdown("line\nbreak"), "line break", "a newline can't start a new table row");
eq(escapeMarkdown("[[Note]]"), "\\[\\[Note\\]\\]", "a wikilink can't become a link or embed");

const csvRows = [
  row({ id: "f1", name: "=HYPERLINK(\"x\")" }),
  row({ id: "f2", name: "+1", author: "@me", version: "-2" }),
  row({ id: "f3", name: "Plain \"quoted\" name" }),
];
const csv = buildReportCsv(csvRows).split("\n");
ok(csv[0].startsWith("\"Plugin\",\"Id\""), "a header row first");
ok(csv[1].startsWith("\"'=HYPERLINK(\"\"x\"\")\""), "a leading = is defanged and quotes are doubled");
ok(csv[2].startsWith("\"'+1\",\"f2\",\"'@me\",\"'-2\""), "leading + @ - are defanged in every field");
ok(csv[3].startsWith("\"Plain \"\"quoted\"\" name\""), "an ordinary name is quoted, not defanged");
for (const lead of ["=", "+", "-", "@", "\t", "\r"]) ok(FORMULA_LEAD.test(`${lead}x`), `formula lead ${JSON.stringify(lead)}`);

const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  rows: [row({ id: "p1", name: "Evil | ![](https://x/y.png)" })],
  stats: { ...stats, avg: 84 },
  graded: true,
  grade: { letter: "B", verdict: "Healthy overall, with a couple of things to watch." },
  online: true,
  scope: "",
  search: "",
  insights: [{ title: "2 plugins have no recent release", detail: "Consider ![x](y)" }],
  isPro: false,
  generatedAt: new Date(0),
  ...over,
});
const report = buildReportMarkdown(input());
ok(report.includes("**Vault health: 84/100 (Grade B)**"), "a graded report prints the letter");
ok(buildReportMarkdown(input({ graded: false })).includes("84/100 — ungraded.**"), "an ungraded report says so");
ok(!/(^|[^\\])!\[/m.test(report), "no unescaped embed anywhere in the report");
ok(report.includes("| Evil \\| \\!\\[\\](https://x/y.png) |"), "the plugin name is escaped in its table cell");
ok(!report.includes("Filtered view"), "an unfiltered report claims no filter");
ok(
  buildReportMarkdown(input({ scope: "No recent release", search: "cal" })).includes(
    "Filtered view: No recent release, matching “cal”."
  ),
  "a scoped, searched report says both"
);
ok(buildReportMarkdown(input({ scope: "2 plugins can't load" })).includes("Filtered view: 2 plugins can't load."), "a finding scope is named");
ok(report.includes("The diagnosis above is free."), "free footer");
ok(buildReportMarkdown(input({ isPro: true })).includes("Generated by FlowKit"), "pro footer");

eq(flagText(row({ id: "z", maintenanceStatus: "unmaintained", enabled: false, watched: true })), "No recent release, Disabled, Watching", "status flags");

console.log(`✓ all ${passed} dashboard assertions passed`);
