/**
 * The settings window's words: pure functions, so they are unit-tested. Words that differ by OS come from the status
 * main sends (`Status.platform`); every function defaults to Linux's, today's strings, so a window whose status doesn't
 * name an OS reads exactly as before.
 */

import type { ActivityEntry, ClearHearingStatus, ConversationContext, NaturalVoiceStatus, SpeechModelId, StatusPlatform, UpdateStatus } from "../../shared/ipc";
// Plain words for an unnamed control's role: the same table the May I? question uses.
import { aRoleWord } from "../../shared/role-words";
import { KEYS, OPEN_AGAIN, SHORTCUTS, type KeyConventions, type OS, type ShortcutId } from "../../shared/shortcuts";
import { parseTargetId } from "../../shared/targets";
import { FEATURE_CONSENT_VERSION } from "../../shared/consent";
import { NEVER_LOOK_DEFAULTS as NEVER_LOOK_BY_OS, NEVER_LOOK_NAMES, missingDefaults as missingFor } from "../../shared/never-look";
import { onboardingRest } from "./computers-copy";
import { needsUser, type SetupRow } from "../../shared/setup-attention";
import { sideOf, type HandlePosition } from "../../shared/handle-place";
import { CONVERSATION_LIMIT, type HistoryProblemKind } from "../../shared/conversation";
import { NATURAL_CHOICES, naturalModelHint, type NaturalModel } from "./natural-copy";

export const CONVERSATION_RETENTION = `Keeps the latest ${CONVERSATION_LIMIT} messages while Ember runs. Older messages are forgotten as new ones arrive. Closing Ember or signing out forgets this conversation.`;
export const CONVERSATION_KEEP_LABEL = "Keep my recent conversation after Ember closes";
export const CONVERSATION_KEEP_HINT = "Off by default. When on, Ember saves these messages on this computer, in a file only you can read, and shows them again after it restarts. They are for you to read: Ember itself starts a fresh conversation and doesn’t remember them, and nothing in them is run again.";
export const CONVERSATION_RETENTION_KEPT = `Keeps the latest ${CONVERSATION_LIMIT} messages on this computer, also after Ember closes. Older messages are forgotten as new ones arrive. Turning this off, New conversation, signing out and Forget everything delete the saved copy.`;
/** The retention note for the setting as it is now. */
export function conversationRetention(keep: boolean): string {
  return keep ? CONVERSATION_RETENTION_KEPT : CONVERSATION_RETENTION;
}
/** Under the switch when the saved copy can't be written or deleted (it is never silent). */
export function conversationKeepProblem(problem: HistoryProblemKind | null): string {
  if (problem === "exposed") return "Ember couldn’t delete the saved conversation on this computer, and couldn’t make sure it stays hidden, so it may show again after a restart. Try turning this off again later.";
  if (problem === "unchecked") return "Ember can’t check that the earlier conversation was cleared, so it isn’t showing it. It will look again the next time Ember starts.";
  if (problem === "account") return "Ember couldn’t confirm which GitHub account is signed in, so it isn’t keeping this conversation. Sign out and in again, or check your connection.";
  if (problem === "owner") return "Ember can’t tell which model service key this conversation belongs to, so it isn’t saving it. Save the key again in Model provider to fix this.";
  if (problem === "delete") return "Ember couldn’t delete the saved conversation on this computer. It won’t show it again, and will try to delete it the next time you turn this off, forget or sign out.";
  if (problem === "save") return "Ember couldn’t save the conversation on this computer, so it may not be here after a restart.";
  return "";
}
export const CONVERSATION_SCOPE = "Sends your message without reading a window. Use Ask Ember to include the app you’re working in. Existing conversation context still applies.";
export const CONVERSATION_EDIT = "Review this as a new request, then choose Send. Sending again may repeat actions; nothing is sent by choosing Edit.";
export const CONVERSATION_TRUNCATED = "This message exceeded the session limit of 131,072 characters. Only the text shown here is retained and copied.";
export function conversationMatchesText(text: string, query: string): boolean {
  return text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}
export function conversationSearchCount(matches: number): string {
  return matches === 1 ? "1 matching message in this session." : `${matches} matching messages in this session.`;
}

/** Linux's never-look defaults, the list a fresh Linux install starts with (other OSes': app/shared/never-look.ts). */
export const NEVER_LOOK_DEFAULTS: readonly string[] = NEVER_LOOK_BY_OS.linux;

/**
 * The row a control the organisation manages dims with it (Element.closest): the switch's label it sits in, or the
 * choice row its own label sits beside (Speak … out loud, review #55).
 */
export const MANAGED_ROW = "label, .choice";

/** How a never-look entry reads on screen (the defaults are stored lower-case, as matched). */
export function neverLookLabel(item: string): string {
  return NEVER_LOOK_NAMES[item.trim().toLowerCase()] ?? item;
}

/** The defaults of `os` (Linux's unless the status names another) that are missing from `list` (case-insensitive). */
export function missingDefaults(list: readonly string[], os: OS = "linux"): string[] {
  return missingFor(list, os);
}

export { friendlyApp } from "../../shared/apps";
import { friendlyApp } from "../../shared/apps";

/**
 * What main said when a request to it failed, in its own words: Electron puts "Error invoking remote method
 * '<channel>': Error: " before every message an IPC handler throws, which the user must never read.
 */
export function ipcErrorText(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, "") : String(err);
}

/**
 * What the settings window says when a change couldn't be saved (review #84): main's own plain sentence ("Ember
 * couldn't save your settings: the disk is full…"), or a plain one of its own, never a raw error.
 */
export function saveFailedText(err: unknown): string {
  const said = ipcErrorText(err);
  return /^Ember couldn't save /.test(said) ? said : "Ember couldn't save that change.";
}

/** A failed deletion must remain retryable without exposing an IPC or filesystem error. */
export function memoryDeleteFailedText(err: unknown): string {
  const said = ipcErrorText(err);
  return /^Ember couldn't finish deleting /.test(said) ? said : "Ember couldn't finish deleting memory. Try Forget again.";
}

/** The same safe deletion failure, naming the action beside the learned line. */
export function learnedUndoFailedText(err: unknown): string { return memoryDeleteFailedText(err).replace(/(try|Try) Forget again/g, "$1 Undo again"); }

/** Token counts that read naturally: "312", "1.2k", "48k". */
export function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(n / 1000)}k`;
}

export function usageLine(u: { calls: number; inputTokens: number; outputTokens: number }): string {
  if (!u.calls) return "";
  return `This session: ${u.calls} model ${u.calls === 1 ? "call" : "calls"}, ${tokens(u.inputTokens)} tokens in, ${tokens(u.outputTokens)} tokens out.`;
}

export function conversationContextLine(context: ConversationContext | undefined): string {
  if (!context) return "";
  if (context.kind === "compacting") return "Making room in the conversation…";
  const used = tokens(context.currentTokens);
  return context.tokenLimit === undefined
    ? `The current conversation context uses ${used} tokens. Its limit is unknown.`
    : `The current conversation context uses ${used} of ${tokens(context.tokenLimit)} tokens.`;
}

/** Where "Check again" found a sign-in. */
const SOURCE_TEXT: Record<string, string> = {
  stored: "Ember's saved sign-in",
  environment: "a GitHub token in the environment",
  "github-cli": "your GitHub CLI sign-in",
};

/**
 * What "Check again" says. `hint`: main's words when nothing was found (what signing in needs in this build: the GitHub
 * CLI, and how to install it here, in a build without Ember's own GitHub App); a main that sends none gets the old sentence.
 */
export function retryMessage(r: { found: boolean; source: string | null; hint?: string }, connected = false): string {
  if (!r.found) return r.hint || "No GitHub sign-in found on this computer. Run “gh auth login” in a terminal, then press Check again.";
  const what = SOURCE_TEXT[r.source ?? ""] ?? "a GitHub sign-in";
  return `Found ${what}; ${connected ? "connected." : "connecting…"}`;
}

/** A model in the Copilot section's lists: its name, and how many premium requests a call costs when that is above 1. */
export function modelLabel(m: { name: string; cost?: number }): string {
  return typeof m.cost === "number" && m.cost > 1 ? `${m.name} (${Number(m.cost.toFixed(2))}× premium requests)` : m.name;
}

/** The Copilot section's sign-in button: Ember's own GitHub App signs in with the browser; without it, the GitHub CLI. */
export function signInLabel(signInWith?: string): string {
  return signInWith === "github-cli" ? "Connect with GitHub CLI" : "Sign in with GitHub";
}

/** The corner Ember's handle is in, as a sentence names it (Handle position, review #75): "bottom-right corner". */
export function handleCornerText(p: HandlePosition | undefined): string {
  return sideOf(p) === "left" ? "bottom-left corner" : "bottom-right corner";
}

/** The line under "Ember" at the top of the window; `askLabel` is the ask shortcut as this OS writes it. */
export function tagline(t: {
  failing: number; onboarded: boolean; phase: string | null; hidden: boolean; overlay: boolean; waitingForTasks?: boolean;
  /** Setup rows that don't fail but need the user (a warning that holds Ember back, or one with a button). */
  look?: number;
  /** Handle position: the corner the card is in without a compositor (the bottom right when not given). */
  corner?: HandlePosition;
}, askLabel = SHORTCUTS.linux.ask.label): string {
  // Before Start it is always the first-run instruction: the setup check's own heading counts its rows (review #160).
  if (!t.onboarded) return "Read how Ember works, pick who keeps you company, then agree and press Start.";
  if (t.failing) return `Ember needs ${things(t.failing)} fixed before it can work on this computer.`;
  const where = !t.overlay ? `Ember is in the ${handleCornerText(t.corner)}.` : t.hidden ? "Ember is hidden for now." : "Ember is beside your cursor.";
  if (t.phase === "error" && t.waitingForTasks) return `${where} Copilot isn't answering: Ember reconnects once the tasks that are running finish.`;
  if (t.phase === "signed-out" || t.phase === "error") return `${where} Connect Copilot to start asking.`;
  if (t.phase === "starting" || t.phase === null) return `${where} Connecting to Copilot…`;
  // Ready, with setup rows still worth a look: said, so a warning isn't left in a closed fold (review #95).
  // An empty label: another app holds the ask shortcut and its fallback (D-45b), so settings' Ask Ember… is the way.
  const ask = askLabel ? `Press ${askLabel} to ask it anything.` : "Ask it anything with Ask Ember… below.";
  return `${where} ${ask}${t.look ? ` The setup check has ${things(t.look)} worth a look.` : ""}`;
}

