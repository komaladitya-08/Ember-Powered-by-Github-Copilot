/**
 * Draws a task's plan and its activity's rows on its card (its view is drawn by app/renderer/shared/view-dom.ts). Every
 * string is set as text (textContent), never as markup: what a worker sends may carry what it read on the screen.
 * Nothing drawn here takes a click, so the overlay stays click-through over it (only the card's buttons do: taskRects).
 */

import { PLAN_WORD, type PlanStep } from "../../shared/view";
import { ROW_WORD, elapsedText, type ActivityRow } from "../../shared/activity";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] =>
  Object.assign(document.createElement(tag), props);

/** A plan's steps as list items: each with its state for screen readers ("Done: ", "Now: ", "Next: "). */
export function planItems(plan: readonly PlanStep[]): HTMLLIElement[] {
  return plan.map(p => {
    const li = el("li");
    li.dataset.state = p.state;
    li.append(el("span", { className: "sr", textContent: PLAN_WORD[p.state] }), document.createTextNode(p.text));
    return li;
  });
}

/**
 * The card's details: one row per item or group of steps, its state as a symbol (and in words for screen readers), when
 * it happened, and its words. The worker's own note is set apart as its words, not Ember's ("Note: " before it).
 */
export function activityItems(rows: readonly ActivityRow[]): HTMLLIElement[] {
  return rows.map(r => {
    const li = el("li");
    li.dataset.state = r.state;
    if (r.model) li.dataset.model = "";
    li.append(
      el("span", { className: "sr", textContent: r.model ? "Note: " : ROW_WORD[r.state] }),
      el("span", { className: "at", textContent: elapsedText(r.at) }),
      el("span", { className: "words", textContent: r.words }),
    );
    return li;
  });
}
