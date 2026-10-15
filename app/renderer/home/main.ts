/** Home window: pick your Ember, size, setup checks and build facts. */

import { Rig, FACTORIES, type Character } from "@ember/characters";
import type { EmberHomeApi, Status } from "../../shared/ipc";
import type { Settings } from "../../main/settings";

declare global {
  interface Window { ember: EmberHomeApi }
}

const $ = (id: string) => document.getElementById(id)!;
const PITCH: Record<string, string> = {
  cinder: "Coal critter with ember eyes and helping hands",
  wisp: "A living flame; its fire is its mood",
  glassling: "Squishy drop of molten glass",
  glint: "Two glowing eyes; the quietest",
};

interface Card { id: string; el: HTMLButtonElement; canvas: HTMLCanvasElement; character: Character; rig: Rig }
const cards: Card[] = FACTORIES.map(make => {
  const character = make();
  const el = document.createElement("button");
  el.type = "button";
  el.className = "card";
  el.setAttribute("role", "radio");
  el.dataset.id = character.id;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  const name = document.createElement("b"); name.textContent = character.name;
  const pitch = document.createElement("span"); pitch.textContent = PITCH[character.id] ?? "";
  el.append(canvas, name, pitch);
  el.addEventListener("click", () => {
    void window.ember.updateSettings({ character: character.id as Settings["character"] });
  });
  $("cards").appendChild(el);
  return { id: character.id, el, canvas, character, rig: new Rig() };
});

let settings: Settings | null = null;
function applySettings(s: Settings): void {
  const changed = settings?.character !== s.character;
  settings = s;
  for (const c of cards) {
    const on = c.id === s.character;
    c.el.setAttribute("aria-checked", String(on));
    if (on && changed) c.rig.setEmotion("happy");
    if (!on) c.rig.setEmotion("neutral");
  }
  ($("size") as HTMLInputElement).value = String(s.size);
  $("size-out").textContent = `${s.size} px`;
  $("start").hidden = s.onboarded;
  $("pick-h").textContent = s.onboarded ? "Your Ember" : "Choose your Ember";
}

$("size").addEventListener("input", e => {
  const v = Number((e.target as HTMLInputElement).value);
  $("size-out").textContent = `${v} px`;
  void window.ember.updateSettings({ size: v });
});
$("start").addEventListener("click", () => { void window.ember.updateSettings({ onboarded: true }); });

function render(status: Status): void {
  const failing = status.environment.checks.filter(c => c.status === "fail").length;
  $("tagline").textContent = failing
    ? "Ember needs a couple of things fixed before it can work on this machine."
    : status.settings.onboarded
      ? "Ember is beside your cursor. Pick a different look or size any time."
      : "Pick who keeps you company, then press Start.";

  $("checks").replaceChildren(...status.environment.checks.map(c => {
    const li = document.createElement("li");
    const pill = document.createElement("span");
    pill.className = `pill ${c.status}`;
    pill.textContent = c.status === "ok" ? "OK" : c.status === "warn" ? "Check" : "Fix";
    const label = document.createElement("span");
    label.className = "check-label";
    label.textContent = c.label;
    const detail = document.createElement("span");
    detail.className = "check-detail";
    detail.textContent = c.detail;
    li.append(pill, label, detail);
    return li;
  }));

  const v = status.environment.versions;
  const facts: [string, string][] = [
    ["Ember", status.appVersion],
    ["Electron", `${v.electron ?? "?"} (Chromium ${v.chrome ?? "?"}, Node ${v.node})`],
    ["Settings", "~/.config/ember/settings.json"],
    ["Log file", status.logFile],
  ];
  $("facts").replaceChildren(...facts.flatMap(([k, val]) => {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = val;
    return [dt, dd];
  }));
  applySettings(status.settings);
}

// The big hero character mirrors the selection.
const heroCanvas = $("buddy") as HTMLCanvasElement;
const heroRig = new Rig();
const heroChars: Record<string, Character> = Object.fromEntries(FACTORIES.map(f => { const c = f(); return [c.id, c]; }));

let pointer = { x: 0, y: 0 };
window.addEventListener("pointermove", e => { pointer = { x: e.clientX, y: e.clientY }; });

function paint(canvas: HTMLCanvasElement, rig: Rig, character: Character, dt: number, zoom: number): void {
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth;
  if (!size) return;
  if (canvas.width !== Math.round(size * dpr)) { canvas.width = canvas.height = Math.round(size * dpr); }
  const r = canvas.getBoundingClientRect();
  const dx = pointer.x - (r.left + size / 2), dy = pointer.y - (r.top + size / 2);
  const d = Math.max(160, Math.hypot(dx, dy));
  rig.lookAt(dx / d * 1.4, dy / d * 1.4);
  const pose = rig.update(dt);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  ctx.translate(size / 2, size * 0.58);
  ctx.scale(size / zoom, size / zoom);
  character.draw(ctx, pose);
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.05));
  last = now;
  paint(heroCanvas, heroRig, heroChars[settings?.character ?? "cinder"], dt, 170);
  for (const c of cards) paint(c.canvas, c.rig, c.character, dt, 175);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

void window.ember.getStatus().then(render);
window.ember.onSettingsChanged(applySettings);
