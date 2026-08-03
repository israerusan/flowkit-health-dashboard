// Executable tests for the scoring engine. Bundled with `obsidian` aliased to a
// stub (apiVersion = "1.5.0") and run under Node — see test/run.mjs.
import type { PluginManifest } from "obsidian";
import {
  buildRemoteCache,
  classifyListing,
  compareVersion,
  computeHealth,
  deriveMaintenanceStatus,
  mergeRemoteCache,
  pickLatestVersion,
  rankerFromDistribution,
  releaseCount,
  remoteFromCache,
  type ScoreInput,
} from "../src/scoring";
import {
  attributeStack,
  errorRatePerDay,
  errorSignature,
  MIN_OBSERVATION_MS,
  pruneErrorLog,
  recordError,
  reliabilityScore,
} from "../src/errors";
import nacl from "tweetnacl";
import { verifyLicense } from "../src/shared/verifyLicense.mjs";
import { buildInsights } from "../src/insights";
import type { HealthChangeKind, PluginHealth } from "../src/types";
import { diffTrouble } from "../src/changes";
import {
  loadScore,
  pollPenalty,
  readFootprint,
  recordLoad,
  pruneProfiles,
  sizeScore,
  startupCost,
} from "../src/runtime";
import { findConflicts, printChord, type CommandRow } from "../src/conflicts";
import { buildMute, describeMute, migrateMutes, sweepMutes } from "../src/mutes";
import { rankSafeDisable } from "../src/triage";
import { isStale, selectForLookup, type RepoActivityMap } from "../src/repoActivity";
import { repoVerdict } from "../src/scoring";
import {
  beginBisect,
  bisectStep,
  desiredState,
  restoreState,
  roundsNeeded,
  searchableCandidates,
  type BisectState,
} from "../src/bisect";
import {
  correlate,
  diffInstalled,
  pruneEvents,
  type PluginEvent,
  type SeenMap,
} from "../src/timeline";
import {
  deleteProfile,
  isNoop,
  profileDelta,
  saveProfile,
  type PluginProfile,
} from "../src/profiles";
import { searchTerms } from "../src/issueSearch";
import { tickScore } from "../src/runtime";

const DAY = 86_400_000;
const NOW = 2_000_000_000_000; // fixed "now" so the tests are deterministic

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, actual === expected, `expected ${String(expected)}, got ${String(actual)}`);
}

function manifest(overrides: Partial<PluginManifest>): PluginManifest {
  return {
    id: "sample",
    name: "Sample",
    version: "1.0.0",
    minAppVersion: "1.0.0",
    description: "A sample plugin used for tests with a decent description.",
    author: "Test Author",
    ...overrides,
  } as PluginManifest;
}

function input(overrides: Partial<ScoreInput>): ScoreInput {
  return {
    manifest: manifest({}),
    enabled: true,
    isMobile: false,
    bundleBytes: 50_000, // the footprint anchor: scores exactly 100
    // Long enough that "no errors seen" is a real reading rather than a shrug.
    observedMs: MIN_OBSERVATION_MS,
    ...overrides,
  };
}

// --- compareVersion ---------------------------------------------------------
eq("compareVersion equal", compareVersion("1.0.0", "1.0.0"), 0);
eq("compareVersion less", compareVersion("1.4.0", "1.5.0"), -1);
eq("compareVersion greater", compareVersion("1.5", "1.4.9"), 1);
eq("compareVersion missing-parts-equal", compareVersion("1.4", "1.4.0"), 0);
eq("compareVersion numeric-not-lexical", compareVersion("2.0", "10.0"), -1);

// --- deriveMaintenanceStatus ------------------------------------------------
eq("status undefined", deriveMaintenanceStatus(undefined, NOW), "unknown");
eq("status recent", deriveMaintenanceStatus(NOW - 10 * DAY, NOW), "maintained");
eq("status boundary-180", deriveMaintenanceStatus(NOW - 180 * DAY, NOW), "maintained");
eq("status aging", deriveMaintenanceStatus(NOW - 200 * DAY, NOW), "aging");
eq("status boundary-540", deriveMaintenanceStatus(NOW - 540 * DAY, NOW), "aging");
eq("status abandoned", deriveMaintenanceStatus(NOW - 600 * DAY, NOW), "unmaintained");

// --- computeHealth: healthy, online -----------------------------------------
{
  const h = computeHealth(
    input({
      manifest: manifest({
        id: "dataview",
        name: "Dataview",
        author: "blacksmithgu",
        minAppVersion: "0.13.11",
      }),
      repo: "blacksmithgu/obsidian-dataview",
      remote: { downloads: 5_000_000, updated: NOW - 30 * DAY },
      downloadPercentile: 1,
      listing: "listed",
    }),
    NOW
  );
  eq("healthy compatibility", h.metrics.compatibility.value, 100);
  eq("healthy popularity", h.metrics.popularity.value, 100);
  eq("healthy maintenance", h.metrics.maintenance.value, 100);
  eq("healthy footprint", h.metrics.footprint.value, 100);
  eq("healthy hygiene", h.metrics.hygiene.value, 100);
  eq("healthy overall", h.overall, 100);
  eq("full coverage means full confidence", h.confidence, 1);
  eq("healthy status", h.maintenanceStatus, "maintained");
  eq("compatibility source measured", h.metrics.compatibility.source, "measured");
  eq("hygiene is measured, not estimated", h.metrics.hygiene.source, "measured");
}

// --- computeHealth: incompatible is gated, not averaged ---------------------
{
  const h = computeHealth(
    input({
      manifest: manifest({
        id: "old",
        name: "Old Plugin",
        minAppVersion: "1.9.0", // newer than stubbed apiVersion 1.5.0
      }),
      remote: undefined,
    }),
    NOW
  );
  eq("incompatible compatibility", h.metrics.compatibility.value, 0);
  eq("abandoned popularity null", h.metrics.popularity.value, null);
  eq("abandoned maintenance null", h.metrics.maintenance.value, null);
  eq("popularity unavailable", h.metrics.popularity.source, "unavailable");
  // A plugin that cannot load must not wear a mid-range score. Previously 72.
  check(
    "a plugin that cannot load is capped at 20",
    h.overall != null && h.overall <= 20,
    `got ${h.overall}`
  );
}

// --- computeHealth: desktop-only on mobile ----------------------------------
{
  const h = computeHealth(
    input({
      manifest: manifest({ isDesktopOnly: true, minAppVersion: "1.0.0" }),
      isMobile: true,
    }),
    NOW
  );
  eq("mobile-incompatible", h.metrics.compatibility.value, 0);
  eq("mobile-incompatible source", h.metrics.compatibility.source, "measured");
}

// --- computeHealth: disabling a plugin must not change its score ------------
{
  const base = {
    manifest: manifest({ id: "same", minAppVersion: "1.0.0" }),
    repo: "a/b",
    remote: { downloads: 100, updated: NOW - 10 * DAY },
    downloadPercentile: 0.5,
    listing: "listed" as const,
  };
  const on = computeHealth(input({ ...base, enabled: true }), NOW);
  const off = computeHealth(input({ ...base, enabled: false }), NOW);
  eq("disabled footprint is scored, not dropped", off.metrics.footprint.value, 100);
  eq("disabled footprint source", off.metrics.footprint.source, "measured");
  // The old model dropped Performance from the denominator when disabled, so
  // the same plugin scored 92 enabled and 97 disabled — turning something off
  // and watching its health improve.
  eq("denominator is stable across enabled state", on.confidence, off.confidence);
  check(
    "disabling never raises a score",
    off.overall != null && on.overall != null && off.overall <= on.overall,
    `enabled ${on.overall}, disabled ${off.overall}`
  );
}

