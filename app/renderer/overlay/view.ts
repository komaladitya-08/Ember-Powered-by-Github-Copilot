/**
 * Draws a task's plan, its result view (app/shared/view.ts's catalog) and its activity's rows on its card. Every string
 * is set as text (textContent), never as markup: what a worker sends may carry what it read on the screen. Nothing drawn
 * here takes a click, so the overlay stays click-through over it (only the card's buttons do: taskRects). A progress
 * bar's width is computed here from checked whole numbers only, and set once (no transition).
 */

import { PLAN_WORD, TONE_WORD, progressWords, type PlanStep, type ViewBlock } from "../../shared/view";
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
    case "checklist": {
      const list = el("ul", { className: "checklist" });
      list.append(...b.items.map(i => {
        const li = el("li");
        li.dataset.done = String(i.done);
        li.append(el("span", { className: "sr", textContent: i.done ? "Done: " : "Not done: " }), document.createTextNode(i.text));
        return li;
      }));
      return list;
    }
    case "progress": {
      const wrap = el("div", { className: "progress" });
      const words = el("p");
      words.append(el("span", { className: "progress-label", textContent: b.label }), el("span", { className: "progress-n", textContent: progressWords(b.value, b.total) }));
      // Decorative: the words say it (the bar is hidden from screen readers).
      const track = el("div", { className: "bar" });
      track.setAttribute("aria-hidden", "true");
      const fill = el("i");
      const pct = b.total > 0 ? Math.min(100, Math.max(0, Math.round((b.value / b.total) * 100))) : 0;
      fill.style.width = `${pct}%`;
      track.append(fill);
      wrap.append(words, track);
      return wrap;
    }
    case "compare": {
      const table = el("table", { className: "compare" });
      const head = el("tr");
      head.append(el("td"), ...b.columns.map(c => el("th", { textContent: c, scope: "col" })));
      table.append(el("thead"), el("tbody"));
      table.tHead!.append(head);
      for (const r of b.rows) {
        const tr = el("tr");
        tr.append(el("th", { textContent: r.label, scope: "row" }), el("td", { textContent: r.a }), el("td", { textContent: r.b }));
        table.tBodies[0].append(tr);
      }
      return table;
    }
    case "excerpt": {
      const fig = el("figure", { className: "excerpt" });
      fig.append(el("figcaption", { textContent: b.path }), el("pre", { textContent: b.lines.join("\n") }));
      return fig;
    }
    case "status": {
      const p = el("p", { className: "status-block" });
      p.dataset.tone = b.tone;
      p.append(el("span", { className: "sr", textContent: TONE_WORD[b.tone] }), document.createTextNode(b.text));
      return p;
    }
  }
}

/** A result view's blocks, in order. */
export function viewNodes(view: readonly ViewBlock[]): HTMLElement[] {
  return view.map(block);
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
