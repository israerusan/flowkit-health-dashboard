// Executable tests for the scoring engine. Bundled with `obsidian` aliased to a
// stub (apiVersion = "1.5.0") and run under Node — see test/run.mjs.
import type { PluginManifest } from "obsidian";
import {
  buildRemoteCache,
  classifyListing,
  compareVersion,
  computeHealth,
  deriveMaintenanceStatus,
  pickLatestVersion,
  rankerFromDistribution,
  releaseCount,
  remoteFromCache,
  type ScoreInput,
} from "../src/scoring";
import nacl from "tweetnacl";
import { verifyLicense } from "../src/shared/verifyLicense.mjs";
import { buildInsights } from "../src/insights";
import type { PluginHealth } from "../src/types";

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
  const cache = buildRemoteCache(stats, list, NOW);

  eq("cache carries the repo from the list", cache.plugins.a.repo, "own/a");
  eq("cache records which feeds it had", cache.hadStats && cache.hadList, true);
  eq("distribution is sorted for ranking", cache.distribution.join(","), "10,20");

  eq("in list is listed", classifyListing("a", cache), "listed");
  // In the stats feed but pulled from the list: Obsidian removed it.
  eq("in stats but not list is delisted", classifyListing("b", cache), "delisted");
  eq("in neither is local", classifyListing("c", cache), "local");
  eq("no list at all is unknown", classifyListing("a", buildRemoteCache(stats, null, NOW)), "unknown");

  // A cached scan must score the same as the live one it was built from.
  const revived = remoteFromCache(cache.plugins.a);
  eq("cache round-trips downloads", revived?.downloads, 10);
  eq("cache round-trips the update time", revived?.updated, NOW);
  eq("cache round-trips the latest version", pickLatestVersion(revived), "1.0.0");
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
  check(
    "a missing signal cannot push a score to full marks",
    offline.overall != null && offline.overall <= 85,
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
    overall: 90,
    confidence: 1,
    metrics: {
      hygiene: metric(90),
      maintenance: metric(90),
      footprint: metric(90),
      popularity: metric(90),
      compatibility: metric(100),
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

// --- report -----------------------------------------------------------------
if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
} else {
  console.log(`✓ all ${passed} scoring assertions passed`);
}
