/**
 * Settings window: first-run consent, pick your Ember, Copilot sign-in, the
 * conversation, voice, apps & privacy, comfort & access (where Ember is), what
 * Ember did, setup checks and build facts. Until Start, only the welcome, the
 * character picker and Start show.
 */

import { Rig, FACTORIES, type Character } from "@ember/characters";
import type { ActivityEntry, EmberHomeApi, Presence, Status, VoiceStatus } from "../../shared/ipc";
import { CONSENT_VERSION } from "../../shared/consent";
import type { Settings } from "../../main/settings";
import { dayLabel, describeEntry, friendlyApp, missingDefaults, neverLookLabel, progressStep, retryMessage, tagline, usageLine } from "./copy";

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

/** Whether an element is (now) hidden, itself or by a parent. */
const isHidden = (el: Element) => el instanceof HTMLElement && (el.hidden || !!el.closest("[hidden]") || el.closest("body.first-run .after-setup") !== null);
/** Focus the first of `ids` that is shown. */
function focusFirst(ids: string[]): void {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el && !isHidden(el)) { el.focus(); return; }
  }
}

// ───── Calm mode: the setting or the desktop's reduced-motion preference ─────
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let calm = false;
function applyCalm(): void {
  calm = settings?.reduceMotion === true || reducedMotion.matches;
  document.documentElement.classList.toggle("calm", settings?.reduceMotion === true);
  heroRig.reducedMotion = calm;
  for (const c of cards) c.rig.reducedMotion = calm;
}
reducedMotion.addEventListener("change", applyCalm);

// ───── Your Ember ─────
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

// The big hero character mirrors the selection.
const heroCanvas = $("buddy") as HTMLCanvasElement;
const heroRig = new Rig();
const heroChars: Record<string, Character> = Object.fromEntries(FACTORIES.map(f => { const c = f(); return [c.id, c]; }));

const size = $("size") as HTMLInputElement;
/** The size slider is being dragged (or used): settings echoing back must not move it under the pointer. */
let sliding = false;
size.addEventListener("pointerdown", () => { sliding = true; });
window.addEventListener("pointerup", () => { sliding = false; });
size.addEventListener("blur", () => { if (settings) showSize(settings.size); });
function showSize(v: number): void {
  size.value = String(v);
  size.setAttribute("aria-valuetext", `${v} pixels`);
  $("size-out").textContent = `${v} px`;
}

let settings: Settings | null = null;
function applySettings(s: Settings): void {
  const changed = settings?.character !== s.character;
  settings = s;
  applyCalm();
  for (const c of cards) {
    const on = c.id === s.character;
    c.el.setAttribute("aria-checked", String(on));
    c.el.tabIndex = on ? 0 : -1;
    if (on && changed) c.rig.setEmotion("happy");
    if (!on) c.rig.setEmotion("neutral");
  }
  if (!sliding && document.activeElement !== size) showSize(s.size);
  ($("login") as HTMLInputElement).checked = s.startAtLogin;
  ($("reduce-motion") as HTMLInputElement).checked = s.reduceMotion;
  // First run (or changed terms): the consent panel comes first and Start (right beside "I agree") waits for it;
  // everything else waits until Ember has started.
  const consented = s.consent.version >= CONSENT_VERSION;
  document.body.classList.toggle("first-run", !s.onboarded);
  document.body.classList.remove("loading");
  $("welcome").hidden = consented;
  $("start-row").hidden = s.onboarded;
  $("agree-row").hidden = consented;
  ($("start") as HTMLButtonElement).disabled = !consented && !($("agree") as HTMLInputElement).checked;
  $("start-hint").hidden = consented;
  $("pick-h").textContent = s.onboarded ? "Your Ember" : "Choose your Ember";
  renderPrivacy(s);
  renderTagline();
}
// Never a blank window, even if the first status is slow.
setTimeout(() => document.body.classList.remove("loading"), 1500);
$("login").addEventListener("change", e => { void window.ember.updateSettings({ startAtLogin: (e.target as HTMLInputElement).checked }); });
$("agree").addEventListener("change", e => {
  const on = (e.target as HTMLInputElement).checked;
  ($("start") as HTMLButtonElement).disabled = !on;
  $("start-hint").hidden = on;
});
$("reduce-motion").addEventListener("change", e => { void window.ember.updateSettings({ reduceMotion: (e.target as HTMLInputElement).checked }); });

