/**
 * The command palette: every action of the window and the shown session's slash commands by name, filtered as one
 * types, driven by the keyboard (Up, Down, Enter, Escape). It opens on Ctrl+K, or Command+K where the page is shown on
 * a Mac (`primaryKey`: the page reads its own user agent; nothing here asks the OS), and from its button.
 */
import type { CodeApp } from "./app";
import { moveHighlight } from "./completions";
import { PALETTE_EMPTY, PALETTE_PLACEHOLDER, PALETTE_TITLE, paletteSlash } from "./copy";
import { byId, el } from "./dom";

export interface PaletteAction { id: string; label: string; detail?: string; run(): void }

/** The primary modifier as the page's platform names it: Command on a Mac, else Ctrl (for the hint and the key). */
export function primaryKey(userAgent: string): "Command" | "Ctrl" {
  return /Macintosh|Mac OS X/.test(userAgent) ? "Command" : "Ctrl";
}

/** The actions whose label matches every word of `query`, in order. */
export function filterActions(actions: readonly PaletteAction[], query: string): PaletteAction[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return actions.filter(a => words.every(w => a.label.toLocaleLowerCase().includes(w) || (a.detail ?? "").toLocaleLowerCase().includes(w)));
}

export interface Palette { open(): void; close(): void; isOpen(): boolean }

export function mountPalette(_app: CodeApp, actions: () => PaletteAction[]): Palette {
  const dialog = byId<HTMLDialogElement>("palette");
  const input = el("input", { type: "text", id: "palette-input", placeholder: PALETTE_PLACEHOLDER, autocomplete: "off", spellcheck: false,
    attrs: { role: "combobox", "aria-expanded": "true", "aria-controls": "palette-list", "aria-autocomplete": "list", "aria-label": PALETTE_TITLE } });
  const list = el("ul", { id: "palette-list", className: "pal-list", attrs: { role: "listbox", "aria-label": PALETTE_TITLE } });
  const empty = el("p", { className: "pal-empty", textContent: PALETTE_EMPTY, hidden: true });
  dialog.setAttribute("aria-label", PALETTE_TITLE);
  dialog.replaceChildren(el("div", { className: "pal" }, input, list, empty));
  let shown: PaletteAction[] = [];
  let at = 0;
  let back: HTMLElement | null = null;

  function draw(): void {
    shown = filterActions(actions(), input.value).slice(0, 80);
    at = Math.min(at, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.map((a, i) => {
      const li = el("li", { id: `pal-${i}`, className: `pal-item${i === at ? " on" : ""}`, attrs: { role: "option", "aria-selected": String(i === at) } },
        el("span", { className: "pal-label", textContent: a.label }), a.detail ? el("span", { className: "pal-detail", textContent: a.detail }) : null);
      li.addEventListener("mousedown", e => { e.preventDefault(); run(i); });
      return li;
    }));
    empty.hidden = shown.length > 0;
    if (shown.length) { input.setAttribute("aria-activedescendant", `pal-${at}`); list.children[at]?.scrollIntoView({ block: "nearest" }); }
    else input.removeAttribute("aria-activedescendant");
  }
  function run(i: number): void {
    const a = shown[i];
    if (!a) return;
    close(false);
    a.run();
  }
  function close(restore = true): void {
    if (!dialog.open) return;
    dialog.close();
    if (restore) back?.focus();
  }
  input.addEventListener("input", () => { at = 0; draw(); });
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); at = moveHighlight(at, e.key, shown.length); draw(); return; }
    if (e.key === "Enter") { e.preventDefault(); run(at); return; }
  });
  dialog.addEventListener("cancel", e => { e.preventDefault(); close(); });
  dialog.addEventListener("click", e => { if (e.target === dialog) close(); });

  return {
    open() {
      if (dialog.open) return;
      back = document.activeElement as HTMLElement | null;
      input.value = "";
      at = 0;
      draw();
      dialog.showModal();
      input.focus();
    },
    close,
    isOpen: () => dialog.open,
  };
}

/** A slash command as a palette action: it goes into the message box, for the person to send. */
export function slashAction(name: string, description: string, insert: (text: string) => void): PaletteAction {
  return { id: `slash:${name}`, label: paletteSlash(name), detail: description, run: () => insert(`/${name} `) };
}
