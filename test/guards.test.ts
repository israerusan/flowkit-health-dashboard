// The guards that keep FlowKit from rearranging a vault it shouldn't.
//
// Each one was a real defect found in review: FlowKit could switch itself off
// (and, via "Measure load time", load a second instance of itself), start safe
// mode or save a set mid-search, run two profiling passes at once, and record
// history under the "your vault may be half off" salvage banner. These run the
// real methods from main.ts against a fake plugin registry, built with
// Object.create so no Obsidian constructor runs.
import FlowKitHealthPlugin from "../src/main";

const SELF = "flowkit-health-dashboard";
let passed = 0;

function check(cond: unknown, label: string): void {
  if (!cond) throw new Error(`guards: ${label}`);
  passed++;
}

async function rejects(p: Promise<unknown>, label: string): Promise<void> {
  try {
    await p;
  } catch {
    passed++;
    return;
  }
  throw new Error(`guards: expected a rejection — ${label}`);
}

interface Fake {
  plugin: FlowKitHealthPlugin;
  enabled: Set<string>;
  toggles: string[];
}

function makePlugin(opts: {
  installed: string[];
  enabled: string[];
  bisect?: unknown;
  bisectError?: string | null;
  salvage?: unknown;
  runtimeWatcher?: unknown;
}): Fake {
  const enabled = new Set(opts.enabled);
  const toggles: string[] = [];
  const registry = {
    manifests: Object.fromEntries(opts.installed.map((id) => [id, { id, name: id, version: "1.0.0" }])),
    enabledPlugins: enabled,
    enablePluginAndSave: async (id: string) => {
      toggles.push(`on:${id}`);
      enabled.add(id);
    },
    disablePluginAndSave: async (id: string) => {
      toggles.push(`off:${id}`);
      enabled.delete(id);
    },
  };
  const plugin = Object.create(FlowKitHealthPlugin.prototype) as FlowKitHealthPlugin;
  Object.assign(plugin, {
    app: { plugins: registry },
    manifest: { id: SELF },
    settings: { bisect: opts.bisect ?? null, safeMode: null, profiles: [], healthExperiment: null },
    bisectError: opts.bisectError ?? null,
    bisectSalvage: opts.salvage ?? null,
    settingsUnreadable: false,
    vaultMutationDepth: 0,
    profilingRun: false,
    runtimeWatcher: opts.runtimeWatcher ?? null,
    saveSettings: async () => {},
  });
  return { plugin, enabled, toggles };
}

const midSearch = { done: false, disabled: ["a"] };

// --- FlowKit never switches itself off -------------------------------------
{
  const { plugin, enabled, toggles } = makePlugin({ installed: [SELF, "a"], enabled: [SELF, "a"] });
  await rejects(plugin.setPluginEnabled(SELF, false), "switching FlowKit off directly is refused");
  check(enabled.has(SELF) && toggles.length === 0, "and nothing was toggled");

  const bulk = await plugin.disableMany([SELF, "a"]);
  check(bulk.changed.length === 1 && bulk.changed[0] === "a", "a bulk disable naming FlowKit changes only the others");
  check(bulk.failed.length === 0, "and doesn't report FlowKit as a failure");
  check(enabled.has(SELF) && !enabled.has("a"), "FlowKit stays on, the other goes off");
}

// --- measuring restarts the plugin: never FlowKit, never mid-profile ------
{
  let measured = 0;
  const watcher = {
    measureLoad: async () => {
      measured++;
      return 12;
    },
  };
  const { plugin } = makePlugin({ installed: [SELF, "a"], enabled: [SELF, "a"], runtimeWatcher: watcher });
  check((await plugin.measureLoad(SELF)) === null, "measuring FlowKit's own load is refused");
  check(measured === 0, "and the watcher is never asked to restart it");
  check((await plugin.measureLoad("a")) === 12, "another plugin is still measured");
}

// --- one profiling run at a time ------------------------------------------
{
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let runs = 0;
  const watcher = {
    profileAll: async () => {
      runs++;
      await gate;
      return { measured: 1, failed: [], stranded: null };
    },
    measureLoad: async () => 5,
  };
  const { plugin } = makePlugin({ installed: [SELF, "a", "b"], enabled: [SELF, "a", "b"], runtimeWatcher: watcher });
  const first = plugin.profileAll(["a", "b"]);
  check(plugin.profiling, "a run in progress is visible");
  await rejects(plugin.profileAll(["a"]), "a second run while one is going is refused");
  await rejects(plugin.measureLoad("a"), "measuring one plugin mid-run is refused");
  release();
  await first;
  check(runs === 1, "only one run reached the watcher");
  check(!plugin.profiling, "the flag clears when the run ends");
}

// --- the salvage banner suspends recording --------------------------------
{
  const clean = makePlugin({ installed: [SELF], enabled: [SELF] }).plugin;
  check(!clean.recordingSuspended(), "an ordinary vault records");
  const salvaging = makePlugin({ installed: [SELF], enabled: [SELF], salvage: { garbled: true } }).plugin;
  check(salvaging.recordingSuspended(), "an unreadable search record suspends recording");
}

// --- safe mode: one plan, from the live registry --------------------------
{
  const { plugin } = makePlugin({ installed: [SELF, "a", "b", "c"], enabled: [SELF, "a", "b"] });
  const plan = plugin.planSafeMode(["b", "c"]);
  check(plan.session.keepEnabled.join() === `${SELF},b`, "kept: FlowKit and the watched plugin that is on");
  check(plan.disable.join() === "a", "switched off: exactly the other enabled plugin");
}
{
  const { plugin, enabled } = makePlugin({ installed: [SELF, "a", "b"], enabled: [SELF, "a", "b"] });
  const result = await plugin.startSafeMode(["b"]);
  check(result != null && result.changed.join() === "a", "safe mode switches off what the plan said");
  check(enabled.has(SELF) && enabled.has("b") && !enabled.has("a"), "and leaves FlowKit and the watched plugin on");
}

// --- nothing that records or reshapes the set runs mid-search -------------
for (const [label, opts] of [
  ["a search in progress", { bisect: midSearch }],
  ["a finished search that couldn't restore", { bisect: { done: true }, bisectError: "x wouldn't switch back on" }],
] as const) {
  const { plugin, enabled, toggles } = makePlugin({ installed: [SELF, "a", "b"], enabled: [SELF, "b"], ...opts });
  check(plugin.bisectOwnsPage(), `${label} owns the page`);
  check((await plugin.startSafeMode([])) === null, `safe mode doesn't start during ${label}`);
  check(toggles.length === 0 && enabled.has("b"), `and nothing was switched off during ${label}`);
  check(plugin.settings.safeMode == null, `and no safe-mode session was recorded during ${label}`);
  check((await plugin.saveCurrentProfile("x")) === false, `no set is saved during ${label}`);
  check((await plugin.startHealthExperiment("x", [])) === null, `no experiment baseline is taken during ${label}`);
}

console.log(`✓ all ${passed} guard assertions passed`);
