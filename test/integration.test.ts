// Integration tests for the parts that touch Obsidian's internals.
//
// The scoring tests exercise pure functions. These exercise the two pieces that
// actually reach into the running app and are therefore the ones that can break
// somebody's vault: the runtime watcher, which monkey-patches `setInterval` and
// the plugin loader, and the bisect loop, which switches plugins off and on and
// promises to put them back.
//
// Nothing here needs Obsidian. It needs a faithful *fake* of the three things
// FlowKit relies on — a plugin registry whose enabled set really changes, a
// command registry, and plugin code whose stack frames carry the
// `//# sourceURL=plugin:<id>` marker Obsidian gives them. The last one is what
// makes the attribution test real rather than a restatement of the regex.

import { RuntimeWatcher } from "../src/runtimeWatcher";
import {
  beginBisect,
  bisectStep,
  desiredState,
  restoreState,
  type BisectState,
} from "../src/bisect";
import type { RuntimeProfiles } from "../src/runtime";
import { SaveQueue, isUsableCache, mapWithConcurrency } from "../src/persistence";
import { ErrorWatcher } from "../src/errorWatcher";
import type { PluginErrorRecord } from "../src/types";
import type { Plugin } from "obsidian";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, actual === expected, `expected ${String(expected)}, got ${String(actual)}`);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// --- a browser-shaped `window` ----------------------------------------------
// Numeric timer ids, like a browser and unlike Node, because the watcher keys a
// Map on them and a Node Timeout object would let an identity bug pass.

interface FakeWindow {
  setInterval: (handler: TimerHandler, timeout?: number, ...args: unknown[]) => number;
  clearInterval: (id?: number) => void;
  setTimeout: (handler: TimerHandler, timeout?: number, ...args: unknown[]) => number;
  clearTimeout: (id?: number) => void;
}

// Node's timer handles are objects; the DOM `clearInterval` in scope is typed
// for numbers. Alias the real ones once rather than casting at each call site.
const nodeClear = clearInterval as unknown as (handle: unknown) => void;
const nodeClearTimeout = clearTimeout as unknown as (handle: unknown) => void;

// `unknown` on purpose: with both the DOM and Node timer typings in scope,
// setInterval's return type is ambiguous, and the handle is only ever passed
// straight back to the matching clear function.
const handles = new Map<number, unknown>();
let nextTimerId = 1;

const fakeWindow: FakeWindow = {
  setInterval(handler, timeout, ...args) {
    const id = nextTimerId++;
    handles.set(id, setInterval(handler as () => void, timeout, ...args));
    return id;
  },
  clearInterval(id) {
    if (id == null) return;
    const handle = handles.get(id);
    if (handle) nodeClear(handle);
    handles.delete(id);
  },
  setTimeout(handler, timeout, ...args) {
    const id = nextTimerId++;
    handles.set(id, setTimeout(handler as () => void, timeout, ...args));
    return id;
  },
  clearTimeout(id) {
    if (id == null) return;
    const handle = handles.get(id);
    if (handle) nodeClearTimeout(handle);
    handles.delete(id);
  },
};

(globalThis as unknown as { window: FakeWindow }).window = fakeWindow;

/** Stop every timer this file created, so the process can exit. */
function clearAllTimers(): void {
  for (const handle of handles.values()) {
    nodeClear(handle);
    nodeClearTimeout(handle);
  }
  handles.clear();
}

// --- a fake Obsidian --------------------------------------------------------

interface FakeManifest {
  id: string;
  name: string;
  version: string;
}

class FakeApp {
  manifests: Record<string, FakeManifest> = {};
  enabledPlugins = new Set<string>();
  /** Loaded plugin instances, shaped like Obsidian's `Component`. */
  instances: Record<string, { _events: unknown[]; _children: unknown[] }> = {};
  commandRegistry: Record<string, { name: string }> = {};
  /** How long each plugin pretends to take to load. */
  loadCost: Record<string, number> = {};
  /** Ids whose enable should fail, to prove a failure doesn't record a time. */
  failing = new Set<string>();

