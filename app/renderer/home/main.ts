/**
 * Settings window (Home): until Start, only first run's steps show (welcome.ts); then one pane at a time, chosen in
 * the sidebar as System Settings does (docs/DESIGN.md "Home"). Home itself is the status panel (Ember's still ring,
 * its state, what is on, today, Ask and Stop everything), the conversation, Task activity and what Ember did; the
 * other panes are Your Ember (character, size, Ember on screen), Copilot, Voice, Memory, Apps & privacy, Computers,
 * Commands, Extensions, Comfort & access, and Setup & about.
 */

import { Rig, FACTORIES, type Character } from "@ember/characters";
import type { ActivityEntry, EmberHomeApi, MemoryView, Presence, RoutineRow, Status, StatusPlatform, UpdateStatus, VoiceStatus } from "../../shared/ipc";
import type { HistoryProblemKind } from "../../shared/conversation";
import { GLASS_CHOICES, GLASS_HINT, GLASS_LABEL, LISTEN_ONCE_READY, SPEAK_NO_VOICE, clearHearingLine, modelsDownloadLabel, setupBadge, setupView } from "./copy";
import { mountListenOnce } from "../shared/listen-once";
import {
  AUTONOMY_CONSENT_TEXT, autonomyHint, elevationOf, betterRecallDownloadLabel, betterRecallProgress, betterRecallText, type BetterRecallState, MEMORY_CONSENT_TEXT,
  memoryOwnerOffersErase, memoryOwnerText, MEMORY_PAUSED_TEXT, MEMORY_QUESTIONS_HINT, memoryPaused, ROUTINES_CONSENT_TEXT, UPDATES_CONSENT_TEXT, updateStatusText, deleteRoutineLabel, forgetMemoryLabel, handleCornerText, learnedLine, memoryEmptyText,
  memorySourceLabel, routinesEmptyText, MEMORY_SEARCH_LABEL, MEMORY_SOURCE_LABEL, MEMORY_ALL_SOURCES, MEMORY_SHOW_MORE, MEMORY_NO_MATCHES, memoryCountText, settingsResultText, SETTINGS_MORE_RESULTS, SETTINGS_RESULTS_LABEL, correctMemoryLabel, memoryProvenanceLabel, MEMORY_CORRECTION,
} from "./copy";
import { mountAboutYou } from "./about-you";
import { mountReminders } from "./reminders";
import { dismissForgetConfirms, mountForgetConfirms } from "./forget-confirm";
import { FEATURE_CONSENT_VERSION } from "../../shared/consent";
import { MATCH_TEXT, matchAnnouncement, matchView, trustView } from "./match-copy";
import { ISSUES_URL } from "../../shared/support";
import { CONSENT_VERSION } from "../../shared/consent";
import { useAppNames } from "../../shared/apps";
import { speakChoice, speakSettings, type SpeakChoice } from "../../shared/speech";
import type { Settings, SettingsPatch } from "../../main/settings";
import {
  dayLabel, describeEntry, entryWords, fixButtonName, fixFailedText, friendlyApp, homePatches, ipcErrorText, memoryDeleteFailedText, MANAGED_ROW, micOffText, missingDefaults, neverLookLabel, progressStep,
  conversationContextLine, rereadsStatusOnFocus, modelLabel, retryMessage, saveFailedText, signInLabel, STARTED_TEXT, tagline, usageLine, voiceFix, voiceFixFailed, withCommandShells,
  type HomePatch, type Segment,
} from "./copy";
import { startTargets, targetsSettings, targetsStatus } from "./computers";
import { extensionsStatus, startExtensions } from "./extensions";
import { onProviderDestination, ownProvider, providerSettings, startProvider } from "./provider";
import { modelDestination, recipientWords } from "./copy";
import { mountProject } from "./project";
import { homeConnectionView, ownProviderOffer, taskModelChoices } from "./first-run-copy";
import { mountNaturalVoice } from "./natural-voice";
import { keptWords, lockdownNotice, lockdownSendLine, turnedOffWords } from "./admin-copy";
import { PendingSection, sectionRequest } from "./section-request";
import { startWelcome } from "./welcome";
import { startTasks } from "./tasks";
import { memoryWhatsOn, setupLinkText, statusWord, taskCounts, todayCounts, todaySummary, whatsOnText } from "./status-copy";
import { SEARCH_ALIASES, searchMatches, searchMessage } from "./search-copy";
import { conversationChange, conversationShown, earlierLabel } from "./conversation-view";
import { NO_STREAM, STOPPED_NOTE, streamEntries, streamEvent, type StreamEvent } from "./conversation-stream";
import { CONVERSATION_EDIT, CONVERSATION_KEEP_HINT, CONVERSATION_KEEP_LABEL, conversationKeepProblem, conversationRetention, CONVERSATION_SCOPE, CONVERSATION_TRUNCATED, conversationMatchesText, conversationSearchCount } from "./copy";
import { markHeard, personalMatch, personalSettings, startPersonal } from "./personal";
import { KeyedRows } from "./keyed-rows";
import { mountLearnedUndo } from "./learned-undo";
import { mountMemoryCorrection } from "./memory-correction";
import { MEMORY_PAGE_SIZE, MEMORY_SOURCES, memoryPage } from "./memory-view";
import type { TaskEntry } from "../../shared/activity";

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

/** Whether an element is hidden by its own page's rules (itself or a parent), whichever pane shows. */
const hiddenHere = (el: Element) => el instanceof HTMLElement && (el.hidden || !!el.closest("[hidden]") || el.closest("body.first-run .after-setup") !== null);
/** Whether an element is (now) hidden, itself or by a parent, or on a pane not shown. */
const isHidden = (el: Element) => hiddenHere(el) || el.closest("body:not(.first-run) .off-pane") !== null;
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
/** Memory (Settings › Conversation): see the Memory part below. Declared here: applySettings shows its switch. */
type MemoryRow = MemoryView["rows"][number];
const MEMORY_VERSION = FEATURE_CONSENT_VERSION.memory;
const ROUTINES_VERSION = FEATURE_CONSENT_VERSION.routines;
const AUTONOMY_VERSION = FEATURE_CONSENT_VERSION.autonomy;
let memoryRows: MemoryRow[] = [];
let routineRows: RoutineRow[] = [];
/** The routine whose Delete was pressed: focus goes to the one now in its place. */
let routineFocus: number | null = null;
function applySettings(s: Settings): void {
  const changed = settings?.character !== s.character;
  settings = s;
  renderTaskReasoning();
  applyCalm();
  for (const c of cards) {
    const on = c.id === s.character;
    c.el.setAttribute("aria-checked", String(on));
    c.el.tabIndex = on ? 0 : -1;
    if (on && changed) c.rig.setEmotion("happy");
    if (!on) c.rig.setEmotion("neutral");
  }
  if (!sliding && document.activeElement !== size) showSize(s.size);
  applyMemorySettings(s);
  applyRoutineSettings(s);
  applyUpdateSettings(s);
  applyAutonomySettings(s);
  providerSettings(s);
  ($("login") as HTMLInputElement).checked = s.startAtLogin;
  ($("keep-conversation") as HTMLInputElement).checked = s.keepConversation;
  $("conversation-retention").textContent = conversationRetention(s.keepConversation);
  ($("reduce-motion") as HTMLInputElement).checked = s.reduceMotion;
  ($("more-time") as HTMLInputElement).checked = s.moreTime;
  ($("appearance") as HTMLSelectElement).value = s.appearance;
  ($("text-size") as HTMLSelectElement).value = s.textSize;
  ($("glass") as HTMLSelectElement).value = s.glass ?? "regular";
  ($("handle-position") as HTMLSelectElement).value = s.handlePosition;
  // The copy that names the handle's corner follows Handle position (review #75).
  const corner = handleCornerText(s.handlePosition);
  if ($("handle-corner").textContent !== corner) $("handle-corner").textContent = corner;
  if (presence) renderPresence(presence);
  // First run (or changed terms): its steps come first, the consent among them (welcome.ts); everything else waits
  // until Ember has started. Start pressed here: focus moves to the top of the settings, and Ember says it started
  // (review #50), rather than dropping to the page.
  const started = welcome.settings(s);
  document.body.classList.toggle("first-run", !s.onboarded);
  document.body.classList.remove("loading");
  $("pick-h").textContent = s.onboarded ? "Your Ember" : "Choose your Ember";
  renderPrivacy(s);
  renderTagline();
  if (started) {
    $("home-live").textContent = STARTED_TEXT;
    showPane("home");
    window.scrollTo({ top: 0 });
    $("home-h").focus({ preventScroll: true });
  }
  renderStatus();
}
// First run, one step at a time: it borrows the character and the cards until Start, and its fixes reach the setup check.
const welcome = startWelcome({ save, buddy: heroCanvas, cards: $("cards"), checksChanged: env => renderChecks(env), arrived: () => { if (!calm) { heroRig.setEmotion("happy"); drawSoon(); } } });
// Never a blank window, even if the first status is slow.
setTimeout(() => document.body.classList.remove("loading"), 1500);
$("login").addEventListener("change", e => { void save({ startAtLogin: (e.target as HTMLInputElement).checked }); });
$("reduce-motion").addEventListener("change", e => { void save({ reduceMotion: (e.target as HTMLInputElement).checked }); });
$("more-time").addEventListener("change", e => { void save({ moreTime: (e.target as HTMLInputElement).checked }); });
// The text size reaches every window from main (page-prefs.ts), this one included.
$("appearance").addEventListener("change", e => { void save({ appearance: (e.target as HTMLSelectElement).value as Settings["appearance"] }); });
$("text-size").addEventListener("change", e => { void save({ textSize: (e.target as HTMLSelectElement).value as Settings["textSize"] }); });
// Comfort & access › Glass: its choices and words from copy.ts.
$("glass-label").textContent = GLASS_LABEL;
$("glass-hint").textContent = GLASS_HINT;
$("glass").replaceChildren(...GLASS_CHOICES.map(c => Object.assign(document.createElement("option"), { value: c.value, textContent: c.label })));
$("glass").addEventListener("change", e => { void save({ glass: (e.target as HTMLSelectElement).value as Settings["glass"] }); });
// The handle (and its task cards) moves as main hears the change (handle.ts, overlay/main.ts).
$("handle-position").addEventListener("change", e => { void save({ handlePosition: (e.target as HTMLSelectElement).value as Settings["handlePosition"] }); });

