/**
 * The "Ask Ember" box: type a request, Enter sends it (Shift+Enter adds a line), ↑/↓ go through earlier questions, Esc
 * closes.
 */
import type { AskContext, EmberAskApi } from "../../shared/ipc";
import type { TargetSummary } from "../../shared/targets";
import { targetChip } from "../handle/badge";
import { AskHistory } from "./history";
import { CUT_NOTE, FIELD, atLimit, enterAction, fieldHeight, fieldLines, historyKey } from "./field";
import { seesView } from "./chips";

declare global { interface Window { emberAsk: EmberAskApi } }

// No compositor (main says so in the address): an opaque panel, as a transparent window would paint black.
document.documentElement.classList.toggle("opaque", new URLSearchParams(location.search).has("opaque"));

const input = document.getElementById("q") as HTMLTextAreaElement;
const sees = document.getElementById("sees")!;
const where = document.getElementById("where")!;
const cut = document.getElementById("cut")!;
const seesLive = document.getElementById("sees-live")!;
const seesText = document.getElementById("sees-text")!;
/** Room the window's name keeps on the line before the key hints step aside (Esc first, then ↑, then Enter). */
const NAME_ROOM = 160;
/** The line under the field: the key hints give way, last first, while the window's name would be cut too short. */
function fitMeta(): void {
  const keys = [...document.querySelectorAll<HTMLElement>("#hint .key")];
  for (const k of keys) k.classList.remove("crowded");
  if (sees.hidden) return;
  for (const k of keys.reverse()) {
    if (seesText.scrollWidth <= seesText.clientWidth || seesText.clientWidth >= NAME_ROOM) break;
    if (!k.hidden) k.classList.add("crowded");
  }
}
/** What the live region last said in this opening (said once, when it arrives). */
let said = "";
const form = document.getElementById("form") as HTMLFormElement;
const field = input.parentElement!;
/** The lines the window was last sized for (main opens it at one). */
let shownLines = 1;
/**
 * The field as tall as its text (one line to four, then it scrolls), the window with it, and the note when the text
 * reached the most that is sent (a longer paste was cut at the limit).
 */
function fit(): void {
  field.style.flexBasis = `${FIELD.oneLine}px`;
  const lines = fieldLines(input.scrollHeight);
  field.style.flexBasis = `${fieldHeight(lines)}px`;
  input.classList.toggle("scrolls", input.scrollHeight > fieldHeight(lines) + 1);
  if (lines !== shownLines) { shownLines = lines; window.emberAsk.fit?.(lines); }
  const full = atLimit(input.value);
  if (cut.hidden === full) { cut.hidden = !full; cut.textContent = full ? CUT_NOTE : ""; }
}
/** Earlier questions (↑/↓), and what was being typed meanwhile. */
const history = new AskHistory();

form.addEventListener("submit", e => {
  e.preventDefault();
  const text = input.value.trim();
  if (text) window.emberAsk.ask(text);
  input.value = "";
  fit();
});
input.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    if (enterAction(e) === "send") { e.preventDefault(); form.requestSubmit(); }
    return;
  }
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  if (!historyKey(input.value, input.selectionStart, input.selectionEnd, e.key)) return;
  const text = history.step(e.key === "ArrowUp" ? -1 : 1, input.value);
  if (text === null) return;
  e.preventDefault();
  input.value = text;
  input.setSelectionRange(input.value.length, input.value.length);
  fit();
});
input.addEventListener("input", fit);
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
  where.title = chip ?? "";
  // The window's app and title (shortened on the chip), what else goes with a request, all of it in the tooltip.
  const view = seesView(c);
  sees.hidden = !view;
  sees.title = view?.full ?? "";
  sees.classList.toggle("private", c.privateWindow === true);
  document.getElementById("sees-full")!.textContent = view?.full ?? "";
  seesText.textContent = view?.text ?? "";
  document.getElementById("sees-extra")!.textContent = view?.extra ?? "";
  // The field had the keyboard before this came, so its description isn't read again: a screen reader hears it here.
  if (c.opened) { said = ""; seesLive.textContent = ""; }
  else if (view && view.full !== said) { said = view.full; seesLive.textContent = view.full; }
  fitMeta();
  input.focus();
  // Opened again: what was left in it (after Esc, or a click away) is selected, so typing replaces it instead of
  // running on from it ("draftwhat can you do"); End or a click keeps it. Main opened the window one line tall.
  if (c.opened) { input.select(); shownLines = 1; }
  fit();
});
// Typed while the box was opening: it goes where the caret is, as if typed here.
window.emberAsk.onTyped(t => {
  if (t.cancel) { window.emberAsk.close(); return; }
  if (t.text) {
    const at = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? at;
    input.setRangeText(t.text, at, end, "end");
    fit();
  }
  input.focus();
  if (t.submit) form.requestSubmit();
});
input.focus();