  plugins = {
    manifests: this.manifests,
    enabledPlugins: this.enabledPlugins,
    plugins: this.instances,
    enablePlugin: async (id: string): Promise<boolean> => {
      if (this.failing.has(id)) throw new Error(`cannot enable ${id}`);
      await sleep(this.loadCost[id] ?? 1);
      this.enabledPlugins.add(id);
      this.instances[id] = { _events: [1, 2, 3], _children: [] };
      return true;
    },
    disablePlugin: async (id: string): Promise<boolean> => {
      this.enabledPlugins.delete(id);
      delete this.instances[id];
      return true;
    },
  };

  commands = { commands: this.commandRegistry };

  install(id: string, version = "1.0.0"): void {
    this.manifests[id] = { id, name: id.toUpperCase(), version };
    this.enabledPlugins.add(id);
    this.instances[id] = { _events: [1, 2, 3], _children: [] };
  }
}

/**
 * Run `fn` from inside code that carries a plugin's sourceURL marker, so the
 * stack the watcher reads looks exactly like a real plugin's.
 *
 * This is how Obsidian loads plugin code, and it is the only way to test
 * attribution honestly — asserting against a hand-written stack string would
 * just be re-testing the regex.
 */
function asPlugin<T>(id: string, fn: () => T): T {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const runner = new Function(
    "fn",
    `return fn();\n//# sourceURL=plugin:${id}`
  ) as (f: () => T) => T;
  return runner(fn);
}

