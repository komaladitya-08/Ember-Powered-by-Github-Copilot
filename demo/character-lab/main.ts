/**
 * Character lab: four bodies, one rig. The gallery shows every direction at
 * portrait and real size; the scene shows the chosen one leaving your cursor
 * to work in a background window while "you" keep typing.
 */

import { Rig, PRESETS, FACTORIES, type Emotion, type Gesture, type Character } from "@ember/characters";
import { ReasoningBubble, type BubbleMood } from "@ember/bubble";
import { arcFlight, Spring2D } from "@ember/motion";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const EMOTIONS = Object.keys(PRESETS) as Emotion[];

/** Size a canvas's backing store to its CSS box; returns its CSS size. */
function fit(canvas: HTMLCanvasElement): { w: number; h: number } {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  canvas.getContext("2d")!.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

function drawCursor(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(0, 17); ctx.lineTo(4, 13); ctx.lineTo(7, 19); ctx.lineTo(9.5, 18); ctx.lineTo(7, 12); ctx.lineTo(12, 12);
  ctx.closePath();
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.strokeStyle = "#111";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.restore();
}

// ─────────────────────────── gallery ───────────────────────────

interface Card {
  rig: Rig;
  hero: Character;
  small: [Character, Character];
  heroCanvas: HTMLCanvasElement;
  strip: HTMLCanvasElement;
  el: HTMLElement;
  pickBtn: HTMLButtonElement;
  visible: boolean;
}

const gallery = $("gallery");
const cards: Card[] = FACTORIES.map(make => {
  const hero = make();
  const el = document.createElement("article");
  el.className = "card";
  el.innerHTML = `
    <div class="portrait"><canvas aria-label="${hero.name}, animated"></canvas></div>
    <h3>${hero.name}</h3>
    <p>${hero.pitch}</p>
    <div class="real"><span class="label">At real size, over light and dark apps</span><div class="real-strip"><canvas aria-hidden="true"></canvas></div></div>
    <button class="btn" type="button" aria-pressed="false">Use in the scene</button>`;
  gallery.appendChild(el);
  const [heroCanvas, strip] = Array.from(el.querySelectorAll("canvas"));
  const rig = new Rig();
  const card: Card = { rig, hero, small: [make(), make()], heroCanvas, strip, el, pickBtn: el.querySelector("button")!, visible: true };
  card.pickBtn.addEventListener("click", () => pick(hero.id));
  return card;
});

const io = new IntersectionObserver(entries => {
  for (const e of entries) {
    const c = cards.find(c => c.el === e.target);
    if (c) c.visible = e.isIntersecting;
  }
});
cards.forEach(c => io.observe(c.el));

let pointer: { x: number; y: number } | null = null;
window.addEventListener("pointermove", e => { pointer = { x: e.clientX, y: e.clientY }; });

// Feelings bar
const chips = $("feel-chips");
const when = $("feel-when");
for (const e of EMOTIONS) {
  const b = document.createElement("button");
  b.type = "button";
  b.setAttribute("role", "radio");
  b.dataset.emotion = e;
  b.textContent = PRESETS[e].label;
  b.addEventListener("click", () => setFeeling(e));
  chips.appendChild(b);
}
function setFeeling(e: Emotion): void {
  chips.querySelectorAll("button").forEach(b => b.setAttribute("aria-checked", String(b.dataset.emotion === e)));
  when.innerHTML = `<b>${PRESETS[e].label}:</b> ${PRESETS[e].when}`;
  cards.forEach((c, i) => setTimeout(() => c.rig.setEmotion(e), i * 70));
}
const talkOpt = $<HTMLInputElement>("opt-talk");
const aliveOpt = $<HTMLInputElement>("opt-alive");
talkOpt.addEventListener("change", () => cards.forEach(c => c.rig.setTalking(talkOpt.checked)));
aliveOpt.addEventListener("change", () => cards.forEach(c => { c.rig.alive = aliveOpt.checked; }));
setFeeling("neutral");

$("map-list").innerHTML = EMOTIONS.map(e => `<div><dt>${PRESETS[e].label}</dt><dd>${PRESETS[e].when}</dd></div>`).join("");

function drawGallery(dt: number): void {
  for (const c of cards) {
    if (!c.visible) { c.rig.update(dt); continue; }
    const { w, h } = fit(c.heroCanvas);
    const rect = c.heroCanvas.getBoundingClientRect();
    const cx = w / 2, cy = h * 0.56;
    if (pointer) {
      const dx = pointer.x - (rect.left + cx), dy = pointer.y - (rect.top + cy);
      const d = Math.max(200, Math.hypot(dx, dy));
      c.rig.lookAt((dx / d) * 1.4, (dy / d) * 1.4);
      if (c.rig.emotion === "curious") c.rig.setAim({ x: dx, y: dy });
    }
    if (c.rig.emotion !== "curious") c.rig.setAim(null);
    const pose = c.rig.update(dt);
    const ctx = c.heroCanvas.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(cx, cy);
    const s = Math.min(w, h) / 165;
    ctx.scale(s, s);
    c.hero.draw(ctx, pose);
    ctx.restore();

    // Real-size strip: light app on the left, dark app on the right.
    const st = fit(c.strip);
    const sc = c.strip.getContext("2d")!;
    sc.fillStyle = "#f6f5f4"; sc.fillRect(0, 0, st.w / 2, st.h);
    sc.fillStyle = "#242424"; sc.fillRect(st.w / 2, 0, st.w / 2, st.h);
    for (let i = 0; i < 4; i++) {
      sc.fillStyle = "#d4d0cc"; sc.fillRect(10, 12 + i * 13, st.w / 2 - 24 - (i % 2) * 30, 5);
      sc.fillStyle = "#3a3a3a"; sc.fillRect(st.w / 2 + 10, 12 + i * 13, st.w / 2 - 24 - ((i + 1) % 2) * 30, 5);
    }
    c.small.forEach((ch, i) => {
      const x0 = i ? st.w * 0.75 : st.w * 0.25;
      drawCursor(sc, x0 - 30, st.h * 0.5 - 18);
      sc.save();
      sc.translate(x0 + 4, st.h * 0.56);
      const k = 48 / 100;
      sc.scale(k, k);
      ch.draw(sc, pose);
      sc.restore();
    });
  }
}

// ─────────────────────────── scene ───────────────────────────

const stage = $("stage");
const sceneCanvas = $<HTMLCanvasElement>("scene-canvas");
const userCursorEl = $("user-cursor");
const statusPill = $("status-pill");
const statusText = $("status-text");
const voice = $("voice");
const voiceText = $("voice-text");
const typed = $("typed");
const settings = $("win-settings");
const bubble = new ReasoningBubble($("scene-bubble"));

const sceneChars: Record<string, Character> = Object.fromEntries(FACTORIES.map(f => { const c = f(); return [c.id, c]; }));
let sceneChar = sceneChars.cinder;
const sceneRig = new Rig();
let emberSize = 60;
let stageSize = { w: 0, h: 0 };
let sceneVisible = true;
new IntersectionObserver(([e]) => { sceneVisible = e.isIntersecting; }).observe(stage);

function pick(id: string): void {
  sceneChar = sceneChars[id];
  cards.forEach(c => {
    const on = c.hero.id === id;
    c.el.classList.toggle("is-picked", on);
    c.pickBtn.setAttribute("aria-pressed", String(on));
    c.pickBtn.textContent = on ? "In the scene" : "Use in the scene";
  });
  $("who").querySelectorAll("button").forEach(b => b.setAttribute("aria-checked", String(b.dataset.id === id)));
}
const who = $("who");
for (const c of Object.values(sceneChars)) {
  const b = document.createElement("button");
  b.type = "button";
  b.setAttribute("role", "radio");
  b.dataset.id = c.id;
  b.textContent = c.name;
  b.addEventListener("click", () => pick(c.id));
  who.appendChild(b);
}
pick("cinder");

const sizeInput = $<HTMLInputElement>("size");
sizeInput.addEventListener("input", () => {
  emberSize = Number(sizeInput.value);
  $("size-out").textContent = `${emberSize} px`;
});

const userCursor = { x: 0, y: 0 };
let userControlled = false;
stage.addEventListener("pointermove", e => {
  const r = stage.getBoundingClientRect();
  userCursor.x = e.clientX - r.left;
  userCursor.y = e.clientY - r.top;
  userControlled = true;
});
stage.addEventListener("pointerleave", () => { userControlled = false; });

const followOffset = () => ({ x: emberSize * 0.62, y: emberSize * 0.72 });
const spring = new Spring2D({ x: 0, y: 0 }, 150, 20);
const ember = { x: 0, y: 0 };
let mode: "follow" | "fly" | "park" = "follow";
let park = { x: 0, y: 0 };

function rectInStage(el: Element): { x: number; y: number; w: number; h: number } {
  const s = stage.getBoundingClientRect(), r = el.getBoundingClientRect();
  return { x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const id = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(id); reject(signal.reason); }, { once: true });
  });
}

