import type { Plugin } from "obsidian";
import { attributeStack, recordError, type ObservedError } from "./errors";
import { PRODUCT_ID } from "./product";
import type { PluginErrorRecord } from "./types";

/** FlowKit's own frames, skipped when a stack was captured inside our wrappers. */
const IGNORE_SELF: ReadonlySet<string> = new Set([PRODUCT_ID]);

type ConsoleErrorFn = (...args: unknown[]) => void;

/**
 * A readable message from an arbitrary rejection reason. Plugins reject with
 * all sorts of things; blindly stringifying an object yields "[object Object]",
 * which would collapse every such rejection into one useless signature.
 */
function describeReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  if (typeof reason === "number" || typeof reason === "boolean") return String(reason);
  if (reason == null) return "Unhandled rejection";
  try {
    return JSON.stringify(reason)?.slice(0, 300) ?? "Unhandled rejection";
  } catch {
    return "Unhandled rejection (unserialisable reason)";
  }
}

/** Marks our wrapper so unload can tell it apart from someone else's. */
const WRAPPED = Symbol.for("flowkit-console-wrapper");

export interface ErrorWatcherHost {
  /** Ids of every installed plugin, used to attribute a stack frame. */
  installedIds(): Set<string>;
  /** The log to fold errors into. Mutated in place. */
  log(): Record<string, PluginErrorRecord>;
  /** Called after a batch of errors lands, so the host can persist and refresh. */
  onChange(): void;
}

/**
 * Watches for runtime errors and attributes them to the plugin that threw.
 *
 * Nothing here leaves the machine: the log lives in this plugin's own data and
 * is never transmitted. That matters because stack traces and error messages
 * can quote file paths and note titles.
 */
export class ErrorWatcher {
  private originalConsoleError: ConsoleErrorFn | null = null;
  /** The exact function we installed, so we only ever remove our own. */
  private myWrapper: ConsoleErrorFn | null = null;
  /** Guards against an error thrown *by* our handler re-entering it. */
  private handling = false;
  /**
   * Set once `stop()` has run.
   *
   * `RuntimeWatcher` learned this in 1.6.0 and this class did not, which is the
   * whole of the bug: a `console.error` wrapper that somebody else has since
   * wrapped cannot be removed, so it survives unload holding this watcher and,
   * through the host, the unloaded plugin's settings. Every logged error in the
   * vault then went on being attributed, written into a dead instance's error
   * log, and flushed through `onChange()` — which saves `data.json` and asks
   * for a rescan. A disabled plugin quietly kept rewriting its own settings
   * file. The wrapper can't be unhooked, so it is made inert instead.
   */
  private stopped = false;
  /** Errors seen since the last flush, so a loop doesn't mean a write per iteration. */
  private dirty = false;
  private flushTimer: number | null = null;

  constructor(
    private plugin: Plugin,
    private host: ErrorWatcherHost
  ) {}

  /** Attach the listeners. Safe to call once, from onload. */
  start(captureConsole: boolean): void {
    this.stopped = false;
    this.plugin.registerDomEvent(window, "error", (evt: ErrorEvent) => {
      this.observe({
        kind: "uncaught",
        message: evt.message || String(evt.error ?? "Unknown error"),
        stack: evt.error instanceof Error ? evt.error.stack : undefined,
      });
    });

    this.plugin.registerDomEvent(
      window,
      "unhandledrejection",
      (evt: PromiseRejectionEvent) => {
        const reason: unknown = evt.reason;
        this.observe({
          kind: "rejection",
          message: describeReason(reason),
          stack: reason instanceof Error ? reason.stack : undefined,
        });
      }
    );

    if (captureConsole) this.wrapConsole();
  }