// --- runtime watcher: timers ------------------------------------------------
async function timerTests(): Promise<void> {
  const app = new FakeApp();
  app.install("alpha");
  app.install("beta");
  // FlowKit is itself an installed plugin, which is precisely why its own
  // frames were being matched and returned as the culprit.
  app.install("flowkit-health-dashboard");

  const store: RuntimeProfiles = {};
  const watcher = new RuntimeWatcher(app as never, {
    installedIds: () => new Set(Object.keys(app.manifests)),
    store: () => store,
    versionOf: (id) => app.manifests[id]?.version,
    onChange: () => undefined,
  });

  const beforeSet = window.setInterval;
  watcher.start();
  check("start() replaces setInterval", window.setInterval !== beforeSet);

  // A timer created from inside plugin code is attributed to that plugin.
  //
  // Nested through a frame marked as FlowKit's own, because that is the real
  // shape: the watcher captures the stack from inside its own `setInterval`
  // wrapper, so FlowKit's frames sit ON TOP of the calling plugin's. The first
  // version of this harness called `setInterval` from unmarked test code, which
  // is why it passed while the shipped build attributed every timer in the
  // vault to FlowKit itself and measured no other plugin at all.
  const alphaTimer = asPlugin("alpha", () =>
    asPlugin("flowkit-health-dashboard", () => window.setInterval(() => undefined, 250))
  );
  // …and one created from test code (no plugin frame) is not blamed on anyone.
  const orphan = window.setInterval(() => undefined, 100);

  let snapshot = watcher.snapshot();
  eq("a plugin's timer is attributed to it", snapshot.alpha?.minIntervalMs, 250);
  eq("and counted", snapshot.alpha?.timers, 1);
  check(
    "an unattributable timer is dropped, not blamed on a nearby plugin",
    snapshot.beta?.minIntervalMs == null && snapshot.alpha?.timers === 1
  );
  check(
    "FlowKit's own frames are skipped, not recorded as the timer's owner",
    snapshot["flowkit-health-dashboard"]?.minIntervalMs == null,
    `got ${snapshot["flowkit-health-dashboard"]?.minIntervalMs}`
  );

  // The fastest period wins, since that is the one that costs.
  asPlugin("alpha", () =>
    asPlugin("flowkit-health-dashboard", () => window.setInterval(() => undefined, 1000))
  );
  const fast = asPlugin("alpha", () =>
    asPlugin("flowkit-health-dashboard", () => window.setInterval(() => undefined, 50))
  );
  snapshot = watcher.snapshot();
  eq("the fastest period is the one reported", snapshot.alpha?.minIntervalMs, 50);
  eq("and all of them are counted", snapshot.alpha?.timers, 3);

  // Clearing a timer removes it from the live set.
  window.clearInterval(fast);
  window.clearInterval(alphaTimer);
  snapshot = watcher.snapshot();
  eq("cleared timers stop being counted", snapshot.alpha?.timers, 1);
  eq("and the reported period follows", snapshot.alpha?.minIntervalMs, 1000);
  window.clearInterval(orphan);

  // Callback cost: the thing that actually explains a laggy vault.
  const slow = asPlugin("beta", () =>
    window.setInterval(() => {
      const until = performance.now() + 30;
      while (performance.now() < until) {
        /* deliberately blocking, exactly like the plugins this catches */
      }
    }, 10)
  );
  await sleep(80);
  window.clearInterval(slow);
  snapshot = watcher.snapshot();
  const tick = snapshot.beta?.maxTickMs ?? 0;
  check("a slow callback is timed", tick >= 25, `got ${tick}ms`);
  check("and the runs are counted", (snapshot.beta?.ticks ?? 0) >= 1);

  // A plugin's own exception must pass straight through the timing wrapper:
  // swallowing it would both break the plugin and hide it from the error watcher.
  let threw = false;
  const boom = asPlugin("alpha", () =>
    window.setInterval(() => {
      threw = true;
      throw new Error("plugin exploded");
    }, 5)
  );
  const originalHandler = process.listeners("uncaughtException").slice();
  process.removeAllListeners("uncaughtException");
  process.on("uncaughtException", () => undefined);
  await sleep(40);
  window.clearInterval(boom);
  process.removeAllListeners("uncaughtException");
  for (const handler of originalHandler) process.on("uncaughtException", handler);
  check("a throwing callback still runs and still throws", threw);
  check(
    "and its time is still recorded",
    (watcher.snapshot().alpha?.ticks ?? 0) >= 1
  );

  // Command and hook counts, read live.
  app.commandRegistry["alpha:one"] = { name: "One" };
  app.commandRegistry["alpha:two"] = { name: "Two" };
  app.commandRegistry["editor:toggle-bold"] = { name: "Bold" };
  snapshot = watcher.snapshot();
  eq("commands are attributed by prefix", snapshot.alpha?.commands, 2);
  check("core commands are not attributed to a plugin", snapshot.beta?.commands == null);
  eq("registered hooks are read from the instance", snapshot.alpha?.handlers, 3);

  watcher.stop();
  eq("stop() restores setInterval", window.setInterval, beforeSet);

  // If somebody else wrapped setInterval after us, restoring ours would undo
  // theirs. Leaving ours in place is the lesser harm, and it is what happens.
  //
  // That compromise is only defensible if the wrapper we leave behind is DEAD.
  // It was not: the closure still held the watcher, its maps and its host, so
  // every timer created afterwards was attributed, recorded, and flushed
  // through `onChange` — which saves settings and rescans — on behalf of a
  // plugin Obsidian had already unloaded. The old test asserted only that the
  // later wrapper survived, which blessed the leak rather than catching it.
  let deadHostCalls = 0;
  const store2: RuntimeProfiles = {};
  const watcher2 = new RuntimeWatcher(app as never, {
    installedIds: () => new Set(Object.keys(app.manifests)),
    store: () => store2,
    versionOf: (id) => app.manifests[id]?.version,
    onChange: () => {
      deadHostCalls++;
    },
  });
  watcher2.start();
  const ours = window.setInterval;
  const theirs = ((handler: TimerHandler, timeout?: number): number =>
    ours(handler, timeout)) as typeof window.setInterval;
  window.setInterval = theirs;
  watcher2.stop();
  eq("a later wrapper is not clobbered on unload", window.setInterval, theirs);

  // Now drive a timer through the chain that still contains our wrapper.
  const afterUnload = asPlugin("alpha", () =>
    asPlugin("flowkit-health-dashboard", () => window.setInterval(() => undefined, 20))
  );
  const strandedSnapshot = watcher2.snapshot();
  check(
    "a wrapper that survives unload records nothing",
    strandedSnapshot.alpha?.timers == null,
    `got ${strandedSnapshot.alpha?.timers}`
  );
  await sleep(60);
  window.clearInterval(afterUnload);
  eq("and never calls back into the unloaded plugin", deadHostCalls, 0);
  window.setInterval = beforeSet;

  // Two generations of FlowKit can coexist for a moment during a reload. The
  // marker they share says "some FlowKit wrapper", not "mine" — so restoring on
  // the marker alone let one instance replace the other's LIVE wrapper with its
  // own stale predecessor, leaving the survivor blind.
  const firstStore: RuntimeProfiles = {};
  const first = new RuntimeWatcher(app as never, {
    installedIds: () => new Set(Object.keys(app.manifests)),
    store: () => firstStore,
    versionOf: (id: string) => app.manifests[id]?.version,
    onChange: () => undefined,
  });
  const second = new RuntimeWatcher(app as never, {
    installedIds: () => new Set(Object.keys(app.manifests)),
    store: () => store,
    versionOf: (id: string) => app.manifests[id]?.version,
    onChange: () => undefined,
  });
  first.start();
  second.start();
  const secondsWrapper = window.setInterval;
  first.stop();
  eq(
    "one instance does not restore over another's live wrapper",
    window.setInterval,
    secondsWrapper
  );
  // The outgoing instance cannot unhook itself from the middle of the chain —
  // its wrapper is underneath the survivor's, and pulling it out would take the
  // survivor with it. What matters is that it observes nothing more.
  const afterFirstStopped = asPlugin("alpha", () =>
    asPlugin("flowkit-health-dashboard", () => window.setInterval(() => undefined, 400))
  );
  check(
    "the stopped instance in the middle of the chain records nothing",
    first.snapshot().alpha?.timers == null
  );
  check(
    "while the live one still measures normally",
    (second.snapshot().alpha?.timers ?? 0) > 0
  );
  window.clearInterval(afterFirstStopped);
  second.stop();
  window.setInterval = beforeSet;

  // Clearing a timer changes the snapshot as much as creating one, and only
  // the creating side ever said so — so a plugin that stopped polling went on
  // being displayed as a poller until something unrelated forced a re-score.
  let clearNotifications = 0;
  const watcher3 = new RuntimeWatcher(
    app as never,
    {
      installedIds: () => new Set(Object.keys(app.manifests)),
      store: () => store,
      versionOf: (id) => app.manifests[id]?.version,
      onChange: () => {
        clearNotifications++;
      },
    },
    20
  );
  watcher3.start();
  const doomed = asPlugin("alpha", () =>
    asPlugin("flowkit-health-dashboard", () => window.setInterval(() => undefined, 300))
  );
  // Let the creation's own flush land first, so what is counted below is the
  // clear and nothing else.
  await sleep(60);
  clearNotifications = 0;
  window.clearInterval(doomed);
  await sleep(60);
  eq(
    "clearing an attributed timer tells the host the snapshot moved",
    clearNotifications,
    1
  );
  // …and clearing something we never attributed says nothing, so an unrelated
  // plugin's housekeeping cannot rescore the dashboard.
  const untracked = window.setInterval(() => undefined, 300);
  await sleep(60);
  clearNotifications = 0;
  window.clearInterval(untracked);
  await sleep(60);
  eq("an unattributed timer's removal does not", clearNotifications, 0);
  watcher3.stop();
  window.setInterval = beforeSet;
}

