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

/**
 * Labels of fields whose contents never reach the model: passwords, payment and
 * bank details, one-time codes, keys. The sidecar withholds these already
 * (SECRET_LABEL in ember_atspi.py; keep the two in step); this is the second line.
 */
const SECRET_LABEL = /\b(pass(word|phrase|code)|passwd|passwort|kennwort|mot de passe|contrase(n|ñ)a|senha|pin( ?code)?|card ?(number|no)|credit ?card|cvv2?|cvc2?|csc|security code|card verification|expir(y|ation)|iban|routing number|account number|sort code|one[- ]time (code|password|pin)|otp|2fa|two[- ]factor|totp|verification code|auth(entication)? code|recovery (code|key)|secret|private key|(api|access|auth|bearer) ?(key|token)|ssn|social security)\b/;

/** Does this field name or label say its contents are secret? */
export const isSecretLabel = (label: string) => !!label && SECRET_LABEL.test(label.normalize("NFKC").replace(/\p{Cf}/gu, "").toLowerCase());

/** Input fields, whose label can make their contents secret (documents and terminals are not judged by name). */
const FIELD_ROLES = new Set(["text", "entry", "password text", "spin button", "combo box"]);

/** Is this element's text off limits (a password field, or a field labelled as secret)? */
export function isSecretNode(n: Pick<AxNode, "role" | "name"> & { secret?: boolean }, label = ""): boolean {
  return !!n.secret || n.role === "password text" || (FIELD_ROLES.has(n.role) && (isSecretLabel(n.name) || isSecretLabel(label)));
}

/** JSON-quoted and truncated; "<" is escaped so screen text can't close the <screen> wrapper. */
const quote = (s: string, max: number) => JSON.stringify(s.length > max ? s.slice(0, max) + "…" : s).replace(/</g, "\\u003c");
/** The same quoting for screen text that reaches the model anywhere else (titles, names, values). */
export const quoteUntrusted = (s: string, max = 120) => quote(s, max);
/**
 * Role and action names, bare when they are plain words ("push button", "click"), quoted otherwise:
 * an app can make up its own role and action names, so they are screen text too.
 */
export const screenWord = (s: string) => /^[a-z][a-z0-9 _-]{0,39}$/i.test(s) ? s : quote(s, 40);

export interface SerializeOptions {
  maxLines?: number;
  maxTextChars?: number;
  /** Include bounds (for workers that click by element). */
  withBounds?: boolean;
  /** Lines put first inside the wrapper (they must quote any screen text themselves, with quoteUntrusted). */
  header?: string[];
}

export function serializeElements(window: AxWindow, nodes: AxNode[], opts: SerializeOptions = {}): string {
  const maxLines = opts.maxLines ?? 150;
  const labels = inferLabels(nodes);
  const minDepth = Math.min(...nodes.map(n => n.depth), 0);
  const lines: string[] = [];
  for (const n of nodes) {
    if (lines.length >= maxLines) { lines.push(`… ${nodes.length - maxLines} more elements not shown`); break; }
    const name = n.name || labels.get(n.id) || "";
    const bits = [`[${n.id}] ${screenWord(n.role)}`];
    if (name) bits.push(quote(name, 80) + (n.name ? "" : " (label)"));
    const states = n.states.filter(s => !["enabled", "sensitive", "focusable"].includes(s));
    if (!n.states.includes("sensitive") && !n.states.includes("enabled")) states.push("disabled");
    // Contents of password and payment fields are never shown, whatever the sidecar sent.
    const secret = isSecretNode(n, name);
    if (secret) states.push("secret");
    if (states.length) bits.push(`(${states.join(", ")})`);
    if (n.value !== undefined && !secret) bits.push(`value=${n.value}`);
    if (n.actions?.length) bits.push(`actions=${n.actions.map(screenWord).join("/")}`);
    if (n.text && !secret) bits.push(`text=${quote(n.text, opts.maxTextChars ?? 160)}`);
    if (n.selection && !secret) bits.push(`selected=${quote(n.selection, 300)}`);
    if (opts.withBounds && n.bounds) bits.push(`@${n.bounds.x},${n.bounds.y} ${n.bounds.width}x${n.bounds.height}`);
    lines.push("  ".repeat(Math.max(0, n.depth - minDepth)) + bits.join(" "));
  }
  const attrs = `app=${quote(window.app, 60)} window=${quote(window.name, 100)}`;
  return `<screen source="accessibility" ${attrs} untrusted="true">\n${[...opts.header ?? [], ...lines].join("\n")}\n</screen>`;
}

export function focusedElement(nodes: AxNode[]): AxNode | null {
  return nodes.find(n => n.states.includes("focused")) ?? null;
}

/** True when the app or window matches the user's "never look at" list. */
export function isNeverLook(window: { app: string; name: string }, list: string[]): boolean {
  const hay = `${window.app} ${window.name}`.toLowerCase();
  return list.some(item => item.trim() && hay.includes(item.trim().toLowerCase()));
}