// --- footprint is a real per-plugin signal ----------------------------------
{
  const small = computeHealth(input({ bundleBytes: 50_000 }), NOW);
  const large = computeHealth(input({ bundleBytes: 5_000_000 }), NOW);
  eq("50 KB anchors at 100", small.metrics.footprint.value, 100);
  eq("5 MB scores far lower", large.metrics.footprint.value, 20);
  check(
    "footprint actually differentiates plugins",
    small.metrics.footprint.value !== large.metrics.footprint.value,
    "the old Performance metric returned the same constant for every row"
  );
  const unknown = computeHealth(input({ bundleBytes: undefined }), NOW);
  eq("unreadable bundle is unavailable, not guessed", unknown.metrics.footprint.value, null);
}

// --- pickLatestVersion ------------------------------------------------------
eq("latest undefined", pickLatestVersion(undefined), undefined);
eq(
  "latest picks max, ignores fields",
  pickLatestVersion({ downloads: 9, updated: 1, "0.5.9": 1, "0.5.64": 2, "0.5.7": 3 }),
  "0.5.64"
);

// --- computeHealth: update available + listing ------------------------------
{
  const h = computeHealth(
    input({
      manifest: manifest({ id: "x", version: "1.2.0" }),
      listing: "listed",
      remote: { downloads: 100, updated: NOW, "1.2.0": 10, "1.3.0": 20 },
    }),
    NOW
  );
  eq("update available", h.updateAvailable, true);
  eq("latest version", h.latestVersion, "1.3.0");
  eq("in-list is listed", h.listing, "listed");
}
{
  const h = computeHealth(
    input({
      manifest: manifest({ id: "x", version: "1.3.0" }),
      listing: "local",
      remote: { downloads: 100, updated: NOW, "1.3.0": 20 },
    }),
    NOW
  );
  eq("no update when current", h.updateAvailable, false);
  eq("absent from both files is a local install", h.listing, "local");
}
{
  const h = computeHealth(input({ listing: undefined, muted: true }), NOW);
  eq("unknown listing when no list", h.listing, "unknown");
  eq("muted flag propagates", h.muted, true);
  eq("no update without remote", h.updateAvailable, false);
}

// --- the persisted projection + listing classification ----------------------
{
  const stats = {
    a: { downloads: 10, updated: NOW, "1.0.0": 8 },
    b: { downloads: 20, updated: NOW, "2.0.0": 20 },
  };
  const list = { a: { repo: "own/a" } };
  const installed = new Set(["a", "b"]);
  const cache = buildRemoteCache(stats, list, NOW, installed);

  eq("cache carries the repo from the list", cache.plugins.a.repo, "own/a");
  eq("cache records which feeds it had", cache.hadStats && cache.hadList, true);
  eq("distribution is sorted for ranking", cache.distribution.join(","), "10,20");

  eq("in list is listed", classifyListing("a", cache), "listed");
  // In the stats feed but pulled from the list: Obsidian removed it.
  eq("in stats but not list is delisted", classifyListing("b", cache), "delisted");
  eq("in neither is local", classifyListing("c", cache), "local");
  eq(
    "no list at all is unknown",
    classifyListing("a", buildRemoteCache(stats, null, NOW, installed)),
    "unknown"
  );

  // Only installed plugins are persisted — the directory has ~6,250 entries and
  // the whole settings object is rewritten on every save.
  {
    const wide = { ...stats, zzz: { downloads: 999 } };
    const slim = buildRemoteCache(wide, list, NOW, new Set(["a"]));
    eq("uninstalled plugins are not stored", Object.keys(slim.plugins).join(","), "a");
    eq("but they still count toward the distribution", slim.distribution.length, 3);
  }

  // A cached scan must score the same as the live one it was built from.
  const revived = remoteFromCache(cache.plugins.a);
  eq("cache round-trips downloads", revived?.downloads, 10);
  eq("cache round-trips the update time", revived?.updated, NOW);
  eq("cache round-trips the latest version", pickLatestVersion(revived), "1.0.0");
}

// --- the cache must not distort the maturity signal -------------------------
{
  // computeAll always scores through the cache, so a round-trip that inflates
  // the release count silently moves the maturity threshold for every user.
  const live: Record<string, number | undefined> = { downloads: 100, updated: NOW };
  for (let i = 0; i < 8; i++) live[`1.${i}.0`] = 5;
  eq("live release count", releaseCount(live), 8);

  const cached = buildRemoteCache({ p: live }, null, NOW, new Set(["p"]));
  eq("cached release count", cached.plugins.p.releases, 8);
  eq(
    "round-tripped release count is unchanged",
    releaseCount(remoteFromCache(cached.plugins.p)),
    8
  );
}

// --- a half-failed refresh must not discard the other half ------------------
{
  const installed = new Set(["a"]);
  const full = buildRemoteCache(
    { a: { downloads: 50, updated: NOW, "1.0.0": 50 } },
    { a: { repo: "own/a" } },
    NOW,
    installed
  );
  // The community list 500s; only the stats feed answered this time.
  const statsOnly = buildRemoteCache(
    { a: { downloads: 60, updated: NOW, "1.1.0": 60 } },
    null,
    NOW + 1000,
    installed
  );
  const merged = mergeRemoteCache(full, statsOnly);
  eq("fresh stats win", merged.plugins.a.downloads, 60);
  // Without the merge this became undefined: every GitHub link vanished, every
  // delisted detection was lost, and hygiene dropped 25 points per plugin.
  eq("the surviving repo is kept", merged.plugins.a.repo, "own/a");
  eq("and the listing is still known", merged.hadList, true);
  eq("listed survives a stats-only refresh", classifyListing("a", merged), "listed");
}
{
  // Delisted is a hard cap, not a chip: it outranks an otherwise perfect score.
  const h = computeHealth(
    input({
      manifest: manifest({ minAppVersion: "1.0.0" }),
      repo: "a/b",
      remote: { downloads: 900_000, updated: NOW },
      downloadPercentile: 0.99,
      listing: "delisted",
    }),
    NOW
  );
  check(
    "a delisted plugin is capped at 30",
    h.overall != null && h.overall <= 30,
    `got ${h.overall}`
  );
}

// --- a missing signal must never flatter a plugin ---------------------------
{
  const shared = {
    manifest: manifest({ id: "abandoned", minAppVersion: "1.0.0" }),
    repo: "a/b",
  };
  const online = computeHealth(
    input({
      ...shared,
      remote: { downloads: 200_000, updated: NOW - 1100 * DAY },
      downloadPercentile: 0.95,
      listing: "listed",
    }),
    NOW
  );
  const offline = computeHealth(input({ ...shared, listing: "unknown" }), NOW);
  // Offline we genuinely cannot know this plugin is stale, so the score can't
  // be expected to match the online one. What it must not do is sail to 100
  // because the condemning metric left the denominator: it is capped at what a
  // neutral maintenance reading would earn, and confidence says how thin the
  // evidence is. (Previously: 100 offline, presented with a grade and no caveat.)
  // Offline, the four local metrics all read 100, so the raw blend would be a
  // flat 100. The neutral-maintenance cap pulls it to (70 + 12.5) / 0.95 ≈ 87.
  check(
    "a missing signal cannot push a score to full marks",
    offline.overall != null && offline.overall <= 90,
    `offline ${offline.overall}`
  );
  check(
    "and the cap is what does it, not luck",
    offline.overall != null && offline.overall < 100,
    `offline ${offline.overall}`
  );
  check(
    "and confidence drops to say so",
    offline.confidence < online.confidence,
    `online ${online.confidence}, offline ${offline.confidence}`
  );
}

// --- percentile ranking -----------------------------------------------------
{
  const rank = rankerFromDistribution([10, 20, 30, 40]);
  eq("smallest ranks at 0", rank(10), 0);
  eq("median ranks mid-scale", rank(30), 0.5);
  eq("unknown downloads have no rank", rank(undefined), undefined);
  eq("no distribution means no ranker", rankerFromDistribution([])(5), undefined);
}