size.addEventListener("input", () => {
  const v = Number(size.value);
  sizeLabel(v);
  void save({ size: v });
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

// ───── The line under the title: recomputed whenever anything it depends on changes ─────
let failing = 0;
/** Setup rows that don't fail but need the user: the status panel's link under the tagline names them (it opens the pane). */
let toLook = 0;
function renderTagline(): void {
  // The tagline leaves the rows worth a look to the link under it, which goes to them (owner review).
  const text = tagline({
    failing, look: 0, onboarded: settings?.onboarded ?? false, phase: agent?.phase ?? null, waitingForTasks: agent?.waitingForTasks === true,
    hidden: presence?.hidden ?? false, overlay: presence?.overlay ?? true, corner: settings?.handlePosition,
  }, platform?.shortcuts.ask.label);
  if ($("tagline").textContent !== text) $("tagline").textContent = text;
  renderStatus();
}

// ───── Home's status panel: the still ring, Ember's state, what is on, today, and its actions ─────
/** The tasks as Task activity last heard them; today's counts from the audit's recent entries. */
let tasksNow: TaskEntry[] = [];
let today = { tasks: 0, approvals: 0 };
const setText = (id: string, text: string) => { if ($(id).textContent !== text) $(id).textContent = text; };
function renderStatus(): void {
  const { running, asking: askingTasks } = taskCounts(tasksNow);
  const asking = Math.max(askingTasks, presence?.approval ? 1 : 0);
  const s = statusWord({ phase: agent?.phase ?? null, failing, waitingForTasks: agent?.waitingForTasks === true, running, asking });
  setText("state-word", s.word);
  $("ring").dataset.ring = s.ring;
  $("state-word").dataset.ring = s.ring;
  const v = voice?.state;
  const listening = !!settings?.wakeWord && !!settings?.voice.consent;
  setText("whats-on", whatsOnText({
    voice: !listening ? "off" : v === "muted" ? "muted" : "listening",
    memory: memoryWhatsOn(!!settings?.memory.on && (settings?.memory.consent.version ?? 0) >= MEMORY_VERSION, !!settings && memoryPaused(settings.memory), memoryOwner),
    commands: Object.values(settings?.commands ?? {}).filter(c => c?.on).length,
    computers: settings?.targets.hosts.length ?? 0,
    wsl: !!settings?.targets.wsl.on,
  }));
  setText("today", todaySummary(tasksNow, today));
  // Copilot not connected: connecting it is the one prominent action here, and Ask steps back.
  const notConnected = (agent?.phase === "signed-out" || agent?.phase === "error") && agent?.waitingForTasks !== true;
  $("p-connect").hidden = !notConnected;
  $("p-ask").classList.toggle("quiet", notConnected);
  $("p-waiting").hidden = !asking;
  const setup = setupLinkText(failing, toLook);
  $("p-setup").hidden = !setup;
  setText("p-setup", setup ?? "");
}
$("p-setup").addEventListener("click", () => showSection("checks"));
$("p-connect").addEventListener("click", () => showSection("copilot"));
// Home opens the exact live approval in its own focusable window; main owns question identity and authority.
const openApproval = () => { void window.ember.openApproval(); };
$("p-waiting").addEventListener("click", openApproval);
$("tasks-open-approval").addEventListener("click", openApproval);

// ───── Setup check and build facts ─────
let checksOpened = false;
/** The setup check shows on the first-run screen (a row needed the user), and stays there until Start. */
let checksBeforeStart = false;
/** The checks on screen, to leave them alone when a fresh status brings the same ones. */
let shownChecks = "";
/** The setup check's rows as last shown: the voice line's fix button comes from its microphone row. */
let checksNow: Status["environment"]["checks"] = [];
/** Whether the organisation manages "Work without asking" (applyAutonomySettings): its hint is redrawn with the checks. */
let autonomyManaged = false;
function renderChecks(environment: Status["environment"]): void {
  shownChecks = JSON.stringify(environment.checks);
  checksNow = environment.checks;
  // The switch's hint says when Ember runs elevated (every command asks then).
  $("autonomy-hint").textContent = autonomyHint(autonomyManaged, elevationOf(checksNow));
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
  const view = setupView(environment.checks, { opened: checksOpened, beforeStart: checksBeforeStart });
  toLook = view.needing - failing;
  renderSetupBadge(view.needing, failing);
  const note = $("checks-note");
  // As `ember doctor` says it ("worth a look"), counted in words (copy.ts checksNote): the same count as the tagline's
  // and the sidebar's badge (UI audit #6).
  note.textContent = view.note;
  note.className = `fold-note${failing ? " fail" : view.needing ? " warn" : ""}`;
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
  welcome.status(status);
  const v = status.environment.versions;
  // Paths are set in the mono face (they are values to copy); versions and the address read as words (UI audit #15).
  const facts: [string, string, "path" | "text" | "copy"][] = [
    ["Ember", status.appVersion, "text"],
    ["Electron", `${v.electron ?? "?"} (Chromium ${v.chrome ?? "?"}, Node ${v.node})`, "text"],
    ["Settings", platform?.settingsFile ?? "~/.config/ember/settings.json", "path"],
    ["Log file", status.logFile, "path"],
    // Somewhere to say what went wrong (review #105): the window never opens links, so the address is there to copy.
    ["Report a problem", ISSUES_URL, "copy"],
  ];
  $("facts").replaceChildren(...facts.flatMap(([k, val, kind]) => {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.className = kind === "path" ? "path" : "plain";
    dd.append(Object.assign(document.createElement("span"), { textContent: val }));
    if (kind === "copy") {
      const copy = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: "Copy" });
      copy.setAttribute("aria-label", `Copy the address ${val}`);
      // Through main (pages get no clipboard permission), as the sign-in code is copied.
      copy.addEventListener("click", () => { window.ember.copyText(val).then(() => { copy.textContent = "Copied"; }, () => { copy.textContent = "Couldn't copy"; }); });
      dd.append(copy);
    }
    return [dt, dd];
  }));
  $("about-note").textContent = `Ember ${status.appVersion}`;
  renderSettingsNotice(status.settingsNotice);
  applySettings(status.settings);
  targetsStatus(status);
  extensionsStatus(status);
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
  // Keep the voice choice available while platform capabilities are refreshed.
  renderNatural();
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
/** The data list's "When you ask something" line as the page writes it, put back once Ember isn't locked down. */
let sendAsWritten: Node[] | null = null;
let lastAdmin: Status["admin"] | null = null;
/**
 * Names where requests actually go (copy.ts modelDestination) in the data list's "When you ask something" line and in
 * the microphone note and its list item, so none says Copilot while another service answers. Runs whenever the policy
 * or the user's provider changes, so the note is never stale when it is read.
 */
function renderRecipient(): void {
  const a = lastAdmin;
  if (!a) return;
  const d = modelDestination({ locked: !!lockdownSendLine(a), adminProvider: a.provider ?? null, own: ownProvider() });
  const service = document.querySelector<HTMLElement>("#w-full #model-service");
  // The locked-down line replaces the sentence (and this span) altogether.
  if (service && d.kind !== "none") service.textContent = recipientWords(d, true);
  for (const el of document.querySelectorAll<HTMLElement>(".model-recipient")) {
    const words = recipientWords(d);
    if (el.textContent !== words) el.textContent = words;
  }
  // Agreeing to "sent to …" needs the recipient named: unknown, "I agree" waits (aria-disabled keeps it focusable).
  const yes = $("consent-yes");
  if (d.kind === "unknown") yes.setAttribute("aria-disabled", "true"); else yes.removeAttribute("aria-disabled");
}
onProviderDestination(renderRecipient);
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
    const off = turnedOffWords(a.features, platform?.os);
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
  // The full consent text's line (first run's short form beside it is welcome.ts's own, drawn from the status).
  const send = document.querySelector<HTMLElement>("#w-full li[data-icon='send']");
  const sendLine = lockdownSendLine(a);
  if (send) {
    sendAsWritten ??= [...send.childNodes].map(n => n.cloneNode(true));
    send.replaceChildren(...(sendLine ? [Object.assign(document.createElement("b"), { textContent: "When you ask something" }), sendLine] : sendAsWritten.map(n => n.cloneNode(true))));
  }
  lastAdmin = a;
  if (agent) renderAgent(agent);
  renderRecipient();
  for (const [id, key] of [["wake", "wakeWord"], ["speak", "speak"], ["speak-results", "speak"], ["natural-model", "naturalVoice"], ["m-conductor", "models"], ["m-worker", "models"], ["memory-on", "memory"], ["updates-on", "updates"], ["routines-on", "routines"], ["autonomy-on", "autonomy"]] as const) {
    const input = $(id) as HTMLInputElement | HTMLSelectElement;
    input.disabled = managed.has(key);
    (input.closest(MANAGED_ROW) ?? input).classList.toggle("locked", managed.has(key));
    if (managed.has(key)) input.title = "Managed by your organisation";
  }
  privacyKey = "";
  renderTaskReasoning();
  if (settings) renderPrivacy(settings);
  if (voice) renderVoice(voice);
  if (settings) applyMemorySettings(settings);
  if (settings) applyRoutineSettings(settings);
  if (settings) applyAutonomySettings(settings);
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
  today = todayCounts(entries);
  renderStatus();
  let day = "";
  let todayRows = 0;
  const items: HTMLLIElement[] = [];
  const words = entryWords(platform);
  for (const e of withCommandShells(entries)) {
    const d = describeEntry(e, words);
    if (!d) continue;
    if (items.length >= 80) break;
    // A heading for each day ("Today", "Yesterday", then dates): the list covers up to a month.
    const label = dayLabel(e.t);
    if (label === "Today") todayRows++;
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
  $("activity-note").textContent = todayRows ? `${todayRows} today` : "";
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
const COPILOT_BUTTONS = ["sign-in", "own-provider", "switch-account", "cancel-sign-in", "retry", "sign-out"];
let agent: AgentStatus | null = null;
let signingIn = false;
let modelsKey = "";
let taskReasoningKey = "";
const effortLabels = { low: "Low", medium: "Medium", high: "High", xhigh: "Very high", max: "Maximum" };

function taskReasoningModel(): AgentStatus["models"][number] | undefined {
  if (!settings || agent?.phase !== "ready" || agent.service || managed.has("models")) return undefined;
  const workerModel = agent.workerModel;
  return agent.models.find(m => m.id === workerModel && m.reasoningEfforts?.length);
}

function renderTaskReasoning(): void {
  const model = taskReasoningModel();
  const levels = model?.reasoningEfforts ?? [];
  const preference = settings?.taskReasoning;
  const chosen = preference && preference.model === model?.id && levels.includes(preference.effort) ? preference.effort : "";
  const key = JSON.stringify([model?.id, levels, chosen]);
  if (key === taskReasoningKey) return;
  taskReasoningKey = key;
  const select = $("m-worker-effort") as HTMLSelectElement;
  select.hidden = $("m-worker-effort-label").hidden = $("m-worker-effort-hint").hidden = !model;
  if (!model) return;
  select.replaceChildren(new Option("Model default", ""), ...levels.map(level => new Option(effortLabels[level], level)));
  select.value = chosen;
}

const projectReady = mountProject();
function renderAgent(a: AgentStatus | null): void {
  if (!a) return;
  agent = a;
  projectReady(a.phase === "ready", a.service?.host ?? "GitHub Copilot", a.conductorModel);
  const had = document.activeElement;
  ($("agent-dot") as HTMLElement).dataset.phase = a.phase;
  $("agent-text").textContent = a.detail;
  // Copilot stopped answering with tasks at work: Ember reconnects once they're done. Signing in again isn't the
  // fix, and reconnecting now stops the tasks: the button says so.
  const waiting = a.waitingForTasks === true;
  // What leads depends on why Copilot isn't connected (FE #3): an account without Copilot is not asked to sign in again.
  const a2 = lastAdmin;
  const view = homeConnectionView({
    phase: a.phase, reason: a.reason, detail: a.detail, signingIn, waiting,
    ownOffered: ownProviderOffer({
      bridge: !!window.emberProvider, managedProvider: !!a2?.provider, locked: !!a2 && a2.error !== null,
      userProviderOff: a2?.features.userProvider === false,
    }).offered,
  });
  $("sign-in").hidden = !view.show["sign-in"] || waiting;
  // Without Ember's own GitHub App the button waits for a GitHub CLI sign-in: it doesn't promise a browser sign-in.
  $("sign-in").textContent = signInLabel(a.signInWith);
  $("own-provider").hidden = !view.show["own-provider"];
  $("switch-account").hidden = !view.show["switch-account"];
  // Only the leading action is filled: one prominent button in the group.
  $("sign-in").classList.toggle("quiet", view.primary !== "sign-in");
  $("own-provider").classList.toggle("quiet", view.primary !== "own-provider");
  $("switch-account").classList.toggle("quiet", view.primary !== "switch-account");
  $("connection-help").hidden = !view.help;
  if ($("connection-help").textContent !== view.help) $("connection-help").textContent = view.help;
  $("retry").hidden = !view.show.retry;
  $("retry").classList.toggle("quiet", view.primary !== "retry");
  $("retry").textContent = waiting ? "Reconnect now (stops the tasks that are running)" : "Check again";
  $("cancel-sign-in").hidden = !signingIn;
  $("sign-out").hidden = a.phase !== "ready" || !a.login;
  // With the user's own provider, its models are chosen in its own rows (Model provider), not from Copilot's list.
  $("models").hidden = a.phase !== "ready" || a.models.length === 0 || a.service?.kind === "user";
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
    // No model reads images: every model is listed, the one in use selected, and the limit is said (FE #5).
    const tasks = taskModelChoices(a.models, a.workerModel);
    fill("m-worker", tasks.options, a.workerModel);
    $("m-worker-label").textContent = tasks.label;
    $("m-worker-note").textContent = tasks.note;
    $("m-worker-note").hidden = !tasks.note;
  }
  $("usage").textContent = usageLine(a.usage);
  $("conversation-context").textContent = conversationContextLine(a.phase === "ready" ? a.conversationContext : undefined);
  renderTaskReasoning();
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
$("m-worker-effort").addEventListener("change", e => {
  const model = taskReasoningModel();
  if (!model) return;
  const value = (e.target as HTMLSelectElement).value;
  const effort = model.reasoningEfforts?.find(level => level === value);
  if (value && !effort) return;
  void save({ taskReasoning: effort ? { model: model.id, effort } : null });
});
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
    // Not agreed yet: the way forward is first run's consent step, so go there.
    if (settings && settings.consent.version < CONSENT_VERSION) { welcome.toConsent(); return; }
    signInMsg(ipcErrorText(err), true);
  });
});
/** What "Check again" found, while its message shows (it changes to "connected" when Copilot is ready). */
let retryFound: { found: boolean; source: string | null; hint?: string } | null = null;
// "Try a different GitHub account" is the same sign-in: GitHub's page lets them choose another account.
$("switch-account").addEventListener("click", () => $("sign-in").click());
// The user's own provider is the group under this one: its switch is the way in.
$("own-provider").addEventListener("click", () => {
  const sw = $("byok-on");
  sw.scrollIntoView({ block: "center" });
  sw.focus();
});
$("retry").addEventListener("click", () => {
  signInMsg("Checking…");
  window.ember.retrySignIn().then(r => {
    retryFound = r.found ? r : null;
    say(retryMessage(r, r.found && agent?.phase === "ready"));
  }, err => signInMsg(ipcErrorText(err), true));
});
$("cancel-sign-in").addEventListener("click", () => { void window.ember.cancelSignIn(); });
mountForgetConfirms(window.ember, {
  signOutFailed: err => signInMsg(memoryDeleteFailedText(err), true),
  deleteMemory: remove => deleteMemory($("memory-forget-all") as HTMLButtonElement, remove),
});

