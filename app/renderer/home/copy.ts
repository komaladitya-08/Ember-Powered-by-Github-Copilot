/**
 * The settings window's words: pure functions, so they are unit-tested. Words that differ by OS come from the status
 * main sends (`Status.platform`); every function defaults to Linux's, today's strings, so a window whose status doesn't
 * name an OS reads exactly as before.
 */

import type { ActivityEntry, StatusPlatform } from "../../shared/ipc";
import { KEYS, SHORTCUTS, type KeyConventions, type OS, type ShortcutId } from "../../shared/shortcuts";
import { NEVER_LOOK_DEFAULTS as NEVER_LOOK_BY_OS, NEVER_LOOK_NAMES, missingDefaults as missingFor } from "../../shared/never-look";
import { computersIntro, onboardingRest } from "./computers-copy";
import { needsUser, type SetupRow } from "../../shared/setup-attention";

/** Linux's never-look defaults, the list a fresh Linux install starts with (other OSes': app/shared/never-look.ts). */
export const NEVER_LOOK_DEFAULTS: readonly string[] = NEVER_LOOK_BY_OS.linux;

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

export function retryMessage(r: { found: boolean; source: string | null }, connected = false): string {
  if (!r.found) return "No GitHub sign-in found on this computer. Run “gh auth login” in a terminal, then press Check again.";
  const what = SOURCE_TEXT[r.source ?? ""] ?? "a GitHub sign-in";
  return `Found ${what}; ${connected ? "connected." : "connecting…"}`;
}

/** "one thing", "2 things": how many setup rows, in a sentence. */
const things = (n: number) => (n === 1 ? "one thing" : `${n} things`);

/**
 * The line under "Ember" at the top of the window; `askLabel` is the ask shortcut as this OS writes it. Before Start it
 * is always the first-run instruction (the setup check's own heading counts its rows, review #160).
 */
export function tagline(t: {
  failing: number; onboarded: boolean; phase: string | null; hidden: boolean; overlay: boolean; waitingForTasks?: boolean;
}, askLabel = SHORTCUTS.linux.ask.label): string {
  if (!t.onboarded) return "Read how Ember works, pick who keeps you company, then agree and press Start.";
  if (t.failing) return `Ember needs ${things(t.failing)} fixed before it can work on this computer: see the setup check.`;
  const where = !t.overlay ? "Ember is in the bottom-right corner." : t.hidden ? "Ember is hidden for now." : "Ember is beside your cursor.";
  if (t.phase === "error" && t.waitingForTasks) return `${where} Copilot isn't answering: Ember reconnects once the tasks running are done.`;
  if (t.phase === "signed-out" || t.phase === "error") return `${where} Connect Copilot below to start asking.`;
  if (t.phase === "starting" || t.phase === null) return `${where} Connecting to Copilot…`;
  return `${where} Press ${askLabel} to ask it anything.`;
}

/** The note by the Setup check heading: how many rows fail, else how many warn, counted in words (review #160). */
export function checksNote(failing: number, warn: number): string {
  const n = (k: number) => `${k} ${k === 1 ? "thing" : "things"}`;
  return failing ? `${n(failing)} to fix` : warn ? `${n(warn)} to look at` : "All good";
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

/** The voice line while the microphone is off; `muteLabel` is the mute shortcut as this OS writes it. */
export function micOffText(muteLabel = SHORTCUTS.linux.mute.label): string {
  return `Microphone off (${muteLabel} to turn on)`;
}

/** Download progress for screen readers: only at 0, 25, 50, 75 and 100 %. */
export function progressStep(fraction: number): number {
  return Math.min(100, Math.floor(Math.max(0, fraction) * 4) * 25);
}

const KIND: Record<string, string> = {
  click: "Click", toggle: "Switch", text: "Type into", select: "Choose in", value: "Set", setting: "Change setting", open_app: "Open",
  cursor_click: "Click (your mouse)", cursor_text: "Type (your keyboard)", keys: "Press keys", scroll: "Scroll", point: "Point at", read: "Read",
};
/** Plain words for an unnamed control's role. */
const ROLE: Record<string, string> = {
  "push button": "a button", button: "a button", "toggle button": "a switch", switch: "a switch", "check box": "a checkbox",
  "radio button": "an option", text: "a text field", entry: "a text field", "password text": "a password field",
  "combo box": "a drop-down", "menu item": "a menu item", "list item": "a list item", link: "a link", slider: "a slider",
  "spin button": "a number field", "page tab": "a tab",
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
/** A key as people write it on `os`: "ctrl+s" → "Ctrl+S", "Return" → "Enter" ("cmd+s" → "Cmd+S" on a Mac). */
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

/** One line of "What Ember did", or null for entries that the next line already says. */
export function describeEntry(e: ActivityEntry, words: EntryWords = LINUX_ENTRY_WORDS): EntryView | null {
  // A named control is called by its name ("Switch “Night Light”"); the role only when there is no name.
  const control = e.element ? (e.element.name ? `“${e.element.name}”` : ROLE[e.element.role] ?? e.element.role) : e.value ? `“${e.value}”` : "";
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
      return { tag: e.phase === "cancelled" ? "Stopped" : "Failed", cls: "no", what: String(e.goal ?? ""), why: typeof e.summary === "string" ? e.summary : undefined };
    case "decision":
      // Several cells filled with one question (fill_cells): one line for them all, on the last cell's decision.
      if (typeof e.batch === "number") {
        if (e.at !== e.batch - 1 || (e.batchVerdict !== "ask" && e.batchVerdict !== "deny")) return null;
        const fill = [deskless(`Fill ${e.batch} cells (your keyboard)`), where].filter(Boolean).join(" ");
        return { tag: e.batchVerdict === "deny" ? "Refused" : "Asked you", cls: e.batchVerdict === "deny" ? "no" : "ask", what: fill, why: typeof e.batchReason === "string" ? e.batchReason : undefined };
      }
      if (e.verdict === "allow") return null; // the action line that follows says it
      return { tag: e.verdict === "deny" ? "Refused" : "Asked you", cls: e.verdict === "deny" ? "no" : "ask", what, why: e.reason };
    case "confirm":
      return { tag: e.answer === "once" || e.answer === "always" ? "You allowed" : e.answer === "deny" ? "You said no" : e.answer === "stopped" ? "Stopped" : "No answer", cls: e.answer === "once" || e.answer === "always" ? "ok" : "no", what };
    case "action":
      return { tag: e.ok ? "Done" : "Didn't work", cls: e.ok ? "ok" : "no", what: `${what}${e.tier === 2 ? " (on Ember's desk)" : ""}`, why: forUser(e.error) };
    case "stop":
      return { tag: "Stopped", cls: "no", what: `Everything stopped (${e.source === "hotkey" ? words.stopLabel : e.source === "voice" ? "“Ember, stop”" : "menu"})` };
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
    // WSL is Windows' alone: the onboarding line and the Computers intro name it only there (review #221).
    { selector: "#targets-note", content: [onboardingRest(p.os)] },
    { selector: "#computers-intro", content: [computersIntro(p.os)] },
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