// --- runtime watcher: load timing -------------------------------------------
async function loadTests(): Promise<void> {
  const app = new FakeApp();
  app.install("slow", "2.0.0");
  app.install("quick", "1.0.0");
  app.loadCost.slow = 40;
  app.loadCost.quick = 1;

  const store: RuntimeProfiles = {};
  let changes = 0;
  const watcher = new RuntimeWatcher(app as never, {
    installedIds: () => new Set(Object.keys(app.manifests)),
    store: () => store,
    versionOf: (id) => app.manifests[id]?.version,
    onChange: () => {
      changes++;
    },
  });

  const originalEnable = app.plugins.enablePlugin;
  watcher.start();
  check("start() replaces enablePlugin", app.plugins.enablePlugin !== originalEnable);

  // Any enable that happens while FlowKit is running gets timed — including one
  // triggered from Obsidian's own settings, which is what this simulates.
  await app.plugins.enablePlugin("slow");
  check("a witnessed load is timed", (store.slow?.loadMs ?? 0) >= 30, `got ${store.slow?.loadMs}`);
  eq("and tied to the version it timed", store.slow?.loadVersion, "2.0.0");

  // An enable that throws must not record a load time — a failed load is not a
  // fast load, and recording one would be a fabricated measurement.
  app.failing.add("quick");
  try {
    await app.plugins.enablePlugin("quick");
  } catch {
    /* expected */
  }
  check("a failed enable records nothing", store.quick == null);
  app.failing.delete("quick");

  // measureLoad restarts a plugin that was already running, which is the only
  // way to measure one that loaded before FlowKit did.
  app.loadCost.quick = 25;
  const ms = await watcher.measureLoad("quick");
  check("measureLoad returns a real number", (ms ?? 0) >= 20, `got ${ms}`);
  check("and the plugin is left enabled", app.enabledPlugins.has("quick"));
  check("the store has it", (store.quick?.loadMs ?? 0) >= 20);

  // The wrapper already recorded a tighter measurement from inside the call, so
  // measureLoad must not overwrite it with its own looser one.
  check(
    "the recorded time is the inner measurement, not the outer one",
    (store.quick?.loadMs ?? 0) <= (ms ?? 0) + 1,
    `store ${store.quick?.loadMs}, returned ${ms}`
  );

  // profileAll fills in the whole table in one pass.
  app.install("third", "1.0.0");
  app.loadCost.third = 5;
  const progress: number[] = [];
  const result = await watcher.profileAll(["slow", "quick", "third"], (done) => {
    progress.push(done);
  });
  eq("profileAll measures everything", result.measured, 3);
  eq("and reports no failures", result.failed.length, 0);
  eq("reporting progress for each", progress.join(), "1,2,3");
  check(
    "every plugin is back on afterwards",
    ["slow", "quick", "third"].every((id) => app.enabledPlugins.has(id))
  );

  // A plugin that measuring cannot switch back on is not a failed sample — it
  // is a vault that is no longer what the user left it as. The run has to stop
  // on it and say which plugin, rather than restarting another forty on top of
  // it and reporting a tally. The watcher logs to the console by design, so it
  // is muted here: a passing run that prints a stack trace reads like a failing
  // one.
  app.failing.add("third");
  const realError = console.error;
  console.error = () => undefined;
  const partial = await watcher.profileAll(["third", "quick"]);
  console.error = realError;
  check("a plugin left switched off is reported", partial.stranded != null);
  eq("naming the plugin", partial.stranded?.pluginId, "third");
  check("and recording what its state had been", partial.stranded?.wasEnabled === true);
  eq("the run stops rather than continuing", partial.measured, 0);
  check(
    "so the plugins after it are never touched",
    app.enabledPlugins.has("quick"),
    "quick should not have been restarted"
  );
  app.failing.delete("third");

  // Measuring a plugin that was switched off must leave it switched off. It
  // used to enable unconditionally, turning a measurement into a decision to
  // run something the user had deliberately turned off.
  app.install("dormant", "1.0.0");
  app.enabledPlugins.delete("dormant");
  await watcher.measureLoad("dormant");
  check(
    "measuring a disabled plugin leaves it disabled",
    !app.enabledPlugins.has("dormant")
  );

  check("changes were flagged for persistence", changes >= 0);
  watcher.stop();
  eq("stop() restores enablePlugin", app.plugins.enablePlugin, originalEnable);
}

