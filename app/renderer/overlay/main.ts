/**
 * Overlay renderer: draws Ember (any of the four characters) where the main
 * process says it is, plus its reasoning bubble, status pill and task cards.
 * Only redraws the area around Ember each frame; the rest stays transparent.
 */

import { Rig, FACTORIES, type Character, type Emotion } from "@ember/characters";
import { ReasoningBubble } from "@ember/bubble";
import type { OverlayApi, OverlayFrame, OverlayInit, EmberState, Rect } from "../../shared/overlay";
import type { Settings } from "../../main/settings";

declare global { interface Window { emberOverlay: OverlayApi } }

const api = window.emberOverlay;
const canvas = document.getElementById("stage") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const bubble = new ReasoningBubble(document.getElementById("bubble-host")!);
const statusEl = document.getElementById("status")!;
const tasksEl = document.getElementById("tasks")!;

const characters: Record<string, Character> = Object.fromEntries(FACTORIES.map(f => { const c = f(); return [c.id, c]; }));
const rig = new Rig();
let character: Character = characters.cinder;
let settings: Settings | null = null;
let bounds: Rect = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
let frame: OverlayFrame | null = null;
let state: EmberState | null = null;
let emotion: Emotion = "neutral";
let lastDirty: Rect | null = null;
let lastInteractive = "";

function applySettings(s: Settings): void {
  settings = s;
  character = characters[s.character] ?? characters.cinder;
}

api.onInit((i: OverlayInit) => { bounds = i.bounds; applySettings(i.settings); });
api.onSettings(applySettings);
api.onFrame(f => { frame = f; });
api.onState(s => {
  state = s;
  if (s.emotion !== emotion) { emotion = s.emotion; rig.setEmotion(s.emotion); }
  rig.setTalking(s.talking);
  const b = s.bubble;
  bubble.setMood(b.mood);
  bubble.setTitle(b.title);
  bubble.setThought(b.thought);
  bubble.setStreaming(b.streaming);
  bubble.setStep(b.step);
  bubble.setActions(b.actions.length ? b.actions.map(a => ({ label: a.label, primary: a.primary, onClick: () => api.bubbleAction(a.id) })) : null);
  statusEl.hidden = !s.status;
  statusEl.querySelector("span")!.textContent = s.status ?? "";
  tasksEl.replaceChildren(...s.tasks.map(t => {
    const li = document.createElement("li");
    li.className = "task";
    li.dataset.status = t.status;
    const title = document.createElement("b"); title.textContent = t.title;
    const detail = document.createElement("span"); detail.textContent = t.detail;
    li.append(title, detail);
    return li;
  }));
});

function fit(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(window.innerWidth * dpr), h = Math.round(window.innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; lastDirty = null; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function reportInteractive(): void {
  const rects: Rect[] = [];
  const actions = document.querySelector(".eb-actions:not([hidden])");
  if (actions && bubble.root.dataset.hidden !== "true") {
    const r = actions.getBoundingClientRect();
    rects.push({ x: r.x - 4, y: r.y - 4, width: r.width + 8, height: r.height + 8 });
  }
  const key = JSON.stringify(rects);
  if (key !== lastInteractive) { lastInteractive = key; api.setInteractive(rects); }
}

let last = performance.now();
function draw(now: number): void {
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.05));
  last = now;
  fit();
  const size = settings?.size ?? 60;
  const scale = size / 100;

  if (lastDirty) ctx.clearRect(lastDirty.x, lastDirty.y, lastDirty.width, lastDirty.height);
  lastDirty = null;

  const here = frame && frame.visible
    && frame.ember.x > bounds.x - size * 2 && frame.ember.x < bounds.x + bounds.width + size * 2
    && frame.ember.y > bounds.y - size * 2 && frame.ember.y < bounds.y + bounds.height + size * 2;

  if (frame) {
    const lx = frame.ember.x - bounds.x, ly = frame.ember.y - bounds.y;
    rig.setPosition(lx / scale, ly / scale, dt);
    const dx = frame.cursor.x - frame.ember.x, dy = frame.cursor.y - frame.ember.y;
    const d = Math.max(80, Math.hypot(dx, dy));
    rig.lookAt(dx / d * 1.3, dy / d * 1.3);
    const pose = rig.update(dt);
    if (here) {
      ctx.save();
      ctx.translate(lx, ly);
      ctx.scale(scale, scale);
      character.draw(ctx, pose);
      ctx.restore();
      const pad = size * 1.7;
      lastDirty = { x: lx - pad, y: ly - pad * 1.25, width: pad * 2, height: pad * 2.25 };
      bubble.place({ x: lx, y: ly + size * 0.4 }, { width: window.innerWidth, height: window.innerHeight });
    }
  }
  bubble.setVisible(!!(here && state?.bubble.visible));
  reportInteractive();
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
