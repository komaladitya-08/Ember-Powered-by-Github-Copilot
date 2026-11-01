/**
 * Draws a task's plan and its result view on its card (app/shared/view.ts's catalog). Every string is set as text
 * (textContent), never as markup: what a worker sends may carry what it read on the screen. Nothing drawn here takes a
 * click, so the overlay stays click-through over it (only the card's buttons do: taskRects).
 */

import { PLAN_WORD, type PlanStep, type ViewBlock } from "../../shared/view";

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

/** One block of a result view. */
function block(b: ViewBlock): HTMLElement {
  switch (b.kind) {
    case "text":
      return el("p", { textContent: b.text });
    case "list": {
      const list = el(b.ordered ? "ol" : "ul");
      list.append(...b.items.map(t => el("li", { textContent: t })));
      return list;
    }
    case "facts": {
      const dl = el("dl");
      for (const r of b.rows) dl.append(el("dt", { textContent: r.label }), el("dd", { textContent: r.value }));
      return dl;
    }
    case "table": {
      const table = el("table");
      const head = el("tr");
      head.append(...b.columns.map(c => el("th", { textContent: c, scope: "col" })));
      table.append(el("thead"), el("tbody"));
      table.tHead!.append(head);
      for (const r of b.rows) {
        const tr = el("tr");
        tr.append(...r.map(c => el("td", { textContent: c })));
        table.tBodies[0].append(tr);
      }
      return table;
    }
    case "file": {
      const p = el("p", { className: "file" });
      if (b.label) p.append(el("span", { className: "file-label", textContent: `${b.label}: ` }));
      p.append(el("code", { textContent: b.path }));
      return p;
    }
  }
}

/** A result view's blocks, in order. */
export function viewNodes(view: readonly ViewBlock[]): HTMLElement[] {
  return view.map(block);
}
