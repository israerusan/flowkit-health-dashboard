// Executable tests for the scoring engine. Bundled with `obsidian` aliased to a
// stub (apiVersion = "1.5.0") and run under Node — see test/run.mjs.
import type { PluginManifest } from "obsidian";
import {
  compareVersion,
  computeHealth,
  deriveMaintenanceStatus,
  pickLatestVersion,
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
    enabledCount: 10,
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
        authorUrl: "https://github.com/blacksmithgu",
        minAppVersion: "0.13.11",
      }),
      repo: "blacksmithgu/obsidian-dataview",
      remote: { downloads: 5_000_000, updated: NOW - 30 * DAY },
    }),
    NOW
  );
  eq("healthy compatibility", h.metrics.compatibility.value, 100);
  eq("healthy popularity", h.metrics.popularity.value, 100);
  eq("healthy maintenance", h.metrics.maintenance.value, 100);
  eq("healthy performance", h.metrics.performance.value, 90);
  eq("healthy quality", h.metrics.quality.value, 95);
  eq("healthy overall", h.overall, 97);
  eq("healthy status", h.maintenanceStatus, "maintained");
  eq("compatibility source measured", h.metrics.compatibility.source, "measured");
  eq("quality source estimated", h.metrics.quality.source, "estimated");
}

// --- computeHealth: abandoned, offline, crowded vault -----------------------
{
  const h = computeHealth(
    input({
      manifest: manifest({
        id: "old",
        name: "Old Plugin",
        authorUrl: undefined,
        minAppVersion: "1.9.0", // newer than stubbed apiVersion 1.5.0
      }),
      enabledCount: 30,
      remote: undefined,
    }),
    NOW
  );
  eq("abandoned compatibility", h.metrics.compatibility.value, 0);
  eq("abandoned popularity null", h.metrics.popularity.value, null);
  eq("abandoned maintenance null", h.metrics.maintenance.value, null);
  eq("abandoned performance penalized", h.metrics.performance.value, 75);
  eq("abandoned quality", h.metrics.quality.value, 28);
  eq("abandoned overall", h.overall, 34);
  eq("abandoned status", h.maintenanceStatus, "unknown");
  eq("popularity unavailable", h.metrics.popularity.source, "unavailable");
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

// --- computeHealth: disabled plugin has no performance value ----------------
{
  const h = computeHealth(input({ enabled: false }), NOW);
  eq("disabled performance null", h.metrics.performance.value, null);
  eq("disabled performance unavailable", h.metrics.performance.source, "unavailable");
}

// --- pickLatestVersion ------------------------------------------------------
eq("latest undefined", pickLatestVersion(undefined), undefined);
eq(
  "latest picks max, ignores fields",
  pickLatestVersion({ downloads: 9, updated: 1, "0.5.9": 1, "0.5.64": 2, "0.5.7": 3 }),
  "0.5.64"
);

// --- computeHealth: update available + sideload -----------------------------
{
  const h = computeHealth(
    input({
      manifest: manifest({ id: "x", version: "1.2.0" }),
      inCommunityList: true,
      remote: { downloads: 100, updated: NOW, "1.2.0": 10, "1.3.0": 20 },
    }),
    NOW
  );
  eq("update available", h.updateAvailable, true);
  eq("latest version", h.latestVersion, "1.3.0");
  eq("in-list not sideloaded", h.sideloaded, false);
}
{
  const h = computeHealth(
    input({
      manifest: manifest({ id: "x", version: "1.3.0" }),
      inCommunityList: false,
      remote: { downloads: 100, updated: NOW, "1.3.0": 20 },
    }),
    NOW
  );
  eq("no update when current", h.updateAvailable, false);
  eq("absent from list is sideloaded", h.sideloaded, true);
}
{
  const h = computeHealth(input({ inCommunityList: null, muted: true }), NOW);
  eq("unknown sideload when no list", h.sideloaded, null);
  eq("muted flag propagates", h.muted, true);
  eq("no update without remote", h.updateAvailable, false);
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
    sideloaded: false,
    muted: false,
    overall: 90,
    metrics: {
      quality: metric(90),
      maintenance: metric(90),
      performance: metric(90),
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
    buildInsights([ph({ id: "s", sideloaded: true })]).some((i) => i.id === "sideloaded"),
    true
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
