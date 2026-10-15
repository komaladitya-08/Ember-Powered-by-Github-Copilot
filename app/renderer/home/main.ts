/**
 * Home window: first-run consent, pick your Ember, Copilot sign-in, the
 * conversation, voice, apps & privacy, comfort & access, what Ember did,
 * setup checks and build facts.
 */

import { Rig, FACTORIES, type Character } from "@ember/characters";
import type { ActivityEntry, VoiceStatus } from "../../shared/ipc";
import { CONSENT_VERSION } from "../../shared/consent";
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
// A radio group is one Tab stop; the arrow keys move (and choose) within it.
$("cards").addEventListener("keydown", e => {
  const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  if (!(e.key in keys) && e.key !== "Home" && e.key !== "End") return;
  e.preventDefault();
  const at = cards.findIndex(c => c.el === document.activeElement);
  const next = e.key === "Home" ? 0 : e.key === "End" ? cards.length - 1 : (Math.max(0, at) + keys[e.key] + cards.length) % cards.length;
  cards[next].el.focus();
  cards[next].el.click();
});

let settings: Settings | null = null;
function applySettings(s: Settings): void {
  const changed = settings?.character !== s.character;
  settings = s;
  for (const c of cards) {
    const on = c.id === s.character;
    c.el.setAttribute("aria-checked", String(on));
    c.el.tabIndex = on ? 0 : -1;
    if (on && changed) c.rig.setEmotion("happy");
    if (!on) c.rig.setEmotion("neutral");
  }
  const size = $("size") as HTMLInputElement;
  size.value = String(s.size);
  size.setAttribute("aria-valuetext", `${s.size} pixels`);
  ($("login") as HTMLInputElement).checked = s.startAtLogin;
  ($("reduce-motion") as HTMLInputElement).checked = s.reduceMotion;
  $("size-out").textContent = `${s.size} px`;
  // First run (or changed terms): the consent panel comes first and Start (right beside "I agree") waits for it.
  const consented = s.consent.version >= CONSENT_VERSION;
  $("welcome").hidden = consented;
  $("start-row").hidden = s.onboarded;
  $("agree-row").hidden = consented;
  ($("start") as HTMLButtonElement).disabled = !consented && !($("agree") as HTMLInputElement).checked;
  $("start-hint").hidden = consented;
  $("pick-h").textContent = s.onboarded ? "Your Ember" : "Choose your Ember";
  renderPrivacy(s);
}
$("login").addEventListener("change", e => { void window.ember.updateSettings({ startAtLogin: (e.target as HTMLInputElement).checked }); });
$("agree").addEventListener("change", e => {
  const on = (e.target as HTMLInputElement).checked;
  ($("start") as HTMLButtonElement).disabled = !on;
  $("start-hint").hidden = on;
});
$("reduce-motion").addEventListener("change", e => { void window.ember.updateSettings({ reduceMotion: (e.target as HTMLInputElement).checked }); });

$("size").addEventListener("input", e => {
  const input = e.target as HTMLInputElement;
  const v = Number(input.value);
  $("size-out").textContent = `${v} px`;
  input.setAttribute("aria-valuetext", `${v} pixels`);
  void window.ember.updateSettings({ size: v });
});
$("start").addEventListener("click", () => {
  const already = (settings?.consent.version ?? 0) >= CONSENT_VERSION;
  if (!already && !($("agree") as HTMLInputElement).checked) return;
  void window.ember.updateSettings({ ...(already ? {} : { consent: { version: CONSENT_VERSION, at: new Date().toISOString() } }), onboarded: true });
});

function renderChecks(environment: Status["environment"]): void {
  $("checks").replaceChildren(...environment.checks.map(c => {
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
    if (c.fix) {
      const fix = c.fix;
      const btn = document.createElement("button");
      btn.className = "btn quiet check-fix";
      btn.textContent = "Turn on";
      btn.addEventListener("click", () => {
        btn.disabled = true;
        window.ember.applyFix(fix).then(renderChecks, err => {
          btn.disabled = false;
          detail.textContent = `Couldn't change it: ${err instanceof Error ? err.message : String(err)}`;
        });
      });
      li.append(btn);
    }
    return li;
  }));
}