/** The device code row: "Code ABCD-1234 [Copy] Enter it at github.com/login/device [Open]". */
function showCode(userCode: string, uri: string): void {
  const msg = $("sign-in-msg");
  msg.hidden = false;
  msg.classList.remove("error");
  const code = Object.assign(document.createElement("code"), { textContent: userCode });
  const copy = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: "Copy" });
  copy.setAttribute("aria-label", `Copy the code ${userCode}`);
  // Main copies it: the page has no clipboard permission (every web permission is denied but the mic window's audio).
  copy.addEventListener("click", () => { window.ember.copyText(userCode).then(() => { copy.textContent = "Copied"; }, () => { copy.textContent = "Couldn't copy"; }); });
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
// Extensions, plugins and connectors: what main says is added, and the catalogs (only the user adds, here).
startExtensions();
// The user's own model provider (Copilot › Model provider): its key goes to main once and never comes back.
startProvider(save);
// Voice personalisation (Settings › Voice; the conversation's “That's not what I said”).
startPersonal(save);
// Task activity (in memory only): each task this session, and the status panel's count of those at work.
startTasks(t => { tasksNow = t; renderStatus(); });

// ───── Conversation (this session only) ─────
type Entry = Awaited<ReturnType<EmberHomeApi["conversation"]>>[number];
const WHO: Record<string, string> = { you: "You", ember: "Ember", task: "Task", problem: "Problem" };
let shownConversation: Entry[] = [];
const conversationMessage = $("conversation-message") as HTMLTextAreaElement;
const conversationSearch = $("conversation-search") as HTMLInputElement;
const conversationComposeStatus = $("conversation-compose-status");
let conversationAwaitingReply = false;
let conversationLastAtSend: Entry | undefined;
let conversationDraftBeforeEdit: string | null = null;
let conversationGeneration = 0;
$("conversation-scope").textContent = CONVERSATION_SCOPE;
$("conversation-retention").textContent = conversationRetention(false);
$("keep-conversation-label").textContent = CONVERSATION_KEEP_LABEL;
$("keep-conversation-hint").textContent = CONVERSATION_KEEP_HINT;
// Never silent: the saved copy that couldn't be written or deleted is said under the switch.
{
  const showProblem = (p: HistoryProblemKind | null) => { $("keep-conversation-problem").textContent = conversationKeepProblem(p); };
  void window.ember.historyProblem().then(showProblem, () => undefined);
  window.ember.onHistoryProblem(showProblem);
}
$("keep-conversation").addEventListener("change", e => { void save({ keepConversation: (e.target as HTMLInputElement).checked }); });
function conversationRow(e: Entry): HTMLLIElement {
  const li = document.createElement("li");
  li.className = e.who;
  // "Ember learned: …" with Undo (forgets that fact): a small line of its own, not a message.
  if (e.who === "learned") {
    const text = Object.assign(document.createElement("p"), { textContent: learnedLine(e.text) });
    li.append(text);
    const id = e.fact;
    if (id) mountLearnedUndo(li, e.text, id, window.ember.forgetMemory);
    return li;
  }
  const who = Object.assign(document.createElement("span"), { className: "who", textContent: WHO[e.who] ?? e.who });
  const t = Object.assign(document.createElement("time"), { textContent: time(e.t), dateTime: e.t });
  const text = Object.assign(document.createElement("p"), { textContent: e.text });
  // A request Ember heard: "That's not what I said" finds its row by this (personal.ts markHeard).
  if (e.heardId) li.dataset.heardId = String(e.heardId);
  li.append(who, t, text);
  const actions = Object.assign(document.createElement("div"), { className: "conversation-message-actions" });
  if (e.who === "ember" || e.who === "you") {
    const copy = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: "Copy" });
    copy.setAttribute("aria-label", `Copy ${e.who === "you" ? "your message" : "Ember’s answer"} from ${time(e.t)}`);
    copy.addEventListener("click", () => {
      copy.disabled = true;
      void window.ember.copyText(e.text).then(() => { conversationComposeStatus.textContent = "Copied message."; }, () => {
        conversationComposeStatus.textContent = "Couldn’t copy this message. Select its text and copy it manually.";
      }).finally(() => { copy.disabled = false; });
    });
    actions.append(copy);
  }
  if (e.who === "you") {
    const edit = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: "Edit" });
    edit.setAttribute("aria-label", `Edit your message from ${time(e.t)} as a new request`);
    edit.addEventListener("click", () => {
      // Editing has no IPC side effect: Send is a new, deliberate typed request, never a tool/voice/suggestion replay.
      if (conversationDraftBeforeEdit === null) conversationDraftBeforeEdit = conversationMessage.value;
      $("conversation-cancel-edit").hidden = false;
      conversationMessage.value = e.text;
      conversationComposeStatus.textContent = CONVERSATION_EDIT;
      conversationMessage.focus();
    });
    actions.append(edit);
  }
  if (actions.childElementCount) li.append(actions);
  if (e.stopped) li.append(Object.assign(document.createElement("small"), { className: "conversation-limit", textContent: STOPPED_NOTE }));
  if (e.truncated) li.append(Object.assign(document.createElement("small"), { className: "conversation-limit", textContent: CONVERSATION_TRUNCATED }));
  return li;
}
/**
 * The conversation is part of the page, not a box that scrolls inside it (UI audit #1): its latest messages, and "Show
 * earlier messages" for the rest (conversation-view.ts). Rows are matched by what they are, so a new message is added in
 * place and the oldest shown goes from the top; nothing scrolls the page on its own.
 */