// --- the stability carve-out ------------------------------------------------
{
  // Calendar's real shape: last release 2021, ~3M downloads, many versions,
  // and its users long since migrated to the newest one. The old model called
  // this "abandoned" and offered to bulk-disable it.
  const mature: Record<string, number | undefined> = {
    downloads: 1000,
    updated: NOW - 1200 * DAY,
    "1.8.0": 800, // the newest release, and where the users are
  };
  for (let i = 0; i < 8; i++) mature[`1.${i}.0`] = 10;
  eq("mature stable is not unmaintained", deriveMaintenanceStatus(NOW - 1200 * DAY, NOW, mature), "stable");

  const abandoned = { downloads: 1000, updated: NOW - 1200 * DAY, "0.1.0": 5 };
  eq(
    "one release and long silent is unmaintained",
    deriveMaintenanceStatus(NOW - 1200 * DAY, NOW, abandoned),
    "unmaintained"
  );
  eq("release count counts stable keys only", releaseCount(abandoned), 1);
  check(
    "mature stable earns a maintenance floor",
    (computeHealth(input({ remote: mature as never }), NOW).metrics.maintenance.value ?? 0) >= 60,
    "a finished plugin should not score 5"
  );
}

// --- license verification (offline Ed25519) ---------------------------------
function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
function makeLicense(secretKey: Uint8Array, product: string, email = "a@b.com"): string {
  const payload = new TextEncoder().encode(
    JSON.stringify({ product, email, issued: "2026-01-01" })
  );
  const sig = nacl.sign.detached(payload, secretKey);
  return `${b64url(payload)}.${b64url(sig)}`;
}
{
  const kp = nacl.sign.keyPair();
  const pub = Buffer.from(kp.publicKey).toString("base64");
  const PRODUCT = "flowkit-health-dashboard";
  const good = makeLicense(kp.secretKey, PRODUCT);

  const v = verifyLicense(good, PRODUCT, pub);
  check("license valid", v.valid === true, v.error ?? "");
  eq("license email extracted", v.email, "a@b.com");

  eq(
    "license wrong product rejected",
    verifyLicense(makeLicense(kp.secretKey, "other-product"), PRODUCT, pub).valid,
    false
  );

  const zeroSig = `${good.split(".")[0]}.${b64url(new Uint8Array(64))}`;
  eq("license tampered signature rejected", verifyLicense(zeroSig, PRODUCT, pub).valid, false);
  eq("license empty rejected", verifyLicense("", PRODUCT, pub).valid, false);
  eq("license malformed rejected", verifyLicense("no-dot-here", PRODUCT, pub).valid, false);

  const other = nacl.sign.keyPair();
  const otherPub = Buffer.from(other.publicKey).toString("base64");
  eq("license from another key rejected", verifyLicense(good, PRODUCT, otherPub).valid, false);
}

// --- insights ----------------------------------------------------------------
function ph(overrides: Partial<PluginHealth>): PluginHealth {
  const metric = (value: number | null) => ({
    value,
    source: "measured" as const,
    detail: "",
  });
  return {
    id: "p",
    name: "P",
    author: "A",
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
      hygiene: metric(90),
      maintenance: metric(90),
      footprint: metric(90),
      popularity: metric(90),
      compatibility: metric(100),
      reliability: metric(100),
    },
    ...overrides,
  };
}
{
  // A tidy vault yields the single "healthy" insight.
  const healthy = buildInsights([ph({}), ph({ id: "q", name: "Q" })]);
  eq("insights healthy count", healthy.length, 1);
  eq("insights healthy id", healthy[0].id, "healthy");

  // Unmaintained → actionable insight referencing the plugin id.
  const um = buildInsights([ph({ id: "old", maintenanceStatus: "unmaintained" })]).find(
    (i) => i.id === "unmaintained"
  );
  check("insight unmaintained present", um != null);
  eq("insight unmaintained action", um?.action, "disable-unmaintained");
  eq("insight unmaintained id captured", um?.ids[0], "old");

  // Muted plugins are ignored entirely.
  eq(
    "muted excluded from insights",
    buildInsights([ph({ id: "m", maintenanceStatus: "unmaintained", muted: true })]).some(
      (i) => i.id === "unmaintained"
    ),
    false
  );

  // Incompatible outranks unmaintained (severity ordering).
  const inc = ph({ id: "inc", maintenanceStatus: "maintained" });
  inc.metrics.compatibility = { value: 0, source: "measured", detail: "" };
  const ordered = buildInsights([ph({ id: "old", maintenanceStatus: "unmaintained" }), inc]);
  eq("insights severity ordered", ordered[0].id, "incompatible");

  eq(
    "insight updates present",
    buildInsights([ph({ id: "up", updateAvailable: true })]).some((i) => i.id === "updates"),
    true
  );
  eq(
    "insight sideloaded present",
    buildInsights([ph({ id: "s", listing: "local" })]).some((i) => i.id === "sideloaded"),
    true
  );
  // A delisted plugin is a different, more serious thing than a local install,
  // and it must outrank everything — including "won't load".
  {
    const withDelisted = buildInsights([
      ph({ id: "d", listing: "delisted" }),
      ph({ id: "l", listing: "local" }),
    ]);
    eq("delisted insight present", withDelisted[0].id, "delisted");
    eq(
      "delisted offers no mute action",
      withDelisted.find((i) => i.id === "delisted")?.action,
      undefined
    );
  }
}

// --- version parsing regressions (0.3.0) ------------------------------------
// Plugins like Calendar, Linter and Periodic Notes publish `-beta` builds into
// the same stats object; counting one as "latest" showed an Update badge for a
// release the user cannot install from the community browser.
eq(
  "prerelease keys are not 'latest'",
  pickLatestVersion({ downloads: 9, updated: 1, "1.5.10": 100, "2.0.0-beta.2": 5 }),
  "1.5.10"
);
eq(
  "build-metadata keys are not 'latest'",
  pickLatestVersion({ "1.2.0": 1, "1.3.0+build.5": 2 }),
  "1.2.0"
);
eq("v-prefix ignored", compareVersion("v1.2.3", "1.2.3"), 0);
eq("prerelease sorts below its release", compareVersion("1.0.0-beta", "1.0.0"), -1);
eq("release sorts above its prerelease", compareVersion("1.0.0", "1.0.0-beta"), 1);
eq("prerelease vs prerelease", compareVersion("1.0.0-alpha", "1.0.0-beta"), -1);
{
  // A vault pinned to the stable release must not be told an update is waiting
  // just because a beta of the same version exists.
  const h = computeHealth(
    input({
      manifest: manifest({ id: "x", version: "1.3.0" }),
      remote: { downloads: 10, updated: NOW, "1.3.0": 5, "1.4.0-beta.1": 1 },
    }),
    NOW
  );
  eq("no update for a beta-only newer version", h.updateAvailable, false);
}

// --- insights cohort consistency (0.3.0) ------------------------------------
{
  // Every other cohort is enabled-only; unmaintained was not, so "Disable these"
  // counted plugins that were already off.
  const off = ph({ id: "off", enabled: false, maintenanceStatus: "unmaintained" });
  const unmaintained = buildInsights([off]).find((i) => i.id === "unmaintained");
  eq("disabled plugins excluded from unmaintained insight", unmaintained, undefined);

  const on = ph({ id: "on", enabled: true, maintenanceStatus: "unmaintained" });
  const both = buildInsights([on, off]).find((i) => i.id === "unmaintained");
  eq("only enabled plugins listed", both?.ids.length, 1);
  eq("and it is the enabled one", both?.ids[0], "on");
}

// --- a finding shows exactly what it counted --------------------------------
{
  // The card said "3 plugins score below 50" and opened a table of everything
  // the `attention` filter matched — which includes anything with an update
  // available. Every insight now carries the predicate it was built from.
  const rows = [
    ph({ id: "bad", overall: 20 }),
    ph({ id: "fine-but-update", overall: 95, updateAvailable: true }),
    ph({ id: "fine", overall: 95 }),
  ];
  const insights = buildInsights(rows);
  for (const ins of insights) {
    const matched = rows.filter((r) => ins.match(r)).map((r) => r.id).sort();
    check(
      `insight "${ins.id}" matches exactly the plugins it counted`,
      JSON.stringify(matched) === JSON.stringify([...ins.ids].sort()),
      `counted ${JSON.stringify(ins.ids)}, matches ${JSON.stringify(matched)}`
    );
  }

  // Muted plugins are excluded from every count, so no predicate may match one.
  const muted = ph({ id: "m", overall: 5, muted: true, maintenanceStatus: "unmaintained" });
  for (const ins of buildInsights([...rows, muted])) {
    check(`insight "${ins.id}" never matches a muted plugin`, !ins.match(muted), "muted leaked");
  }
}