function render(status: Status): void {
  const failing = status.environment.checks.filter(c => c.status === "fail").length;
  $("tagline").textContent = failing
    ? "Ember needs a couple of things fixed before it can work on this machine."
    : status.settings.onboarded
      ? "Ember is beside your cursor. Pick a different look or size any time."
      : "Read how Ember works, pick who keeps you company, then agree and press Start.";

  renderChecks(status.environment);
  renderAdmin(status.admin);

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

// ───── Organisation policy ─────
let managed = new Set<string>();
const FEATURE_TEXT: Record<string, string> = {
  voice: "listening for “Hey Ember”", speak: "speaking out loud", actions: "acting in apps (Ember can still answer and show you how)",
  cursor: "borrowing your mouse", desk: "Ember's own desk", screenImages: "sending screenshots",
};
function renderAdmin(a: Status["admin"]): void {
  managed = new Set(a.managed);
  const el = $("managed");
  el.classList.toggle("error", !!a.error);
  if (a.error) {
    el.hidden = false;
    el.textContent = `Your organisation's Ember policy has a problem, so Ember is locked down until it's fixed (${a.error}).`;
  } else if (a.source) {
    const off = Object.entries(a.features).filter(([, v]) => v === false).map(([k]) => FEATURE_TEXT[k] ?? k);
    const rules = [
      off.length ? `Turned off: ${off.join(", ")}.` : "",
      a.confirmEveryAction ? "Ember asks before every action." : "",
      !a.allowGrants ? "“Always in this app” isn't available." : "",
      a.provider ? "Ember uses your organisation's model service." : "",
    ].filter(Boolean).join(" ");
    el.hidden = false;
    el.textContent = `Some settings are managed by your organisation (${a.source}).${rules ? ` ${rules}` : ""}`;
  } else {
    el.hidden = true;
  }
  $("retention").textContent = String(a.retentionDays);
  if (a.provider) $("model-service").textContent = `your organisation's model service (${new URL(a.provider).host})`;
  for (const [id, key] of [["wake", "wakeWord"], ["speak", "speak"], ["m-conductor", "models"], ["m-worker", "models"]] as const) {
    const input = $(id) as HTMLInputElement | HTMLSelectElement;
    input.disabled = managed.has(key);
    (input.closest("label") ?? input).classList.toggle("locked", managed.has(key));
    if (managed.has(key)) input.title = "Managed by your organisation";
  }
}

// ───── Activity timeline ─────
const time = (t: string) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const KIND: Record<string, string> = {
  click: "Click", toggle: "Switch", text: "Type into", select: "Choose in", value: "Set", setting: "Change setting", open_app: "Open",
  cursor_click: "Click (your mouse)", cursor_text: "Type (your keyboard)", keys: "Press keys", scroll: "Scroll", point: "Point at", read: "Read",
};
function describeEntry(e: ActivityEntry): { tag: string; cls: string; what: string; why?: string } | null {
  const target = [e.element ? `${e.element.name ? `“${e.element.name}” ` : ""}${e.element.role}` : e.value ? `“${e.value}”` : "", e.app ? `in ${e.app}` : ""].filter(Boolean).join(" ");
  const what = `${KIND[e.kind ?? ""] ?? e.kind ?? ""} ${target}`.trim();
  switch (e.event) {
    case "task":
      if (e.phase === "asked") return { tag: e.mode === "guide" ? "Guide" : "Task", cls: "", what: String(e.goal ?? "") };
      if (e.phase === "done") return { tag: "Finished", cls: "ok", what: String(e.summary ?? e.goal ?? "") };
      return { tag: e.phase === "cancelled" ? "Stopped" : "Failed", cls: "no", what: String(e.goal ?? ""), why: typeof e.summary === "string" ? e.summary : undefined };
    case "decision":
      if (e.verdict === "allow") return null; // the action line that follows says it
      return { tag: e.verdict === "deny" ? "Refused" : "Asked you", cls: e.verdict === "deny" ? "no" : "ask", what, why: e.reason };
    case "confirm":
      return { tag: e.answer === "once" || e.answer === "always" ? "You allowed" : e.answer === "deny" ? "You said no" : "No answer", cls: e.answer === "once" || e.answer === "always" ? "ok" : "no", what };
    case "action":
      return { tag: e.ok ? "Done" : "Didn't work", cls: e.ok ? "ok" : "no", what: `${what}${e.tier === 2 ? " (on Ember's desk)" : ""}`, why: e.error };
    case "stop":
      return { tag: "Stopped", cls: "no", what: `Everything stopped (${e.source === "hotkey" ? "Ctrl+Alt+X" : e.source === "voice" ? "“Ember, stop”" : "menu"})` };
    default:
      return null;
  }
}
const dayOf = (t: string) => new Date(t).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
let shownActivity = "";
async function refreshActivity(): Promise<void> {
  const entries = await window.ember.activity().catch(() => [] as ActivityEntry[]);
  // Unchanged: leave the list alone (a screen reader keeps its place, the scroll position stays).
  const key = JSON.stringify(entries.slice(0, 1).map(e => e.t)) + entries.length;
  if (key === shownActivity) return;
  shownActivity = key;
  let day = "";
  const items: HTMLLIElement[] = [];
  for (const e of entries) {
    const d = describeEntry(e);
    if (!d) continue;
    if (items.length >= 80) break;
    // A heading for each day: the list covers up to a month.
    if (dayOf(e.t) !== day) {
      day = dayOf(e.t);
      items.push(Object.assign(document.createElement("li"), { className: "day", textContent: day }));
    }
    const li = document.createElement("li");
    const t = Object.assign(document.createElement("time"), { textContent: time(e.t), dateTime: e.t });
    const tag = Object.assign(document.createElement("span"), { className: `tag ${d.cls}`, textContent: d.tag });
    const what = Object.assign(document.createElement("span"), { className: "what", textContent: d.what });
    if (d.why) what.append(Object.assign(document.createElement("span"), { className: "why", textContent: d.why }));
    li.append(t, tag, what);
    items.push(li);
  }
  $("activity").replaceChildren(...items);
}
void refreshActivity();
setInterval(() => { if (document.visibilityState === "visible") void refreshActivity(); }, 3000);

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

// ───── Copilot section ─────
type AgentStatus = Awaited<ReturnType<EmberHomeApi["agentStatus"]>>;
let signingIn = false;
function renderAgent(a: AgentStatus | null): void {
  if (!a) return;
  ($("agent-dot") as HTMLElement).dataset.phase = a.phase;
  $("agent-text").textContent = a.detail;
  const notConnected = a.phase === "signed-out" || a.phase === "error";
  $("sign-in").hidden = !notConnected || signingIn;
  $("retry").hidden = !notConnected || signingIn;
  $("sign-out").hidden = a.phase !== "ready" || !a.login;
  $("models").hidden = a.phase !== "ready" || a.models.length === 0;
  const fill = (id: string, list: AgentStatus["models"], current: string | null) => {
    const sel = $(id) as HTMLSelectElement;
    sel.replaceChildren(...list.map(m => {
      const o = document.createElement("option");
      o.value = m.id; o.textContent = m.name; o.selected = m.id === current;
      return o;
    }));
  };
  fill("m-conductor", a.models, a.conductorModel);
  fill("m-worker", a.models.filter(m => m.vision), a.workerModel);
  $("usage").textContent = a.usage.calls
    ? `This session: ${a.usage.calls} model calls, ${(a.usage.inputTokens / 1000).toFixed(1)}k tokens in, ${(a.usage.outputTokens / 1000).toFixed(1)}k out.`
    : "";
}
for (const [id, key] of [["m-conductor", "conductor"], ["m-worker", "worker"]] as const) {
  $(id).addEventListener("change", e => {
    const value = (e.target as HTMLSelectElement).value;
    const current = settings?.models ?? { conductor: null, worker: null };
    void window.ember.updateSettings({ models: { ...current, [key]: value } });
  });
}
const signInMsg = (text: string, error = false) => {
  const msg = $("sign-in-msg");
  msg.hidden = !text;
  msg.classList.toggle("error", error);
  msg.textContent = text;
};
const setSigningIn = (on: boolean) => {
  signingIn = on;
  $("cancel-sign-in").hidden = !on;
  void window.ember.agentStatus().then(renderAgent);
};
$("sign-in").addEventListener("click", () => {
  setSigningIn(true);
  window.ember.signIn().catch(err => { setSigningIn(false); signInMsg(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err), true); });
});
$("retry").addEventListener("click", () => { signInMsg("Checking…"); void window.ember.retrySignIn().then(() => signInMsg("")); });
$("cancel-sign-in").addEventListener("click", () => { void window.ember.cancelSignIn(); });
$("sign-out").addEventListener("click", () => { void window.ember.signOut(); });
window.ember.onSignInProgress(p => {
  const msg = $("sign-in-msg");
  if (p.state === "code") {
    msg.hidden = false;
    msg.classList.remove("error");
    const code = Object.assign(document.createElement("code"), { textContent: p.userCode ?? "" });
    const copy = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: "Copy code" });
    copy.addEventListener("click", () => { void navigator.clipboard.writeText(p.userCode ?? "").then(() => { copy.textContent = "Copied"; }); });
    msg.replaceChildren("Enter ", code, " ", copy, ` at ${p.verificationUri} (your browser should open it). Waiting for you to approve…`);
    return;
  }
  if (p.state === "waiting") { setSigningIn(true); signInMsg(p.message ?? ""); return; }
  setSigningIn(false);
  if (p.state === "cancelled") { signInMsg(""); return; }
  signInMsg(p.message ?? (p.state === "done" ? "Signed in." : ""), p.state === "error");
  if (p.state === "done" && !p.message) setTimeout(() => signInMsg(""), 3000);
});
void window.ember.agentStatus().then(renderAgent);
window.ember.onAgentStatus(renderAgent);

