/**
 * Overlay renderer: draws Ember (any of the four characters) where the main
 * process says it is, plus its reasoning bubble, status pill and task cards.
 * Ember is drawn on a small canvas that moves with it (a full-screen canvas
 * would ship a screen-sized bitmap to the compositor every frame), and only as
 * often as it needs to be: every frame while Ember moves or changes expression,
 * ~30 fps while it talks or its hands are busy, ~15 fps while it rests, ~8 fps
 * while it dozes, and not at all while it is hidden or on another display.
 */

import { Rig, FACTORIES, PRESETS, type Character, type Emotion, type Gesture, type Pose } from "@ember/characters";
import { ReasoningBubble, onPress, plainStream } from "@ember/bubble";
import { TASK_STOPPING, type OverlayApi, type OverlayFrame, type OverlayInit, type EmberState, type Rect, type TaskCard } from "../../shared/overlay";
import type { Settings } from "../../main/settings";
import { STATE_WORD, STOP_ACK_MS, foldCount, foldedLine, stackOrder, stopPending, underWay } from "./stack";
import { TASK_ARM_MS } from "../handle/arm";
import { whereText } from "../handle/badge";
import { cardsCorner } from "./layout";

declare global { interface Window { emberOverlay: OverlayApi } }

/** Frame gaps (plus the wait for the next display frame) while nothing moves quickly. */
const LIVELY_MS = 22;
const RESTING_MS = 55;
const DOZING_MS = 110;
/** Fall asleep after this long with nothing happening (no cursor movement, no state change). */
const SLEEP_AFTER_S = 180;
/** Gestures whose hands keep moving: drawn at the lively rate. */
const BRISK: ReadonlySet<Gesture> = new Set(["type", "tap", "scratch", "cheeks", "clap", "wave"]);

const api = window.emberOverlay;
const canvas = document.getElementById("stage") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const bubble = new ReasoningBubble(document.getElementById("bubble-host")!);
bubble.setVisible(false);
const statusEl = document.getElementById("status")!;
const tasksEl = document.getElementById("tasks")!;
const focusEl = document.getElementById("focus")!;

const characters: Record<string, Character> = Object.fromEntries(FACTORIES.map(f => { const c = f(); return [c.id, c]; }));
const rig = new Rig();
rig.sleepAfter = SLEEP_AFTER_S;
const reducedMotionQuery = matchMedia("(prefers-reduced-motion: reduce)");
let character: Character = characters.cinder;
let settings: Settings | null = null;
let bounds: Rect = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
let viewport = { width: window.innerWidth, height: window.innerHeight };
let frame: OverlayFrame | null = null;
/** `avoid`: windows the bubble should keep off (global DIP), when main sends them. */
let state: (EmberState & { avoid?: Rect[] }) | null = null;
let emotion: Emotion = "neutral";
/** The gesture field as last received: a gesture plays once, when it changes. */
let gestureSeen: Gesture | null | undefined;
let pose: Pose | null = null;
/** The stage canvas: its size in CSS px and where it sits. */
let stage = { width: 0, height: 0, dpr: 0 };
let stageAt: { x: number; y: number } | null = null;
let stageShown = false;
/** Where Ember and the cursor were at the last drawn frame. */
let drawnAt: { ember: { x: number; y: number }; cursor: { x: number; y: number } } | null = null;
let lastInteractive = "";
let taskRects: Rect[] = [];
/** Ember's body while it holds still beside a control or asks (it catches clicks then), in this overlay's coordinates. */
let bodyRect: Rect | null = null;
let interactiveDirty = true;
let bubbleShown = false;
/** Ember's handle in the corner, in this overlay's coordinates (null: not on this display). */
let handleRect: Rect | null = null;
/** What the bubble keeps off: the handle, the task cards, and any windows main names. */
let avoid: Rect[] = [];
/** The ring round the control Ember works on: kept off too, where the bubble can also keep off the rest. */
let focusOff: Rect[] = [];
/** Clears the status pill's words once it has faded out (see onState). */
let statusClear: ReturnType<typeof setTimeout> | null = null;
/** The windows main names (the settings window while the user works in it), in this overlay's coordinates. */
let windows: Rect[] = [];
let avoidKey = "null";

