/**
 * Settings window (Home): until Start, only first run's steps show (welcome.ts); then one pane at a time, chosen in
 * the sidebar as System Settings does (docs/DESIGN.md "Home"). Home itself is the status panel (Ember's still ring,
 * its state, what is on, today, Ask and Stop everything), the conversation, Task activity and what Ember did; the
 * other panes are Your Ember (character, size, Ember on screen), Copilot, Voice, Memory, Apps & privacy, Computers,
 * Commands, Extensions, Comfort & access, and Setup & about.
 */

import { Rig, FACTORIES, frameSeconds, restingGap, type Character } from "@ember/characters";
import type { ActivityEntry, EmberHomeApi, MemoryForgotten, MemoryView, Presence, RetryResult, RoutineRow, Status, StatusPlatform, UpdateStatus, VoiceStatus } from "../../shared/ipc";
import { MEMORY_UNDO_MS } from "../../shared/ipc";
import { CONVERSATION_REQUEST_LIMIT, conversationTurnChangeOf, type ConversationTurn, type ConversationTurnEnd, type HistoryProblemKind } from "../../shared/conversation";
import { GLASS_CHOICES, GLASS_HINT, GLASS_LABEL, HEAR_WAITING, LISTEN_ONCE_READY, SPEAK_NO_VOICE, SPEAK_RATES, clearHearingLine, hearEmberLine, nearestRate, closedUnexpectedlyText, heardThrough, showLogLabel, modelsDownloadLabel, modelsSize, setupBadge, setupView } from "./copy";
import { mountListenOnce } from "../shared/listen-once";
import { heldLive } from "../shared/held-live";
import {
  AUTONOMY_CONSENT_TEXT, autonomyHint, elevationOf, betterRecallDownloadLabel, betterRecallProgress, betterRecallText, type BetterRecallState, MEMORY_CONSENT_TEXT,
  memoryOwnerOffersErase, memoryOwnerText, memoryForgottenText, memoryPutBackText, memoryRestoreFailedText, memoryTroubleText, MEMORY_UNDO_EXPIRED, undoForgotLabel, MEMORY_PAUSED_TEXT, MEMORY_QUESTIONS_HINT, memoryPaused, ROUTINES_CONSENT_TEXT, UPDATES_CONSENT_TEXT, updateHowTo, updateOut, updateStatusText, deleteRoutineLabel, forgetMemoryLabel, handleCornerText, forgotLine, learnedLine, rememberedAgainLine, memoryEmptyText,
  memorySourceLabel, routinesEmptyText, MEMORY_SEARCH_LABEL, MEMORY_SOURCE_LABEL, MEMORY_ALL_SOURCES, MEMORY_SHOW_MORE, MEMORY_NO_MATCHES, memoryCountText, settingsResultText, SETTINGS_MORE_RESULTS, SETTINGS_RESULTS_LABEL, correctMemoryLabel, memoryProvenanceLabel, MEMORY_CORRECTION,
} from "./copy";
import { mountAboutYou } from "./about-you";
import { mountReminders } from "./reminders";
import { dismissForgetConfirms, mountForgetConfirms } from "./forget-confirm";
import { FEATURE_CONSENT_VERSION } from "../../shared/consent";
import { MATCH_TEXT, matchAnnouncement, matchView, trustView } from "./match-copy";
import { ISSUES_URL } from "../../shared/support";
import { CONSENT_VERSION } from "../../shared/consent";
import { AGREE_ARM_MS } from "../../shared/provider";
import { useAppNames } from "../../shared/apps";
import { speakChoice, speakSettings, type SpeakChoice } from "../../shared/speech";
import type { Settings, SettingsPatch } from "../../main/settings";
import {
  dayLabel, entryWords, fixButtonName, fixFailedText, friendlyApp, homePatches, ipcErrorText, memoryDeleteFailedText, MANAGED_ROW, micOffText, missingDefaults, neverLookLabel, progressStep,
  conversationContextLine, rereadsStatusOnFocus, modelLabel, retryMessage, saveFailedText, signInLabel, STARTED_TEXT, tagline, usageLine, voiceFix, voiceFixFailed,
  type HomePatch, type Segment,
} from "./copy";
import { startTargets, targetsSettings, targetsStatus } from "./computers";
import { extensionsStatus, startExtensions } from "./extensions";
import { onProviderDestination, ownProvider, providerCard, providerSettings, providerSignedOut, startProvider } from "./provider";
import { modelDestination, privacyFoldWords, recipientWords, type ModelDestination } from "./copy";
import { ACTIVITY_EARLIER, ACTIVITY_LINES, activityLines, activityNote, activityProblemText, grantRemovedText, neverLookRemovedText, withEarlier } from "./copy";
import { ACTIVITY_ENTRIES, ACTIVITY_MAX_ENTRIES } from "../../shared/ipc";
import { mountProject } from "./project";
import { homeConnectionView, ownProviderOffer, taskModelChoices } from "./first-run-copy";
import { checkState, fixCommand, recheckMessage } from "./welcome-copy";
import { holdsBack } from "../../shared/setup-attention";
import { mountNaturalVoice } from "./natural-voice";
import { keptWords, lockdownMicWords, lockdownNotice, lockdownSendLine, turnedOffWords } from "./admin-copy";
import { LATEST_ANSWER, PendingSection, sectionRequest } from "./section-request";
import { startWelcome } from "./welcome";
import { holdTaskNews, startTasks } from "./tasks";
import { connectLabel, memoryWhatsOn, setupLinkText, statusWord, taskCounts, todayCounts, todaySummary, whatsOnText } from "./status-copy";
import { SEARCH_ALIASES, searchMatches, searchMessage, shownText } from "./search-copy";
import { conversationAdded, conversationChange, conversationShown, earlierLabel, stillUnsent } from "./conversation-view";
import { NO_STREAM, STOPPED_NOTE, streamEntries, streamEvent, type StreamEvent } from "./conversation-stream";
import { problemInHome, PROBLEM_SETTINGS, composerCount, composerGivenBack, composerLineYields, COMPOSER_OVER, COMPOSER_SAYS, COMPOSER_THINKING, conversationNewQuestion, CONVERSATION_NOTHING_TO_STOP, CONVERSATION_STOPPED, composerStillWaiting, CONVERSATION_EDIT, CONVERSATION_RESTORED_END, conversationWhen, CONVERSATION_KEEP_HINT, CONVERSATION_KEEP_LABEL, conversationKeepProblem, conversationRetention, CONVERSATION_SCOPE, CONVERSATION_TRUNCATED, conversationMatchesText, conversationSearchCount } from "./copy";
import { markHeard, personalMatch, personalSettings, startPersonal } from "./personal";
import { KeyedRows } from "./keyed-rows";
import { mountForgotUndo, mountLearnedUndo } from "./learned-undo";
import { mountMemoryCorrection } from "./memory-correction";
import { MEMORY_PAGE_SIZE, MEMORY_SOURCES, memoryPage } from "./memory-view";
import { homeFrameGap } from "./frame-gap";
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
const welcome = startWelcome({ save, buddy: heroCanvas, cards: $("cards"), checksChanged: env => renderChecks(env), arrived: () => { if (!calm) { heroRig.setEmotion("happy"); drawSoon(); } }, destination: () => destinationNow() });
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
/** Signed out while the user's own provider's card waits: the host it names, the way on instead of Copilot (integrations-r3-1). */
const waitingFor = (): string | null => {
  const own = providerCard();
  return agent?.phase === "signed-out" && own.on ? own.card : null;
};
let failing = 0;
/** Setup rows that don't fail but need the user: the status panel's link under the tagline names them (it opens the pane). */
let toLook = 0;
/** Setup rows that hold Ember back (failing, or it can't read or use apps): to fix, as first run says (first-run-5). */
let toFix = 0;
function renderTagline(): void {
  // The tagline leaves the rows worth a look to the link under it, which goes to them (owner review).
  const text = tagline({
    failing, look: 0, onboarded: settings?.onboarded ?? false, phase: agent?.phase ?? null, waitingForTasks: agent?.waitingForTasks === true,
    hidden: presence?.hidden ?? false, overlay: presence?.overlay ?? true, corner: settings?.handlePosition,
    locked: !!lastAdmin && lastAdmin.error !== null, held: !!lastAdmin?.held, service: agent?.service?.kind, waitingFor: waitingFor(),
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
  const locked = !!lastAdmin && lastAdmin.error !== null;
  const s = statusWord({ phase: agent?.phase ?? null, failing, waitingForTasks: agent?.waitingForTasks === true, running, asking, locked, held: !!lastAdmin?.held, service: agent?.service?.kind, answering: conversationAwaitingReply || conversationTurnNow !== "idle" });
  setText("state-word", s.word);
  $("ring").dataset.ring = s.ring;
  $("state-word").dataset.ring = s.ring;
  const v = voice?.state;
  const listening = !!settings?.wakeWord && !!settings?.voice.consent;
  setText("whats-on", whatsOnText({
    voice: !listening ? "off" : v === "muted" ? "muted" : "listening",
    memory: memoryWhatsOn(!!settings?.memory.on && (settings?.memory.consent.version ?? 0) >= MEMORY_VERSION, !!settings && memoryPaused(settings.memory), memoryOwner, memoryTrouble),
    commands: Object.values(settings?.commands ?? {}).filter(c => c?.on).length,
    computers: settings?.targets.hosts.length ?? 0,
    wsl: !!settings?.targets.wsl.on,
  }));
  setText("today", todaySummary(tasksNow, today));
  // Copilot not connected: connecting it is the one prominent action here, and Ask steps back.
  const notConnected = (agent?.phase === "signed-out" || agent?.phase === "error") && agent?.waitingForTasks !== true;
  // Locked down, connecting can't help (safety-privacy-4): no Connect button.
  $("p-connect").hidden = !notConnected || locked;
  setText("p-connect", connectLabel(agent?.service?.kind, !!waitingFor()));
  $("p-ask").classList.toggle("quiet", notConnected);
  $("p-waiting").hidden = !asking;
  const setup = setupLinkText(failing, toLook, toFix);
  $("p-setup").hidden = !setup;
  setText("p-setup", setup ?? "");
}
$("p-setup").addEventListener("click", () => showSection("checks"));
// However long the conversation, the composer and Task activity below it are a step away (home-v2).
$("p-write").addEventListener("click", () => showSection("conversation:message"));
$("p-tasks").addEventListener("click", () => showSection("tasks"));
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
/**
 * The setup check's live line. What Check again found is shown above its button too, so a sighted user sees it looked
 * again (first-run-r2); a fix's failure is only read out, as its row shows it. Rows drawn anew take a shown result away.
 */
function checksMsg(text: string, shown = false): void {
  const m = $("checks-msg");
  if (m.textContent !== text) m.textContent = text;
  m.className = shown && text ? "hint checks-msg" : "sr";
}
function renderChecks(environment: Status["environment"]): void {
  shownChecks = JSON.stringify(environment.checks);
  if ($("checks-msg").className !== "sr") checksMsg("");
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
    // First run's own words for the state (first-run-9), never a code such as "OK".
    pill.textContent = checkState(c.status, holdsBack(c));
    const label = document.createElement("span");
    label.className = "check-label";
    label.textContent = c.label;
    const detail = document.createElement("span");
    detail.className = "check-detail";
    detail.textContent = c.detail;
    li.append(pill, label, detail);
    // The row's fix, and a second one beside it for when that didn't take (macOS: Reset Ember's permissions).
    const actions = Object.assign(document.createElement("span"), { className: "check-actions" });
    // A fix the user runs themselves: its command, ready to copy, as first run offers it (first-run-9).
    const command = !c.fix && c.status !== "ok" ? fixCommand(c.detail) : undefined;
    if (command) {
      const copy = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet check-copy", textContent: "Copy" });
      copy.setAttribute("aria-label", `Copy the command: ${command}`);
      copy.addEventListener("click", () => { window.ember.copyText(command).then(() => { copy.textContent = "Copied"; }, () => { copy.textContent = "Couldn't copy"; }); });
      actions.append(copy);
    }
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
        checksMsg("");
        window.ember.applyFix(fix).then(renderChecks, err => {
          btn.removeAttribute("aria-disabled");
          // A refused fix says why in its own words (main's message, without Electron's IPC prefix), in its row and
          // in the status line a screen reader reads; focus stays on the button.
          const why = ipcErrorText(err);
          detail.textContent = `Couldn't change it: ${why}`;
          checksMsg(fixFailedText(c.label, why));
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
  // A fix the user makes outside Ember (a command run, a setting changed by hand): Check again reads the rows anew.
  $("checks-again-row").hidden = !view.needing;
  toLook = view.needing - failing;
  toFix = view.held;
  renderSetupBadge(view.needing, failing, view.held);
  const note = $("checks-note");
  // As first run and `ember doctor` say it ("to fix" for a row that holds Ember back, else "worth a look"), counted in
  // words (copy.ts checksNote): the same count as the tagline's and the sidebar's badge (UI audit #6, first-run-5).
  note.textContent = view.note;
  note.className = `fold-note${failing ? " fail" : view.needing ? " warn" : ""}`;
  // A row needs the user (it fails, holds back reading or using apps, or has a button): the check opens by itself
  // (once), and it shows before Start too, until Start.
  if (view.open) { ($("checks-fold") as HTMLDetailsElement).open = true; checksOpened = true; }
  checksBeforeStart = view.beforeStart;
  $("checks-fold").closest("section")!.classList.toggle("after-setup", !checksBeforeStart);
  renderTagline();
}

$("checks-again").addEventListener("click", () => {
  const btn = $("checks-again");
  // Busy, not disabled: a disabled button drops keyboard focus to the page.
  if (btn.getAttribute("aria-disabled") === "true") return;
  btn.setAttribute("aria-disabled", "true");
  checksMsg("Checking…", true);
  const before = checksNow;
  window.ember.recheckSetup().then(env => {
    btn.removeAttribute("aria-disabled");
    renderChecks(env);
    checksMsg(recheckMessage(before, env.checks), true);
    if ($("checks-again-row").hidden) ($("checks-fold").querySelector("summary") as HTMLElement).focus();
  }, err => {
    btn.removeAttribute("aria-disabled");
    checksMsg(ipcErrorText(err), true);
  });
});

/** The sidebar's Setup link carries how many rows need the user, so a warning is seen from anywhere (review #95). */
function renderSetupBadge(needing: number, fails: number, held: number): void {
  const link = document.querySelector<HTMLAnchorElement>("#jump a[href=\"#checks-h\"]");
  if (!link) return;
  const b = setupBadge(needing, fails, held);
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
  const facts: [string, string, "path" | "text" | "copy" | "log"][] = [
    ["Ember", status.appVersion, "text"],
    ["Electron", `${v.electron ?? "?"} (Chromium ${v.chrome ?? "?"}, Node ${v.node})`, "text"],
    ["Settings", platform?.settingsFile ?? "~/.config/ember/settings.json", "path"],
    ["Log file", status.logFile, "log"],
    // Somewhere to say what went wrong (review #105): the window never opens links, so the address is there to copy.
    ["Report a problem", ISSUES_URL, "copy"],
  ];
  $("facts").replaceChildren(...facts.flatMap(([k, val, kind]) => {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.className = kind === "path" || kind === "log" ? "path" : "plain";
    dd.append(Object.assign(document.createElement("span"), { textContent: val }));
    if (kind === "copy" || kind === "log") {
      const copy = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: "Copy" });
      copy.setAttribute("aria-label", kind === "log" ? "Copy the log file's path" : `Copy the address ${val}`);
      // Through main (pages get no clipboard permission), as the sign-in code is copied.
      copy.addEventListener("click", () => { window.ember.copyText(val).then(() => { copy.textContent = "Copied"; }, () => { copy.textContent = "Couldn't copy"; }); });
      dd.append(copy);
    }
    if (kind === "log") {
      // The log to attach to a report, found where it is (rp-8): main shows only Ember's own log file.
      const show = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: showLogLabel(platform?.os ?? "linux") });
      show.addEventListener("click", () => { window.ember.showLogFile().catch(() => { show.textContent = "Couldn't open it"; }); });
      dd.append(show);
    }
    return [dt, dd];
  }));
  $("about-note").textContent = `Ember ${status.appVersion}`;
  renderSettingsNotice(status.settingsNotice);
  // The last run ended unexpectedly (rp-5): said for this run, with where its log is.
  $("run-notice").textContent = status.unexpectedExit ? closedUnexpectedlyText(status.logFile) : "";
  applySettings(status.settings);
  targetsStatus(status);
  extensionsStatus(status);
}

