import type { App, PluginManifest } from "obsidian";
import { attributeStack } from "./errors";
import { PRODUCT_ID } from "./product";
import { recordLoad, type RuntimeProfile, type RuntimeProfiles } from "./runtime";

/**
 * FlowKit's own frames, which sit on top of the caller's in any stack captured
 * inside our wrappers. Skipping them is what makes timer attribution point at
 * the plugin that created the timer rather than at the code watching for it.
 */
const IGNORE_SELF: ReadonlySet<string> = new Set([PRODUCT_ID]);

// Measuring what other plugins cost while they run.
//
// Obsidian exposes no per-plugin performance API, so this observes the two
// things it can honestly observe from inside the same process: how long a
// plugin's `onload` takes when FlowKit is present to time it, and what
// repeating timers it creates. Both are recorded only when actually seen —
// nothing here ever infers a cost from absence, because a plugin that loaded
// before FlowKit did is unmeasured, not free.

type SetIntervalFn = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => number;
type ClearIntervalFn = (id?: number) => void;

/** Marks our wrappers, so unload can tell them from someone else's. */
const WRAPPED = Symbol.for("flowkit-runtime-wrapper");

/**
 * A measurement that could not put the plugin back the way it found it.
 *
 * Distinct from "couldn't measure that one", because the consequences are
 * completely different: one is a blank cell in a table, the other is a vault
 * that is not what the user left it as. It carries the id so the UI can name
 * the plugin instead of telling somebody to go and read the console.
 */
export class RestoreFailedError extends Error {
  constructor(
    readonly pluginId: string,
    /** What the plugin's state was before FlowKit touched it. */
    readonly wasEnabled: boolean,
    readonly cause: unknown,
    /** The measurement's own failure, when there was one as well. */
    readonly measureError: unknown = null
  ) {
    super(
      `FlowKit could not switch ${pluginId} back ${wasEnabled ? "on" : "off"} after measuring it.`
    );
    this.name = "RestoreFailedError";
  }
}

/** What one profiling run did, including a plugin it could not restore. */
export interface ProfileRunResult {
  measured: number;
  failed: string[];
  /** Set when the run stopped because a plugin was left in the wrong state. */
  stranded?: RestoreFailedError;
}

/** Obsidian's internal plugin registry — not in the public typings. */
interface InternalPluginsApi {
  manifests: Record<string, PluginManifest>;
  enabledPlugins: Set<string>;
  plugins?: Record<string, unknown>;
  enablePlugin?: (id: string) => Promise<unknown>;
  disablePlugin?: (id: string) => Promise<unknown>;
}

/** The bits of Obsidian's command registry we read. */
interface InternalCommandsApi {
  commands?: Record<string, unknown>;
}

interface AppInternals {
  plugins?: InternalPluginsApi;
  commands?: InternalCommandsApi;
}

/** Obsidian's `Component` keeps its registered cleanups in `_events`. */
interface ComponentInternals {
  _events?: unknown[];
  _children?: unknown[];
}

export interface RuntimeWatcherHost {
  /** Ids of every installed plugin, for stack attribution. */
  installedIds(): Set<string>;
  /** The persisted profile store. Mutated in place. */
  store(): RuntimeProfiles;
  /** Installed version of a plugin, so a load time is tied to the build it timed. */
  versionOf(id: string): string | undefined;
  /** Called after a measurement lands, so the host can persist and re-render. */
  onChange(): void;
}

/** One live repeating timer, and who created it. */
interface LiveTimer {
  pluginId: string;
  period: number;
}

/** What we learned from watching a plugin's callbacks actually run. */
interface TickRecord {
  maxMs: number;
  ticks: number;
}

