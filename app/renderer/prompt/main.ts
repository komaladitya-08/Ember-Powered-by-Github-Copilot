/**
 * The prompt window's page ("Ember", §8.6): one card at a time (a host key, a password or passphrase, a code, a
 * security key touch, any other prompt, a consent card), keyboard reachable, Esc cancels. Everything shown is built
 * as text nodes from the card's fields (values from outside Ember with every character made visible); a secret goes
 * to main once, and the field is cleared the moment it is sent. A consent card's yes carries the hash of the very text
 * this page showed (computed here), so main can tell it was that text, and it can be pressed only once every word of
 * it has been in view (review #182, #270): words that run on below fade at their foot and say to scroll.
 */

import type { PromptCard } from "../../shared/remote-ui";
import { CONSENT_READ_HINT, PROMPT_ARM_MS, consentHashText, isConsent, moreBelow, pressResult, promptView, readThrough, type Block, type ButtonView, type Part } from "./copy";
import type { PromptApi } from "./api";
import { LEGEND_MIXED, LEGEND_TOKENS } from "../command/copy";
import { breaksLine, legendFor, segmentLabel, visibleText } from "../command/visible";

declare global { interface Window { emberPrompt: PromptApi } }

const api = window.emberPrompt;
const $ = (id: string) => document.getElementById(id)!;
const field = $("field") as HTMLInputElement;
const words = $("body");
const hint = $("hint");
let card: PromptCard | null = null;
let shownAt = 0;
let buttons: { view: ButtonView; el: HTMLButtonElement }[] = [];
let armTimer: ReturnType<typeof setTimeout> | null = null;
let sent = false;
/** Every word of the card on screen has been in view since it came up. */
let seen = false;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Text from outside Ember, every character visible (as the command card shows commands). */
function visible(s: string, legend: Set<string>): Node[] {
  const segs = visibleText(s);
  const l = legendFor(segs);
  if (l.tokens) legend.add(LEGEND_TOKENS);
  if (l.mixed) legend.add(LEGEND_MIXED);
  const out: Node[] = [];
  for (const seg of segs) {
    if (seg.kind === "plain") { out.push(document.createTextNode(seg.text)); continue; }
    out.push(el("span", `vt vt-${seg.kind}`, segmentLabel(seg)));
    if (breaksLine(seg)) out.push(document.createTextNode("\n"));
  }
  return out;
}

function partNodes(parts: readonly Part[], legend: Set<string>): Node[] {
  return parts.flatMap(x => (typeof x === "string" ? [document.createTextNode(x)] : "v" in x ? visible(x.v, legend) : [el("code", "", x.code)]));
}

function blockNode(b: Block, legend: Set<string>): HTMLElement {
  if (b.kind === "mono") return el("p", "mono", b.text);
  if (b.kind === "quote") {
    const q = el("blockquote", "quote");
    q.append(...visible(b.text, legend));
    return q;
  }
  const p = el("p");
  p.append(...partNodes(b.parts, legend));
  return p;
}

/** The hex sha256 of a consent card's text as this page shows it, or null where the page can't hash. */
async function hashShown(c: { title: string; body: string[] }): Promise<string | null> {
  try {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(consentHashText(c)));
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
  } catch { return null; } // no WebCrypto here: the card's own hash goes back, as the contract has it
}

async function press(b: ButtonView): Promise<void> {
  if (!card || sent) return;
  const r = pressResult(card, b, field, Date.now(), shownAt, seen);
  if (r.kind === "wait") { if (r.focusField) field.focus(); return; }
  sent = true;
  if (r.kind === "cancel") api.cancel(r.id);
  else if (r.kind === "answer") api.answer(r.answer);
  else api.answer({ id: r.id, ok: true, sha256: (await hashShown(r)) ?? r.sha256 });
}