size.addEventListener("input", () => {
  const v = Number(size.value);
  size.setAttribute("aria-valuetext", `${v} pixels`);
  $("size-out").textContent = `${v} px`;
  void window.ember.updateSettings({ size: v });
});
$("start").addEventListener("click", () => {
  const already = (settings?.consent.version ?? 0) >= CONSENT_VERSION;
  if (!already && !($("agree") as HTMLInputElement).checked) return;
  void window.ember.updateSettings({ ...(already ? {} : { consent: { version: CONSENT_VERSION, at: new Date().toISOString() } }), onboarded: true });
});
/** Something needs the user's agreement first: take them to the checkbox. */
function focusAgree(): void {
  const agree = $("agree");
  agree.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
  agree.focus({ preventScroll: true });
}

// ───── The line under the title: recomputed whenever anything it depends on changes ─────
let failing = 0;
function renderTagline(): void {
  const text = tagline({
    failing, onboarded: settings?.onboarded ?? false, phase: agent?.phase ?? null, waitingForTasks: agent?.waitingForTasks === true,
    hidden: presence?.hidden ?? false, overlay: presence?.overlay ?? true,
  });
  if ($("tagline").textContent !== text) $("tagline").textContent = text;
}

// ───── Setup check and build facts ─────
let checksOpened = false;
function renderChecks(environment: Status["environment"]): void {
  const hadFocus = $("checks").contains(document.activeElement);
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
  if (hadFocus) ($("checks-fold").querySelector("summary") as HTMLElement).focus();
  failing = environment.checks.filter(c => c.status === "fail").length;
  const warn = environment.checks.filter(c => c.status === "warn").length;
  const note = $("checks-note");
  note.textContent = failing ? `${failing} to fix` : warn ? `${warn} to look at` : "All good";
  note.className = `fold-note${failing ? " fail" : warn ? " warn" : ""}`;
  // Something fails: the check opens by itself (once), and it shows even before Start.
  if (failing && !checksOpened) { ($("checks-fold") as HTMLDetailsElement).open = true; checksOpened = true; }
  $("checks-fold").closest("section")!.classList.toggle("after-setup", !failing);
  renderTagline();
}

function render(status: Status): void {
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
  $("about-note").textContent = `Ember ${status.appVersion}`;
  renderSettingsNotice(status.settingsNotice);
  applySettings(status.settings);
}

/** A settings file Ember couldn't use as it was (a hand edit): what happened and where the user's copy is. */
function renderSettingsNotice(notice: string | null): void {
  const el = $("settings-notice");
  el.hidden = !notice;
  el.textContent = notice ?? "";
}
window.ember.onSettingsNotice(renderSettingsNotice);

// ───── Organisation policy ─────
let managed = new Set<string>();
/** The organisation has Ember ask before every action: "Always in this app" grants don't apply. */
let confirmEvery = false;
/** Never-look entries the administrator set (lower case): shown locked, never part of the user's own list. */
let adminNeverLook = new Set<string>();
const FEATURE_TEXT: Record<string, string> = {
  voice: "listening for “Hey Ember”", speak: "speaking out loud", actions: "acting in apps (Ember can still answer and show you how)",
  cursor: "borrowing your mouse", desk: "Ember's own desk", screenImages: "sending screenshots",
};
function renderAdmin(a: Status["admin"]): void {
  managed = new Set(a.managed);
  confirmEvery = a.confirmEveryAction;
  adminNeverLook = new Set((a.neverLook ?? []).map(x => x.trim().toLowerCase()));
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
  privacyKey = "";
  if (settings) renderPrivacy(settings);
  if (voice) renderVoice(voice);
}