function applyReducedMotion(): void {
  rig.reducedMotion = reducedMotionQuery.matches || settings?.reduceMotion === true;
  // Calm mode also stills the CSS pulses (the bubble's dot, the status dot, the focus glow).
  document.documentElement.classList.toggle("calm", settings?.reduceMotion === true);
}
reducedMotionQuery.addEventListener("change", applyReducedMotion);

function applySettings(s: Settings): void {
  settings = s;
  character = characters[s.character] ?? characters.cinder;
  bubble.setSpeaker("Ember");
  applyReducedMotion();
  requestDraw();
}

api.onInit((i: OverlayInit) => {
  bounds = i.bounds;
  // The handle's place, when the main process says (`handle`, global DIP; null = on another display).
  // Otherwise it is where it always is: the bottom-right corner, 200×56, 12 px in.
  const given = (i as OverlayInit & { handle?: Rect | null }).handle;
  handleRect = given === undefined
    ? { x: i.bounds.width - 212, y: i.bounds.height - 68, width: 200, height: 56 }
    : given && { x: given.x - i.bounds.x, y: given.y - i.bounds.y, width: given.width, height: given.height };
  placeTasks();
  applySettings(i.settings);
});
api.onSettings(applySettings);
api.onFrame(f => {
  frame = f;
  // Away (hidden, or on another display): one more draw clears Ember, then nothing until it is back.
  if (!isHere(f)) { if (drawnAt) requestDraw(); return; }
  // Resting: come back at once when Ember or the cursor moves.
  if (!drawnAt || moved(f.ember, drawnAt.ember, 0.05) || moved(f.cursor, drawnAt.cursor, 0.5)) requestDraw();
});
api.onState((s: EmberState & { avoid?: Rect[] }) => {
  state = s;
  const g = s.gesture ?? null;
  const fresh = g !== gestureSeen;
  gestureSeen = g;
  if (s.emotion !== emotion) {
    emotion = s.emotion;
    rig.setEmotion(s.emotion, fresh && g ? { gesture: g } : {});
  } else if (fresh) {
    // A new gesture plays; a cleared one hands back to the emotion's own.
    rig.setGesture(g ?? PRESETS[rig.emotion].gesture);
  }
  rig.setTalking(s.talking);
  if (s.talking || s.bubble.visible) rig.wake();
  const b = s.bubble;
  bubble.setMood(b.mood);
  showWhere(b.where, b.title);
  bubble.setTitle(b.title);
  // The finished answer arrives plain; the tail shown while it streams may still carry markdown.
  bubble.setThought(b.streaming ? plainStream(b.thought) : b.thought);
  bubble.setStreaming(b.streaming);
  bubble.setStep(b.step);
  bubble.setExpanded(b.expanded === true);
  bubble.setActions(b.actions.length ? b.actions.map(a => ({ key: a.id, label: a.label, primary: a.primary, onClick: () => api.bubbleAction(a.id) })) : null);
  const f = s.focus && s.focus.width > 2 && s.focus.height > 2 ? s.focus : null;
  focusEl.hidden = !f;
  if (f) {
    const pad = 4;
    Object.assign(focusEl.style, { left: `${f.x - bounds.x - pad}px`, top: `${f.y - bounds.y - pad}px`, width: `${f.width + pad * 2}px`, height: `${f.height + pad * 2}px` });
  }
  statusEl.hidden = !s.status;
  const statusText = statusEl.querySelector("span")!;
  // Its words stay while it fades out (not an empty capsule), and go once it has: the same status shown again is
  // announced again. A newer status cancels an older fade's clearing (it would empty the newer words as they fade);
  // other updates during the fade leave the clearing as it is (re-arming it on each would keep the words for good).
  if (s.status) {
    if (statusClear) { clearTimeout(statusClear); statusClear = null; }
    if (statusText.textContent !== s.status) statusText.textContent = s.status;
  } else if (statusText.textContent && !statusClear) {
    statusClear = setTimeout(() => { statusClear = null; if (statusEl.hidden) statusText.textContent = ""; }, 250);
  }
  // Cards sit at a fixed place, so their buttons are measured only when the cards change (or change corner).
  const changed = renderTasks(s.tasks);
  if (!cornerTasks() && (changed || keepOffKey(s) !== avoidKey)) measureTasks();
  requestDraw();
});

