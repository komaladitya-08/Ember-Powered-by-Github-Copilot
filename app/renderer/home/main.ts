/** Home window (M0): live character, setup checks, build facts. */

import { Rig, FACTORIES, type Character } from "@ember/characters";
import type { EmberHomeApi, Status } from "../../shared/ipc";

declare global {
  interface Window { ember: EmberHomeApi }
}

const $ = (id: string) => document.getElementById(id)!;
const characters: Record<string, Character> = Object.fromEntries(FACTORIES.map(f => { const c = f(); return [c.id, c]; }));
let current: Character = characters.cinder;
const rig = new Rig();

function render(status: Status): void {
  const failing = status.environment.checks.filter(c => c.status === "fail").length;
  $("tagline").textContent = failing
    ? "Ember needs a couple of things fixed before it can work on this machine."
    : "Ember is running. Its overlay, voice and Copilot connection arrive in the next milestones.";
  rig.setEmotion(failing ? "worried" : "happy");
  setTimeout(() => rig.setEmotion("neutral"), 2500);

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
    ["Character", status.settings.character],
    ["Log file", status.logFile],
  ];
  $("facts").replaceChildren(...facts.flatMap(([k, val]) => {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = val;
    return [dt, dd];
  }));
  current = characters[status.settings.character] ?? characters.cinder;
}

const canvas = $("buddy") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
let pointer = { x: 0, y: 0 };
window.addEventListener("pointermove", e => { pointer = { x: e.clientX, y: e.clientY }; });

let last = performance.now();
function frame(now: number): void {
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.05));
  last = now;
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth;
  if (canvas.width !== Math.round(size * dpr)) { canvas.width = canvas.height = Math.round(size * dpr); }
  const r = canvas.getBoundingClientRect();
  const dx = pointer.x - (r.left + size / 2), dy = pointer.y - (r.top + size / 2);
  const d = Math.max(160, Math.hypot(dx, dy));
  rig.lookAt(dx / d * 1.4, dy / d * 1.4);
  const pose = rig.update(dt);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(size / 2, size * 0.56);
  ctx.scale(size / 170, size / 170);
  current.draw(ctx, pose);
  ctx.restore();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

void window.ember.getStatus().then(render);
window.ember.onSettingsChanged(s => { current = characters[s.character] ?? current; });