// ───── What Ember did ─────
const time = (t: string) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
let shownActivity = "";
async function refreshActivity(): Promise<void> {
  const entries = await window.ember.activity().catch(() => [] as ActivityEntry[]);
  // Unchanged: leave the list alone (a screen reader keeps its place, the scroll position stays).
  const key = JSON.stringify(entries.slice(0, 1).map(e => e.t)) + entries.length + dayLabel(new Date().toISOString());
  if (key === shownActivity) return;
  shownActivity = key;
  let day = "";
  let today = 0;
  const items: HTMLLIElement[] = [];
  for (const e of entries) {
    const d = describeEntry(e);
    if (!d) continue;
    if (items.length >= 80) break;
    // A heading for each day ("Today", "Yesterday", then dates): the list covers up to a month.
    const label = dayLabel(e.t);
    if (label === "Today") today++;
    if (label !== day) {
      day = label;
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
  $("activity-note").textContent = today ? `${today} today` : "";
}
void refreshActivity();
/** Main says whether the window can be seen: minimised, X11 still reports the page visible. */
let windowShown = true;
const canBeSeen = () => windowShown && document.visibilityState === "visible";
setInterval(() => { if (canBeSeen()) void refreshActivity(); }, 3000);

// ───── Drawing the characters ─────
// Only while the window shows and a character is on screen (not hidden or scrolled away); every frame while something
// moves or the pointer is about, else ~30 fps for a calm face and ~15 for a still one, as the handle.
let pointer = { x: 0, y: 0 };
/** The pointer moved since the last frame (the characters look at it). */
let looking = false;
/** The canvases on screen now: only these are drawn. */
const onScreen = new Set<Element>();
let drawTimer: ReturnType<typeof setTimeout> | null = null;
let drawPending = false;
/** Draw on the next frame, or after `gap` ms (a sooner draw already asked for wins). */
function drawSoon(gap = 0): void {
  if (drawPending || !canBeSeen() || !onScreen.size) return;
  if (gap > 0) {
    if (!drawTimer) drawTimer = setTimeout(() => { drawTimer = null; drawSoon(); }, gap);
    return;
  }
  if (drawTimer) { clearTimeout(drawTimer); drawTimer = null; }
  drawPending = true;
  requestAnimationFrame(frame);
}
window.addEventListener("pointermove", e => { pointer = { x: e.clientX, y: e.clientY }; looking = true; drawSoon(); });
document.addEventListener("visibilitychange", () => drawSoon());
window.ember.onVisibility(shown => {
  windowShown = shown;
  if (shown) { void refreshActivity(); drawSoon(); }
});
const seen = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (e.isIntersecting) onScreen.add(e.target);
    else onScreen.delete(e.target);
  }
  drawSoon();
});
seen.observe(heroCanvas);
for (const c of cards) seen.observe(c.canvas);

function paint(canvas: HTMLCanvasElement, rig: Rig, character: Character, dt: number, zoom: number): void {
  const dpr = window.devicePixelRatio || 1;
  const px = canvas.clientWidth;
  if (!px) return;
  if (canvas.width !== Math.round(px * dpr)) { canvas.width = canvas.height = Math.round(px * dpr); }
  const r = canvas.getBoundingClientRect();
  const dx = pointer.x - (r.left + px / 2), dy = pointer.y - (r.top + px / 2);
  const d = Math.max(160, Math.hypot(dx, dy));
  rig.lookAt(dx / d * 1.4, dy / d * 1.4);
  const pose = rig.update(dt);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, px, px);
  ctx.translate(px / 2, px * 0.58);
  ctx.scale(px / zoom, px / zoom);
  character.draw(ctx, pose);
}

let last = performance.now();
function frame(now: number): void {
  drawPending = false;
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.05));
  last = now;
  // Hidden, minimised or scrolled away: nothing is drawn until it shows again (drawSoon is called then).
  if (!canBeSeen() || !onScreen.size) return;
  const drawn: Rig[] = [];
  if (onScreen.has(heroCanvas)) { paint(heroCanvas, heroRig, heroChars[settings?.character ?? "cinder"], dt, 170); drawn.push(heroRig); }
  for (const c of cards) if (onScreen.has(c.canvas)) { paint(c.canvas, c.rig, c.character, dt, 175); drawn.push(c.rig); }
  const motion = looking || drawn.some(r => r.motion === "brisk") ? 0 : drawn.some(r => r.motion === "gentle") ? 1 : 2;
  looking = false;
  // In a window the user isn't working in (behind another, or minimised: X11 doesn't always say hidden), less often.
  drawSoon((document.hasFocus() ? [0, 33, 66] : [33, 66, 110])[motion]);
}
drawSoon();

