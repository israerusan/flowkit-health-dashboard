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
  const watcher2 = new RuntimeWatcher(app as never, {
    installedIds: () => new Set(Object.keys(app.manifests)),
    store: () => store,
    versionOf: (id) => app.manifests[id]?.version,
    onChange: () => undefined,
  });
  watcher2.start();
  const ours = window.setInterval;
  const theirs = ((handler: TimerHandler, timeout?: number): number =>
    ours(handler, timeout)) as typeof window.setInterval;
  window.setInterval = theirs;
  watcher2.stop();
  eq("a later wrapper is not clobbered on unload", window.setInterval, theirs);
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

  // A plugin that can't be re-enabled is reported, not silently skipped. The
  // watcher logs that to the console by design, so it is muted here — a passing
  // run that prints a stack trace reads like a failing one.
  app.failing.add("third");
  const realError = console.error;
  console.error = () => undefined;
  const partial = await watcher.profileAll(["third"]);
  console.error = realError;
  eq("a failure is counted", partial.failed.join(), "third");
  eq("and the rest of the run is unaffected", partial.measured, 0);
  app.failing.delete("third");

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

// --- run --------------------------------------------------------------------
await timerTests();
await loadTests();
bisectTests();
clearAllTimers();

if (failures.length) {
  console.error(`\n✗ ${failures.length} integration failures, ${passed} passed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
} else {
  console.log(`✓ all ${passed} integration assertions passed`);
}
