/** "What to fix": the findings, the disable-first ranking and the all-clear. */
import { apiVersion, setIcon } from "obsidian";
import type { PluginHealth } from "../types";
import { isIncompatible, type Insight } from "../insights";
import { totalUncaught } from "../errors";
import { rankSafeDisable } from "../triage";
import { roundsNeeded } from "../bisect";
import { PRO_PRICE } from "../product";
import { describeWatched } from "./format";
import { runBulk } from "./vaultActions";
import type { HealthDashboardView } from "../view";

export function renderInsights(v: HealthDashboardView, root: HTMLElement): void {
  const insights = v.insights();
  const section = root.createDiv({ cls: "flowkit-insights" });

  const head = section.createDiv({ cls: "flowkit-section-head" });
  setIcon(head.createSpan({ cls: "flowkit-section-icon" }), "lightbulb");
  head.createSpan({ cls: "flowkit-section-title", text: "What to fix" });

  // When nothing is wrong, state the negative results. A diagnosis that finds
  // nothing used to render as four green words, so the user never saw the
  // work that was done — and this is the state most vaults are in most of the
  // time, which made it the least designed screen in the product.
  if (insights.length === 1 && insights[0].id === "healthy") {
    renderAllClear(v, section);
    return;
  }

  renderStartHere(v, section);

  // The complete diagnosis, for everyone.
  //
  // This used to show insights[0] and then a lock card. It converted nobody:
  // every input the hidden insights are built from was already free — the
  // badges, the chips — and the filter dropdown ships a dedicated option for
  // each hidden cohort, so any user could reconstruct the whole list in five
  // seconds and conclude the gate was artificial. What Pro sells now is
  // applying the fixes, not being told what they are.
  for (const ins of insights) renderInsightCard(v, section, ins);

  if (v.plugin.isPro) return;

  // The ask, framed around the one question this list cannot answer.
  //
  // A ranked to-do list tells you what is wrong with each plugin. It says
  // nothing about the problem that has no single culprit — the lag, the
  // freeze, the thing that started last Tuesday — and that is exactly the
  // problem people install a plugin-health tool to solve. So the pitch is
  // the search, on this vault's real numbers.
  const enabled = v.results.filter((r) => r.enabled).length;
  if (enabled < 2) return;

  const lock = section.createDiv({ cls: "flowkit-insight-lock" });
  const body = lock.createDiv({ cls: "flowkit-insight-lock-body" });
  setIcon(body.createSpan({ cls: "flowkit-lock-icon" }), "search-check");
  const txt = body.createDiv();
  txt.createEl("strong", {
    text: "Something wrong that isn't on this list?",
  });
  txt.createDiv({
    cls: "flowkit-lock-sub",
    text:
      `FlowKit can find it by elimination — switching off half your plugins, asking whether the problem is still there, ` +
      `and halving until one is left. That's ${roundsNeeded(enabled)} questions to search your ${enabled} enabled plugins, ` +
      `instead of an evening of it. Everything it switches off goes back on afterwards. Pro, ${PRO_PRICE}.`,
  });
  const btn = lock.createEl("button", { cls: "flowkit-health-btn flowkit-upgrade-btn" });
  btn.setText("See how it works");
  btn.onclick = () => v.openUpgrade("bisect");
}

/**
 * The order to act in.
 *
 * The findings say what is wrong; for a vault with nine of them, that still
 * isn't an answer. Ranking by badness alone answers it wrongly — the
 * worst-scoring plugin is often the one used every day, while the easy win is
 * the broken thing the user forgot was installed. This ranks by trouble
 * removed per feature given up, and says what each one would cost.
 */
