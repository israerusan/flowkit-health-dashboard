// Binary search for the plugin that is breaking your vault. Kept free of any
// Obsidian import so the Node test suite exercises this exact code.
//
// "Disable half your plugins and see if it goes away" is the answer given in
// every Obsidian support thread, and it is correct — it is also twenty minutes
// of tedious clicking that people abandon halfway through, having forgotten
// which half they were on and which plugins were off to begin with. Five rounds
// finds one culprit out of forty. This runs those rounds.

/** Where a session is up to. */
export interface BisectState {
  /** Plugins still possibly responsible, narrowing each round. */
  candidates: string[];
  /**
   * Everything that was enabled when the session began. This is what "restore"
   * means, and it is the reason the session is persisted: a user who has to
   * restart Obsidian to reproduce their problem must not come back to a vault
   * with half its plugins off and no record of which.
   */
  originalEnabled: string[];
  /** The subset currently switched off, for this round. */
  disabled: string[];
  /** 1-based, for "round 3 of 6". */
  round: number;
  /** How many rounds this can take at most, known from the start. */
  maxRounds: number;
  /** When the session started. */
  startedAt: number;
  /** What the user is testing for, in their words. */
  symptom?: string;
  done: boolean;
  /** The plugin responsible, once found. */
  culprit?: string;
  /**
   * Set when every candidate was eliminated: the symptom survived with all of
   * them off, so no installed plugin is causing it. A real and useful answer —
   * it points at a theme, a CSS snippet, Obsidian itself, or the vault.
   */
  exonerated?: boolean;
}

/**
 * Questions needed to isolate one item from `n`.
 *
 * Halving takes log2(n) rounds to get down to a single suspect, plus one more
 * to actually switch that suspect off and confirm. The confirming round is not
 * padding: without it the last plugin standing is accused on the strength of
 * its siblings' innocence, and "no plugin is responsible" becomes an outcome
 * the search can never report.
 */
export function roundsNeeded(n: number): number {
  return n <= 1 ? 1 : Math.ceil(Math.log2(n)) + 1;
}

/**
 * The half to switch off this round.
 *
 * Always the FIRST half, and always a strict subset — with two candidates left
 * this disables exactly one, so the answer to "is it gone?" is decisive either
 * way. Splitting 2 into 2-and-0 would ask a question whose answer eliminates
 * nothing and loops forever.
 */
function halfOf(candidates: string[]): string[] {
  return candidates.slice(0, Math.ceil(candidates.length / 2));
}

/**
 * Open a session. `candidates` is what will be searched; anything enabled but
 * not a candidate stays on throughout, so the vault keeps working as normally
 * as it can while the search runs.
 */
export function beginBisect(
  candidates: string[],
  originalEnabled: string[],
  startedAt: number,
  symptom?: string
): BisectState {
  const unique = [...new Set(candidates)];
  return {
    candidates: unique,
    originalEnabled: [...new Set(originalEnabled)],
    disabled: halfOf(unique),
    round: 1,
    maxRounds: roundsNeeded(unique.length),
    startedAt,
    symptom,
    done: unique.length === 0,
    exonerated: unique.length === 0 ? true : undefined,
  };
}

/**
 * Answer this round's question and get the next state.
 *
 * @param gone whether the symptom disappeared with `state.disabled` switched
 *   off. If it did, the culprit is among the plugins we just turned off; if it
 *   didn't, those are innocent and it is among the ones still running.
 */
export function bisectStep(state: BisectState, gone: boolean): BisectState {
  if (state.done) return state;

  const suspects = gone
    ? state.disabled
    : state.candidates.filter((id) => !state.disabled.includes(id));

  // One suspect left, and the symptom went away when it was switched off: that
  // is the proof, and the search is over.
  if (suspects.length === 1 && gone) {
    return {
      ...state,
      candidates: suspects,
      // Leave the culprit switched off: it is the one thing the user certainly
      // wants off, and re-enabling it to then offer to disable it again would
      // be theatre.
      disabled: suspects,
      round: state.round + 1,
      done: true,
      culprit: suspects[0],
    };
  }

  // One suspect left because everything ELSE was cleared — but this one has
  // never actually been switched off, so nothing has been proved about it yet.
  // Concluding here would name a culprit on the strength of its siblings'
  // innocence, and would make "the problem isn't a plugin at all" an outcome
  // this search could never reach. One more round settles it either way.
  if (suspects.length === 1) {
    return {
      ...state,
      candidates: suspects,
      disabled: suspects,
      round: state.round + 1,
    };
  }

  if (suspects.length === 0) {
    // The symptom outlived every candidate. Not a failure — an answer.
    return {
      ...state,
      candidates: [],
      disabled: [],
      round: state.round + 1,
      done: true,
      exonerated: true,
    };
  }

  return {
    ...state,
    candidates: suspects,
    disabled: halfOf(suspects),
    round: state.round + 1,
  };
}

/**
 * What the vault should look like right now: everything originally enabled,
 * minus whatever this round has switched off.
 *
 * Expressed as a target state rather than as a diff, so a session that survives
 * an Obsidian restart — or a user toggling something by hand mid-run —
 * converges rather than drifting.
 */
export function desiredState(state: BisectState): {
  enable: string[];
  disable: string[];
} {
  const off = new Set(state.disabled);
  return {
    enable: state.originalEnabled.filter((id) => !off.has(id)),
    disable: state.originalEnabled.filter((id) => off.has(id)),
  };
}

/** Putting everything back exactly as it was. */
export function restoreState(state: BisectState): {
  enable: string[];
  disable: string[];
} {
  return { enable: [...state.originalEnabled], disable: [] };
}

/** The question to put to the user this round. */
export function describeRound(state: BisectState): string {
  const n = state.disabled.length;
  return `FlowKit has switched off ${n} plugin${n === 1 ? "" : "s"}. Reproduce what you were seeing, then tell it whether the problem is still there.`;
}

/** How many plugins are still in the frame. */
export function remainingText(state: BisectState): string {
  const n = state.candidates.length;
  if (state.done) return state.culprit ? "Found it." : "No plugin was responsible.";
  return `${n} plugin${n === 1 ? "" : "s"} still possible · round ${state.round} of ${state.maxRounds}`;
}