/** Every message, once "Show earlier messages" was pressed (until the conversation is forgotten). */
let conversationAllShown = false;
let conversationAll: Entry[] = [];
/** The answer being written: one row that grows in place (conversation-stream.ts), kept apart from the messages' rows. */
let answerStream = NO_STREAM;
let streamRowEl: HTMLLIElement | null = null;
let streamRowId = 0;
/** Draws the answer being written (or stopped short) as the last row; the same element for every word of one answer. */
function syncStreamRow(list: HTMLElement): void {
  const row = answerStream.row;
  if (!row) { streamRowEl?.remove(); streamRowEl = null; return; }
  if (!streamRowEl || streamRowId !== row.id) {
    streamRowEl?.remove();
    const li = document.createElement("li");
    li.className = "ember";
    li.dataset.streamId = String(row.id);
    li.append(
      Object.assign(document.createElement("span"), { className: "who", textContent: WHO.ember }),
      Object.assign(document.createElement("time"), { textContent: time(row.t), dateTime: row.t }),
      document.createElement("p"),
    );
    streamRowEl = li;
    streamRowId = row.id;
  }
  const li = streamRowEl;
  (li.querySelector("p") as HTMLElement).textContent = row.text;
  // A screen reader waits for the finished answer (the status line says when it came) rather than reading every word.
  if (row.phase === "streaming") li.setAttribute("aria-busy", "true"); else li.removeAttribute("aria-busy");
  li.dataset.phase = row.phase;
  const note = li.querySelector("small");
  if (row.phase === "interrupted" && !note) li.append(Object.assign(document.createElement("small"), { className: "conversation-limit", textContent: STOPPED_NOTE }));
  const q = conversationSearch.value.trim();
  li.hidden = !!q && !conversationMatchesText(row.text, q);
  if (li.parentElement !== list || li !== list.lastElementChild) list.append(li);
}
function renderConversation(raw: Entry[]): void {
  answerStream = streamEntries(answerStream, raw);
  const entries = raw;
  // Forgotten (signed out, another account): back to the latest messages.
  if (!entries.length) {
    conversationAllShown = false;
  }
  conversationAll = raw;
  const list = $("conversation");
  // Out of the way while the messages' rows change (their changes count rows from the top), back at the end after.
  streamRowEl?.remove();
  const searching = !!conversationSearch.value.trim();
  const shown = conversationShown(entries, conversationAllShown || searching);
  const { drop, add } = conversationChange(shownConversation, shown);
  for (let i = 0; i < drop; i++) list.firstElementChild?.remove();
  list.append(...add.map(conversationRow));
  shownConversation = shown;
  let matches = 0;
  for (let i = 0; i < shown.length; i++) {
    const match = !searching || conversationMatchesText(shown[i].text, conversationSearch.value);
    (list.children[i] as HTMLElement).hidden = !match;
    if (match) matches++;
  }
  $("conversation-search-status").textContent = searching ? conversationSearchCount(matches) : "";
  syncStreamRow(list);
  const latest = raw.at(-1);
  const newReply = latest && (latest.t !== conversationLastAtSend?.t || latest.who !== conversationLastAtSend?.who || latest.text !== conversationLastAtSend?.text);
  // (An answer stopped short is not a reply received: the problem that follows it, or the Stop, says what happened.)
  if (conversationAwaitingReply && newReply && (latest.who === "problem" || (latest.who === "ember" && !latest.stopped))) {
    conversationAwaitingReply = false;
    conversationComposeStatus.textContent = raw.at(-1)?.who === "problem" ? "Ember couldn’t finish this reply. Review the message above; you can edit your request and send again." : "Reply received.";
  }
  // Requests Ember heard (not typed) offer “That's not what I said”.
  markHeard(list);
  const earlier = $("conversation-earlier") as HTMLButtonElement;
  const label = earlierLabel(entries.length - shown.length);
  earlier.hidden = !label;
  if (label) earlier.textContent = label;
}
$("conversation-earlier").addEventListener("click", () => {
  // Every message from the first, from now on; focus goes to the heading above them (the button goes).
  conversationAllShown = true;
  shownConversation = [];
  $("conversation").replaceChildren();
  renderConversation(conversationAll);
  $("conversation-h").focus();
});
const conversationOpened = conversationGeneration;
let conversationReceived = false;
void window.ember.conversation().then(entries => {
  if (!conversationReceived && conversationOpened === conversationGeneration) renderConversation(entries);
}, () => { if (!conversationReceived && conversationOpened === conversationGeneration) conversationComposeStatus.textContent = "Couldn’t load this conversation. New replies will still appear here."; });
window.ember.onConversation(entries => { conversationReceived = true; renderConversation(entries); });
const resetConversationView = () => {
  // Only explicit session erasure clears an unsent draft; forgetting the last learned fact can also empty this list.
  conversationMessage.value = "";
  conversationSearch.value = "";
  conversationComposeStatus.textContent = "";
  conversationAwaitingReply = false;
  conversationLastAtSend = undefined;
  conversationDraftBeforeEdit = null;
  conversationGeneration++;
  $("conversation-cancel-edit").hidden = true;
  const send = $("conversation-send") as HTMLButtonElement;
  send.disabled = false;
  send.textContent = "Send";
  ($("conversation-stop") as HTMLButtonElement).disabled = false;
  renderConversation([]);
};
window.ember.onConversationForgotten(resetConversationView);
window.ember.onConversationStream(e => {
  const ev = e as Partial<StreamEvent> | null;
  if (!ev || !Number.isSafeInteger(ev.id) || typeof ev.text !== "string" || !["streaming", "done", "interrupted"].includes(ev.state ?? "")) return;
  answerStream = streamEvent(answerStream, ev as StreamEvent, conversationAll, new Date().toISOString());
  syncStreamRow($("conversation"));
});
$("conversation-new").addEventListener("click", () => {
  const button = $("conversation-new") as HTMLButtonElement;
  const generation = conversationGeneration;
  button.disabled = true;
  void window.ember.conversationNew().then(() => {
    // Forgotten or reset another way meanwhile (sign-out, another account): a newer draft isn't this click's to clear.
    if (generation !== conversationGeneration) return;
    resetConversationView();
    conversationComposeStatus.textContent = "Started a new conversation. Memory, reminders and running tasks are untouched.";
    conversationMessage.focus();
  }, () => { if (generation === conversationGeneration) conversationComposeStatus.textContent = "Couldn’t start a new conversation. Try again."; })
    .finally(() => { button.disabled = false; });
});
conversationSearch.addEventListener("input", () => renderConversation(conversationAll));
$("conversation-compose").addEventListener("submit", event => {
  event.preventDefault();
  const send = $("conversation-send") as HTMLButtonElement;
  if (send.disabled) return;
  const text = conversationMessage.value;
  if (!text.trim() || text.length > 2000) {
    conversationComposeStatus.textContent = "Enter a request of up to 2,000 characters.";
    conversationMessage.focus();
    return;
  }
  send.disabled = true;
  send.textContent = "Sending…";
  conversationAwaitingReply = true;
  conversationLastAtSend = conversationAll.at(-1);
  const generation = conversationGeneration;
  conversationComposeStatus.textContent = "Sending request…";
  void window.ember.conversationSend(text).then(() => {
    if (generation !== conversationGeneration) return;
    // Preserve any edits made while the acknowledgement was pending.
    if (conversationMessage.value === text) conversationMessage.value = "";
    conversationDraftBeforeEdit = null;
    $("conversation-cancel-edit").hidden = true;
    if (conversationAwaitingReply) conversationComposeStatus.textContent = "Request sent. Ember’s reply will appear above.";
  }, error => {
    if (generation !== conversationGeneration) return;
    conversationAwaitingReply = false;
    conversationComposeStatus.textContent = ipcErrorText(error) || "Couldn’t send. Your draft is still here; try again.";
  }).finally(() => { if (generation === conversationGeneration) { send.disabled = false; send.textContent = "Send"; } });
});
$("conversation-cancel-edit").addEventListener("click", () => {
  conversationMessage.value = conversationDraftBeforeEdit ?? "";
  conversationDraftBeforeEdit = null;
  $("conversation-cancel-edit").hidden = true;
  conversationComposeStatus.textContent = "Edit cancelled. Your previous draft is restored.";
  conversationMessage.focus();
});
conversationMessage.addEventListener("keydown", event => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
    event.preventDefault();
    ($("conversation-compose") as HTMLFormElement).requestSubmit();
  }
});
$("conversation-stop").addEventListener("click", () => {
  const stop = $("conversation-stop") as HTMLButtonElement;
  const generation = conversationGeneration;
  stop.disabled = true;
  void window.ember.conversationStop().then(() => {
    if (generation !== conversationGeneration) return;
    conversationAwaitingReply = false;
    conversationComposeStatus.textContent = "Response stopped. Running tasks continue.";
  }, () => { if (generation === conversationGeneration) conversationComposeStatus.textContent = "Couldn’t stop this response. Try again, or use Stop everything."; })
    .finally(() => { if (generation === conversationGeneration) stop.disabled = false; });
});