export function renderStartHere(v: HealthDashboardView, section: HTMLElement): void {
  const ranked = rankSafeDisable(v.results, 3);
  // Below three findings there is no ordering problem to solve, and a "start
  // here" list in front of a two-item list is furniture.
  if (ranked.length < 2) return;

  const box = section.createDiv({ cls: "flowkit-starthere" });
  const head = box.createDiv({ cls: "flowkit-starthere-head" });
  setIcon(head.createSpan({ cls: "flowkit-section-icon" }), "list-ordered");
  head.createSpan({ cls: "flowkit-starthere-title", text: "Disable these first" });
  head.createSpan({
    cls: "flowkit-starthere-sub",
    text: "Most trouble removed for the least you'd give up",
  });

  const list = box.createEl("ol", { cls: "flowkit-starthere-list" });
  for (const c of ranked) {
    const li = list.createEl("li");
    const name = li.createEl("button", {
      cls: "flowkit-plugin-name",
      text: c.name,
    });
    name.setAttr("aria-label", `${c.name} — open its reasoning`);
    name.onclick = () => {
      v.expandedId = c.id;
      // Scoped by id rather than by searching its name: a plugin whose name
      // is a substring of another's would otherwise take you to a list of
      // two, which is not what the card promised.
      v.applyScope({
        id: `plugin:${c.id}`,
        tone: "info",
        icon: "plug",
        title: c.name,
        detail: "",
        ids: [c.id],
        match: (r: PluginHealth) => r.id === c.id,
      });
    };
    li.createDiv({ cls: "flowkit-starthere-why", text: `Because ${c.why}.` });
    li.createDiv({ cls: "flowkit-starthere-loss", text: `You'd lose: ${c.loss}.` });
  }
}

/** The good case, stated as the checks that passed rather than as an absence. */
export function renderAllClear(v: HealthDashboardView, section: HTMLElement): void {
  const live = v.results.filter((r) => !r.muted);
  const card = section.createDiv({ cls: "flowkit-allclear" });
  const head = card.createDiv({ cls: "flowkit-allclear-head" });
  setIcon(head.createSpan({ cls: "flowkit-allclear-icon" }), "check-circle");
  head.createSpan({
    cls: "flowkit-allclear-title",
    text: `Checked ${live.length} plugin${live.length === 1 ? "" : "s"}. Nothing needs your attention.`,
  });

  const watched = v.plugin.observedMs();
  const errors = totalUncaught(v.plugin.settings.errorLog);
  const checks = [
    `${live.filter((r) => r.listing === "delisted").length} pulled from the community directory`,
    `${live.filter((r) => isIncompatible(r)).length} incompatible with Obsidian ${apiVersion}`,
    watched > 0
      ? `${errors} error${errors === 1 ? "" : "s"} traced to a plugin in ${describeWatched(watched)} of watching`
      : "error watching is off",
    `${live.filter((r) => r.maintenanceStatus === "unmaintained").length} without a release in 18 months`,
  ];
  const list = card.createEl("ul", { cls: "flowkit-allclear-list" });
  for (const c of checks) list.createEl("li", { text: c });
}

export function renderInsightCard(v: HealthDashboardView, parent: HTMLElement, ins: Insight): void {
  const card = parent.createDiv({ cls: `flowkit-insight tone-${ins.tone}` });
  setIcon(card.createSpan({ cls: "flowkit-insight-icon" }), ins.icon);
  const body = card.createDiv({ cls: "flowkit-insight-body" });
  body.createDiv({ cls: "flowkit-insight-title", text: ins.title });
  body.createDiv({ cls: "flowkit-insight-detail", text: ins.detail });

  // An insight that names plugins should be able to show you exactly them —
  // scoped by the same predicate the count was built from.
  if (ins.ids.length) {
    card.addClass("is-clickable");
    card.setAttr("tabindex", "0");
    card.setAttr("role", "button");
    card.setAttr(
      "aria-label",
      `${ins.title} — show these ${ins.ids.length} plugin${ins.ids.length === 1 ? "" : "s"}`
    );
    const go = () => v.applyScope(ins);
    card.onclick = (evt) => {
      if ((evt.target as HTMLElement).closest("button")) return;
      go();
    };
    card.onkeydown = (evt) => {
      if (evt.key !== "Enter" && evt.key !== " ") return;
      if ((evt.target as HTMLElement) !== card) return;
      evt.preventDefault();
      go();
    };
  }
  // Free since 1.4.0. Charging for this asked people to pay for the
  // difference between one click and three — a thirty-second job they can do
  // in Obsidian's own settings, which is why it converted nobody. What Pro
  // sells now is the work that genuinely can't be done by hand: the search,
  // the profile, the saved sets.
  if (ins.action && ins.ids.length) {
    const btn = card.createEl("button", { cls: "flowkit-insight-action" });
    btn.setText(ins.actionLabel ?? "Apply");
    btn.onclick = () => runBulk(v, ins);
  }
}
