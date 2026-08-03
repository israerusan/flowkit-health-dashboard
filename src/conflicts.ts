// Plugins that get in each other's way. Kept free of any Obsidian import so the
// Node test suite exercises this exact code.
//
// Every other signal in FlowKit judges one plugin in isolation, which misses an
// entire class of "my vault feels broken": two plugins that are each perfectly
// healthy, both bound to Ctrl+Shift+T, so one of them silently never fires. No
// per-plugin score can ever surface that, because neither plugin is at fault.

/** One command as Obsidian's registry describes it. */
export interface CommandRow {
  /** `pluginId:commandId` for plugin commands; `editor:…`/`app:…` for core. */
  id: string;
  name: string;
  /** The command's default hotkeys, as declared by whoever registered it. */
  hotkeys?: Hotkey[];
}

export interface Hotkey {
  modifiers?: string[];
  key?: string;
}

export interface ConflictInput {
  commands: CommandRow[];
  /**
   * The user's own bindings, keyed by command id. An entry here REPLACES the
   * command's defaults — including an empty array, which is how Obsidian
   * records "I removed this binding", so treating it as "no override" would
   * report a conflict the user has already resolved by hand.
   */
  customKeys: Record<string, Hotkey[]>;
  /** Installed plugin ids, so a command prefix can be attributed. */
  installed: ReadonlySet<string>;
  /** Display names, for readable output. */
  names: Record<string, string>;
  /**
   * What `Mod` means on this machine — Ctrl on Windows/Linux, Meta on macOS.
   *
   * Passed in rather than read here, because this module is deliberately free
   * of any Obsidian import so the Node suite drives it directly. Defaults to
   * Ctrl, which is the majority platform and the one where the bug this fixes
   * actually bites.
   */
  mod?: ModKey;
}

export type ConflictKind = "hotkey" | "command-name";

export interface ConflictParty {
  /** Owning plugin id, or null for one of Obsidian's own commands. */
  pluginId: string | null;
  /** Plugin name, or "Obsidian". */
  owner: string;
  commandId: string;
  commandName: string;
}

export interface Conflict {
  kind: ConflictKind;
  /** The contested thing: a printed chord, or a command name. */
  subject: string;
  parties: ConflictParty[];
  /** Plugin ids involved (excludes Obsidian itself). */
  ids: string[];
}

/** Obsidian's own command namespaces. Anything else is a plugin id. */
function ownerOf(
  commandId: string,
  installed: ReadonlySet<string>,
  names: Record<string, string>
): { pluginId: string | null; owner: string } {
  const cut = commandId.indexOf(":");
  if (cut > 0) {
    const prefix = commandId.slice(0, cut);
    if (installed.has(prefix)) {
      return { pluginId: prefix, owner: names[prefix] ?? prefix };
    }
  }
  return { pluginId: null, owner: "Obsidian" };
}

/**
 * The concrete modifier `Mod` stands for on this machine.
 *
 * Obsidian's modifier union is `Mod | Ctrl | Meta | Shift | Alt`, where `Mod`
 * is a platform alias: Ctrl on Windows and Linux, Meta on macOS.
 */
export type ModKey = "Ctrl" | "Meta";

/**
 * Modifier order varies by platform and by who registered it; sort it away —
 * and resolve `Mod` to what it actually means here before doing so.
 *
 * Without the resolution this function reported `Mod+T` and `Ctrl+T` as two
 * different chords, so two plugins bound to the same physical keystroke on
 * Windows produced NO conflict. That is precisely the case this whole file
 * exists to catch: the shortcut that silently never fires, which nothing in
 * Obsidian's own UI will tell you about. Both spellings are common in the wild
 * — `Mod` is the documented one, `Ctrl` is what plugins written on Windows
 * tend to hard-code — so the miss was the likely case, not the exotic one.
 *
 * Deduplicated after resolving, so `Mod+Ctrl+T` doesn't print `Ctrl+Ctrl+T`.
 */
export function printChord(hotkey: Hotkey, mod: ModKey = "Ctrl"): string | null {
  const key = (hotkey.key ?? "").trim();
  if (!key) return null;
  const mods = [
    ...new Set(
      (hotkey.modifiers ?? [])
        .map((m) => m.trim())
        .filter(Boolean)
        .map((m) => (m === "Mod" ? mod : m))
    ),
  ].sort();
  return [...mods, key.toUpperCase()].join("+");
}