// ───── Memory (docs/MEMORY.md): kept between runs, only once the user turns it on and agrees to its note ─────
$("memory-consent-text").textContent = MEMORY_CONSENT_TEXT;
const memoryOn = () => !!settings?.memory.on && (settings?.memory.consent.version ?? 0) >= MEMORY_VERSION;
let memoryOwner: MemoryView["ownership"] = "waiting";
let memoryReason: MemoryView["reason"];
let memoryEpoch = 0;
const memoryCorrection = mountMemoryCorrection(window.ember, () => $("memory-on"), (expected, corrected) => {
  const current = memoryRows.find(row => row.id === expected.id);
  // A newer push wins; a successful IPC reply can fill in a missed view notification without resurrecting a deletion.
  if (!current || current.text !== expected.text || current.source !== expected.source || current.at !== expected.at || (current.revision ?? 0) !== (expected.revision ?? 0)) return;
  renderMemory(memoryRows.map(row => row.id === corrected.id ? corrected : row));
});
const memoryQuery = $("memory-query") as HTMLInputElement;
const memorySource = $("memory-source") as HTMLSelectElement;
let memoryShown = MEMORY_PAGE_SIZE;
$("memory-query-label").textContent = MEMORY_SEARCH_LABEL;
$("memory-source-label").textContent = MEMORY_SOURCE_LABEL;
memorySource.replaceChildren(...["", ...MEMORY_SOURCES].map(source => Object.assign(document.createElement("option"), { value: source, textContent: source ? memorySourceLabel(source) : MEMORY_ALL_SOURCES })));
$("memory-more").textContent = MEMORY_SHOW_MORE;
const memoryList = new KeyedRows<MemoryRow>($("memory-list"), {
  key: row => row.id,
  empty: () => memoryQuery.value.trim() || memorySource.value ? MEMORY_NO_MATCHES : memoryEmptyText(memoryOn()),
  fallback: () => $("memory-on"),
  create: read => {
    const row = read();
    const li = document.createElement("li");
    const fact = Object.assign(document.createElement("span"), { className: "mem-fact" });
    fact.append(Object.assign(document.createElement("span"), { textContent: row.text }), Object.assign(document.createElement("span"), { className: "mem-from", textContent: memorySourceLabel(row.source) }));
    const button = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: "Forget" });
    button.setAttribute("aria-label", forgetMemoryLabel(row.text));
    button.dataset.memoryForget = "";
    button.addEventListener("click", () => { void deleteMemory(button, () => window.ember.forgetMemory(read().id)); });
    const correct = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: MEMORY_CORRECTION.correct });
    correct.dataset.memoryCorrect = row.id;
    correct.addEventListener("click", () => memoryCorrection.open(read()));
    const actions = Object.assign(document.createElement("div"), { className: "agent-actions" });
    actions.append(button, correct); li.append(fact, actions);
    return li;
  },
  update: (li, row) => {
    li.querySelector<HTMLElement>(".mem-fact > span")!.textContent = row.text;
    li.querySelector<HTMLElement>(".mem-from")!.textContent = memoryProvenanceLabel(row.source, row.correctedAt);
    li.querySelector<HTMLElement>("[data-memory-forget]")!.setAttribute("aria-label", forgetMemoryLabel(row.text));
    li.querySelector<HTMLElement>("[data-memory-correct]")!.setAttribute("aria-label", correctMemoryLabel(row.text));
  },
});
function renderMemory(rows: MemoryRow[]): void {
  memoryRows = rows;
  memoryCorrection.observe(rows, memoryEpoch, memoryOwner === "ready", memoryOwner === "ready" && memoryOn() && !managed.has("memory"));
  const page = memoryPage(rows, memoryQuery.value, memorySource.value, memoryShown);
  memoryList.render(page.rows);
  const filters = $("memory-filters");
  const unavailable = memoryOwner !== "ready";
  if (unavailable && filters.contains(document.activeElement)) $("memory-on").focus();
  filters.hidden = unavailable;
  $("memory-list").hidden = unavailable;
  $("memory-count").hidden = unavailable;
  $("memory-count").textContent = memoryCountText(page.rows.length, page.total, rows.length);
  const more = $("memory-more");
  const moreWasFocused = document.activeElement === more;
  more.hidden = page.rows.length >= page.total;
  if (moreWasFocused && more.hidden) ($("memory-list").querySelector<HTMLElement>("li:last-child button") ?? (unavailable ? $("memory-on") : memoryQuery)).focus();
  const owner = $("memory-owner");
  owner.hidden = memoryOwner === "ready" || (memoryOwner === "waiting" && !memoryOn());
  // Why memory isn't open, never advice to erase memory that only waits (a model provider, a reconnect: memory-2).
  owner.textContent = memoryOwnerText(memoryReason, memoryOwner === "locked");
  // Tell Ember about you can't keep answers then: it says why instead of its questions.
  aboutYou.owner(memoryOwner === "ready" || !memoryOn() ? null : owner.textContent);
  const all = $("memory-forget-all");
  const wasFocused = document.activeElement === all;
  all.hidden = !rows.length && !memoryOwnerOffersErase(memoryReason, memoryOwner === "locked");
  if (wasFocused && all.hidden) $("memory-on").focus();
}
for (const control of [memoryQuery, memorySource]) control.addEventListener("input", () => {
  memoryShown = MEMORY_PAGE_SIZE;
  renderMemory(memoryRows);
});
$("memory-more").addEventListener("click", () => {
  const before = $("memory-list").children.length;
  memoryShown += MEMORY_PAGE_SIZE;
  renderMemory(memoryRows);
  // Move into the newly revealed page, including when Show more has reached the end and disappeared.
  $("memory-list").children[before]?.querySelector<HTMLElement>("button")?.focus();
});
const showMemory = (view: MemoryView) => { memoryOwner = view.ownership; memoryReason = view.reason; memoryEpoch = view.epoch ?? 0; renderMemory(view.rows); renderStatus(); };
/** Memory's settings as they are, so a change to one of its fields keeps the others (the patch replaces it whole). */
const memoryNow = () => settings?.memory ?? { on: false, consent: { version: 0, at: null }, questions: true, askedAt: null };
/** "Tell Ember about you" (about-you.ts): its Turn on memory… opens the switch's own note. */
const aboutYou = mountAboutYou($("about-you"), {
  id: "ay", save, ownSave: true,
  askConsent: () => { $("memory-consent").hidden = false; $("memory-yes").focus(); },
});
$("memory-questions-hint").textContent = MEMORY_QUESTIONS_HINT;
/** The paused note was shown (once a session: Not now hides it). */
let pausedSeen = false;
function applyMemorySettings(s: Settings): void {
  const on = s.memory.on && s.memory.consent.version >= MEMORY_VERSION;
  ($("memory-on") as HTMLInputElement).checked = on;
  // Questions are memory's: their switch shows only while memory is on.
  ($("memory-questions") as HTMLInputElement).checked = s.memory.questions;
  $("memory-questions-row").hidden = !on;
  $("memory-questions-hint").hidden = !on;
  aboutYou.refresh(s, managed.has("memory"));
  // On under the earlier note: paused until the new one is agreed to, which shows open with a line saying why (until
  // Not now this session).
  const paused = memoryPaused(s.memory) && !managed.has("memory");
  $("memory-paused").textContent = MEMORY_PAUSED_TEXT;
  $("memory-paused").hidden = !paused;
  if (paused && !pausedSeen) { pausedSeen = true; $("memory-consent").hidden = false; }
  renderMemory(memoryRows);
}
$("memory-on").addEventListener("change", e => {
  const on = (e.target as HTMLInputElement).checked;
  const consent = settings?.memory.consent ?? { version: 0, at: null };
  // First time (or the note changed since it was agreed to): the note comes first, and focus moves to it so it is read and answered.
  if (on && consent.version < MEMORY_VERSION) { $("memory-consent").hidden = false; (e.target as HTMLInputElement).checked = false; $("memory-yes").focus(); return; }
  void save({ memory: { ...memoryNow(), consent, on } });
});
$("memory-questions").addEventListener("change", e => { void save({ memory: { ...memoryNow(), questions: (e.target as HTMLInputElement).checked } }); });
$("memory-yes").addEventListener("click", () => {
  $("memory-consent").hidden = true;
  void save({ memory: { ...memoryNow(), on: true, consent: { version: MEMORY_VERSION, at: new Date().toISOString() } } });
  $("memory-on").focus();
});
$("memory-no").addEventListener("click", () => { $("memory-consent").hidden = true; $("memory-on").focus(); });
/** A rejected deletion keeps the list and presents a retryable, user-safe failure. */
async function deleteMemory(button: HTMLButtonElement, remove: () => Promise<unknown>): Promise<void> {
  if (button.getAttribute("aria-disabled") === "true") return;
  button.setAttribute("aria-disabled", "true");
  $("memory-error").textContent = "";
  try { await remove(); }
  catch (err) { $("memory-error").textContent = memoryDeleteFailedText(err); }
  finally { button.removeAttribute("aria-disabled"); }
}
window.ember.onSettingsChanged(applyMemorySettings);
let receivedMemory = false;
void window.ember.memory().then(view => { if (!receivedMemory) showMemory(view); });

