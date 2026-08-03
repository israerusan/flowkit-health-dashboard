import type { App, PluginManifest } from "obsidian";
import { attributeStack } from "./errors";
import { recordLoad, type RuntimeProfile, type RuntimeProfiles } from "./runtime";

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
  private originalEnablePlugin: ((id: string) => Promise<unknown>) | null = null;
  /** Repeating timers currently outstanding, keyed by timer id. */
  private live = new Map<number, LiveTimer>();
  /** How long each plugin's timer callbacks actually take to run. */
  private ticks = new Map<string, TickRecord>();
  /** Guards against our own hook re-entering itself. */
  private inHook = false;
  private dirty = false;
  private flushTimer: number | null = null;

  constructor(
    private app: App,
    private host: RuntimeWatcherHost
  ) {}

  start(): void {
    this.wrapTimers();
    this.wrapPluginLoad();
  }

  stop(): void {
    if (this.flushTimer != null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
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
  private wrapTimers(): void {
    // Keep the ORIGINAL references for restoring, and bound copies for calling.
    // Storing the bound copy and restoring that instead put a fresh `.bind()`
    // layer on `window.setInterval` every time FlowKit was disabled and
    // re-enabled — so unload never quite gave back what it took, and each cycle
    // added another wrapper to a global other plugins also use.
    const rawSet = window.setInterval;
    const rawClear = window.clearInterval;
    this.originalSetInterval = rawSet;
    this.originalClearInterval = rawClear;
    const originalSet = rawSet.bind(window) as SetIntervalFn;
    const originalClear = rawClear.bind(window) as ClearIntervalFn;

    const set = ((handler: TimerHandler, timeout?: number, ...args: unknown[]): number => {
      // Attribute first, so the wrapped callback knows whose time it is
      // spending. A string handler goes through untouched — it runs in global
      // scope via the engine, and there is nothing here to wrap.
      const owner =
        typeof handler === "function"
          ? this.attributeCaller()
          : null;
      const wrappedHandler =
        owner && typeof handler === "function"
          ? this.timeCallback(owner, handler as (...a: unknown[]) => unknown)
          : handler;
      const id = originalSet(wrappedHandler, timeout, ...args);
      this.noteTimer(id, timeout, owner);
      return id;
    }) as SetIntervalFn & { [WRAPPED]?: true };
    set[WRAPPED] = true;

    const clear = ((id?: number): void => {
      originalClear(id);
      if (id != null) this.live.delete(id);
    }) as ClearIntervalFn & { [WRAPPED]?: true };
    clear[WRAPPED] = true;

    window.setInterval = set as unknown as typeof window.setInterval;
    window.clearInterval = clear as unknown as typeof window.clearInterval;
  }

  private unwrapTimers(): void {
    const currentSet = window.setInterval as unknown as { [WRAPPED]?: true };
    if (this.originalSetInterval && currentSet[WRAPPED]) {
      window.setInterval = this.originalSetInterval as unknown as typeof window.setInterval;
    }
    const currentClear = window.clearInterval as unknown as { [WRAPPED]?: true };
    if (this.originalClearInterval && currentClear[WRAPPED]) {
      window.clearInterval = this.originalClearInterval as unknown as typeof window.clearInterval;
    }
    // If somebody wrapped these after us, leaving ours in place is the lesser
    // harm: it delegates to the original and only writes to a Map we drop.
    this.originalSetInterval = null;
    this.originalClearInterval = null;
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
      return attributeStack(new Error().stack, this.host.installedIds());
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
    pluginId: string,
    handler: (...args: unknown[]) => unknown
  ): (...args: unknown[]) => unknown {
    return (...args: unknown[]): unknown => {
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
    if (this.flushTimer != null) return;
    // The original, so our own bookkeeping timer never enters the wrapper.
    const timeout = window.setTimeout(() => {
      this.flushTimer = null;
      if (!this.dirty) return;
      this.dirty = false;
      this.host.onChange();
    }, 5000);
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
  private wrapPluginLoad(): void {
    const api = (this.app as unknown as AppInternals).plugins;
    if (!api || typeof api.enablePlugin !== "function") return;
    // As with the timers: keep the raw reference to restore, bind a copy to call.
    this.originalEnablePlugin = api.enablePlugin;
    const original = api.enablePlugin.bind(api);

    const wrapper = (async (id: string): Promise<unknown> => {
      const started = performance.now();
      const result = await original(id);
      // Recorded only on success. This was in a `finally`, which meant a plugin
      // whose load threw immediately was recorded as having loaded in ~0 ms —
      // a failed load written down as the fastest one in the vault.
      this.noteLoad(id, performance.now() - started);
      return result;
    }) as ((id: string) => Promise<unknown>) & { [WRAPPED]?: true };
    wrapper[WRAPPED] = true;
    api.enablePlugin = wrapper;
  }

  private unwrapPluginLoad(): void {
    const api = (this.app as unknown as AppInternals).plugins;
    if (!api || !this.originalEnablePlugin) return;
    const current = api.enablePlugin as unknown as { [WRAPPED]?: true } | undefined;
    if (current?.[WRAPPED]) api.enablePlugin = this.originalEnablePlugin;
    this.originalEnablePlugin = null;
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
    try {
      if (wasEnabled) await api.disablePlugin(id);
      const started = performance.now();
      await api.enablePlugin(id);
      const ms = performance.now() - started;
      // When the wrapper installed, it already recorded a tighter measurement
      // from inside the call; recording again here would overwrite it with one
      // that includes this method's own overhead.
      if (!wrapped) this.noteLoad(id, ms);
      return ms;
    } catch (err) {
      console.error("FlowKit: could not measure the load time for", id, err);
      return null;
    }
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
  ): Promise<{ measured: number; failed: string[] }> {
    const failed: string[] = [];
    let measured = 0;
    for (let i = 0; i < ids.length; i++) {
      if (shouldStop?.()) break;
      const id = ids[i];
      const ms = await this.measureLoad(id);
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
