/** The "Ask Ember" box: type a request, Enter sends it, Esc closes. */
import type { EmberAskApi } from "../../shared/ipc";

declare global { interface Window { emberAsk: EmberAskApi } }

const input = document.getElementById("q") as HTMLInputElement;
document.getElementById("form")!.addEventListener("submit", e => {
  e.preventDefault();
  const text = input.value.trim();
  if (text) window.emberAsk.ask(text);
  input.value = "";
});
window.addEventListener("keydown", e => { if (e.key === "Escape") window.emberAsk.close(); });
window.addEventListener("focus", () => input.focus());
input.focus();
