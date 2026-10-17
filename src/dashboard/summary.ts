/** The vault-level summary: the grade, the stat tiles, startup cost, the trend chart and the legend. */
import { setIcon } from "obsidian";
import type { HealthSnapshot } from "../types";
import { SCORING_MODEL } from "../types";
import { needsAttention } from "../insights";
import { formatBytes, startupCost } from "../runtime";
import { type Tone, type FilterKey, svgEl, describeWatched, describeWhen } from "./format";
import { unprofiledIds, startProfileAll } from "./vaultActions";
import type { HealthDashboardView } from "../view";

export function renderHero(v: HealthDashboardView, root: HTMLElement): void {
  const s = v.summaryStats();
  const graded = v.canGrade(s);
  const grade = v.gradeNow(s);
  const hero = root.createDiv({ cls: "flowkit-hero" });

  // No ring. A 116px SVG arc drew one number four different ways (arc, digits,
  // letter, sentence) and could collapse to a giant "—" when confidence was
  // low. The score stays; the ceremony around it doesn't.
  const scoreBlock = hero.createDiv({ cls: "flowkit-hero-score" });
  scoreBlock.createDiv({
    cls: `flowkit-hero-number tone-${grade.tone}`,
    text: s.avg == null ? "—" : String(s.avg),
  });
  scoreBlock.createDiv({
    cls: `flowkit-hero-grade tone-${grade.tone}`,
    text: `Grade ${grade.letter}`,
  });

  const text = hero.createDiv({ cls: "flowkit-hero-text" });
  text.createEl("h3", { text: grade.verdict });

  // The floor under the mean. An average hides the single delisted or erroring
  // plugin that is the entire reason to open this, so name the worst one.
  const worst = v.results
    .filter((r) => !r.muted && r.overall != null)
    .sort((a, b) => (a.overall ?? 100) - (b.overall ?? 100))[0];
  const parts = [`Across ${s.count} plugin${s.count === 1 ? "" : "s"}`];
  if (worst && worst.overall != null) parts.push(`worst: ${worst.name} ${worst.overall}`);
  parts.push(`${Math.round(s.confidence * 100)}% of scoring signals available`);
  const watching = v.plugin.observedMs();
  if (watching > 0) parts.push(`watching ${describeWatched(watching)}`);
  text.createEl("p", { cls: "flowkit-hero-sub", text: parts.join(" · ") });

  // Only advice the reader can act on. This said "turn on online enrichment"
  // unconditionally — including to somebody who has it on and is offline or
  // rate-limited, directly above the coverage notice explaining that GitHub
  // couldn't be reached. When enrichment is already on, that notice owns the
  // explanation and the Retry button, so say nothing here.
  if (!graded && v.coverage.disabled) {
    text.createEl("p", {
      cls: "flowkit-hero-hint",
      text: "Turn on online enrichment for maintenance and popularity data, and a letter grade.",
    });
  }
}

export function renderSummary(v: HealthDashboardView, root: HTMLElement): void {
  const s = v.summaryStats();
  const summary = root.createDiv({ cls: "flowkit-health-summary" });
  // "Plugins 31" beside a hero reading "Across 27 plugins" is two different
  // denominators on one screen with nothing to explain the gap — and in a
  // product whose whole argument is that its numbers are honest, that is the
  // paper cut that costs the most. Muted rows are excluded from every count
  // and every finding, so say so where the difference shows up.
  const muted = v.results.length - s.count;
  statTile(
    v,
    summary,
    "Plugins",
    muted > 0 ? `${s.count} of ${v.results.length}` : String(v.results.length),
    "unknown",
    "all",
    muted > 0
      ? `${s.count} counted towards your vault's health; ${muted} muted and excluded.`
      : undefined
  );
  statTile(
    v,
    summary,
    "Updates",
    String(s.updates),
    s.updates > 0 ? "warn" : "good",
    "update"
  );
  statTile(
    v,
    summary,
    "No recent release",
    String(s.unmaintained),
    s.unmaintained > 0 ? "warn" : "good",
    "unmaintained"
  );
  // Relabelled: it clicks through to the `attention` filter, which is broader
  // than "scores below 50" — so the tile now says what it actually shows.
  const attention = v.results.filter((r) => needsAttention(r)).length;
  statTile(
    v,
    summary,
    "Needs attention",
    String(attention),
    attention > 0 ? "bad" : "good",
    "attention"
  );

  renderStartupCost(v, root);
}