// ── Where a task acts (§2.4): a badge before the bubble's title, "on build-01"; nothing for this computer ──
const bubbleHead = document.querySelector<HTMLElement>("#bubble-host .eb-head");
const whereBadge = Object.assign(document.createElement("span"), { className: "where", hidden: true });
let whereShown = "";
/** Puts (or takes away) the badge before the title; when only it changed, the bubble is told its size changed. */
function showWhere(where: string | undefined, title: string): void {
  const w = whereText(where) ?? "";
  if (w === whereShown || !bubbleHead) return;
  whereShown = w;
  whereBadge.textContent = w;
  whereBadge.hidden = !w;
  if (!whereBadge.isConnected) bubbleHead.insertBefore(whereBadge, bubbleHead.querySelector(".eb-title"));
  // The bubble re-measures on a change it makes itself: setting the title anew marks it changed.
  bubble.setTitle("");
  bubble.setTitle(title);
}

// ── Task cards: stacked just above the handle; kept (not rebuilt) across updates, so a click is never lost to a re-render ──
// Tasks under way sit nearest the handle; when the stack would run off the top of the screen, the oldest ended
// cards fold into one "+N more" line (with Close all), and if even the tasks under way don't fit, the stack scrolls.

/** Space between cards (the stack's CSS gap) and kept free above the stack. */
const CARD_GAP = 8;
const TOP_ROOM = 12;
/** The height the stack may take above the handle (px). */
let tasksRoom = Infinity;

/** The handle's pill is drawn this far inside its window (.handle's inset in handle/styles.css). */
const PILL_INSET = 4;
/** The cards are in the bottom-left corner: the ring round the control Ember works on was under them in their own. */
let cardsLeft = false;

function placeTasks(): void {
  const h = handleRect;
  // Lined up with the pill as it shows (its right edge, a card's gap above it), not with its window.
  const bottom = h ? Math.max(8, viewport.height - (h.y + PILL_INSET) + CARD_GAP) : 80;
  const inset = `${h ? Math.max(8, viewport.width - (h.x + h.width - PILL_INSET)) : 12}px`;
  tasksEl.style.right = cardsLeft ? "auto" : inset;
  tasksEl.style.left = cardsLeft ? inset : "auto";
  tasksEl.style.bottom = `${bottom}px`;
  tasksRoom = Math.max(80, viewport.height - bottom - TOP_ROOM);
  tasksEl.style.maxHeight = `${tasksRoom}px`;
  fitTasks();
  measureTasks();
}

/**
 * The cards make way for the control Ember works on (a chat button or a wizard's Next in the bottom-right corner):
 * while its ring is under them, they go to the bottom-left corner, so the user sees what Ember clicks or asks about.
 * True when they moved (and were measured where they are now).
 */
function cornerTasks(): boolean {
  const f = state?.focus && state.focus.width > 2 && state.focus.height > 2 ? state.focus : null;
  let left = false;
  if (f && tasksEl.children.length) {
    const r = tasksEl.getBoundingClientRect();
    // Where the stack is in its own corner (it may be in the other one now: the same distance in, mirrored).
    const own = { x: cardsLeft ? viewport.width - r.x - r.width : r.x, y: r.y, width: r.width, height: r.height };
    left = cardsCorner({ x: f.x - bounds.x, y: f.y - bounds.y, width: f.width, height: f.height }, own, viewport.width) === "left";
  }
  if (left === cardsLeft) return false;
  cardsLeft = left;
  placeTasks();
  return true;
}

