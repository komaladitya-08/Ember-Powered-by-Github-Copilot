/** Handle: Ember's face and status in the corner; click for Ember's menu. */

import { Rig, FACTORIES, frameSeconds, restingGap, type Character, type Emotion } from "@ember/characters";
import { AUTONOMOUS_TAG, RISKY_TAG, WHOLE_READ_HINT, announcement, onPress, plainStream, stepParts, wholeInView, wholeJudged, wholeNext, wholePage, wholeReadNews, wholeUnreported, type BubbleView, type WholeView } from "@ember/bubble";
import { waitsForWhole, wholeSeenAction, type BubbleState, type EmberState, type HandleApi, type WholeText } from "../../shared/overlay";
import { cardAutonomous, cardRisky, cardTask, cardText } from "./card";
import { cardClear, cardNeed, linesKept, waitsForRoom, type CardMeasure, type CardRow } from "./fit";
import { armMsFor } from "./arm";
import { cardBadge, targetBadge, whereText, type TargetBadge } from "./badge";
import { STATE_WORD, cardLines } from "../overlay/stack";
import type { Settings } from "../../main/settings";
import { micBadge } from "../../shared/mic";
import { presenceOf } from "../../shared/presence";
import { HandleLive } from "./live";
import { mayRest } from "./rest";
import { watchPixels } from "../shared/pixels";
import { handleLine, pillLine } from "./line";

declare global { interface Window { emberHandle: HandleApi } }

const api = window.emberHandle;
const characters: Record<string, Character> = Object.fromEntries(FACTORIES.map(f => { const c = f(); return [c.id, c]; }));
let character = characters.cinder;
const rig = new Rig();
let emotion: Emotion = "neutral";
const canvas = document.getElementById("face") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const $ = (id: string) => document.getElementById(id)!;
// Hairlines of one device pixel at any scale (the face's canvas is sized at the scale on every frame it draws).
watchPixels();

/** Ember is who speaks, whichever look it wears (Cinder, Wisp, Glassling, Glint are its looks). */
const name = "Ember";
// Calm mode follows the setting or the desktop's reduced-motion preference; the face dozes with Ember.
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
let reduceSetting = false;
const applyMotion = () => { rig.reducedMotion = reduceSetting || reduce.matches; };
reduce.addEventListener("change", applyMotion);
rig.sleepAfter = 180;
function applySettings(s: Settings): void {
  character = characters[s.character] ?? characters.cinder;
  $("name").textContent = name;
  reduceSetting = s.reduceMotion;
  document.documentElement.classList.toggle("calm", s.reduceMotion);
  applyMotion();
  resume();
}

let fallback = false;
api.onInit(i => {
  fallback = i.fallback;
  document.body.classList.toggle("fallback", i.fallback);
  applySettings(i.settings);
});
api.onSettings(applySettings);

/** Buttons are kept (not rebuilt) while they stay the same, so a click is never lost to a re-render. */
function buttons(host: HTMLElement, list: { id: string; label: string; primary?: boolean }[], label: (a: { label: string }) => string): void {
  const key = JSON.stringify(list.map(a => [a.id, a.label, a.primary === true]));
  if (host.dataset.key === key) return;
  host.dataset.key = key;
  // A new task card's buttons take no press for a moment (the pointer may rest where they just appeared).
  // Question buttons are armed by the Confirmer already, so a deliberate Allow is not dropped here.
  const armedAt = performance.now() + armMsFor(list);
  host.replaceChildren(...list.map(a => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = a.label;
    b.setAttribute("aria-label", label(a));
    if (a.primary) b.className = "primary";
    onPress(b, () => { if (performance.now() >= armedAt) api.bubbleAction(a.id); });
    return b;
  }));
}


const thoughtEl = $("thought");
// A risky question's tag beside Ember's name (shown by styles.css only while body[data-risky="true"], on the card).
$("risk").textContent = RISKY_TAG;
// Ember's own "Without asking" tag beside its name, as the bubble shows it (body[data-autonomous="true"], on the card).
$("auto").textContent = AUTONOMOUS_TAG;
let wasStreaming = false;
/**
 * Without a compositor nothing else speaks for Ember: finished answers, questions and problems are said once
 * in the card's live region, as the overlay's bubble does (with one, the bubble does it and the pill says nothing).
 */
