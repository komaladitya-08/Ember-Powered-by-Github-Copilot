/**
 * Settings window: first-run consent, pick your Ember, Copilot sign-in, the
 * conversation, voice, apps & privacy, comfort & access (where Ember is), what
 * Ember did, setup checks and build facts. Until Start, only the welcome, the
 * character picker and Start show.
 */

import { Rig, FACTORIES, type Character } from "@ember/characters";
import type { ActivityEntry, EmberHomeApi, Presence, Status, StatusPlatform, VoiceStatus } from "../../shared/ipc";
import { SPEAK_NO_VOICE, setupBadge, setupView } from "./copy";
import { handleCornerText } from "./copy";
import { MATCH_TEXT, matchAnnouncement, matchView, trustView } from "./match-copy";
import { TARGET_FEATURE_TEXT, targetFeatureApplies } from "./computers-copy";
import { ISSUES_URL } from "../../shared/support";
import { CONSENT_VERSION } from "../../shared/consent";
import { useAppNames } from "../../shared/apps";
import { speakChoice, speakSettings, type SpeakChoice } from "../../shared/speech";
import type { Settings, SettingsPatch } from "../../main/settings";
import {
  dayLabel, describeEntry, entryWords, fixButtonName, fixFailedText, friendlyApp, homePatches, ipcErrorText, MANAGED_ROW, micOffText, missingDefaults, neverLookLabel, progressStep,
  rereadsStatusOnFocus, modelLabel, retryMessage, saveFailedText, signInLabel, STARTED_TEXT, tagline, usageLine, voiceFix, voiceFixFailed, withCommandShells,
  type HomePatch, type Segment,
} from "./copy";
import { startTargets, targetsSettings, targetsStatus } from "./computers";
import { keptWords, lockdownNotice, lockdownSendLine } from "./admin-copy";
import { PendingSection, sectionRequest } from "./section-request";
import { followStartRow } from "./start-row";

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
    void save({ character: character.id as Settings["character"] });
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
  sizeLabel(v);
}
/** The words beside the slider and the filled part of its track. */
function sizeLabel(v: number): void {
  size.setAttribute("aria-valuetext", `${v} pixels`);
  $("size-out").textContent = `${v} px`;
  size.style.setProperty("--fill", `${((v - Number(size.min)) / (Number(size.max) - Number(size.min))) * 100}%`);
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
  ($("more-time") as HTMLInputElement).checked = s.moreTime;
  ($("text-size") as HTMLSelectElement).value = s.textSize;
  ($("handle-position") as HTMLSelectElement).value = s.handlePosition;
  // The copy that names the handle's corner follows Handle position (review #75).
  const corner = handleCornerText(s.handlePosition);
  if ($("handle-corner").textContent !== corner) $("handle-corner").textContent = corner;
  if (presence) renderPresence(presence);
  // First run (or changed terms): the consent panel comes first and Start (right beside "I agree") waits for it;
  // everything else waits until Ember has started.
  const consented = s.consent.version >= CONSENT_VERSION;
  // Start (or "I agree") had focus and goes now: focus moves to the top of the settings, and Ember says it started
  // (review #50), rather than dropping to the page.
  const started = s.onboarded && !$("start-row").hidden && $("start-row").contains(document.activeElement);
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
  if (started) {
    $("home-live").textContent = STARTED_TEXT;
    window.scrollTo({ top: 0 });
    $("pick-h").focus({ preventScroll: true });
  }
}
// First run's Start row stays at the window's foot: focus scrolls clear of it at its height now (start-row.ts).
followStartRow($("start-row"), document.documentElement);
// Never a blank window, even if the first status is slow.
setTimeout(() => document.body.classList.remove("loading"), 1500);
$("login").addEventListener("change", e => { void save({ startAtLogin: (e.target as HTMLInputElement).checked }); });
$("agree").addEventListener("change", e => {
  const on = (e.target as HTMLInputElement).checked;
  ($("start") as HTMLButtonElement).disabled = !on;
  $("start-hint").hidden = on;
});
$("reduce-motion").addEventListener("change", e => { void save({ reduceMotion: (e.target as HTMLInputElement).checked }); });
$("more-time").addEventListener("change", e => { void save({ moreTime: (e.target as HTMLInputElement).checked }); });
// The text size reaches every window from main (page-prefs.ts), this one included.
$("text-size").addEventListener("change", e => { void save({ textSize: (e.target as HTMLSelectElement).value as Settings["textSize"] }); });
// The handle (and its task cards) moves as main hears the change (handle.ts, overlay/main.ts).
$("handle-position").addEventListener("change", e => { void save({ handlePosition: (e.target as HTMLSelectElement).value as Settings["handlePosition"] }); });