  /**
   * Most plugins never let an exception escape — they catch it and
   * `console.error` it, which is exactly the failure a user experiences as
   * "this stopped working" with nothing in the UI to show for it. Capturing
   * that is most of the value, so it is worth the monkey-patch.
   */
  private wrapConsole(): void {
    // Keep the RAW reference for restoring and a bound copy for calling. This
    // stored the bound copy and restored *that*, so every disable/enable cycle
    // laminated another `.bind` onto a global other plugins also use — the same
    // defect `wrapTimers` was fixed for, in the sibling class, and left here.
    const raw = console.error as ConsoleErrorFn;
    this.originalConsoleError = raw;
    const original = raw.bind(console);

    const wrapper = ((...args: unknown[]): void => {
      // Always pass through first: whatever we do next must not swallow the
      // user's own console output or the devtools experience.
      original(...args);
      // Once stopped this is a pass-through and nothing more — see `stopped`.
      if (this.stopped) return;
      const err = args.find((a): a is Error => a instanceof Error);
      const message = err
        ? err.message
        : args.map((a) => (typeof a === "string" ? a : "")).join(" ").trim();
      if (!message) return;
      this.observe({
        kind: "console",
        message,
        // No Error object means no stack of its own; synthesise one so the
        // frames of whoever called console.error are available to attribute.
        stack: err?.stack ?? new Error().stack,
      });
    }) as ConsoleErrorFn & { [WRAPPED]?: true };
    wrapper[WRAPPED] = true;

    this.myWrapper = wrapper;
    console.error = wrapper;
  }

  /** Restore console.error, but only if nobody has wrapped it since we did. */
  stop(): void {
    // Set FIRST, and before anything is unwrapped: a wrapper that survives this
    // call must already be inert by the time it can next be entered.
    this.stopped = true;
    if (this.flushTimer != null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Cleared too, or a flush that has already been armed fires for an
    // observation that was written before we stopped.
    this.dirty = false;
    if (!this.originalConsoleError) return;
    // Identity, not the shared `WRAPPED` marker: that marker means "some
    // FlowKit wrapper", so on the marker alone one instance could restore over
    // another instance's live wrapper and leave the survivor blind.
    if (console.error === this.myWrapper) {
      console.error = this.originalConsoleError;
    }
    // If another plugin wrapped console.error after us, restoring would undo
    // their wrapper too. Leaving ours in place is the lesser harm — and
    // `stopped` is what makes that true: the survivor now only calls through.
    this.originalConsoleError = null;
    this.myWrapper = null;
  }

  private observe(partial: Omit<ObservedError, "pluginId" | "at">): void {
    // The window listeners go through `registerDomEvent` and are removed for
    // us, but a surviving console wrapper does not — so this is the choke point
    // that has to refuse.
    if (this.stopped || this.handling) return;
    this.handling = true;
    try {
      const installed = this.host.installedIds();
      // A thrown Error carries the stack from where it was thrown, so FlowKit
      // is absent from it — but `console.error("some string")` has no Error, so
      // the stack is synthesised inside our own wrapper with our frames on top.
      // Without skipping ourselves, every such log is blamed on FlowKit.
      const pluginId = attributeStack(partial.stack, installed, IGNORE_SELF);
      // Unattributable errors are dropped rather than blamed on something.
      // Obsidian's own internals, themes and CSS snippets all land here.
      if (!pluginId) return;

      const log = this.host.log();
      log[pluginId] = recordError(log[pluginId], {
        ...partial,
        pluginId,
        at: Date.now(),
      });
      this.dirty = true;
      this.scheduleFlush();
    } catch {
      // A failure to record an error must never itself surface as an error.
    } finally {
      this.handling = false;
    }
  }

  /**
   * Coalesce writes. A plugin erroring inside a render loop can fire hundreds
   * of times a second, and each one would otherwise rewrite data.json.
   */
  private scheduleFlush(): void {
    // Belt and braces: nothing should reach here after `stop()`, and arming a
    // timeout that calls into an unloaded host is the outcome worth ruling out
    // twice.
    if (this.stopped || this.flushTimer != null) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      if (this.stopped || !this.dirty) return;
      this.dirty = false;
      this.host.onChange();
    }, 5000);
  }
}