let announced = "";
/** What it last said that from (only the news once a question's whole text has all been shown: wholeReadNews). */
let announcedView: BubbleView | null = null;
/** The status line and the microphone's news, each said once (live.ts): in the card, and the microphone's in the pill. */
const live = new HandleLive();
/**
 * Reads out what changed: the bubble's words, and the status line ("Using your mouse: move it to take over", "I only
 * caught the first part…"), which the card shows even under a bubble, and news about the microphone. All at once go
 * out together (one live update).
 */
function announce(b: BubbleState, status: string | null, micNews: string | null): void {
  const parts: string[] = [];
  // What was said while the card showed nothing new isn't repeated when it shows again.
  if (b.visible) {
    const view: BubbleView = { visible: true, mood: b.mood, title: b.title, thought: b.thought, streaming: b.streaming, where: b.where, step: b.step, ...(b.whole ? { whole: b.whole.text, wholeSeen: b.whole.seen } : {}), ...(b.risky ? { risky: true } : {}), ...(b.stalled ? { stalled: true } : {}) };
    const text = announcement(view, name);
    // The same question, its whole text now all shown: only that news, not the question and its text again.
    if (text && text !== announced) { parts.push(wholeReadNews(announcedView, view) ?? text); announced = text; announcedView = view; }
  }
  parts.push(...live.news(status, micNews));
  if (parts.length) $("live").textContent = parts.join(" ");
}
// ── A question's whole text (review #116): all of a long typed text under its sentence, as the bubble shows it, and
// its Allow waiting until all of it has been in view on the card (packages/bubble/src/whole.ts judges it) ──
const wholeEl = $("whole");
const wholeHintEl = $("whole-hint");
let whole: WholeView | null = null;
/** The whole text as main sends it (null: none): shown from its start; each approve-key press since, a page on. */
function showWhole(next: WholeText | null): void {
  const r = wholeNext(whole, next);
  whole = r.view;
  wholeEl.hidden = !whole;
  if (!whole) { wholeEl.textContent = ""; paintWhole(); return; }
  if (r.fresh) { wholeEl.textContent = whole.text; wholeEl.scrollTop = 0; }
  if (r.pages) wholeEl.scrollTop += r.pages * wholePage(wholeEl.clientHeight, parseFloat(getComputedStyle(wholeEl).lineHeight));
  paintWhole();
  // Seen here and main doesn't say so yet (just now, or a word that was lost): told (again).
  if (wholeUnreported(whole, next)) api.bubbleAction(wholeSeenAction(whole.n));
}
/**
 * The read hint, and Allow taking no press, while the whole text hasn't all been in view, or while the question's
 * sentence doesn't show beside it on the card (a layout read; accessibility-visual-1: Allow stayed live under
 * "Type “Dear team, the" at Larger text).
 */
function paintWhole(): void {
  const unread = !!whole && !whole.seen;
  wholeHintEl.hidden = !unread;
  wholeHintEl.textContent = unread ? WHOLE_READ_HINT : "";
  const cramped = fallback && document.body.classList.contains("asking") && !wordsClear();
  for (const el of $("actions").querySelectorAll<HTMLElement>("button")) {
    if ((unread && el.dataset.whole === "wait") || (cramped && el.dataset.room === "wait")) el.setAttribute("aria-disabled", "true");
    else el.removeAttribute("aria-disabled");
  }
}
/** A length in a computed style, in CSS px (0 for none or auto). */
const px = (v: string): number => parseFloat(v) || 0;
/** The words' rows shown now (the name, the bold line, the words, a whole text's block, its hint, the step). */
const wordRows = (): HTMLElement[] => [...$("handle").querySelector<HTMLElement>(".text")!.children]
  .filter((el): el is HTMLElement => el instanceof HTMLElement && getComputedStyle(el).display !== "none");
/**
 * The words have the room a whole text needs to count as seen (fit.ts): the question's sentence beside it, and nothing
 * running into the buttons. A card too small for that (its limits, the work area) never takes the block's end as read.
 */
