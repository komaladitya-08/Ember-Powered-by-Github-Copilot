/**
 * Customise › Companion (docs/CODING-APP.md §5): whether the companion is on, and a way to its switch, which lives in
 * one place only, Ember's settings (Home's "Companion and coding"). This window shows the state main gives it and
 * opens settings at that row; it never changes the setting itself.
 */
import { COMPANION_OPEN, COMPANION_SECTION, companionState } from "./copy-customise";
import { registerCustomiseSection, sectionId } from "./customise";
import { el } from "./dom";

registerCustomiseSection({
  id: sectionId(COMPANION_SECTION), label: COMPANION_SECTION,
  mount(host, ctx) {
    const api = ctx.app.api;
    const line = el("p", { className: "cz-line", textContent: companionState(null) });
    const open = el("button", { type: "button", className: "btn quiet", textContent: COMPANION_OPEN });
    open.hidden = !api.openCompanionSettings;
    open.addEventListener("click", () => api.openCompanionSettings?.());
    host.replaceChildren(line, open);
    const read = () => {
      void (api.companionState?.() ?? Promise.resolve(null)).then(s => { line.textContent = companionState(s ? s.on : null); }, () => { line.textContent = companionState(null); });
    };
    read();
    return { show() { read(); } };
  },
});