// --- findings don't restate each other --------------------------------------
{
  // One broken plugin used to generate four findings: delisted, incompatible,
  // no-recent-release AND "scores below 50" all naming the same row.
  const broken = ph({
    id: "broken",
    overall: 12,
    listing: "delisted",
    maintenanceStatus: "unmaintained",
  });
  broken.metrics.compatibility = { value: 0, source: "measured", detail: "" };
  const found = buildInsights([broken]);
  const atRisk = found.find((i) => i.id === "at-risk");
  check(
    "a plugin already explained above is not restated by at-risk",
    !atRisk || !atRisk.ids.includes("broken"),
    "broken was listed twice"
  );
}

// --- error attribution ------------------------------------------------------
{
  const installed = new Set(["dataview", "templater-obsidian", "flowkit-health-dashboard"]);

  // Obsidian tags plugin code with `//# sourceURL=plugin:<id>`.
  eq(
    "attributes via the sourceURL marker",
    attributeStack(
      "TypeError: x is undefined\n    at eval (plugin:dataview:8123:15)\n    at App.onload (app://obsidian.md/app.js:1:1)",
      installed
    ),
    "dataview"
  );

  // And via the on-disk path, in case that marker ever changes.
  eq(
    "attributes via the plugin path",
    attributeStack(
      "Error: boom\n    at t (/home/u/vault/.obsidian/plugins/templater-obsidian/main.js:99:1)",
      installed
    ),
    "templater-obsidian"
  );
  eq(
    "attributes via a Windows plugin path",
    attributeStack(
      "Error: boom\n    at t (C:\\vault\\.obsidian\\plugins\\dataview\\main.js:99:1)",
      installed
    ),
    "dataview"
  );

  // Never blame a plugin that isn't installed, and never guess.
  eq(
    "ignores unknown plugin ids",
    attributeStack("at eval (plugin:some-other-thing:1:1)", installed),
    null
  );
  eq(
    "core Obsidian frames are not attributed",
    attributeStack("at Workspace.onLayoutReady (app://obsidian.md/app.js:1:1)", installed),
    null
  );
  eq("no stack means no attribution", attributeStack(undefined, installed), null);

  // The innermost plugin frame wins: whoever actually threw owns the error.
  eq(
    "innermost plugin frame wins",
    attributeStack(
      "Error\n    at inner (plugin:templater-obsidian:5:5)\n    at outer (plugin:dataview:9:9)",
      installed
    ),
    "templater-obsidian"
  );
}

// --- error signatures + accumulation ----------------------------------------
{
  const stackA = "Error: nope\n    at f (plugin:dataview:100:5)";
  const stackB = "Error: nope\n    at f (plugin:dataview:214:9)";
  // Line numbers drift between versions; the same bug must stay one entry.
  eq(
    "line numbers don't fragment a signature",
    errorSignature("nope", stackA),
    errorSignature("nope", stackB)
  );
  check(
    "different messages are different signatures",
    errorSignature("nope", stackA) !== errorSignature("other", stackA),
    "messages must separate"
  );

  let rec = recordError(undefined, {
    pluginId: "dataview",
    kind: "uncaught",
    message: "nope",
    stack: stackA,
    at: 1000,
  });
  rec = recordError(rec, {
    pluginId: "dataview",
    kind: "uncaught",
    message: "nope",
    stack: stackB,
    at: 2000,
  });
  eq("repeat errors increment one signature", rec.signatures.length, 1);
  eq("and the count follows", rec.signatures[0].count, 2);
  eq("uncaught count accumulates", rec.uncaught, 2);
  eq("lastAt tracks the newest", rec.lastAt, 2000);

  rec = recordError(rec, {
    pluginId: "dataview",
    kind: "console",
    message: "handled it",
    stack: stackA,
    at: 3000,
  });
  eq("console errors are counted separately", rec.logged, 1);
  eq("and don't inflate the uncaught count", rec.uncaught, 2);

  // A record must not be mutated in place — the caller decides when to persist.
  const before = recordError(undefined, {
    pluginId: "x",
    kind: "uncaught",
    message: "m",
    at: 1,
  });
  const after = recordError(before, {
    pluginId: "x",
    kind: "uncaught",
    message: "m",
    at: 2,
  });
  eq("recordError does not mutate its input", before.uncaught, 1);
  eq("and returns the updated copy", after.uncaught, 2);
}

// --- reliability scoring ----------------------------------------------------
{
  eq("silence scores 100", reliabilityScore(0), 100);
  check("one error a day is a dent, not a death", reliabilityScore(1) > 60 && reliabilityScore(1) < 85, `got ${reliabilityScore(1)}`);
  check("constant throwing bottoms out", reliabilityScore(200) < 15, `got ${reliabilityScore(200)}`);

  const day = 86_400_000;
  const rec = { uncaught: 10, logged: 99, firstAt: 0, lastAt: day, signatures: [] };
  eq("rate is per day", Math.round(errorRatePerDay(rec, 2 * day)), 5);
  // The console count must not move the score, or plugins that report their
  // failures honestly would rank below ones that swallow them.
  eq("console errors are excluded from the rate", errorRatePerDay({ ...rec, uncaught: 0 }, day), 0);

  // Until we've watched long enough, silence proves nothing.
  const fresh = computeHealth(input({ observedMs: 60_000 }), NOW);
  eq("reliability unavailable while still watching", fresh.metrics.reliability.value, null);
  const watched = computeHealth(input({ observedMs: MIN_OBSERVATION_MS }), NOW);
  eq("and measured once we have", watched.metrics.reliability.value, 100);
  eq("with the weight to match", watched.metrics.reliability.source, "measured");

  // An erroring plugin must actually lose points.
  const erroring = computeHealth(
    input({
      observedMs: 7 * day,
      errors: { uncaught: 70, logged: 0, firstAt: NOW - 7 * day, lastAt: NOW, signatures: [] },
    }),
    NOW
  );
  check(
    "errors drag the overall down",
    erroring.overall != null && watched.overall != null && erroring.overall < watched.overall,
    `clean ${watched.overall}, erroring ${erroring.overall}`
  );
}

// --- pruning ----------------------------------------------------------------
{
  const log = {
    kept: { uncaught: 1, logged: 0, firstAt: 0, lastAt: 0, signatures: [] },
    gone: { uncaught: 5, logged: 0, firstAt: 0, lastAt: 0, signatures: [] },
  };
  const pruned = pruneErrorLog(log, new Set(["kept"]));
  eq("uninstalled plugins are forgotten", Object.keys(pruned).join(","), "kept");
}