function wordsClear(): boolean {
  const handleEl = $("handle");
  const end = handleEl.getBoundingClientRect().bottom - px(getComputedStyle(handleEl).paddingBottom);
  return cardClear({
    sentence: { clientHeight: thoughtEl.clientHeight, scrollHeight: thoughtEl.scrollHeight, lineHeight: px(getComputedStyle(thoughtEl).lineHeight) },
    wordsEnd: end, rowsEnd: wordRows().map(el => el.getBoundingClientRect().bottom),
  });
}
/** Measured (a layout read) while it waits to be read: main told the first time all of it is in view on the shown card. */
function judgeWhole(): void {
  if (!whole || whole.seen) return;
  const r = wholeEl.getBoundingClientRect();
  const shown = fallback && document.visibilityState === "visible" && wordsClear();
  const { view, report } = wholeJudged(whole, wholeInView(
    { scrollTop: wholeEl.scrollTop, scrollHeight: wholeEl.scrollHeight, clientHeight: wholeEl.clientHeight, top: r.top, bottom: r.bottom, viewportHeight: window.innerHeight },
    { shown, fontsLoaded: document.fonts.status === "loaded" },
  ));
  whole = view;
  if (!report) return;
  paintWhole();
  api.bubbleAction(wholeSeenAction(view.n));
}
wholeEl.addEventListener("scroll", judgeWhole, { passive: true });
// Fitted by main (or squeezed by a short work area): the question's sentence may show whole now, or no longer.
window.addEventListener("resize", () => { paintWhole(); judgeWhole(); });
document.fonts.addEventListener("loadingdone", judgeWhole);

/** The picker's target beside Ember's name (§8.1): nothing for this computer. The corner card gives its own (cardBadge). */
let badgeKey = "";
function renderTarget(s: EmberState, given?: TargetBadge | null): void {
  const badge = given !== undefined ? given : targetBadge(s.target);
  const key = badge ? `${badge.state}|${badge.text}` : "";
  if (key === badgeKey) return;
  badgeKey = key;
  const el = $("target");
  el.hidden = !badge;
  if (!badge) return;
  el.dataset.state = badge.state;
  el.title = badge.label;
  el.setAttribute("aria-label", badge.label);
  $("target-text").textContent = badge.text;
}

/**
 * The card's step row: the keys a question's hint names as keycaps beside their words, as the bubble draws them
 * (stepParts; accessibility-visual-r3: one grey run of text here), each chord kept on one line with its word (the card
 * is narrow), anything else as words. Drawn again only on a change.
 */
let stepShown: string | null = null;
function drawStep(step: string | null): void {
  const el = $("step");
  el.hidden = !step;
  if (step === stepShown) return;
  stepShown = step;
  const { lead, keys } = stepParts(step);
  if (!keys) { el.textContent = step ?? ""; return; }
  el.replaceChildren(...(lead ? [document.createTextNode(lead), document.createElement("br")] : []), ...keys.flatMap((k, i) => {
    const hint = Object.assign(document.createElement("span"), { className: "key-hint" });
    hint.append(...k.keys.map(key => Object.assign(document.createElement("kbd"), { textContent: key })), Object.assign(document.createElement("span"), { className: "key-word", textContent: k.word }));
    return [...(i ? [document.createTextNode(" · ")] : []), hint];
  }));
}