// Better recall (docs/MEMORY.md §2): a one-line download prompt while memory is on; the click is the agreement.
let recallShown = -1;
function renderRecall(s: BetterRecallState): void {
  const off = s.state === "off";
  for (const id of ["recall-h", "recall-group", "recall-hint"]) $(id).hidden = off;
  $("recall-text").textContent = betterRecallText(s);
  ($("recall-dot") as HTMLElement).dataset.phase = s.state === "ready" ? "ready" : s.state === "downloading" ? "starting" : "";
  const dl = $("recall-download") as HTMLButtonElement;
  dl.hidden = s.state !== "absent";
  dl.textContent = betterRecallDownloadLabel(s.bytes);
  ($("recall-remove") as HTMLButtonElement).hidden = s.state !== "ready";
  const bar = $("recall-progress") as HTMLProgressElement;
  bar.hidden = s.state !== "downloading";
  if (s.state === "downloading") {
    const fraction = (s.done ?? 0) / (s.bytes || 1);
    bar.value = fraction;
    const step = progressStep(fraction);
    if (step !== recallShown) { recallShown = step; $("recall-live").textContent = betterRecallProgress(fraction); }
  } else recallShown = -1;
}
$("recall-download").addEventListener("click", () => { void window.ember.downloadMemoryModel(); });
$("recall-remove").addEventListener("click", () => { void window.ember.removeMemoryModel().then(() => $("recall-download").focus(), err => { $("memory-error").textContent = memoryDeleteFailedText(err); }); });
window.ember.onMemoryModel(renderRecall);
void window.ember.memoryModel().then(renderRecall);
window.ember.onMemory(view => { receivedMemory = true; showMemory(view); });

// ───── Routines and lasting reminders (app/main/agent/routines.ts): kept only once the user turns them on and agrees ─────
$("routines-consent-text").textContent = ROUTINES_CONSENT_TEXT;
const routinesOn = () => !!settings?.routines.on && (settings?.routines.consent.version ?? 0) >= ROUTINES_VERSION;
function renderRoutines(rows: RoutineRow[]): void {
  routineRows = rows;
  const list = $("routines-list");
  list.replaceChildren(...(rows.length
    ? rows.map((r, i) => {
      const li = document.createElement("li");
      li.append(Object.assign(document.createElement("span"), { textContent: `“${r.name}”: ${r.steps.join("; ")}` }));
      const btn = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: "Delete" });
      btn.setAttribute("aria-label", deleteRoutineLabel(r.name));
      btn.addEventListener("click", () => { routineFocus = i; void window.ember.forgetRoutine(r.id); });
      li.append(btn);
      return li;
    })
    : [Object.assign(document.createElement("li"), { className: "empty", textContent: routinesEmptyText(routinesOn()) })]));
  // While routines are on, reminders may be kept too (Home lists none of them): Delete all clears those as well.
  ($("routines-forget-all") as HTMLButtonElement).hidden = !rows.length && !routinesOn();
  if (routineFocus !== null) {
    const buttons = list.querySelectorAll("button");
    (buttons[Math.min(routineFocus, buttons.length - 1)] ?? $("routines-on")).focus();
    routineFocus = null;
  }
}
function applyRoutineSettings(s: Settings): void {
  ($("routines-on") as HTMLInputElement).checked = s.routines.on && s.routines.consent.version >= ROUTINES_VERSION;
  if (!routineRows.length) renderRoutines(routineRows);
}
$("routines-on").addEventListener("change", e => {
  const on = (e.target as HTMLInputElement).checked;
  const consent = settings?.routines.consent ?? { version: 0, at: null };
  // First time: the note comes first, and focus moves to it so it is read and answered.
  if (on && consent.version < ROUTINES_VERSION) { $("routines-consent").hidden = false; (e.target as HTMLInputElement).checked = false; $("routines-yes").focus(); return; }
  void save({ routines: { consent, on } });
});
$("routines-yes").addEventListener("click", () => {
  $("routines-consent").hidden = true;
  void save({ routines: { on: true, consent: { version: ROUTINES_VERSION, at: new Date().toISOString() } } });
  $("routines-on").focus();
});
$("routines-no").addEventListener("click", () => { $("routines-consent").hidden = true; $("routines-on").focus(); });
mountReminders(window.ember);

// ───── Telling the user a newer Ember is out (app/main/updates.ts): on only once they agree to its note ─────
const UPDATES_VERSION = FEATURE_CONSENT_VERSION.updates;
$("updates-consent-text").textContent = UPDATES_CONSENT_TEXT;
function applyUpdateSettings(s: Settings): void {
  ($("updates-on") as HTMLInputElement).checked = s.updates.on && s.updates.consent.version >= FEATURE_CONSENT_VERSION.updates;
}
function renderUpdates(s: UpdateStatus): void {
  $("updates-status").textContent = updateStatusText(s);
  ($("updates-open") as HTMLButtonElement).hidden = s.phase !== "available";
  const check = $("updates-check") as HTMLButtonElement;
  check.hidden = s.phase === "off";
  check.disabled = s.phase === "checking";
}
$("updates-on").addEventListener("change", e => {
  const on = (e.target as HTMLInputElement).checked;
  const own = settings?.updates ?? { on: false, consent: { version: 0, at: null }, told: null };
  // First time: the note comes first, and focus moves to it so it is read and answered.
  if (on && own.consent.version < UPDATES_VERSION) { $("updates-consent").hidden = false; (e.target as HTMLInputElement).checked = false; $("updates-yes").focus(); return; }
  void save({ updates: { ...own, on } });
});
$("updates-yes").addEventListener("click", () => {
  $("updates-consent").hidden = true;
  void save({ updates: { on: true, told: settings?.updates.told ?? null, consent: { version: UPDATES_VERSION, at: new Date().toISOString() } } });
  $("updates-on").focus();
});
$("updates-no").addEventListener("click", () => { $("updates-consent").hidden = true; $("updates-on").focus(); });
$("updates-check").addEventListener("click", () => { void window.ember.checkForUpdates().then(renderUpdates); });
$("updates-open").addEventListener("click", () => { void window.ember.openUpdate(); });
window.ember.onUpdates(renderUpdates);
void window.ember.updates().then(renderUpdates);

// ───── Work without asking (app/main/policy/autonomy.ts): on only once the user agrees to its card ─────
$("autonomy-consent-text").textContent = AUTONOMY_CONSENT_TEXT;
function applyAutonomySettings(s: Settings): void {
  ($("autonomy-on") as HTMLInputElement).checked = s.autonomy.on && s.autonomy.consent.version >= AUTONOMY_VERSION;
  autonomyManaged = managed.has("autonomy");
  $("autonomy-hint").textContent = autonomyHint(autonomyManaged, elevationOf(checksNow));
}
$("autonomy-on").addEventListener("change", e => {
  const on = (e.target as HTMLInputElement).checked;
  const a = settings?.autonomy ?? { on: false, scopes: { apps: true, commands: true, cursor: true, crossWindow: true }, consent: { version: 0, at: null } };
  if (on && a.consent.version < AUTONOMY_VERSION) { $("autonomy-consent").hidden = false; (e.target as HTMLInputElement).checked = false; $("autonomy-yes").focus(); return; }
  // Turned on: all four of what it covers (using apps, commands, the mouse and keyboard, moving text between apps).
  void save({ autonomy: { ...a, on, ...(on ? { scopes: { apps: true, commands: true, cursor: true, crossWindow: true } } : {}) } });
});
$("autonomy-yes").addEventListener("click", () => {
  $("autonomy-consent").hidden = true;
  void save({ autonomy: { on: true, scopes: { apps: true, commands: true, cursor: true, crossWindow: true }, consent: { version: AUTONOMY_VERSION, at: new Date().toISOString() } } });
  $("autonomy-on").focus();
});
$("autonomy-no").addEventListener("click", () => { $("autonomy-consent").hidden = true; $("autonomy-on").focus(); });
window.ember.onSettingsChanged(applyRoutineSettings);
void window.ember.routines().then(renderRoutines);
window.ember.onRoutines(renderRoutines);

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
  // Hidden by the page itself (Computers before its list came, the first run): it waits until it shows.
  if (hiddenHere(h)) { pendingSection.hold(value); return; }
  pendingSection.drop();
  const inPane = paneOf(h);
  const opened = !document.body.classList.contains("first-run") && !!inPane && inPane !== pane;
  if (opened && inPane) { restoring = null; showPane(inPane, true); }
  // Asked for by voice ("work without asking" before its card was agreed to): the card shows, focused on its agree button.
  if (control === "autonomy-yes" && !managed.has("autonomy")) $("autonomy-consent").hidden = false;
  // Asked for by voice ("get to know me" while memory is off): its note shows, focused on its agree button.
  if (control === "memory-yes" && !managed.has("memory")) $("memory-consent").hidden = false;
  const fold = h.closest("details");
  if (fold) fold.open = true;
  const target = (fold?.querySelector("summary") ?? h) as HTMLElement;
  const field = control ? document.getElementById(control) : null;
  const to = field && !isHidden(field) ? field : target;
  const block = to === field ? "center" : "start";
  // A pane just opened starts at its top (its heading, or the control, in view); within the pane, it scrolls there.
  if (opened && block === "start") window.scrollTo({ top: 0 });
  else to.scrollIntoView({ block, behavior: calm || opened ? "auto" : "smooth" });
  to.focus({ preventScroll: true });
  keptInView = { el: to, block, until: performance.now() + 3000 };
}

