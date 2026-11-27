/**
 * Customise: a settings surface with its sections (Models, MCP servers, Skills, Plugins, Agents, Instructions, Hooks,
 * Permissions, Sandbox, Schedules, Usage), each an empty state until a later step registers its contents with
 * `registerCustomiseSection` (the same shape as a panel tab: panel.ts).
 */
import type { CodeApp, View } from "./app";
import { CUSTOMISE_DONE, CUSTOMISE_SECTIONS, CUSTOMISE_TITLE, customiseEmpty } from "./copy";
import { byId, el } from "./dom";
import type { PanelContext, PanelInstance } from "./panel";
import type { CodeState, MainView } from "./store";

export interface CustomiseSection { id: string; label: string; mount(host: HTMLElement, ctx: PanelContext): PanelInstance }

const sections = new Map<string, CustomiseSection>();
export function registerCustomiseSection(s: CustomiseSection): void { sections.set(s.id, s); }
/** A section's id from its label ("MCP servers" is "mcp-servers"). */
export const sectionId = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
for (const label of CUSTOMISE_SECTIONS) {
  registerCustomiseSection({
    id: sectionId(label), label,
    mount(host) { host.replaceChildren(el("p", { className: "panel-empty", textContent: customiseEmpty(label) })); return { show() { /* nothing to show yet */ } }; },
  });
}

export interface Customise extends View { focus(): void }

export function mountCustomise(app: CodeApp, back: () => MainView): Customise {
  const root = byId("customise-view");
  const title = el("h1", { id: "customise-title", textContent: CUSTOMISE_TITLE, tabIndex: -1 });
  const done = el("button", { type: "button", className: "btn quiet small", textContent: CUSTOMISE_DONE });
  done.addEventListener("click", () => app.showView(back()));
  const nav = el("nav", { className: "c-nav", attrs: { "aria-label": CUSTOMISE_TITLE } });
  const heading = el("h2", { className: "c-h", id: "customise-h" });
  const host = el("div", { className: "c-body" });
  root.replaceChildren(el("div", { className: "c-head" }, title, done), el("div", { className: "c-grid" }, nav, el("section", { className: "c-pane", attrs: { "aria-labelledby": "customise-h" } }, heading, host)));
  let drawn = "";
  let inst: PanelInstance | null = null;

  nav.addEventListener("keydown", e => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const links = [...nav.querySelectorAll<HTMLElement>("button")];
    const i = links.indexOf(document.activeElement as HTMLElement);
    const next = links[i + (e.key === "ArrowDown" ? 1 : -1)];
    if (next) { e.preventDefault(); next.focus(); }
  });

  function render(s: CodeState): void {
    if (s.view.kind !== "customise") return;
    const id = sections.has(s.view.section) ? s.view.section : sectionId(CUSTOMISE_SECTIONS[0]);
    if (nav.childElementCount !== sections.size) {
      nav.replaceChildren(...[...sections.values()].map(sec => {
        const b = el("button", { type: "button", className: "c-link", textContent: sec.label, data: { section: sec.id } });
        b.addEventListener("click", () => app.showView({ kind: "customise", section: sec.id }));
        return b;
      }));
    }
    for (const b of nav.querySelectorAll<HTMLElement>(".c-link")) { if (b.dataset.section === id) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current"); }
    if (drawn === id) return;
    drawn = id;
    inst?.dispose?.();
    const sec = sections.get(id)!;
    heading.textContent = sec.label;
    host.replaceChildren();
    inst = sec.mount(host, { app, state: () => app.state });
    inst.show(null);
  }

  return { render, focus() { title.focus(); } };
}