// ───── Copilot ─────
type AgentStatus = Awaited<ReturnType<EmberHomeApi["agentStatus"]>>;
const COPILOT_BUTTONS = ["sign-in", "cancel-sign-in", "retry", "sign-out"];
let agent: AgentStatus | null = null;
let signingIn = false;
let modelsKey = "";
function renderAgent(a: AgentStatus | null): void {
  if (!a) return;
  agent = a;
  const had = document.activeElement;
  ($("agent-dot") as HTMLElement).dataset.phase = a.phase;
  $("agent-text").textContent = a.detail;
  const notConnected = a.phase === "signed-out" || a.phase === "error";
  // Copilot stopped answering with tasks at work: Ember reconnects once they're done. Signing in again isn't the
  // fix, and reconnecting now stops the tasks: the button says so.
  const waiting = a.waitingForTasks === true;
  $("sign-in").hidden = !notConnected || signingIn || waiting;
  $("retry").hidden = !notConnected || signingIn;
  $("retry").textContent = waiting ? "Reconnect now (stops the tasks running)" : "Check again";
  $("cancel-sign-in").hidden = !signingIn;
  $("sign-out").hidden = a.phase !== "ready" || !a.login;
  $("models").hidden = a.phase !== "ready" || a.models.length === 0;
  // The lists are rebuilt only when they change (an open drop-down isn't pulled from under the pointer).
  const key = JSON.stringify([a.models, a.conductorModel, a.workerModel]);
  if (key !== modelsKey) {
    modelsKey = key;
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
  }
  $("usage").textContent = usageLine(a.usage);
  if (retryFound && a.phase === "ready") say(retryMessage(retryFound, true));
  // A button that just went away (Sign in, Check again…) hands focus to the one that took its place.
  if (had && COPILOT_BUTTONS.includes(had.id) && isHidden(had)) focusFirst([...COPILOT_BUTTONS, "copilot-h"]);
  renderTagline();
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
/** A message that clears itself after a few seconds (unless something else replaced it). */
let sayTimer: ReturnType<typeof setTimeout> | null = null;
function say(text: string, ms = 6000): void {
  signInMsg(text);
  if (sayTimer) clearTimeout(sayTimer);
  sayTimer = setTimeout(() => {
    sayTimer = null;
    retryFound = null;
    if ($("sign-in-msg").textContent === text) signInMsg("");
  }, ms);
}
const setSigningIn = (on: boolean) => {
  signingIn = on;
  if (agent) renderAgent(agent);
  else $("cancel-sign-in").hidden = !on;
  void window.ember.agentStatus().then(renderAgent);
};
const cleanError = (err: unknown) => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));
$("sign-in").addEventListener("click", () => {
  setSigningIn(true);
  $("cancel-sign-in").focus();
  window.ember.signIn().catch(err => {
    setSigningIn(false);
    // Not agreed yet: the way forward is the checkbox at the top, so go there.
    if (settings && settings.consent.version < CONSENT_VERSION) { focusAgree(); return; }
    signInMsg(cleanError(err), true);
  });
});
/** What "Check again" found, while its message shows (it changes to "connected" when Copilot is ready). */
let retryFound: { found: boolean; source: string | null } | null = null;
$("retry").addEventListener("click", () => {
  signInMsg("Checking…");
  window.ember.retrySignIn().then(r => {
    retryFound = r.found ? r : null;
    say(retryMessage(r, r.found && agent?.phase === "ready"));
  }, err => signInMsg(cleanError(err), true));
});
$("cancel-sign-in").addEventListener("click", () => { void window.ember.cancelSignIn(); });
$("sign-out").addEventListener("click", () => { void window.ember.signOut(); });

