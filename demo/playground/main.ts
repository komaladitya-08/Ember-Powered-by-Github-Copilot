/**
 * Ember playground: drives the real overlay renderer (src/overlay/ember) over a
 * simulated GNOME desktop, with two scripted tasks that mimic what the Copilot
 * SDK session will stream: listening → thinking → acting/guiding → done.
 */

import {
  EmberFlame, ReasoningBubble, Spring2D, arcFlight, FOLLOW_OFFSET, MOODS, MOOD_LABEL,
  type Mood, type Point, type Rect,
} from "../../src/overlay/ember";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const stage = $("stage");
const osCursor = $("os-cursor");
const keycaps = $("keycaps");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const flame = new EmberFlame($<HTMLCanvasElement>("flame"), { reducedMotion: reduced });
const bubble = new ReasoningBubble($("bubble-host"));

// ---------- geometry ----------

let size = { width: 0, height: 0 };
function resize(): void {
  const r = stage.getBoundingClientRect();
  size = { width: r.width, height: r.height };
  flame.resize(r.width, r.height);
}
resize();
new ResizeObserver(resize).observe(stage);

const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const center = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
function rectOf(el: Element): Rect {
  const s = stage.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: r.left - s.left, y: r.top - s.top, width: r.width, height: r.height };
}
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// ---------- cursor, follow and flight ----------

const cursor: Point = { x: size.width * 0.62, y: size.height * 0.46 };
let userPointer: Point = { ...cursor };
let agentHasCursor = false;
let mode: "follow" | "flying" | "parked" = "follow";
let parkedAt: Point = { x: 0, y: 0 };
let highlightEl: Element | null = null;
const spring = new Spring2D(add(cursor, FOLLOW_OFFSET));
flame.setAnchor(add(cursor, FOLLOW_OFFSET));

function pointerToStage(e: PointerEvent): Point {
  const s = stage.getBoundingClientRect();
  return { x: e.clientX - s.left, y: e.clientY - s.top };
}
function onPointer(e: PointerEvent): void {
  userPointer = pointerToStage(e);
  if (!agentHasCursor) Object.assign(cursor, userPointer);
}
stage.addEventListener("pointermove", onPointer);
stage.addEventListener("pointerdown", onPointer);

function releaseCursor(): void {
  agentHasCursor = false;
  Object.assign(cursor, userPointer);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const id = setTimeout(resolve, reduced ? ms * 0.6 : ms);
    signal.addEventListener("abort", () => { clearTimeout(id); reject(signal.reason); }, { once: true });
  });
}

function animate(seconds: number, onFrame: (t: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const step = (now: number) => {
      if (signal.aborted) return reject(signal.reason);
      const t = Math.min((now - t0) / (seconds * 1000), 1);
      onFrame(t);
      if (t < 1) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });
}

/** A slightly curved, human-looking path for the OS cursor (ghost-cursor stands in for this in the app). */
function humanPath(a: Point, b: Point): (t: number) => Point {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const n = { x: -dy / len, y: dx / len };
  const c1 = { x: a.x + dx * 0.3 + n.x * len * rand(-0.14, 0.14), y: a.y + dy * 0.3 + n.y * len * rand(-0.14, 0.14) };
  const c2 = { x: a.x + dx * 0.78 + n.x * len * rand(-0.06, 0.06), y: a.y + dy * 0.78 + n.y * len * rand(-0.06, 0.06) };
  return t => {
    const u = 1 - t;
    return {
      x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
    };
  };
}

/**
 * Fly Ember to a point. With the cursor: Ember leads and the OS cursor follows
 * on a human path, landing on `to`. Without: Ember parks at `to` (guide mode).
 */
async function flyTo(to: Point, withCursor: boolean, signal: AbortSignal): Promise<void> {
  mode = "flying";
  const flameTo = withCursor ? add(to, FOLLOW_OFFSET) : to;
  const flight = arcFlight({ ...flame.anchor }, flameTo, reduced ? 2.5 : 1);
  const path = humanPath({ ...cursor }, to);
  const lag = 0.1;
  await animate(flight.duration / (1 - lag), t => {
    flame.setAnchor(flight.at(Math.min(t / (1 - lag), 1)));
    if (withCursor) Object.assign(cursor, path(easeInOut(Math.max(0, (t - lag) / (1 - lag)))));
  }, signal);
  spring.jump(flame.anchor);
  parkedAt = flameTo;
  mode = withCursor ? "follow" : "parked";
}