// ───── Panes: one at a time, as System Settings shows one pane per sidebar item (UI audit #1) ─────
/** The pane shown: Home until the user picks another. */
let pane = "home";
/** A section's pane (its `data-pane`: the page's own sections, not first run's steps, which use the same attribute). */
const paneOf = (el: Element) => el.closest<HTMLElement>(".home > [data-pane]")?.dataset.pane ?? null;
/** Shows pane `p` (every other pane's sections are taken off the page) and marks its link. */
function showPane(p: string, glide = false, remember = true): void {
  if (p !== pane) dismissForgetConfirms(); // an open question would stay modal over a pane it isn't in, and its inert marks would block the focus that follows
  pane = p;
  if (remember) try { localStorage.setItem("ember.home.pane", p); } catch { /* storage blocked: the window opens on Home */ }
  for (const s of document.querySelectorAll<HTMLElement>(".home > [data-pane]")) s.classList.toggle("off-pane", s.dataset.pane !== p);
  for (const a of jumpLinks) {
    const h = document.getElementById(`${sectionOf(a)}-h`);
    if (h && paneOf(h) === p) a.setAttribute("aria-current", "true");
    else a.removeAttribute("aria-current");
  }
  placeHighlight(glide);
  // Home's characters draw only while they show (the observer sees them go).
  drawSoon();
}
/**
 * The sidebar's selection: one highlight that glides to the link of the pane shown when the user picks it, and is put
 * there without motion otherwise (the window opening, a resize). Decorative: aria-current says which it is.
 */
const highlight = Object.assign(document.createElement("span"), { className: "jump-hl" });
highlight.setAttribute("aria-hidden", "true");
$("jump").prepend(highlight);
function placeHighlight(glide: boolean): void {
  const a = jumpLinks.find(l => l.getAttribute("aria-current") === "true");
  if (!a || !a.offsetHeight) { $("jump").classList.remove("has-hl"); return; }
  $("jump").classList.toggle("glides", glide && $("jump").classList.contains("has-hl"));
  highlight.style.setProperty("--hl-y", `${a.offsetTop}px`);
  highlight.style.setProperty("--hl-h", `${a.offsetHeight}px`);
  $("jump").classList.add("has-hl");
}
window.addEventListener("resize", () => placeHighlight(false));
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
  const value = pendingSection.take(s => { const h = document.getElementById(`${s}-h`); return !!h && !hiddenHere(h); });
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
// The window opens on the pane last viewed (Apple's settings windows restore it), Home the first time. Kept in this
// window's own storage: a pane's name only, and a blocked storage just means Home. Computers and Commands show only
// once their list has come: the window waits on Home for them (without forgetting them), until the user picks a pane.
let lastPane: string | null = null;
try { lastPane = localStorage.getItem("ember.home.pane"); } catch { /* storage blocked: Home */ }
const paneShows = (p: string) => !!document.querySelector(`.home > [data-pane="${CSS.escape(p)}"]:not([hidden])`);
const known = !!lastPane && !!document.querySelector(`.home > [data-pane="${CSS.escape(lastPane)}"]`);
/** The pane to reopen once it shows; null once it did, or the user picked another. */
let restoring: string | null = known && lastPane && !paneShows(lastPane) ? lastPane : null;
if (known && lastPane && paneShows(lastPane)) showPane(lastPane);
else showPane("home", false, false);
// A pane that shows late is reopened; the pane shown going away (its section hidden) leaves Home in its place.
const panesSeen = new MutationObserver(() => {
  if (restoring && paneShows(restoring)) { const p = restoring; restoring = null; showPane(p); return; }
  if (!paneShows(pane)) showPane("home", false, false);
});
for (const s of document.querySelectorAll(".home > [data-pane]")) panesSeen.observe(s, { attributes: true, attributeFilter: ["hidden"] });
// Links that show or step out later (Computers, Commands, a search) move the others, and a text size or window change
// resizes them: the highlight follows at once.
const linksMoved = new MutationObserver(() => placeHighlight(false));
for (const a of jumpLinks) linksMoved.observe(a, { attributes: true, attributeFilter: ["hidden", "class"] });
new ResizeObserver(() => placeHighlight(false)).observe($("jump"));

// ───── Search settings: at the top of the sidebar, it narrows the panes to those that hold the words typed, and
// Enter goes to the first setting found (System Settings' search, HIG/search-fields) ─────
const SEARCHED = "h2, h3.sub, label, summary, .hint, .row-note, .intro, .agent-actions > button, .pick-row label";
function searchItems(): { pane: string; text: string; alias?: string; el: HTMLElement }[] {
  const items: { pane: string; text: string; alias?: string; el: HTMLElement }[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(`.home > [data-pane] :is(${SEARCHED})`)) {
    const p = paneOf(el);
    if (!p || hiddenHere(el) || !el.textContent?.trim()) continue;
    items.push({ pane: p, text: el.textContent, alias: SEARCH_ALIASES[el.id], el });
  }
  return items;
}
let found: ReturnType<typeof searchItems> = [];
const search = $("search") as HTMLInputElement;
$("search-results").setAttribute("aria-label", SETTINGS_RESULTS_LABEL);
let searchShown = 12;
function renderSearchResults(): void {
  const results = $("search-results");
  results.hidden = !found.length;
  results.replaceChildren(...found.slice(0, searchShown).map(result => {
    const li = document.createElement("li");
    const section = jumpLinks.find(link => paneOf(document.getElementById(`${sectionOf(link)}-h`) ?? link) === result.pane)?.textContent ?? result.pane;
    const button = Object.assign(document.createElement("button"), { type: "button", className: "search-result", textContent: settingsResultText(section, result.text) });
    button.addEventListener("click", () => openSearchResult(result));
    li.append(button);
    return li;
  }));
  if (found.length > searchShown) {
    const li = document.createElement("li");
    const more = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: SETTINGS_MORE_RESULTS });
    more.addEventListener("click", () => {
      const before = searchShown;
      searchShown += 12;
      renderSearchResults();
      results.children[before]?.querySelector<HTMLElement>("button")?.focus();
    });
    li.append(more);
    results.append(li);
  }
}
$("search-results").addEventListener("keydown", e => {
  if (e.key === "Escape") { e.preventDefault(); search.focus(); $("search-results").hidden = true; }
});
search.addEventListener("focus", renderSearchResults);
for (const event of ["pointerdown", "focusin"]) document.addEventListener(event, e => {
  if (e.target instanceof Element && !e.target.closest(".search, #search-results")) $("search-results").hidden = true;
});
search.addEventListener("input", () => {
  const q = search.value;
  found = searchMatches(q, searchItems());
  searchShown = 12;
  renderSearchResults();
  const panes = new Set(found.map(f => f.pane));
  for (const a of jumpLinks) {
    const h = document.getElementById(`${sectionOf(a)}-h`);
    a.classList.toggle("unmatched", !!q.trim() && !(h && panes.has(paneOf(h) ?? "")));
  }
  setText("search-msg", searchMessage(q, found.length, panes.size));
  // Nothing found is said where the links were too (an empty sidebar read as broken).
  const none = !!q.trim() && !found.length;
  $("search-none").hidden = !none;
  if (none) setText("search-none", searchMessage(q, 0, 0));
});
function openSearchResult(result: ReturnType<typeof searchItems>[number]): void {
  $("search-results").hidden = true;
  const { pane: p, el: hit } = result;
  // A group's header or footnote stands for its group, which it describes as a whole: a group of one row is that row
  // (marked, its control focused); a longer one is marked whole and takes focus itself, so no one row is picked for it.
  const sibling = hit.matches("h3.sub") ? hit.nextElementSibling : hit.matches(".hint") ? hit.previousElementSibling : null;
  const group = sibling instanceof HTMLElement && sibling.matches(".group") && !hiddenHere(sibling) ? sibling : null;
  const rows = group ? [...group.children].filter((r): r is HTMLElement => r instanceof HTMLElement && !hiddenHere(r)) : [];
  const el = !group ? hit : rows.length === 1 ? rows[0] : group;
  showPane(p, true);
  // A setting in a fold (What Ember did, About) shows once its folds are open.
  for (let d = el.closest("details"); d; d = d.parentElement?.closest("details") ?? null) d.open = true;
  // The setting found takes focus (its control, when it is a label), marked until it loses focus.
  const control = el === group ? null : el.matches("label") ? el.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled)") : el.matches("summary, button:not(:disabled)") ? el : el.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled), button:not(:disabled)");
  const to = control ?? (el.matches(":disabled") ? el.closest<HTMLElement>(".group") ?? el.parentElement ?? el : el);
  const madeFocusable = !control && !to.hasAttribute("tabindex");
  if (madeFocusable) to.tabIndex = -1;
  el.classList.add("found");
  to.addEventListener("blur", () => { el.classList.remove("found"); if (madeFocusable) to.removeAttribute("tabindex"); }, { once: true });
  to.scrollIntoView({ block: "center", behavior: "auto" });
  to.focus({ preventScroll: true });
}
search.addEventListener("keydown", e => {
  if (e.key === "Escape" && search.value) { e.preventDefault(); search.value = ""; search.dispatchEvent(new Event("input")); return; }
  if (e.key === "ArrowDown" && found.length) { e.preventDefault(); renderSearchResults(); $("search-results").querySelector<HTMLElement>("button")?.focus(); return; }
  if (e.key !== "Enter" || !found.length) return;
  e.preventDefault();
  openSearchResult(found[0]);
});

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
// Only the switch flipped: main fills in the other from the user's own settings (withOwnTrust), never the shown value,
// which may be the administrator's.
$("trust-apps").addEventListener("change", e => { void save({ trust: { askedApps: (e.target as HTMLInputElement).checked } } as SettingsPatch); });
$("trust-commands").addEventListener("change", e => { void save({ trust: { reviewCommands: (e.target as HTMLInputElement).checked } } as SettingsPatch); });
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