// --- change detection -------------------------------------------------------
{
  const ALL = new Set<HealthChangeKind>([
    "error-started",
    "became-incompatible",
    "delisted",
    "update-published",
  ]);
  const LOCAL_ONLY = new Set<HealthChangeKind>(["error-started", "became-incompatible"]);
  const BAD: HealthChangeKind[] = ["error-started", "delisted", "became-incompatible"];
  const row = (
    id: string,
    kinds: HealthChangeKind[],
    muted = false
  ): { id: string; name: string; muted: boolean; kinds: HealthChangeKind[] } => ({
    id,
    name: id,
    muted,
    kinds,
  });

  // A new problem is reported once, and only once.
  {
    const first = diffTrouble({}, [row("a", ["error-started"])], ALL, 1);
    eq("a new problem is reported", first.fresh.length, 1);
    eq("and remembered", first.current.a.join(), "error-started");
    const second = diffTrouble(first.current, [row("a", ["error-started"])], ALL, 2);
    eq("the same problem is not reported twice", second.fresh.length, 0);
  }

  // Installing an update is not "back to normal". This is the most common
  // transition in any vault, so getting it wrong was the most visible bug.
  {
    const before = { a: ["update-published"] as HealthChangeKind[] };
    const after = diffTrouble(before, [row("a", [])], ALL, 2);
    eq("applying an update reports nothing", after.fresh.length, 0);
  }

  // Genuine recovery does say so.
  {
    const before = { a: ["error-started"] as HealthChangeKind[] };
    const after = diffTrouble(before, [row("a", [])], ALL, 2);
    eq("a fixed plugin is reported resolved", after.fresh[0]?.kind, "resolved");
  }

  // A signal we couldn't read this scan must not read as recovery.
  {
    const before = { a: ["delisted"] as HealthChangeKind[] };
    const offline = diffTrouble(before, [row("a", [])], LOCAL_ONLY, 2);
    eq("an unreadable signal is not a recovery", offline.fresh.length, 0);
    eq("and the state is carried forward", offline.current.a.join(), "delisted");
  }

  // Muted plugins keep their state but generate no news, so unmuting later
  // doesn't re-announce trouble the user already acknowledged.
  {
    const muted = diffTrouble({}, [row("a", ["error-started"], true)], ALL, 1);
    eq("a muted plugin reports nothing", muted.fresh.length, 0);
    eq("but its state is remembered", muted.current.a.join(), "error-started");
    const unmuted = diffTrouble(muted.current, [row("a", ["error-started"])], ALL, 2);
    eq("unmuting doesn't re-announce it", unmuted.fresh.length, 0);
  }
}

// --- runtime footprint -------------------------------------------------------
{
  eq("50 KB is the footprint anchor", Math.round(sizeScore(50_000)), 100);
  check("500 KB costs 40 points", Math.round(sizeScore(500_000)) === 60);
  eq("a 50 ms load is free", loadScore(50), 100);
  check("a 5 s load is punishing", loadScore(5000) < 25, `got ${loadScore(5000)}`);

  eq("a minute-long timer costs nothing", pollPenalty(60_000), 0);
  eq("an hourly timer costs nothing", pollPenalty(3_600_000), 0);
  check("a 100 ms timer costs the most", pollPenalty(100) === 45);
  check(
    "a faster timer never costs less than a slower one",
    pollPenalty(250) >= pollPenalty(1000) && pollPenalty(1000) >= pollPenalty(10_000)
  );

  // The whole point of the rework: size alone said the small one was cheaper.
  const smallPoller = readFootprint(60_000, { minIntervalMs: 100 }, "1.0.0");
  const bigIdle = readFootprint(400_000, {}, "1.0.0");
  check(
    "a small plugin polling hard scores below a big idle one",
    (smallPoller.value ?? 0) < (bigIdle.value ?? 0),
    `poller ${smallPoller.value} vs idle ${bigIdle.value}`
  );
  check("and the reason is named", smallPoller.detail.includes("timer"), smallPoller.detail);

  // Bytes-only behaviour is unchanged, so an unobserved plugin scores as before.
  eq("bytes-only is unchanged", readFootprint(50_000, undefined, "1.0.0").value, 100);
  eq(
    "an unmeasurable plugin stays unavailable",
    readFootprint(undefined, undefined, "1.0.0").value,
    null
  );

  // A load time measured against a build the user no longer runs is not
  // evidence about the build they do run.
  const stale = readFootprint(50_000, { loadMs: 4000, loadVersion: "0.9.0" }, "1.0.0");
  eq("a load time from an older version is ignored", stale.value, 100);
  const current = readFootprint(50_000, { loadMs: 4000, loadVersion: "1.0.0" }, "1.0.0");
  check("but the current version's load time counts", (current.value ?? 100) < 40);

  const rec = recordLoad(undefined, 123.7, "1.0.0", NOW);
  eq("a recorded load rounds to whole ms", rec.loadMs, 124);
  eq("and is tied to the version it timed", rec.loadVersion, "1.0.0");

  const kept = pruneProfiles({ a: { loadMs: 1 }, b: { loadMs: 2 } }, new Set(["a"]));
  eq("uninstalled profiles are dropped", Object.keys(kept).join(), "a");

  const cost = startupCost(
    [
      { id: "a", enabled: true, bytes: 1000 },
      { id: "b", enabled: false, bytes: 9_000_000 },
      { id: "c", enabled: true, bytes: 2000 },
    ],
    { a: { loadMs: 100 }, c: { minIntervalMs: 200 } }
  );
  eq("startup cost counts only enabled plugins", cost.bytes, 3000);
  eq("and only measured load times", cost.measuredCount, 1);
  eq("and counts the pollers", cost.polling, 1);
}

// --- conflicts ---------------------------------------------------------------
{
  const installed = new Set(["alpha", "beta"]);
  const names = { alpha: "Alpha", beta: "Beta" };
  const cmd = (id: string, name: string, hotkeys?: CommandRow["hotkeys"]): CommandRow => ({
    id,
    name,
    hotkeys,
  });

  eq("chords print canonically", printChord({ modifiers: ["Shift", "Mod"], key: "t" }), "Mod+Shift+T");
  eq("a chord with no key is nothing", printChord({ modifiers: ["Mod"] }), null);

  {
    const found = findConflicts({
      commands: [
        cmd("alpha:go", "Go", [{ modifiers: ["Mod"], key: "T" }]),
        cmd("beta:leap", "Leap", [{ modifiers: ["Mod"], key: "t" }]),
      ],
      customKeys: {},
      installed,
      names,
    });
    eq("two plugins on one chord is a conflict", found.length, 1);
    eq("and it is reported as a hotkey clash", found[0].kind, "hotkey");
    eq("naming both plugins", found[0].ids.slice().sort().join(), "alpha,beta");
  }

  {
    // Modifier order and key case are presentation, not identity.
    const found = findConflicts({
      commands: [
        cmd("alpha:go", "Go", [{ modifiers: ["Mod", "Shift"], key: "k" }]),
        cmd("beta:leap", "Leap", [{ modifiers: ["Shift", "Mod"], key: "K" }]),
      ],
      customKeys: {},
      installed,
      names,
    });
    eq("modifier order doesn't hide a clash", found.length, 1);
  }

  {
    // One plugin binding the same chord to two of its own commands is its own
    // business, and usually deliberate.
    const found = findConflicts({
      commands: [
        cmd("alpha:on", "On", [{ modifiers: ["Mod"], key: "T" }]),
        cmd("alpha:off", "Off", [{ modifiers: ["Mod"], key: "T" }]),
      ],
      customKeys: {},
      installed,
      names,
    });
    eq("one plugin clashing with itself is not reported", found.length, 0);
  }

  {
    // An empty custom binding is how Obsidian records "I removed this", so it
    // must count as an override — not as "no override, use the default".
    const found = findConflicts({
      commands: [
        cmd("alpha:go", "Go", [{ modifiers: ["Mod"], key: "T" }]),
        cmd("beta:leap", "Leap", [{ modifiers: ["Mod"], key: "T" }]),
      ],
      customKeys: { "beta:leap": [] },
      installed,
      names,
    });
    eq("a binding the user removed is not still clashing", found.length, 0);
  }

  {
    const found = findConflicts({
      commands: [
        cmd("editor:toggle-bold", "Toggle bold", [{ modifiers: ["Mod"], key: "B" }]),
        cmd("app:go-back", "Back", [{ modifiers: ["Mod"], key: "B" }]),
      ],
      customKeys: {},
      installed,
      names,
    });
    eq("two core commands clashing is not our business", found.length, 0);
  }

  {
    const found = findConflicts({
      commands: [cmd("alpha:x", "Insert template"), cmd("beta:y", "Insert template")],
      customKeys: {},
      installed,
      names,
    });
    eq("duplicate command names are reported", found.length, 1);
    eq("as a name clash", found[0].kind, "command-name");
  }
}