/**
 * The bindings actually in effect for a command: the user's override when there
 * is one, the declared defaults otherwise.
 */
function effectiveHotkeys(cmd: CommandRow, customKeys: Record<string, Hotkey[]>): Hotkey[] {
  const custom = customKeys[cmd.id];
  if (custom !== undefined) return custom;
  return cmd.hotkeys ?? [];
}

/**
 * Chords claimed by more than one owner.
 *
 * Only cross-owner collisions are reported. One plugin binding the same chord
 * to two of its own commands is its own business — and usually deliberate, for
 * a toggle — whereas two different plugins claiming one chord is a thing the
 * user did not choose and cannot see from anywhere in Obsidian's UI.
 */
export function findConflicts(input: ConflictInput): Conflict[] {
  const byChord = new Map<string, ConflictParty[]>();
  const byName = new Map<string, ConflictParty[]>();

  for (const cmd of input.commands) {
    const { pluginId, owner } = ownerOf(cmd.id, input.installed, input.names);
    const party: ConflictParty = {
      pluginId,
      owner,
      commandId: cmd.id,
      commandName: cmd.name,
    };

    for (const hotkey of effectiveHotkeys(cmd, input.customKeys)) {
      const chord = printChord(hotkey, input.mod ?? "Ctrl");
      if (!chord) continue;
      const list = byChord.get(chord) ?? [];
      list.push(party);
      byChord.set(chord, list);
    }

    // Only plugin commands are considered for name collisions. Core commands
    // are namespaced in the palette by their category, and a plugin echoing a
    // core name ("Toggle bold") is normal.
    if (pluginId && cmd.name.trim()) {
      const key = cmd.name.trim().toLowerCase();
      const list = byName.get(key) ?? [];
      list.push(party);
      byName.set(key, list);
    }
  }

  const conflicts: Conflict[] = [];

  for (const [chord, parties] of byChord) {
    const owners = new Set(parties.map((p) => p.pluginId ?? "@obsidian"));
    if (parties.length < 2 || owners.size < 2) continue;
    // At least one side must be an installed plugin: two core commands sharing
    // a chord is Obsidian's business, and the user can't act on it here.
    const ids = [...new Set(parties.map((p) => p.pluginId).filter((v): v is string => v != null))];
    if (!ids.length) continue;
    conflicts.push({ kind: "hotkey", subject: chord, parties, ids });
  }

  for (const [, parties] of byName) {
    const owners = new Set(parties.map((p) => p.pluginId));
    if (parties.length < 2 || owners.size < 2) continue;
    const ids = [...new Set(parties.map((p) => p.pluginId).filter((v): v is string => v != null))];
    conflicts.push({
      kind: "command-name",
      subject: parties[0].commandName,
      parties,
      ids,
    });
  }

  // Hotkeys first — a shadowed binding is a thing that silently doesn't work,
  // where a duplicate name is only ever a moment of confusion in the palette.
  return conflicts.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "hotkey" ? -1 : 1;
    return a.subject.localeCompare(b.subject);
  });
}

/** Conflicts involving one plugin, for its detail panel. */
export function conflictsFor(conflicts: Conflict[], id: string): Conflict[] {
  return conflicts.filter((c) => c.ids.includes(id));
}

/** One line describing a conflict, from the point of view of one plugin. */
export function describeConflict(conflict: Conflict, id: string): string {
  const mine = conflict.parties.find((p) => p.pluginId === id);
  const others = conflict.parties.filter((p) => p.pluginId !== id);
  const otherNames = [...new Set(others.map((p) => p.owner))].join(", ");
  if (conflict.kind === "hotkey") {
    return `${conflict.subject} is also claimed by ${otherNames}${
      mine ? ` — only one of these fires${mine.commandName ? ` (yours: “${mine.commandName}”)` : ""}` : ""
    }.`;
  }
  return `“${conflict.subject}” is a command name it shares with ${otherNames} — they are indistinguishable in the command palette.`;
}