let lastCards = "null";
/** Where the cards' buttons are (they take clicks) and what the bubble keeps off. */
function measureTasks(): void {
  // A stack that scrolls takes the wheel (and clicks) over all of it; otherwise only its buttons do.
  const scrolls = tasksEl.classList.contains("scroll");
  const hot = scrolls ? [tasksEl] : [...tasksEl.querySelectorAll<HTMLElement>(".task:not([hidden]) .task-actions:not([hidden])")];
  taskRects = hot.map(el => {
    const r = el.getBoundingClientRect();
    return { x: r.x - 4, y: r.y - 4, width: r.width + 8, height: r.height + 8 };
  });
  const list: Rect[] = handleRect ? [handleRect] : [];
  // Windows main asks the bubble to keep off (the settings window while it is open), in global DIP.
  avoidKey = keepOffKey(state);
  windows = (state?.avoid ?? []).map(r => ({ x: r.x - bounds.x, y: r.y - bounds.y, width: r.width, height: r.height }));
  list.push(...windows);
  // The control Ember works on: the bubble keeps off its ring (what Ember is about to click, or is showing you) where
  // it can do that and still keep off the handle, the cards and the windows above.
  const f = state?.focus;
  focusOff = f && f.width > 2 && f.height > 2 ? [{ x: f.x - bounds.x - 8, y: f.y - bounds.y - 8, width: f.width + 16, height: f.height + 16 }] : [];
  let cardsAt: Rect | null = null;
  if (tasksEl.children.length) {
    const r = tasksEl.getBoundingClientRect();
    list.push({ x: r.x, y: r.y, width: r.width, height: r.height });
    cardsAt = { x: r.x + bounds.x, y: r.y + bounds.y, width: r.width, height: r.height };
  }
  // Ember itself keeps off the cards too (main moves it): it never sits on their Stop button.
  const cardsKey = JSON.stringify(cardsAt);
  if (cardsKey !== lastCards) { lastCards = cardsKey; api.setCards(cardsAt); }
  avoid = list;
  interactiveDirty = true;
  reportInteractive();
}

/** `said`: the detail Ember last sent; `stopAt`: when its Stop was pressed (0: not pressed, or it works again). */
interface CardEls { li: HTMLLIElement; state: HTMLElement; where: HTMLElement; title: HTMLElement; detail: HTMLElement; actions: HTMLDivElement; actionsKey: string; armedAt: number; said: string; stopAt: number }
/** What the bubble keeps off besides the cards: the windows main names and the control Ember works on. */
const keepOffKey = (s: (EmberState & { avoid?: Rect[] }) | null) => JSON.stringify([s?.avoid ?? null, s?.focus ?? null]);
const cards = new Map<string, CardEls>();
let tasksKey = "";
/** The cards in stack order (top first), as last rendered. */
let stacked: TaskCard[] = [];
/** The ended cards folded into the "+N more" line now (Close all closes the failures among them). */
let folded: TaskCard[] = [];

/** The "+N more" line at the top of the stack: one element, kept, so its Close all is never lost to a re-render. */
const more = (() => {
  const li = document.createElement("li");
  li.className = "task more";
  li.hidden = true;
  const text = document.createElement("div");
  text.className = "more-text";
  const title = document.createElement("b");
  const detail = document.createElement("span");
  text.append(title, detail);
  const actions = document.createElement("div");
  actions.className = "task-actions";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close all";
  onPress(close, () => { for (const id of foldedLine(folded).close) api.bubbleAction(id); });
  actions.append(close);
  li.append(text, actions);
  return { li, title, detail, actions, close };
})();

/** The "+N more" line says what is folded into it now. */
function showFolded(list: TaskCard[]): void {
  const line = foldedLine(list);
  more.title.textContent = line.title;
  more.detail.textContent = line.detail;
  more.actions.hidden = line.close.length === 0;
  more.close.setAttribute("aria-label", `Close all: ${line.close.length === 1 ? "1 earlier task" : `${line.close.length} earlier tasks`}`);
}