// ───── What differs by OS: shortcuts, folders, the consent's OS sentences (from main; Linux's markup until then) ─────
/** The OS words main sent; undefined while no status named them (the page's own markup is Linux's). */
let platform: StatusPlatform | undefined;
/** The last update status, drawn again once main's word of the platform (how Ember was installed) arrives. */
let updatesNow: UpdateStatus | null = null;
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
  if (updatesNow) renderUpdates(updatesNow);
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
  $("settings-notice").textContent = notice ?? "";
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
/** The data list's microphone line as the page wrote it (its conversation sentence changes while locked down). */
let micAsWritten: Node[] | null = null;
let lastAdmin: Status["admin"] | null = null;
/**
 * Names where requests actually go (copy.ts modelDestination) in the data list's "When you ask something" line and in
 * the microphone note and its list item, so none says Copilot while another service answers. Runs whenever the policy
 * or the user's provider changes, so the note is never stale when it is read.
 */
function renderRecipient(): void {
  const a = lastAdmin;
  if (!a) return;
  const d = destinationNow();
  // The locked-down line replaces the sentence (and this span) altogether. Apps & privacy's copy of the line follows it
  // too, without being drawn again: the copy keeps no ids (safety-privacy-r6).
  for (const service of document.querySelectorAll<HTMLElement>("#w-full #model-service, .model-service-copy")) {
    if (d.kind !== "none" && service.textContent !== recipientWords(d, true)) service.textContent = recipientWords(d, true);
  }
  for (const el of document.querySelectorAll<HTMLElement>(".model-recipient")) {
    const words = recipientWords(d);
    if (el.textContent !== words) el.textContent = words;
  }
  // Agreeing to "sent to …" needs the recipient named: unknown, "I agree" waits (aria-disabled keeps it focusable).
  const yes = $("consent-yes");
  if (d.kind === "unknown") yes.setAttribute("aria-disabled", "true"); else yes.removeAttribute("aria-disabled");
  // First run's consent says it in short, from the same answer (first-run-r2-2).
  welcome.recipient();
}
/** Where requests go now (copy.ts modelDestination); not known before the first policy, so never worded as Copilot. */
function destinationNow(): ModelDestination {
  const a = lastAdmin;
  if (!a) return { kind: "unknown" };
  return modelDestination({ locked: !!lockdownSendLine(a), adminProvider: a.provider ?? null, own: ownProvider() });
}
// The provider's card coming or going changes what the status panel says while nothing is connected (integrations-c2-3).
let cardDrawn = "";
onProviderDestination(() => {
  renderRecipient();
  const card = JSON.stringify(providerCard());
  if (card !== cardDrawn) { cardDrawn = card; if (agent) renderAgent(agent); }
});
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
  // And what a conversation sends is said as nothing sent, not as going to "no model service (…)" (safety-privacy-r4).
  const mic = document.querySelector<HTMLElement>("#w-full li[data-icon='mic']");
  if (mic) {
    micAsWritten ??= [...mic.childNodes].map(n => n.cloneNode(true));
    mic.replaceChildren(...micAsWritten.map(n => n.cloneNode(true)));
    const to = mic.querySelector(".model-recipient");
    const [before, after] = [to?.previousSibling, to?.nextSibling];
    const words = to && before?.nodeType === Node.TEXT_NODE && after?.nodeType === Node.TEXT_NODE ? lockdownMicWords(a, before.textContent ?? "", after.textContent ?? "") : null;
    if (to && before && after && words) { before.textContent = words[0]; after.textContent = words[1]; to.remove(); }
  }
  lastAdmin = a;
  if (agent) renderAgent(agent);
  renderRecipient();
  renderTagline();
  for (const [id, key] of [["wake", "wakeWord"], ["speak", "speak"], ["speak-results", "speak"], ["speak-rate", "speak"], ["natural-model", "naturalVoice"], ["m-conductor", "models"], ["m-worker", "models"], ["memory-on", "memory"], ["updates-on", "updates"], ["routines-on", "routines"], ["autonomy-on", "autonomy"], ["screen-images", "screenImages"]] as const) {
    const input = $(id) as HTMLInputElement | HTMLSelectElement;
    input.disabled = managed.has(key);
    (input.closest(MANAGED_ROW) ?? input).classList.toggle("locked", managed.has(key));
    if (managed.has(key)) input.title = "Managed by your organisation";
  }
  renderHear();
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
/** The newest entries read, how many to read (more once Show earlier needs them), and how many lines show. */
let activityRead: ActivityEntry[] = [];
let activityWanted = ACTIVITY_ENTRIES;
let linesShown = ACTIVITY_LINES;
/** A read that failed (home-10): what was shown stays, with a line that says so. */
let activityFailed = false;
/** `deep`: read all that is wanted (Show earlier); else only the newest page, with what was read before kept behind it. */
async function refreshActivity(deep = false): Promise<void> {
  let entries: ActivityEntry[];
  try {
    const fresh = await window.ember.activity(deep ? activityWanted : ACTIVITY_ENTRIES);
    entries = deep || activityWanted <= ACTIVITY_ENTRIES ? fresh
      : withEarlier(fresh, activityRead, ACTIVITY_ENTRIES, activityWanted) ?? await window.ember.activity(activityWanted);
  } catch {
    // Never an empty list for a failed read: "Nothing yet" would say Ember did nothing, and Today would reset.
    if (!activityFailed) { activityFailed = true; drawActivity(); }
    return;
  }
  const recovered = activityFailed;
  activityFailed = false;
  // Unchanged: leave the list alone (a screen reader keeps its place, the scroll position stays).
  const key = JSON.stringify(entries.slice(0, 1).map(e => e.t)) + entries.length + dayLabel(new Date().toISOString());
  if (key === shownActivity) { if (recovered) drawActivity(); return; }
  shownActivity = key;
  activityRead = entries;
  today = todayCounts(entries);
  renderStatus();
  drawActivity();
}
/** The record may hold entries older than those read: the read filled all it asked for. */
const activityMore = () => activityRead.length >= activityWanted && activityWanted < ACTIVITY_MAX_ENTRIES;
/**
 * What Ember did: a page of lines under their days, and Show earlier while there are more, read from the record a page
 * of ACTIVITY_ENTRIES at a time (safety-privacy-5: it stopped at 79 lines, and counted only those for today). Focus
 * stays on the line or button it was on when the list is drawn again.
 */