void window.ember.getStatus().then(render);
window.ember.onSettingsChanged(applySettings);

// ───── Conversation (this session only) ─────
type Entry = Awaited<ReturnType<EmberHomeApi["conversation"]>>[number];
const WHO: Record<string, string> = { you: "You", ember: "Ember", task: "Task" };
function renderConversation(entries: Entry[]): void {
  const list = $("conversation");
  list.replaceChildren(...entries.map(e => {
    const li = document.createElement("li");
    li.className = e.who;
    const who = Object.assign(document.createElement("span"), { className: "who", textContent: WHO[e.who] ?? e.who });
    const t = Object.assign(document.createElement("time"), { textContent: time(e.t), dateTime: e.t });
    const text = Object.assign(document.createElement("p"), { textContent: e.text });
    li.append(who, t, text);
    return li;
  }));
  list.lastElementChild?.scrollIntoView({ block: "nearest" });
}
void window.ember.conversation().then(renderConversation);
window.ember.onConversation(renderConversation);
// Main asks for a section ("Read all" on a long answer, connecting after setup): show it and move focus there.
window.ember.onFocusSection(section => {
  const h = document.getElementById(`${section}-h`) as HTMLElement | null;
  if (!h) return;
  h.scrollIntoView({ block: "start", behavior: "smooth" });
  h.focus({ preventScroll: true });
});

