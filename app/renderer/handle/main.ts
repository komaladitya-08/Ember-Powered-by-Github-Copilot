/** Handle: Ember's face and status in the corner; click for Ember's menu. */

import { Rig, FACTORIES, type Character, type Emotion } from "@ember/characters";
import { plainStream } from "@ember/bubble";
import type { HandleApi } from "../../shared/overlay";
import { cardTask, cardText } from "./card";
import type { Settings } from "../../main/settings";

declare global { interface Window { emberHandle: HandleApi } }

const api = window.emberHandle;
const NAMES: Record<string, string> = { cinder: "Cinder", wisp: "Wisp", glassling: "Glassling", glint: "Glint" };
const characters: Record<string, Character> = Object.fromEntries(FACTORIES.map(f => { const c = f(); return [c.id, c]; }));
let character = characters.cinder;
const rig = new Rig();
let emotion: Emotion = "neutral";
const canvas = document.getElementById("face") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const $ = (id: string) => document.getElementById(id)!;

let name = "Ember";
// Calm mode follows the setting or the desktop's reduced-motion preference; the face dozes with Ember.
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
let reduceSetting = false;
const applyMotion = () => { rig.reducedMotion = reduceSetting || reduce.matches; };
reduce.addEventListener("change", applyMotion);
rig.sleepAfter = 180;
function applySettings(s: Settings): void {
  character = characters[s.character] ?? characters.cinder;
  name = NAMES[s.character] ?? "Ember";
  $("name").textContent = name;
  reduceSetting = s.reduceMotion;
  document.documentElement.classList.toggle("calm", s.reduceMotion);
  applyMotion();
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
  host.replaceChildren(...list.map(a => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = a.label;
    b.setAttribute("aria-label", label(a));
    if (a.primary) b.className = "primary";
    b.addEventListener("click", () => api.bubbleAction(a.id));
    return b;
  }));
}

const thoughtEl = $("thought");
let wasStreaming = false;
api.onState(s => {
  if (s.emotion !== emotion) { emotion = s.emotion; rig.setEmotion(s.emotion); }
  rig.setTalking(s.talking);
  busy = s.talking || s.bubble.streaming;
  const b = s.bubble;
  const mic = $("mic");
  const micShown = s.mic === "waiting" || s.mic === "active" || s.mic === "muted" || s.mic === "error";
  mic.hidden = !micShown;
  mic.dataset.state = s.mic ?? "off";
  mic.title = s.mic === "active" ? "Hearing you" : s.mic === "waiting" ? "Listening for “Hey Ember”" : s.mic === "muted" ? "Microphone off" : "";
  if (!fallback) {
    // The pill: one line. An answer's title is the character's name, already shown above: the line shows what it said.
    const said = b.visible ? (b.title === name ? (b.streaming ? plainStream(b.thought) : b.thought) : b.title) : "";
    $("line").textContent = s.status ?? (said.replace(/\s+/g, " ").trim() || s.idle || "Ready");
    return;
  }
  // The card: a short label or title in bold, the words under it, then the question's buttons and the running task.
  const task = cardTask(s.tasks);
  const text = cardText(b, name, s.status ?? s.idle ?? null, task?.title);
  if ($("line").textContent !== text.line) $("line").textContent = text.line;
  const thought = b.streaming ? plainStream(text.thought) : text.thought;
  if (thoughtEl.textContent !== thought) thoughtEl.textContent = thought;
  // While it streams, the newest lines show; once done, it reads (and scrolls) from the start.
  if (b.streaming) thoughtEl.scrollTop = thoughtEl.scrollHeight;
  else if (wasStreaming) thoughtEl.scrollTop = 0;
  // The fade at the top only when the start has really scrolled away.
  thoughtEl.dataset.overflow = String(b.streaming && thoughtEl.scrollHeight > thoughtEl.clientHeight + 1);
  wasStreaming = b.visible && b.streaming;
  document.body.dataset.mood = b.visible ? b.mood : "idle";
  document.body.classList.toggle("streaming", b.visible && b.streaming);
  // A step the task row already shows isn't repeated.
  const step = b.visible && b.step !== task?.detail ? b.step : null;
  $("step").hidden = !step;
  $("step").textContent = step ?? "";

  const actions = b.visible ? b.actions : [];
  document.body.classList.toggle("asking", actions.length > 0);
  $("actions").hidden = actions.length === 0;
  buttons($("actions"), actions, a => a.label);

  $("task").hidden = !task;
  if (task) {
    $("task").dataset.status = task.status;
    $("task-title").textContent = task.title;
    $("task-detail").textContent = task.detail;
    $("task").title = `${task.title}${task.detail ? `: ${task.detail}` : ""}`;
  }
  buttons($("task-actions"), task?.actions ?? [], a => `${a.label}: ${task?.title ?? ""}`);
  requestAnimationFrame(fitCard);
});

/**
 * Asks the main process for a card as tall as what it shows (no empty gap under a short question,
 * room for a long one), when it offers that (`fit`); otherwise the card keeps the size main gives it.
 */
let askedHeight = 0;
function fitCard(): void {
  const fit = (api as HandleApi & { fit?: (height: number) => void }).fit;
  if (!fallback || typeof fit !== "function") return;
  const handleEl = $("handle");
  const extra = thoughtEl.scrollHeight - thoughtEl.clientHeight;
  let h = handleEl.offsetHeight + Math.max(0, extra);
  for (const id of ["actions", "task"]) {
    const el = $(id);
    if (!el.hidden) h += el.offsetHeight + 10;
  }
  h = Math.ceil(h);
  if (Math.abs(h - askedHeight) < 4) return;
  askedHeight = h;
  fit(h);
}
$("handle").addEventListener("click", () => api.openMenu());

let pointer = { x: -1, y: -1 };
window.addEventListener("pointermove", e => { pointer = { x: e.clientX, y: e.clientY }; });

let last = performance.now();
/** Talking or streaming, or a lively face: full frame rate; a calm face ~30 fps; a still one ~15 (the page sleeps in between). */
let busy = false;
const next = () => {
  const motion = rig.motion;
  const gap = busy || motion === "brisk" ? 0 : motion === "gentle" ? 33 : 66;
  if (gap) setTimeout(() => requestAnimationFrame(frame), gap); else requestAnimationFrame(frame);
};
function frame(now: number): void {
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
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