function flyTo(to: { x: number; y: number }, signal: AbortSignal): Promise<void> {
  mode = "fly";
  const flight = arcFlight({ ...ember }, to, reduced ? 2.5 : 1);
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const step = (now: number) => {
      if (signal.aborted) return reject(signal.reason);
      const k = Math.min((now - t0) / (flight.duration * 1000), 1);
      const p = flight.at(k);
      ember.x = p.x; ember.y = p.y;
      if (k < 1) requestAnimationFrame(step);
      else { park = { ...to }; spring.jump(ember); mode = "park"; resolve(); }
    };
    requestAnimationFrame(step);
  });
}

const MOOD_OF: Partial<Record<Emotion, BubbleMood>> = {
  neutral: "idle", happy: "idle", listening: "listening", thinking: "thinking", focused: "acting",
  curious: "guiding", worried: "attention", sad: "error", proud: "done", surprised: "listening",
};
function feel(e: Emotion, gesture?: Gesture): void {
  sceneRig.setEmotion(e, gesture ? { gesture } : {});
  bubble.setMood(MOOD_OF[e] ?? "idle");
}

async function say(title: string, thought: string, signal: AbortSignal, talkMs = 900): Promise<void> {
  bubble.setVisible(true);
  bubble.setTitle(title);
  bubble.setThought(thought);
  sceneRig.setTalking(true);
  await sleep(talkMs, signal);
  sceneRig.setTalking(false);
}

