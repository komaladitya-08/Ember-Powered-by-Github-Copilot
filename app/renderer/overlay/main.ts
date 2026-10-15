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
import { ReasoningBubble, plainStream } from "@ember/bubble";
import type { OverlayApi, OverlayFrame, OverlayInit, EmberState, Rect, TaskCard } from "../../shared/overlay";
import type { Settings } from "../../main/settings";

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
let state: EmberState | null = null;
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
let interactiveDirty = true;
let bubbleShown = false;
/** Ember's handle in the corner, in this overlay's coordinates (null: not on this display). */
let handleRect: Rect | null = null;
/** What the bubble keeps off: the handle and the task cards. */
let avoid: Rect[] = [];

function applyReducedMotion(): void {
  rig.reducedMotion = reducedMotionQuery.matches || settings?.reduceMotion === true;
  // Calm mode also stills the CSS pulses (the bubble's dot, the status dot, the focus glow).
  document.documentElement.classList.toggle("calm", settings?.reduceMotion === true);
}
reducedMotionQuery.addEventListener("change", applyReducedMotion);

function applySettings(s: Settings): void {
  settings = s;
  character = characters[s.character] ?? characters.cinder;
  bubble.setSpeaker(character.name);
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
api.onState(s => {
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
  bubble.setTitle(b.title);
  // The finished answer arrives plain; the tail shown while it streams may still carry markdown.
  bubble.setThought(b.streaming ? plainStream(b.thought) : b.thought);
  bubble.setStreaming(b.streaming);
  bubble.setStep(b.step);
  bubble.setActions(b.actions.length ? b.actions.map(a => ({ key: a.id, label: a.label, primary: a.primary, onClick: () => api.bubbleAction(a.id) })) : null);
  const f = s.focus;
  focusEl.hidden = !f;
  if (f) {
    const pad = 4;
    Object.assign(focusEl.style, { left: `${f.x - bounds.x - pad}px`, top: `${f.y - bounds.y - pad}px`, width: `${f.width + pad * 2}px`, height: `${f.height + pad * 2}px` });
  }
  statusEl.hidden = !s.status;
  const statusText = statusEl.querySelector("span")!;
  if (statusText.textContent !== (s.status ?? "")) statusText.textContent = s.status ?? "";
  // Cards sit at a fixed place, so their buttons are measured only when the cards change.
  if (renderTasks(s.tasks)) measureTasks();
  requestDraw();
});

// ── Task cards: stacked just above the handle; kept (not rebuilt) across updates, so a click is never lost to a re-render ──

function placeTasks(): void {
  const h = handleRect;
  tasksEl.style.right = `${h ? Math.max(8, viewport.width - (h.x + h.width)) : 12}px`;
  tasksEl.style.bottom = `${h ? Math.max(8, viewport.height - h.y + 10) : 80}px`;
  measureTasks();
}

/** Where the cards' buttons are (they take clicks) and what the bubble keeps off. */
function measureTasks(): void {
  taskRects = [...tasksEl.querySelectorAll<HTMLElement>(".task-actions:not([hidden])")].map(el => {
    const r = el.getBoundingClientRect();
    return { x: r.x - 4, y: r.y - 4, width: r.width + 8, height: r.height + 8 };
  });
  const list: Rect[] = handleRect ? [handleRect] : [];
  if (tasksEl.children.length) {
    const r = tasksEl.getBoundingClientRect();
    list.push({ x: r.x, y: r.y, width: r.width, height: r.height });
  }
  avoid = list;
  interactiveDirty = true;
  reportInteractive();
}

interface CardEls { li: HTMLLIElement; title: HTMLElement; detail: HTMLElement; actions: HTMLDivElement; actionsKey: string }
const cards = new Map<string, CardEls>();
let tasksKey = "";

function renderTasks(tasks: TaskCard[]): boolean {
  const key = JSON.stringify(tasks);
  if (key === tasksKey) return false;
  tasksKey = key;
  const items = tasks.map(t => {
    let c = cards.get(t.id);
    if (!c) {
      const li = document.createElement("li");
      li.className = "task";
      const title = document.createElement("b");
      const detail = document.createElement("span");
      const actions = document.createElement("div");
      actions.className = "task-actions";
      actions.hidden = true;
      li.append(title, detail, actions);
      c = { li, title, detail, actions, actionsKey: "" };
      cards.set(t.id, c);
    }
    c.li.dataset.status = t.status;
    if (c.title.textContent !== t.title) c.title.textContent = t.title;
    if (c.detail.textContent !== t.detail) c.detail.textContent = t.detail;
    c.detail.hidden = !t.detail;
    const list = t.actions ?? [];
    const actionsKey = JSON.stringify([list, t.title]);
    if (actionsKey !== c.actionsKey) {
      c.actionsKey = actionsKey;
      c.actions.hidden = list.length === 0;
      c.actions.replaceChildren(...list.map(a => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = a.label;
        b.setAttribute("aria-label", `${a.label}: ${t.title}`);
        b.addEventListener("click", () => api.bubbleAction(a.id));
        return b;
      }));
    }
    return c.li;
  });
  const ids = new Set(tasks.map(t => t.id));
  for (const id of [...cards.keys()]) if (!ids.has(id)) cards.delete(id);
  const same = items.length === tasksEl.children.length && items.every((li, i) => tasksEl.children[i] === li);
  if (!same) tasksEl.replaceChildren(...items);
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

function reportInteractive(): void {
  if (!interactiveDirty) return;
  interactiveDirty = false;
  const rects = [...bubble.interactiveRects(), ...taskRects];
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
    const f = state?.focus;
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
    if (showBubble && bubble.place({ x: lx, y: ly + size * 0.4 }, viewport, size, avoid)) interactiveDirty = true;

    const urgent = moving || looking || rig.motion === "brisk";
    const lively = rig.motion === "gentle" || BRISK.has(pose.gesture) || !!state?.talking || pose.talk > 0.01;
    requestDraw(urgent ? 0 : lively ? LIVELY_MS : rig.asleep ? DOZING_MS : RESTING_MS);
  } else {
    // Hidden or on another display: sleep until a frame brings Ember here.
    showStage(false);
    drawnAt = null;
  }
  bubble.setVisible(showBubble);
  if (showBubble !== bubbleShown) { bubbleShown = showBubble; interactiveDirty = true; }
  reportInteractive();
}
requestDraw();