size.addEventListener("input", () => {
  const v = Number(size.value);
  sizeLabel(v);
  void save({ size: v });
});
$("start").addEventListener("click", () => {
  const already = (settings?.consent.version ?? 0) >= CONSENT_VERSION;
  if (!already && !($("agree") as HTMLInputElement).checked) return;
  void save({ ...(already ? {} : { consent: { version: CONSENT_VERSION, at: new Date().toISOString() } }), onboarded: true }).then(ok => {
    // Start did nothing visible: the notice at the top says why (review #84).
    if (!ok) $("settings-notice").scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
  });
});
/**
 * Saves a change made in this window. One that can't be saved says why (main's plain sentence, in the notice at the
 * top) and the controls go back to the settings still in use, instead of nothing happening (review #84).
 */
function save(patch: SettingsPatch): Promise<boolean> {
  return window.ember.updateSettings(patch).then(() => true, err => {
    renderSettingsNotice(saveFailedText(err));
    if (settings) { applySettings(settings); applyVoiceSettings(settings); }
    if (agent) renderAgent(agent);
    return false;
  });
}
/** Something needs the user's agreement first: take them to the checkbox. */
function focusAgree(): void {
  const agree = $("agree");
  agree.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
  agree.focus({ preventScroll: true });
}

// ───── The line under the title: recomputed whenever anything it depends on changes ─────
let failing = 0;
/** Setup rows that don't fail but need the user: the tagline mentions them once Ember has started. */
let toLook = 0;
function renderTagline(): void {
  const text = tagline({
    failing, look: toLook, onboarded: settings?.onboarded ?? false, phase: agent?.phase ?? null, waitingForTasks: agent?.waitingForTasks === true,
    hidden: presence?.hidden ?? false, overlay: presence?.overlay ?? true, corner: settings?.handlePosition,
  }, platform?.shortcuts.ask.label);
  if ($("tagline").textContent !== text) $("tagline").textContent = text;
}

// ───── Setup check and build facts ─────
let checksOpened = false;
/** The setup check shows on the first-run screen (a row needed the user), and stays there until Start. */
let checksBeforeStart = false;
/** The checks on screen, to leave them alone when a fresh status brings the same ones. */
let shownChecks = "";
/** The setup check's rows as last shown: the voice line's fix button comes from its microphone row. */
let checksNow: Status["environment"]["checks"] = [];
function renderChecks(environment: Status["environment"]): void {
  shownChecks = JSON.stringify(environment.checks);
  checksNow = environment.checks;
  renderVoiceFix();
  const hadFocus = $("checks").contains(document.activeElement);
  // A fix button that had focus keeps it when its row is drawn again (the row's check id says which).
  const hadFix = hadFocus ? document.activeElement?.closest<HTMLElement>("li")?.dataset.check : undefined;
  $("checks").replaceChildren(...environment.checks.map(c => {
    const li = document.createElement("li");
    li.dataset.check = c.id;
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
    // The row's fix, and a second one beside it for when that didn't take (macOS: Reset Ember's permissions).
    const actions = Object.assign(document.createElement("span"), { className: "check-actions" });
    for (const fix of [c.fix, c.alt]) {
      if (!fix) continue;
      const btn = document.createElement("button");
      btn.className = "btn quiet check-fix";
      btn.textContent = platform?.fixLabels[fix] ?? "Turn on";
      btn.setAttribute("aria-label", fixButtonName(btn.textContent, c.label));
      btn.addEventListener("click", () => {
        // Busy, not disabled: a disabled button drops keyboard focus to the page.
        if (btn.getAttribute("aria-disabled") === "true") return;
        btn.setAttribute("aria-disabled", "true");
        $("checks-msg").textContent = "";
        window.ember.applyFix(fix).then(renderChecks, err => {
          btn.removeAttribute("aria-disabled");
          // A refused fix says why in its own words (main's message, without Electron's IPC prefix), in its row and
          // in the status line a screen reader reads; focus stays on the button.
          const why = ipcErrorText(err);
          detail.textContent = `Couldn't change it: ${why}`;
          $("checks-msg").textContent = fixFailedText(c.label, why);
          if (btn.isConnected) btn.focus();
        });
      });
      actions.append(btn);
    }
    if (actions.childElementCount) li.append(actions);
    return li;
  }));
  if (hadFocus) {
    const again = hadFix ? $("checks").querySelector<HTMLElement>(`li[data-check="${CSS.escape(hadFix)}"] .check-fix`) : null;
    (again ?? ($("checks-fold").querySelector("summary") as HTMLElement)).focus();
  }
  failing = environment.checks.filter(c => c.status === "fail").length;
  const warn = environment.checks.filter(c => c.status === "warn").length;
  const view = setupView(environment.checks, { opened: checksOpened, beforeStart: checksBeforeStart });
  toLook = view.needing - failing;
  renderSetupBadge(view.needing, failing);
  const note = $("checks-note");
  // As `ember doctor` says it ("worth a look"), counted in words (copy.ts checksNote).
  note.textContent = view.note;
  note.className = `fold-note${failing ? " fail" : warn ? " warn" : ""}`;
  // A row needs the user (it fails, holds back reading or using apps, or has a button): the check opens by itself
  // (once), and it shows before Start too, until Start.
  if (view.open) { ($("checks-fold") as HTMLDetailsElement).open = true; checksOpened = true; }
  checksBeforeStart = view.beforeStart;
  $("checks-fold").closest("section")!.classList.toggle("after-setup", !checksBeforeStart);
  renderTagline();
}

