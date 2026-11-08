/**
 * The "Ask Ember" box: type a request, Enter sends it (Shift+Enter adds a line), ↑/↓ go through earlier questions, Esc
 * closes.
 */
import { listenOnceShown, type AskContext, type EmberAskApi, type ListenOnceStatus } from "../../shared/ipc";
import type { TargetSummary } from "../../shared/targets";
import { targetChipParts } from "../handle/badge";
import { AskHistory } from "./history";
import { ASK_OVER, WAIT_TIP, askCount, auxiliaryRows, boxRows, enterAction, fieldHeight, fieldLines, historyKey, overLimit, sendKey, textScaleOf } from "./field";
import { liveWords, seesView, unavailableLine, type SeesView } from "./chips";
import { watchPixels } from "../shared/pixels";
import { mountListenOnce } from "../shared/listen-once";

// Hairlines of one device pixel at any scale (ember.css --glass-hairline reads --dpx).
watchPixels();

declare global { interface Window { emberAsk: EmberAskApi } }

// No compositor (main says so in the address): an opaque panel, as a transparent window would paint black.
const query = new URLSearchParams(location.search);
document.documentElement.classList.toggle("opaque", query.has("opaque"));
// The send key as this OS names it (Return on a Mac).
document.getElementById("key-send")!.textContent = sendKey(query.get("os"));

const input = document.getElementById("q") as HTMLTextAreaElement;
const send = document.getElementById("send") as HTMLButtonElement;
const sees = document.getElementById("sees")!;
const where = document.getElementById("where")!;
const cut = document.getElementById("cut")!;
const tip = document.getElementById("tip")!;
const suggest = document.getElementById("suggest")!;
const seesLive = document.getElementById("sees-live")!;
const seesText = document.getElementById("sees-text")!;
const seesExtra = document.getElementById("sees-extra")!;
/** Why Ember can't answer now: the line's sentence, and its word alone for a crowded line (fitMeta); "" for none. */
let cantSay = { full: "", word: "" };
/** What the chip says now (fitMeta picks the long or the brief form of what else is sent). */
let view: SeesView | null = null;
/** Room the window's name keeps on the line before the rest gives way, at the default text size. */
const NAME_ROOM = 160;
/** The text's scale on this page now (main sets the text size, and sizes the window by the same scale: ask.ts). */
const scale = () => textScaleOf(getComputedStyle(document.documentElement).getPropertyValue("--text-scale"));
/**
 * The line under the field, while the window's name would be cut shorter than NAME_ROOM: the key hints step aside
 * (Esc first, then ↑, then Enter), then what else is sent says it in fewer words ("+ text, 2 titles"), then why Ember
 * can't answer says just its word ("Not connected"), then the other computer's name is shortened (never its state).
 * The tooltip and screen readers keep the whole sentence.
 */