/**
 * "Why is my vault slow?", as a question the dashboard can answer.
 *
 * Everything needed for this was already measured and shown one row at a
 * time, where nobody adds it up. Stated as a vault total with a way into the
 * ordered list, the same data becomes a performance triage tool rather than a
 * maintenance checklist.
 */
export function renderStartupCost(v: HealthDashboardView, root: HTMLElement): void {
  const enabled = v.results.filter((r) => r.enabled && !r.muted);
  if (enabled.length === 0) return;

  const cost = startupCost(
    enabled.map((r) => ({
      id: r.id,
      enabled: true,
      bytes: r.bundleBytes,
      // So a load timed against an older build is left out of the total
      // rather than quoted as current — the same rule Footprint applies.
      version: r.version,
    })),
    Object.fromEntries(enabled.map((r) => [r.id, r.runtime ?? {}]))
  );

  const bar = root.createDiv({ cls: "flowkit-startup" });
  setIcon(bar.createSpan({ cls: "flowkit-startup-icon" }), "gauge");
  const parts = [`${enabled.length} plugins load at startup`];
  if (cost.bytes > 0) parts.push(`${formatBytes(cost.bytes)} of code`);
  if (cost.measuredCount > 0) {
    parts.push(
      `${Math.round(cost.measuredMs)} ms measured across ${cost.measuredCount}`
    );
  }
  if (cost.polling > 0) {
    parts.push(`${cost.polling} running a fast repeating timer`);
  }
  bar.createSpan({ cls: "flowkit-startup-text", text: parts.join(" · ") });

  // Say how partial the measurement is. "142 ms across 3" beside "38 plugins
  // enabled" invites the reading that the other 35 are free.
  // The label and the action are now the SAME list. They were computed
  // separately and differed by construction: the count excluded muted and
  // already-measured plugins, the click passed every enabled one — so
  // "Profile the other 12" opened a modal saying "Profile 38 plugins?" and
  // then restarted all 38, including the 26 it had just said it would leave
  // alone.
  const unprofiled = unprofiledIds(v);
  if (v.plugin.runtimeTracking && !v.plugin.profiling && unprofiled.length > 0) {
    const profile = bar.createEl("button", {
      text: `Profile the other ${unprofiled.length}`,
    });
    profile.setAttr(
      "aria-label",
      "Restart each unmeasured plugin in turn and time how long it takes to load"
    );
    profile.onclick = () => startProfileAll(v, unprofiled);
  }

  // Named for what it does. As "Why is my vault slow?" it promised a
  // diagnosis and delivered a sort order, which is a small overclaim in the
  // one place the product is otherwise scrupulous about not making them.
  const btn = bar.createEl("button", { text: "Show the most expensive" });
  btn.setAttr("aria-label", "Order the table by what each plugin costs to run");
  btn.onclick = () => v.applyScope("heavy");
}

/** A stat tile that filters the table to the thing it counts. */
export function statTile(
  v: HealthDashboardView,
  parent: HTMLElement,
  label: string,
  value: string,
  tone: Tone,
  filter: FilterKey,
  hint?: string
): void {
  const tile = parent.createEl("button", { cls: "flowkit-stat" });
  tile.setAttr("aria-label", hint ?? `${value} ${label} — show them`);
  if (hint) tile.setAttr("title", hint);
  // Label first: as a one-line pill it reads "Updates 3", not "3 Updates".
  tile.createSpan({ cls: "flowkit-stat-label", text: label });
  tile.createSpan({ cls: `flowkit-stat-value tone-${tone}`, text: value });
  tile.onclick = () => v.applyScope(filter);
}