// --- mutes -------------------------------------------------------------------
{
  const migrated = migrateMutes(["old-one"], undefined, NOW);
  eq("a pre-1.3 mute survives migration", Object.keys(migrated).join(), "old-one");
  eq("as an indefinite one", migrated["old-one"].until, null);

  const both = migrateMutes(["a"], { a: { at: 1, until: 99 } }, NOW);
  eq("an existing record wins over the legacy list", both.a.until, 99);

  const mutes = {
    timed: buildMute("30d", NOW, "1.5.0"),
    pinned: buildMute("until-update", NOW, "1.5.0"),
    forever: buildMute("forever", NOW, "1.5.0", "  decided  "),
  };
  eq("a reason is trimmed", mutes.forever.reason, "decided");
  eq("an indefinite mute has no expiry", mutes.forever.until, null);

  const same = sweepMutes(mutes, NOW + 1000, "1.5.0");
  eq("nothing lapses on the same day and version", same.expired.length, 0);

  const later = sweepMutes(mutes, NOW + 31 * DAY, "1.5.0");
  eq("a 30-day mute lapses", later.expired.join(), "timed");
  check("and the others survive", "pinned" in later.active && "forever" in later.active);

  const updated = sweepMutes(mutes, NOW + 1000, "1.6.0");
  eq("an Obsidian update lapses the version-pinned mute", updated.expired.join(), "pinned");

  check(
    "a live mute describes itself",
    describeMute(mutes.timed, NOW).includes("lapses in"),
    describeMute(mutes.timed, NOW)
  );
}

// --- triage ------------------------------------------------------------------
{
  const broken = ph({
    id: "broken",
    name: "Broken",
    overall: 20,
    metrics: {
      hygiene: { value: 100, source: "measured", detail: "" },
      maintenance: { value: 80, source: "measured", detail: "" },
      footprint: { value: 90, source: "measured", detail: "" },
      popularity: { value: 50, source: "measured", detail: "" },
      compatibility: { value: 0, source: "measured", detail: "" },
      reliability: { value: 100, source: "measured", detail: "" },
    },
    runtime: { commands: 10, handlers: 20 },
  });
  const old = ph({
    id: "old",
    name: "Old",
    overall: 45,
    maintenanceStatus: "unmaintained",
    runtime: { commands: 0, handlers: 0 },
  });
  const beloved = ph({
    id: "beloved",
    name: "Beloved",
    overall: 30,
    watched: true,
    maintenanceStatus: "unmaintained",
    errors: { uncaught: 6, logged: 0, firstAt: 1, lastAt: 2, signatures: [] },
    runtime: { commands: 2, handlers: 2 },
  });

  const ranked = rankSafeDisable([broken, old, beloved], 3);
  eq("the broken one leads", ranked[0]?.id, "broken");
  eq("because switching it off costs nothing", ranked[0]?.cost, 0);
  check(
    "and that is what it says",
    ranked[0]?.loss.includes("already isn't running"),
    ranked[0]?.loss
  );
  const watchedRank = ranked.findIndex((c) => c.id === "beloved");
  check(
    "a watched plugin is never recommended first",
    watchedRank !== 0,
    `ranked at ${watchedRank}`
  );

  eq(
    "a disabled plugin is not a candidate",
    rankSafeDisable([{ ...broken, enabled: false }]).length,
    0
  );
  eq("nor is a muted one", rankSafeDisable([{ ...broken, muted: true }]).length, 0);
  eq("nor is a healthy one", rankSafeDisable([ph({ overall: 95 })]).length, 0);
}

// --- repository activity -----------------------------------------------------
{
  eq("an archived repo is decisive", repoVerdict({ at: NOW, archived: true }, NOW), "archived");
  eq(
    "a deleted repo is decisive",
    repoVerdict({ at: NOW, failed: "missing" }, NOW),
    "gone"
  );
  eq(
    "a recent push means active",
    repoVerdict({ at: NOW, pushedAt: NOW - 30 * DAY }, NOW),
    "active"
  );
  eq(
    "a three-year-old push means dormant",
    repoVerdict({ at: NOW, pushedAt: NOW - 1100 * DAY }, NOW),
    "dormant"
  );
  // Nine months is neither evidence of life nor of death, and must leave the
  // release-based reading exactly as it was.
  eq(
    "an ambiguous push decides nothing",
    repoVerdict({ at: NOW, pushedAt: NOW - 280 * DAY }, NOW),
    null
  );
  eq("no reading decides nothing", repoVerdict(undefined, NOW), null);

  const base: ScoreInput = {
    manifest: manifest({}),
    enabled: true,
    isMobile: false,
    bundleBytes: 50_000,
  };
  const ancient = { downloads: 1000, updated: NOW - 900 * DAY } as Record<string, number>;
  for (let i = 0; i < 9; i++) ancient[`1.0.${i}`] = 700;

  const stableOnly = computeHealth({ ...base, remote: ancient }, NOW);
  eq("the maturity carve-out still applies alone", stableOnly.maintenanceStatus, "stable");

  const dormant = computeHealth(
    { ...base, remote: ancient, repoActivity: { at: NOW, pushedAt: NOW - 1100 * DAY } },
    NOW
  );
  eq(
    "a dormant repository overrules the carve-out",
    dormant.maintenanceStatus,
    "unmaintained"
  );
  check(
    "and drags the score down with it",
    (dormant.metrics.maintenance.value ?? 100) <= 25,
    `got ${dormant.metrics.maintenance.value}`
  );

  const stillGoing = computeHealth(
    { ...base, remote: ancient, repoActivity: { at: NOW, pushedAt: NOW - 20 * DAY } },
    NOW
  );
  eq("a repository still being pushed to reads as active", stillGoing.maintenanceStatus, "active");
  check(
    "and is not scored as abandoned",
    (stillGoing.metrics.maintenance.value ?? 0) >= 65,
    `got ${stillGoing.metrics.maintenance.value}`
  );

  const archived = computeHealth(
    { ...base, remote: ancient, repoActivity: { at: NOW, archived: true } },
    NOW
  );
  eq("an archived repository is unmaintained", archived.maintenanceStatus, "unmaintained");
  check(
    "whatever its release history says",
    (archived.metrics.maintenance.value ?? 100) <= 10,
    `got ${archived.metrics.maintenance.value}`
  );

  // Selection has to spend a scarce request budget where the answer can change.
  const cache: RepoActivityMap = { fresh: { at: NOW } };
  check("a fresh reading is not stale", !isStale(cache.fresh, NOW));
  check("a fortnight-old one is", isStale(cache.fresh, NOW + 14 * DAY));
  const picked = selectForLookup(
    [
      { id: "fresh", repo: "a/b", inDoubt: true, enabled: true },
      { id: "norepo", inDoubt: true, enabled: true },
      { id: "settled", repo: "c/d", inDoubt: false, enabled: true },
      { id: "off", repo: "e/f", inDoubt: true, enabled: false },
      { id: "on", repo: "g/h", inDoubt: true, enabled: true },
    ],
    cache,
    NOW,
    2
  );
  eq("only doubtful, stale, repo-having plugins are looked up", picked.join(), "on,off");
}

// --- conflict insight --------------------------------------------------------
{
  const rows = [
    ph({ id: "alpha", name: "Alpha" }),
    ph({ id: "beta", name: "Beta" }),
    ph({ id: "gamma", name: "Gamma" }),
  ];
  const insights = buildInsights(rows, {
    conflicts: [
      {
        kind: "hotkey",
        subject: "Mod+T",
        parties: [],
        ids: ["alpha", "beta"],
      },
    ],
  });
  const card = insights.find((i) => i.id === "conflicts");
  check("a shortcut clash becomes a finding", card != null);
  eq("naming exactly the plugins involved", card?.ids.slice().sort().join(), "alpha,beta");
  eq("and the table scopes to them", rows.filter((r) => card?.match(r)).length, 2);

  const none = buildInsights(rows, { conflicts: [] });
  eq("no clashes, no card", none.some((i) => i.id === "conflicts"), false);

  // A clash involving only disabled plugins isn't affecting anything today.
  const disabled = buildInsights(
    [ph({ id: "alpha", enabled: false }), ph({ id: "beta", enabled: false })],
    { conflicts: [{ kind: "hotkey", subject: "Mod+T", parties: [], ids: ["alpha", "beta"] }] }
  );
  eq("a clash between disabled plugins is not reported", disabled.some((i) => i.id === "conflicts"), false);
}