/** Folds the oldest ended cards into the "+N more" line until the stack fits above the handle; scrolls if still too tall. */
function fitTasks(): void {
  const items = stacked.map(t => cards.get(t.id)?.li).filter((li): li is HTMLLIElement => !!li);
  const ended = stacked.filter(t => !underWay(t)).length;
  // Everything shown once to measure it (one layout read), the line as it would read, then what doesn't fit folds away.
  for (const li of items) li.hidden = false;
  more.li.hidden = ended === 0;
  if (!items.length) { folded = []; tasksEl.classList.remove("scroll"); return; }
  if (ended) showFolded(stacked.slice(0, ended));
  const heights = items.map(li => li.offsetHeight);
  const k = foldCount(heights, ended, tasksRoom, CARD_GAP, more.li.hidden ? 0 : more.li.offsetHeight);
  folded = stacked.slice(0, k);
  items.slice(0, k).forEach(li => { li.hidden = true; });
  more.li.hidden = k === 0;
  if (k) showFolded(folded);
  const scrolls = tasksEl.scrollHeight > tasksEl.clientHeight + 1;
  const was = tasksEl.classList.contains("scroll");
  tasksEl.classList.toggle("scroll", scrolls);
  // When it starts scrolling, the cards nearest the handle (the newest under way) are the ones in view.
  if (scrolls && !was) tasksEl.scrollTop = tasksEl.scrollHeight;
}

/** The card's detail: what Ember last said, or "Stopping…" from the moment its Stop is pressed. */
function showDetail(c: CardEls): void {
  const detail = c.stopAt ? TASK_STOPPING : c.said;
  if (c.detail.textContent !== detail) c.detail.textContent = detail;
  c.detail.hidden = !detail;
}

/** A Stop being carried out takes no second press (it says so to screen readers too). */
function showStopping(c: CardEls): void {
  c.li.toggleAttribute("data-stopping", c.stopAt > 0);
  for (const b of c.actions.querySelectorAll<HTMLButtonElement>("button.stop")) {
    if (c.stopAt) b.setAttribute("aria-disabled", "true"); else b.removeAttribute("aria-disabled");
  }
}

/**
 * Stop was pressed: the card says so at once, before the task has wound down (a press that shows nothing gets
 * pressed again, or the user reaches for the kill switch). If Ember never says it is stopping, Stop works again.
 */
function pressedStop(c: CardEls): void {
  const at = performance.now();
  c.stopAt = at;
  showDetail(c);
  showStopping(c);
  setTimeout(() => {
    if (c.stopAt !== at || stopPending(at, performance.now(), c.said)) return;
    c.stopAt = 0;
    showDetail(c);
    showStopping(c);
    fitTasks();
    measureTasks();
  }, STOP_ACK_MS + 50);
  // The detail's height may have changed: the buttons are measured where they are now.
  fitTasks();
  measureTasks();
}

function renderTasks(tasks: TaskCard[]): boolean {
  const key = JSON.stringify(tasks);
  if (key === tasksKey) return false;
  tasksKey = key;
  stacked = stackOrder(tasks);
  const items = stacked.map(t => {
    let c = cards.get(t.id);
    if (!c) {
      const li = document.createElement("li");
      li.className = "task";
      // New: it fades in once (a card only moved in the stack is re-inserted, and must not blink).
      li.dataset.fresh = "";
      setTimeout(() => { delete li.dataset.fresh; }, 400);
      const state = Object.assign(document.createElement("span"), { className: "sr" });
      const where = Object.assign(document.createElement("span"), { className: "where", hidden: true });
      const title = document.createElement("b");
      const detail = Object.assign(document.createElement("span"), { className: "detail" });
      const actions = document.createElement("div");
      actions.className = "task-actions";
      actions.hidden = true;
      li.append(state, where, title, detail, actions);
      c = { li, state, where, title, detail, actions, actionsKey: "", armedAt: 0, said: "", stopAt: 0 };
      cards.set(t.id, c);
    }
    c.li.dataset.status = t.status;
    if (c.state.textContent !== STATE_WORD[t.status]) c.state.textContent = STATE_WORD[t.status];
    const where = whereText(t.where) ?? "";
    if (c.where.textContent !== where) c.where.textContent = where;
    c.where.hidden = !where;
    if (c.title.textContent !== t.title) c.title.textContent = t.title;
    c.said = t.detail;
    // A pressed Stop keeps saying so until Ember does (or the task has ended, or the press didn't land).
    if (c.stopAt && (!underWay(t) || !stopPending(c.stopAt, performance.now(), t.detail))) c.stopAt = 0;
    showDetail(c);
    const list = t.actions ?? [];
    const actionsKey = JSON.stringify([list, t.title]);
    if (actionsKey !== c.actionsKey) {
      c.actionsKey = actionsKey;
      c.stopAt = 0;
      // New buttons take no press for a moment: the pointer may be resting where a card just appeared (the ask box
      // closed over it), and a Stop there must be a deliberate click.
      c.armedAt = performance.now() + TASK_ARM_MS;
      c.actions.hidden = list.length === 0;
      c.actions.replaceChildren(...list.map(a => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = a.label;
        b.setAttribute("aria-label", `${a.label}: ${t.title}`);
        const card = c!;
        const stop = /:stop$/.test(a.id);
        if (stop) b.className = "stop";
        onPress(b, () => {
          if (performance.now() < card.armedAt || (stop && card.stopAt)) return;
          if (stop) pressedStop(card);
          api.bubbleAction(a.id);
        });
        return b;
      }));
    }
    showStopping(c);
    return c.li;
  });
  const ids = new Set(tasks.map(t => t.id));
  for (const id of [...cards.keys()]) if (!ids.has(id)) cards.delete(id);
  // The "+N more" line heads the stack whenever there are ended cards that could fold.
  const all = stacked.some(t => !underWay(t)) ? [more.li, ...items] : items;
  const same = all.length === tasksEl.children.length && all.every((li, i) => tasksEl.children[i] === li);
  if (!same) tasksEl.replaceChildren(...all);
  fitTasks();
  return true;
}