// ───── Apps & privacy ─────
function renderPrivacy(s: Settings): void {
  const row = (label: string, remove: () => void, locked: boolean) => {
    const li = document.createElement("li");
    li.append(Object.assign(document.createElement("span"), { textContent: label }));
    const btn = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: "Remove", disabled: locked });
    btn.setAttribute("aria-label", `Remove ${label}`);
    btn.addEventListener("click", remove);
    li.append(btn);
    return li;
  };
  const grants = Object.entries(s.grants).filter(([, g]) => g === "act");
  $("grants").replaceChildren(...(grants.length
    ? grants.map(([app]) => row(app, () => {
      const next = { ...s.grants };
      delete next[app];
      void window.ember.updateSettings({ grants: next });
    }, managed.has("grants")))
    : [Object.assign(document.createElement("li"), { className: "empty", textContent: "None: Ember asks before its first action in each app." })]));
  $("never-look").replaceChildren(...s.privacy.neverLook.map(item => row(item, () => {
    void window.ember.updateSettings({ privacy: { neverLook: s.privacy.neverLook.filter(x => x !== item) } });
  }, false)));
}
$("never-look-form").addEventListener("submit", e => {
  e.preventDefault();
  const input = $("never-look-add") as HTMLInputElement;
  const v = input.value.trim();
  if (!v || !settings) return;
  if (!settings.privacy.neverLook.some(x => x.toLowerCase() === v.toLowerCase())) {
    void window.ember.updateSettings({ privacy: { neverLook: [...settings.privacy.neverLook, v] } });
  }
  input.value = "";
});