/** The device code row: "Code ABCD-1234 [Copy] — enter it at github.com/login/device [Open]". */
function showCode(userCode: string, uri: string): void {
  const msg = $("sign-in-msg");
  msg.hidden = false;
  msg.classList.remove("error");
  const code = Object.assign(document.createElement("code"), { textContent: userCode });
  const copy = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: "Copy" });
  copy.setAttribute("aria-label", `Copy the code ${userCode}`);
  copy.addEventListener("click", () => { void navigator.clipboard.writeText(userCode).then(() => { copy.textContent = "Copied"; }); });
  let where = uri;
  try { const u = new URL(uri); where = `${u.host}${u.pathname}`.replace(/\/$/, ""); } catch { /* shown as given */ }
  const parts: (string | Node)[] = ["Code ", code, copy, ` — enter it at ${where}`];
  // Opening the page again needs the main process (the window never navigates); offered when it can.
  const open = (window.ember as EmberHomeApi & { openSignInPage?: () => Promise<void> }).openSignInPage;
  if (typeof open === "function") {
    const btn = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: "Open" });
    btn.setAttribute("aria-label", `Open ${where} in your browser`);
    btn.addEventListener("click", () => { void open(); });
    parts.push(btn);
  }
  const wait = Object.assign(document.createElement("span"), { className: "wait", textContent: "Your browser should have opened it. Waiting for you to approve…" });
  msg.replaceChildren(...parts, wait);
}
window.ember.onSignInProgress(p => {
  if (p.state === "code") { showCode(p.userCode ?? "", p.verificationUri ?? ""); return; }
  if (p.state === "waiting") { setSigningIn(true); signInMsg(p.message ?? ""); return; }
  setSigningIn(false);
  if (p.state === "cancelled") { signInMsg(""); return; }
  if (p.state === "done" && !p.message) { say("Signed in.", 3000); return; }
  signInMsg(p.message ?? "", p.state === "error");
});
void window.ember.agentStatus().then(renderAgent);
window.ember.onAgentStatus(renderAgent);

void window.ember.getStatus().then(render);
window.ember.onSettingsChanged(applySettings);

// ───── Conversation (this session only) ─────
type Entry = Awaited<ReturnType<EmberHomeApi["conversation"]>>[number];
const WHO: Record<string, string> = { you: "You", ember: "Ember", task: "Task", problem: "Problem" };
let shownConversation: Entry[] = [];
function conversationRow(e: Entry): HTMLLIElement {
  const li = document.createElement("li");
  li.className = e.who;
  const who = Object.assign(document.createElement("span"), { className: "who", textContent: WHO[e.who] ?? e.who });
  const t = Object.assign(document.createElement("time"), { textContent: time(e.t), dateTime: e.t });
  const text = Object.assign(document.createElement("p"), { textContent: e.text });
  li.append(who, t, text);
  return li;
}
function renderConversation(entries: Entry[]): void {
  const list = $("conversation");
  // Only the list scrolls, and only if the reader was at its end (never the page, never away from what they read).
  const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
  const same = (a: Entry, b: Entry) => a.t === b.t && a.who === b.who && a.text === b.text;
  const grows = shownConversation.length <= entries.length && shownConversation.every((e, i) => same(e, entries[i]));
  if (grows) list.append(...entries.slice(shownConversation.length).map(conversationRow));
  else list.replaceChildren(...entries.map(conversationRow));
  shownConversation = entries;
  if (atEnd) list.scrollTop = list.scrollHeight;
}
void window.ember.conversation().then(renderConversation);
window.ember.onConversation(renderConversation);

