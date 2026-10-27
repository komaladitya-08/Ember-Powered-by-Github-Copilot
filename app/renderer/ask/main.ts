/** The "Ask Ember" box: type a request, Enter sends it, ↑/↓ go through earlier questions, Esc closes. */
import type { AskContext, EmberAskApi } from "../../shared/ipc";
import type { TargetSummary } from "../../shared/targets";
import { targetChip } from "../handle/badge";
import { AskHistory } from "./history";

declare global { interface Window { emberAsk: EmberAskApi } }

// No compositor (main says so in the address): an opaque panel, as a transparent window would paint black.
document.documentElement.classList.toggle("opaque", new URLSearchParams(location.search).has("opaque"));

const input = document.getElementById("q") as HTMLInputElement;
const sees = document.getElementById("sees")!;
const where = document.getElementById("where")!;
/** Earlier questions (↑/↓), and what was being typed meanwhile. */
const history = new AskHistory();

document.getElementById("form")!.addEventListener("submit", e => {
  e.preventDefault();
  const text = input.value.trim();
  if (text) window.emberAsk.ask(text);
  input.value = "";
});
input.addEventListener("keydown", e => {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  const text = history.step(e.key === "ArrowUp" ? -1 : 1, input.value);
  if (text === null) return;
  e.preventDefault();
  input.value = text;
  input.setSelectionRange(input.value.length, input.value.length);
});
window.addEventListener("keydown", e => { if (e.key === "Escape") window.emberAsk.close(); });
window.addEventListener("focus", () => input.focus());
// Each time the box opens: where Ember will look (so nothing is sent by surprise) and the earlier questions. The
// update once the quick look is done (not `opened`) keeps the user's place in the history and what they were typing.
window.emberAsk.onContext(c => {
  history.context(c.history, c.opened === true);
  // "↑ earlier questions" only when there are some.
  document.getElementById("hint-history")!.hidden = history.size === 0;
  // Where a request goes when it names no computer (§8.1): "On build-01" when that isn't this computer. Main sends the
  // picker's target with the context when the targets runtime has one; without it nothing shows, as before.
  const chip = targetChip((c as AskContext & { target?: TargetSummary | null }).target);
  where.hidden = !chip;
  where.textContent = chip ?? "";
  sees.hidden = !c.sees;
  sees.textContent = c.sees ? `Ember will see: ${c.sees}` : "";
  input.focus();
  // Opened again: what was left in it (after Esc, or a click away) is selected, so typing replaces it instead of
  // running on from it ("draftwhat can you do"); End or a click keeps it.
  if (c.opened) input.select();
});
// Typed while the box was opening: it goes where the caret is, as if typed here.
window.emberAsk.onTyped(t => {
  if (t.cancel) { window.emberAsk.close(); return; }
  if (t.text) {
    const at = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? at;
    input.setRangeText(t.text, at, end, "end");
  }
  input.focus();
  if (t.submit) (document.getElementById("form") as HTMLFormElement).requestSubmit();
});
input.focus();