function drawActivity(): void {
  const list = $("activity");
  const problem = $("activity-problem");
  const held = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
  const lines = activityLines(activityRead, entryWords(platform));
  const seen = new Map<string, number>();
  let day = "";
  const items: HTMLLIElement[] = [];
  lines.slice(0, linesShown).forEach((l, i) => {
    // A heading for each day ("Today", "Yesterday", then dates): the list covers up to a month.
    if (l.day !== day) {
      day = l.day;
      items.push(Object.assign(document.createElement("li"), { className: "day", textContent: day }));
    }
    const n = seen.get(l.t) ?? 0;
    seen.set(l.t, n + 1);
    const li = document.createElement("li");
    li.dataset.key = `${l.t}|${n}`;
    li.dataset.line = String(i);
    const t = Object.assign(document.createElement("time"), { textContent: time(l.t), dateTime: l.t });
    const tag = Object.assign(document.createElement("span"), { className: `tag ${l.view.cls}`, textContent: l.view.tag });
    const what = Object.assign(document.createElement("span"), { className: "what", textContent: l.view.what });
    if (l.view.why) what.append(Object.assign(document.createElement("span"), { className: "why", textContent: l.view.why }));
    li.append(t, tag, what);
    items.push(li);
  });
  if (lines.length > linesShown || activityMore()) {
    const li = Object.assign(document.createElement("li"), { className: "more" });
    const more = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: ACTIVITY_EARLIER });
    more.dataset.key = "more";
    more.addEventListener("click", () => void showEarlier());
    li.append(more);
    items.push(li);
  }
  list.replaceChildren(...items);
  // Read before, then not: the lines stay, said to be old; never read: no "Nothing yet".
  list.hidden = activityFailed && !lines.length;
  problem.textContent = activityFailed ? activityProblemText(lines.length > 0) : "";
  $("activity-note").textContent = activityNote(lines, activityMore());
  const back = held ? [...list.querySelectorAll<HTMLElement>("[data-key]")].find(e => e.dataset.key === held) : undefined;
  if (back) { if (back.tagName === "LI") back.tabIndex = -1; back.focus({ preventScroll: true }); }
}
/** Show earlier: the next lines, read from the record when those read run out; focus goes to the first of them. */
async function showEarlier(): Promise<void> {
  const first = linesShown;
  linesShown += ACTIVITY_LINES;
  if (activityLines(activityRead, entryWords(platform)).length < linesShown && activityMore()) {
    activityWanted = Math.min(activityWanted + ACTIVITY_ENTRIES, ACTIVITY_MAX_ENTRIES);
    shownActivity = "";
    await refreshActivity(true);
  } else drawActivity();
  const row = $("activity").querySelector<HTMLElement>(`li[data-line="${first}"]`);
  if (row) { row.tabIndex = -1; row.focus(); }
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
window.addEventListener("focus", () => drawSoon());
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
/** The resting gap the last frame waited for (restingGap's, else 0): its time passes in full (frameSeconds). */
let planned = 0;
function frame(now: number): void {
  drawPending = false;
  const dt = frameSeconds(now - last, planned, 50);
  last = now;
  planned = 0;
  // Hidden, minimised or scrolled away: nothing is drawn until it shows again (drawSoon is called then).
  if (!canBeSeen() || !onScreen.size) return;
  const drawn: Rig[] = [];
  if (onScreen.has(heroCanvas)) { paint(heroCanvas, heroRig, heroChars[settings?.character ?? "cinder"], dt, 170); drawn.push(heroRig); }
  for (const c of cards) if (onScreen.has(c.canvas)) { paint(c.canvas, c.rig, c.character, dt, 175); drawn.push(c.rig); }
  const motion = looking || drawn.some(r => r.motion === "brisk") ? 0 : drawn.some(r => r.motion === "gentle") ? 1 : 2;
  looking = false;
  // In a window the user isn't working in (behind another, or minimised: X11 doesn't always say hidden), less often,
  // and a still face not until something changes: the focus coming back (below), the pointer, the window showing (rp-4).
  const gap = homeFrameGap(motion, document.hasFocus());
  if (gap === null) return;
  // Every face shown awake at rest, Ready: about 6 frames a second, waking for the next blink (rp-4).
  const rest = motion === 2 && drawn.length ? Math.min(...drawn.map(r => restingGap(r, gap))) : gap;
  if (rest > gap) planned = rest;
  drawSoon(rest);
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
  // Copilot stopped answering with tasks at work: Ember reconnects once they're done. Signing in again isn't the
  // fix, and reconnecting now stops the tasks: the button says so.
  const waiting = a.waitingForTasks === true;
  // What leads depends on why Copilot isn't connected (FE #3): an account without Copilot is not asked to sign in again.
  const a2 = lastAdmin;
  const view = homeConnectionView({
    phase: a.phase, reason: a.reason, detail: a.detail, signingIn, waiting, service: a.service?.kind, own: providerCard(),
    ownOffered: ownProviderOffer({
      bridge: !!window.emberProvider, managedProvider: !!a2?.provider, locked: !!a2 && a2.error !== null,
      userProviderOff: a2?.features.userProvider === false,
    }).offered,
  });
  // Written only when its words change: its role=status line said "Connected." again on every request, into the
  // conversation it opened (voice-listening-r4-2).
  const line = view.line || a.detail;
  if ($("agent-text").textContent !== line) $("agent-text").textContent = line;
  $("sign-in").hidden = !view.show["sign-in"] || waiting;
  // Without Ember's own GitHub App the button waits for a GitHub CLI sign-in: it doesn't promise a browser sign-in.
  $("sign-in").textContent = signInLabel(a.signInWith);
  $("own-provider").hidden = !view.show["own-provider"];
  $("provider-details").hidden = !view.show.provider;
  $("provider-details").classList.toggle("quiet", view.primary !== "provider");
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
  // "Still can't connect" from Check again goes once the provider connects, rather than sit under Connected (integrations-c1-1).
  if (retryProvider && a.phase === "ready") { if ($("sign-in-msg").textContent === retryProvider) signInMsg(""); retryProvider = null; }
  // A button that just went away (Sign in, Check again…) hands focus to the one that took its place.
  if (had && COPILOT_BUTTONS.includes(had.id) && isHidden(had)) focusFirst([...COPILOT_BUTTONS, "copilot-h"]);
  renderTagline();
  // The Model provider hint says whether anything answers while its card waits (integrations-r3-1).
  providerSignedOut(a.phase === "signed-out");
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
let retryFound: RetryResult | null = null;
/** Check again's "still can't connect" line for a model provider, while it shows. */
let retryProvider: string | null = null;
// "Try a different GitHub account" is the same sign-in: GitHub's page lets them choose another account.
$("switch-account").addEventListener("click", () => $("sign-in").click());
// The user's own provider is failing (integrations-3): its fields are the way on, the model's when it names none.
$("provider-details").addEventListener("click", () => {
  const field = $(agent?.reason === "models" ? "byok-conductor" : "byok-url");
  field.scrollIntoView({ block: "center" });
  field.focus();
});
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
    const text = retryMessage(r, r.found && agent?.phase === "ready");
    retryProvider = r.provider && text ? text : null;
    say(text);
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
/**
 * Whether the conversation answers a request now, as main says (home-c1-1): from the composer, the Ask box or voice.
 * The status panel says "Thinking…" while it does, and the composer's wait ends when it stops.
 */
let conversationTurnNow: ConversationTurn = "idle";
/** How main says the last turn ended, when a Stop ended it (home-c2-2): its words, not a guess from the lines. */
let conversationTurnEnded: ConversationTurnEnd | undefined;
/** The composer's request was taken by main (its send resolved), and main has said it is answering since it was sent. */
let conversationSendTaken = false;
let conversationTurnSeen = false;
/**
 * A message sent from the composer is (or is no longer) being answered: the status panel says "Thinking…", and the
 * composer's line follows main's word of the turn (home-7, home-c1-1).
 */
function awaitingReply(on: boolean): void {
  conversationAwaitingReply = on;
  renderStatus();
}
/**
 * The composer's request had its turn and the turn is over (home-c1-1): what it left is said, though it wrote nothing (it
 * only started a task, ran a step, or was stopped). A reply or a problem says so as it comes (renderConversation).
 */
function endComposerWait(): void {
  if (!conversationAwaitingReply || !conversationSendTaken || !conversationTurnSeen || conversationTurnNow !== "idle") return;
  awaitingReply(false);
  const said = sinceSend().filter(e => e.who === "ember" || e.who === "problem").at(-1);
  // A Stop that ended it left no line to read it from (the bubble's own Stop: home-c2-2).
  const stopped = conversationTurnEnded === "stopped-everything" ? COMPOSER_SAYS.stoppedAll : conversationTurnEnded === "stopped" ? CONVERSATION_STOPPED : null;
  const words = stopped ? stoppedLine(stopped)
    : said?.who === "problem" ? COMPOSER_SAYS.replyFailed : said?.stopped ? COMPOSER_SAYS.replyStopped : said ? COMPOSER_SAYS.replied : COMPOSER_SAYS.noReply;
  keepingComposer(() => { conversationComposeStatus.textContent = words; });
}
/** What came after the last message there was as the composer's request was sent (rows are matched by what they are). */
function sinceSend(): Entry[] {
  const was = conversationLastAtSend;
  let at = -1;
  if (was) for (let i = conversationAll.length - 1; i >= 0 && at < 0; i--) if (conversationAll[i].t === was.t && conversationAll[i].who === was.who && conversationAll[i].text === was.text) at = i;
  return conversationAll.slice(at + 1);
}
/**
 * How a Stop ended the composer's request (`stopped`), and the words given back (home-r3-1): main keeps a request's line
 * once it goes to the model (or is answered, or refused), so every message main took whose line never came was dropped
 * unsent, waiting for a reconnect. They go back in the composer, oldest first, and never over anything typed since: it
 * stays after them, the caret where it was in it (home-v4-2). Said once however the Stop is told.
 */
function stoppedLine(stopped: string): string {
  const unsent = conversationUnsent.filter(u => u.taken).map(u => u.text.trim());
  conversationUnsent = conversationUnsent.filter(u => !u.taken);
  if (!unsent.length) return conversationGivenBack !== null && conversationComposeStatus.textContent === conversationGivenBack ? conversationGivenBack : stopped;
  const words = unsent.join("\n\n");
  const draft = conversationMessage.value.trim() ? conversationMessage.value : "";
  if (draft) {
    const { selectionStart, selectionEnd, selectionDirection } = conversationMessage;
    const by = words.length + 2;
    conversationMessage.value = `${words}\n\n${draft}`;
    conversationMessage.setSelectionRange(selectionStart + by, selectionEnd + by, selectionDirection);
  } else conversationMessage.value = words;
  syncComposerCount();
  conversationGivenBack = composerGivenBack(stopped, unsent.length, !!draft);
  return conversationGivenBack;
}
/** Main's word of the conversation's turn: the status panel, and the composer's line while its request waits. */
function conversationTurn(value: unknown): void {
  const change = conversationTurnChangeOf(value);
  if (!change) return;
  const turn = change.turn;
  conversationTurnNow = turn;
  conversationTurnEnded = change.ended;
  if (conversationAwaitingReply && turn !== "idle") conversationTurnSeen = true;
  const waiting = composerStillWaiting(agent?.service?.kind);
  if (conversationAwaitingReply && conversationSendTaken) {
    // Still waiting as the bubble says it (nothing written yet), and back to thinking once it is heard from.
    if (turn === "slow" && !answerStream.row) keepingComposer(() => { conversationComposeStatus.textContent = waiting; });
    else if (turn === "thinking" && conversationComposeStatus.textContent === waiting) conversationComposeStatus.textContent = COMPOSER_THINKING;
  } else if (!conversationAwaitingReply) {
    // A request from the Ask box or by voice that the bubble says is still waiting: the line under Stop response (where
    // the settings key lands then) says so, not an older message's outcome, and goes once the wait does (home-r2-3). A
    // note about the draft (Edit's caution, the over-limit note) stays: the wait isn't the draft's (home-c3-1).
    if (turn === "slow" && !answerStream.row) { if (composerLineYields(conversationComposeStatus.textContent ?? "")) keepingComposer(() => { conversationComposeStatus.textContent = waiting; }); }
    else if (conversationComposeStatus.textContent === waiting) conversationComposeStatus.textContent = "";
  }
  endComposerWait();
  if (turn === "idle") {
    // Nothing waits in main now. With no Stop, every message it took has its line, or never will (home-v4-1); a Stop
    // dropped those still without one, given back though the composer waited for none of them (a later send was
    // refused: home-v4-2).
    if (!change.ended) conversationUnsent = conversationUnsent.filter(u => !u.taken);
    else if (conversationUnsent.some(u => u.taken)) keepingComposer(() => { conversationComposeStatus.textContent = stoppedLine(change.ended === "stopped-everything" ? COMPOSER_SAYS.stoppedAll : CONVERSATION_STOPPED); });
  }
  renderStatus();
}
window.ember.onConversationTurn(conversationTurn);
void window.ember.conversationTurn().then(conversationTurn, () => undefined);
// Stop everything (its shortcut, "Ember, stop", the handle's menu, a typed "stop"): the composer's request went with it.
window.ember.onStopped(() => {
  if (!conversationAwaitingReply) return;
  awaitingReply(false);
  keepingComposer(() => { conversationComposeStatus.textContent = stoppedLine(COMPOSER_SAYS.stoppedAll); });
});
let conversationLastAtSend: Entry | undefined;
/**
 * The composer's messages being sent, or main took (`taken`), each until its own line comes (stillUnsent): given back
 * if a Stop dropped them unsent (stoppedLine: home-r3-1, home-v4-2), never once Ember answered them (home-v4-1).
 */
let conversationUnsent: { text: string; taken: boolean }[] = [];
/** The line that last said a Stop gave words back (stoppedLine). */
let conversationGivenBack: string | null = null;
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
  // "Ember learned: …" with Undo (forgets that fact): a small line of its own, not a message. Once forgotten it says
  // so where it was, with the Undo that puts it back, and once put back that it is remembered again (memory-c1-3).
  if (e.who === "learned") {
    const text = Object.assign(document.createElement("p"), {
      textContent: e.again ? rememberedAgainLine(e.text) : e.forgot ? forgotLine(e.text, e.derived, e.back) : learnedLine(e.text),
      // Where focus goes when its own Undo changed the line, so a second Enter does nothing and the change is read out.
      tabIndex: -1,
    });
    li.append(text);
    li.dataset.state = learnedState(e);
    const id = e.fact;
    if (e.again) return li;
    if (e.forgot) mountForgotUndo(li, e.text, e.forgot, window.ember.restoreMemory);
    else if (id) mountLearnedUndo(li, e.text, id, async fact => { await window.ember.forgetMemory(fact); });
    return li;
  }
  const who = Object.assign(document.createElement("span"), { className: "who", textContent: WHO[e.who] ?? e.who });
  // A line kept from before a restart may be days old: its day is said too (home-8).
  const when = e.restored ? conversationWhen(e.t, time(e.t)) : time(e.t);
  const t = Object.assign(document.createElement("time"), { textContent: when, dateTime: e.t });
  // A Problem line names the section that helps, here in Ember's settings (home-7).
  const problem = e.who === "problem" ? problemInHome(e.text) : null;
  const text = Object.assign(document.createElement("p"), { textContent: problem?.text ?? e.text });
  // A request Ember heard: "That's not what I said" finds its row by this (personal.ts markHeard).
  if (e.heardId) li.dataset.heardId = String(e.heardId);
  li.append(who, t, text);
  const actions = Object.assign(document.createElement("div"), { className: "conversation-message-actions" });
  if (e.who === "ember" || e.who === "you") {
    const copy = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: "Copy" });
    copy.setAttribute("aria-label", `Copy ${e.who === "you" ? "your message" : "Ember's answer"} from ${when}`);
    copy.addEventListener("click", () => {
      // Answered by main: aria-disabled, not disabled, which drops the keyboard focus to the page (home-c1-3).
      if (copy.getAttribute("aria-disabled") === "true") return;
      copy.setAttribute("aria-disabled", "true");
      // Said on the button, where the eye is, for 2 s (as About's Copy does), and in the status line for screen readers.
      const said = (label: string) => { copy.textContent = label; setTimeout(() => { copy.textContent = "Copy"; }, 2000); };
      void window.ember.copyText(e.text).then(() => { said("Copied"); conversationComposeStatus.textContent = COMPOSER_SAYS.copied; }, () => {
        said("Couldn't copy");
        conversationComposeStatus.textContent = COMPOSER_SAYS.copyFailed;
      }).finally(() => { copy.removeAttribute("aria-disabled"); });
    });
    actions.append(copy);
  }
  if (e.who === "you") {
    const edit = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: "Edit" });
    edit.setAttribute("aria-label", `Edit your message from ${when} as a new request`);
    edit.addEventListener("click", () => {
      // Editing has no IPC side effect: Send is a new, deliberate typed request, never a tool/voice/suggestion replay.
      if (conversationDraftBeforeEdit === null) conversationDraftBeforeEdit = conversationMessage.value;
      $("conversation-cancel-edit").hidden = false;
      conversationMessage.value = e.text;
      syncComposerCount();
      conversationComposeStatus.textContent = CONVERSATION_EDIT;
      conversationMessage.focus();
    });
    actions.append(edit);
  }
  // A live problem that settings can help with: the way there (not a line kept from before a restart, now long past).
  if (problem?.settings && !e.restored) {
    const go = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: PROBLEM_SETTINGS });
    go.setAttribute("aria-label", `${PROBLEM_SETTINGS} for the problem from ${when}`);
    go.addEventListener("click", () => showSection("copilot"));
    actions.append(go);
  }
  if (actions.childElementCount) li.append(actions);
  if (e.stopped) li.append(Object.assign(document.createElement("small"), { className: "conversation-limit", textContent: STOPPED_NOTE }));
  if (e.truncated) li.append(Object.assign(document.createElement("small"), { className: "conversation-limit", textContent: CONVERSATION_TRUNCATED }));
  return li;
}
/**
 * The conversation is part of the page, not a box that scrolls inside it (UI audit #1): its latest messages, and "Show
 * earlier messages" for the rest (conversation-view.ts). Rows are matched by what they are, so a new message is added in
 * place and the oldest shown goes from the top; nothing scrolls the page on its own but the composer the person is
 * writing in, kept in view as a reply grows above it (keepingComposer).
 */