// ───── Section links ─────
// The links stay at the top of a wide window, one row or two: scrolling keeps clear of their height (styles.css).
new ResizeObserver(() => document.documentElement.style.setProperty("--jump-h", `${$("jump").offsetHeight}px`)).observe($("jump"));
/** Shows a section (opening it if folded) and moves focus there. */
function showSection(section: string): void {
  const h = document.getElementById(`${section}-h`);
  if (!h || isHidden(h)) return;
  const fold = h.closest("details");
  if (fold) fold.open = true;
  const target = (fold?.querySelector("summary") ?? h) as HTMLElement;
  target.scrollIntoView({ block: "start", behavior: calm ? "auto" : "smooth" });
  target.focus({ preventScroll: true });
  markCurrent(section);
  // The scroll this starts (and a page too short to bring the section to the top) doesn't move the mark.
  pinnedUntil = performance.now() + 900;
}
let pinnedUntil = 0;
// Main asks for a section ("Read all" on a long answer, connecting after setup).
window.ember.onFocusSection(showSection);
const jumpLinks = [...document.querySelectorAll<HTMLAnchorElement>("#jump a")];
const sectionOf = (a: HTMLAnchorElement) => (a.getAttribute("href") ?? "").replace(/^#/, "").replace(/-h$/, "");
$("jump").addEventListener("click", e => {
  const a = (e.target as Element).closest("a");
  if (!a) return;
  e.preventDefault();
  showSection(sectionOf(a));
});
function markCurrent(section: string): void {
  for (const a of jumpLinks) {
    if (sectionOf(a) === section) a.setAttribute("aria-current", "true");
    else a.removeAttribute("aria-current");
  }
}
// While scrolling: the link of the section at the top is marked.
let scrollQueued = false;
window.addEventListener("scroll", () => {
  if (scrollQueued || performance.now() < pinnedUntil) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    let current = sectionOf(jumpLinks[0]);
    for (const a of jumpLinks) {
      const h = document.getElementById(`${sectionOf(a)}-h`);
      if (h && !isHidden(h) && h.getBoundingClientRect().top < 140) current = sectionOf(a);
    }
    markCurrent(current);
  });
}, { passive: true });

