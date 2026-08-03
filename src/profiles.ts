// Named sets of enabled plugins. Kept free of any Obsidian import so the Node
// test suite exercises this exact code.
//
// This is the one capability here that genuinely cannot be done by hand in
// thirty seconds: switching twenty plugins on and eighteen off, correctly, is
// several minutes of clicking that nobody does twice. It is also what makes
// bisect safe to start — there is always a recorded way back.

export interface PluginProfile {
  /** User-chosen, and the identity: saving over a name replaces it. */
  name: string;
  /** Plugin ids that should be enabled. */
  ids: string[];
  /** When it was captured or last overwritten. */
  at: number;
}

/** The name FlowKit uses for the automatic pre-bisect capture. */
export const AUTO_SNAPSHOT = "Before last bisect";

/** Save (or overwrite) a profile, newest first. */
export function saveProfile(
  profiles: PluginProfile[],
  name: string,
  ids: string[],
  at: number
): PluginProfile[] {
  const trimmed = name.trim();
  if (!trimmed) return profiles;
  const rest = profiles.filter((p) => p.name !== trimmed);
  return [{ name: trimmed, ids: [...new Set(ids)].sort(), at }, ...rest];
}

export function deleteProfile(profiles: PluginProfile[], name: string): PluginProfile[] {
  return profiles.filter((p) => p.name !== name);
}

export interface ProfileDelta {
  /** Installed plugins the profile wants on that are currently off. */
  enable: string[];
  /** Currently on that the profile wants off. */
  disable: string[];
  /**
   * Ids in the profile that are no longer installed. Reported rather than
   * silently skipped: a profile that quietly does less than it says is how a
   * "known-good" set stops being known-good.
   */
  missing: string[];
}

/**
 * What applying this profile would change.
 *
 * Scoped to installed plugins throughout — a profile captured on a desktop and
 * synced to a phone will name plugins that aren't there, and trying to enable
 * them would fail one at a time with no explanation.
 */
export function profileDelta(
  profile: PluginProfile,
  installed: ReadonlySet<string>,
  enabled: ReadonlySet<string>
): ProfileDelta {
  const want = new Set(profile.ids);
  const enable: string[] = [];
  const disable: string[] = [];
  const missing: string[] = [];

  for (const id of profile.ids) {
    if (!installed.has(id)) {
      missing.push(id);
      continue;
    }
    if (!enabled.has(id)) enable.push(id);
  }
  for (const id of enabled) {
    if (installed.has(id) && !want.has(id)) disable.push(id);
  }
  return { enable: enable.sort(), disable: disable.sort(), missing: missing.sort() };
}

/** Whether applying this profile would do anything at all. */
export function isNoop(delta: ProfileDelta): boolean {
  return delta.enable.length === 0 && delta.disable.length === 0;
}
