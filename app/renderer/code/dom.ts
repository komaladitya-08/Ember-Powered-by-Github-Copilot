/**
 * Small DOM helpers for the coding window's views: an element maker that puts every string in as text (never markup),
 * and ids safe to build from SDK request ids. Model and tool text reaches the page only through these, `textContent`
 * and markdown-dom.ts.
 */

type Props<K extends keyof HTMLElementTagNameMap> = Partial<Omit<HTMLElementTagNameMap[K], "style" | "children">> & {
  className?: string;
  attrs?: Record<string, string | undefined>;
  data?: Record<string, string | undefined>;
};

/** An element with its properties, attributes and children (strings become text nodes). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props<K> = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const { attrs, data, ...rest } = props;
  const e = Object.assign(document.createElement(tag), rest);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== undefined) e.setAttribute(k, v);
  for (const [k, v] of Object.entries(data ?? {})) if (v !== undefined) e.dataset[k] = v;
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
}

/** A button of the shared kinds: quiet (bordered) unless `prominent`, small unless `large`. */
export function button(label: string, opts: { prominent?: boolean; large?: boolean; className?: string; aria?: string; onClick?: (e: MouseEvent) => void; disabled?: boolean } = {}): HTMLButtonElement {
  const b = el("button", { type: "button", className: `btn${opts.prominent ? "" : " quiet"}${opts.large ? "" : " small"}${opts.className ? ` ${opts.className}` : ""}`, textContent: label, disabled: !!opts.disabled });
  if (opts.aria) b.setAttribute("aria-label", opts.aria);
  if (opts.onClick) b.addEventListener("click", opts.onClick);
  return b;
}

/** An id fragment from any string (an SDK id may hold anything): letters, digits, "-" and "_" only, kept unique by a hash. */
export function idPart(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${s.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}-${(h >>> 0).toString(36)}`;
}

/** The element by id (the page's own, so it is there). */
export const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Replace `node`'s text only when it changes (a live region written with the same words says them again). */
export function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/** Copies `text` to the clipboard: the async API where the page may use it, else a selection the browser copies. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* the window denies clipboard permission requests: copy through a selection instead */ }
  const area = el("textarea", { value: text, className: "copy-buffer", readOnly: true });
  document.body.append(area);
  area.select();
  let ok: boolean;
  try { ok = document.execCommand("copy"); } catch { ok = false; /* nothing more to try */ }
  area.remove();
  return ok;
}