api.onState(s => {
  if (!fallback) renderTarget(s);
  if (s.emotion !== emotion) { emotion = s.emotion; rig.setEmotion(s.emotion); }
  rig.setTalking(s.talking);
  busy = s.talking || s.bubble.streaming;
  if (busy || s.bubble.visible) rig.wake();
  resume();
  const b = s.bubble;
  // The microphone: a shape and words for its state (never colour alone), whenever listening is on.
  const mic = $("mic");
  const micState = micBadge(s.mic, s.micLearning === true);
  mic.hidden = !micState;
  mic.dataset.state = s.mic ?? "off";
  mic.dataset.glyph = micState?.glyph ?? "";
  mic.title = micState?.label ?? "";
  mic.setAttribute("aria-label", micState?.label ?? "Microphone");
  const micNews = live.micNews(s.mic);
  // The presence ring round the face says Ember's state at a glance (still: the handle never animates it), dim at rest.
  const ring = presenceOf(s);
  if (document.body.dataset.presence !== ring) document.body.dataset.presence = ring;
  // The most urgent thing that is true now: a task that needs you, why Ember can't answer, the tasks under way, a
  // failure, the setup row that holds Ember back (by name), the microphone, else Ready (line.ts, review #5).
  const idle = handleLine(s);
  if (!fallback) {
    if (micNews) $("live").textContent = micNews;
    // The pill: one line. An answer's title is the character's name, already shown above: the line shows what it said.
    const line = pillLine(s, name, idle);
    $("line").textContent = line;
    // Hovering the pill shows the whole line (it is cut off with an ellipsis when long).
    $("handle").title = line;
    return;
  }
  announce(b, s.status ?? null, micNews);
  // The card: a short label or title in bold, the words under it, then the question's buttons and the running task.
  const task = cardTask(s.tasks, b.visible ? b : undefined);
  // Beside Ember's name: where the bubble's task acts (its question is about that computer), else the picker's choice.
  renderTarget(s, cardBadge({ where: b.visible ? b.where : undefined, task: b.visible && !!b.task }, s.target));
  const text = cardText(b, name, s.status ?? idle, task?.title);
  if ($("line").textContent !== text.line) $("line").textContent = text.line;
  const thought = b.streaming ? plainStream(text.thought) : text.thought;
  if (thoughtEl.textContent !== thought) thoughtEl.textContent = thought;
  showWhole(b.visible ? b.whole ?? null : null);
  keepLines();
  // While it streams, the newest lines show; once done, it reads (and scrolls) from the start.
  if (b.streaming) thoughtEl.scrollTop = thoughtEl.scrollHeight;
  else if (wasStreaming) thoughtEl.scrollTop = 0;
  // The fade at the top only when the start has really scrolled away.
  thoughtEl.dataset.overflow = String(b.streaming && thoughtEl.scrollHeight > thoughtEl.clientHeight + 1);
  wasStreaming = b.visible && b.streaming;
  document.body.dataset.mood = b.visible ? b.mood : "idle";
  // A risky question (policy's risky, as the bubble marks it): its tag, and an Allow that is bordered, not filled, so
  // nothing invites a reflex yes. Only how it looks: it is answered as any question.
  const risky = String(cardRisky(b));
  if (document.body.dataset.risky !== risky) document.body.dataset.risky = risky;
  const autonomous = String(cardAutonomous(b));
  if (document.body.dataset.autonomous !== autonomous) document.body.dataset.autonomous = autonomous;
  document.body.classList.toggle("streaming", b.visible && b.streaming);
  const actions = b.visible ? b.actions : [];
  // A question (not just "Read all" or "Open settings", which are Ember's own buttons).
  const asks = actions.some(a => !a.id.startsWith("ui:"));
  // Under a bubble the status line ("Using your mouse: move it to take over", "Waiting until you let go of the
  // mouse…", "I only caught the first part…") takes the step's place: without a compositor it has nowhere else to
  // show. A question keeps its keyboard hint there. A step the task row already shows isn't repeated.
  const step = b.visible && s.status && !asks ? s.status : b.visible && b.step !== task?.detail ? b.step : null;
  drawStep(step);

  document.body.classList.toggle("asking", actions.length > 0);
  $("actions").hidden = actions.length === 0;
  buttons($("actions"), actions, a => a.label);
  // Allow (never Not now) waits for the question's whole text to have all been in view; main refuses it before, too.
  [...$("actions").querySelectorAll<HTMLElement>("button")].forEach((el, i) => { el.dataset.whole = actions[i] && waitsForWhole(actions[i].id, b.whole) ? "wait" : ""; });
  // So does every answer but Not now while the question's sentence can't show beside it (fit.ts waitsForRoom).
  [...$("actions").querySelectorAll<HTMLElement>("button")].forEach((el, i) => { el.dataset.room = actions[i] && waitsForRoom(actions[i].id) ? "wait" : ""; });
  paintWhole();

  $("task").hidden = !task;
  if (task) {
    $("task").dataset.status = task.status;
    // The task row's state in words for screen readers (its symbol says it to the eye), from the cards' one table.
    $("task-state").textContent = STATE_WORD[task.status];
    const at = whereText(task.where);
    $("task-title").textContent = at ? `${task.title} (${at})` : task.title;
    // Under it, what it is doing now in Ember's words ("Clicking in Text Editor…"), else what it last said.
    const lines = cardLines(task);
    const doing = lines.live ?? lines.detail;
    $("task-detail").textContent = doing;
    $("task").title = `${task.title}${doing ? `: ${doing}` : ""}`;
  }
  buttons($("task-actions"), task?.actions ?? [], a => `${a.label}: ${task?.title ?? ""}`);
  requestAnimationFrame(fitCard);
  // Judged once laid out (and again when the card is fitted to it: resize).
  if (whole && !whole.seen) requestAnimationFrame(judgeWhole);
});

/**
 * Under a question with a whole text, the sentence keeps its first three lines (all, when it has fewer) and the block
 * its first three, however little room is left (styles.css --lines-kept): the block gives way first, from the lines it
 * shows unsqueezed (--lines-shown, up to its seven). Otherwise none.
 */
function keepLines(): void {
  const set = (el: HTMLElement, name: string, n: number) => { if (el.style.getPropertyValue(name) !== String(n)) el.style.setProperty(name, String(n)); };
  for (const el of [thoughtEl, wholeEl]) {
    const cs = getComputedStyle(el);
    const content = el.scrollHeight - px(cs.paddingTop) - px(cs.paddingBottom);
    set(el, "--lines-kept", whole ? linesKept(content, px(cs.lineHeight), 3) : 0);
    if (el === wholeEl) set(el, "--lines-shown", whole ? linesKept(content, px(cs.lineHeight), 7) : 7);
  }
}

