/**
 * Turns an accessibility snapshot into compact text for the model. Unnamed
 * controls borrow the label to their left (GTK switches have no name of their
 * own). Everything read from the screen is wrapped as untrusted data.
 */

import type { AxNode, AxWindow } from "./sidecar";

const INTERACTIVE = new Set(["push button", "toggle button", "check box", "radio button", "combo box", "text", "entry",
  "password text", "spin button", "slider", "menu item", "menu", "link", "page tab", "list item", "table cell", "check menu item",
  "radio menu item", "tree item", "switch", "icon"]);

export function inferLabels(nodes: AxNode[]): Map<number, string> {
  const labels = nodes.filter(n => n.role === "label" && n.name && n.bounds);
  const out = new Map<number, string>();
  for (const n of nodes) {
    if (n.name || !n.bounds || !INTERACTIVE.has(n.role)) continue;
    const cy = n.bounds.y + n.bounds.height / 2;
    let best: { name: string; gap: number } | null = null;
    for (const l of labels) {
      const b = l.bounds!;
      const ly = b.y + b.height / 2;
      const gap = n.bounds.x - (b.x + b.width);
      if (Math.abs(ly - cy) < Math.max(12, n.bounds.height / 2) && gap >= -4 && gap < 320 && (!best || gap < best.gap)) best = { name: l.name, gap };
    }
    if (best) out.set(n.id, best.name);
  }
  return out;
}

/** JSON-quoted and truncated; "<" is escaped so screen text can't close the <screen> wrapper. */
const quote = (s: string, max: number) => JSON.stringify(s.length > max ? s.slice(0, max) + "…" : s).replace(/</g, "\\u003c");

export interface SerializeOptions {
  maxLines?: number;
  maxTextChars?: number;
  /** Include bounds (for workers that click by element). */
  withBounds?: boolean;
}

export function serializeElements(window: AxWindow, nodes: AxNode[], opts: SerializeOptions = {}): string {
  const maxLines = opts.maxLines ?? 150;
  const labels = inferLabels(nodes);
  const minDepth = Math.min(...nodes.map(n => n.depth), 0);
  const lines: string[] = [];
  for (const n of nodes) {
    if (lines.length >= maxLines) { lines.push(`… ${nodes.length - maxLines} more elements not shown`); break; }
    const name = n.name || labels.get(n.id) || "";
    const bits = [`[${n.id}] ${n.role}`];
    if (name) bits.push(quote(name, 80) + (n.name ? "" : " (label)"));
    const states = n.states.filter(s => !["enabled", "sensitive", "focusable"].includes(s));
    if (!n.states.includes("sensitive") && !n.states.includes("enabled")) states.push("disabled");
    if (states.length) bits.push(`(${states.join(", ")})`);
    if (n.value !== undefined) bits.push(`value=${n.value}`);
    if (n.actions?.length) bits.push(`actions=${n.actions.join("/")}`);
    if (n.text) bits.push(`text=${quote(n.text, opts.maxTextChars ?? 160)}`);
    if (opts.withBounds && n.bounds) bits.push(`@${n.bounds.x},${n.bounds.y} ${n.bounds.width}x${n.bounds.height}`);
    lines.push("  ".repeat(Math.max(0, n.depth - minDepth)) + bits.join(" "));
  }
  const attrs = `app=${quote(window.app, 60)} window=${quote(window.name, 100)}`;
  return `<screen source="accessibility" ${attrs} untrusted="true">\n${lines.join("\n")}\n</screen>`;
}

export function focusedElement(nodes: AxNode[]): AxNode | null {
  return nodes.find(n => n.states.includes("focused")) ?? null;
}

/** True when the app or window matches the user's "never look at" list. */
export function isNeverLook(window: { app: string; name: string }, list: string[]): boolean {
  const hay = `${window.app} ${window.name}`.toLowerCase();
  return list.some(item => item.trim() && hay.includes(item.trim().toLowerCase()));
}
