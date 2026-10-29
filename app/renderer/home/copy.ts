/**
 * The settings window's words: pure functions, so they are unit-tested. Words that differ by OS come from the status
 * main sends (`Status.platform`); every function defaults to Linux's, today's strings, so a window whose status doesn't
 * name an OS reads exactly as before.
 */

import type { ActivityEntry, StatusPlatform } from "../../shared/ipc";
// Plain words for an unnamed control's role: the same table the May I? question uses.
import { aRoleWord } from "../../shared/role-words";
import { KEYS, SHORTCUTS, type KeyConventions, type OS, type ShortcutId } from "../../shared/shortcuts";
import { parseTargetId } from "../../shared/targets";
import { NEVER_LOOK_DEFAULTS as NEVER_LOOK_BY_OS, NEVER_LOOK_NAMES, missingDefaults as missingFor } from "../../shared/never-look";
import { onboardingRest } from "./computers-copy";
import { needsUser, type SetupRow } from "../../shared/setup-attention";

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

/** The line under "Ember" at the top of the window; `askLabel` is the ask shortcut as this OS writes it. */
export function tagline(t: {
  failing: number; onboarded: boolean; phase: string | null; hidden: boolean; overlay: boolean; waitingForTasks?: boolean;
  /** Setup rows that don't fail but need the user (a warning that holds Ember back, or one with a button). */
  look?: number;
}, askLabel = SHORTCUTS.linux.ask.label): string {
  // Before Start it is always the first-run instruction: the setup check's own heading counts its rows (review #160).
  if (!t.onboarded) return "Read how Ember works, pick who keeps you company, then agree and press Start.";
  if (t.failing) return `Ember needs ${things(t.failing)} fixed before it can work on this computer.`;
  const where = !t.overlay ? "Ember is in the bottom-right corner." : t.hidden ? "Ember is hidden for now." : "Ember is beside your cursor.";
  if (t.phase === "error" && t.waitingForTasks) return `${where} Copilot isn't answering: Ember reconnects once the tasks that are running finish.`;
  if (t.phase === "signed-out" || t.phase === "error") return `${where} Connect Copilot below to start asking.`;
  if (t.phase === "starting" || t.phase === null) return `${where} Connecting to Copilot…`;
  // Ready, with setup rows still worth a look: said, so a warning isn't left in a closed fold (review #95).
  return `${where} Press ${askLabel} to ask it anything.${t.look ? ` The setup check has ${things(t.look)} worth a look.` : ""}`;
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
 * The note by the Setup check heading: how many rows fail, else how many warn, counted in words (review #160), as
 * `ember doctor` says it ("worth a look").
 */
export function checksNote(failing: number, warn: number): string {
  return failing ? `${things(failing)} to fix` : warn ? `${things(warn)} worth a look` : "All good";
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
  return { failing, warn, needing, open: needing > 0 && !before.opened, beforeStart: before.beforeStart || needing > 0, note: checksNote(failing, warn) };
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

/** What the conversation list says while it is empty (its `data-empty`); `askLabel` is the ask shortcut as this OS writes it. */
export function emptyConversationText(askLabel = SHORTCUTS.linux.ask.label): string {
  return `Nothing yet. Press ${askLabel} and ask Ember something.`;
}

/** Under "Speak replies" once Ember tried to speak and no voice started (review #101); the setup check says how to add one. */
export const SPEAK_NO_VOICE = "Ember couldn't speak: this computer has no voice it can use. The setup check says how to add one.";

/** The voice line while the microphone is off; `muteLabel` is the mute shortcut as this OS writes it. */
export function micOffText(muteLabel = SHORTCUTS.linux.mute.label): string {
  return `Microphone off (${muteLabel} to turn on)`;
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

/** What "What Ember did" lines depend on beyond the entry: the OS (for key names) and the stop shortcut's label. */
export interface EntryWords { readonly os: OS; readonly stopLabel: string }
/** Linux's, today's words: what a line uses while the status names no OS. */
export const LINUX_ENTRY_WORDS: EntryWords = { os: "linux", stopLabel: SHORTCUTS.linux.stop.label };
/** The entry words for the OS a status names (Linux's without one). */
export function entryWords(p?: StatusPlatform): EntryWords {
  return p ? { os: p.os, stopLabel: p.shortcuts.stop.label } : LINUX_ENTRY_WORDS;
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
      if (e.verdict === "allow") return null; // the action line that follows says it
      return { tag: e.verdict === "deny" ? "Refused" : "Asked you", cls: e.verdict === "deny" ? "no" : "ask", what, why: userWords(e.reason) };
    case "confirm":
      return { ...answerTag(e.answer), what };
    case "action":
      return { tag: e.ok ? "Done" : "Didn't work", cls: e.ok ? "ok" : "no", what: `${what}${e.tier === 2 ? " (on Ember's desk)" : ""}`, why: userWords(forUser(e.error)) };
    case "stop":
      return { tag: "Stopped", cls: "no", what: `Everything stopped (${e.source === "hotkey" ? words.stopLabel : e.source === "voice" ? "“Ember, stop”" : e.source === "settings" ? "settings" : "menu"})` };
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
  return [
    ...chords,
    { selector: "#permissions-note", content: [p.permissionsNote], hidden: !p.permissionsNote },
    { selector: "#data-dir", content: [p.dataDir] },
    { selector: "#autostart-note", content: [p.autostartNote ?? ""], hidden: !p.autostartNote },
    // Ember listens to what the speakers play (to tell its own voice apart) only where the OS lets it, today Linux's
    // PulseAudio: elsewhere the consent doesn't say it does.
    { selector: "#speaker-note", hidden: !p.speakerRejection },
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