/** The sidebar's Setup link carries how many rows need the user, so a warning is seen from anywhere (review #95). */
function renderSetupBadge(needing: number, fails: number): void {
  const link = document.querySelector<HTMLAnchorElement>("#jump a[href=\"#checks-h\"]");
  if (!link) return;
  const b = setupBadge(needing, fails);
  let el = link.querySelector<HTMLElement>(".jump-badge");
  if (!b) { el?.remove(); return; }
  if (!el) el = link.appendChild(document.createElement("span"));
  el.className = `jump-badge ${b.tone}`;
  // The number is for the eye; a screen reader hears the words after the link's name instead.
  const shown = Object.assign(document.createElement("span"), { textContent: b.text });
  shown.setAttribute("aria-hidden", "true");
  el.replaceChildren(shown, Object.assign(document.createElement("span"), { className: "sr", textContent: b.label }));
}

function render(status: Status): void {
  renderPlatform(status.platform);
  renderChecks(status.environment);
  renderAdmin(status.admin);
  const v = status.environment.versions;
  const facts: [string, string][] = [
    ["Ember", status.appVersion],
    ["Electron", `${v.electron ?? "?"} (Chromium ${v.chrome ?? "?"}, Node ${v.node})`],
    ["Settings", platform?.settingsFile ?? "~/.config/ember/settings.json"],
    ["Log file", status.logFile],
    // Somewhere to say what went wrong (review #105): the window never opens links, so the address is there to copy.
    ["Report a problem", ISSUES_URL],
  ];
  $("facts").replaceChildren(...facts.flatMap(([k, val]) => {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = val;
    return [dt, dd];
  }));
  $("about-note").textContent = `Ember ${status.appVersion}`;
  renderSettingsNotice(status.settingsNotice);
  applySettings(status.settings);
  targetsStatus(status);
}

// ───── What differs by OS: shortcuts, folders, the consent's OS sentences (from main; Linux's markup until then) ─────
/** The OS words main sent; undefined while no status named them (the page's own markup is Linux's). */
let platform: StatusPlatform | undefined;
/** Rich text as elements: key caps in <kbd>, commands and paths in <code>. */
const segmentNode = (s: Segment): Node => (typeof s === "string" ? document.createTextNode(s)
  : "kbd" in s ? Object.assign(document.createElement("kbd"), { textContent: s.kbd }) : Object.assign(document.createElement("code"), { textContent: s.code }));