export function renderTrends(v: HealthDashboardView, root: HTMLElement): void {
  // Free sees the last 30 days; Pro sees the full retained window.
  const windowDays = v.plugin.isPro ? 90 : 30;
  const cutoff = Date.now() - windowDays * 86_400_000;
  // Two exclusions, both about comparability:
  //  - offline readings, where a missing signal looked like an improvement;
  //  - readings from an older scoring model, which are a different scale.
  // Applied before the window is cut, so the upsell below can count what the
  // window actually costs the reader rather than what these filters removed.
  // …and a third: readings taken on another device. Where `data.json` is
  // synced and the installed plugins are not, a phone with six plugins and a
  // desktop with forty were drawing one polyline between two different
  // vaults' health.
  const comparable = v.plugin.settings.history
    .filter(
      (h): h is HealthSnapshot & { avg: number } =>
        h.avg != null &&
        h.online !== false &&
        h.model === SCORING_MODEL &&
        v.plugin.isThisDevice(h)
    )
    .sort((a, b) => a.at - b.at);
  const history = comparable.filter((h) => h.at >= cutoff);

  const section = root.createDiv({ cls: "flowkit-trends" });
  const head = section.createDiv({ cls: "flowkit-section-head" });
  setIcon(head.createSpan({ cls: "flowkit-section-icon" }), "trending-up");
  head.createSpan({
    cls: "flowkit-section-title",
    text: `Vault health trend · ${windowDays} days`,
  });

  const usable = history;

  if (usable.length === 0) {
    // "From tomorrow" is only true if tomorrow's reading would be plottable.
    // Snapshots carry `online: coverage.stats`, which is permanently false
    // while enrichment is off, and the chart drops anything with
    // `online === false` — so a privacy-minded user with ninety stored
    // readings was told to come back tomorrow, every day, forever.
    // THIS device's readings. Counting the whole shared history and then
    // blaming enrichment for none of them being plottable was wrong twice on
    // a synced vault: most of those readings belong to the other machine and
    // are excluded by the device filter, not by enrichment — so turning
    // enrichment on would not plot a single one of the ninety it named.
    const stored = v.plugin.settings.history.filter((h) =>
      v.plugin.isThisDevice(h)
    ).length;
    section.createDiv({
      cls: "flowkit-trends-empty",
      text: v.coverage.disabled
        ? stored > 0
          ? `${stored} reading${stored === 1 ? "" : "s"} recorded, but none can be plotted: with online enrichment off, a score is built from local signals only and isn't comparable with one that wasn't. Turn enrichment on and the trend starts building.`
          : "With online enrichment off, readings aren't comparable enough to plot. Turn it on and the trend starts building."
        : "FlowKit records one reading a day. Your trend appears here from tomorrow.",
    });
    return;
  }
  if (usable.length === 1) {
    section.createDiv({
      cls: "flowkit-trends-empty",
      text: `First reading recorded: ${usable[0].avg}/100. The trend line builds from tomorrow.`,
    });
    return;
  }

  const latest = usable[usable.length - 1];
  // The baseline must come from the points actually drawn. Reading it back
  // out of the full history would quote a delta against a snapshot the chart
  // just excluded for being incomparable.
  const prev = usable[usable.length - 2];
  const row = section.createDiv({ cls: "flowkit-trends-row" });
  renderSparkline(v, row, usable);

  const delta = row.createDiv({ cls: "flowkit-trends-delta" });
  if (prev) {
    const d = latest.avg - prev.avg;
    const tone: Tone = d > 0 ? "good" : d < 0 ? "bad" : "unknown";
    const sign = d > 0 ? "▲" : d < 0 ? "▼" : "—";
    delta.createSpan({
      cls: `flowkit-delta tone-${tone}`,
      text: `${sign} ${Math.abs(d)}`,
    });
    delta.createSpan({
      cls: "flowkit-delta-sub",
      text: ` since ${describeWhen(prev.at)}`,
    });
  } else {
    delta.createSpan({
      cls: "flowkit-delta-sub",
      text: `${usable.length} readings recorded`,
    });
  }

  // Only ask when the window is actually costing the reader something.
  //
  // This compared against the WHOLE history, including readings the chart
  // dropped for being offline or scored on an older model — so a free user
  // three weeks in, with two network hiccups behind them, was told they had
  // five readings saved and offered ninety days to see them. The number in
  // an upsell has to be a number the purchase would change.
  const beyondWindow = comparable.length - usable.length;
  if (!v.plugin.isPro && beyondWindow > 0) {
    const more = section.createDiv({ cls: "flowkit-trends-more" });
    more.appendText(
      `${beyondWindow} older reading${beyondWindow === 1 ? "" : "s"} sit${
        beyondWindow === 1 ? "s" : ""
      } outside this 30-day window. `
    );
    const link = more.createEl("button", { text: "See all 90 days with Pro" });
    link.onclick = () => v.openUpgrade("history");
  }
}