/** Every message, once "Show earlier messages" was pressed (until the conversation is forgotten). */
let conversationAllShown = false;
let conversationAll: Entry[] = [];
/** The answer being written: one row that grows in place (conversation-stream.ts), kept apart from the messages' rows. */
let answerStream = NO_STREAM;
/** Where the lines kept from before a restart end (home-8): one row, moved as the list changes. */
const restoredEnd = Object.assign(document.createElement("li"), { className: "restored-end", textContent: CONVERSATION_RESTORED_END });
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
/** What a "learned" line says now: learned (its fact), forgotten (its Undo's token) or remembered again (memory-c1-3). */
const learnedState = (e: Entry) => (e.again ? "again" : e.forgot ? `forgot:${e.forgot}` : `fact:${e.fact ?? ""}`);
/**
 * A "learned" line whose state changed (main keeps the line where it was): drawn again in place. Focus in it, on the
 * Undo just pressed, moves to its new words, which a screen reader then reads (memory-c1-3).
 */
function redrawLearned(row: HTMLElement, e: Entry): HTMLElement {
  if (e.who !== "learned" || row.dataset.state === undefined || row.dataset.state === learnedState(e)) return row;
  const had = row.contains(document.activeElement);
  const next = conversationRow(e);
  next.hidden = row.hidden;
  row.replaceWith(next);
  if (had) next.querySelector("p")?.focus();
  return next;
}
function renderConversation(raw: Entry[]): void {
  answerStream = streamEntries(answerStream, raw);
  const entries = raw;
  // Forgotten (signed out, another account): back to the latest messages.
  if (!entries.length) {
    conversationAllShown = false;
  }
  // A message of the composer's whose own line came went: no Stop gives it back after that, however far the
  // conversation has moved past it (home-v4-1: main keeps 60 lines).
  if (conversationUnsent.length) conversationUnsent = stillUnsent(conversationUnsent, conversationAdded(conversationAll, raw));
  conversationAll = raw;
  const list = $("conversation");
  // Out of the way while the messages' rows change (their changes count rows from the top), back at the end after.
  streamRowEl?.remove();
  restoredEnd.remove();
  const searching = !!conversationSearch.value.trim();
  // A message holding the keyboard focus (its Copy, its Edit) stays, and those after it, while the focus does (home-c1-2).
  const focus = document.activeElement;
  const holding = focus && focus !== list ? shownConversation[[...list.children].findIndex(li => li.contains(focus))] : undefined;
  const shown = conversationShown(entries, conversationAllShown || searching, holding);
  const { drop, add } = conversationChange(shownConversation, shown);
  for (let i = 0; i < drop; i++) list.firstElementChild?.remove();
  list.append(...add.map(conversationRow));
  shownConversation = shown;
  let matches = 0;
  for (let i = 0; i < shown.length; i++) {
    // (A Problem line is found by the words it shows: home-7.)
    const match = !searching || conversationMatchesText(shown[i].who === "problem" ? problemInHome(shown[i].text).text : shown[i].text, conversationSearch.value);
    redrawLearned(list.children[i] as HTMLElement, shown[i]).hidden = !match;
    if (match) matches++;
  }
  $("conversation-search-status").textContent = searching ? conversationSearchCount(matches) : "";
  // Under the last line kept from before a restart: those are for reading, and this conversation starts below (home-8).
  let lastRestored = -1;
  for (let i = 0; i < shown.length; i++) if (shown[i].restored) lastRestored = i;
  if (lastRestored >= 0 && !searching) list.children[lastRestored].after(restoredEnd);
  syncStreamRow(list);
  const latest = raw.at(-1);
  const newReply = latest && (latest.t !== conversationLastAtSend?.t || latest.who !== conversationLastAtSend?.who || latest.text !== conversationLastAtSend?.text);
  // (An answer stopped short is not a reply received: the problem that follows it, or the Stop, says what happened.)
  // Once main said it is answering this request, its turn's end says it (endComposerWait): a line of Ember's that comes
  // meanwhile (a reminder, the answer to a request asked before) isn't taken for this reply (home-7). A request answered
  // with no turn (Ember's own answers, one it couldn't send) ends here.
  if (conversationAwaitingReply && !conversationTurnSeen && newReply && (latest.who === "problem" || (latest.who === "ember" && !latest.stopped))) {
    awaitingReply(false);
    conversationComposeStatus.textContent = raw.at(-1)?.who === "problem" ? COMPOSER_SAYS.replyFailed : COMPOSER_SAYS.replied;
  }
  // Requests Ember heard (not typed) offer “That's not what I said”.
  markHeard(list);
  if (latestWanted && list.querySelector(":scope > li.ember")) queueMicrotask(() => { if (latestWanted) showSection("conversation:latest", true); });
  const earlier = $("conversation-earlier") as HTMLButtonElement;
  const label = earlierLabel(entries.length - shown.length);
  earlier.hidden = !label;
  if (label) earlier.textContent = label;
}
/** Whether some of `el` shows in the window (`whole`: all of it). */
const inWindow = (el: Element, whole = false) => {
  const r = el.getBoundingClientRect();
  return whole ? r.top >= 0 && r.bottom <= innerHeight : r.bottom > 0 && r.top < innerHeight;
};
/**
 * A reply grows above the composer the person is writing in, and pushed it, still focused, below the window (home-1):
 * while the focus is in the composer and it showed, its buttons are brought back into view after the change (nearest
 * edge, no glide: it moves by a line at a time). Nothing scrolls for someone reading elsewhere, or who scrolled away.
 */