/** "1 thing", "2 things": how many setup rows, in a sentence. */
function things(n: number): string {
  return `${n} ${n === 1 ? "thing" : "things"}`;
}

/**
 * The badge on the sidebar's Setup link: the count shown, the words a screen reader adds, and its tone (null: none).
 * Failing rows are counted as the heading's note counts them; else the rows that need the user (setupView's `needing`).
 */
export function setupBadge(needing: number, failing = 0): { text: string; label: string; tone: "fail" | "warn" } | null {
  const n = failing || needing;
  if (!n) return null;
  return { text: String(n), label: `, ${things(n)} ${failing ? "to fix" : "worth a look"}`, tone: failing ? "fail" : "warn" };
}

/**
 * The note by the Setup check heading: how many rows fail, else how many need the user (setupView's `needing`, the
 * count the tagline and the sidebar's badge give, UI audit #6), counted in words (review #160), as `ember doctor` says it.
 */
export function checksNote(failing: number, needing: number): string {
  return failing ? `${things(failing)} to fix` : needing ? `${things(needing)} worth a look` : "All good";
}

/** What the setup check shows, and what the window remembers between statuses. */
export interface SetupView {
  failing: number;
  warn: number;
  /** Rows that need the user (setup-attention.ts needsUser): failing ones, and warnings that hold Ember back or have a button. */
  needing: number;
  /** Open the fold now (once per window: a user who closes it isn't overruled by the next status). */
  open: boolean;
  /** The setup check shows before Start too. */
  beforeStart: boolean;
  note: string;
}

/**
 * The setup check for these rows, given what the window did before (`opened` the fold by itself, showed the check
 * `beforeStart`). A row that needs the user opens the fold and shows the check before Start (review #94, #161), and
 * the check then stays until Start, so fixing one row never takes the others' buttons off the first-run screen.
 */
export function setupView(rows: readonly SetupRow[], before: { opened: boolean; beforeStart: boolean }): SetupView {
  const failing = rows.filter(r => r.status === "fail").length;
  const warn = rows.filter(r => r.status === "warn").length;
  const needing = rows.filter(needsUser).length;
  return { failing, warn, needing, open: needing > 0 && !before.opened, beforeStart: before.beforeStart || needing > 0, note: checksNote(failing, needing) };
}

/** What a screen reader hears when Start has done its work and gone (review #50). */
export const STARTED_TEXT = "Ember has started.";