async function click(el: Element, why: string, effect: () => void, signal: AbortSignal): Promise<void> {
  bubble.setStep(why);
  const r = rectOf(el);
  const target = { x: center(r).x + rand(-r.width * 0.12, r.width * 0.12), y: center(r).y + rand(-r.height * 0.15, r.height * 0.15) };
  await flyTo(target, true, signal);
  await sleep(140, signal);
  osCursor.classList.add("is-pressed");
  el.classList.add("is-pressed");
  flame.burst({ ...cursor }, 0.7);
  await sleep(130, signal);
  osCursor.classList.remove("is-pressed");
  el.classList.remove("is-pressed");
  effect();
  await sleep(380, signal);
}

function showKey(label: string): void {
  const k = document.createElement("span");
  k.className = "keycap";
  k.textContent = label;
  keycaps.appendChild(k);
  setTimeout(() => k.remove(), 1000);
}

async function typeText(text: string, onChar: (ch: string) => void, signal: AbortSignal): Promise<void> {
  for (const ch of text) {
    showKey(ch.toUpperCase());
    onChar(ch);
    await sleep(rand(80, 150), signal);
  }
}

/** Stream text into the bubble the way assistant.reasoning_delta arrives. */
async function stream(text: string, signal: AbortSignal, wordsPerSecond = 9): Promise<void> {
  bubble.setThought("");
  bubble.setStreaming(true);
  try {
    for (const part of text.split(/(?<=\s)/)) {
      bubble.appendThought(part);
      await sleep(1000 / wordsPerSecond + rand(-30, 40), signal);
    }
  } finally {
    bubble.setStreaming(false);
  }
}

function waitForClick(el: Element, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { el.removeEventListener("click", done); resolve(); };
    el.addEventListener("click", done);
    signal.addEventListener("abort", () => { el.removeEventListener("click", done); reject(signal.reason); }, { once: true });
  });
}

/** Guide mode: park beside the element, ring it with fire, wait for the user's click. */
async function point(el: HTMLElement, title: string, thought: string, signal: AbortSignal): Promise<void> {
  bubble.setTitle(title);
  bubble.setThought(thought);
  bubble.setStep("Waiting for your click");
  const r = rectOf(el);
  const right = r.x + r.width + 40 < size.width;
  const spot = { x: right ? r.x + r.width + 18 : r.x - 18, y: r.y + r.height / 2 + 10 };
  highlightEl = el;
  await flyTo(spot, false, signal);
  await waitForClick(el, signal);
  highlightEl = null;
  flame.setHighlight(null);
  flame.burst(center(rectOf(el)), 0.6);
  await sleep(250, signal);
}

// ---------- the simulated desktop ----------

const overview = $("overview");
const query = $("ov-query");
const settingsWin = $("win-settings");
const nightSwitch = $("t-nightlight");

const desktop = {
  reset() {
    overview.hidden = true;
    query.textContent = "";
    overview.querySelectorAll(".ov-app").forEach(a => a.classList.remove("is-dim", "is-match"));
    settingsWin.hidden = true;
    this.panel("wifi");
    this.nightLight(false);
  },
  openOverview() { overview.hidden = false; },
  closeOverview() { overview.hidden = true; },
  type(ch: string) {
    query.textContent += ch;
    const q = query.textContent!.toLowerCase();
    overview.querySelectorAll<HTMLElement>(".ov-app").forEach(a => {
      const hit = a.textContent!.trim().toLowerCase().startsWith(q);
      a.classList.toggle("is-dim", !hit);
      a.classList.toggle("is-match", hit);
    });
  },
  openSettings() { settingsWin.hidden = false; },
  panel(name: "wifi" | "displays") {
    $("panel-wifi").hidden = name !== "wifi";
    $("panel-displays").hidden = name !== "displays";
    settingsWin.querySelectorAll(".set-side button").forEach(b =>
      b.setAttribute("aria-current", String(b.textContent === (name === "wifi" ? "Wi-Fi" : "Displays"))));
  },
  nightLight(on: boolean) {
    nightSwitch.setAttribute("aria-checked", String(on));
    stage.dataset.nightlight = on ? "on" : "off";
  },
};

// The fake desktop also works by hand, so guide mode can follow the user.
$("t-activities").addEventListener("click", () => (overview.hidden ? desktop.openOverview() : desktop.closeOverview()));
$("t-settings").addEventListener("click", () => { desktop.closeOverview(); desktop.openSettings(); });
$("t-displays").addEventListener("click", () => desktop.panel("displays"));
nightSwitch.addEventListener("click", () => desktop.nightLight(nightSwitch.getAttribute("aria-checked") !== "true"));