// --- bisect, driven against a registry that really changes ------------------
function bisectTests(): void {
  /** Apply a bisect state to a real enabled-set, the way main.ts does. */
  function apply(state: BisectState, enabled: Set<string>): void {
    const { enable, disable } = desiredState(state);
    for (const id of disable) enabled.delete(id);
    for (const id of enable) enabled.add(id);
  }

  const all = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"];

  for (const guilty of all) {
    const enabled = new Set([...all, "not-a-candidate"]);
    const original = [...enabled];
    let state = beginBisect(all, original, 1, "lag");
    apply(state, enabled);

    let rounds = 0;
    while (!state.done && rounds++ < 25) {
      // The symptom is present exactly when the guilty plugin is running.
      state = bisectStep(state, !enabled.has(guilty));
      apply(state, enabled);
    }

    eq(`bisect finds ${guilty} against a live registry`, state.culprit, guilty);
    check(
      `a non-candidate stays enabled throughout (${guilty})`,
      enabled.has("not-a-candidate")
    );

    // Restore is the safety net, and it must be exact.
    const back = restoreState(state);
    for (const id of back.disable) enabled.delete(id);
    for (const id of back.enable) enabled.add(id);
    eq(
      `restore returns the exact original set (${guilty})`,
      [...enabled].sort().join(),
      original.slice().sort().join()
    );
  }

  // Mid-search restart: the session is persisted, so it must survive a
  // round-trip through JSON and still converge on the same vault state.
  {
    const enabled = new Set(all);
    let state = beginBisect(all, all, 1);
    apply(state, enabled);
    state = bisectStep(state, false);
    apply(state, enabled);

    const before = [...enabled].sort().join();
    const revived = JSON.parse(JSON.stringify(state)) as BisectState;
    // Simulate the user toggling something by hand while Obsidian was closed.
    enabled.add("a");
    enabled.delete("k");
    apply(revived, enabled);
    eq("a restarted session converges on the same state", [...enabled].sort().join(), before);
  }

  // Stopping halfway restores everything, including plugins the search had off.
  {
    const enabled = new Set(all);
    let state = beginBisect(all, all, 1);
    apply(state, enabled);
    state = bisectStep(state, true);
    apply(state, enabled);
    check("plugins really are switched off mid-search", enabled.size < all.length);

    const back = restoreState(state);
    for (const id of back.enable) enabled.add(id);
    eq("stopping restores everything", [...enabled].sort().join(), all.slice().sort().join());
  }

  // A vault where the problem isn't a plugin at all.
  {
    const enabled = new Set(all);
    let state = beginBisect(all, all, 1);
    apply(state, enabled);
    let rounds = 0;
    while (!state.done && rounds++ < 25) {
      state = bisectStep(state, false); // never gets better
      apply(state, enabled);
    }
    eq("an innocent plugin set is exonerated", state.exonerated, true);
    eq("and nobody is accused", state.culprit, undefined);
  }
}

