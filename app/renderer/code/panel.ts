/**
 * The right-hand panel: tabs (Changes, Plan, Files, Terminal, Agents and tasks) with their empty states, resizable by
 * its edge (a separator the keyboard moves too) and collapsible. Each tab's contents are a module that registers
 * itself through `registerPanelTab`, so a later step adds one without touching this file:
 *
 *   registerPanelTab({ id: "changes", label: "Changes", mount(host, ctx) { …; return { show(sessionId) {}, render(s) {}, dispose() {} }; } });
 *
 * A tab is mounted the first time it is shown, told which session is shown (`show`, null for none), drawn with the
 * store's state on every change while it is up (`render`), and disposed of when it is replaced.
 */
import type { CodeApp, View } from "./app";
import { PANEL_HIDE, PANEL_LABEL, PANEL_NO_SESSION, PANEL_RESIZE, PANEL_SHOW, TAB_EMPTY, TAB_NAMES } from "./copy";
import { byId, el } from "./dom";
import { changesTab } from "./panel-changes";
import { planTab } from "./panel-plan";
import type { CodeState } from "./store";

/** What a tab's module gets: the app (its RPC calls go through `app.rpc`) and the state now. */
export interface PanelContext { app: CodeApp; state(): CodeState }

/** A mounted tab. */
export interface PanelInstance {
  /** The session shown now (null: none). */
  show(sessionId: string | null): void;
  /** The store changed while this tab is up. */
  render?(s: CodeState, prev: CodeState | null): void;
  dispose?(): void;
}

/** A tab of the panel. */
export interface PanelTab {
  id: string;
  label: string;
  /** Draw the tab into `host` (its tab panel, emptied first). */
  mount(host: HTMLElement, ctx: PanelContext): PanelInstance;
  /** Words for a mark on the tab itself, drawn whether or not the tab is up (null: no mark), such as "needs you". */
  mark?(s: CodeState): string | null;
  /**
   * A count after the tab's label, kept up to date whichever tab is up (null: none): `text` is shown, `label` is the
   * tab's whole name for screen readers ("Agents and tasks, 2 running").
   */
  badge?(s: CodeState, ctx: PanelContext): { text: string; label: string } | null;
}

const tabs = new Map<string, PanelTab>();
const listeners = new Set<() => void>();

/** Add or replace a tab (by id). The built-in tabs register empty states; a later module replaces one with its contents. */
export function registerPanelTab(tab: PanelTab): void {
  tabs.set(tab.id, tab);
  for (const fn of listeners) fn();
}
/** The tabs, in the order they were first registered. */
export function panelTabs(): PanelTab[] { return [...tabs.values()]; }

/** A tab with nothing in it yet: its empty state's words. */
export function emptyTab(id: string): PanelTab {
  return {
    id, label: TAB_NAMES[id] ?? id,
    mount(host) {
      const words = el("p", { className: "panel-empty" });
      host.replaceChildren(words);
      return { show(sessionId) { words.textContent = sessionId ? TAB_EMPTY[id] ?? "" : PANEL_NO_SESSION; } };
    },
  };
}
const BUILT: Readonly<Record<string, PanelTab>> = { changes: changesTab, plan: planTab };
for (const id of ["changes", "plan", "files", "terminal", "agents"]) registerPanelTab(BUILT[id] ?? emptyTab(id));

export interface Panel extends View { toggle(open?: boolean): void; select(id: string): void }