async function stream(text: string, signal: AbortSignal): Promise<void> {
  bubble.setThought("");
  bubble.setStreaming(true);
  for (const part of text.split(/(?<=\s)/)) {
    bubble.appendThought(part);
    await sleep(95, signal);
  }
  bubble.setStreaming(false);
}

// "You" keep typing in the editor the whole time Ember works.
const PLAN = "Q4 plan\n\n1. AT-SPI sidecar on RHEL 8.4\n2. Wake word: \"Hey Ember\"\n3. Background actions, no cursor theft\n4. Wayland via a Shell extension\n\nNotes: keep Ember out of the way while I write. ";
let typing = false;
let typedIdx = 0;
let typeClock = 0;

function selectPanel(name: string): void {
  settings.querySelectorAll<HTMLElement>(".panel").forEach(p => { p.hidden = p.dataset.panel !== name; });
  settings.querySelectorAll<HTMLElement>(".set-side span").forEach(s => s.classList.toggle("is-current", s.dataset.panel === name));
}
function setSwitch(id: string, on: boolean): void {
  $(id).setAttribute("aria-checked", String(on));
  if (id === "s-night") stage.dataset.nightlight = on ? "on" : "off";
}

/** Ember parks beside an element in the background window and presses it. */
async function touch(el: HTMLElement, step: string, effect: () => void, signal: AbortSignal): Promise<void> {
  bubble.setStep(step);
  const r = rectInStage(el);
  const spot = { x: r.x - emberSize * 0.55, y: r.y + r.h / 2 - emberSize * 0.15 };
  await flyTo(spot, signal);
  sceneRig.setAim({ x: 1, y: 0.25 });
  sceneRig.setGesture("tap");
  el.classList.add("is-touched");
  await sleep(320, signal);
  sceneRig.hop(0.35);
  park = { x: spot.x + emberSize * 0.12, y: spot.y };
  await sleep(140, signal);
  effect();
  park = spot;
  await sleep(380, signal);
  el.classList.remove("is-touched");
  sceneRig.setGesture("type");
  sceneRig.setAim(null);
}

let run: AbortController | null = null;

function resetScene(): void {
  selectPanel("wifi");
  setSwitch("s-night", false);
  setSwitch("s-dnd", false);
  settings.classList.remove("is-ember");
  statusPill.hidden = true;
  voice.hidden = true;
  bubble.setStep(null);
  bubble.setActions(null);
  mode = "follow";
  feel("neutral");
  bubble.setTitle("Say “Hey Ember”");
  bubble.setThought("I'm listening for my name.");
}