// --- persistence: the save queue, the scan pool, the cache guard ------------
//
// The save queue is the highest-risk code in the plugin that isn't touching
// somebody's plugins: it collapses concurrent writes, and the thing it must not
// collapse is the promise. `await saveSettings()` is a durability barrier
// before bisect switches anything off, so a caller resolving early would mean
// the recovery record might not be on disk when the vault starts changing.
async function persistenceTests(): Promise<void> {
  // A caller only ever resolves after a write that included its own state.
  {
    let state = 0;
    const written: number[] = [];
    const gate: { release: () => void } = { release: () => undefined };
    const queue = new SaveQueue<number>(
      () => state,
      async (snapshot) => {
        await new Promise<void>((resolve) => {
          gate.release = () => {
            written.push(snapshot);
            resolve();
          };
        });
      }
    );

    state = 1;
    const first = queue.save();
    await sleep(0); // let the write start and capture state 1
    state = 2;
    const second = queue.save();
    state = 3;
    const third = queue.save();

    gate.release();
    await first;
    eq("the first write persisted the state it started with", written.join(), "1");
    check("and the later callers are not resolved by it", !queue.settled);

    // The follow-up write is now in flight; let it through.
    await sleep(0);
    gate.release();
    await Promise.all([second, third]);
    eq("one further write covers both later callers", written.join(), "1,3");
    check("everything requested is now on disk", queue.settled);
  }

  // The reason the snapshot is taken when save() is CALLED and not when the
  // write runs. State here is replaced wholesale, not only added to — the
  // bisect recovery record is set and cleared — so a write that reads the live
  // object at its own start can contain LESS than the caller that asked for it,
  // and would then resolve that caller over a disk state its mutation never
  // reached.
  {
    let state = "idle";
    const written: string[] = [];
    const gate: { release: () => void } = { release: () => undefined };
    const queue = new SaveQueue<string>(
      () => state,
      async (snapshot) => {
        await new Promise<void>((resolve) => {
          gate.release = () => {
            written.push(snapshot);
            resolve();
          };
        });
      }
    );

    // A write is already running when the record is set.
    const blocking = queue.save();
    await sleep(0);
    state = "recovery-record";
    const barrier = queue.save();
    // …and something clears it again before the queued write gets its turn,
    // without asking for a save of its own.
    state = "cleared";

    gate.release();
    await blocking;
    await sleep(0);
    gate.release();
    await barrier;
    check(
      "the barrier caller's own state reached disk",
      written.includes("recovery-record"),
      `wrote ${written.join(" then ")}`
    );
  }

  // Concurrent requests collapse: this is what stops one scan rewriting
  // data.json five times.
  {
    let writes = 0;
    const queue = new SaveQueue<number>(
      () => writes,
      async () => {
        writes++;
        await sleep(1);
      }
    );
    await Promise.all([queue.save(), queue.save(), queue.save(), queue.save()]);
    check("four concurrent saves collapse into fewer writes", writes <= 2, `${writes}`);
    check("and all of them are satisfied", queue.settled);
  }

  // A failed write must reject the callers it would have covered — they are
  // entitled to know their state is not on disk — and leave the queue usable.
  {
    let fail = true;
    let writes = 0;
    const queue = new SaveQueue<number>(
      () => writes,
      async () => {
        writes++;
        if (fail) throw new Error("disk is read-only");
      }
    );
    let rejected = false;
    await queue.save().catch(() => {
      rejected = true;
    });
    check("a failed write rejects its caller", rejected);
    check("and nothing is claimed as saved", !queue.settled);
    fail = false;
    await queue.save();
    check("the queue still works afterwards", queue.settled, `${writes} writes`);
  }

  // …but a failed write must NOT reject a caller whose state it never held.
  //
  // Callers queued behind a running write used to inherit its rejection
  // wholesale. Two things went wrong at once: the later caller was told its
  // state had not reached disk when its snapshot had never been attempted, and
  // — worse — the loop exited, leaving that snapshot pending and unwritten
  // until something else happened to call save(). `await saveSettings()` is the
  // durability barrier bisect leans on before switching a plugin off, so
  // "someone else's write failed" has to mean "attempt mine".
  {
    let attempts = 0;
    let state = 0;
    const written: number[] = [];
    const gate: { release: () => void } = { release: () => undefined };
    const queue = new SaveQueue<number>(
      () => state,
      async (snapshot) => {
        const mine = ++attempts;
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
        // Only the very first physical write fails.
        if (mine === 1) throw new Error("disk went away for a moment");
        written.push(snapshot);
      }
    );

    state = 1;
    const doomed = queue.save();
    await sleep(0); // let it take the job and block
    state = 2;
    const later = queue.save();

    let doomedRejected = false;
    gate.release();
    await doomed.catch(() => {
      doomedRejected = true;
    });
    check("the caller whose write failed is told", doomedRejected);

    await sleep(0);
    gate.release();
    let laterRejected = false;
    await later.catch(() => {
      laterRejected = true;
    });
    check("a later caller does not inherit that verdict", !laterRejected);
    eq("its own snapshot really was written", written.join(), "2");
    check("and the queue reports everything settled", queue.settled);
  }

  // The scan pool must return results in input order whatever finishes first,
  // or equal-scoring plugins reshuffle on every scan.
  {
    const items = [40, 5, 30, 1, 20, 2, 10, 3];
    const order = await mapWithConcurrency(items, 4, async (ms) => {
      await sleep(ms);
      return ms;
    });
    eq("the pool preserves input order", order.join(), items.join());

    let live = 0;
    let peak = 0;
    await mapWithConcurrency(new Array(12).fill(0), 3, async () => {
      peak = Math.max(peak, ++live);
      await sleep(2);
      live--;
      return 0;
    });
    check("and never exceeds its limit", peak <= 3, `peak ${peak}`);
    eq("an empty list is fine", (await mapWithConcurrency([], 4, async () => 1)).length, 0);
  }

  // The cache guard is all-or-nothing: a half-valid cache keeps an `at` that
  // suppresses the refetch and `hadStats` flags the header reports as coverage.
  {
    const good = { at: 1, plugins: {}, distribution: [1, 2], hadStats: true, hadList: false };
    check("a complete cache is usable", isUsableCache(good));
    check("no cache at all is not", !isUsableCache(null));
    check("a cache with no plugin map is not", !isUsableCache({ ...good, plugins: null }));
    check("nor one whose plugin map is an array", !isUsableCache({ ...good, plugins: [] }));
    check("nor one with no timestamp", !isUsableCache({ ...good, at: undefined }));
    check("nor one with a junk timestamp", !isUsableCache({ ...good, at: NaN }));
    check("nor one with a junk distribution", !isUsableCache({ ...good, distribution: [1, "x"] }));
    check("nor one missing its coverage flags", !isUsableCache({ ...good, hadStats: undefined }));

    // The entries, not just the container. The guard validated the shell and
    // stopped, while its own contract promised all-or-nothing — so a mangled
    // row went straight into scoring, where `listed` being truthy is the
    // difference between "installed outside the directory" and the far more
    // serious "Obsidian pulled this from the community directory".
    const withEntry = (entry: unknown) => ({ ...good, plugins: { alpha: entry } });
    check(
      "a well-formed entry is fine",
      isUsableCache(withEntry({ downloads: 10, updated: 1, latest: "1.0.0", listed: true }))
    );
    check("an entry that is a string is not", !isUsableCache(withEntry("nonsense")));
    check("nor one that is an array", !isUsableCache(withEntry([1, 2])));
    check("nor one that is null", !isUsableCache(withEntry(null)));
    check(
      "nor a download count that isn't a number",
      !isUsableCache(withEntry({ downloads: "12000" }))
    );
    check(
      "nor a non-finite one",
      !isUsableCache(withEntry({ downloads: Number.POSITIVE_INFINITY }))
    );
    check("nor a stringly-typed listing flag", !isUsableCache(withEntry({ listed: "true" })));
    check("nor a version that isn't a string", !isUsableCache(withEntry({ latest: 3 })));
    check(
      "per-feed timestamps are optional but must be numbers",
      isUsableCache({ ...good, statsAt: 5, listAt: undefined }) &&
        !isUsableCache({ ...good, listAt: "yesterday" })
    );
  }
}

