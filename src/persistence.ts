// Persistence and scan plumbing, deliberately free of any Obsidian import so
// the Node test suite exercises this exact code rather than a restatement of
// it. The save queue in particular is the sort of thing that looks obviously
// correct and is not.

import type { RemoteCache } from "./types";

/**
 * Serialises writes to a single destination without weakening what awaiting one
 * means.
 *
 * The problem it solves: five independent things write FlowKit's settings — the
 * foreground scan, the six-hourly background pass, both watchers, the detached
 * repository lookups, and every user action — and overlapping `saveData` calls
 * can complete out of order, so an older state can be the one that lands last.
 *
 * The trap it avoids: collapsing concurrent requests into one write is exactly
 * what you want for throughput, and exactly what breaks a durability barrier if
 * done by resolving callers early. `await save()` is used here as a real
 * barrier — the bisect recovery record is written before a single plugin is
 * switched off — so the guarantee has to survive the optimisation:
 *
 *   when a caller's promise resolves, a write that included that caller's
 *   mutations has completed successfully.
 *
 * A revision counter gives that. Each request takes the next revision; each
 * physical write records the highest revision it covered; a caller returns only
 * once a completed write covers its own. A failed write rejects the caller that
 * ran it — it is entitled to know its state is not on disk — while callers
 * queued behind it fall through to attempt their own newer snapshot rather than
 * inheriting a verdict on a write that never contained their mutations.
 */
export class SaveQueue<T> {
  private requested = 0;
  private saved = 0;
  private pending: { revision: number; state: T } | null = null;
  private inFlight: Promise<void> | null = null;

  /**
   * @param snapshot captures the state to persist. Taken when `save()` is
   *   CALLED, not when the write eventually runs — that distinction is the
   *   whole correctness argument. Reading the live object at write time looks
   *   equivalent and is not: settings fields here are replaced and cleared
   *   wholesale, not only added to, so a write that starts later can contain
   *   *less* than the caller that requested it. A caller would then be resolved
   *   over a disk state that never held its mutation, which is precisely the
   *   guarantee bisect leans on before it switches anything off.
   * @param write persists one captured state.
   */
  constructor(
    private readonly snapshot: () => T,
    private readonly write: (state: T) => Promise<void>
  ) {}

  async save(): Promise<void> {
    const wanted = ++this.requested;
    // Capture now. A later request supersedes this one — that is correct, and
    // it is not the same thing as losing it: the newer snapshot was taken after
    // this caller's mutation, so it contains it unless something deliberately
    // changed it in between, which is what "last writer wins" means.
    this.pending = { revision: wanted, state: this.snapshot() };
    while (this.saved < wanted) {
      if (this.inFlight) {
        // Someone else's write is running. It may already cover this caller;
        // if not, the next pass starts one that does.
        //
        // Its failure is NOT this caller's failure. Inheriting the rejection
        // here was wrong twice over: this caller was told its state didn't
        // reach disk when its snapshot had never been attempted, and — worse —
        // the loop exited, so that snapshot sat in `pending` unwritten until
        // something else happened to call `save()`. `await saveSettings()` is
        // used as a durability barrier before bisect switches a plugin off, so
        // "somebody else's write failed" must mean "try mine", not "give up on
        // both". Swallowing it is safe because the loop is the only way out:
        // this caller now runs its own write, and rejects only if that fails.
        await this.inFlight.catch(() => undefined);
        continue;
      }
      const job = this.pending;
      // Nothing queued but the counter says otherwise: only reachable if a
      // write failed after taking the job. Re-capture rather than stall.
      const next = job ?? { revision: this.requested, state: this.snapshot() };
      this.pending = null;
      const run = this.runWrite(next);
      this.inFlight = run;
      try {
        await run;
      } finally {
        if (this.inFlight === run) this.inFlight = null;
      }
    }
  }

  private async runWrite(job: { revision: number; state: T }): Promise<void> {
    await this.write(job.state);
    if (job.revision > this.saved) this.saved = job.revision;
  }

  /** Whether every request so far has reached the destination. */
  get settled(): boolean {
    return this.saved >= this.requested;
  }
}

/**
 * A detached copy of persisted state.
 *
 * Everything FlowKit stores is JSON — it is written with `saveData`, which
 * stringifies it — so the round trip is faithful, and `structuredClone` is used
 * where it exists because it is materially faster on the larger objects here
 * (the community projection alone carries an entry per installed plugin and a
 * 101-point distribution).
 */
export function cloneState<T>(value: T): T {
  // Referenced unqualified rather than through a global object: this module is
  // deliberately environment-free (it is the one the Node test suite drives
  // directly), and there is no window to reach for here.
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Run `fn` over `items` a few at a time, returning results in INPUT order.
 *
 * Order is the whole reason this isn't three lines of `Promise.all` chunking:
 * the results become table rows, and a pool that appended on completion would
 * shuffle equal-scoring plugins into a different order on every scan.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  // `all`, not `allSettled`: the callers here are already defensive, and a
  // genuine throw should fail the scan rather than leave holes in the table.
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker())
  );
  return out;
}

/**
 * Whether a persisted community projection can be trusted whole.
 *
 * All-or-nothing on purpose. `computeAll` reads `cache?.plugins[id]`, where the
 * optional chain stops at the cache and not at the map inside it, so a
 * sync-mangled object took the whole scan down. But a *partial* check is worse
 * than none: a cache that passes it keeps its `at`, which suppresses the
 * refetch that would replace it, and keeps its `hadStats`/`hadList`, which is
 * what the header uses to tell the user how much of the score is real. Half
 * valid doesn't degrade the product, it makes it lie.
 */
export function isUsableCache(cache: unknown): cache is RemoteCache {
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) return false;
  const c = cache as Partial<RemoteCache>;
  if (typeof c.at !== "number" || !Number.isFinite(c.at)) return false;
  if (!c.plugins || typeof c.plugins !== "object" || Array.isArray(c.plugins)) return false;
  if (!Array.isArray(c.distribution)) return false;
  if (c.distribution.some((n) => typeof n !== "number" || !Number.isFinite(n))) return false;
  if (typeof c.hadStats !== "boolean" || typeof c.hadList !== "boolean") return false;
  if (!isOptionalTime(c.statsAt) || !isOptionalTime(c.listAt)) return false;
  // The entries, not just the container. The check validated the shell and
  // stopped, while the paragraph above promised all-or-nothing — so a
  // sync-mangled row (a string where a record belongs, a download count of
  // `null`, a `listed` that is the string "true") passed the guard and went
  // straight into scoring, where `listed` being truthy is the difference
  // between "installed outside the directory" and "Obsidian pulled this".
  for (const entry of Object.values(c.plugins)) {
    if (!isUsableEntry(entry)) return false;
  }
  return true;
}

function isOptionalTime(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

/** One cached plugin row, checked field by field. */
function isUsableEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  if (!isOptionalNumber(e.downloads)) return false;
  if (!isOptionalNumber(e.updated)) return false;
  if (!isOptionalNumber(e.latestDownloads)) return false;
  if (!isOptionalNumber(e.releases)) return false;
  if (!isOptionalString(e.latest)) return false;
  if (!isOptionalString(e.repo)) return false;
  if (e.listed !== undefined && typeof e.listed !== "boolean") return false;
  return true;
}