function keepingComposer(change: () => void): void {
  const form = $("conversation-compose");
  const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  const focused = active && form.contains(active) ? active : null;
  const showed = !!focused && inWindow(focused);
  // Someone reading elsewhere (the focus on a message's Copy) keeps their place when rows above go (only the last
  // messages show). The browser's scroll anchoring holds it at once, mostly; where it didn't, the Copy jumped 333 px in
  // CI (home-1). Measured after the change, so what the anchoring already did isn't done twice.
  const reading = !focused && active && inWindow(active) ? { el: active, top: active.getBoundingClientRect().top } : null;
  change();
  if (reading?.el.isConnected) {
    const moved = reading.el.getBoundingClientRect().top - reading.top;
    if (Math.abs(moved) >= 1) window.scrollBy(0, moved);
  }
  if (!focused || !showed) return;
  const actions = form.querySelector(".conversation-compose-actions");
  // With the line under them that says how the request is going, while it says something (home-7).
  const status = conversationComposeStatus.textContent ? conversationComposeStatus : null;
  if (actions && (!inWindow(focused, true) || !inWindow(actions, true) || (status && !inWindow(status, true)))) (status ?? actions).scrollIntoView({ block: "nearest", behavior: "auto" });
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
}, () => { if (!conversationReceived && conversationOpened === conversationGeneration) conversationComposeStatus.textContent = COMPOSER_SAYS.loadFailed; });
window.ember.onConversation(entries => { conversationReceived = true; keepingComposer(() => renderConversation(entries)); });
const resetConversationView = () => {
  // Only explicit session erasure clears an unsent draft; forgetting the last learned fact can also empty this list.
  conversationMessage.value = "";
  syncComposerCount();
  conversationSearch.value = "";
  conversationComposeStatus.textContent = "";
  awaitingReply(false);
  conversationLastAtSend = undefined;
  conversationUnsent = [];
  conversationGivenBack = null;
  conversationDraftBeforeEdit = null;
  conversationGeneration++;
  $("conversation-cancel-edit").hidden = true;
  newConfirm.hidden = true;
  const send = $("conversation-send") as HTMLButtonElement;
  send.removeAttribute("aria-disabled");
  send.textContent = "Send";
  $("conversation-stop").removeAttribute("aria-disabled");
  conversationSendTaken = conversationTurnSeen = false;
  renderConversation([]);
};
window.ember.onConversationForgotten(resetConversationView);
window.ember.onConversationStream(e => {
  const ev = e as Partial<StreamEvent> | null;
  if (!ev || !Number.isSafeInteger(ev.id) || typeof ev.text !== "string" || !["streaming", "done", "interrupted"].includes(ev.state ?? "")) return;
  answerStream = streamEvent(answerStream, ev as StreamEvent, conversationAll, new Date().toISOString());
  keepingComposer(() => syncStreamRow($("conversation")));
  // Written to at last: no longer a wait (the reply, or what stopped it, says the rest). The composer's own request is
  // thinking still; another's wait goes with the turn's next word (home-c3-1).
  if (conversationAwaitingReply && answerStream.row && conversationComposeStatus.textContent === composerStillWaiting(agent?.service?.kind)) conversationComposeStatus.textContent = COMPOSER_THINKING;
});
/** New conversation asks first while there are messages to clear (home-9): Keep, or Escape, leaves them be. */
const newConfirm = $("conversation-new-confirm");
const closeNewConfirm = (refocus: boolean) => {
  if (newConfirm.hidden) return;
  newConfirm.hidden = true;
  if (refocus) $("conversation-new").focus();
};
$("conversation-new").addEventListener("click", () => {
  const messages = conversationAll.filter(e => e.who !== "learned").length;
  if (!messages) { startNewConversation(); return; }
  $("conversation-new-question").textContent = conversationNewQuestion(messages, settings?.keepConversation === true);
  newConfirm.hidden = false;
  $("conversation-new-no").focus();
});
$("conversation-new-no").addEventListener("click", () => closeNewConfirm(true));
$("conversation-new-yes").addEventListener("click", () => { closeNewConfirm(false); startNewConversation(); });
newConfirm.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeNewConfirm(true); } });
function startNewConversation(): void {
  const button = $("conversation-new") as HTMLButtonElement;
  const generation = conversationGeneration;
  button.disabled = true;
  void window.ember.conversationNew().then(() => {
    // Forgotten or reset another way meanwhile (sign-out, another account): a newer draft isn't this click's to clear.
    if (generation !== conversationGeneration) return;
    resetConversationView();
    conversationComposeStatus.textContent = COMPOSER_SAYS.started;
    conversationMessage.focus();
  }, () => { if (generation === conversationGeneration) conversationComposeStatus.textContent = COMPOSER_SAYS.startFailed; })
    .finally(() => { button.disabled = false; });
}
conversationSearch.addEventListener("input", () => renderConversation(conversationAll));
$("conversation-compose").addEventListener("submit", event => {
  event.preventDefault();
  const send = $("conversation-send") as HTMLButtonElement;
  // While a send is answered (aria-disabled: a disabled Send pressed from the keyboard dropped its focus, home-c1-3).
  if (send.getAttribute("aria-disabled") === "true") return;
  const text = conversationMessage.value;
  if (!text.trim() || text.length > CONVERSATION_REQUEST_LIMIT) {
    keepingComposer(() => { conversationComposeStatus.textContent = text.trim() ? COMPOSER_OVER : COMPOSER_SAYS.empty; });
    conversationMessage.focus();
    return;
  }
  // A search left typed in would hide this request and its reply while the status says the reply came (home-4). The
  // messages it hid come back above the composer: it is kept in view with them (home-r1).
  if (conversationSearch.value) keepingComposer(() => { conversationSearch.value = ""; renderConversation(conversationAll); });
  send.setAttribute("aria-disabled", "true");
  send.textContent = "Sending…";
  // Only main's word of this request's turn ends the wait: not a turn under way before it (home-c1-1).
  conversationSendTaken = false;
  conversationTurnSeen = false;
  awaitingReply(true);
  conversationLastAtSend = conversationAll.at(-1);
  const generation = conversationGeneration;
  // Kept from now, so its own line coming before main answers the send still takes it off (home-v4-1).
  const unsent = { text, taken: false };
  conversationUnsent.push(unsent);
  // Each of the line's words while the send goes is brought into view under the buttons, where they push it (home-c3-2).
  keepingComposer(() => { conversationComposeStatus.textContent = COMPOSER_SAYS.sending; });
  void window.ember.conversationSend(text).then(sent => {
    if (generation !== conversationGeneration) return;
    // Preserve any edits made while the acknowledgement was pending.
    if (conversationMessage.value === text) conversationMessage.value = "";
    syncComposerCount();
    conversationDraftBeforeEdit = null;
    $("conversation-cancel-edit").hidden = true;
    // A typed "stop" stopped everything at once: no turn comes, so nothing is awaited (home-c1-1).
    if (sent === "stopped") {
      conversationUnsent = conversationUnsent.filter(u => u !== unsent);
      awaitingReply(false);
      keepingComposer(() => { conversationComposeStatus.textContent = COMPOSER_SAYS.stoppedAll; });
      return;
    }
    // Main has it: given back if a Stop drops it before its line comes (home-r3-1), whichever send the composer waits for.
    unsent.taken = true;
    if (!conversationAwaitingReply) return;
    conversationSendTaken = true;
    // Main answers already (this request, or one before it that it waits behind): its end is this one's too.
    if (conversationTurnNow !== "idle") conversationTurnSeen = true;
    keepingComposer(() => { conversationComposeStatus.textContent = conversationTurnNow === "slow" && !answerStream.row ? composerStillWaiting(agent?.service?.kind) : COMPOSER_THINKING; });
    endComposerWait();
  }, error => {
    if (generation !== conversationGeneration) return;
    conversationUnsent = conversationUnsent.filter(u => u !== unsent);
    awaitingReply(false);
    keepingComposer(() => { conversationComposeStatus.textContent = ipcErrorText(error) || COMPOSER_SAYS.sendFailed; });
  }).finally(() => { if (generation === conversationGeneration) { send.removeAttribute("aria-disabled"); send.textContent = "Send"; } });
});
$("conversation-cancel-edit").addEventListener("click", () => {
  conversationMessage.value = conversationDraftBeforeEdit ?? "";
  syncComposerCount();
  conversationDraftBeforeEdit = null;
  $("conversation-cancel-edit").hidden = true;
  conversationComposeStatus.textContent = COMPOSER_SAYS.editCancelled;
  conversationMessage.focus();
});
/**
 * The count under the composer near the limit, and how much to shorten a message over it: a long paste is kept whole
 * (no maxlength cutting its end off unseen), and Send refuses it until it fits (home-5). Crossing the limit is said once.
 */