// ---------- moods ----------

interface Sample { title: string; thought: string; step?: string; trigger: string; meaning: string }
const SAMPLES: Record<Mood, Sample> = {
  idle: {
    title: "Hold Ctrl+Space and ask", thought: "I can do it for you, or show you where to click.",
    meaning: "Resting beside your cursor, ready for a request.", trigger: "no turn running",
  },
  listening: {
    title: "Listening…", thought: "“Rename these trip photos by date”",
    meaning: "Push-to-talk is held. Rings pulse with your voice.", trigger: "push-to-talk key down",
  },
  thinking: {
    title: "Planning the steps", thought: "The photos are in ~/Pictures/Trip. Files can rename a selection in one go, so I'll select them all first.",
    meaning: "The model is reasoning. Its thoughts stream into the bubble.", trigger: "assistant.reasoning_delta",
  },
  acting: {
    title: "Renaming photos", thought: "", step: "Press Ctrl+A to select all 24 photos",
    meaning: "Moving the real cursor and typing. Each step says why.", trigger: "tool.execution_start",
  },
  guiding: {
    title: "Click Rename…", thought: "It's in the right-click menu.", step: "Waiting for your click",
    meaning: "Pointing at the next thing for you to click, ringed with fire.", trigger: "point_at tool",
  },
  attention: {
    title: "Delete 3 duplicates?", thought: "These are identical copies. Deleting moves them to Trash.",
    meaning: "Waiting for your decision before a risky step.", trigger: "onPreToolUse → ask",
  },
  error: {
    title: "I couldn't find Rename", thought: "This version of Files keeps it in another menu. Can you show me where it is?",
    meaning: "A step failed. The flame gutters and smokes.", trigger: "tool.execution_complete (failed)",
  },
  done: {
    title: "Renamed 24 photos", thought: "They're now named 2026-10-03_001.jpg onward.",
    meaning: "Task finished. A short flare, then back to rest.", trigger: "session.idle after a successful turn",
  },
};

const moodOrder = Object.keys(MOODS) as Mood[];
const chips = $("mood-chips");
const swatch = (m: Mood) =>
  `<i class="swatch" style="background:radial-gradient(circle at 45% 40%, ${MOODS[m].ramp[1]}, ${MOODS[m].ramp[3]} 70%);box-shadow:0 0 8px ${MOODS[m].glow}"></i>`;

for (const m of moodOrder) {
  const b = document.createElement("button");
  b.type = "button";
  b.setAttribute("role", "radio");
  b.dataset.mood = m;
  b.innerHTML = `${swatch(m)}${MOOD_LABEL[m]}`;
  b.addEventListener("click", () => { stopRun(); previewMood(m); });
  chips.appendChild(b);
}

$("mood-list").innerHTML = moodOrder.map(m => `
  <div class="mood-item">
    ${swatch(m)}
    <dt>${MOOD_LABEL[m]}</dt>
    <dd>${SAMPLES[m].meaning}</dd>
    <dd class="trigger">${SAMPLES[m].trigger}</dd>
  </div>`).join("");

function setMood(m: Mood): void {
  flame.setMood(m);
  bubble.setMood(m);
  chips.querySelectorAll("button").forEach(b => b.setAttribute("aria-checked", String(b.dataset.mood === m)));
}

function previewMood(m: Mood): void {
  const s = SAMPLES[m];
  setMood(m);
  bubble.setTitle(s.title);
  bubble.setThought(s.thought);
  bubble.setStep(s.step ?? null);
  bubble.setActions(m === "attention"
    ? [{ label: "Delete", primary: true, onClick: () => previewMood("done") }, { label: "Not now", onClick: () => previewMood("idle") }]
    : null);
}

// ---------- scripted tasks ----------

let run: AbortController | null = null;

function stopRun(): void {
  run?.abort(new DOMException("stopped", "AbortError"));
  run = null;
  releaseCursor();
  highlightEl = null;
  flame.setHighlight(null);
  mode = "follow";
  bubble.setActions(null);
}

async function start(script: (signal: AbortSignal) => Promise<void>): Promise<void> {
  stopRun();
  desktop.reset();
  const ctrl = new AbortController();
  run = ctrl;
  try {
    await script(ctrl.signal);
  } catch (e) {
    if ((e as Error)?.name !== "AbortError") { console.error(e); previewMood("error"); }
  } finally {
    if (run === ctrl) { run = null; releaseCursor(); mode = "follow"; }
  }
}