/**
 * What the card needs to show all it holds, measured as if nothing were squeezed (fit.ts): each row of words at its own
 * height (the words and a whole text's block at all of theirs, the block up to its own most), then the question's
 * buttons and the task row with the gaps the stylesheet leaves under them (read, so the two can never drift apart).
 */
function cardMeasure(): CardMeasure {
  const handleEl = $("handle");
  const hs = getComputedStyle(handleEl);
  const ts = getComputedStyle(handleEl.querySelector<HTMLElement>(".text")!);
  const rows = wordRows().map((el): CardRow => {
    const cs = getComputedStyle(el);
    let natural = el.offsetHeight;
    if (el === thoughtEl) natural = el.scrollHeight;
    else if (el === wholeEl) {
      const most = parseFloat(cs.maxHeight);
      natural = Number.isFinite(most) ? Math.min(el.scrollHeight, most + px(cs.paddingTop) + px(cs.paddingBottom)) : el.scrollHeight;
    }
    return { natural, marginTop: px(cs.marginTop), marginBottom: px(cs.marginBottom) };
  });
  const below = ["actions", "task"].map(id => $(id)).filter(el => !el.hidden)
    .map((el): CardRow => ({ natural: el.offsetHeight, marginTop: 0, marginBottom: px(getComputedStyle(el).marginBottom) }));
  return {
    top: { padTop: px(hs.paddingTop), padBottom: px(hs.paddingBottom), min: px(hs.minHeight), face: $("menu").offsetHeight },
    text: { padTop: px(ts.paddingTop), gap: px(ts.rowGap), rows },
    below,
  };
}

/**
 * Asks the main process for a card as tall as what it shows (no empty gap under a short question,
 * room for a long one), when it offers that (`fit`); otherwise the card keeps the size main gives it.
 */
let askedHeight = 0;
function fitCard(): void {
  const fit = (api as HandleApi & { fit?: (height: number) => void }).fit;
  if (!fallback || typeof fit !== "function") return;
  const h = cardNeed(cardMeasure());
  if (Math.abs(h - askedHeight) < 4) return;
  askedHeight = h;
  fit(h);
}
$("handle").addEventListener("click", () => api.openMenu());

let pointer = { x: -1, y: -1 };
window.addEventListener("pointermove", e => { pointer = { x: e.clientX, y: e.clientY }; rig.wake(); resume(); });
window.addEventListener("resize", () => resume());

let last = performance.now();
/** Talking or streaming, or a lively face: full frame rate; a calm face ~30 fps; a still one ~15 (the page sleeps in between). */
let busy = false;
let resting = false;
/** The resting gap the last frame waited for (restingGap's, else 0): its time passes in full (frameSeconds). */
let planned = 0;
/** Something may have changed: draws again if the loop had stopped. */
function resume(): void {
  if (!resting) return;
  resting = false;
  last = performance.now();
  requestAnimationFrame(frame);
}
const next = () => {
  // Dozing and still: the last frame stays until the state, settings or the pointer change (as overlay/main.ts does). This
  // loop cost 3.4-6.3 % of a core at idle (docs/ASSISTANT.md), drawing a picture that didn't change.
  if (mayRest(rig.asleep, rig.settled, busy)) { resting = true; return; }
  const motion = rig.motion;
  // An awake Ready face with nothing passing: about 6 frames a second, waking for its next blink (rp-4).
  const gap = busy || motion === "brisk" ? 0 : motion === "gentle" ? 33 : restingGap(rig, 66);
  planned = gap > 66 ? gap : 0;
  if (gap) setTimeout(() => requestAnimationFrame(frame), gap); else requestAnimationFrame(frame);
};
function frame(now: number): void {
  const dt = frameSeconds(now - last, planned);
  last = now;
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth;
  if (canvas.width !== Math.round(size * dpr)) canvas.width = canvas.height = Math.round(size * dpr);
  if (pointer.x >= 0) {
    const r = canvas.getBoundingClientRect();
    rig.lookAt((pointer.x - r.left - size / 2) / 80, (pointer.y - r.top - size / 2) / 80);
  }
  const pose = rig.update(dt);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  ctx.translate(size / 2, size * 0.6);
  ctx.scale(size / 150, size / 150);
  character.draw(ctx, pose);
  next();
}
requestAnimationFrame(frame);