// --- bisect ------------------------------------------------------------------
{
  eq("one candidate needs one round", roundsNeeded(1), 1);
  // log2 to narrow, plus one to switch the last suspect off and confirm.
  eq("forty candidates need seven", roundsNeeded(40), 7);
  eq("eight candidates need four", roundsNeeded(8), 4);

  const all = ["a", "b", "c", "d", "e", "f", "g", "h"];

  // The search must terminate on whichever plugin is guilty, whichever answers
  // that implies — so drive it for every possible culprit rather than trusting
  // one hand-picked path.
  for (const guilty of all) {
    let state = beginBisect(all, all, NOW, "lag");
    let guard = 0;
    while (!state.done && guard++ < 20) {
      // The symptom disappears exactly when the guilty plugin is switched off.
      state = bisectStep(state, state.disabled.includes(guilty));
    }
    check(`bisect terminates for ${guilty}`, state.done, `after ${guard} rounds`);
    eq(`bisect finds ${guilty}`, state.culprit, guilty);
    check(
      `and does it within the promised rounds for ${guilty}`,
      guard <= roundsNeeded(all.length),
      `took ${guard}, promised ${roundsNeeded(all.length)}`
    );
  }

  // Nobody is guilty: the symptom persists no matter what is switched off.
  {
    let state = beginBisect(all, all, NOW);
    let guard = 0;
    while (!state.done && guard++ < 20) state = bisectStep(state, false);
    check("bisect terminates when no plugin is at fault", state.done);
    eq("with nothing accused", state.culprit, undefined);
    eq("and says so", state.exonerated, true);
  }

  // Two candidates must split 1/1, not 2/0 — a round that disables everything
  // asks a question whose answer eliminates nothing.
  {
    const two = beginBisect(["a", "b"], ["a", "b"], NOW);
    eq("two candidates split one and one", two.disabled.length, 1);
    const after = bisectStep(two, true);
    eq("and one answer settles it", after.done, true);
    eq("naming the disabled one", after.culprit, "a");
    // Answering "still happening" clears `a` but proves nothing about `b`,
    // which has never been switched off — so it takes one more round.
    const other = bisectStep(two, false);
    eq("clearing one doesn't yet accuse the other", other.done, false);
    eq("but it is now the only suspect, and it is off", other.disabled.join(), "b");
    eq("and the next answer names it", bisectStep(other, true).culprit, "b");
    eq("or exonerates everything", bisectStep(other, false).exonerated, true);
  }

  // Plugins that were never candidates stay on throughout, and everything the
  // user had off stays off.
  {
    const state = beginBisect(["a", "b"], ["a", "b", "keepme"], NOW);
    const want = desiredState(state);
    check("non-candidates stay enabled", want.enable.includes("keepme"));
    check("the tested half is off", want.disable.includes("a"));
    check(
      "and a plugin the user had disabled is never switched on",
      !want.enable.includes("neverinstalled") && !want.disable.includes("neverinstalled")
    );
  }

  // Restore is the whole safety net: it must name exactly the original set.
  {
    const state = beginBisect(["a", "b", "c"], ["a", "b", "c", "d"], NOW);
    const mid = bisectStep(state, false);
    const back = restoreState(mid);
    eq("restore re-enables everything that was on", back.enable.slice().sort().join(), "a,b,c,d");
    eq("and leaves nothing off", back.disable.length, 0);
  }

  {
    const done = beginBisect([], [], NOW);
    eq("a search with no candidates is already over", done.done, true);
    const stepped: BisectState = bisectStep(done, true);
    eq("and stepping it does nothing", stepped, done);
  }
}

// A search must never be able to switch off the thing running the search.
// Without this, bisect eventually unloads FlowKit: the view vanishes mid-run,
// the session survives on disk describing a half-disabled vault, and the only
// thing that knows how to restore it is now disabled.
{
  const enabled = ["alpha", "flowkit-health-dashboard", "beta"];
  const searchable = searchableCandidates(enabled, "flowkit-health-dashboard");
  eq("the searcher is never a candidate", searchable.join(), "alpha,beta");
  eq(
    "and it is never switched off",
    beginBisect(searchable, enabled, 1).disabled.includes("flowkit-health-dashboard"),
    false
  );
  // It stays enabled throughout, because it is in originalEnabled but never
  // in the disabled set.
  const state = beginBisect(searchable, enabled, 1);
  check(
    "it stays running for the whole search",
    desiredState(state).enable.includes("flowkit-health-dashboard")
  );
  eq(
    "filtering is a no-op when it isn't in the list",
    searchableCandidates(["alpha"], "flowkit-health-dashboard").join(),
    "alpha"
  );
}

// --- timeline ----------------------------------------------------------------
{
  const observed = (version: string, enabled = true) => [
    { id: "a", name: "A", version, enabled },
  ];

  // The first run records a baseline and says nothing — announcing every
  // installed plugin as new would fabricate events that never happened.
  {
    const first = diffInstalled({}, observed("1.0.0"), NOW, false);
    eq("the baseline run emits nothing", first.events.length, 0);
    eq("but records what it saw", first.seen.a.version, "1.0.0");
  }

  {
    const seen: SeenMap = { a: { version: "1.0.0", enabled: true, at: NOW - DAY } };
    const updated = diffInstalled(seen, observed("1.1.0"), NOW);
    eq("an update is recorded", updated.events.length, 1);
    eq("with both versions", `${updated.events[0].from}->${updated.events[0].to}`, "1.0.0->1.1.0");

    const same = diffInstalled(seen, observed("1.0.0"), NOW);
    eq("an unchanged plugin emits nothing", same.events.length, 0);

    const toggled = diffInstalled(seen, observed("1.0.0", false), NOW);
    eq("a toggle is recorded", toggled.events[0]?.kind, "disabled");

    const gone = diffInstalled(seen, [], NOW);
    eq("an uninstall is recorded", gone.events[0]?.kind, "removed");

    const added = diffInstalled({}, observed("1.0.0"), NOW);
    eq("a new plugin is recorded as installed", added.events[0]?.kind, "installed");
  }

  // The correlation is the product's best sentence, and also the easiest place
  // to assert a cause that isn't there.
  {
    const events: PluginEvent[] = [
      { at: NOW - 2 * 3_600_000, id: "a", name: "A", kind: "updated", from: "1", to: "2" },
      { at: NOW - 40 * DAY, id: "b", name: "B", kind: "updated", from: "1", to: "2" },
    ];

    const hit = correlate(
      events,
      [{ id: "a", name: "A", firstAt: NOW - 3_600_000, uncaught: 5 }],
      NOW
    );
    eq("errors soon after an update correlate", hit.length, 1);
    eq("naming that update", hit[0].event.to, "2");
    eq("and the ordering is known", hit[0].approximate, false);

    // The case a real vault produced: FlowKit does not scan the instant a
    // plugin updates, so the moment it NOTICES can land after the errors have
    // already started. Anchoring to `at` alone silently discards exactly the
    // correlation the feature exists to make.
    const noticedLate: PluginEvent[] = [
      {
        at: NOW,
        since: NOW - 4 * 3_600_000,
        id: "a",
        name: "A",
        kind: "updated",
        from: "1",
        to: "2",
      },
    ];
    const late = correlate(
      noticedLate,
      [{ id: "a", name: "A", firstAt: NOW - 2 * 3_600_000, uncaught: 5 }],
      NOW
    );
    eq("an update noticed late still correlates", late.length, 1);
    eq("but says the ordering is uncertain", late[0].approximate, true);
    eq("and never reports a negative gap", late[0].gapMs, 0);

    // Before the window opened is still not evidence about the change.
    const tooEarly = correlate(
      noticedLate,
      [{ id: "a", name: "A", firstAt: NOW - 5 * 3_600_000, uncaught: 5 }],
      NOW
    );
    eq("errors predating the window still don't correlate", tooEarly.length, 0);

    const old = correlate(
      events,
      [{ id: "b", name: "B", firstAt: NOW - 3_600_000, uncaught: 5 }],
      NOW
    );
    eq("an update forty days earlier is not a cause", old.length, 0);

    // Errors that predate the update are not evidence about the update. This
    // is the difference between a correlation and blaming an author for a bug
    // that predates their release.
    const before = correlate(
      events,
      [{ id: "a", name: "A", firstAt: NOW - 5 * 3_600_000, uncaught: 5 }],
      NOW
    );
    eq("errors that started before the change don't correlate", before.length, 0);

    const clean = correlate(events, [{ id: "a", name: "A", firstAt: NOW, uncaught: 0 }], NOW);
    eq("a plugin with no errors never correlates", clean.length, 0);
  }

  {
    const kept = pruneEvents(
      [
        { at: NOW - 200 * DAY, id: "old", name: "Old", kind: "installed" },
        { at: NOW - DAY, id: "new", name: "New", kind: "installed" },
      ],
      NOW
    );
    eq("events past the window are dropped", kept.length, 1);
    eq("keeping the recent one", kept[0].id, "new");
  }
}

