/** Handle: Ember's face and status in the corner; click for Ember's menu. */

import { Rig, FACTORIES, type Character, type Emotion } from "@ember/characters";
import type { HandleApi } from "../../shared/overlay";
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

function applySettings(s: Settings): void {
  character = characters[s.character] ?? characters.cinder;
  $("name").textContent = NAMES[s.character] ?? "Ember";
}

api.onInit(i => {
  document.body.classList.toggle("fallback", i.fallback);
  applySettings(i.settings);
});
api.onSettings(applySettings);
api.onState(s => {
  if (s.emotion !== emotion) { emotion = s.emotion; rig.setEmotion(s.emotion); }
  rig.setTalking(s.talking);
  $("line").textContent = s.status ?? (s.bubble.visible ? s.bubble.title : "Ready");
  $("thought").textContent = s.bubble.visible ? s.bubble.thought : "";
  // Only the fallback card shows buttons; with a compositor they are in Ember's bubble.
  const actions = document.body.classList.contains("fallback") && s.bubble.visible ? s.bubble.actions : [];
  document.body.classList.toggle("asking", actions.length > 0);
  $("actions").hidden = actions.length === 0;
  $("actions").replaceChildren(...actions.map(a => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = a.label;
    if (a.primary) b.className = "primary";
    b.addEventListener("click", () => api.bubbleAction(a.id));
    return b;
  }));
});
$("handle").addEventListener("click", () => api.openMenu());

let pointer = { x: -1, y: -1 };
window.addEventListener("pointermove", e => { pointer = { x: e.clientX, y: e.clientY }; });

let last = performance.now();
function frame(now: number): void {
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.05));
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
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