// ───── Voice ─────
const VOICE_TEXT: Record<string, string> = {
  off: "Off", "needs-models": "Speech models aren't downloaded yet (a one-time download)", downloading: "Downloading speech models…",
  starting: "Starting…", waiting: "Listening for “Hey Ember”", active: "Hearing you…", muted: "Microphone off (Ctrl+Alt+M to turn on)", error: "Not working",
};
let voiceSettings: { wakeWord: boolean; consent: boolean } = { wakeWord: false, consent: false };
function renderVoice(v: VoiceStatus): void {
  $("voice-text").textContent = v.detail && v.state === "error" ? `${VOICE_TEXT.error}: ${v.detail}` : v.detail ?? VOICE_TEXT[v.state] ?? v.state;
  $("voice-dot").dataset.phase = v.state === "waiting" || v.state === "active" ? "ready" : v.state === "error" ? "error" : v.state === "off" || v.state === "muted" ? "" : "starting";
  const dl = $("voice-download") as HTMLButtonElement;
  dl.hidden = v.modelsReady || v.state === "downloading";
  dl.textContent = `Download speech models (${Math.round(v.modelsBytes / 1e6)} MB)`;
  ($("voice-progress") as HTMLProgressElement).hidden = v.state !== "downloading";
}
function applyVoiceSettings(s: Status["settings"]): void {
  voiceSettings = { wakeWord: s.wakeWord, consent: s.voice.consent };
  ($("wake") as HTMLInputElement).checked = s.wakeWord && s.voice.consent;
  ($("speak") as HTMLInputElement).checked = s.speak;
}
$("wake").addEventListener("change", e => {
  const on = (e.target as HTMLInputElement).checked;
  // First time: the microphone note comes first, and focus moves to it so it is read and answered.
  if (on && !voiceSettings.consent) { $("consent").hidden = false; (e.target as HTMLInputElement).checked = false; $("consent-yes").focus(); return; }
  void window.ember.updateSettings({ wakeWord: on });
});
$("consent-yes").addEventListener("click", () => {
  $("consent").hidden = true;
  void window.ember.updateSettings({ wakeWord: true, voice: { consent: true, speakerRejection: true } });
  // Agreeing also fetches the speech models if they aren't here yet (one less step to find).
  if (!($("voice-download") as HTMLButtonElement).hidden) void window.ember.downloadVoice();
  $("wake").focus();
});
$("consent-no").addEventListener("click", () => { $("consent").hidden = true; $("wake").focus(); });
$("speak").addEventListener("change", e => { void window.ember.updateSettings({ speak: (e.target as HTMLInputElement).checked }); });
$("voice-download").addEventListener("click", () => { void window.ember.downloadVoice(); });
window.ember.onVoiceProgress(p => {
  const bar = $("voice-progress") as HTMLProgressElement;
  bar.hidden = false;
  bar.value = p.done / p.total;
  $("voice-text").textContent = `Downloading speech models… ${Math.round((p.done / p.total) * 100)}%`;
});
void window.ember.voiceStatus().then(renderVoice);
window.ember.onVoiceStatus(renderVoice);
window.ember.onSettingsChanged(applyVoiceSettings);
void window.ember.getStatus().then(st => applyVoiceSettings(st.settings));
