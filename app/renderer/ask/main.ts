/** The "Ask Ember" box: type a request, Enter sends it, ↑/↓ go through earlier questions, Esc closes. */
import type { EmberAskApi } from "../../shared/ipc";

declare global { interface Window { emberAsk: EmberAskApi } }

const input = document.getElementById("q") as HTMLInputElement;
const sees = document.getElementById("sees")!;
let history: string[] = [];
/** Where we are in the history while browsing it (history.length = the new, unsent text). */
let at = 0;
let draft = "";

document.getElementById("form")!.addEventListener("submit", e => {
  e.preventDefault();
  const text = input.value.trim();
  if (text) window.emberAsk.ask(text);
  input.value = "";
});
input.addEventListener("keydown", e => {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  if (!history.length) return;
  e.preventDefault();
  if (at === history.length) draft = input.value;
  at = Math.min(history.length, Math.max(0, at + (e.key === "ArrowUp" ? -1 : 1)));
  input.value = at === history.length ? draft : history[at];
  input.setSelectionRange(input.value.length, input.value.length);
});
window.addEventListener("keydown", e => { if (e.key === "Escape") window.emberAsk.close(); });
window.addEventListener("focus", () => input.focus());
// Each time the box opens: where Ember will look (so nothing is sent by surprise) and the earlier questions.
window.emberAsk.onContext(c => {
  history = c.history;
  at = history.length;
  draft = "";
  // "↑ earlier questions" only when there are some.
  document.getElementById("hint-history")!.hidden = history.length === 0;
  sees.hidden = !c.sees;
  sees.textContent = c.sees ? `Ember will see: ${c.sees}` : "";
  input.focus();
});
input.focus();