// ── Drawing ──

function moved(a: { x: number; y: number }, b: { x: number; y: number }, by: number): boolean {
  return Math.abs(a.x - b.x) > by || Math.abs(a.y - b.y) > by;
}

/** Ember is shown and (at least partly) on this overlay's display. */
function isHere(f: OverlayFrame | null): f is OverlayFrame {
  const size = settings?.size ?? 60;
  return !!f && f.visible
    && f.ember.x > bounds.x - size * 2 && f.ember.x < bounds.x + bounds.width + size * 2
    && f.ember.y > bounds.y - size * 2 && f.ember.y < bounds.y + bounds.height + size * 2;
}

function fit(): void {
  viewport = { width: window.innerWidth, height: window.innerHeight };
  placeTasks();
  interactiveDirty = true;
  requestDraw();
}
window.addEventListener("resize", fit);

/** Room for Ember at this size: hands, hops, flames and the emote over its head. */
function stageFor(size: number): { width: number; height: number; padX: number; padTop: number } {
  const pad = size * 1.7;
  return { width: Math.ceil(pad * 2), height: Math.ceil(pad * 2.25), padX: pad, padTop: pad * 1.25 };
}

function showStage(on: boolean): void {
  if (on === stageShown) return;
  stageShown = on;
  canvas.style.visibility = on ? "visible" : "hidden";
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

function setBody(r: Rect | null): void {
  if (JSON.stringify(r) === JSON.stringify(bodyRect)) return;
  bodyRect = r;
  interactiveDirty = true;
}

function reportInteractive(): void {
  if (!interactiveDirty) return;
  interactiveDirty = false;
  const rects = [...bubble.interactiveRects(), ...taskRects, ...(bodyRect ? [bodyRect] : [])];
  const key = JSON.stringify(rects);
  if (key !== lastInteractive) { lastInteractive = key; api.setInteractive(rects); }
}

let timer: ReturnType<typeof setTimeout> | null = null;
let rafPending = false;

/** Draw on the next animation frame, or after `delay` ms (a pending sooner draw wins). */
function requestDraw(delay = 0): void {
  if (rafPending) return;
  if (delay > 0) {
    if (!timer) timer = setTimeout(() => { timer = null; requestDraw(); }, delay);
    return;
  }
  if (timer) { clearTimeout(timer); timer = null; }
  rafPending = true;
  requestAnimationFrame(draw);
}

let last = performance.now();
function draw(now: number): void {
  rafPending = false;
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
  last = now;
  const size = settings?.size ?? 60;
  const scale = size / 100;

  const fr = frame;
  const here = isHere(fr);
  const showBubble = here && !!state?.bubble.visible;
  if (here) {
    const lx = fr.ember.x - bounds.x, ly = fr.ember.y - bounds.y;
    const moving = !drawnAt || moved(fr.ember, drawnAt.ember, 0.05);
    const looking = !drawnAt || moved(fr.cursor, drawnAt.cursor, 0.5);
    if (looking) rig.wake();
    drawnAt = { ember: { ...fr.ember }, cursor: { ...fr.cursor } };
    rig.setPosition(lx / scale, ly / scale, dt);
    // Look at the control Ember is working on, else at the cursor; point at it while acting or guiding.
    const f = state?.focus && state.focus.width > 2 && state.focus.height > 2 ? state.focus : null;
    const target = f ? { x: f.x + f.width / 2, y: f.y + f.height / 2 } : fr.cursor;
    const dx = target.x - fr.ember.x, dy = target.y - fr.ember.y;
    const d = Math.max(80, Math.hypot(dx, dy));
    rig.lookAt(dx / d * 1.3, dy / d * 1.3);
    const gesture = pose?.gesture ?? "rest";
    const aiming = !!f && (gesture === "point" || gesture === "tap" || gesture === "type");
    const len = Math.hypot(dx, dy) || 1;
    rig.setAim(aiming ? { x: dx / len, y: dy / len } : null);
    pose = rig.update(dt);

    const box = stageFor(size);
    const dpr = window.devicePixelRatio || 1;
    if (box.width !== stage.width || box.height !== stage.height || dpr !== stage.dpr) {
      stage = { width: box.width, height: box.height, dpr };
      canvas.width = Math.round(box.width * dpr);
      canvas.height = Math.round(box.height * dpr);
      canvas.style.width = `${box.width}px`;
      canvas.style.height = `${box.height}px`;
    }
    // Whole pixels for the canvas (no resampling blur); the fraction goes into the drawing.
    const ox = Math.round(lx - box.padX), oy = Math.round(ly - box.padTop);
    if (stageAt?.x !== ox || stageAt.y !== oy) {
      stageAt = { x: ox, y: oy };
      canvas.style.transform = `translate(${ox}px, ${oy}px)`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.width, box.height);
    ctx.translate(lx - ox, ly - oy);
    ctx.scale(scale, scale);
    character.draw(ctx, pose);
    showStage(true);
    // With no room beside the settings window, a bubble that asks nothing hides rather than cover it (the window's
    // Conversation section has its words); a question stays, wherever it must go.
    // (An answer opened in full is pinned: it stays on screen too.)
    const asks = !!state?.bubble.actions.some(a => !a.id.startsWith("ui:")) || state?.bubble.expanded === true;
    if (showBubble && bubble.place({ x: lx, y: ly + size * 0.4 }, viewport, size, avoid, asks ? [] : windows, focusOff)) interactiveDirty = true;
    // Beside a control (a guide's step, a click) or asking, Ember holds still where the user may click, and may hide
    // another control (a form's Submit next to the button it points at): its body then catches clicks, so one on
    // Ember never lands on what it hides. Following the cursor, it lets them through; and sitting on the control
    // itself (no room beside one as wide as the screen), a click there is meant for the control.
    const body = { x: Math.round(lx - size * 0.45), y: Math.round(ly - size * 0.55), width: Math.round(size * 0.9), height: Math.round(size * 1.05) };
    const onTarget = !!f && overlaps(body, { x: f.x - bounds.x, y: f.y - bounds.y, width: f.width, height: f.height });
    setBody((f || (showBubble && asks)) && !onTarget ? body : null);

    const urgent = moving || looking || rig.motion === "brisk";
    const lively = rig.motion === "gentle" || BRISK.has(pose.gesture) || !!state?.talking || pose.talk > 0.01;
    requestDraw(urgent ? 0 : lively ? LIVELY_MS : rig.asleep ? DOZING_MS : RESTING_MS);
  } else {
    // Hidden or on another display: sleep until a frame brings Ember here.
    showStage(false);
    drawnAt = null;
    setBody(null);
  }
  bubble.setVisible(showBubble);
  if (showBubble !== bubbleShown) { bubbleShown = showBubble; interactiveDirty = true; }
  reportInteractive();
}
requestDraw();