function applyPatch(p: HomePatch): void {
  for (const el of document.querySelectorAll<HTMLElement>(p.selector)) {
    if (p.content) el.replaceChildren(...p.content.map(segmentNode));
    if (p.hidden !== undefined) el.hidden = p.hidden;
    for (const [name, value] of Object.entries(p.attrs ?? {})) el.setAttribute(name, value);
  }
}
/** The OS words on the page, to leave it alone when a fresh status brings the same ones (a screen reader keeps its place). */
let shownPlatform = "";
function renderPlatform(p: StatusPlatform | undefined): void {
  if (!p || JSON.stringify(p) === shownPlatform) return;
  shownPlatform = JSON.stringify(p);
  const before = JSON.stringify(entryWords(platform));
  if (!platform) useAppNames(p.os);
  platform = p;
  for (const patch of homePatches(p)) applyPatch(patch);
  const muted = micOffText(p.shortcuts.mute.label);
  if (VOICE_TEXT.muted !== muted) { VOICE_TEXT.muted = muted; if (voice) renderVoice(voice); }
  // Keys read differently on this OS: the lines already shown are written again.
  if (JSON.stringify(entryWords(p)) !== before) { shownActivity = ""; void refreshActivity(); }
  renderTagline();
}
// Permissions, the microphone switch and the login item change in the OS's own settings: off Linux the status is
// read again whenever the window comes back (rereadsStatusOnFocus says why Linux doesn't).
let refreshing = false;
window.addEventListener("focus", () => {
  if (!rereadsStatusOnFocus(platform) || refreshing) return;
  refreshing = true;
  window.ember.getStatus().then(s => {
    renderPlatform(s.platform);
    if (JSON.stringify(s.environment.checks) !== shownChecks) renderChecks(s.environment);
  }, () => { /* the next time the window comes back asks again */ }).finally(() => { refreshing = false; });
});

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
  cursor: "borrowing your mouse", desk: "Ember's own desk", screenImages: "sending screenshots", ...TARGET_FEATURE_TEXT,
};
/** The data list's "When you ask something" line as the page writes it, put back once Ember isn't locked down. */
let sendAsWritten: Node[] | null = null;
function renderAdmin(a: Status["admin"]): void {
  managed = new Set(a.managed);
  confirmEvery = a.confirmEveryAction;
  adminNeverLook = new Set((a.neverLook ?? []).map(x => x.trim().toLowerCase()));
  const el = $("managed");
  el.classList.toggle("error", !!a.error);
  const locked = lockdownNotice(a);
  if (locked) {
    el.hidden = false;
    el.textContent = locked;
  } else if (a.source) {
    const off = Object.entries(a.features).filter(([k, v]) => v === false && targetFeatureApplies(k, platform?.os)).map(([k]) => FEATURE_TEXT[k] ?? k);
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
  $("retention").textContent = keptWords(a);
  // Locked down, nothing goes to a model service: the data list says so instead of naming one.
  const send = document.querySelector<HTMLElement>("li[data-icon='send']");
  const sendLine = lockdownSendLine(a);
  if (send) {
    sendAsWritten ??= [...send.childNodes].map(n => n.cloneNode(true));
    send.replaceChildren(...(sendLine ? [Object.assign(document.createElement("b"), { textContent: "When you ask something" }), sendLine] : sendAsWritten.map(n => n.cloneNode(true))));
  }
  if (a.provider && !sendLine) $("model-service").textContent = `your organisation's model service (${new URL(a.provider).host})`;
  for (const [id, key] of [["wake", "wakeWord"], ["speak", "speak"], ["m-conductor", "models"], ["m-worker", "models"]] as const) {
    const input = $(id) as HTMLInputElement | HTMLSelectElement;
    input.disabled = managed.has(key);
    (input.closest(MANAGED_ROW) ?? input).classList.toggle("locked", managed.has(key));
    if (managed.has(key)) input.title = "Managed by your organisation";
  }
  privacyKey = "";
  if (settings) renderPrivacy(settings);
  if (voice) renderVoice(voice);
}

// ───── What Ember did ─────
const time = (t: string) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
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
  const words = entryWords(platform);
  for (const e of withCommandShells(entries)) {
    const d = describeEntry(e, words);
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
  // Without Ember's own GitHub App the button waits for a GitHub CLI sign-in: it doesn't promise a browser sign-in.
  $("sign-in").textContent = signInLabel(a.signInWith);
  $("retry").hidden = !notConnected || signingIn;
  $("retry").textContent = waiting ? "Reconnect now (stops the tasks that are running)" : "Check again";
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
        o.value = m.id; o.textContent = modelLabel(m); o.selected = m.id === current;
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
    void save({ models: { ...current, [key]: value } });
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
$("sign-in").addEventListener("click", () => {
  setSigningIn(true);
  $("cancel-sign-in").focus();
  window.ember.signIn().catch(err => {
    setSigningIn(false);
    // Not agreed yet: the way forward is the checkbox at the top, so go there.
    if (settings && settings.consent.version < CONSENT_VERSION) { focusAgree(); return; }
    signInMsg(ipcErrorText(err), true);
  });
});
/** What "Check again" found, while its message shows (it changes to "connected" when Copilot is ready). */
let retryFound: { found: boolean; source: string | null; hint?: string } | null = null;
$("retry").addEventListener("click", () => {
  signInMsg("Checking…");
  window.ember.retrySignIn().then(r => {
    retryFound = r.found ? r : null;
    say(retryMessage(r, r.found && agent?.phase === "ready"));
  }, err => signInMsg(ipcErrorText(err), true));
});
$("cancel-sign-in").addEventListener("click", () => { void window.ember.cancelSignIn(); });
$("sign-out").addEventListener("click", () => { void window.ember.signOut(); });

/** The device code row: "Code ABCD-1234 [Copy] Enter it at github.com/login/device [Open]". */
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
  // "Enter it at …" stays in one piece: wrapped, the row's next line starts with it (not with a dash).
  const parts: (string | Node)[] = ["Code ", code, copy, Object.assign(document.createElement("span"), { className: "nowrap", textContent: `Enter it at ${where}` })];
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
/** A button after the sign-in message that opens the page main offers (the GitHub CLI's download page). */
function addOpenButton(label: string): void {
  const open = (window.ember as EmberHomeApi & { openSignInPage?: () => Promise<void> }).openSignInPage;
  if (typeof open !== "function") return;
  const btn = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: label });
  btn.addEventListener("click", () => { void open(); });
  $("sign-in-msg").append(" ", btn);
}
window.ember.onSignInProgress(p => {
  if (p.state === "code") { showCode(p.userCode ?? "", p.verificationUri ?? ""); return; }
  if (p.state === "waiting") { setSigningIn(true); signInMsg(p.message ?? ""); if (p.link) addOpenButton(p.link); return; }
  setSigningIn(false);
  if (p.state === "cancelled") { signInMsg(""); return; }
  if (p.state === "done" && !p.message) { say("Signed in.", 3000); return; }
  signInMsg(p.message ?? "", p.state === "error");
});
void window.ember.agentStatus().then(renderAgent);
window.ember.onAgentStatus(renderAgent);