export function renderSparkline(
  v: HealthDashboardView,
  parent: HTMLElement,
  points: Array<HealthSnapshot & { avg: number }>
): void {
  const w = 180;
  const h = 40;
  const pad = 3;
  const values = points.map((p) => p.avg);
  // Auto-scale to the data. It used to force `max(...values, 100)` and
  // `min(...values, 0)`, pinning the span to at least 100 inside a 34px
  // drawing area — so real movement of a few points rendered as about one
  // pixel, and the headline trend feature drew a flat line.
  const lo = Math.max(0, Math.min(...values) - 3);
  const hi = Math.min(100, Math.max(...values) + 3);
  const span = Math.max(1, hi - lo);
  // Space by real elapsed time, so a gap in scanning looks like a gap.
  const t0 = points[0].at;
  const tSpan = Math.max(1, points[points.length - 1].at - t0);
  const pts = points
    .map((p) => {
      const x = pad + ((p.at - t0) / tSpan) * (w - pad * 2);
      const y = pad + (1 - (p.avg - lo) / span) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const svg = svgEl(parent, "svg", {
    viewBox: `0 0 ${w} ${h}`,
    width: w,
    height: h,
    class: "flowkit-sparkline",
  });
  svgEl(svg, "polyline", {
    points: pts,
    fill: "none",
    "stroke-width": 2,
    "stroke-linejoin": "round",
    "stroke-linecap": "round",
    class: "flowkit-sparkline-line",
  });
  // Highlight the last point.
  const last = points[points.length - 1];
  const lx = pad + (w - pad * 2);
  const ly = pad + (1 - (last.avg - lo) / span) * (h - pad * 2);
  svgEl(svg, "circle", { cx: lx, cy: ly, r: 3, class: "flowkit-sparkline-dot" });
  svg.setAttribute(
    "aria-label",
    `Vault health from ${values[0]} to ${last.avg} over ${points.length} readings.`
  );
}

export function renderLegend(v: HealthDashboardView, root: HTMLElement): void {
  const legend = root.createDiv({ cls: "flowkit-health-legend" });
  legend.createEl("strong", { text: "How to read this: " });
  legend.createSpan({
    text:
      "Scores are 0–100. Overall is a weighted blend — Compatibility 25%, " +
      "Reliability 25%, Maintenance 25%, Footprint 15%, Hygiene 5%, " +
      "Popularity 5% — " +
      "renormalised over whatever data is actually available, with the " +
      "confidence figure above showing how much that was. A plugin that " +
      "can't load is capped at 20 regardless of its other scores, and one " +
      "removed from the community directory at 30. Click a column to " +
      "sort; use the ⋮ menu to enable/disable, open, watch, or mute.",
  });

  // Said in the product, not only in the README. A letter grade is a
  // confident-looking artifact and people read it as a verdict on the
  // software, which is a claim this cannot support and has never made.
  const limits = legend.createDiv({ cls: "flowkit-legend-limits" });
  limits.createEl("strong", { text: "What this score is not: " });
  limits.createSpan({
    text:
      "it is not a judgement of whether a plugin is any good, whether its " +
      "code is safe, or whether you should keep it. It measures whether it " +
      "can run here, whether it has thrown errors on this machine, whether " +
      "it is still being worked on, and what it costs to load. A plugin you " +
      "love can score badly for being finished; a plugin you never use can " +
      "score perfectly. Popularity is context, not health — a niche plugin " +
      "is not a worse plugin. Treat a low score as a reason to look, not a " +
      "reason to uninstall.",
  });
}