// ───── Apps & privacy ─────
/** The user's own never-look list holds at most this many (the administrator's come on top). */
const NEVER_LOOK_MAX = 100;
const isAdminEntry = (x: string) => adminNeverLook.has(x.trim().toLowerCase());
/** The user's own entries: what an add or remove changes (the effective list also holds the administrator's). */
const ownNeverLook = (s: Settings) => s.privacy.neverLook.filter(x => !isAdminEntry(x));
let privacyKey = "";
/** After a Remove: which list, and where in it, focus goes once the list is redrawn. */
let focusAfter: { list: "grants" | "never-look"; index: number } | null = null;
const listMsg = (text: string) => { $("never-look-msg").textContent = text; };
function renderPrivacy(s: Settings): void {
  // Redrawn only when the lists change (never under a pointer or a screen reader for an unrelated setting).
  const key = JSON.stringify([s.grants, s.privacy.neverLook, managed.has("grants"), confirmEvery, [...adminNeverLook]]);
  if (key === privacyKey) return;
  privacyKey = key;
  /** `locked`: true = Remove disabled (managed); null = the organisation's entry (no Remove at all). */
  const row = (label: string, remove: () => void, locked: boolean | null) => {
    const li = document.createElement("li");
    li.append(Object.assign(document.createElement("span"), { textContent: label }));
    if (locked === null) {
      li.append(Object.assign(document.createElement("span"), { className: "managed-tag", textContent: "Set by your organisation" }));
      return li;
    }
    const btn = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: "Remove", disabled: locked });
    btn.setAttribute("aria-label", `Remove ${label}`);
    btn.addEventListener("click", remove);
    li.append(btn);
    return li;
  };
  const grants = Object.entries(s.grants).filter(([, g]) => g === "act");
  // Asked before every action anyway: the list stays (Remove still tidies it) but says it doesn't apply.
  $("grants-off").hidden = !confirmEvery;
  $("grants-hint").hidden = confirmEvery || managed.has("grants");
  $("grants").classList.toggle("off", confirmEvery);
  if (confirmEvery) $("grants").setAttribute("aria-describedby", "grants-off");
  else $("grants").removeAttribute("aria-describedby");
  $("grants").replaceChildren(...(grants.length
    ? grants.map(([app], i) => row(friendlyApp(app), () => {
      const next = { ...s.grants };
      delete next[app];
      focusAfter = { list: "grants", index: i };
      void window.ember.updateSettings({ grants: next });
    }, managed.has("grants")))
    : [Object.assign(document.createElement("li"), { className: "empty", textContent: confirmEvery ? "None." : "None: Ember asks before its first action in each app." })]));
  // The user's own entries (with Remove), then the organisation's (locked).
  const own = ownNeverLook(s);
  const theirs = s.privacy.neverLook.filter(isAdminEntry);
  $("never-look").replaceChildren(...(own.length || theirs.length
    ? [
      ...own.map((item, i) => row(neverLookLabel(item), () => {
        focusAfter = { list: "never-look", index: i };
        listMsg("");
        void window.ember.updateSettings({ privacy: { neverLook: own.filter(x => x !== item) } });
      }, false)),
      ...theirs.map(item => row(neverLookLabel(item), () => {}, null)),
    ]
    : [Object.assign(document.createElement("li"), { className: "empty", textContent: "Nothing on the list. Ember still never reads password prompts." })]));
  $("never-look-defaults").hidden = missingDefaults(s.privacy.neverLook).length === 0;
  if (focusAfter) {
    const { list, index } = focusAfter;
    focusAfter = null;
    const removes = (id: string) => [...$(id).querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const here = removes(list);
    const next = here[Math.min(index, here.length - 1)] ?? (list === "grants" ? removes("never-look")[0] : undefined) ?? $("never-look-add");
    next.focus();
  }
}
$("never-look-form").addEventListener("submit", e => {
  e.preventDefault();
  const input = $("never-look-add") as HTMLInputElement;
  const v = input.value.trim();
  if (!v || !settings) return;
  const have = settings.privacy.neverLook.find(x => x.trim().toLowerCase() === v.toLowerCase());
  if (have) { listMsg(`Already on the list: ${neverLookLabel(have)}${isAdminEntry(have) ? " (set by your organisation)" : ""}.`); input.select(); return; }
  const own = ownNeverLook(settings);
  if (own.length >= NEVER_LOOK_MAX) { listMsg(`The list is full (${NEVER_LOOK_MAX} names). Remove one to add another.`); return; }
  window.ember.updateSettings({ privacy: { neverLook: [...own, v] } }).then(() => {
    input.value = "";
    listMsg(`Added ${v}.`);
  }, err => listMsg(`Couldn't add it: ${cleanError(err)}`));
});
$("never-look-add").addEventListener("input", () => listMsg(""));
$("never-look-defaults").addEventListener("click", () => {
  if (!settings) return;
  const own = ownNeverLook(settings);
  const back = missingDefaults(settings.privacy.neverLook);
  const room = Math.max(0, NEVER_LOOK_MAX - own.length);
  void window.ember.updateSettings({ privacy: { neverLook: [...own, ...back.slice(0, room)] } });
  listMsg(room < back.length
    ? `The list is full (${NEVER_LOOK_MAX} names): remove some to restore the rest of the defaults.`
    : "The usual password managers and password prompts are back on the list.");
  $("never-look-add").focus();
});

// ───── Ember on screen (the handle menu's Hide / Stay put / Quit, reachable by keyboard) ─────
let presence: Presence | null = null;
function renderPresence(p: Presence): void {
  presence = p;
  $("p-hide").hidden = !p.overlay;
  $("p-follow").hidden = !p.overlay;
  $("p-hide").textContent = p.hidden ? "Show Ember" : "Hide Ember";
  $("p-follow").textContent = p.paused ? "Follow my cursor" : "Stay put";
  $("presence-text").textContent = !p.overlay
    ? "This desktop session can't show Ember beside your cursor, so it lives in the card in the bottom-right corner."
    : p.hidden
      ? "Ember is hidden. It shows itself again when it needs to ask you something."
      : p.paused ? "Ember stays where it is instead of following your cursor." : "Ember follows your cursor.";
  renderTagline();
}
$("p-hide").addEventListener("click", () => { void window.ember.setPresence({ hidden: !(presence?.hidden ?? false) }).then(renderPresence); });
$("p-follow").addEventListener("click", () => { void window.ember.setPresence({ paused: !(presence?.paused ?? false) }).then(renderPresence); });
$("p-quit").addEventListener("click", () => { void window.ember.quit(); });
void window.ember.presence().then(renderPresence);
window.ember.onPresence(renderPresence);