async function listen(transcript: string, signal: AbortSignal): Promise<void> {
  setMood("listening");
  bubble.setTitle("Listening…");
  bubble.setStep(null);
  bubble.setActions(null);
  await stream(transcript, signal, 4.5);
  await sleep(350, signal);
}

async function doIt(signal: AbortSignal): Promise<void> {
  await listen("“Turn on Night Light.”", signal);

  setMood("thinking");
  bubble.setTitle("Planning the steps");
  await stream("Night Light lives in Settings, under Displays. Settings isn't open, so I'll find it through Activities search.", signal);
  await sleep(400, signal);

  setMood("acting");
  agentHasCursor = true;
  bubble.setTitle("Opening Settings");
  bubble.setThought("");
  await click($("t-activities"), "Click Activities, where app search lives", () => desktop.openOverview(), signal);
  bubble.setStep("Type “settings” to find the app");
  await typeText("settings", ch => desktop.type(ch), signal);
  await sleep(250, signal);
  bubble.setStep("Press Enter to open the top result");
  showKey("ENTER");
  await sleep(300, signal);
  desktop.closeOverview();
  desktop.openSettings();
  await sleep(500, signal);

  setMood("thinking");
  bubble.setTitle("Finding Displays");
  bubble.setStep(null);
  await stream("Settings opened on Wi-Fi. Displays is in the sidebar.", signal);

  setMood("acting");
  bubble.setTitle("Turning on Night Light");
  bubble.setThought("");
  await click($("t-displays"), "Click Displays in the sidebar", () => desktop.panel("displays"), signal);
  await click(nightSwitch, "Switch on Night Light", () => desktop.nightLight(true), signal);
  releaseCursor();

  setMood("done");
  bubble.setTitle("Night Light is on");
  bubble.setStep(null);
  bubble.setThought("Your screen will warm up from sunset to sunrise. Want a different schedule?");
  await sleep(4500, signal);
  setMood("idle");
  bubble.setTitle("Anything else?");
}

async function guide(signal: AbortSignal): Promise<void> {
  await listen("“How do I turn on Night Light?”", signal);

  setMood("thinking");
  bubble.setTitle("Planning the steps");
  await stream("You'd like to learn it, so I'll point and you click. It's in Settings, under Displays.", signal);
  await sleep(400, signal);

  setMood("guiding");
  await point($("t-activities"), "Click Activities", "App search lives here.", signal);
  await sleep(300, signal);
  await point($("t-settings"), "Click Settings", "You can also type “settings” to find it.", signal);
  await sleep(300, signal);
  await point($("t-displays"), "Click Displays", "Night Light is a display setting.", signal);
  await sleep(200, signal);
  await point(nightSwitch, "Switch on Night Light", "", signal);
  mode = "follow";

  setMood("done");
  bubble.setTitle("You did it");
  bubble.setStep(null);
  bubble.setThought("Night Light is on. Next time you can just ask me to do it.");
  await sleep(4500, signal);
  setMood("idle");
  bubble.setTitle("Anything else?");
}

$("run-do").addEventListener("click", () => start(doIt));
$("run-guide").addEventListener("click", () => start(guide));
$("run-reset").addEventListener("click", () => { stopRun(); desktop.reset(); previewMood("idle"); });

document.querySelectorAll<HTMLButtonElement>(".seg button").forEach(b =>
  b.addEventListener("click", () => {
    stage.dataset.appTheme = b.dataset.app!;
    document.querySelectorAll(".seg button").forEach(o => o.setAttribute("aria-checked", String(o === b)));
  }));

// ---------- frame loop ----------

let last = performance.now();
function tick(now: number): void {
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.05));
  last = now;
  if (mode === "follow") flame.setAnchor(spring.step(add(cursor, FOLLOW_OFFSET), dt));
  else if (mode === "parked") flame.setAnchor(spring.step(parkedAt, dt));
  if (flame.getMood() === "listening") {
    const t = now / 1000;
    flame.setLevel(0.35 + 0.3 * Math.sin(t * 7.3) * Math.sin(t * 2.1) + 0.2 * Math.sin(t * 13.7));
  } else {
    flame.setLevel(0);
  }
  if (highlightEl) {
    const r = rectOf(highlightEl);
    flame.setHighlight({ x: r.x - 4, y: r.y - 4, width: r.width + 8, height: r.height + 8 });
  }
  flame.frame(dt);
  bubble.place(flame.anchor, size);
  osCursor.style.transform = `translate(${cursor.x}px, ${cursor.y}px)`;
  requestAnimationFrame(tick);
}

previewMood("idle");
requestAnimationFrame(tick);