export class RuntimeWatcher {
  private originalSetInterval: SetIntervalFn | null = null;
  private originalClearInterval: ClearIntervalFn | null = null;
  /**
   * `clearTimeout` is watched too, and only to forget timers.
   *
   * Browsers share one id space between the timeout and interval families, and
   * `clearTimeout(intervalId)` cancels an interval perfectly well — the spec
   * says so and plenty of code does it, usually by holding every handle it owns
   * in one list and clearing them all the same way on unload. That path never
   * reached the `clearInterval` hook, so the timer stayed in the live map for
   * the rest of the session and FlowKit went on reporting a plugin's timer
   * count, its polling period and its slowest callback — all in the present
   * tense, about a timer that had been cancelled.
   *
   * Nothing is measured here and no timeout is attributed: `setTimeout` is
   * deliberately left alone, because a one-shot timer is not a standing cost
   * and wrapping the busiest scheduling function in the process to learn
   * nothing would be a performance tool that costs performance.
   */
  private originalClearTimeout: ClearIntervalFn | null = null;
  private originalEnablePlugin: ((id: string) => Promise<unknown>) | null = null;
  /**
   * The exact functions this watcher installed.
   *
   * Restoration used to test only for the shared `WRAPPED` marker, which every
   * FlowKit wrapper in the process carries — so a second instance, during a
   * hot reload or an overlapping unload, could recognise a *different*
   * watcher's live wrapper as its own and replace it with its own saved
   * predecessor. Identity is the only thing that answers "did I put this here",
   * and it is what makes the restore safe to attempt at all.
   */
  private myTimerWrapper: unknown = null;
  private myClearWrapper: unknown = null;
  private myClearTimeoutWrapper: unknown = null;
  private myLoadWrapper: unknown = null;
  /**
   * The current run's liveness token, or `null` once stopped.
   *
   * Every wrapper this class installs closes over the token that was current
   * when it was installed, and checks THAT rather than a field on the instance.
   *
   * Why anything is made inert at all: FlowKit deliberately declines to restore
   * a global that somebody else has since wrapped, because pulling ours out
   * would take theirs with it — so its wrapper can legitimately remain in the
   * chain after unload, holding this watcher, its host, and through the host
   * the unloaded plugin's settings. Left live, that wrapper went on attributing
   * timers, filling maps, arming a flush timeout, and calling `host.onChange()`
   * — which saves settings and rescans — inside an instance Obsidian has
   * already torn down. The wrapper cannot be removed, so after `stop()` every
   * hook does nothing but call through to what it wrapped.
   *
   * Why that had to become per-run rather than per-instance: an instance-wide
   * `stopped = false` in `start()` REACTIVATED any wrapper a previous run had
   * left behind. `start(); …someone wraps on top…; stop(); start();` then had
   * two live generations of our wrapper in one chain, and a single
   * `setInterval` call traversed both — attributed twice, flushed twice. A
   * stopped run now stays stopped whatever happens next.
   */
  private run: { live: boolean } | null = null;
  /** Repeating timers currently outstanding, keyed by timer id. */
  private live = new Map<number, LiveTimer>();
  /** How long each plugin's timer callbacks actually take to run. */
  private ticks = new Map<string, TickRecord>();
  /** Guards against our own hook re-entering itself. */
  private inHook = false;
  private dirty = false;
  private flushTimer: number | null = null;

  /**
   * How long observations are coalesced before the host is told.
   *
   * A parameter rather than a constant so the tests can drive the flush
   * without sleeping through it: the alternative is a suite that waits five
   * real seconds per assertion about notification, which is how coalescing
   * ends up untested.
   */
  private readonly flushDelayMs: number;

  constructor(
    private app: App,
    private host: RuntimeWatcherHost,
    flushDelayMs = 5000
  ) {
    this.flushDelayMs = flushDelayMs;
  }

