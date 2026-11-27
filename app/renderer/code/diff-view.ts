/**
 * A unified diff drawn as rows (shared/diff-rows.ts): each line with its old and new numbers and a sign, and for a
 * screen reader the words "Added: " or "Removed: " before it, so a change is never told by colour alone (WCAG 1.4.1).
 */
import { diffRows } from "../shared/diff-rows";
import { el } from "./dom";

export const DIFF_WORDS = { add: "Added: ", del: "Removed: " } as const;
export function diffSummary(added: number, removed: number): string {
  const n = (k: number) => `${k.toLocaleString("en-GB")} ${k === 1 ? "line" : "lines"}`;
  return `${n(added)} added, ${n(removed)} removed`;
}
export function diffMore(n: number): string { return `${n.toLocaleString("en-GB")} more ${n === 1 ? "line" : "lines"} not shown.`; }

/** `diff` as a group of rows, scrollable and reachable by the keyboard. */
export function diffView(diff: string, label?: string, opts: { numbered?: boolean } = {}): HTMLElement {
  const d = diffRows(diff);
  const summary = diffSummary(d.added, d.removed);
  const lines = el("div", { className: `diff-lines${opts.numbered === false ? " unnumbered" : ""}`, tabIndex: 0, attrs: { "aria-label": label ? `${label}: ${summary}` : summary } });
  for (const r of d.rows) {
    const sign = r.kind === "add" ? "+" : r.kind === "del" ? "−" : "";
    const words = r.kind === "add" || r.kind === "del" ? DIFF_WORDS[r.kind] : "";
    lines.append(el("div", { className: `d-${r.kind}` },
      el("span", { className: "d-no", textContent: r.oldNo !== undefined ? String(r.oldNo) : "", attrs: { "aria-hidden": "true" } }),
      el("span", { className: "d-no", textContent: r.newNo !== undefined ? String(r.newNo) : "", attrs: { "aria-hidden": "true" } }),
      el("span", { className: "d-sign", textContent: sign, attrs: { "aria-hidden": "true" } }),
      el("span", { className: "d-text" }, words ? el("span", { className: "sr", textContent: words }) : null, r.text || " ")));
  }
  return el("div", { className: "diff", attrs: { role: "group", "aria-label": summary } },
    el("p", { className: "diff-summary", textContent: summary }), lines,
    d.more ? el("p", { className: "hint", textContent: diffMore(d.more) }) : null);
}