/** "Today", "Yesterday", else the weekday and date. */
export function dayLabel(t: string, now = new Date()): string {
  const d = new Date(t);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(now) - start(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}

/**
 * What the conversation list says while it is empty (its `data-empty`); `askLabel` is the ask shortcut Ember holds as
 * this OS writes it, "" while it holds neither its default nor its fallback (D-45b).
 */
export function emptyConversationText(askLabel = SHORTCUTS.linux.ask.label): string {
  return askLabel ? `No messages yet. Write to Ember below, or press ${askLabel} to open Ask Ember.`
    : "No messages yet. Write to Ember below, or use Ask Ember… at the top of Home.";
}

/**
 * The own model provider's card (Copilot › Model provider, FEATURE_CONSENT_VERSION.provider), shown when the user turns
 * it on, and again for another host: where everything Copilot would get goes instead, screenshots included, and where
 * the key goes. Change its words only with a bump of that version.
 */
export function providerConsentText(host: string): string {
  return `Ember will send what it would send to GitHub Copilot to ${host} instead: your requests, what it reads from your screen and apps, what it remembers that bears on them, what commands print, and for tasks, screenshots of the windows it works in, with password fields and never-look windows blacked out. That service's own terms and privacy rules apply, and it may keep what it gets. Your API key is kept encrypted on this computer and goes only to ${host}. Turn this off to go back to Copilot.`;
}

/** Where Ember's model requests go right now (see `modelDestination`). `host` only: never a path, key or credentials. */
export type ModelDestination =
  | { kind: "copilot" }
  | { kind: "own"; host: string }
  | { kind: "organisation"; host: string }
  | { kind: "none" }
  /** The user's own provider can't be told yet (state not read, or the read failed): never worded as Copilot. */
  | { kind: "unknown" };

/** Whether the user's own provider is in force, as main's provider state said: `host` is null when it is not. */
export type OwnProvider = { known: true; host: string | null } | { known: false };

/**
 * The single answer for the microphone and data-list words, matching main's routing (app/main/provider.ts
 * userProviderInForce): the administrator's lockdown sends nothing; the organisation's own service wins and shuts
 * the user's out; the user's own provider counts only while it is in force (on, agreed to for its host, allowed);
 * otherwise GitHub Copilot. `own` is main's answer: its host while in force, `host: null` when not, `known: false` when
 * it hasn't been (or couldn't be) read, which is a destination of its own and never Copilot; `adminProvider` is a URL.
 */
export function modelDestination(o: { locked: boolean; adminProvider: string | null; own: OwnProvider }): ModelDestination {
  if (o.locked) return { kind: "none" };
  if (o.adminProvider) {
    try { return { kind: "organisation", host: new URL(o.adminProvider).host }; } catch { return { kind: "none" }; /* unreadable address: fail closed */ }
  }
  if (!o.own.known) return { kind: "unknown" };
  if (o.own.host) return { kind: "own", host: o.own.host };
  return { kind: "copilot" };
}

/** The recipient as a phrase: "Copilot" (or "GitHub Copilot" when `long`), "your own model provider (host)", and so on. */
export function recipientWords(d: ModelDestination, long = false): string {
  switch (d.kind) {
    case "copilot": return long ? "GitHub Copilot" : "Copilot";
    case "own": return `your own model provider (${d.host})`;
    case "organisation": return `your organisation's model service (${d.host})`;
    case "unknown": return "a model service I can't tell yet";
    case "none": return "no model service (your organisation's policy has locked Ember down)";
  }
}

/** Under the Model provider group: what the switch does now, or why the organisation decides it. */
export function providerHint(o: { managed: "organisation" | "off" | null; inForce: boolean; on: boolean; host: string | null }): string {
  if (o.managed === "organisation") return "Managed by your organisation: Ember uses its model service.";
  if (o.managed === "off") return "Managed by your organisation: Ember uses GitHub Copilot.";
  if (o.inForce && o.host) return `Ember sends your requests to ${o.host} instead of Copilot. A change applies from your next message; tasks already running finish where they started.`;
  if (o.on && !o.host) return "Enter the service's address to use it.";
  if (o.on && o.host && !o.inForce) return `Ember uses GitHub Copilot until you agree to use ${o.host}.`;
  return "Use a model service of your own instead of GitHub Copilot: OpenAI, Azure OpenAI, Anthropic, or a model server on this computer such as Ollama or LM Studio.";
}

/** Shown in place of the key field when the computer can't keep a key safely (no keyring, or basic_text). */
export const PROVIDER_NO_KEYRING = "This computer has no keyring for passwords, so Ember can't keep a key safely here. A model server on this computer that needs no key still works.";

/** The Model provider group's short messages (under the group, in its status line). */
export const PROVIDER_WORDS = {
  keySaved: "Key saved.",
  keyRemoved: "Key removed.",
  pasteKey: "Paste the API key first.",
  testing: "Testing…",
  testFailed: "Ember couldn't test the connection. Try again.",
  badModel: "A model name has no spaces in it, such as gpt-4.1 or llama3.2:3b.",
  badAddress: "Enter the service's full address, starting with https://.",
  readAgain: "The address changed: read the note again for the new one, then agree.",
  badAzure: "Enter the API version as Azure writes it, such as 2024-10-21.",
} as const;

/** What "Test connection" found, in one sentence: connected (with how many models it lists), or main's reason why not. */
export function providerTestText(r: { ok: true; host: string; models: number | null } | { ok: false; why: string }): string {
  if (!r.ok) return r.why;
  if (r.models === null) return `Connected to ${r.host}.`;
  return `Connected to ${r.host}. It lists ${r.models} ${r.models === 1 ? "model" : "models"}.`;
}

/**
 * Memory's note, shown before it is first turned on (Settings › Conversation, docs/MEMORY.md §3): what Ember keeps,
 * where, what goes to Copilot, and how to forget it. Changing it means bumping FEATURE_CONSENT_VERSION.memory (2: it
 * learns on its own, docs/MEMORY.md steps 3–5).
 */
export const MEMORY_CONSENT_TEXT = "Ember will remember what you tell it about yourself, your work, and how you like things done. It learns from conversations and finished tasks using short Copilot requests, and keeps what it learns on this computer. A few relevant facts go to Copilot with each request. Saved memory is tied to your verified GitHub account. Ember keeps older or unmatched memory hidden until it can verify the owner or you clear it. Ember never keeps passwords, codes or card numbers. You can review and forget facts here. Signing out erases saved memory that belongs to your verified account.";

/**
 * Memory was on under an earlier note (version 1, before Ember learned on its own) and waits for the user to agree to
 * the new one: it remembers nothing more until then, and keeps what it has.
 */
export function memoryPaused(m: { on: boolean; consent: { version: number } }): boolean {
  return m.on && m.consent.version > 0 && m.consent.version < FEATURE_CONSENT_VERSION.memory;
}
/** Said in Settings › Memory while memory is paused, above its new note. */
export const MEMORY_PAUSED_TEXT = "Memory is paused until you review the new account privacy note.";
/** Memory's line while its saved memory can't be opened, and whether to offer Forget everything (memory-2): shared with main. */
export { memoryOwnerOffersErase, memoryOwnerText } from "../../shared/memory-owner";

/** Where a remembered fact came from, as Settings › Memory lists it beside the fact. */
export function memorySourceLabel(source: string): string {
  return ({ user: "You told me", conversation: "From our conversation", task: "From a task", observed: "Seen on screen", connector: "From a connected service" } as Record<string, string>)[source] ?? "Learned";
}

/** The conversation's line when Ember keeps something new on its own, and its Undo button's name for screen readers. */
export const learnedLine = (text: string) => `Ember learned: ${text}`;
export const undoLearnedLabel = (text: string) => `Undo: forget “${text}”`;
/** The line's button once main confirms the deletion. */
export const LEARNED_UNDONE = "Forgotten";
export const UNDO_LEARNED = "Undo";
export const MEMORY_FORGETTING = "Forgetting…";
export const MEMORY_SEARCH_LABEL = "Search memory";
export const MEMORY_SOURCE_LABEL = "Source";
export const MEMORY_ALL_SOURCES = "All sources";
export const MEMORY_SHOW_MORE = "Show more memories";
export const MEMORY_NO_MATCHES = "No memories match. Try another word or source.";
export const WORD_DELETE_FAILED = "Couldn't forget that correction. Try again.";
export const WORDS_DELETE_FAILED = "Couldn't forget the corrections. Try again.";

/** The visible page and all matching memories, without suggesting that hidden pages have been removed. */
export function memoryCountText(shown: number, matched: number, all: number): string {
  return matched === all ? `${shown} of ${all} ${all === 1 ? "memory" : "memories"}` : `${shown} of ${matched} matching ${matched === 1 ? "memory" : "memories"} (${all} total)`;
}

/** A selectable settings result carries its section as context, including repeated words such as “Download”. */
export function settingsResultText(section: string, text: string): string { return `${section}: ${text.trim().replace(/\s+/g, " ")}`; }
export const SETTINGS_MORE_RESULTS = "Show more results";
export const SETTINGS_RESULTS_LABEL = "Settings search results";
export const MEMORY_CORRECTION = {
  correct: "Correct…", title: "Correct this memory", label: "Corrected memory", save: "Save correction", cancel: "Cancel",
  hint: "The original source stays recorded. Correcting a memory doesn't give it more authority over what Ember does.",
  saved: "Memory corrected.", saving: "Saving correction…",
  finish: "Finish or cancel the current correction first. Your words are still here.",
  stale: "This memory changed while you were editing. Your words are still here. Cancel and reopen the correction to review it.",
  gone: "That memory is no longer saved. The correction has been closed.",
  off: "Turn on memory for your verified account before saving a correction.",
  failed: "Ember couldn't save this correction. Your words are still here; try again.",
} as const;
/** A corrected sentence still names its original source, including its original authority. */
export function memoryProvenanceLabel(source: string, correctedAt?: string): string { return `${memorySourceLabel(source)}${correctedAt ? " · Corrected by you" : ""}`; }
export const correctMemoryLabel = (text: string) => `Correct memory: ${text}`;
/** Correction failures use main's plain bounded sentences; arbitrary IPC/filesystem details remain private. */
export function memoryCorrectionFailedText(error: unknown): string {
  const said = ipcErrorText(error);
  return /^(?:This memory changed|Keep the correction|This correction holds a secret|Ember couldn't save this correction)/.test(said) ? said : MEMORY_CORRECTION.failed;
}

/**
 * "Tell Ember about you" (Settings › Memory and first run's optional step): every question can be left empty, and only
 * what is answered is kept, as something the user told Ember.
 */
export const ABOUT_YOU = {
  title: "Tell Ember about you",
  lead: "A few short questions, each one optional. Ember keeps your answers as things you told it, and you can forget any of them here.",
  name: "What should Ember call you?",
  work: "Your role and what you work on",
  apps: "The apps you use most",
  length: "Answers",
  lengthChoices: { "": "No preference", short: "Short", detailed: "Detailed" },
  spoken: "Spoken replies",
  spokenChoices: { "": "No preference", yes: "Spoken aloud", no: "Not spoken" },
  hours: "Your timezone or working hours",
  save: "Save",
  memoryOff: "Ember needs memory turned on to keep your answers.",
  managed: "Your organisation has turned memory off.",
  voice: "You can also say “Ember, get to know me” for a short spoken version.",
} as const;

/** The form's fields as main takes them: trimmed, each one left out when it is empty or "No preference". */
export function introFromForm(f: { name: string; work: string; apps: string; length: string; spoken: string; hours: string }): {
  name?: string; work?: string; apps?: string; length?: "short" | "detailed"; spoken?: boolean; hours?: string;
} {
  const t = (s: string, n: number) => {
    const value = s.replace(/\s+/g, " ").trim().slice(0, n).trimEnd();
    // The memory service skips an answer made only of trailing punctuation.
    return /^[.!]+$/.test(value) ? "" : value;
  };
  return {
    ...(t(f.name, 80) ? { name: t(f.name, 80) } : {}),
    ...(t(f.work, 240) ? { work: t(f.work, 240) } : {}),
    ...(t(f.apps, 240) ? { apps: t(f.apps, 240) } : {}),
    ...(f.length === "short" || f.length === "detailed" ? { length: f.length } : {}),
    ...(f.spoken === "yes" || f.spoken === "no" ? { spoken: f.spoken === "yes" } : {}),
    ...(t(f.hours, 120) ? { hours: t(f.hours, 120) } : {}),
  };
}

/** After "Save" in "Tell Ember about you": how many answers were kept (none answered, or memory off, said so). */
export function aboutYouSaved(kept: number | null): string {
  if (kept === null) return "Not saved: memory is off.";
  if (kept === 0) return "Nothing to save yet: answer any question you like.";
  return kept === 1 ? "Saved 1 answer." : `Saved ${kept} answers.`;
}

/** Under the "Ask me questions" switch. */
export const MEMORY_QUESTIONS_HINT = "At most one question a day, only while you're not using Ember, about names it keeps finding nothing on. Your answer is kept as something you told it.";

/**
 * "Work without asking"'s card (Apps & privacy, FEATURE_CONSENT_VERSION.autonomy; app/main/policy/autonomy.ts): what runs
 * without asking, what still asks, that Ember says what it does, and that a stop always works. Change it only with a bump
 * of that version.
 */
export const AUTONOMY_CONSENT_TEXT = "Ember will use your apps, borrow your mouse and keyboard, run ordinary commands, move text between apps and press OK on a simple message box (one whose only button is OK, with nothing to choose or tick) for what you ask, without asking you first each time. It says what it is doing as it goes, in its bubble and on the task's card, and keeps a record under What Ember did. It still asks every time before anything risky: sending, posting, submitting, sharing, deleting, overwriting, paying, installing, signing out, security settings, dangerous commands and any dialog that asks a question. It never types passwords and never acts in sign-in prompts, and if a page or file tries to give it instructions, that task goes back to asking. Saying “Ember, stop”, or Ember's stop shortcut, stops everything at once, and moving your mouse takes it back.";

/**
 * Under the "Work without asking" switch: what changes, and that questions can be answered by voice (Voice Match).
 * `elevated`: Ember runs as an administrator or as root (elevationOf), so every command asks whatever the switch says
 * (commands/decide.ts): said, so the user can tell why.
 */
export function autonomyHint(managed: boolean, elevated: "administrator" | "maybe-administrator" | "root" | null = null): string {
  const base = managed
    ? "Managed by your organisation: Ember asks before its first step in an app, before using your mouse and keyboard, before pressing OK on an app's message box and before moving text between apps."
    : "Off, Ember asks before its first step in an app, before using your mouse and keyboard, before pressing OK on an app's message box and before moving text between apps. On, it tells you what it's doing instead, and still asks before anything risky. You can answer a question by voice too: “Ember, allow” (with Voice Match on) or “Ember, not now”.";
  if (elevated === "administrator") return `${base} Ember is running as an administrator, so it asks before every command. Start it normally to change that.`;
  if (elevated === "maybe-administrator") return `${base} Ember may be running as an administrator (it couldn't tell), and then it asks before every command. Start it normally to be sure.`;
  if (elevated === "root") return `${base} Ember is running as root, so it asks before every command. Start it as yourself to change that.`;
  return base;
}

/**
 * Whether the setup check says Ember runs elevated (Windows' "elevated" row, Linux's "elevated" and macOS's "root",
 * whenever it isn't ok: one that can't tell counts, as the commands do, but is said as "may be"), and how to say it.
 */
export function elevationOf(checks: readonly { id: string; label: string; status: string; detail?: string }[]): "administrator" | "maybe-administrator" | "root" | null {
  const row = checks.find(c => (c.id === "elevated" || c.id === "root") && c.status !== "ok");
  if (!row) return null;
  if (row.label !== "Administrator") return "root";
  return /couldn't tell/i.test(row.detail ?? "") ? "maybe-administrator" : "administrator";
}

/** The routines note (FEATURE_CONSENT_VERSION.routines): change it only with a bump of that version. */
export const ROUTINES_CONSENT_TEXT = "Ember will keep the routines you name and the reminders you set after it closes, in your own words. It keeps them on this computer only, in its data folder, where only you can read it. When you say a routine's name, its steps go to Copilot as if you had just asked each one, and Ember still asks before anything risky. You can see and delete them here, and signing out deletes them all.";

/** The update note (FEATURE_CONSENT_VERSION.updates): change it only with a bump of that version. */
export const UPDATES_CONSENT_TEXT = "Once a day, Ember will ask GitHub whether a newer version is out. GitHub sees your internet address and that someone asked, and nothing else: no sign-in, and nothing about you or what you do. Ember only tells you. It never downloads or installs anything by itself.";

/** Where the update check stands, in a sentence; nothing while it is off. */
export function updateStatusText(s: UpdateStatus): string {
  switch (s.phase) {
    case "available": return `Ember ${s.latest} is out.`;
    case "current": return "You have the latest version.";
    case "checking": return "Checking…";
    case "failed": return "Couldn't check for updates. Ember will try again tomorrow.";
    case "idle": return "Ember will check shortly.";
    default: return "";
  }
}

/** The routines list when it's empty: what to say to make one, or that routines are off. */
export function routinesEmptyText(on: boolean): string {
  return on ? "No routines yet. Say “When I say start my day, open Mail and show today's calendar”." : "Routines are off.";
}

/** A routine's Delete button, for screen readers: which routine. */
export const deleteRoutineLabel = (name: string) => `Delete the routine “${name}”`;

/** The memory list while it is empty: `on`, memory is on. */
export function memoryEmptyText(on: boolean): string {
  return on ? "Nothing yet. Tell Ember about yourself, or say “Remember that…”." : "Nothing remembered.";
}

/** Better recall's model in Settings › Memory (docs/MEMORY.md §2), as main reports it (memory/better-recall.ts). */
export interface BetterRecallState { state: "absent" | "downloading" | "ready" | "off"; bytes: number; done?: number; failed?: "checksum" | "network" }

/** Better recall's line: what the download is and does, how it is going, or that it is on. */
export function betterRecallText(s: BetterRecallState): string {
  const mb = `${Math.max(1, Math.round(s.bytes / 1e6))} MB`;
  if (s.state === "ready") return "On: a language model on this computer matches what you ask with what Ember remembers, even in other words.";
  if (s.state === "downloading") return "Downloading the language model…";
  if (s.failed === "checksum") return "The download didn't match what Ember expects, so it wasn't used.";
  if (s.failed) return "The download didn't finish. Check the network and try again.";
  return `Download a ${mb} language model that runs on this computer, so Ember finds what you told it when you ask in other words.`;
}

/** Better recall's download button: what it fetches and its size. */
export function betterRecallDownloadLabel(bytes: number): string {
  return `Download (${Math.max(1, Math.round(bytes / 1e6))} MB)`;
}

/** Better recall's download for screen readers: only at 0, 25, 50, 75 and 100 % (progressStep). */
export function betterRecallProgress(fraction: number): string {
  return `Language model ${progressStep(fraction)}% downloaded`;
}

/** A remembered fact's Forget button, for screen readers. */
export function forgetMemoryLabel(text: string): string {
  return `Forget: ${text}`;
}

/** Under "Speak replies" once Ember tried to speak and no voice started (review #101); the setup check says how to add one. */
/**
 * The speech models' download button: what it fetches and its size. Listening's own models missing: "speech models"
 * (everything missing comes with them); otherwise the voice models that are missing (Kitten Nano, Voice Match).
 */
export function modelsDownloadLabel(missing: readonly SpeechModelId[], bytes: number): string {
  const onlyVoice = missing.length === 1 && missing[0] === "tts";
  const mb = `${Math.max(1, onlyVoice ? Math.round(bytes / 1e5) / 10 : Math.round(bytes / 1e6))} MB`;
  const listening = missing.some(id => id === "kws" || id === "vad" || id === "asr");
  const parts = listening ? ["speech models"] : [...(missing.includes("tts") ? ["Kitten Nano"] : []), ...(missing.includes("speaker") ? ["Voice Match"] : [])];
  return `Download ${parts.length ? parts.join(" and ") : "speech models"} (${mb})`;
}

export const SPEAK_NO_VOICE = "Ember couldn't speak: no local voice is available for your language. Your reply is still in the bubble. The setup check says how to add a voice.";
export const LISTEN_ONCE_READY = "Press Listen once, then say one request without saying “Hey Ember”.";

/** The voice line while the microphone is off; `muteLabel` is the mute shortcut Ember holds as this OS writes it ("": none). */
export function micOffText(muteLabel = SHORTCUTS.linux.mute.label): string {
  return muteLabel ? `Microphone off (${muteLabel} to turn on)` : "Microphone off";
}

/**
 * The setup check's microphone fix while the voice line shows an error (review #100): the microphone's privacy switch
 * (Windows) or permission (macOS) is off, so the button that turns it on sits beside the error too. null otherwise.
 */
export function voiceFix<F extends string>(state: string, checks: readonly { id: string; fix?: F }[]): F | null {
  if (state !== "error") return null;
  return checks.find(c => c.id === "microphone" && c.fix)?.fix ?? null;
}

/** What the voice line says when its fix button's fix was refused (main's own words, as the setup check's button). */
export function voiceFixFailed(err: unknown): string {
  return `Couldn't open it: ${ipcErrorText(err)}`;
}

/** Download progress for screen readers: only at 0, 25, 50, 75 and 100 %. */
export function progressStep(fraction: number): number {
  return Math.min(100, Math.floor(Math.max(0, fraction) * 4) * 25);
}

/**
 * A setup check's fix button as a screen reader names it (review #155, #49): the words it shows, then its row, so four
 * "Open System Settings" buttons or one "Turn on" per distro can be told apart.
 */
export function fixButtonName(fixLabel: string, checkLabel: string): string {
  return `${fixLabel}: ${checkLabel}`;
}

/** What the setup check's status line says when a fix was refused (main's reason, in its own words). */
export function fixFailedText(checkLabel: string, reason: string): string {
  return `${checkLabel}: couldn't change it. ${reason}`;
}

const KIND: Record<string, string> = {
  "project-patch": "Apply a project patch",
  click: "Click", toggle: "Switch", text: "Type into", select: "Choose in", value: "Set", setting: "Change setting", open_app: "Open",
  cursor_click: "Click (your mouse)", cursor_text: "Type (your keyboard)", keys: "Press keys", scroll: "Scroll", point: "Point at", read: "Read",
};

export interface EntryView { tag: string; cls: string; what: string; why?: string }

const KEY_NAMES: Record<string, string> = {
  ctrl: "Ctrl", control: "Ctrl", alt: "Alt", shift: "Shift", super: "Super", meta: "Super", return: "Enter", enter: "Enter",
  escape: "Esc", esc: "Esc", backspace: "Backspace", delete: "Delete", tab: "Tab", space: "Space", up: "Up", down: "Down",
  left: "Left", right: "Right", home: "Home", end: "End", pageup: "Page Up", page_up: "Page Up", prior: "Page Up",
  pagedown: "Page Down", page_down: "Page Down", next: "Page Down", insert: "Insert",
};
/** The canonical modifier an X keysym is on an OS: Super and Meta are its logo key (Win, or ⌘ on a Mac). */
function modifierToken(keysym: string, kc: KeyConventions): string | undefined {
  if (/^(super|meta)_/i.test(keysym)) return kc.logoToken;
  return ({ control: "ctrl", alt: "alt", shift: "shift" } as Record<string, string>)[keysym.split("_")[0].toLowerCase()];
}
/**
 * An OS's key names: the shared ones with its modifier labels on top, and every other spelling of a modifier read the
 * same way, so "control+a" and "ctrl+a" both say "Control+A" on a Mac and "meta+e" says "Win+E" on Windows (a task's
 * keys are logged as the model wrote them). On Linux the labels and aliases equal KEY_NAMES' own: today's names.
 */
function keyNames(kc: KeyConventions): Readonly<Record<string, string>> {
  const spellings: [string, string][] = [["control", "Control_L"], ["super", "Super_L"], ["meta", "Meta_L"], ...Object.entries(kc.extraModifiers)];
  const aliases = spellings.flatMap(([name, keysym]): [string, string][] => {
    const token = modifierToken(keysym, kc);
    const label = token === undefined ? undefined : kc.labels[token];
    return label === undefined ? [] : [[name, label]];
  });
  return { ...KEY_NAMES, ...Object.fromEntries(aliases), ...kc.labels };
}
const KEY_NAMES_BY_OS: Readonly<Record<OS, Readonly<Record<string, string>>>> = {
  linux: keyNames(KEYS.linux),
  win32: keyNames(KEYS.win32),
  darwin: keyNames(KEYS.darwin),
};
/** A key as people write it on `os`: "ctrl+s" → "Ctrl+S", "Return" → "Enter" ("cmd+s" → "Command+S" on a Mac). */
export function keyLabel(key: string, os: OS = "linux"): string {
  const names = KEY_NAMES_BY_OS[os];
  return key.split("+").map(part => {
    const k = part.trim();
    return names[k.toLowerCase()] ?? (k.length === 1 || /^f\d{1,2}$/i.test(k) ? k.toUpperCase() : k);
  }).join("+");
}

/**
 * What "What Ember did" lines depend on beyond the entry: the OS (for key names). Not the stop chord: the record doesn't
 * keep which one was pressed, and the one Ember holds now (its default, its fallback or none, D-45b) may not be it.
 */
export interface EntryWords { readonly os: OS }
/** Linux's, today's words: what a line uses while the status names no OS. */
export const LINUX_ENTRY_WORDS: EntryWords = { os: "linux" };
/** The entry words for the OS a status names (Linux's without one). */
export function entryWords(p?: StatusPlatform): EntryWords {
  return p ? { os: p.os } : LINUX_ENTRY_WORDS;
}

/** The tools Ember's model is told to call: a sentence that names one is advice to the model, not news for the user. */
const TOOL_NAME = /\b(perceive_window|finish_task|press_keys|type_text|fill_cells|list_windows|switch_window|open_app|open_on_desk|wait_for_click|choose_option|read_element)\b/;
/**
 * Why a step didn't work, as the user reads it: without what the model was told to do next ("Tell the user in
 * finish_task.", "call perceive_window and try again") or the helper's code before it ("background_unavailable: ").
 */
export function forUser(why: string | undefined): string | undefined {
  if (!why) return undefined;
  const out = why.replace(/^[a-z]+(?:_[a-z]+)+:\s*/, "").split(/(?<=[.!?])\s+/).map(s => {
    const at = s.search(TOOL_NAME);
    if (at < 0) return s;
    // "… too busy to be read in time: call perceive_window and try again." keeps what went before the advice.
    const colon = s.lastIndexOf(":", at);
    return colon > 0 ? `${s.slice(0, colon).trimEnd()}.` : "";
  }).filter(Boolean).join(" ");
  return out || undefined;
}

/** "The user …" in a reason is you: the verbs that change with it ("the user has" → "you have"). */
const YOU_VERBS: Readonly<Record<string, string>> = {
  has: "have", is: "are", was: "were", does: "do", "doesn't": "don't", "hasn't": "haven't", "isn't": "aren't", "wasn't": "weren't",
  says: "say", wants: "want", asks: "ask", needs: "need",
};
/**
 * A reason as the user reads it in "What Ember did" (review #217): the audit keeps the policy's and the helpers' own
 * words, which call the user "the user" and often start in lower case. Here they say "you", "your" and "yours", start
 * with a capital and end with a full stop. A first word that is a name ("build-01's") keeps its case.
 */
export function userWords(why: string | undefined): string | undefined {
  const s = why?.trim();
  if (!s) return undefined;
  const you = s
    // "… wasn't the user's." ends its clause: "yours", not "your" (decide.ts' reason for a tainted task).
    .replace(/\b([Tt])he user's(?=\s*[.,;:!?)]|\s*$)/g, (_m, t: string) => (t === "T" ? "Yours" : "yours"))
    .replace(/\b([Tt])he user's\b/g, (_m, t: string) => (t === "T" ? "Your" : "your"))
    .replace(/\b([Tt])he user\b(?: (\S+))?/g, (_m, t: string, next: string | undefined) => {
      const verb = next !== undefined ? YOU_VERBS[next] ?? next : undefined;
      return `${t === "T" ? "You" : "you"}${verb !== undefined ? ` ${verb}` : ""}`;
    });
  const first = /^[a-z][a-z']*(?=[\s,;:.]|$)/.test(you) ? you[0].toUpperCase() + you.slice(1) : you;
  return /[.!?…]$/.test(first) ? first : `${first}.`;
}

/** Shell names as people write them (the command window's own). */
const SHELL_NAME: Readonly<Record<string, string>> = { bash: "bash", zsh: "zsh", sh: "sh", powershell: "PowerShell", cmd: "cmd" };

/** A target id as a place: "on this computer", "on build-01", "in Ubuntu (WSL)" (an id it can't read: no place). */
function placeOf(target: unknown): string {
  if (target === undefined || target === "local") return "on this computer";
  const p = typeof target === "string" ? parseTargetId(target) : null;
  return !p ? "" : p.kind === "local" ? "on this computer" : p.kind === "ssh" ? `on ${p.name}` : `in ${p.name} (WSL)`;
}

/** A computer's name, as a remote or WSL entry gives it. */
function computerOf(e: ActivityEntry): string {
  if (e.event === "wsl") return typeof e.distro === "string" && e.distro ? `${e.distro} (WSL)` : "WSL";
  return typeof e.host === "string" && e.host ? e.host : "another computer";
}

/** How a run ended, as the end line says it (commands/types.ts' CommandExit.ended). */
function commandEnd(e: ActivityEntry, what: string): EntryView {
  switch (e.ended) {
    case "exit":
      if (e.code === 0) return { tag: "Done", cls: "ok", what };
      return { tag: "Didn't work", cls: "no", what, why: typeof e.code === "number" ? `It ended with exit code ${e.code}.` : typeof e.signal === "string" ? `It was ended by ${e.signal}.` : undefined };
    case "stopped-user": return { tag: "Stopped", cls: "no", what, why: "You stopped it." };
    case "stopped-task": return { tag: "Stopped", cls: "no", what, why: "Its task stopped." };
    case "killswitch": return { tag: "Stopped", cls: "no", what, why: "Everything was stopped." };
    case "timeout": return { tag: "Didn't work", cls: "no", what, why: "It ran out of time." };
    case "lost": return { tag: "Didn't work", cls: "no", what, why: "The connection dropped." };
    case "failed-to-start": return { tag: "Didn't work", cls: "no", what, why: "It couldn't start." };
    case "refused-remote": {
      const host = typeof e.target === "string" ? parseTargetId(e.target) : null;
      const own = host?.kind === "ssh" ? `${host.name}'s own check` : "The computer's own check";
      return { tag: "Refused", cls: "no", what, why: e.needsConfirm === true ? `${own} asked first.` : `${own} refused it.` };
    }
    default: return { tag: "Didn't work", cls: "no", what };
  }
}

/** An answer to one of Ember's questions: "You allowed", "You said no"… (the same tags as the confirm lines). */
function answerTag(answer: unknown): Pick<EntryView, "tag" | "cls"> {
  return answer === "once" || answer === "always" ? { tag: "You allowed", cls: "ok" }
    : answer === "deny" ? { tag: "You said no", cls: "no" } : answer === "stopped" ? { tag: "Stopped", cls: "no" } : { tag: "No answer", cls: "no" };
}

/**
 * A command's line (commands/flow.ts's audit, review #152 and #224): where it ran, in which shell when known, and how
 * it went. Never the command's text: the audit folder keeps it (redacted), and the command window shows it in full.
 */
function commandLine(e: ActivityEntry): EntryView | null {
  const place = placeOf(e.target);
  const shell = typeof e.shell === "string" ? SHELL_NAME[e.shell] : undefined;
  const run = [shell ? `Run a ${shell} command` : "Run a command", place].filter(Boolean).join(" ");
  switch (e.phase) {
    case "decided":
      // An ordinary command runs without asking: its end line says it.
      if (e.verdict === "refuse") return { tag: "Refused", cls: "no", what: run, why: userWords(e.reason) };
      if (e.verdict === "ask") return { tag: "Asked you", cls: "ask", what: run, why: userWords(e.reason) };
      if (e.verdict === "announce") return { tag: "Announced", cls: "ask", what: run, why: userWords(e.reason) };
      return null;
    case "answered":
      if (e.q === "consent") return { ...answerTag(e.answer), what: ["Turn on commands", place].filter(Boolean).join(" ") };
      // Stop pressed while an announcement counted down.
      if (e.q === "announce") return { tag: "Stopped", cls: "no", what: run, why: "You stopped it before it started." };
      return { ...answerTag(e.answer), what: run };
    case "ended":
      return commandEnd(e, run);
    default:
      return null;
  }
}

/** Why a connection didn't work, by its kind (remote/ssh-errors.ts); kinds without plain words say nothing more. */
const CONNECT_WHY: Readonly<Record<string, string>> = {
  auth: "It needed you to sign in.", cancelled: "You cancelled it.", timeout: "It took too long.", dns: "Ember couldn't find it.",
  network: "Ember couldn't reach it.", "unknown-host-key": "Its key wasn't checked.", "host-key-changed": "Its key has changed.",
  "not-allowed": "Your organisation doesn't allow it.",
};

/**
 * A connection's line (remote/connections.ts's audit; WSL's in the same steps): made, lost, ended, failed, given up
 * reconnecting, or removed.
 */
function connectionLine(e: ActivityEntry): EntryView | null {
  const name = computerOf(e);
  const why = typeof e.kind === "string" ? CONNECT_WHY[e.kind] : undefined;
  switch (e.step) {
    case "connected": return { tag: "Connected", cls: "ok", what: name };
    case "lost": return { tag: "Lost", cls: "no", what: name, why: "The connection dropped." };
    // "Disconnected" is too wide for the tag column.
    case "disconnected": return { tag: "Ended", cls: "", what: `Connection to ${name}` };
    case "failed":
      // A reconnect's tries (about 24 in its 10 minutes) make one line, "gave-up", when it stops (review #152).
      if (e.reconnect === true) return null;
      // Removal is called what settings' button calls it: "Remove Ember's helper from build-01" (review #191).
      return { tag: "Didn't work", cls: "no", what: e.uninstall === true ? `Remove Ember's helper from ${name}` : `Connect to ${name}`, ...(why ? { why } : {}) };
    case "uninstalled": return { tag: "Removed", cls: "ok", what: `Ember's helper from ${name}` };
    case "gave-up": return { tag: "Didn't work", cls: "no", what: `Reconnect to ${name}`, ...(why ? { why } : {}) };
    // A card shown, a connection starting: the line after it says how it went.
    default: return null;
  }
}

/**
 * The entries with each command's shell carried from its decision to its answer and its end (newest first, as main
 * sends them): only the decision says which shell, and an ordinary command's decision has no line of its own.
 */
export function withCommandShells(entries: readonly ActivityEntry[]): ActivityEntry[] {
  const shells = new Map<string, string>();
  const out = [...entries];
  for (let i = out.length - 1; i >= 0; i--) {
    const e = out[i];
    if (e.event !== "command") continue;
    const key = `${String(e.task)}|${String(e.target)}`;
    const known = shells.get(key);
    if (e.phase === "decided" && typeof e.shell === "string") shells.set(key, e.shell);
    else if ((e.phase === "answered" || e.phase === "ended") && e.shell === undefined && known !== undefined) out[i] = { ...e, shell: known };
  }
  return out;
}

/** One line of "What Ember did", or null for entries that the next line already says. */
export function describeEntry(e: ActivityEntry, words: EntryWords = LINUX_ENTRY_WORDS): EntryView | null {
  // A named control is called by its name ("Switch “Night Light”"); the role only when there is no name.
  const control = e.element ? (e.element.name ? `“${e.element.name}”` : aRoleWord(e.element.role)) : e.value ? `“${e.value}”` : "";
  const where = e.app ? `in ${friendlyApp(e.app)}` : "";
  const target = [control, where].filter(Boolean).join(" ");
  const chosen = typeof e.value === "string" && e.value ? e.value : "";
  // On Ember's desk the keyboard and the mouse are the desk's own, not the user's.
  const deskless = (s: string) => (e.tier === 2 || e.onDesk === true ? s.replace(/ \(your (keyboard|mouse)\)$/, "") : s);
  // Keys say which ("Press Ctrl+S in Mousepad"): the field they went to adds nothing.
  const what = e.kind === "keys"
    ? [chosen ? `Press ${keyLabel(chosen, words.os)}` : "Press keys", where].filter(Boolean).join(" ")
    // The option chosen, and what it was chosen for: "Choose “Vegetarian” for “Meal” in Firefox".
    : e.kind === "select" && chosen && e.element
      ? [`Choose “${chosen}”`, e.element.name ? `for “${e.element.name}”` : "", where].filter(Boolean).join(" ")
      // A guide step the user did themselves (a click, or Enter or Space on it).
      : e.kind === "user_clicked" ? `You used ${target || "it"}`
        : `${deskless(KIND[e.kind ?? ""] ?? e.kind ?? "")} ${target}`.trim();
  switch (e.event) {
    case "task":
      if (e.phase === "asked") return { tag: e.mode === "guide" ? "Guide" : "Task", cls: "", what: String(e.goal ?? "") };
      if (e.phase === "done") return { tag: "Finished", cls: "ok", what: String(e.summary ?? e.goal ?? "") };
      return { tag: e.phase === "cancelled" ? "Stopped" : "Failed", cls: "no", what: String(e.goal ?? ""), why: typeof e.summary === "string" ? userWords(e.summary) : undefined };
    case "decision":
      // Several cells filled with one question (fill_cells): one line for them all, on the last cell's decision.
      if (typeof e.batch === "number") {
        if (e.at !== e.batch - 1 || (e.batchVerdict !== "ask" && e.batchVerdict !== "deny")) return null;
        const fill = [deskless(`Fill ${e.batch} cells (your keyboard)`), where].filter(Boolean).join(" ");
        return { tag: e.batchVerdict === "deny" ? "Refused" : "Asked you", cls: e.batchVerdict === "deny" ? "no" : "ask", what: fill, why: typeof e.batchReason === "string" ? userWords(e.batchReason) : undefined };
      }
      // Gone ahead without asking (Work without asking): said, so the record shows which steps weren't asked about.
      if (e.verdict === "allow") return e.autonomy === true ? { tag: "Without asking", cls: "", what } : null; // (otherwise the action line says it)
      return { tag: e.verdict === "deny" ? "Refused" : "Asked you", cls: e.verdict === "deny" ? "no" : "ask", what, why: userWords(e.reason) };
    case "confirm":
      return { ...answerTag(e.answer), what };
    case "action":
      return { tag: e.ok ? "Done" : "Didn't work", cls: e.ok ? "ok" : "no", what: `${what}${e.tier === 2 ? " (on Ember's desk)" : ""}`, why: userWords(forUser(e.error)) };
    case "stop": {
      // What pulled it: a control the user used, or the administrator's policy changing while Ember ran (killswitch.ts
      // StopSource). A source this page doesn't know is put on no control (cross-review X10).
      if (e.source === "policy") return { tag: "Stopped", cls: "no", what: "Everything stopped: your organisation changed Ember's policy" };
      const how = e.source === "hotkey" ? "stop shortcut" : e.source === "voice" ? "“Ember, stop”" : e.source === "settings" ? "settings" : e.source === "menu" ? "menu" : null;
      return { tag: "Stopped", cls: "no", what: how ? `Everything stopped (${how})` : "Everything stopped" };
    }
    case "autonomy": {
      const by = e.via === "voice" ? (e.verified === true ? " (by your voice, Voice Match)" : " (by voice)") : e.via === "typed" ? " (asked in words)" : "";
      return { tag: "Setting", cls: "", what: `${e.on === true ? "Work without asking turned on" : "Work without asking turned off"}${by}` };
    }
    case "command":
      return commandLine(e);
    case "remote":
    case "wsl":
      return connectionLine(e);
    default:
      return null;
  }
}

/** Rich text in the settings window: plain text, a key cap (`<kbd>`) or a command or path (`<code>`). */
export type Segment = string | { readonly kbd: string } | { readonly code: string };

/**
 * One change the OS makes to the settings window's markup: the elements `selector` finds (`#id`, or a shortcut's chord
 * chips `[data-shortcut="stop"]`) get `content` in place of their children, are hidden or shown, and/or get `attrs`.
 */
export interface HomePatch {
  readonly selector: string;
  readonly content?: readonly Segment[];
  readonly hidden?: boolean;
  readonly attrs?: Readonly<Record<string, string>>;
}

/** A shortcut's key caps as a chord chip shows them: <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>X</kbd>. */
export function chordSegments(keys: readonly string[]): Segment[] {
  return keys.flatMap((kbd, i): Segment[] => (i ? ["+", { kbd }] : [{ kbd }]));
}

/** The audit folder as the window names it: inside the data folder, with the OS's separator. */
export function auditDirLabel(p: Pick<StatusPlatform, "os" | "dataDir">): string {
  const sep = p.os === "win32" ? "\\" : "/";
  return `${p.dataDir.replace(/[\\/]+$/, "")}${sep}audit${sep}`;
}

/** The journal hint after the audit folder: " and in the system journal (<code>journalctl -t ember-audit</code>)". */
export function auditCopySegments(auditCopy: string): Segment[] {
  // A command in brackets at the end reads as code, as the window has always shown journalctl.
  const m = /^(.*\()([^()]+)(\)[^()]*)$/.exec(auditCopy);
  return m ? [` and in ${m[1]}`, { code: m[2] }, m[3]] : [` and in ${auditCopy}`];
}

/**
 * Everything the settings window fills in from `Status.platform`: the chord chips, the data and audit folders, the
 * journal hint, the consent's OS sentences, the login note and the empty conversation's hint. Linux's status gives
 * back the page's own markup, so applying it changes nothing a person or a screen reader can tell.
 */
export function homePatches(p: StatusPlatform): HomePatch[] {
  const chords = (Object.keys(SHORTCUTS.linux) as ShortcutId[])
    .map((id): HomePatch => ({ selector: `[data-shortcut="${id}"]`, content: chordSegments(p.shortcuts[id].keys) }));
  // A shortcut another app holds with its fallback (D-45b): the sentences that name its chord give way to how to do it
  // without the key.
  const taken = (id: ShortcutId) => p.shortcuts[id].taken === true;
  const toggles = (["stop", "ask", "mute"] as const).flatMap((id): HomePatch[] => [
    { selector: `[data-key-held="${id}"]`, hidden: taken(id) },
    { selector: `[data-key-taken="${id}"]`, hidden: !taken(id) },
  ]);
  // The question keys' sentence names each key Ember holds, and sends only the other one to the bubble.
  const asked = !taken("allow") && !taken("deny") ? "both" : !taken("allow") ? "allow" : !taken("deny") ? "deny" : "none";
  const questionKeys = (["both", "allow", "deny", "none"] as const).map((k): HomePatch => ({ selector: `[data-question-keys="${k}"]`, hidden: k !== asked }));
  return [
    ...chords,
    ...toggles,
    ...questionKeys,
    { selector: 'p:has(> [data-shortcut="settings"])', hidden: taken("settings") },
    { selector: "#settings-taken", content: [`Open Ember again ${OPEN_AGAIN[p.os]} any time to come back here, or click Ember's handle.`], hidden: !taken("settings") },
    { selector: "#permissions-note", content: [p.permissionsNote], hidden: !p.permissionsNote },
    { selector: "#data-dir", content: [p.dataDir] },
    { selector: "#autostart-note", content: [p.autostartNote ?? ""], hidden: !p.autostartNote },
    // Ember listens to what the speakers play (to tell its own voice apart) only where the OS lets it, today Linux's
    // PulseAudio: elsewhere the consent doesn't say it does.
    { selector: "#speaker-note", hidden: !p.speakerRejection },
    { selector: "#output-note", hidden: !p.outputLevel },
    { selector: "#conversation", attrs: { "data-empty": emptyConversationText(p.shortcuts.ask.label) } },
    { selector: "#mic-indicator", content: [p.micIndicator], hidden: !p.micIndicator },
    { selector: "#audit-dir", content: [auditDirLabel(p)] },
    p.auditCopy ? { selector: "#journal-hint", content: auditCopySegments(p.auditCopy), hidden: false } : { selector: "#journal-hint", hidden: true },
    // WSL is Windows' alone: the onboarding line names it only there (review #221).
    { selector: "#targets-note", content: [onboardingRest(p.os)] },
  ];
}

/**
 * Whether the window reads the status again each time it comes back: only off Linux, where permissions, the microphone
 * switch and the login item change in the OS's own settings, outside Ember (§9.8). Linux reads it once, as before:
 * every read runs the environment check, and on Linux that runs gsettings in main.
 */
export function rereadsStatusOnFocus(p: StatusPlatform | undefined): boolean {
  return p !== undefined && p.os !== "linux";
}

/** Comfort & access › Glass (settings.glass): how much of the screen shows through Ember's floating glass. */
export const GLASS_CHOICES: readonly { value: "clear" | "regular" | "solid"; label: string }[] = [
  { value: "clear", label: "Clear" },
  { value: "regular", label: "Regular" },
  { value: "solid", label: "Solid" },
];
export const GLASS_LABEL = "How much shows through";
export const GLASS_HINT = "How much of your screen shows through Ember's bubble, task cards, handle and ask box. Clear is an even, lighter tint, with Ember's words kept easy to read; Solid shows nothing through. Calm mode, and your desktop's settings to reduce transparency or increase contrast, make it solid.";

// ───── Voice personalisation (Settings › Voice, and the conversation's “That's not what I said”) ─────

/** The rows' words (docs/ASSISTANT.md "Personalisation"; app/main/personal/). */
export const PERSONAL_TEXT = {
  learn: "Keep learning my voice",
  learnHint: "Ember follows your voice as it changes (a new microphone, a cold), learning only from requests it is sure are yours: never from its own voice, or while another voice is about. It keeps numbers, never audio, with your voiceprint on this computer.",
  reset: "Reset to my enrolment",
  resetDone: "Ember went back to the voice it learnt when you taught it.",
  words: "Learn my words",
  wordsHint: "When Ember mishears a name, choose “That's not what I said” under your request in Conversation and type what you said: Ember hears it right from then on. It also listens for your apps' names and, with Memory on, the names you asked it to remember. Kept on this computer.",
  wordsHeading: "Words Ember learnt",
  wordsEmpty: "No words learnt yet.",
  forgetAllWords: "Forget all words",
  conversation: "Keep listening after I call Ember",
  conversationHint: "Talk to Ember as you would to a person: no name needed after the first time, and you can cut in while it speaks or works. Ember stops talking, takes in what you said and carries on. Say “That's all” to finish, or it stops listening 30 seconds after everything goes quiet. Off, you have a few seconds after each answer.",
  suggest: "Suggest what I might say next",
  suggestHint: "A few likely next requests under Ember's answers and in Ask Ember, worked out on this computer. Nothing runs until you choose one, and Ember never suggests sending, deleting or paying unless you just asked about it.",
  notSaid: "That's not what I said",
  teachLabel: "What you said",
  teachSave: "Save",
  teachCancel: "Cancel",
} as const;

/** How much Voice Match learnt since enrolment, under its row ("" before it learnt anything). */
export function learntText(n: number): string {
  if (n <= 0) return "";
  return n === 1 ? "Learnt from 1 of your requests since you taught it." : `Learnt from ${n} of your requests since you taught it.`;
}

/**
 * Voice Match's personalisation rows for a status (`hidden`: the Voice Match group is): Keep learning once it knows the
 * voice; Reset to my enrolment only while it is on and its model in, and it learnt something; the "Learnt from…" line.
 */
export function personalView(m: { enrolled: boolean; on: boolean; model?: boolean; enrolling: unknown; learnt?: number } | undefined, hidden: boolean): { learnRow: boolean; reset: boolean; learnt: string } {
  const enrolled = !!m?.enrolled && !m.enrolling && !hidden;
  const learnt = enrolled ? learntText(m?.learnt ?? 0) : "";
  return { learnRow: enrolled, reset: enrolled && !!m?.on && m?.model !== false && (m?.learnt ?? 0) > 0, learnt };
}

/** A learnt correction as its row says it: what Ember heard, and what it hears now. */
export function wordRowText(w: { heard: string; meant: string }): string {
  return `“${w.heard}” → “${w.meant}”`;
}

/** Its Forget button's spoken name. */
export function forgetWordLabel(w: { meant: string }): string {
  return `Forget “${w.meant}”`;
}

/** What the conversation says after the user retyped what they said (PersonalVoice.teach's outcome). */
export function teachOutcomeText(outcome: "learnt" | "off" | "unknown" | "unlike" | "same", meant: string): string {
  switch (outcome) {
    case "learnt": return `Got it: Ember will hear that as “${meant.trim()}” from now on.`;
    case "off": return "Learn my words is off (Settings › Voice), so Ember didn't keep that.";
    case "same": return "That's what Ember heard, so there's nothing to learn.";
    case "unlike": return "That's a different request, not a misheard word, so Ember didn't keep it. Ask again to have it done.";
    default: return "Ember can't find that request any more.";
  }
}

/** The baseline voice is included in the speech models; optional choices name their separate download. */
export const NATURAL_HINT = naturalModelHint("kitten");

/** Hear me more clearly's note: what it fetches and what it costs. */
export const CLEAR_HINT = "Downloads a 482 MB speech model that gets about half as many words wrong, above all with an accent or across a room. Each request takes about 0.3 s longer and listening uses about 550 MB more memory. It runs on this computer, and nothing you say leaves it.";

/** How Hear me more clearly stands, under its switch ("" while off). */
export function clearHearingLine(s: ClearHearingStatus | undefined): string {
  switch (s?.state) {
    case "downloading": return `Downloading… ${s.percent}%`;
    case "starting": return "Starting…";
    case "on": return "On. Ember writes what you say with the clearer model.";
    case "wont-load": return "It wouldn't start on this computer, so Ember is using its usual speech model.";
    case "needs-native": return "This computer can't run it, so Ember is using its usual speech model.";
    case "failed": return `${s.detail} Turn this off and on to try again.`;
    default: return "";
  }
}

/** Effective selected voice and actual playback/fallback from the service, without guessing from the old toggle. */
export function naturalVoiceView(s: NaturalVoiceStatus | undefined, model: NaturalModel = "kitten"): { text: string; retry: boolean; busy: boolean } {
  const name = NATURAL_CHOICES[model].name;
  const fallback = s?.voice === "kitten" ? "Ember uses Kitten Nano."
    : s?.voice === "system" || model === "kitten" ? "Ember uses this computer's system voice when available."
    : "Ember uses Kitten Nano when available, otherwise this computer's system voice.";
  if (!s || s.model && s.model !== model) return { text: `${name} is selected. Checking voice availability…`, retry: false, busy: true };
  switch (s.state) {
    case "later": return { text: `${name} will be checked the next time Ember speaks.`, retry: false, busy: false };
    case "checking": return { text: `Checking ${name} on this computer…`, retry: false, busy: true };
    case "needs-voice": return { text: `Kitten Nano is included in the speech models. Use Show speech model download to add it (63.8 MB for this voice). ${fallback}`, retry: false, busy: false };
    case "downloading": return { text: `Downloading ${name}… ${Math.max(0, Math.min(99, Math.round(s.percent)))}%`, retry: false, busy: true };
    case "ready": return { text: `${name} is ready for Ember's next reply.`, retry: false, busy: false };
    case "on": return { text: s.voice && s.voice !== model ? `${name} is selected. ${fallback}` : `Ember speaks in ${name}.`, retry: false, busy: false };
    case "too-slow": return { text: `${name} is too slow on this computer. ${fallback}`, retry: false, busy: false };
    case "wont-load": return { text: `${name} couldn't load. ${fallback}`, retry: false, busy: false };
    case "needs-native": return { text: `${name} isn't available on this computer. ${fallback}`, retry: false, busy: false };
    case "failed": return { text: model !== "kitten" ? `Couldn't download ${name}. ${s.detail} ${fallback}` : `Couldn't prepare Kitten Nano. ${s.detail} Download the speech models above to try again. ${fallback}`, retry: model !== "kitten", busy: false };
    default: return { text: `${name} is selected. ${fallback}`, retry: false, busy: false };
  }
}

/** Plain, local-only feedback and labels for the upcoming reminder inventory. */
export const REMINDER_WORDS = {
  gone: "That reminder is no longer waiting.", edit: "Edit", cancel: "Cancel reminder", words: "Reminder words",
  time: "Due on this computer's local time", save: "Save reminder", discard: "Discard edit",
  updated: "Reminder updated.", cancelled: "Reminder cancelled.",
  failed: "Couldn't change that reminder. Your edit is still here. If it changed or is already due, discard the edit and refresh the list.",
  future: "Choose a future local time within one week.", kept: "Kept on this computer after Ember closes.", transient: "Until Ember closes.",
  empty: "No reminders waiting.", deleted: "All routines and waiting reminders deleted.",
  deleteFailed: "Couldn't delete the routines and reminders. Try again.", loadFailed: "Couldn't load reminders. Try Refresh list again.",
} as const;

/** What is in Ember right now, counted while a Sign out or Forget everything question is open; null is "couldn't tell". */
export interface ForgetCounts { tasks: number | null; facts: number | null; reminders: number | null; routines: number | null }

/** Said while the counts are still being read. */
export const FORGET_LOADING = "Checking what this affects…";

const plural = (n: number | null, one: string, many: string) => n === null ? `an unknown number of ${many}` : `${n} ${n === 1 ? one : many}`;
const isAre = (n: number | null) => n === 1 ? "is" : "are";
/** Added when any count is unknown, so a missing number is never read as none. */
const UNKNOWN_NOTE = " Ember couldn't count everything right now, so those numbers are unknown, not zero.";
const hasUnknown = (c: ForgetCounts) => Object.values(c).some(n => n === null);

/** The question for Sign out: it clears all four, and the counts are today's. */
export function signOutScope(c: ForgetCounts): string {
  return `Sign out? This stops ${plural(c.tasks, "task", "tasks")} that ${isAre(c.tasks)} running or waiting, and clears this conversation (and the copy saved on this computer, if you keep one), `
    + `${plural(c.facts, "saved fact", "saved facts")}, ${plural(c.reminders, "reminder", "reminders")} and ${plural(c.routines, "routine", "routines")}.`
    + (hasUnknown(c) ? UNKNOWN_NOTE : "");
}

/** The question for Forget everything: only saved memory goes, and the other three are said to stay. */
export function forgetEverythingScope(c: ForgetCounts): string {
  return `Forget everything? This removes ${plural(c.facts, "saved fact", "saved facts")}, what Ember learned from them and the conversation saved on this computer, if you keep one. `
    + `${plural(c.tasks, "task", "tasks")}, ${plural(c.reminders, "reminder", "reminders")} and ${plural(c.routines, "routine", "routines")} stay as they are, and so do the lines on screen now, but they aren't saved again.`
    + (hasUnknown(c) ? UNKNOWN_NOTE : "");
}

/** Bulk deletion always names both visible record types and includes saved reminders in its scope. */
export function reminderDeleteScope(routines: number, reminders: number): string {
  return `Delete all ${routines} routines and ${reminders} waiting reminders? This removes saved reminders too.`;
}