// --- plugin sets -------------------------------------------------------------
{
  let profiles: PluginProfile[] = [];
  profiles = saveProfile(profiles, "Writing", ["a", "b"], NOW);
  profiles = saveProfile(profiles, "Minimal", ["a"], NOW);
  eq("profiles are saved newest first", profiles[0].name, "Minimal");

  profiles = saveProfile(profiles, "Writing", ["a", "b", "c"], NOW + 1);
  eq("saving over a name replaces it", profiles.length, 2);
  eq("with the new contents", profiles.find((p) => p.name === "Writing")?.ids.length, 3);

  eq("a blank name saves nothing", saveProfile(profiles, "  ", ["x"], NOW).length, 2);
  eq("deleting works", deleteProfile(profiles, "Minimal").length, 1);

  const installed = new Set(["a", "b", "c"]);
  const enabled = new Set(["a", "z"]);
  const delta = profileDelta(
    { name: "W", ids: ["a", "b", "gone"], at: NOW },
    installed,
    enabled
  );
  eq("what to switch on", delta.enable.join(), "b");
  // `z` is enabled but not installed as far as this vault knows, so it is left
  // alone rather than being switched off by a profile that never mentioned it.
  eq("what to switch off", delta.disable.join(), "");
  eq("and what the profile names that isn't here", delta.missing.join(), "gone");

  const off = profileDelta({ name: "W", ids: ["a"], at: NOW }, installed, new Set(["a", "c"]));
  eq("a plugin outside the profile is switched off", off.disable.join(), "c");

  check("an identical profile is a no-op", isNoop(profileDelta({ name: "W", ids: ["a"], at: NOW }, installed, new Set(["a"]))));
  check("a different one is not", !isNoop(off));
}

// --- timer callback cost -----------------------------------------------------
{
  eq("a callback inside the frame budget is free", tickScore(10), 100);
  eq("a quarter-second freeze bottoms out", tickScore(250), 0);
  check("and 100 ms lands in between", tickScore(100) > 0 && tickScore(100) < 100);

  // The case the whole metric exists for: a slow callback on a slow timer is
  // invisible to every other measure here.
  const slowTick = readFootprint(50_000, { minIntervalMs: 30_000, maxTickMs: 200 }, "1.0.0");
  check(
    "a slow callback on a slow timer still scores badly",
    (slowTick.value ?? 100) < 30,
    `got ${slowTick.value}`
  );
  check("and says why", slowTick.detail.includes("blocks the interface"), slowTick.detail);

  // A 30 s timer is not free — it sits inside the one-minute idle threshold —
  // so the idle case is checked at a period the curve really does ignore.
  const fastTick = readFootprint(50_000, { minIntervalMs: 120_000, maxTickMs: 3 }, "1.0.0");
  eq("a quick callback on an idle timer costs nothing", fastTick.value, 100);
  check(
    "a 30-second timer costs a little",
    (readFootprint(50_000, { minIntervalMs: 30_000 }, "1.0.0").value ?? 100) < 100
  );
}

// --- issue search terms ------------------------------------------------------
{
  const terms = searchTerms(
    "Cannot read properties of undefined at C:\\Users\\me\\vault\\.obsidian\\plugins\\x\\main.js:1042"
  );
  check("paths are stripped", !terms.includes("Users"), terms);
  check("line numbers are stripped", !terms.includes("1042"), terms);
  check("but the message survives", terms.includes("Cannot read properties"), terms);
  eq("an empty message searches for nothing", searchTerms("  "), "");
}

// --- attribution must look past our own frames ------------------------------
// Found in a real vault: the watcher captures a stack from inside its own
// setInterval wrapper, so FlowKit's frames sit on top of the caller's. The
// innermost-wins rule then faithfully returned FlowKit every time, and no other
// plugin in the vault was ever measured.
{
  const installed = new Set(["flowkit-health-dashboard", "dataview"]);
  const self = new Set(["flowkit-health-dashboard"]);
  const stack = [
    "Error",
    "    at RuntimeWatcher.attributeCaller (plugin:flowkit-health-dashboard:120:20)",
    "    at Window.set (plugin:flowkit-health-dashboard:99:14)",
    "    at DataviewPlugin.onload (plugin:dataview:4102:9)",
  ].join("\n");

  eq(
    "without the exclusion, our own frame wins",
    attributeStack(stack, installed),
    "flowkit-health-dashboard"
  );
  eq(
    "with it, the real caller is found",
    attributeStack(stack, installed, self),
    "dataview"
  );
  eq(
    "a stack containing only our own frames attributes to nobody",
    attributeStack(
      "Error\n    at x (plugin:flowkit-health-dashboard:1:1)",
      installed,
      self
    ),
    null
  );
}

// --- reliability: silence needs time, failure does not ----------------------
{
  const brandNew = { ...input({}), observedMs: 60_000 };

  const quiet = computeHealth(brandNew, NOW);
  eq(
    "a quiet plugin is still unjudged early on",
    quiet.metrics.reliability.value,
    null
  );

  // Observed uncaught errors are evidence available immediately. Withholding
  // the score for six hours put "13 errors" beside a blank Reliability and an
  // overall of 72 — the product contradicting itself in three inches.
  const broken = computeHealth(
    {
      ...brandNew,
      errors: {
        uncaught: 13,
        logged: 10,
        firstAt: NOW - 60_000,
        lastAt: NOW,
        signatures: [],
      },
    },
    NOW
  );
  check(
    "but observed errors are scored straight away",
    broken.metrics.reliability.value != null,
    "still null"
  );
  check(
    "and scored badly",
    (broken.metrics.reliability.value ?? 100) < 40,
    `got ${broken.metrics.reliability.value}`
  );
  check(
    "which drags the overall down with it",
    (broken.overall ?? 100) < (quiet.overall ?? 0),
    `broken ${broken.overall} vs quiet ${quiet.overall}`
  );

  // Errors a plugin catches and logs itself still never count against it.
  const tidy = computeHealth(
    {
      ...brandNew,
      errors: { uncaught: 0, logged: 40, firstAt: NOW - 60_000, lastAt: NOW, signatures: [] },
    },
    NOW
  );
  eq("logged-only errors don't force an early judgement", tidy.metrics.reliability.value, null);
}

// --- don't send people to a setting that can't help -------------------------
{
  const local = computeHealth(input({ listing: "local" }), NOW);
  check(
    "a local install isn't told to enable enrichment",
    !local.metrics.popularity.detail.includes("enrichment"),
    local.metrics.popularity.detail
  );
  check(
    "it's told why the figures don't exist",
    local.metrics.maintenance.detail.includes("outside the community directory"),
    local.metrics.maintenance.detail
  );
  const listed = computeHealth(input({ listing: "listed" }), NOW);
  check(
    "a listed plugin with no data still gets the actionable message",
    listed.metrics.popularity.detail.includes("enrichment"),
    listed.metrics.popularity.detail
  );
}

// --- report -----------------------------------------------------------------
if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
} else {
  console.log(`✓ all ${passed} scoring assertions passed`);
}