// ───── Ember on screen (the handle menu's Hide and Stay put as switches, Ask and Stop everything on Home, Quit) ─────
let presence: Presence | null = null;
function renderPresence(p: Presence): void {
  presence = p;
  // Following the cursor and hiding are states, so they are switches (UI audit #13), shown where Ember is by the cursor.
  $("follow-row").hidden = !p.overlay;
  $("hide-row").hidden = !p.overlay;
  ($("p-hide") as HTMLInputElement).checked = p.hidden;
  ($("p-follow") as HTMLInputElement).checked = !p.paused;
  const line = !p.overlay
    ? `This desktop session can't show Ember beside your cursor, so it lives in the card in the ${handleCornerText(settings?.handlePosition)}.`
    : p.hidden ? "Ember is hidden. It shows itself again when it needs to ask you something." : "";
  if ($("presence-text").textContent !== line) $("presence-text").textContent = line;
  renderTagline();
}
$("p-hide").addEventListener("change", e => { void window.ember.setPresence({ hidden: (e.target as HTMLInputElement).checked }).then(renderPresence); });
$("p-follow").addEventListener("change", e => { void window.ember.setPresence({ paused: !(e.target as HTMLInputElement).checked }).then(renderPresence); });
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
const showListenOnce = mountListenOnce(
  $("voice-listen-once") as HTMLButtonElement,
  $("voice-listen-once-detail"),
  on => window.ember.listenOnce(on),
  LISTEN_ONCE_READY,
);
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
  if (v !== voice) showListenOnce(v.listenOnce);
  voice = v;
  renderVoiceFix();
  const text = v.detail && v.state === "error" ? `${VOICE_TEXT.error}: ${v.detail}` : v.detail ?? VOICE_TEXT[v.state] ?? v.state;
  $("voice-text").textContent = text;
  // Off, the switch above says so: no lone "Off" row under it (UI audit #15). Screen readers still hear the change.
  $("voice-text").parentElement!.hidden = v.state === "off";
  renderStatus();
  renderNatural();
  // Teaching Ember a voice: its prompts are what screen readers hear; the voice line only when it changes.
  const said = renderMatch();
  if (said) voiceLive(said);
  else if (v.state !== "downloading" && text !== voiceLine) voiceLive(text);
  voiceLine = text;
  $("voice-dot").dataset.phase = v.state === "waiting" || v.state === "active" ? "ready" : v.state === "error" ? "error" : v.state === "off" || v.state === "muted" ? "" : "starting";
  const dl = $("voice-download") as HTMLButtonElement;
  // Listening turned off by the organisation: nothing to download it for. Otherwise it fetches what's missing (all of
  // them on first use; later just Ember's voice or Voice Match, should one be missing or damaged).
  const downloading = v.state === "downloading" || !!v.downloading;
  dl.hidden = !v.modelsMissing.length || downloading || managed.has("wakeWord");
  dl.textContent = modelsDownloadLabel(v.modelsMissing, v.modelsBytes);
  // One orange button per section: the download is the main thing only once "Hey Ember" is on.
  dl.classList.toggle("quiet", !(voiceSettings.wakeWord && voiceSettings.consent));
  ($("voice-progress") as HTMLProgressElement).hidden = !downloading;
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
  // Voice Match's model alone missing: its size, for the note that says to download it.
  const speakerBytes = voice?.modelsMissing.length === 1 && voice.modelsMissing[0] === "speaker" ? voice.modelsBytes : null;
  const view = matchView(m, { listening: voiceSettings.wakeWord && voiceSettings.consent, managed: managed.has("wakeWord"), speakerBytes });
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
  // Keep learning my voice and Reset to my enrolment, once Voice Match knows the voice.
  personalMatch(voice, view.hidden);
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
  void save({ voice: { ...(settings?.voice ?? { consent: true, speakerRejection: true, muted: false, natural: false, naturalModel: "kokoro", learn: true, words: true, suggest: true, conversation: true, clearHearing: false }), match: on } });
});
$("match-teach").addEventListener("click", startEnrol);
// Teach comes back (and takes focus) once main says teaching stopped; Forget hides itself, so focus goes to Teach now.
$("match-cancel").addEventListener("click", () => { matchCancelled = true; void window.ember.cancelEnrolVoice(); });
$("match-forget").addEventListener("click", () => { void window.ember.forgetVoice(); focusFirst(["match-teach", "match-on", "wake"]); });
function applyVoiceSettings(s: Status["settings"]): void {
  voiceSettings = { wakeWord: s.wakeWord, consent: s.voice.consent };
  ($("wake") as HTMLInputElement).checked = s.wakeWord && s.voice.consent;
  ($("speak") as HTMLSelectElement).value = speakChoice(s);
  ($("speak-results") as HTMLInputElement).checked = s.speakResults;
  naturalUI.settings(s);
  personalSettings(s);
  if (voice) renderVoice(voice);
  else renderNatural();
}
$("wake").addEventListener("change", e => {
  const on = (e.target as HTMLInputElement).checked;
  // First time: the microphone note comes first, and focus moves to it so it is read and answered.
  if (on && !voiceSettings.consent) { consentClosed(); $("consent").hidden = false; (e.target as HTMLInputElement).checked = false; $("consent-yes").focus(); return; }
  void save({ wakeWord: on });
});
/**
 * The microphone note's Agree: consent is saved first, and only a save that succeeded hides the note and fetches the
 * speech models (audit FE #20). A refused write leaves the note open with a plain line and Agree ready to try again,
 * and nothing here claims consent. `consentRun` changes when the note is closed, so a save that finishes after
 * "Not now" starts no download.
 */
let consentRun = 0;
let consentSaving = false;
const consentError = (text: string) => { $("consent-error").textContent = text; $("consent-error").hidden = !text; if (text) voiceLive(text); };
const consentClosed = () => { consentRun++; consentSaving = false; consentError(""); $("consent-yes").removeAttribute("aria-busy"); };
$("consent-yes").addEventListener("click", () => {
  if ($("consent-yes").getAttribute("aria-disabled") === "true" || consentSaving) return;
  consentSaving = true;
  const run = ++consentRun;
  consentError("");
  $("consent-yes").setAttribute("aria-busy", "true");
  void save({ wakeWord: true, voice: { muted: false, match: false, natural: false, naturalModel: "kokoro", learn: true, words: true, suggest: true, conversation: true, clearHearing: false, ...(settings?.voice ?? {}), consent: true, speakerRejection: true } }).then(ok => {
    if (run !== consentRun) return; // closed meanwhile: nothing more to do here
    consentSaving = false;
    $("consent-yes").removeAttribute("aria-busy");
    if (!ok) { consentError("Ember couldn't save your choice, so it isn't listening. Press “I agree, start listening” to try again."); $("consent-yes").focus(); return; }
    $("consent").hidden = true;
    // Agreeing also fetches the speech models if they aren't here yet (one less step to find).
    if (!($("voice-download") as HTMLButtonElement).hidden) void window.ember.downloadVoice();
    $("wake").focus();
  });
});
$("consent-no").addEventListener("click", () => { consentClosed(); $("consent").hidden = true; $("wake").focus(); });
/** The voice choice discloses the optional Kokoro download before switching. */
const naturalUI = mountNaturalVoice({ save, live: voiceLive, managed: () => managed.has("naturalVoice") });
function renderNatural(): void {
  // Kitten remains the baseline choice even when speech must use the system voice.
  $("natural-row").hidden = false;
  naturalUI.status(voice?.natural, voice?.naturalModels ?? []);
  const clearLine = clearHearingLine(voice?.clear);
  $("clear-text").textContent = clearLine;
  $("clear-text").hidden = !clearLine;
}
$("speak").addEventListener("change", e => { void save(speakSettings((e.target as HTMLSelectElement).value as SpeakChoice)); });
$("speak-results").addEventListener("change", e => { void save({ speakResults: (e.target as HTMLInputElement).checked }); });
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