void window.ember.getStatus().then(render);
window.ember.onSettingsChanged(applySettings);
// Computers and Commands (§8.3): shown once the targets runtime answers, kept in step with the settings.
window.ember.onSettingsChanged(targetsSettings);
startTargets();

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
// A sidebar in a wide window (beside the content, so nothing scrolls under it), a row of links in a narrow one.
/** A section main asked for while it was still hidden (Computers shows once its list has come): shown once it shows. */
const pendingSection = new PendingSection();
/**
 * Shows a section (opening it if folded) and moves focus there: to the control main named ("computers:host", the
 * field to add a computer), else to the heading. A hidden section is shown once it appears, unless the user moves on.
 */
function showSection(value: string): void {
  const { section, control } = sectionRequest(value);
  const h = document.getElementById(`${section}-h`);
  if (!h) return;
  if (isHidden(h)) { pendingSection.hold(value); return; }
  pendingSection.drop();
  const fold = h.closest("details");
  if (fold) fold.open = true;
  const target = (fold?.querySelector("summary") ?? h) as HTMLElement;
  const field = control ? document.getElementById(control) : null;
  const to = field && !isHidden(field) ? field : target;
  const block = to === field ? "center" : "start";
  to.scrollIntoView({ block, behavior: calm ? "auto" : "smooth" });
  to.focus({ preventScroll: true });
  keptInView = { el: to, block, until: performance.now() + 3000 };
  markCurrent(section);
  // The scroll this starts (and a page too short to bring the section to the top) doesn't move the mark.
  pinnedUntil = performance.now() + 900;
}
let pinnedUntil = 0;
/**
 * What showSection just focused, brought back into view while sections above it are still appearing (Computers,
 * Commands come after the page has loaded and push it down) for a few seconds, until the user moves on.
 */
