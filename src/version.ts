// Version comparison, with no Obsidian import of any kind.
//
// Extracted from `scoring.ts` because `mutes.ts` needs it and must stay
// importable by the Node test suite directly. It was the only reason the mute
// sweep could not ask "is the running Obsidian NEWER?" and had to settle for
// "is it DIFFERENT?" — which is a different question with a worse answer on
// every synced vault.

/** A version key that names a stable release — no prerelease tag, no build metadata. */
export const STABLE_VERSION_KEY = /^\d+\.\d+(?:\.\d+)?$/;

/**
 * Split `v1.2.3-beta.1` into its numeric parts and its prerelease tag.
 *
 * Build metadata is DISCARDED rather than read as part of the prerelease, which
 * is what semver says and what this did not do. Splitting on `[-+]` together
 * meant `1.0.0+build` parsed as the prerelease "build" — so it sorted BELOW
 * plain `1.0.0`, and an installed `1.2.3+abc` showed an Update badge pointing at
 * the `1.2.3` it already was. It also folded the metadata into a real
 * prerelease tag: `1.0.0-alpha+build` compared on "alpha+build".
 */
function parseVersion(value: string): { parts: number[]; pre: string } {
  const trimmed = String(value ?? "").trim().replace(/^v/i, "");
  const withoutBuild = trimmed.split("+", 1)[0];
  const cut = withoutBuild.indexOf("-");
  const core = cut === -1 ? withoutBuild : withoutBuild.slice(0, cut);
  const pre = cut === -1 ? "" : withoutBuild.slice(cut + 1);
  return { parts: core.split(".").map((x) => parseInt(x, 10) || 0), pre };
}

/**
 * Semver-ish compare. Returns -1, 0, or 1. Missing parts count as 0, a leading
 * `v` is ignored, and a prerelease sorts below its own release (1.0.0-beta <
 * 1.0.0) — which is what stops a `-beta` key in the community stats from being
 * read as a newer version than the stable release the user actually has.
 */
export function compareVersion(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.parts.length, pb.parts.length);
  for (let i = 0; i < len; i++) {
    const x = pa.parts[i] ?? 0;
    const y = pb.parts[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1; // a is the release, b is a prerelease of it
  if (!pb.pre) return -1;
  return comparePrerelease(pa.pre, pb.pre);
}

/**
 * Compare two prerelease tags the way semver specifies, rather than as strings.
 *
 * This was `pa.pre < pb.pre`, which is lexicographic — so `insider.10` sorted
 * BELOW `insider.9`, and every numeric suffix got the wrong order from 10
 * onwards. It mattered the moment `sweepMutes` started asking "is Obsidian
 * NEWER than the version this mute was pinned to", because the answer for a
 * genuine forward update from `1.8.0-insider.9` to `1.8.0-insider.10` was no:
 * the mute survived an update it was written to lapse on, and went on
 * surviving through insider.19 and insider.29.
 *
 * The rule: dot-separated identifiers, compared left to right. Two numeric
 * identifiers compare numerically; a numeric identifier ranks below an
 * alphanumeric one; otherwise they compare as strings. If one tag runs out of
 * identifiers first and everything before matched, the shorter one is lower.
 */
function comparePrerelease(a: string, b: string): number {
  const ia = a.split(".");
  const ib = b.split(".");
  const len = Math.max(ia.length, ib.length);
  for (let i = 0; i < len; i++) {
    const x = ia[i];
    const y = ib[i];
    // One tag ended: `1.0.0-beta` is lower than `1.0.0-beta.1`.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx != null && ny != null) {
      if (nx !== ny) return nx < ny ? -1 : 1;
      continue;
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (nx != null) return -1;
    if (ny != null) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** The numeric parts alone, for callers that build a version string from them. */
export function versionParts(value: string): number[] {
  return parseVersion(value).parts;
}