async function story(signal: AbortSignal): Promise<void> {
  resetScene();
  typing = true;
  await sleep(2600, signal);

  // Wake word
  typing = false;
  voice.hidden = false;
  voiceText.textContent = "Hey Ember,";
  feel("surprised");
  await sleep(700, signal);
  feel("listening");
  bubble.setTitle("Listening…");
  bubble.setThought("");
  const ask = " turn on Night Light and mute notifications.";
  for (const w of ask.split(/(?<=\s)/)) {
    voiceText.textContent += w;
    await sleep(170, signal);
  }
  await sleep(500, signal);
  voice.hidden = true;

  feel("thinking");
  bubble.setTitle("Planning");
  await stream("Both live in Settings. It's open behind your editor, so I'll work there and leave your cursor alone.", signal);
  await sleep(300, signal);
  feel("happy");
  await say("On it. Keep typing!", "", signal);

  // Detach and work in the background window
  typing = true;
  feel("focused", "type");
  settings.classList.add("is-ember");
  statusPill.hidden = false;
  statusText.textContent = "Ember is working in Settings · 1 of 2";
  bubble.setTitle("Night Light");
  await touch($("s-displays"), "Open Displays", () => selectPanel("displays"), signal);
  await touch($("s-night"), "Switch on Night Light", () => setSwitch("s-night", true), signal);
  statusText.textContent = "Ember is working in Settings · 2 of 2";
  bubble.setTitle("Notifications");
  await touch($("s-notif"), "Open Notifications", () => selectPanel("notifications"), signal);
  await touch($("s-dnd"), "Turn on Do Not Disturb", () => setSwitch("s-dnd", true), signal);
  settings.classList.remove("is-ember");
  statusPill.hidden = true;
  bubble.setStep(null);

  // Come home
  mode = "follow";
  await sleep(700, signal);
  feel("proud");
  await say("All done", "Night Light is on and notifications are muted until you turn them back on.", signal, 1400);
  await sleep(3200, signal);
  feel("neutral");
  bubble.setTitle("Anything else?");
  bubble.setThought("Just say “Hey Ember”.");
  await sleep(3500, signal);
}

async function loopStory(): Promise<void> {
  run?.abort();
  const ctrl = new AbortController();
  run = ctrl;
  try {
    while (!ctrl.signal.aborted) await story(ctrl.signal);
  } catch {
    /* aborted */
  }
}
$("replay").addEventListener("click", () => { loopStory(); });

function drawScene(dt: number): void {
  const r = stage.getBoundingClientRect();
  stageSize = { w: r.width, h: r.height };

  // The simulated user: types in the editor unless you move the mouse yourself.
  if (typing) {
    typeClock -= dt;
    if (typeClock <= 0) {
      typedIdx = (typedIdx + 1) % (PLAN.length + 1);
      typed.textContent = PLAN.slice(0, typedIdx);
      const ch = PLAN[typedIdx - 1];
      typeClock = ch === "\n" ? 0.5 : ch === " " ? 0.12 : 0.06 + Math.random() * 0.07;
    }
  }
  if (!userControlled) {
    const ed = rectInStage($("win-editor"));
    userCursor.x = ed.x + ed.w * 0.62 + Math.sin(performance.now() / 1300) * 6;
    userCursor.y = ed.y + ed.h * 0.6 + Math.cos(performance.now() / 1700) * 4;
  }
  userCursorEl.style.transform = `translate(${userCursor.x}px, ${userCursor.y}px)`;

  if (mode === "follow") {
    const off = followOffset();
    const p = spring.step({ x: userCursor.x + off.x, y: userCursor.y + off.y }, dt);
    ember.x = p.x; ember.y = p.y;
  } else if (mode === "park") {
    const p = spring.step(park, dt);
    ember.x = p.x; ember.y = p.y;
  }

  // Ember glances at your cursor while idle, and at its work otherwise.
  if (mode === "follow") {
    const dx = userCursor.x - ember.x, dy = userCursor.y - ember.y;
    const d = Math.max(60, Math.hypot(dx, dy));
    sceneRig.lookAt(dx / d, dy / d);
  } else {
    sceneRig.lookAt(0.9, 0.25);
  }
  sceneRig.setPosition(ember.x / (emberSize / 100), ember.y / (emberSize / 100), dt);
  const pose = sceneRig.update(dt);

  if (!sceneVisible) return;
  const { w, h } = fit(sceneCanvas);
  const ctx = sceneCanvas.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(ember.x, ember.y);
  const k = emberSize / 100;
  ctx.scale(k, k);
  sceneChar.draw(ctx, pose);
  ctx.restore();
  bubble.place({ x: ember.x, y: ember.y + emberSize * 0.35 }, { width: stageSize.w, height: stageSize.h });
}

// ─────────────────────────── loop ───────────────────────────

let last = performance.now();
function frame(now: number): void {
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.05));
  last = now;
  drawGallery(dt);
  drawScene(dt);
  requestAnimationFrame(frame);
}

{
  const r = stage.getBoundingClientRect();
  const ed = rectInStage($("win-editor"));
  userCursor.x = ed.x + ed.w * 0.62;
  userCursor.y = ed.y + ed.h * 0.6;
  ember.x = userCursor.x + followOffset().x;
  ember.y = userCursor.y + followOffset().y;
  spring.jump(ember);
  stageSize = { w: r.width, h: r.height };
}
resetScene();
requestAnimationFrame(frame);
loopStory();