let conversationOver = false;
function syncComposerCount(): void {
  const n = conversationMessage.value.length;
  const words = composerCount(n);
  const count = $("conversation-count");
  if (count.textContent !== words) count.textContent = words;
  count.hidden = !words;
  const over = n > CONVERSATION_REQUEST_LIMIT;
  if (over) conversationMessage.setAttribute("aria-invalid", "true"); else conversationMessage.removeAttribute("aria-invalid");
  if (over && !conversationOver) conversationComposeStatus.textContent = COMPOSER_OVER;
  else if (!over && conversationOver && conversationComposeStatus.textContent === COMPOSER_OVER) conversationComposeStatus.textContent = "";
  conversationOver = over;
}
conversationMessage.addEventListener("input", syncComposerCount);
conversationMessage.addEventListener("keydown", event => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
    event.preventDefault();
    ($("conversation-compose") as HTMLFormElement).requestSubmit();
  }
});
$("conversation-stop").addEventListener("click", () => {
  const stop = $("conversation-stop");
  const generation = conversationGeneration;
  // Pressed again while main answers: nothing more (aria-disabled keeps the keyboard focus here: home-c1-3).
  if (stop.getAttribute("aria-disabled") === "true") return;
  stop.setAttribute("aria-disabled", "true");
  void window.ember.conversationStop().then(stopped => {
    if (generation !== conversationGeneration) return;
    awaitingReply(false);
    // (An older main answers nothing: as before, taken as stopped.) Said under the buttons, in view (home-c3-2).
    keepingComposer(() => { conversationComposeStatus.textContent = stopped === false ? CONVERSATION_NOTHING_TO_STOP : stoppedLine(CONVERSATION_STOPPED); });
  }, () => { if (generation === conversationGeneration) keepingComposer(() => { conversationComposeStatus.textContent = COMPOSER_SAYS.stopFailed; }); })
    .finally(() => { if (generation === conversationGeneration) stop.removeAttribute("aria-disabled"); });
});

// ───── Memory (docs/MEMORY.md): kept between runs, only once the user turns it on and agrees to its note ─────
$("memory-consent-text").textContent = MEMORY_CONSENT_TEXT;
const memoryOn = () => !!settings?.memory.on && (settings?.memory.consent.version ?? 0) >= MEMORY_VERSION;
/**
 * When a consent card came up (performance.now(), by its agree button): a press on that button sooner than
 * AGREE_ARM_MS is dropped, as first run's is (first-run-c1-1), so a repeating Space from the switch, or an Enter typed
 * for another app as the card opens, agrees to nothing (memory-r7).
 */
const agreeShownAt = new Map<string, number>();
const showConsentCard = (card: string, agree: string) => { $(card).hidden = false; agreeShownAt.set(agree, performance.now()); };
const agreeArmed = (agree: string) => performance.now() - (agreeShownAt.get(agree) ?? -Infinity) >= AGREE_ARM_MS;
/**
 * Where focus waits while Memory's list is out of sight (a reconnect's account check) or a control in it goes: the
 * section's heading, which does nothing on a key. Never the switch, where a typed space turns memory off, or on again
 * under a note already agreed to (memory-c2-1).
 */
