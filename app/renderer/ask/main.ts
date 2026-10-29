/**
 * The "Ask Ember" box: type a request, Enter sends it (Shift+Enter adds a line), ↑/↓ go through earlier questions, Esc
 * closes.
 */
import type { AskContext, EmberAskApi } from "../../shared/ipc";
import type { TargetSummary } from "../../shared/targets";
import { targetChipParts } from "../handle/badge";
import { AskHistory } from "./history";
import { CUT_NOTE, FIELD, atLimit, enterAction, fieldHeight, fieldLines, historyKey, sendKey } from "./field";
import { liveWords, seesView, type SeesView } from "./chips";

declare global { interface Window { emberAsk: EmberAskApi } }

// No compositor (main says so in the address): an opaque panel, as a transparent window would paint black.
const query = new URLSearchParams(location.search);
document.documentElement.classList.toggle("opaque", query.has("opaque"));
// The send key as this OS names it (Return on a Mac).
document.getElementById("key-send")!.textContent = sendKey(query.get("os"));

const input = document.getElementById("q") as HTMLTextAreaElement;
const sees = document.getElementById("sees")!;
const where = document.getElementById("where")!;
const cut = document.getElementById("cut")!;
const seesLive = document.getElementById("sees-live")!;
const seesText = document.getElementById("sees-text")!;
const seesExtra = document.getElementById("sees-extra")!;
/** What the chip says now (fitMeta picks the long or the brief form of what else is sent). */
let view: SeesView | null = null;
/** Room the window's name keeps on the line before the rest gives way. */
const NAME_ROOM = 160;
/**
 * The line under the field, while the window's name would be cut shorter than NAME_ROOM: the key hints step aside
 * (Esc first, then ↑, then Enter), then what else is sent says it in fewer words ("+ text, 2 titles"), then the other
 * computer's name is shortened (never its state). The tooltip and screen readers keep the whole sentence.
 */
function fitMeta(): void {
  const keys = [...document.querySelectorAll<HTMLElement>("#hint .key")];
  for (const k of keys) k.classList.remove("crowded");
  where.classList.remove("tight");
  seesExtra.textContent = view?.extra ?? "";
  if (sees.hidden) return;
  const steps = [
    ...keys.reverse().filter(k => !k.hidden).map(k => () => k.classList.add("crowded")),
    () => { seesExtra.textContent = view?.brief ?? ""; },
    () => where.classList.add("tight"),
  ];
  for (const step of steps) {
    if (!cutShort()) break;
    step();
  }
}
/** The window's name is shortened below NAME_ROOM (measured to the fraction of a pixel: an ellipsis can hide in one). */
function cutShort(): boolean {
  const whole = document.createRange();
  whole.selectNodeContents(seesText);
  const room = seesText.getBoundingClientRect().width;
  return whole.getBoundingClientRect().width > room + 0.01 && room < NAME_ROOM;
}
/** What the live region last said in this opening (said once, when it arrives). */
let said = "";
const form = document.getElementById("form") as HTMLFormElement;
const field = input.parentElement!;
/** The rows the window was last sized for: the field's lines, and one for the note (main opens it at one). */
let shownRows = 1;
/**
 * The field as tall as its text (one line to four, then it scrolls), the note on a line of its own when the text
 * reached the most that is sent (a longer paste was cut at the limit), and the window with both.
 */
function fit(): void {
  field.style.flexBasis = `${FIELD.oneLine}px`;
  const lines = fieldLines(input.scrollHeight);
  field.style.flexBasis = `${fieldHeight(lines)}px`;
  input.classList.toggle("scrolls", input.scrollHeight > fieldHeight(lines) + 1);
  const full = atLimit(input.value);
  if (cut.hidden === full) { cut.hidden = !full; cut.textContent = full ? CUT_NOTE : ""; }
  const rows = lines + (full ? 1 : 0);
  if (rows !== shownRows) { shownRows = rows; window.emberAsk.fit?.(rows); }
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
// The box went away: what was left in it (after Esc, or a click away) is selected, so typing replaces it when it opens
// again instead of running on from it ("draftwhat can you do"); End or a click keeps it. Done now, while nothing can be
// typed: done as the box opened, it selected the letters already typed, and the next one replaced them (review #78).
window.emberAsk.onHidden(() => input.select());
// Each time the box opens (sent before its window is shown): where Ember will look (so nothing is sent by surprise) and
// the earlier questions. The update once the quick look is done (not `opened`) keeps the user's place in the history
// and what they were typing.
window.emberAsk.onContext(c => {
  history.context(c.history, c.opened === true);
  // "↑ earlier questions" only when there are some.
  document.getElementById("hint-history")!.hidden = history.size === 0;
  // Where a request goes when it names no computer (§8.1): "On build-01" when that isn't this computer. Main sends the
  // picker's target with the context when the targets runtime has one; without it nothing shows, as before.
  const chip = targetChipParts((c as AskContext & { target?: TargetSummary | null }).target);
  where.hidden = !chip;
  document.getElementById("where-name")!.textContent = chip?.name ?? "";
  document.getElementById("where-state")!.textContent = chip?.state ?? "";
  where.title = chip ? chip.name + chip.state : "";
  // The window's app and title (shortened on the chip), what else goes with a request, all of it in the tooltip.
  view = seesView(c);
  sees.hidden = !view;
  sees.title = view?.full ?? "";
  sees.classList.toggle("private", c.privateWindow === true);
  document.getElementById("sees-full")!.textContent = view?.full ?? "";
  seesText.textContent = view?.text ?? "";
  // The field had the keyboard before this came, so its description isn't read again: a screen reader hears it here.
  const live = liveWords(said, c);
  if (live !== null) seesLive.textContent = said = live;
  fitMeta();
  input.focus();
  // Main opens the window one line tall.
  if (c.opened) shownRows = 1;
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
