/**
 * Small pieces the Changes and Plan tabs share: a part of a tab drawn again without losing the keyboard's place (the
 * focused control is found again by its `data-key`), arrow keys between a list's items, a segmented choice that is a
 * radio group (one tab stop, arrows between its choices), and a wait that runs once after a burst of calls. All text
 * goes in as text (dom.ts `el`).
 */
import { el } from "./dom";

/** Replace `host`'s children, focusing again the control that had focus (by its `data-key`) when it is still there. */
export function redraw(host: HTMLElement, ...kids: (Node | null | false | undefined)[]): void {
  const active = document.activeElement as HTMLElement | null;
  const key = active && host.contains(active) ? active.dataset.key : undefined;
  const caret = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] as const : null;
  host.replaceChildren(...kids.filter((k): k is Node => !!k));
  if (!key) return;
  const again = host.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
  if (!again) return;
  again.focus({ preventScroll: true });
  if (caret && (again instanceof HTMLTextAreaElement || again instanceof HTMLInputElement) && caret[0] !== null) {
    try { again.setSelectionRange(caret[0], caret[1] ?? caret[0]); } catch { /* an input type without a caret: focus is enough */ }
  }
}

/** Up and Down (and Home, End) move focus between `list`'s items that match `selector`; Tab still reaches each. */
export function arrowsBetween(list: HTMLElement, selector: string): void {
  list.addEventListener("keydown", e => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
    const items = [...list.querySelectorAll<HTMLElement>(selector)].filter(i => !(i as HTMLButtonElement).disabled);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
    e.preventDefault();
    items[next].focus();
  });
}

/** A segmented choice drawn as a radio group: one tab stop, the arrow keys move and choose. */
export function segmented<T extends string>(label: string, choices: readonly { value: T; label: string }[], key: string, onChoose: (v: T) => void): { node: HTMLElement; set(v: T): void } {
  const node = el("div", { className: "seg", attrs: { role: "radiogroup", "aria-label": label } });
  const buttons = choices.map(c => {
    const b = el("button", { type: "button", className: "seg-item", textContent: c.label, attrs: { role: "radio", "aria-checked": "false" }, data: { value: c.value, key: `${key}-${c.value}` } });
    b.addEventListener("click", () => onChoose(c.value));
    return b;
  });
  node.append(...buttons);
  node.addEventListener("keydown", e => {
    const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[(Math.max(0, i) + dir + buttons.length) % buttons.length];
    next.focus();
    onChoose(next.dataset.value as T);
  });
  const set = (v: T) => {
    for (const b of buttons) {
      const on = b.dataset.value === v;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
  };
  return { node, set };
}

/** `fn` once, `ms` after the last of a burst of calls. */
export function settle(ms: number, fn: () => void): { call(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    call() { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; fn(); }, ms); },
    cancel() { if (timer) clearTimeout(timer); timer = null; },
  };
}

/** A section of a tab: its heading (an h2: the window's h1 is the session's name) and its body. */
export function section(id: string, title: string, ...kids: (Node | null | false | undefined)[]): HTMLElement {
  return el("section", { className: "pt-section", attrs: { "aria-labelledby": `${id}-h` } },
    el("h2", { className: "pt-h", id: `${id}-h`, textContent: title }), ...kids.filter((k): k is Node => !!k));
}