const memoryRest = () => $("memory-h");
let memoryOwner: MemoryView["ownership"] = "waiting";
let memoryReason: MemoryView["reason"];
/** What is wrong with memory.json this run (memory-r2): Home's status line says "Memory paused" while it can't be read. */
let memoryTrouble: MemoryView["trouble"] = null;
let memoryEpoch = 0;
/** Where focus was in the search when memory went to be checked again, and under which epoch (memory-8). */
let memoryFocusBack: { el: HTMLElement; epoch: number } | null = null;
const memoryCorrection = mountMemoryCorrection(window.ember, memoryRest, (expected, corrected) => {
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
  fallback: memoryRest,
  create: read => {
    const row = read();
    const li = document.createElement("li");
    const fact = Object.assign(document.createElement("span"), { className: "mem-fact" });
    fact.append(Object.assign(document.createElement("span"), { textContent: row.text }), Object.assign(document.createElement("span"), { className: "mem-from", textContent: memoryProvenanceLabel(row.source, row.correctedAt, row.kind) }));
    const button = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: "Forget" });
    button.setAttribute("aria-label", forgetMemoryLabel(row.text));
    button.dataset.memoryForget = "";
    button.addEventListener("click", () => {
      // One Forget at a time, and never one that focus just landed on as its row's neighbour went: a second Enter or a
      // repeating key forgets nothing more (memory-7).
      if (memoryForgetting || KeyedRows.justFocused(button)) return;
      const row = read();
      memoryForgetting = true;
      void deleteMemory(button, async () => { showForgotten(row.text, await window.ember.forgetMemory(row.id)); })
        .finally(() => { memoryForgetting = false; });
    });
    const correct = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: MEMORY_CORRECTION.correct });
    correct.dataset.memoryCorrect = row.id;
    correct.addEventListener("click", () => memoryCorrection.open(read()));
    const actions = Object.assign(document.createElement("div"), { className: "agent-actions" });
    actions.append(button, correct); li.append(fact, actions);
    return li;
  },
  update: (li, row) => {
    li.querySelector<HTMLElement>(".mem-fact > span")!.textContent = row.text;
    li.querySelector<HTMLElement>(".mem-from")!.textContent = memoryProvenanceLabel(row.source, row.correctedAt, row.kind);
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
  // Focus in the search while the same account is checked again (a reconnect) waits on the heading, and goes back if it
  // is still there when the list returns (memory-8); another account's list (a new epoch) never gets it back.
  if (memoryFocusBack && memoryFocusBack.epoch !== memoryEpoch) memoryFocusBack = null;
  if (unavailable && filters.contains(document.activeElement)) { memoryFocusBack = { el: document.activeElement as HTMLElement, epoch: memoryEpoch }; memoryRest().focus(); }
  filters.hidden = unavailable;
  $("memory-list").hidden = unavailable;
  if (!unavailable && memoryFocusBack) {
    if (document.activeElement === memoryRest()) memoryFocusBack.el.focus();
    memoryFocusBack = null;
  }
  // What was forgotten belonged to the list that was open: it goes when the list does (another account, a pause), and
  // waits out of sight while the same account is checked again, its Undo with it (memory-8).
  if (forgottenHeld && forgottenHeld.epoch !== memoryEpoch) hideForgotten();
  if (unavailable && !$("memory-forgotten").hidden) {
    const box = $("memory-forgotten");
    if (memoryUndo && forgottenEpoch === memoryEpoch) {
      forgottenHeld = { epoch: memoryEpoch, focused: box.contains(document.activeElement) };
      box.hidden = true;
      if (forgottenHeld.focused) memoryRest().focus();
    } else hideForgotten();
  }
  if (!unavailable && forgottenHeld) {
    const held = forgottenHeld;
    forgottenHeld = null;
    $("memory-forgotten").hidden = false;
    if (held.focused && document.activeElement === memoryRest()) $("memory-forgotten-text").focus();
  }
  // An empty list says so in its own row, never "0 of 0 memories" above it (memory-13).
  $("memory-count").textContent = unavailable || !rows.length ? "" : memoryCountText(page.rows.length, page.total, rows.length);
  const more = $("memory-more");
  const moreWasFocused = document.activeElement === more;
  more.hidden = page.rows.length >= page.total;
  if (moreWasFocused && more.hidden) ($("memory-list").querySelector<HTMLElement>("li:last-child button") ?? (unavailable ? memoryRest() : memoryQuery)).focus();
  // Why memory isn't open, never advice to erase memory that only waits (a model provider, a reconnect: memory-2).
  const ownerText = memoryOwnerText(memoryReason, memoryOwner === "locked");
  $("memory-owner").textContent = memoryOwner === "ready" || (memoryOwner === "waiting" && !memoryOn()) ? "" : ownerText;
  // Tell Ember about you can't keep answers then: it says why instead of its questions.
  aboutYou.owner(memoryOwner === "ready" || !memoryOn() ? null : ownerText);
  // First run's "Tell me about you" too, and before memory is on while a model service keeps it paused (memory-c1-2).
  const provider = memoryReason === "own-provider" || memoryReason === "org-provider";
  welcome.memoryOwner(memoryOwner === "ready" || (!memoryOn() && !provider) ? null : ownerText);
  const all = $("memory-forget-all");
  const wasFocused = document.activeElement === all;
  all.hidden = !rows.length && !memoryOwnerOffersErase(memoryReason, memoryOwner === "locked");
  if (wasFocused && all.hidden) memoryRest().focus();
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
/** A Forget in the list is under way (memory-7). */
let memoryForgetting = false;
/** Undo for the last Forget: its token and the fact's words, until MEMORY_UNDO_MS. */
let memoryUndo: { token: string; text: string } | null = null;
let memoryUndoTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * The "Forgotten … Undo" line, held out of sight while the same account is checked again (a reconnect: memory-8): the
 * epoch it belongs to, and whether focus was in it. It comes back with the list; another account's epoch drops it.
 */
let forgottenHeld: { epoch: number; focused: boolean } | null = null;
let forgottenEpoch = -1;
/** After Forget: what went, with Undo, where focus goes (the status line, never the next row's Forget: memory-7). */
function showForgotten(text: string, gone: MemoryForgotten | null): void {
  clearTimeout(memoryUndoTimer);
  const said = $("memory-forgotten-text"), undo = $("memory-undo") as HTMLButtonElement;
  said.textContent = memoryForgottenText(gone?.text ?? text, gone?.derived ?? 0, gone?.back);
  memoryUndo = gone ? { token: gone.undo, text: gone.text } : null;
  undo.hidden = !memoryUndo;
  undo.removeAttribute("aria-disabled");
  undo.setAttribute("aria-label", undoForgotLabel(gone?.text ?? text));
  $("memory-forgotten").hidden = false;
  forgottenEpoch = memoryEpoch;
  forgottenHeld = null;
  said.focus();
  // Main lets go of what Undo needs after MEMORY_UNDO_MS: the line goes a little before, and focus with it to the heading.
  memoryUndoTimer = setTimeout(() => hideForgotten(), MEMORY_UNDO_MS - 2000);
}
function hideForgotten(): void {
  clearTimeout(memoryUndoTimer);
  memoryUndo = null;
  forgottenHeld = null;
  const box = $("memory-forgotten");
  const had = box.contains(document.activeElement);
  box.hidden = true;
  if (had) memoryRest().focus();
}
$("memory-undo").addEventListener("click", () => {
  const undo = $("memory-undo") as HTMLButtonElement, said = $("memory-forgotten-text");
  const u = memoryUndo;
  if (!u || undo.getAttribute("aria-disabled") === "true") return;
  undo.setAttribute("aria-disabled", "true");
  $("memory-error").textContent = "";
  void window.ember.restoreMemory(u.token).then(put => {
    clearTimeout(memoryUndoTimer);
    memoryUndo = null;
    undo.hidden = true;
    said.textContent = put ? memoryPutBackText(u.text) : MEMORY_UNDO_EXPIRED;
    said.focus();
    memoryUndoTimer = setTimeout(() => hideForgotten(), 10_000);
  }, err => {
    undo.removeAttribute("aria-disabled");
    $("memory-error").textContent = memoryRestoreFailedText(err);
  });
});
const showMemory = (view: MemoryView) => {
  memoryOwner = view.ownership; memoryReason = view.reason; memoryEpoch = view.epoch ?? 0; memoryTrouble = view.trouble ?? null;
  // memory.json couldn't be read, was set aside or couldn't be saved: said, never an empty list alone (memory-r2).
  const trouble = memoryTroubleText(view.trouble);
  setText("memory-trouble", trouble);
  renderMemory(view.rows); renderStatus();
};
/** Memory's settings as they are, so a change to one of its fields keeps the others (the patch replaces it whole). */
const memoryNow = () => settings?.memory ?? { on: false, consent: { version: 0, at: null }, questions: true, askedAt: null };
/** "Tell Ember about you" (about-you.ts): its Turn on memory… opens the switch's own note. */
const aboutYou = mountAboutYou($("about-you"), {
  id: "ay", save, ownSave: true,
  askConsent: () => { showConsentCard("memory-consent", "memory-yes"); $("memory-yes").focus(); },
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
  if (paused && !pausedSeen) { pausedSeen = true; showConsentCard("memory-consent", "memory-yes"); }
  renderMemory(memoryRows);
}
$("memory-on").addEventListener("change", e => {
  const on = (e.target as HTMLInputElement).checked;
  const consent = settings?.memory.consent ?? { version: 0, at: null };
  // First time (or the note changed since it was agreed to): the note comes first, and focus moves to it so it is read and answered.
  if (on && consent.version < MEMORY_VERSION) { showConsentCard("memory-consent", "memory-yes"); (e.target as HTMLInputElement).checked = false; $("memory-yes").focus(); return; }
  void save({ memory: { ...memoryNow(), consent, on } });
});
$("memory-questions").addEventListener("change", e => { void save({ memory: { ...memoryNow(), questions: (e.target as HTMLInputElement).checked } }); });
$("memory-yes").addEventListener("click", () => {
  if (!agreeArmed("memory-yes")) return;
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
/** The how-to's words as last written, to leave its live region alone when a push brings the same ones. */
let shownHow = "";
function renderUpdates(s: UpdateStatus): void {
  updatesNow = s;
  // Each line is written only when its words change: one Check now pushes the same status several times, and so does
  // every settings change, and a live region rewritten with the same words is announced again (install-docs-c3-2).
  const status = updateStatusText(s);
  if ($("updates-status").textContent !== status) $("updates-status").textContent = status;
  // How to update this kind of install, while a newer version is out (install-docs-11), its commands as code. A polite
  // live region that stays on the page while empty, so it is announced as it fills (install-docs-r2-2).
  const how = updateOut(s) ? updateHowTo(platform?.install ?? null, s.latest) : [];
  if (JSON.stringify(how) !== shownHow) {
    shownHow = JSON.stringify(how);
    $("updates-how").replaceChildren(...how.map(segmentNode));
  }
  ($("updates-open") as HTMLButtonElement).hidden = !updateOut(s);
  const check = $("updates-check") as HTMLButtonElement;
  check.hidden = s.phase === "off";
  check.disabled = s.phase === "checking";
}
$("updates-on").addEventListener("change", e => {
  const on = (e.target as HTMLInputElement).checked;
  const own = settings?.updates ?? { on: false, consent: { version: 0, at: null }, told: null, checkedAt: null };
  // First time: the note comes first, and focus moves to it so it is read and answered.
  if (on && own.consent.version < UPDATES_VERSION) { $("updates-consent").hidden = false; (e.target as HTMLInputElement).checked = false; $("updates-yes").focus(); return; }
  void save({ updates: { ...own, on } });
});
$("updates-yes").addEventListener("click", () => {
  $("updates-consent").hidden = true;
  void save({ updates: { on: true, told: settings?.updates.told ?? null, checkedAt: settings?.updates.checkedAt ?? null, consent: { version: UPDATES_VERSION, at: new Date().toISOString() } } });
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
  if (on && a.consent.version < AUTONOMY_VERSION) { showConsentCard("autonomy-consent", "autonomy-yes"); (e.target as HTMLInputElement).checked = false; $("autonomy-yes").focus(); return; }
  // Turned on: all four of what it covers (using apps, commands, the mouse and keyboard, moving text between apps).
  void save({ autonomy: { ...a, on, ...(on ? { scopes: { apps: true, commands: true, cursor: true, crossWindow: true } } : {}) } });
});
$("autonomy-yes").addEventListener("click", () => {
  if (!agreeArmed("autonomy-yes")) return;
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
 * `asked`: main asked for it (a key, the launcher, voice), never a click here, so its focus shows the ring.
 */
function showSection(value: string, asked = false): void {
  const { section, control } = sectionRequest(value);
  const h = document.getElementById(`${section}-h`);
  if (!h) return;
  // Hidden by the page itself (Computers before its list came, the first run): it waits until it shows.
  if (hiddenHere(h)) { pendingSection.hold(value); pendingAsked = asked; return; }
  pendingSection.drop();
  const inPane = paneOf(h);
  const opened = !document.body.classList.contains("first-run") && !!inPane && inPane !== pane;
  if (opened && inPane) { restoring = null; showPane(inPane, true); }
  // Asked for by voice ("work without asking" before its card was agreed to): the card shows, focused on its agree
  // button, which takes no press for AGREE_ARM_MS.
  if (control === "autonomy-yes" && !managed.has("autonomy")) showConsentCard("autonomy-consent", "autonomy-yes");
  // "Get to know me" or Open Memory while memory is off or waits for its note: the note shows, focused on its words,
  // never its agree button (memory-r7). Memory already agreed to (saved under another account) gets the section alone.
  if (control === "memory-consent-text" && !managed.has("memory") && !memoryOn()) showConsentCard("memory-consent", "memory-yes");
  const fold = h.closest("details");
  if (fold) fold.open = true;
  const target = (fold?.querySelector("summary") ?? h) as HTMLElement;
  // "Read the last answer": that answer, from its top (home-v1); before the messages have come, once they do.
  const latest = control === LATEST_ANSWER ? latestAnswer() : null;
  latestWanted = control === LATEST_ANSWER && !latest;
  const field = latest ?? (control ? document.getElementById(control) : null);
  const to = field && !isHidden(field) ? field : target;
  const block = to === field && to !== latest ? "center" : "start";
  // A pane just opened starts at its top (its heading, or the control, in view); within the pane, it scrolls there.
  if (opened && to === target) window.scrollTo({ top: 0 });
  else to.scrollIntoView({ block, behavior: calm || opened ? "auto" : "smooth" });
  // Chromium draws no ring for a script's focus after a click, and the key never reaches the page: after the mouse
  // was used here, Stop response was focused unseen (accessibility-visual-r2-1). A click here keeps the heuristic.
  to.focus(asked ? { preventScroll: true, focusVisible: true } as FocusOptions : { preventScroll: true });
  keptInView = { el: to, block, until: performance.now() + 3000 };
}

/** "Read the last answer" came before any answer had: it is shown once one comes, unless the user moves on first. */
let latestWanted = false;
/** The section that waits to show was asked for by main (showSection's `asked`), not by a click here. */
let pendingAsked = false;
/** The newest answer's row, focusable for "Read the last answer" (a search left typed in is cleared, so it shows). */
function latestAnswer(): HTMLElement | null {
  if (conversationSearch.value.trim()) { conversationSearch.value = ""; renderConversation(conversationAll); }
  const row = [...document.querySelectorAll<HTMLElement>("#conversation > li.ember")].at(-1) ?? null;
  if (row) row.tabIndex = -1;
  return row;
}

// ───── Panes: one at a time, as System Settings shows one pane per sidebar item (UI audit #1) ─────
/** The pane shown: Home until the user picks another. */
let pane = "home";
/** A section's pane (its `data-pane`: the page's own sections, not first run's steps, which use the same attribute). */
const paneOf = (el: Element) => el.closest<HTMLElement>(".home > [data-pane]")?.dataset.pane ?? null;
/** Shows pane `p` (every other pane's sections are taken off the page) and marks its link. */
/**
 * Apps & privacy's "What Ember reads, sends and keeps" (safety-privacy-9): first run's "Before Ember starts", copied
 * whole as it reads now (the OS's keys, the model service, the data folder, how long the record is kept), so the two
 * never differ. Copied again whenever it opens or its pane shows, and on a settings or policy change only when its
 * words change (never under a screen reader for an unrelated setting, safety-privacy-r6); the copy keeps no ids of its
 * own, and its model service follows renderRecipient through `.model-service-copy`.
 */
function syncPrivacyTerms(): void {
  const source = document.querySelector("#w-full ul.terms");
  if (!source) return;
  const copy = source.cloneNode(true) as HTMLElement;
  copy.querySelector("#model-service")?.classList.add("model-service-copy");
  for (const el of [copy, ...copy.querySelectorAll("[id]")]) el.removeAttribute("id");
  // Said as it is here: the never-look list is below, and screenshots may be off (safety-privacy-r4).
  const walk = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t; t = walk.nextNode()) {
    const words = privacyFoldWords(t.textContent ?? "", { screenImages: settings?.screenImages !== false });
    if (words !== t.textContent) t.textContent = words;
  }
  copy.setAttribute("aria-label", "What Ember reads, sends and keeps");
  const shown = $("privacy-terms").firstElementChild;
  if (shown?.matches("ul.terms") && shown.innerHTML === copy.innerHTML) return;
  $("privacy-terms").replaceChildren(copy);
}
$("privacy-terms-fold").addEventListener("toggle", () => { if (($("privacy-terms-fold") as HTMLDetailsElement).open) syncPrivacyTerms(); });

function showPane(p: string, glide = false, remember = true): void {
  if (p === "privacy") syncPrivacyTerms();
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
window.ember.onFocusSection(value => showSection(value, true));
// A section that was hidden when main asked for it shows itself once it appears; a click, key or scroll first drops it.
new MutationObserver(() => {
  if (!pendingSection.waiting) return;
  const value = pendingSection.take(s => { const h = document.getElementById(`${s}-h`); return !!h && !hiddenHere(h); });
  if (value) showSection(value, pendingAsked);
}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["hidden", "class"] });
for (const type of ["pointerdown", "keydown", "wheel"]) window.addEventListener(type, () => { pendingSection.drop(); keptInView = null; latestWanted = false; }, { capture: true, passive: true });
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
    // A fold's heading is found as its summary, once, by the heading's words (the note beside it isn't its name).
    if (el.matches("h2, h3") && el.closest("summary")) continue;
    const head = el.matches("summary") ? el.querySelector<HTMLElement>("h2, h3") : null;
    // Its words as shown (home-6): a pop-up's choices still find it, after the settings named by their own words.
    const text = shownText(head ?? el);
    if (!p || hiddenHere(el) || !text.trim()) continue;
    const pick = el instanceof HTMLLabelElement && el.control instanceof HTMLSelectElement ? el.control : el.querySelector("select");
    const options = pick ? [...pick.options].map(o => o.textContent ?? "").join(" ") : "";
    items.push({ pane: p, text, alias: [SEARCH_ALIASES[(head ?? el).id], options].filter(Boolean).join(" ") || undefined, el });
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
    // The pane's name as its link shows it: never the setup badge's number or its words for screen readers (home-r2).
    const link = jumpLinks.find(l => paneOf(document.getElementById(`${sectionOf(l)}-h`) ?? l) === result.pane);
    const section = link ? shownText(link).replace(/\s+/g, " ").trim() : result.pane;
    const button = Object.assign(document.createElement("button"), { type: "button", className: "search-result", textContent: settingsResultText(section, result.text, search.value) });
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

// Send screenshots for tasks: the user's own switch, shown as applied (the organisation's off wins: safety-privacy-7).
$("screen-images").addEventListener("change", e => { void save({ screenImages: (e.target as HTMLInputElement).checked }); });
function renderPrivacy(s: Settings): void {
  renderTrust(s);
  ($("screen-images") as HTMLInputElement).checked = s.screenImages;
  // The copy of the consent says whether screenshots are off (safety-privacy-r4); drawn again only if its words change.
  if (($("privacy-terms-fold") as HTMLDetailsElement).open) syncPrivacyTerms();
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
      $("grants-msg").textContent = "";
      // Said once it is saved, as Add is (safety-privacy-11): focus has moved on to the next Remove by then.
      void save({ grants: next }).then(ok => { if (ok) $("grants-msg").textContent = grantRemovedText(friendlyApp(app)); });
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
        void save({ privacy: { neverLook: own.filter(x => x !== item) } }).then(ok => { if (ok) listMsg(neverLookRemovedText(item, platform?.os)); });
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
  undefined,
  $("voice-listen-once-live"),
);
/** No voice spoke Ember's replies (main found it): said under the Speak switch, with a row in the setup check. */
let speechMissing = false;
/** Screen readers hear the voice line when it changes, and a download only every 25 %. */
const voiceLive = (text: string) => { const live = $("voice-live"); if ((live.textContent || voiceTold) !== text) live.textContent = text; };
/** What `#voice-live` said before a window emptied it (below): the line it comes back to isn't said again. */
let voiceTold = "";
/**
 * The voice line is said once it has held this long (ms), and never while the microphone is open for a request (a wake's
 * window, a conversation's, Listen once's): a screen reader says it through the speakers, and "Hearing you…" was heard
 * in the request, or "Listening for “Ember”" said and taken back as a conversation opened was heard as one. The line it
 * comes back to as the window closes is the one said before it, so nothing is said then (voice-listening-c3-1).
 */
const VOICE_LINE_SETTLE_MS = 1000;
/**
 * The microphone opens or is open for a request: a wake's window, a conversation's or Listen once's, or listening (or a
 * Listen once's own voice process) starting, or for Voice Match's phrases while it is taught (only its prompts are said
 * then: anything else read aloud was taken for one of the owner's phrases, voice-listening-r4-1). Status lines besides
 * the voice line's are held then (held-live.ts).
 */
const micHeld = (v: VoiceStatus): boolean => v.state === "active" || v.state === "starting" || v.listenOnce?.phase === "starting" || v.listenOnce?.phase === "listening" || !!v.match?.enrolling;
let voiceLineSoon: ReturnType<typeof setTimeout> | undefined;
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
  clearLive.hold(micHeld(v));
  speakLive.hold(micHeld(v));
  holdTaskNews(micHeld(v));
  renderVoiceFix();
  const text = heardThrough(v.detail && v.state === "error" ? `${VOICE_TEXT.error}: ${v.detail}` : v.detail ?? VOICE_TEXT[v.state] ?? v.state, v.state, v.detail, v.micLabel);
  $("voice-text").textContent = text;
  // Off, the switch above says so: no lone "Off" row under it (UI audit #15). Screen readers still hear the change.
  $("voice-text").parentElement!.hidden = v.state === "off";
  renderStatus();
  renderNatural();
  // Teaching Ember a voice: its prompts are what screen readers hear; the voice line only when it changes.
  const said = renderMatch();
  if (said) voiceLive(said);
  if (said || v.state === "active") clearTimeout(voiceLineSoon);
  else if (v.state !== "downloading" && text !== voiceLine) { clearTimeout(voiceLineSoon); voiceLineSoon = setTimeout(() => voiceLive(text), VOICE_LINE_SETTLE_MS); }
  // Emptied, unsaid, while a window is open: browse mode read "Listening for “Ember”" there beside "Hearing you…"
  // (voice-listening-v4-2). An emptied status line says nothing.
  const live = $("voice-live");
  if (!said && v.state === "active" && live.textContent) { voiceTold = live.textContent; live.textContent = ""; }
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
  // Its Cancel, while it runs (voice-listening-6); when it goes with focus on it, focus goes back to Download.
  const cancel = $("voice-download-cancel") as HTMLButtonElement;
  const hadCancel = document.activeElement === cancel;
  cancel.hidden = !downloading;
  if (hadCancel && cancel.hidden) focusFirst(["voice-download", "wake"]);
  // The consent card says that agreeing downloads the models, and how much (modelsDownloadLabel's size).
  $("consent-models").hidden = !v.modelsMissing.length;
  $("consent-models-size").textContent = modelsSize(v.modelsMissing, v.modelsBytes);
  const missing = v.speechMissing === true;
  if (missing !== speechMissing) {
    speechMissing = missing;
    $("speak-note").textContent = missing ? SPEAK_NO_VOICE : "";
    speakLive.say(missing ? SPEAK_NO_VOICE : "");
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
  void save({ voice: { ...(settings?.voice ?? { consent: true, speakerRejection: true, muted: false, natural: false, naturalModel: "kokoro", learn: true, words: true, suggest: true, conversation: true, clearHearing: false, rate: 1 }), match: on } });
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
  ($("speak-rate") as HTMLSelectElement).value = String(nearestRate(s.voice.rate));
  renderHear(s);
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
  void save({ wakeWord: true, voice: { muted: false, match: false, natural: false, naturalModel: "kokoro", learn: true, words: true, suggest: true, conversation: true, clearHearing: false, rate: 1, ...(settings?.voice ?? {}), consent: true, speakerRejection: true } }).then(ok => {
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
/**
 * Hear me more clearly's line, said through its own status line as the voice line is: once it has held, only when its
 * words change, and never while the microphone opens or is open for a request (`micHeld`). Written on every voice push,
 * a screen reader said it as Listen once opened, over the request after "Hey Ember" and into the conversation, where it
 * was sent with the request or as one (voice-listening-c4-1). A download is said every 25 %.
 */
const clearLive = heldLive($("clear-live"));
/**
 * The note under the Speak control, said the same way: it comes as Ember fails to speak an answer, which is while a
 * conversation is open, and starts with the name (voice-listening-r4-2).
 */
const speakLive = heldLive($("speak-live"));
function renderNatural(): void {
  // Kitten remains the baseline choice even when speech must use the system voice.
  $("natural-row").hidden = false;
  naturalUI.status(voice?.natural, voice?.naturalModels ?? []);
  const clearLine = clearHearingLine(voice?.clear);
  if ($("clear-text").textContent !== clearLine) $("clear-text").textContent = clearLine;
  const c = voice?.clear;
  clearLive.say(c?.state === "downloading" ? clearHearingLine({ ...c, percent: progressStep(c.percent / 100) }) : clearLine);
}
$("speak").addEventListener("change", e => { void save(speakSettings((e.target as HTMLSelectElement).value as SpeakChoice)); });
$("speak-rate").addEventListener("change", e => {
  const rate = Number((e.target as HTMLSelectElement).value);
  if (settings && SPEAK_RATES.some(r => r.rate === rate)) void save({ voice: { ...settings.voice, rate } });
});
/** Hear Ember can't speak with speaking set to Never, or managed by the organisation (voice-speaking-7). */
function renderHear(s: Settings | null = settings): void {
  ($("voice-hear") as HTMLButtonElement).disabled = managed.has("speak") || !s || speakChoice(s) === "never";
}
/** Each click's own answer: an older sample's late one never overwrites a newer one's line. */
let hearClicks = 0;
$("voice-hear").addEventListener("click", () => {
  const line = $("voice-hear-status");
  const click = ++hearClicks;
  const show = (text: string) => { if (click === hearClicks) line.textContent = text; };
  // Main answers once the sample is heard (Kitten may take 2 s to load first): until then no voice is named. The waiting
  // words come first, so the same result again is news again.
  show(HEAR_WAITING);
  window.ember.hearEmber().then(r => show(hearEmberLine(r)), () => show("Couldn't play the sample. Try again."));
});
$("speak-results").addEventListener("change", e => { void save({ speakResults: (e.target as HTMLInputElement).checked }); });
$("voice-download").addEventListener("click", () => {
  void window.ember.downloadVoice();
  // The button goes while it downloads: focus moves to its Cancel, shown now.
  $("voice-download-cancel").hidden = false;
  focusFirst(["voice-download-cancel", "wake"]);
});
$("voice-download-cancel").addEventListener("click", () => { void window.ember.cancelVoiceDownload(); });
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