// ───── Voice ─────
const VOICE_TEXT: Record<string, string> = {
  off: "Off", "needs-models": "Speech models aren't downloaded yet (a one-time download)", downloading: "Downloading speech models…",
  starting: "Starting…", waiting: "Listening for “Hey Ember”", active: "Hearing you…", muted: "Microphone off (Ctrl+Alt+M to turn on)", error: "Not working",
};
let voiceSettings: { wakeWord: boolean; consent: boolean } = { wakeWord: false, consent: false };
let voice: VoiceStatus | null = null;
/** Screen readers hear the voice line when it changes, and a download only every 25 %. */
const voiceLive = (text: string) => { if ($("voice-live").textContent !== text) $("voice-live").textContent = text; };
function renderVoice(v: VoiceStatus): void {
  voice = v;
  const text = v.detail && v.state === "error" ? `${VOICE_TEXT.error}: ${v.detail}` : v.detail ?? VOICE_TEXT[v.state] ?? v.state;
  $("voice-text").textContent = text;
  if (v.state !== "downloading") voiceLive(text);
  $("voice-dot").dataset.phase = v.state === "waiting" || v.state === "active" ? "ready" : v.state === "error" ? "error" : v.state === "off" || v.state === "muted" ? "" : "starting";
  const dl = $("voice-download") as HTMLButtonElement;
  // Listening turned off by the organisation: nothing to download it for.
  dl.hidden = v.modelsReady || v.state === "downloading" || managed.has("wakeWord");
  dl.textContent = `Download speech models (${Math.round(v.modelsBytes / 1e6)} MB)`;
  // One orange button per section: the download is the main thing only once "Hey Ember" is on.
  dl.classList.toggle("quiet", !(voiceSettings.wakeWord && voiceSettings.consent));
  ($("voice-progress") as HTMLProgressElement).hidden = v.state !== "downloading";
}
function applyVoiceSettings(s: Status["settings"]): void {
  voiceSettings = { wakeWord: s.wakeWord, consent: s.voice.consent };
  ($("wake") as HTMLInputElement).checked = s.wakeWord && s.voice.consent;
  ($("speak") as HTMLInputElement).checked = s.speak;
  if (voice) renderVoice(voice);
}
$("wake").addEventListener("change", e => {
  const on = (e.target as HTMLInputElement).checked;
  // First time: the microphone note comes first, and focus moves to it so it is read and answered.
  if (on && !voiceSettings.consent) { $("consent").hidden = false; (e.target as HTMLInputElement).checked = false; $("consent-yes").focus(); return; }
  void window.ember.updateSettings({ wakeWord: on });
});
$("consent-yes").addEventListener("click", () => {
  $("consent").hidden = true;
  void window.ember.updateSettings({ wakeWord: true, voice: { muted: false, ...(settings?.voice ?? {}), consent: true, speakerRejection: true } });
  // Agreeing also fetches the speech models if they aren't here yet (one less step to find).
  if (!($("voice-download") as HTMLButtonElement).hidden) void window.ember.downloadVoice();
  $("wake").focus();
});
$("consent-no").addEventListener("click", () => { $("consent").hidden = true; $("wake").focus(); });
$("speak").addEventListener("change", e => { void window.ember.updateSettings({ speak: (e.target as HTMLInputElement).checked }); });
$("voice-download").addEventListener("click", () => {
  void window.ember.downloadVoice();
  // The button goes while it downloads: focus stays in the section.
  focusFirst(["wake"]);
});
window.ember.onVoiceProgress(p => {
  const bar = $("voice-progress") as HTMLProgressElement;
  bar.hidden = false;
  bar.value = p.done / p.total;
  const pct = Math.round((p.done / p.total) * 100);
  $("voice-text").textContent = `Downloading speech models… ${pct}%`;
  voiceLive(`Downloading speech models… ${progressStep(p.done / p.total)}%`);
});
void window.ember.voiceStatus().then(renderVoice);
window.ember.onVoiceStatus(renderVoice);
window.ember.onSettingsChanged(applyVoiceSettings);
void window.ember.getStatus().then(st => applyVoiceSettings(st.settings));