export function mountPanel(app: CodeApp): Panel {
  const aside = byId("panel");
  const list = byId("panel-tabs");
  const body = byId("panel-body");
  const edge = byId("panel-resize");
  const toggles = [...document.querySelectorAll<HTMLButtonElement>("[data-panel-toggle]")];
  aside.setAttribute("aria-label", PANEL_LABEL);
  edge.setAttribute("aria-label", PANEL_RESIZE);
  const mounted = new Map<string, { tab: PanelTab; host: HTMLElement; inst: PanelInstance }>();
  let shownSession: string | null | undefined;
  let drawnTabs = "";

  function drawTabs(): void {
    const all = panelTabs();
    const sig = all.map(t => `${t.id}:${t.label}`).join("|");
    if (sig === drawnTabs) return;
    drawnTabs = sig;
    list.replaceChildren(...all.map(t => {
      const b = el("button", { type: "button", id: `tab-${t.id}`, className: "tab", textContent: t.label, attrs: { role: "tab", "aria-controls": `tabpanel-${t.id}` }, data: { tab: t.id } });
      b.addEventListener("click", () => select(t.id));
      return b;
    }));
    // A tab replaced since it was mounted is mounted again from the new module.
    for (const [id, m] of mounted) if (tabs.get(id) !== m.tab) { m.inst.dispose?.(); m.host.remove(); mounted.delete(id); }
  }
  listeners.add(() => { drawTabs(); render(app.state, null); });

  /** Each tab's mark (a symbol, and its words after the tab's name in its accessible name), drawn when its words change. */
  function drawMarks(s: CodeState): void {
    for (const t of panelTabs()) {
      const b = document.getElementById(`tab-${t.id}`);
      const words = t.mark?.(s) ?? "";
      if (!b || (b.dataset.mark ?? "") === words) continue;
      if (words) { b.dataset.mark = words; b.setAttribute("aria-label", `${t.label}, ${words}`); } else { delete b.dataset.mark; b.removeAttribute("aria-label"); }
      b.replaceChildren(t.label, ...(words ? [el("span", { className: "tab-mark", attrs: { "aria-hidden": "true" }, data: { status: "waiting" } })] : []));
    }
  }

  list.addEventListener("keydown", e => {
    const ids = panelTabs().map(t => t.id);
    const i = ids.indexOf(app.state.ui.panelTab);
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % ids.length;
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + ids.length) % ids.length;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = ids.length - 1;
    if (next < 0) return;
    e.preventDefault();
    select(ids[next]);
    byId(`tab-${ids[next]}`).focus();
  });

  function select(id: string): void { app.setUi({ panelTab: id, panelOpen: true }); }
  function toggle(open?: boolean): void { app.setUi({ panelOpen: open ?? !app.state.ui.panelOpen }); }
  for (const t of toggles) t.addEventListener("click", () => toggle());

  // Resizing: drag the edge, or move it with the arrow keys (Home and End to its limits).
  const MIN = 260, MAX = 720;
  const clamp = (w: number) => Math.round(Math.min(MAX, Math.max(MIN, Math.min(w, window.innerWidth - 480))));
  edge.setAttribute("aria-valuemin", String(MIN));
  edge.setAttribute("aria-valuemax", String(MAX));
  edge.addEventListener("pointerdown", e => {
    e.preventDefault();
    edge.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => app.setUi({ panelWidth: clamp(window.innerWidth - m.clientX) });
    const up = () => { edge.removeEventListener("pointermove", move); edge.removeEventListener("pointerup", up); };
    edge.addEventListener("pointermove", move);
    edge.addEventListener("pointerup", up);
  });
  edge.addEventListener("keydown", e => {
    const w = app.state.ui.panelWidth;
    const step = e.shiftKey ? 64 : 16;
    const next = e.key === "ArrowLeft" ? w + step : e.key === "ArrowRight" ? w - step : e.key === "Home" ? MAX : e.key === "End" ? MIN : null;
    if (next === null) return;
    e.preventDefault();
    app.setUi({ panelWidth: clamp(next) });
  });

  function drawBadges(s: CodeState): void {
    for (const t of panelTabs()) {
      if (!t.badge) continue;
      const b = list.querySelector<HTMLElement>(`#tab-${t.id}`);
      if (!b) continue;
      const got = t.badge(s, { app, state: () => app.state });
      let mark = b.querySelector<HTMLElement>(".tab-badge");
      if (!got) { mark?.remove(); b.removeAttribute("aria-label"); continue; }
      if (!mark) b.append(mark = el("span", { className: "tab-badge", attrs: { "aria-hidden": "true" } }));
      if (mark.textContent !== got.text) mark.textContent = got.text;
      if (b.getAttribute("aria-label") !== got.label) b.setAttribute("aria-label", got.label);
    }
  }

  function render(s: CodeState, prev: CodeState | null): void {
    drawTabs();
    drawMarks(s);
    drawBadges(s);
    const session = s.view.kind === "session" ? s.view.id : null;
    if (prev && prev.ui === s.ui && prev.view === s.view && !mounted.get(s.ui.panelTab)?.inst.render) return;
    const open = s.ui.panelOpen;
    document.documentElement.style.setProperty("--panel-w", `${s.ui.panelWidth}px`);
    aside.hidden = !open;
    edge.hidden = !open;
    document.body.classList.toggle("panel-open", open);
    edge.setAttribute("aria-valuenow", String(s.ui.panelWidth));
    for (const t of toggles) {
      t.setAttribute("aria-expanded", String(open));
      // The panel's own close button is a symbol, named; the top bar's says its words.
      if (t.classList.contains("panel-close")) t.setAttribute("aria-label", PANEL_HIDE);
      else t.textContent = open ? PANEL_HIDE : PANEL_SHOW;
      t.title = open ? PANEL_HIDE : PANEL_SHOW;
    }
    const want = tabs.has(s.ui.panelTab) ? s.ui.panelTab : panelTabs()[0]?.id;
    for (const b of list.querySelectorAll<HTMLElement>(".tab")) {
      const on = b.dataset.tab === want;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (!open || !want) return;
    let m = mounted.get(want);
    if (!m) {
      const tab = tabs.get(want)!;
      const host = el("div", { id: `tabpanel-${want}`, className: "tabpanel", attrs: { role: "tabpanel", "aria-labelledby": `tab-${want}` }, tabIndex: 0 });
      body.append(host);
      m = { tab, host, inst: tab.mount(host, { app, state: () => app.state }) };
      mounted.set(want, m);
      shownSession = undefined;
    }
    for (const [id, x] of mounted) x.host.hidden = id !== want;
    if (shownSession !== session || !prev || prev.ui.panelTab !== s.ui.panelTab) { shownSession = session; m.inst.show(session); }
    m.inst.render?.(s, prev);
  }

  return { render, toggle, select };
}
