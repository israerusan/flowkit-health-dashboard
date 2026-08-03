// Muting, with a reason and an expiry. Kept free of any Obsidian import so the
// Node test suite exercises this exact code.
//
// A permanent mute is a way to make a real problem invisible forever, one click
// at a time, and the old flat id list offered nothing else. Six months later
// nobody remembers why Templater is muted or whether the reason still holds.

/** Why and for how long one plugin is muted. */
export interface MuteRecord {
  /** When it was muted. */
  at: number;
  /** Epoch ms after which the mute lapses, or null for indefinite. */
  until: number | null;
  /**
   * When set, the mute lapses as soon as Obsidian's version differs from this.
   * "It's fine on 1.7.2" is a claim about a specific Obsidian, and an update is
   * exactly the event that invalidates it.
   */
  untilAppVersion?: string;
  /** The user's own note. */
  reason?: string;
}

export type MuteMap = Record<string, MuteRecord>;

export const MUTE_30_DAYS = 30 * 86_400_000;

/**
 * Fold the pre-1.3 flat id list into the record map. Old mutes become
 * indefinite with no reason, which is exactly what they were — inventing an
 * expiry for them would silently un-mute things the user had settled.
 */
export function migrateMutes(
  ignored: unknown,
  mutes: unknown,
  now: number
): MuteMap {
  const out: MuteMap = {};
  if (mutes && typeof mutes === "object" && !Array.isArray(mutes)) {
    for (const [id, value] of Object.entries(mutes as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const rec = value as Partial<MuteRecord>;
      out[id] = {
        at: typeof rec.at === "number" ? rec.at : now,
        until: typeof rec.until === "number" ? rec.until : null,
        untilAppVersion:
          typeof rec.untilAppVersion === "string" ? rec.untilAppVersion : undefined,
        reason: typeof rec.reason === "string" ? rec.reason : undefined,
      };
    }
  }
  if (Array.isArray(ignored)) {
    for (const id of ignored) {
      if (typeof id !== "string" || id in out) continue;
      out[id] = { at: now, until: null };
    }
  }
  return out;
}

export interface MuteSweep {
  /** The mutes still in force. */
  active: MuteMap;
  /** Ids whose mute has just lapsed, so the user can be told rather than surprised. */
  expired: string[];
}

/**
 * Drop mutes that have run out. Returns the survivors and what lapsed, so a
 * plugin quietly reappearing in the counts can be announced as an event instead
 * of looking like a scoring glitch.
 */
export function sweepMutes(
  mutes: MuteMap,
  now: number,
  appVersion: string
): MuteSweep {
  const active: MuteMap = {};
  const expired: string[] = [];
  for (const [id, rec] of Object.entries(mutes)) {
    const lapsedByTime = rec.until != null && rec.until <= now;
    const lapsedByUpdate =
      rec.untilAppVersion != null && rec.untilAppVersion !== appVersion;
    if (lapsedByTime || lapsedByUpdate) expired.push(id);
    else active[id] = rec;
  }
  return { active, expired };
}

/** One line describing a live mute, for the row and the settings list. */
export function describeMute(rec: MuteRecord, now: number): string {
  const parts: string[] = [];
  if (rec.until != null) {
    const days = Math.max(0, Math.ceil((rec.until - now) / 86_400_000));
    parts.push(days <= 1 ? "lapses today" : `lapses in ${days} days`);
  } else if (rec.untilAppVersion) {
    parts.push(`until Obsidian updates from ${rec.untilAppVersion}`);
  } else {
    parts.push("indefinitely");
  }
  if (rec.reason) parts.push(`“${rec.reason}”`);
  return parts.join(" · ");
}

/** Build a record for one of the three offered durations. */
export function buildMute(
  kind: "30d" | "until-update" | "forever",
  now: number,
  appVersion: string,
  reason?: string
): MuteRecord {
  const trimmed = reason?.trim() || undefined;
  if (kind === "30d") return { at: now, until: now + MUTE_30_DAYS, reason: trimmed };
  if (kind === "until-update") {
    return { at: now, until: null, untilAppVersion: appVersion, reason: trimmed };
  }
  return { at: now, until: null, reason: trimmed };
}