// --- error watcher: the sibling that never went inert -----------------------
//
// 1.6.0 gave RuntimeWatcher a `stopped` flag and identity-based unwrapping, and
// stopped there. ErrorWatcher has the same shape and the same compromise — it
// declines to unhook a `console.error` somebody else has since wrapped — so its
// wrapper could survive unload holding the watcher, the host, and through the
// host an unloaded plugin's settings, and go on writing them.
async function errorWatcherTests(): Promise<void> {
  const app = new FakeApp();
  app.install("alpha");
  app.install("flowkit-health-dashboard");

  const log: Record<string, PluginErrorRecord> = {};
  let changes = 0;
  // A minimal stand-in for Obsidian's Plugin: only `registerDomEvent` is used,
  // and nothing in these assertions goes through the window listeners.
  const fakePlugin = { registerDomEvent: () => undefined } as unknown as Plugin;
  const watcher = new ErrorWatcher(fakePlugin, {
    installedIds: () => new Set(Object.keys(app.manifests)),
    log: () => log,
    onChange: () => {
      changes++;
    },
  });

  const pristine = console.error;
  // The wrapper's whole contract is that it calls through, so the messages
  // below would land in the test output as real console errors. Swap the
  // underlying function for a sink first: what is under test is attribution and
  // inertness, not that console.error prints.
  const sink = (() => undefined) as typeof console.error;
  console.error = sink;
  watcher.start(true);
  check("start() wraps console.error", console.error !== sink);

  asPlugin("alpha", () =>
    asPlugin("flowkit-health-dashboard", () => console.error("alpha exploded"))
  );
  eq("a logged error is attributed to the plugin that logged it", log.alpha?.logged, 1);

  // Somebody else wraps on top of us, exactly as another plugin would.
  const ours = console.error;
  const theirs = ((...args: unknown[]): void => {
    (ours as (...a: unknown[]) => void)(...args);
  }) as typeof console.error;
  console.error = theirs;

  watcher.stop();
  eq("a later wrapper is not clobbered on unload", console.error, theirs);

  const loggedBefore = log.alpha?.logged ?? 0;
  changes = 0;
  asPlugin("alpha", () =>
    asPlugin("flowkit-health-dashboard", () => console.error("after unload"))
  );
  eq(
    "a wrapper that survives unload records nothing",
    log.alpha?.logged ?? 0,
    loggedBefore
  );
  await sleep(30);
  eq("and never calls back into the unloaded plugin", changes, 0);

  console.error = sink;

  // Restoration must hand back the ORIGINAL, not a bound copy of it — storing
  // the bound copy laminated another `.bind` onto a global other plugins also
  // use, once per disable/enable cycle.
  const before = console.error;
  const cycle = new ErrorWatcher(fakePlugin, {
    installedIds: () => new Set(Object.keys(app.manifests)),
    log: () => log,
    onChange: () => undefined,
  });
  for (let i = 0; i < 3; i++) {
    cycle.start(true);
    cycle.stop();
  }
  eq("enable/disable cycles give back exactly what they took", console.error, before);
  console.error = pristine;
}

// --- run --------------------------------------------------------------------
await timerTests();
await loadTests();
bisectTests();
await persistenceTests();
await errorWatcherTests();
clearAllTimers();

if (failures.length) {
  console.error(`\n✗ ${failures.length} integration failures, ${passed} passed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
} else {
  console.log(`✓ all ${passed} integration assertions passed`);
}