function fitMeta(): void {
  const keys = [...document.querySelectorAll<HTMLElement>("#hint .key")];
  for (const k of keys) k.classList.remove("crowded");
  where.classList.remove("tight");
  seesExtra.textContent = view?.extra ?? "";
  const unavailable = document.getElementById("unavailable")!;
  unavailable.textContent = cantSay.full;
  unavailable.removeAttribute("aria-label");
  if (sees.hidden) return;
  const steps = [
    ...keys.reverse().filter(k => !k.hidden).map(k => () => k.classList.add("crowded")),
    () => { seesExtra.textContent = view?.brief ?? ""; },
    () => { if (cantSay.word) { unavailable.textContent = cantSay.word; unavailable.setAttribute("aria-label", cantSay.full); } },
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
  return whole.getBoundingClientRect().width > room + 0.01 && room < NAME_ROOM * scale();
}
/** What the live region last said in this opening (said once, when it arrives). */
let said = "";
const form = document.getElementById("form") as HTMLFormElement;
const field = input.parentElement!;
const listenRow = document.getElementById("listen-once-row")!;
let suggested: string[] = [];
/**
 * The window opens with one field row and two rows for the comfortable Listen once control, plus any wait tip.
 */
let shownRows = 3;
/** The request is over the most that is sent (said once as it goes over: companion-i1). */
let over = false;
/**
 * The field as tall as its text (one line to four, then it scrolls), the count on a line of its own near the most
 * that is sent (a longer paste kept whole, and not sent until it fits), the tip while it shows, and the window with
 * all; its lines at the text size now.
 */
function fit(): void {
  const s = scale();
  send.disabled = !input.value.trim() || overLimit(input.value.trim());
  syncSuggestions();
  field.style.flexBasis = `${fieldHeight(1, s)}px`;
  const lines = fieldLines(input.scrollHeight, s);
  field.style.flexBasis = `${fieldHeight(lines, s)}px`;
  input.classList.toggle("scrolls", input.scrollHeight > fieldHeight(lines, s) + 1);
  const count = askCount(input.value.length);
  const full = !!count;
  if (cut.textContent !== count) cut.textContent = count;
  cut.hidden = !full;
  const nowOver = overLimit(input.value.trim());
  if (nowOver) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
  if (nowOver && !over) seesLive.textContent = ASK_OVER;
  over = nowOver;
  // Layout heights: the opening animation's scale must not make the window too short for its final contents.
  const listenRows = auxiliaryRows(listenRow.offsetHeight, s);
  const suggestRows = auxiliaryRows(suggest.offsetHeight, s);
  const rows = boxRows(lines, full, !tip.hidden, suggestRows, listenRows);
  if (rows !== shownRows) { shownRows = rows; window.emberAsk.fit?.(rows); }
  form.classList.toggle("constrained", form.scrollHeight > form.clientHeight + 1);
  reportShape();
}
/** What main last heard of where the box shows something. */
let shapeSent = "";
/**
 * Where the box takes clicks (window-local CSS px, which are DIP): what it shows, each part a little wider for its edge,
 * so a click in its clear margins or beside a short row reaches the app beneath and closes the box (companion-4: main
 * gives the window that input shape on Linux). Layout boxes, not drawn ones: the opening's scale doesn't shrink it. A
 * box the work area cuts short scrolls, so all of it takes the wheel and clicks.
 */
function reportShape(): void {
  if (!window.emberAsk.shape) return;
  const PAD = 2, at = { x: form.offsetLeft, y: form.offsetTop - form.scrollTop };
  const parts = form.classList.contains("constrained")
    ? [{ x: form.offsetLeft, y: form.offsetTop, width: form.offsetWidth, height: form.offsetHeight }]
    : [...form.children].filter((el): el is HTMLElement => el instanceof HTMLElement && !el.classList.contains("sr") && el.offsetHeight > 0
      && getComputedStyle(el).visibility !== "hidden")
      .map(el => ({ x: at.x + el.offsetLeft - PAD, y: at.y + el.offsetTop - PAD, width: el.offsetWidth + 2 * PAD, height: el.offsetHeight + 2 * PAD }));
  const key = JSON.stringify(parts);
  if (key === shapeSent) return;
  shapeSent = key;
  window.emberAsk.shape(parts);
}
const listenButton = document.getElementById("listen-once") as HTMLButtonElement;
const listenDetail = document.getElementById("listen-once-detail")!;
const voiceSetup = document.getElementById("voice-setup") as HTMLButtonElement;
voiceSetup.addEventListener("click", () => window.emberAsk.voiceSettings?.());
const drawListenOnce = mountListenOnce(listenButton, listenDetail, on => window.emberAsk.listenOnce(on), "Say one request after you press Listen once.", fit);
/**
 * Listen once as main says it stands. A block nothing here can lift isn't a control that can't work (companion-3):
 * speech models not downloaded, the way to Settings' Download instead; voice off by the organisation, no row at all.
 */
function showListenOnce(s: ListenOnceStatus | undefined): void {
  const setup = s?.phase === "blocked" && s.fix === "settings";
  listenRow.hidden = !listenOnceShown(s);
  // The one button's capsule is as wide as it (companion-r2: a full-width strip with nothing after it).
  listenRow.classList.toggle("setup", setup);
  listenButton.hidden = listenDetail.hidden = setup;
  voiceSetup.hidden = !setup;
  drawListenOnce(s);
}
window.emberAsk.onListenOnce(showListenOnce);
/**
 * Ember's suggestions of what to ask next (each opening brings them, or none): chips that send their words as if typed.
 * They show only while the field is empty, so they never sit beside a request being written; put away, they keep their
 * room, so the box keeps its height and the field doesn't jump (companion-v1: main keeps the box's bottom by Ember, and
 * the first letter moved the field 48 px down).
 */
function showSuggestions(list: string[]): void {
  suggested = list.slice(0, 3);
  for (const b of [...suggest.querySelectorAll("button")]) b.remove();
  for (const text of suggested) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.addEventListener("click", () => { (window.emberAsk.askSuggestion ?? window.emberAsk.ask)(text); input.value = ""; fit(); });
    suggest.appendChild(b);
  }
  syncSuggestions();
}
function syncSuggestions(): void {
  suggest.hidden = !suggested.length;
  suggest.classList.toggle("away", input.value.trim() !== "");
}
/** Earlier questions (↑/↓), and what was being typed meanwhile. */
const history = new AskHistory();