let keptInView: { el: HTMLElement; block: ScrollLogicalPosition; until: number } | null = null;
new ResizeObserver(() => {
  if (!keptInView || performance.now() > keptInView.until) { keptInView = null; return; }
  const r = keptInView.el.getBoundingClientRect();
  if (r.top < 0 || r.bottom > innerHeight) keptInView.el.scrollIntoView({ block: keptInView.block, behavior: "auto" });
}).observe(document.body);
// Main asks for a section ("Read all" on a long answer, connecting after setup).
window.ember.onFocusSection(showSection);
// A section that was hidden when main asked for it shows itself once it appears; a click, key or scroll first drops it.
new MutationObserver(() => {
  if (!pendingSection.waiting) return;
  const value = pendingSection.take(s => { const h = document.getElementById(`${s}-h`); return !!h && !isHidden(h); });
  if (value) showSection(value);
}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["hidden", "class"] });
for (const type of ["pointerdown", "keydown", "wheel"]) window.addEventListener(type, () => { pendingSection.drop(); keptInView = null; }, { capture: true, passive: true });
const jumpLinks = [...document.querySelectorAll<HTMLAnchorElement>("#jump a")];
const sectionOf = (a: HTMLAnchorElement) => (a.getAttribute("href") ?? "").replace(/^#/, "").replace(/-h$/, "");
$("jump").addEventListener("click", e => {
  const a = (e.target as Element).closest("a");
  if (!a) return;
  e.preventDefault();
  showSection(sectionOf(a));
});
// In the narrow row, Tab can stop on a link the row shows only part of: Chromium leaves it there, ring cut off.
$("jump").addEventListener("focusin", e => {
  (e.target as Element).closest("a")?.scrollIntoView({ block: "nearest", inline: "nearest" });
});
function markCurrent(section: string): void {
  for (const a of jumpLinks) {
    if (sectionOf(a) === section) a.setAttribute("aria-current", "true");
    else a.removeAttribute("aria-current");
  }
}
// The window opens at the top: the first section is the one you are in.
markCurrent(sectionOf(jumpLinks[0]));
// While scrolling: the link of the section at the top is marked.
let scrollQueued = false;
window.addEventListener("scroll", () => {
  if (scrollQueued || performance.now() < pinnedUntil) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    // At the end of the page the last sections can't scroll up to the line: the last one in view is marked.
    const atEnd = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
    let current = sectionOf(jumpLinks[0]);
    for (const a of jumpLinks) {
      const h = document.getElementById(`${sectionOf(a)}-h`);
      if (!h || isHidden(h)) continue;
      const top = h.getBoundingClientRect().top;
      if (top < 140 || (atEnd && top < innerHeight - 40)) current = sectionOf(a);
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
// ───── When Ember asks first ─────
$("trust-apps").addEventListener("change", e => { void save({ trust: { ...(settings?.trust ?? { askedApps: true, reviewCommands: false }), askedApps: (e.target as HTMLInputElement).checked } }); });
$("trust-commands").addEventListener("change", e => { void save({ trust: { ...(settings?.trust ?? { askedApps: true, reviewCommands: false }), reviewCommands: (e.target as HTMLInputElement).checked } }); });
function renderTrust(s: Settings): void {
  for (const row of trustView(s.trust, managed)) {
    const input = $(row.id) as HTMLInputElement;
    input.checked = row.checked;
    input.disabled = row.disabled;
    (input.closest(MANAGED_ROW) ?? input).classList.toggle("locked", row.locked);
    input.title = row.title;
    input.setAttribute("aria-describedby", row.describedBy);
  }
}

function renderPrivacy(s: Settings): void {
  renderTrust(s);
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
      void save({ grants: next });
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
        void save({ privacy: { neverLook: own.filter(x => x !== item) } });
      }, false)),
      ...theirs.map(item => row(neverLookLabel(item), () => {}, null)),
    ]
    : [Object.assign(document.createElement("li"), { className: "empty", textContent: "Nothing on the list. Ember still never reads password prompts." })]));
  $("never-look-defaults").hidden = missingDefaults(s.privacy.neverLook, platform?.os).length === 0;
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
  }, err => listMsg(saveFailedText(err)));
});
$("never-look-add").addEventListener("input", () => listMsg(""));
$("never-look-defaults").addEventListener("click", () => {
  if (!settings) return;
  const own = ownNeverLook(settings);
  const back = missingDefaults(settings.privacy.neverLook, platform?.os);
  const room = Math.max(0, NEVER_LOOK_MAX - own.length);
  void save({ privacy: { neverLook: [...own, ...back.slice(0, room)] } }).then(ok => { if (!ok) listMsg(""); });
  listMsg(room < back.length
    ? `The list is full (${NEVER_LOOK_MAX} names): remove some to restore the rest of the defaults.`
    : "The usual password managers and password prompts are back on the list.");
  $("never-look-add").focus();
});

// ───── Ember on screen (the handle menu's Ask / Stop everything / Hide / Stay put / Quit, reachable by keyboard) ─────
let presence: Presence | null = null;
function renderPresence(p: Presence): void {
  presence = p;
  $("p-hide").hidden = !p.overlay;
  $("p-follow").hidden = !p.overlay;
  $("p-hide").textContent = p.hidden ? "Show Ember" : "Hide Ember";
  $("p-follow").textContent = p.paused ? "Follow my cursor" : "Stay put";
  const line = !p.overlay
    ? `This desktop session can't show Ember beside your cursor, so it lives in the card in the ${handleCornerText(settings?.handlePosition)}.`
    : p.hidden
      ? "Ember is hidden. It shows itself again when it needs to ask you something."
      : p.paused ? "Ember stays where it is instead of following your cursor." : "Ember follows your cursor.";
  if ($("presence-text").textContent !== line) $("presence-text").textContent = line;
  renderTagline();
}
$("p-hide").addEventListener("click", () => { void window.ember.setPresence({ hidden: !(presence?.hidden ?? false) }).then(renderPresence); });
$("p-follow").addEventListener("click", () => { void window.ember.setPresence({ paused: !(presence?.paused ?? false) }).then(renderPresence); });
$("p-quit").addEventListener("click", () => { void window.ember.quit(); });
$("p-ask").addEventListener("click", () => { void window.ember.openAsk(); });
$("p-stop").addEventListener("click", () => { void window.ember.stopEverything(); });
void window.ember.presence().then(renderPresence);
window.ember.onPresence(renderPresence);