  /**
   * Whether the wrappers are currently installed.
   *
   * `start()` had no guard, and the second call was quietly destructive rather
   * than merely redundant: it read `window.setInterval` — by then OUR wrapper —
   * and saved it as `originalSetInterval`. `stop()` then dutifully restored
   * that, so the global was left holding a FlowKit closure which no later
   * `stop()` could ever remove, permanently interposed on a function every
   * other plugin in the vault uses. Each further `start()` laminated another
   * generation on.
   *
   * Nothing in the shipped UI calls `start()` twice today — the runtime toggle
   * asks for a reload — so this is a guard against the next caller rather than
   * a report of a symptom. It belongs here anyway: the identity-based restore
   * in `unwrapTimers` is the whole basis on which this class is allowed to
   * touch a shared global, and that argument collapses if the saved "original"
   * can be one of ours.
   */
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    const run = { live: true };
    this.run = run;
    this.wrapTimers(run);
    this.wrapPluginLoad(run);
  }

  stop(): void {
    // Killed FIRST, and before anything is unwrapped: a wrapper that survives
    // this call must already be inert by the time it can next be entered, and a
    // flush that fires between the unwrap and this line would call back into a
    // host that is being torn down.
    const run = this.run;
    if (run) run.live = false;
    this.run = null;
    this.started = false;
    if (this.flushTimer != null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.dirty = false;
    this.unwrapTimers();
    this.unwrapPluginLoad();
    this.live.clear();
    this.ticks.clear();
  }

  // --- repeating timers -----------------------------------------------------

  /**
   * Watch `setInterval` and attribute each timer to the plugin that created it,
   * using the same stack-reading machinery the error watcher uses.
   *
   * Only timers created after FlowKit loads are seen. That is a real limit and
   * it is why a plugin with no observed timer is never scored as idle — the
   * penalty only ever applies to a timer we watched being created.
   */
  private wrapTimers(run: { live: boolean }): void {
    // Keep the ORIGINAL references for restoring, and bound copies for calling.
    // Storing the bound copy and restoring that instead put a fresh `.bind()`
    // layer on `window.setInterval` every time FlowKit was disabled and
    // re-enabled — so unload never quite gave back what it took, and each cycle
    // added another wrapper to a global other plugins also use.
    const rawSet = window.setInterval;
    const rawClear = window.clearInterval;
    const rawClearTimeout = window.clearTimeout;
    this.originalSetInterval = rawSet;
    this.originalClearInterval = rawClear;
    this.originalClearTimeout = rawClearTimeout;
    const originalSet = rawSet.bind(window) as SetIntervalFn;
    const originalClear = rawClear.bind(window) as ClearIntervalFn;
    const originalClearTimeout = rawClearTimeout.bind(window) as ClearIntervalFn;

    const set = ((handler: TimerHandler, timeout?: number, ...args: unknown[]): number => {
      // Once stopped, this is a pass-through and nothing more. The wrapper can
      // outlive the plugin whenever someone else wrapped on top of it, and
      // measuring a vault on behalf of an instance Obsidian has unloaded is
      // both a leak and a write to settings nobody owns any more.
      if (!run.live) return originalSet(handler, timeout, ...args);
      // Attribute first, so the wrapped callback knows whose time it is
      // spending. A string handler goes through untouched — it runs in global
      // scope via the engine, and there is nothing here to wrap.
      const owner =
        typeof handler === "function"
          ? this.attributeCaller()
          : null;
      const wrappedHandler =
        owner && typeof handler === "function"
          ? this.timeCallback(run, owner, handler as (...a: unknown[]) => unknown)
          : handler;
      const id = originalSet(wrappedHandler, timeout, ...args);
      this.noteTimer(id, timeout, owner);
      return id;
    }) as SetIntervalFn & { [WRAPPED]?: true };
    set[WRAPPED] = true;

    // One body for both families, because the only thing either of them does
    // here is forget a timer, and browsers let `clearTimeout` cancel an
    // interval handle — see `originalClearTimeout`.
    const forget = (original: ClearIntervalFn) =>
      ((id?: number): void => {
        original(id);
        if (!run.live || id == null) return;
        // A timer going away changes the snapshot exactly as much as one being
        // created, and only the creation side said so — so a plugin that
        // stopped polling went on being shown as a poller until something
        // unrelated happened to trigger a re-score.
        const gone = this.live.get(id);
        if (this.live.delete(id)) {
          // The timing record goes with the last of that plugin's timers. It
          // outlived them, and `maxTickMs` is the one reading here that makes
          // a claim in the present tense about something still running.
          if (gone && !this.hasLiveTimer(gone.pluginId)) this.ticks.delete(gone.pluginId);
          this.dirty = true;
          this.scheduleFlush();
        }
      }) as ClearIntervalFn & { [WRAPPED]?: true };

    const clear = forget(originalClear);
    clear[WRAPPED] = true;
    const clearTimer = forget(originalClearTimeout);
    clearTimer[WRAPPED] = true;

    this.myTimerWrapper = set;
    this.myClearWrapper = clear;
    this.myClearTimeoutWrapper = clearTimer;
    window.setInterval = set as unknown as typeof window.setInterval;
    window.clearInterval = clear as unknown as typeof window.clearInterval;
    window.clearTimeout = clearTimer as unknown as typeof window.clearTimeout;
  }

  private unwrapTimers(): void {
    // Identity, not the shared marker: `WRAPPED` says "some FlowKit wrapper",
    // and restoring over another instance's live wrapper would leave that
    // watcher blind while putting back a stale generation of a global other
    // plugins are also using.
    if (this.originalSetInterval && window.setInterval === this.myTimerWrapper) {
      window.setInterval = this.originalSetInterval as unknown as typeof window.setInterval;
    }
    if (this.originalClearInterval && window.clearInterval === this.myClearWrapper) {
      window.clearInterval = this.originalClearInterval as unknown as typeof window.clearInterval;
    }
    if (this.originalClearTimeout && window.clearTimeout === this.myClearTimeoutWrapper) {
      window.clearTimeout = this.originalClearTimeout as unknown as typeof window.clearTimeout;
    }
    // If somebody wrapped these after us, ours stays in the chain — pulling it
    // out would take theirs with it. The dead token is what makes that safe:
    // the survivor is a pass-through holding no state and calling nothing, and
    // no later `start()` can revive it.
    this.originalSetInterval = null;
    this.originalClearInterval = null;
    this.originalClearTimeout = null;
    this.myTimerWrapper = null;
    this.myClearWrapper = null;
    this.myClearTimeoutWrapper = null;
  }

  /**
   * Which plugin is calling us right now, or null for Obsidian's own code, a
   * theme, or FlowKit itself. Unattributable callers are dropped rather than
   * blamed on whatever plugin happens to be nearby.
   */
  private attributeCaller(): string | null {
    if (this.inHook) return null;
    this.inHook = true;
    try {
      // Captured inside our own wrapper, so our frames are innermost — skip
      // them, or every timer in the vault is recorded against FlowKit.
      return attributeStack(new Error().stack, this.host.installedIds(), IGNORE_SELF);
    } catch {
      return null;
    } finally {
      this.inHook = false;
    }
  }

  /**
   * Wrap a timer callback to record how long it runs.
   *
   * Deliberately thin: one `performance.now()` either side and a Map write. The
   * wrapper sits in front of somebody else's code on every tick, so anything
   * expensive here would be a performance tool that degrades performance —
   * and it re-throws untouched, because swallowing another plugin's exception
   * would break it *and* hide it from the error watcher.
   */
  private timeCallback(
    run: { live: boolean },
    pluginId: string,
    handler: (...args: unknown[]) => unknown
  ): (...args: unknown[]) => unknown {
    return (...args: unknown[]): unknown => {
      // Timers created before unload keep firing through this wrapper for as
      // long as their owner holds them, so it has to stop recording too — or a
      // stopped watcher's `ticks` map refills behind it.
      if (!run.live) return handler(...args);
      const started = performance.now();
      try {
        return handler(...args);
      } finally {
        const elapsed = performance.now() - started;
        const record = this.ticks.get(pluginId);
        if (!record) {
          this.ticks.set(pluginId, { maxMs: elapsed, ticks: 1 });
        } else {
          record.ticks++;
          if (elapsed > record.maxMs) record.maxMs = elapsed;
        }
      }
    };
  }

  /** Whether this plugin still holds any repeating timer we are watching. */
  private hasLiveTimer(pluginId: string): boolean {
    for (const timer of this.live.values()) {
      if (timer.pluginId === pluginId) return true;
    }
    return false;
  }

  private noteTimer(id: number, timeout: number | undefined, owner: string | null): void {
    try {
      const period = typeof timeout === "number" && timeout > 0 ? timeout : 0;
      if (!period || !owner) return;
      this.live.set(id, { pluginId: owner, period });
      this.dirty = true;
      this.scheduleFlush();
    } catch {
      // Measuring must never itself become an error the user sees.
    }
  }

  /**
   * Coalesce re-renders. A plugin that recreates a timer on every keystroke
   * would otherwise redraw the dashboard as fast as the user types.
   */
  private scheduleFlush(): void {
    // Belt and braces: nothing should reach here after `stop()`, and if
    // anything does, arming a timeout that calls into an unloaded host is the
    // one outcome worth ruling out twice.
    const run = this.run;
    if (!run?.live || this.flushTimer != null) return;
    // The original, so our own bookkeeping timer never enters the wrapper.
    const timeout = window.setTimeout(() => {
      this.flushTimer = null;
      if (!run.live || !this.dirty) return;
      this.dirty = false;
      this.host.onChange();
    }, this.flushDelayMs);
    this.flushTimer = timeout;
  }

  // --- load timing ----------------------------------------------------------

  /**
   * Time every plugin load that happens while FlowKit is running.
   *
   * At startup this catches only plugins Obsidian loads after us, which is a
   * partial sample — but it also catches every enable the user performs from
   * here or from Obsidian's own settings, so coverage fills in with use, and
   * the row menu offers an explicit re-measure for the rest.
   */
  private wrapPluginLoad(run: { live: boolean }): void {
    const api = (this.app as unknown as AppInternals).plugins;
    if (!api || typeof api.enablePlugin !== "function") return;
    // As with the timers: keep the raw reference to restore, bind a copy to call.
    this.originalEnablePlugin = api.enablePlugin;
    const original = api.enablePlugin.bind(api);

    const wrapper = (async (id: string): Promise<unknown> => {
      // As with the timers: a wrapper somebody else has since wrapped survives
      // unload, and timing loads into a dead instance's settings is worse than
      // not timing them.
      if (!run.live) return original(id);
      const started = performance.now();
      const result = await original(id);
      // Re-checked AFTER the await. A plugin load is the one thing here with a
      // real suspension point in it, so `stop()` can land in the middle of one
      // — and then this would write a measurement into the store of an instance
      // Obsidian has already torn down, which is precisely what the token
      // exists to prevent everywhere else.
      if (!run.live) return result;
      // Recorded only on success. This was in a `finally`, which meant a plugin
      // whose load threw immediately was recorded as having loaded in ~0 ms —
      // a failed load written down as the fastest one in the vault.
      this.noteLoad(id, performance.now() - started);
      return result;
    }) as ((id: string) => Promise<unknown>) & { [WRAPPED]?: true };
    wrapper[WRAPPED] = true;
    this.myLoadWrapper = wrapper;
    api.enablePlugin = wrapper;
  }

  private unwrapPluginLoad(): void {
    const api = (this.app as unknown as AppInternals).plugins;
    if (!api || !this.originalEnablePlugin) return;
    // Identity again — see `unwrapTimers`.
    if (api.enablePlugin === this.myLoadWrapper) {
      api.enablePlugin = this.originalEnablePlugin;
    }
    this.originalEnablePlugin = null;
    this.myLoadWrapper = null;
  }

  private noteLoad(id: string, ms: number): void {
    try {
      const version = this.host.versionOf(id);
      if (!version) return;
      const store = this.host.store();
      store[id] = recordLoad(store[id], ms, version, Date.now());
      this.dirty = true;
      this.scheduleFlush();
    } catch {
      // As above: a measurement failing must not surface as a broken plugin.
    }
  }

  /**
   * Re-measure one plugin by turning it off and on again, timing the load.
   *
   * Deliberately explicit and never automatic. It is the only way to get a real
   * number for a plugin that was already running when FlowKit started, and it
   * genuinely restarts that plugin — anything holding unsaved in-memory state
   * will lose it, which is why the UI says so before running this.
   */
  async measureLoad(id: string): Promise<number | null> {
    const api = (this.app as unknown as AppInternals).plugins;
    if (!api || typeof api.disablePlugin !== "function" || typeof api.enablePlugin !== "function") {
      return null;
    }
    const wasEnabled = api.enabledPlugins?.has(id) ?? false;
    const wrapped = (api.enablePlugin as unknown as { [WRAPPED]?: true })[WRAPPED] === true;
    let ms: number | null = null;
    let measureError: unknown = null;
    try {
      if (wasEnabled) await api.disablePlugin(id);
      const started = performance.now();
      await api.enablePlugin(id);
      ms = performance.now() - started;
      // When the wrapper installed, it already recorded a tighter measurement
      // from inside the call; recording again here would overwrite it with one
      // that includes this method's own overhead.
      if (!wrapped) this.noteLoad(id, ms);
    } catch (err) {
      measureError = err;
      console.error("FlowKit: could not measure the load time for", id, err);
    }

    // Put it back the way it was found, whether or not the measurement worked.
    //
    // This used to sit inside the try, so an enable that threw after the
    // disable had succeeded left the plugin switched off — a diagnostic that
    // silently changed the vault and reported only "couldn't measure that one".
    // It also always enabled, which turned a measurement of a disabled plugin
    // into a decision to run it.
    try {
      if ((api.enabledPlugins?.has(id) ?? false) !== wasEnabled) {
        if (wasEnabled) await api.enablePlugin(id);
        else await api.disablePlugin(id);
      }
      // The API resolving is not the registry having moved.
      if ((api.enabledPlugins?.has(id) ?? false) !== wasEnabled) {
        throw new Error("the plugin registry did not settle");
      }
    } catch (err) {
      throw new RestoreFailedError(id, wasEnabled, err, measureError);
    }
    return ms;
  }

  // --- live readings --------------------------------------------------------

  /** How many commands each installed plugin currently registers. */
  private commandCounts(installed: ReadonlySet<string>): Record<string, number> {
    const out: Record<string, number> = {};
    const commands = (this.app as unknown as AppInternals).commands?.commands;
    if (!commands) return out;
    for (const key of Object.keys(commands)) {
      const cut = key.indexOf(":");
      if (cut <= 0) continue;
      const id = key.slice(0, cut);
      if (!installed.has(id)) continue;
      out[id] = (out[id] ?? 0) + 1;
    }
    return out;
  }

  /** Registered cleanups on a plugin's own component — events, DOM, timers. */
  private handlerCount(id: string): number | undefined {
    const instance = (this.app as unknown as AppInternals).plugins?.plugins?.[id] as
      | ComponentInternals
      | undefined;
    if (!instance) return undefined;
    const events = Array.isArray(instance._events) ? instance._events.length : 0;
    const children = Array.isArray(instance._children) ? instance._children.length : 0;
    return events + children;
  }

  /**
   * The persisted load times, merged with everything observed live this
   * session. The live half is deliberately not persisted: a timer that existed
   * last Tuesday is not evidence about today, and a stale claim of "polls every
   * 200 ms" would be exactly the sort of confident wrongness this product is
   * meant to be the opposite of.
   */
  snapshot(): RuntimeProfiles {
    const installed = this.host.installedIds();
    const stored = this.host.store();
    const commands = this.commandCounts(installed);
    const out: RuntimeProfiles = {};

    for (const id of installed) {
      const base: RuntimeProfile = { ...(stored[id] ?? {}) };
      const count = commands[id];
      if (count != null) base.commands = count;
      const handlers = this.handlerCount(id);
      if (handlers != null) base.handlers = handlers;
      out[id] = base;
    }

    for (const { pluginId, period } of this.live.values()) {
      const profile = out[pluginId];
      if (!profile) continue;
      profile.timers = (profile.timers ?? 0) + 1;
      profile.minIntervalMs =
        profile.minIntervalMs == null ? period : Math.min(profile.minIntervalMs, period);
    }

    for (const [pluginId, record] of this.ticks) {
      const profile = out[pluginId];
      if (!profile) continue;
      // Only while the plugin still holds a timer. `maxTickMs` is phrased and
      // scored as a present-tense cost — "its slowest timer callback blocked
      // the interface for 180 ms" — and a callback that can no longer run is
      // not a cost the vault is paying. A plugin that polled hard during its
      // own startup and then cleared the timer was permanently marked as the
      // heaviest thing in the vault, and the only way out was restarting
      // Obsidian.
      //
      // Asked here rather than relying solely on the `clearInterval` hook
      // because `clearTimeout` clears an interval handle just as well, and
      // that path never reaches our wrapper. `timers` is set just above from
      // the live map, so this is self-correcting whichever way the timer died.
      if (profile.timers == null) continue;
      profile.maxTickMs = record.maxMs;
      profile.ticks = record.ticks;
    }

    return out;
  }

  /**
   * Time every enabled plugin by restarting each in turn.
   *
   * The passive measurement only ever catches plugins Obsidian loads after
   * FlowKit, which on most vaults is a minority — so "why is my vault slow"
   * was answerable for some rows and blank for the rest. This fills the table
   * in one pass, at the cost of genuinely restarting everything, which is why
   * it is explicit, confirmed, and reports progress.
   *
   * @param onProgress called with (done, total, name) after each plugin.
   * @param shouldStop polled between plugins so a long run can be abandoned.
   */
  async profileAll(
    ids: string[],
    onProgress?: (done: number, total: number, id: string) => void,
    shouldStop?: () => boolean
  ): Promise<ProfileRunResult> {
    const failed: string[] = [];
    let measured = 0;
    for (let i = 0; i < ids.length; i++) {
      if (shouldStop?.()) break;
      const id = ids[i];
      let ms: number | null = null;
      try {
        ms = await this.measureLoad(id);
      } catch (err) {
        // A plugin left in the wrong state stops the run. Carrying on would
        // restart another forty plugins on top of a vault that is already not
        // what the user left it as, and bury the one fact they need.
        if (err instanceof RestoreFailedError) {
          return { measured, failed, stranded: err };
        }
        throw err;
      }
      if (ms == null) failed.push(id);
      else measured++;
      onProgress?.(i + 1, ids.length, id);
      // Yield between plugins so the progress notice can actually paint and
      // Obsidian gets a chance to finish each plugin's own load work.
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    return { measured, failed };
  }
}