form.addEventListener("submit", e => {
  e.preventDefault();
  const text = input.value.trim();
  // Longer than is sent: nothing goes, and the request stays to be shortened (companion-i1: it was cut unseen).
  if (overLimit(text)) { seesLive.textContent = ASK_OVER; return; }
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
  // An input method composing a word uses ↑ and ↓ for its candidates (companion-5).
  if (e.isComposing || !historyKey(input.value, input.selectionStart, input.selectionEnd, e.key)) return;
  const text = history.step(e.key === "ArrowUp" ? -1 : 1, input.value);
  if (text === null) return;
  e.preventDefault();
  input.value = text;
  input.setSelectionRange(input.value.length, input.value.length);
  fit();
});
input.addEventListener("input", fit);
// The text size changed (main sets it on the page, the box hidden meanwhile): the field is measured again at it.
new MutationObserver(fit).observe(document.documentElement, { attributes: true, attributeFilter: ["data-text-size"] });
// A small work area can narrow the window independently of the text size; measure every wrapped row again.
new ResizeObserver(() => { fitMeta(); fit(); }).observe(form);
// Esc while an input method composes a word cancels that word, not the box (companion-5).
window.addEventListener("keydown", e => { if (e.key === "Escape" && !e.isComposing) window.emberAsk.close(); });
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
  // Ember can't answer a request now (not connected, offline): said before one is typed, not after it is sent.
  showUnavailable(c.unavailable, false);
  // The window's app and title (shortened on the chip), what else goes with a request, all of it in the tooltip.
  view = seesView(c);
  sees.hidden = !view;
  sees.title = view?.full ?? "";
  sees.classList.toggle("private", c.privateWindow === true);
  document.getElementById("sees-full")!.textContent = view?.full ?? "";
  seesText.textContent = view?.text ?? "";
  // Nothing to show once the quick look is done (no readable window, the desktop): the line is just its keys at the
  // trailing edge, not a long empty strip (companion-7). Whole while it waits, so nothing jumps when a name comes.
  quiet = c.opened !== true && !view && !chip;
  document.querySelector(".meta")!.classList.toggle("bare", quiet && !unavailableLine(c.unavailable));
  // The field had the keyboard before this came, so its description isn't read again: a screen reader hears it here.
  const live = liveWords(said, c);
  if (live !== null) seesLive.textContent = said = live;
  fitMeta();
  // Main opens the window one line tall, a row taller when this opening says to wait for the box (review #78). Said
  // before the window is shown, so the tip is there from the first frame.
  if (c.opened) {
    input.focus();
    // It grows out of Ember as it shows: from 0.98 and transparent, released once it has been drawn so (a timer too, in
    // case the hidden window gets no frames: it must never stay transparent).
    form.classList.add("opening");
    const grown = () => form.classList.remove("opening");
    requestAnimationFrame(() => requestAnimationFrame(grown));
    setTimeout(grown, 250);
    tip.hidden = c.tip !== true;
    tip.textContent = tip.title = c.tip === true ? WAIT_TIP : "";
    shownRows = boxRows(1, false, c.tip === true, c.suggestions?.length ? 1 : 0, listenOnceShown(c.listenOnce) ? 2 : 0);
    showSuggestions(c.suggestions ?? []);
  }
  if (c.listenOnce) showListenOnce(c.listenOnce);
  else fit();
});
/**
 * The start of the line under the field while Ember can't answer a request (`word`: the handle's, or none). `live`: it
 * changed while the box is open (companion-6), so a line that comes or changes is said, as the field's description isn't
 * read again.
 */
function showUnavailable(word: string | undefined, live: boolean): void {
  const unavailable = document.getElementById("unavailable")!;
  const cant = unavailableLine(word);
  const news = live && !!cant && cant !== cantSay.full;
  cantSay = { full: cant ?? "", word: cant ? word!.replace(/…$/, "") : "" };
  unavailable.hidden = !cant;
  unavailable.textContent = cant ?? "";
  unavailable.title = cant ?? "";
  if (news) seesLive.textContent = cant;
  if (!live) return;
  document.querySelector(".meta")!.classList.toggle("bare", quiet && !cant);
  fitMeta();
  fit();
}
/** The quick look found nothing to show and no computer is named: the line is just its keys (and any line above). */
let quiet = false;
window.emberAsk.onUnavailable?.(w => showUnavailable(w ?? undefined, true));
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