// ───── Voice ─────
const VOICE_TEXT: Record<string, string> = {
  off: "Off", "needs-models": "Speech models aren't downloaded yet (a one-time download)", downloading: "Downloading speech models…",
  starting: "Starting…", waiting: "Listening for “Ember”", active: "Hearing you…", muted: micOffText(), error: "Not working",
};
let voiceSettings: { wakeWord: boolean; consent: boolean } = { wakeWord: false, consent: false };
let voice: VoiceStatus | null = null;
/** No voice spoke Ember's replies (main found it): said under the Speak switch, with a row in the setup check. */
let speechMissing = false;
/** Screen readers hear the voice line when it changes, and a download only every 25 %. */
const voiceLive = (text: string) => { if ($("voice-live").textContent !== text) $("voice-live").textContent = text; };
/** The microphone's fix beside a voice error (Windows' privacy switch, macOS's permission), when the setup check has it. */
function renderVoiceFix(): void {
  const fix = voiceFix(voice?.state ?? "off", checksNow);
  const btn = $("voice-fix") as HTMLButtonElement;
  btn.hidden = !fix;
  if (fix) btn.textContent = platform?.fixLabels[fix] ?? "Open Settings";
}
$("voice-fix").addEventListener("click", () => {
  const fix = voiceFix(voice?.state ?? "off", checksNow);
  if (!fix) return;
  const btn = $("voice-fix") as HTMLButtonElement;
  btn.disabled = true;
  window.ember.applyFix(fix).then(renderChecks, err => {
    // Said on the voice line (and to screen readers) until the next voice status, as the setup check's button does.
    const text = voiceFixFailed(err);
    $("voice-text").textContent = text;
    voiceLive(text);
  }).finally(() => { btn.disabled = false; });
});
function renderVoice(v: VoiceStatus): void {
  voice = v;
  renderVoiceFix();
  const text = v.detail && v.state === "error" ? `${VOICE_TEXT.error}: ${v.detail}` : v.detail ?? VOICE_TEXT[v.state] ?? v.state;
  $("voice-text").textContent = text;
  // Teaching Ember a voice: its prompts are what screen readers hear; the voice line only when it changes.
  const said = renderMatch();
  if (said) voiceLive(said);
  else if (v.state !== "downloading" && text !== voiceLine) voiceLive(text);
  voiceLine = text;
  $("voice-dot").dataset.phase = v.state === "waiting" || v.state === "active" ? "ready" : v.state === "error" ? "error" : v.state === "off" || v.state === "muted" ? "" : "starting";
  const dl = $("voice-download") as HTMLButtonElement;
  // Listening turned off by the organisation: nothing to download it for.
  dl.hidden = v.modelsReady || v.state === "downloading" || managed.has("wakeWord");
  dl.textContent = `Download speech models (${Math.round(v.modelsBytes / 1e6)} MB)`;
  // One orange button per section: the download is the main thing only once "Hey Ember" is on.
  dl.classList.toggle("quiet", !(voiceSettings.wakeWord && voiceSettings.consent));
  ($("voice-progress") as HTMLProgressElement).hidden = v.state !== "downloading";
  const missing = v.speechMissing === true;
  if (missing !== speechMissing) {
    speechMissing = missing;
    const note = $("speak-note");
    note.hidden = !missing;
    note.textContent = missing ? SPEAK_NO_VOICE : "";
    // The setup check gains (or loses) its Speaking row.
    window.ember.getStatus().then(s => { if (JSON.stringify(s.environment.checks) !== shownChecks) renderChecks(s.environment); }, () => { /* shown at the next status */ });
  }
}
/** The voice line last shown, so a status that doesn't change it isn't said again after a Voice Match prompt. */
let voiceLine = "";
/** Voice Match as last drawn, and whether the user pressed Cancel since (for what is said when teaching ends). */
let shownMatch: VoiceStatus["match"];
let matchCancelled = false;
/** Draws Voice Match (match-copy.ts matchView) and returns what screen readers should hear, if anything. */
function renderMatch(): string | null {
  const m = voice?.match;
  const view = matchView(m, { listening: voiceSettings.wakeWord && voiceSettings.consent, managed: managed.has("wakeWord") });
  const group = $("match");
  // The control that has focus, if this draw hides or disables it: focus moves on (as after Download and the consent buttons).
  const had = document.activeElement instanceof HTMLElement && group.contains(document.activeElement) ? document.activeElement : null;
  group.hidden = view.hidden;
  const sw = $("match-on") as HTMLInputElement;
  sw.checked = view.checked;
  sw.disabled = view.disabled;
  $("match-text").textContent = view.text;
  const prompt = $("match-prompt");
  prompt.hidden = !view.prompt;
  prompt.textContent = view.prompt;
  const bar = $("match-progress") as HTMLProgressElement;
  bar.hidden = !view.progress;
  if (view.progress) { bar.max = view.progress.max; bar.value = view.progress.value; bar.setAttribute("aria-valuetext", view.progress.text); }
  else bar.removeAttribute("aria-valuetext");
  $("match-teach").hidden = view.teach.hidden;
  $("match-teach").textContent = view.teach.label;
  $("match-cancel").hidden = view.cancelHidden;
  $("match-forget").hidden = view.forgetHidden;
  if (had && (isHidden(had) || (had as HTMLInputElement).disabled)) focusFirst(view.focus);
  const said = matchAnnouncement(shownMatch, m, matchCancelled);
  if (!m?.enrolling) matchCancelled = false;
  shownMatch = m && { ...m, enrolling: m.enrolling && { ...m.enrolling } };
  return view.hidden ? null : said;
}
const startEnrol = () => {
  // Ember not listening just now: said where the switch's description is, and to screen readers. Otherwise focus
  // moves to Cancel once the first phrase is shown (renderMatch).
  void window.ember.enrolVoice().then(ok => { if (!ok) { $("match-text").textContent = MATCH_TEXT.notListening; voiceLive(MATCH_TEXT.notListening); } });
};
$("match-on").addEventListener("change", e => {
  const on = (e.target as HTMLInputElement).checked;
  // Nothing to match yet: turning it on teaches Ember the voice first (it turns on once that's done).
  if (on && !voice?.match?.enrolled) { (e.target as HTMLInputElement).checked = false; startEnrol(); return; }
  void save({ voice: { ...(settings?.voice ?? { consent: true, speakerRejection: true, muted: false }), match: on } });
});
$("match-teach").addEventListener("click", startEnrol);
// Teach comes back (and takes focus) once main says teaching stopped; Forget hides itself, so focus goes to Teach now.
$("match-cancel").addEventListener("click", () => { matchCancelled = true; void window.ember.cancelEnrolVoice(); });
$("match-forget").addEventListener("click", () => { void window.ember.forgetVoice(); focusFirst(["match-teach", "match-on", "wake"]); });
function applyVoiceSettings(s: Status["settings"]): void {
  voiceSettings = { wakeWord: s.wakeWord, consent: s.voice.consent };
  ($("wake") as HTMLInputElement).checked = s.wakeWord && s.voice.consent;
  ($("speak") as HTMLSelectElement).value = speakChoice(s);
  if (voice) renderVoice(voice);
}
$("wake").addEventListener("change", e => {
  const on = (e.target as HTMLInputElement).checked;
  // First time: the microphone note comes first, and focus moves to it so it is read and answered.
  if (on && !voiceSettings.consent) { $("consent").hidden = false; (e.target as HTMLInputElement).checked = false; $("consent-yes").focus(); return; }
  void save({ wakeWord: on });
});
$("consent-yes").addEventListener("click", () => {
  $("consent").hidden = true;
  void save({ wakeWord: true, voice: { muted: false, match: false, ...(settings?.voice ?? {}), consent: true, speakerRejection: true } });
  // Agreeing also fetches the speech models if they aren't here yet (one less step to find).
  if (!($("voice-download") as HTMLButtonElement).hidden) void window.ember.downloadVoice();
  $("wake").focus();
});
$("consent-no").addEventListener("click", () => { $("consent").hidden = true; $("wake").focus(); });
$("speak").addEventListener("change", e => { void save(speakSettings((e.target as HTMLSelectElement).value as SpeakChoice)); });
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
  // Once the last byte is in, the archive is checked and unpacked: said, so the bar doesn't look stuck (review #259).
  const doing = p.phase === "unpacking" ? "Unpacking" : "Downloading";
  $("voice-text").textContent = `${doing} speech models… ${pct}%`;
  voiceLive(`${doing} speech models… ${progressStep(p.done / p.total)}%`);
});
void window.ember.voiceStatus().then(renderVoice);
window.ember.onVoiceStatus(renderVoice);
window.ember.onSettingsChanged(applyVoiceSettings);
void window.ember.getStatus().then(st => applyVoiceSettings(st.settings));
