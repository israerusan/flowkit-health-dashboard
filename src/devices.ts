// Which device saw what. Kept free of any Obsidian import so the Node test
// suite exercises this exact code.
//
// The problem this exists for: Obsidian syncs plugin SETTINGS and installed
// PLUGINS as two independent options, and plenty of people turn on the first
// without the second — a desktop with forty plugins and a phone with six, both
// sharing one `data.json`.
//
// Every per-plugin store FlowKit keeps was written on the assumption that
// "not installed" means "gone". Under that configuration the assumption is
// false in the most damaging possible way: the phone scans, concludes that
// thirty-four plugins have been uninstalled, deletes their error history,
// their measured load times and their repository readings, and writes thirty-
// four "uninstalled" events into the vault's timeline. The desktop then scans,
// concludes the same about the phone's six, and puts its own thirty-four back
// as fresh installs. The two devices take turns erasing each other's data and
// filling the change history with events that never happened, forever.
//
// The fix is to stop treating one device's view as the truth. What each device
// last saw is recorded under that device, so a plugin missing from this machine
// is merely absent rather than deleted — and a plugin missing from EVERY
// machine for long enough is the only thing that counts as gone.

import type { SeenMap } from "./timeline";

/** What each device last saw installed, keyed by device id. */
export type DeviceSeen = Record<string, SeenMap>;

/**
 * How long a device's record is kept after it stops syncing.
 *
 * The same window as the change history, and for the same reason: a laptop that
 * was replaced six months ago should stop pinning storage for plugins nothing
 * has seen since, but a machine used every few weeks must not be forgotten
 * between uses.
 */
export const DEVICE_RETENTION_MS = 90 * 86_400_000;

/**
 * The id used when this device has no durable local storage of its own.
 *
 * A constant rather than a fresh random id, deliberately: an id that changed on
 * every launch would grow a new bucket per session forever. Devices that land
 * here share one bucket and therefore behave exactly as every device did before
 * any of this existed — no worse, and no unbounded growth.
 */
export const SHARED_DEVICE = "shared";

/** Whether a value is one device's map of plugin id → what was last seen. */
function isSeenMap(value: unknown): value is SeenMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (entry) =>
      entry != null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      typeof (entry as { version?: unknown }).version === "string"
  );
}

/**
 * Read the persisted record, upgrading the pre-1.7 single-device shape.
 *
 * Before this, `seenPlugins` was one flat map with no notion of whose view it
 * was. That map is exactly this device's view — it is the only device that has
 * ever written to this file as far as we can tell — so it is filed under this
 * device's id and nothing is lost or re-announced.
 */
export function migrateSeen(raw: unknown, deviceId: string): DeviceSeen {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.length) return {};

  // A flat map's values are plugin records (they carry `version`); a
  // per-device map's values are themselves maps of those.
  const looksFlat = entries.some(
    ([, value]) =>
      value != null &&
      typeof value === "object" &&
      typeof (value as { version?: unknown }).version === "string"
  );
  if (looksFlat) return { [deviceId]: raw as SeenMap };

  const out: DeviceSeen = {};
  for (const [device, seen] of entries) {
    if (isSeenMap(seen)) out[device] = seen;
  }
  return out;
}

/** When a device last recorded anything, or 0 if it never has. */
function lastActive(seen: SeenMap): number {
  let latest = 0;
  for (const entry of Object.values(seen)) {
    if (entry.at > latest) latest = entry.at;
  }
  return latest;
}

/**
 * Every plugin any still-current device has seen.
 *
 * This is what replaces "installed on this machine" wherever FlowKit decides
 * whether a plugin's stored history is still worth keeping.
 */
export function pluginsKnownToAnyDevice(
  seen: DeviceSeen,
  now: number,
  retentionMs = DEVICE_RETENTION_MS
): Set<string> {
  const known = new Set<string>();
  for (const bucket of Object.values(seen)) {
    if (now - lastActive(bucket) > retentionMs) continue;
    for (const id of Object.keys(bucket)) known.add(id);
  }
  return known;
}

/**
 * Forget devices that have not synced within the retention window.
 *
 * Without this the record only ever grows: every machine the vault has ever
 * been opened on keeps its plugins alive in every other machine's storage.
 */
export function pruneDevices(
  seen: DeviceSeen,
  now: number,
  retentionMs = DEVICE_RETENTION_MS
): DeviceSeen {
  const out: DeviceSeen = {};
  for (const [device, bucket] of Object.entries(seen)) {
    if (now - lastActive(bucket) > retentionMs) continue;
    out[device] = bucket;
  }
  return out;
}

/** How many devices are currently on record, for the settings readout. */
export function deviceCount(seen: DeviceSeen): number {
  return Object.keys(seen).length;
}