function paintArmed(): void {
  const armed = Date.now() >= shownAt + PROMPT_ARM_MS;
  // A consent card's yes also waits until all its words have been in view.
  const unread = !!card && isConsent(card) && !seen;
  for (const b of buttons) if (b.view.armed) b.el.disabled = sent || !armed || unread;
  if (!armed && !armTimer) armTimer = setTimeout(() => { armTimer = null; paintArmed(); }, shownAt + PROMPT_ARM_MS - Date.now() + 5);
}

/** The words measured: read through yet (sticky), more below (the fade), and the hint under a consent card's yes. */
function judge(): void {
  if (!card) return;
  const m = { scrollTop: words.scrollTop, scrollHeight: words.scrollHeight, clientHeight: words.clientHeight };
  if (readThrough(m)) seen = true;
  words.classList.toggle("more", moreBelow(m));
  // Words that scroll can be scrolled from the keyboard too (Tab to them, then the arrow keys or Page Down).
  if (m.scrollHeight > m.clientHeight + 1) words.tabIndex = 0;
  else words.removeAttribute("tabindex");
  const h = isConsent(card) && !seen ? CONSENT_READ_HINT : "";
  if (hint.textContent !== h) hint.textContent = h;
  hint.hidden = !h;
  paintArmed();
}
// Measured again when the words scroll, when the window is fitted to the card, and when their lines rewrap.
words.addEventListener("scroll", judge, { passive: true });
window.addEventListener("resize", judge);
const rewrap = typeof ResizeObserver === "function" ? new ResizeObserver(() => judge()) : null;

function show(next: PromptCard | null): void {
  // The same card again (pulled after it was pushed): leave what the user is doing alone.
  if (next && card && next.id === card.id) return;
  card = next;
  sent = false;
  seen = false;
  field.value = "";
  if (armTimer) clearTimeout(armTimer);
  armTimer = null;
  rewrap?.disconnect();
  $("card").hidden = !next;
  if (!next) { buttons = []; return; }
  shownAt = Date.now();
  const view = promptView(next);
  const legend = new Set<string>();
  $("title").replaceChildren(...partNodes(view.title, legend));
  // The window keeps its title "Ember" (§8.6): Ember's own windows are known by it where their process can't be told,
  // and a host name or an SSH prompt never goes into a window title other programs read. The dialog is named by its h1.
  words.replaceChildren(...view.body.map(b => blockNode(b, legend)));
  words.scrollTop = 0;
  $("legend").replaceChildren(...[...legend].map(l => el("p", "", l)));
  $("legend").hidden = legend.size === 0;
  $("form").hidden = !view.field;
  if (view.field) {
    $("field-label").textContent = view.field.label;
    field.type = view.field.masked ? "password" : "text";
  }
  buttons = view.buttons.map(v => {
    const b = el("button", v.primary ? "btn" : "btn quiet", v.label);
    b.type = "button";
    b.addEventListener("click", e => { if (e.isTrusted) void press(v); });
    return { view: v, el: b };
  });
  // The affirmative button last (on the right), in reading and Tab order alike.
  $("buttons").replaceChildren(...[...buttons].reverse().map(b => b.el));
  judge();
  for (const e of [words, ...words.children]) rewrap?.observe(e);
  // Where the keyboard starts: the field, else the button Enter presses, else the card's words (a consent card).
  const def = buttons.find(b => b.view.isDefault);
  if (view.field) field.focus();
  else if (def) def.el.focus();
  else ($("title") as HTMLElement).focus();
}

$("form").addEventListener("submit", e => {
  e.preventDefault();
  const def = buttons.find(b => b.view.isDefault);
  if (def) void press(def.view);
});
window.addEventListener("keydown", e => {
  if (!card) return;
  if (e.key === "Escape") {
    e.preventDefault();
    const c = buttons.find(b => b.view.id === "cancel");
    if (c) void press(c.view);
  }
});

api.onShow(show);
void api.pull().then(c => { if (c) show(c); });
