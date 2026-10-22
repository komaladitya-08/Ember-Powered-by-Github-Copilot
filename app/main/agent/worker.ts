/**
 * A worker: one Copilot session that carries out one task in the user's apps.
 * It sees the screen through Perception and acts through the accessibility
 * sidecar (tier 1) or system settings (tier 0). Every action goes through the
 * policy engine first, and is shown on screen: Ember flies to the element it
 * is touching.
 *
 * Stopping is absolute: once the task is stopped (Stop, the kill switch, a
 * step or time limit), no tool sends anything more to an app, even one that
 * was already approved or waiting for its turn.
 */

import fs from "node:fs";
import { defineTool, type CopilotClient, type CopilotSession, type ProviderConfig, type Tool, type ToolResultObject } from "@github/copilot-sdk";
import { z } from "zod";
import { hardenedSessionConfig, verifySessionTools } from "./session-config";
import { workerSystemMessage, guideSystemMessage } from "./worker-persona";
import { TURN_START_MS, TurnWatch, within } from "./conductor";
import { asPasteClipboard, ClipboardTimeout, holdsPassword, type ClipboardSnapshot, type PasteClipboard, type TextClipboard } from "./clipboard";
import { handStep, stepOf, type HandStep, type Presenter } from "./presenter";
import type { Confirmer } from "./confirm";
import type { WindowTarget } from "../perception";
import type { AxNode, Bounds, ActionResult, ElementInfo, PointElement } from "../perception/sidecar";
import type { PolicyEngine, ActionKind, ActionRequest, Agreement, ReadSource, TextMode, WindowId } from "../policy/policy";
import type { AuditEntry, AuditLog } from "../policy/audit";
import { inferLabels, quoteUntrusted as q, screenWord } from "../perception/elements";
import { canonicalKeys, foldLabel, isActivatingKey, isEmberWindow, isSecurityWindow, keyFamily, keyLabel, MOVES_CARET, plainQuestion, reachesOut, replacesSelection, takesFormula, typedChar } from "../policy/policy";
import { FILE_PATH_WORDS } from "../policy/vocabulary";
import { SETTINGS, changeSetting, findApp, isTerminalApp, launchApp, listApps, programsOf, type DesktopApp, type SettingName } from "../hands/system";
import { BorrowStopped, CursorBorrow, UserTookOver, typeableText, type Hand } from "../hands/borrow";
import { DIALOG_ROLES, deskWindowAt, type DeskPlace } from "../desk/place";
import { focusedElement, isSheetCell } from "../perception/elements";
import { SLIVER_PX } from "../perception/marks";
import { friendlyApp } from "../../shared/apps";
import { KEYS, SHORTCUTS, type KeyConventions, type OS, type ShortcutTable } from "../../shared/shortcuts";
import { PLATFORM_WORDS, type PlatformWords } from "../../shared/words";
import type { AppCatalog, PrivacyVocabulary, SystemSettings } from "../platform/types";
import type { Logger } from "../logger";
import type { SettingsStore } from "../settings";
import type { ActStamp, PerceptionPort, SidecarPort } from "../perception/ports";
import type { TargetBinding } from "../targets/types";
import type { CommandService } from "../commands/types";
import type { TargetId } from "../../shared/targets";

/**
 * What a worker needs of the OS it runs on (main passes its SystemPlatform, which has all of it): how keys are named
 * and which Ember presses itself, the words its tool descriptions and prompts use, Ember's shortcuts, the installed
 * apps, the comfort settings it can change, and which windows are security prompts.
 */
export interface WorkerSystem {
  os: OS;
  keys: KeyConventions;
  words: PlatformWords;
  shortcuts: ShortcutTable;
  apps: Pick<AppCatalog, "list" | "find" | "isTerminalApp" | "programsOf" | "appKey"> & {
    /** Starts the app. A remote's is asynchronous and throws gate 2's refusal (§2.6), so the worker awaits it. */
    launch(app: DesktopApp): void | Promise<void>;
  };
  settings: SystemSettings;
  privacy: Pick<PrivacyVocabulary, "isSecurityWindow">;
}

/** Linux's, from the modules a worker used before the port: a worker given no `system` (tests, the eval) works as it did. */
export const LINUX_WORKER_SYSTEM: WorkerSystem = {
  os: "linux", keys: KEYS.linux, words: PLATFORM_WORDS.linux, shortcuts: SHORTCUTS.linux,
  apps: {
    list: () => listApps(), find: findApp, launch: launchApp, isTerminalApp: app => isTerminalApp(app),
    programsOf: app => programsOf(app), appKey: name => name.toLowerCase(),
  },
  settings: { available: SETTINGS, change: changeSetting },
  privacy: { isSecurityWindow: w => isSecurityWindow(w) },
};

export interface WorkerDeps {
  client: CopilotClient;
  log: Logger;
  model: string | null;
  /**
   * With no model (`model` null), the runtime's default is used: only where the host found Copilot lists none and
   * nothing limits the models (mayUseRuntimeDefault).
   */
  runtimeDefault?: boolean;
  vision: boolean;
  provider?: ProviderConfig;
  workDir: string;
  perception: PerceptionPort;
  sidecar: SidecarPort;
  policy: PolicyEngine;
  confirmer: Confirmer;
  audit: AuditLog;
  settings: SettingsStore;
  presenter: Presenter;
  /** Waits until no other task is acting in this window; returns the release function. Gives up when `signal` aborts. */
  lease: (windowKey: string, taskId: string, signal?: AbortSignal) => Promise<() => void>;
  /** Ember flies to an element (screen px) while it acts; null brings it back. */
  flyTo: (bounds: Bounds | null) => void;
  onProgress: (text: string) => void;
  /** Ember's desk (tier 2), started on first use. */
  desk?: () => Promise<DeskPlace>;
  /** The worker moved to (or left) the desk: show or hide the mini-view. */
  /** The task moved to `place` (null: off the desk) from `previous`; the view counts the tasks on each desk. */
  onDesk?: (place: DeskPlace | null, previous: DeskPlace | null) => void;
  /** Pointer position and button mask in screen pixels (guide mode watches for the user's click). */
  pointer?: () => { x: number; y: number; mask: number } | null;
  /**
   * Is Enter (the keypad's too) or Space held down on the user's keyboard right now? Guide mode polls it to see a
   * keyboard user press the control pointed at (XInput's keysDown(), on the user's screen only).
   */
  activationKey?: () => boolean;
  /** Tier 3, when available: borrowing the user's mouse and keyboard. */
  cursor?: {
    borrow: CursorBorrow;
    /** X window id for a window title (0 if not found). */
    /** X window id for a window title, narrowed to the process when given (0 if none or several match). */
    findWindow: (title: string, pid?: number) => number;
    /** "waiting": for the user to be still; "active": Ember's windows stop taking clicks and the status says so. */
    setBorrowing: (state: "waiting" | "active" | "off") => void;
    /**
     * The window with keyboard focus on the user's screen (an auth prompt there pauses Ember's input), and its process
     * (Ember's own windows are its own process's).
     */
    activeWindow?: () => { app: string; title: string; pid?: number | null } | null;
  };
  onUsage?: (input: number, output: number) => void;
  /**
   * The user's clipboard (their screen only): text for a field Ember types into with the borrowed
   * keyboard is pasted (any keyboard layout, accents, long text), and the clipboard is put back
   * once the text is in the field.
   */
  clipboard?: PasteClipboard | TextClipboard;
  /**
   * Limits on one task (defaults: 150 tool calls, 20 minutes; a paste gets 10 s to show up in its field; a request
   * the runtime took gets TURN_START_MS for its turn to begin; a turn under way that hears nothing from Copilot says
   * so on the card after TURN_SLOW_MS and is given up on after TURN_SILENT_MS).
   */
  limits?: { maxSteps?: number; maxMs?: number; pasteWaitMs?: number; turnStartMs?: number; turnSlowMs?: number; turnSilentMs?: number };
  /** Whether this user's inotify instances are all in use (a task's turn can't begin then; see host's inotifyUsedUp). */
  inotifyUsedUp?: () => boolean;
  /** The OS's keys, words, apps, settings and security vocabulary (default LINUX_WORKER_SYSTEM). */
  system?: WorkerSystem;
  /** Where the task acts (default: this computer, as before targets existed). */
  target?: TargetBinding;
  /** The target's commands (absent or null: no run_command). */
  commands?: CommandService | null;
  /** The settings.grants key for an app on the task's target (default: the app's name in lower case). */
  grantKey?: (app: string) => string;
  /** Called with gate 1's stamp immediately before a step that policy allowed runs (remotes attach it to the step). */
  onAuthorized?: (stamp: ActStamp) => void;
}

export interface TaskSpec {
  id: string;
  goal: string;
  /** The target the task acts on, fixed for its life (absent: "local"). */
  targetId?: TargetId;
  /**
   * What the user said or typed in the turn that started the task (and in turns that changed it): risky steps are
   * checked against these, never against the goal the conductor wrote (it may have read screen text). Without
   * them (tests) the goal stands in.
   */
  userWords?: string;
  /**
   * Ember's questions the user answered in those turns with a yes or a choice: a risky step one of them names isn't
   * flagged as unasked (nor does it make every later step asked), but is asked about all the same (ActionRequest.agreed).
   */
  agreed?: Agreement[];
  /** What Ember's conversation read on the user's screen in that turn (untrusted): text from it typed into a window is asked about. */
  screen?: string;
  /** The window the user was in when they asked. */
  target: WindowTarget & { app?: string };
  /** "do": Ember acts. "guide": Ember points and the user clicks. */
  mode?: "do" | "guide";
}

export interface WorkerResult {
  success: boolean;
  summary: string;
  /** The user stopped it (took the mouse back, or said "Not now"): not a failure. */
  stopped?: boolean;
  /** Stopped because the user said no to a question (or let it go unanswered), and nothing was done after that. */
  declined?: boolean;
}

const done = (text: string): ToolResultObject => ({ textResultForLlm: text, resultType: "success" });
const fail = (text: string): ToolResultObject => ({ textResultForLlm: text, resultType: "failure", error: text });
const denied = (text: string): ToolResultObject => ({ textResultForLlm: text, resultType: "denied" });
const STOPPED = (): ToolResultObject => denied("Stopped. Do nothing more.");

/** After Stop, a turn that doesn't wind down within this long is left behind. */
const STOP_GRACE_MS = 2000;
/**
 * How long a pasted text gets to show up in its field before the user's clipboard goes back (Ember's text
 * stays on it until then, so a slow app pastes Ember's text, not the user's). A field whose text can't be
 * read gets PASTE_BLIND_MS, and every paste at least PASTE_MIN_MS (the app reads the clipboard after the key).
 */
const PASTE_WAIT_MS = 10_000;
const PASTE_BLIND_MS = 2000;
const PASTE_MIN_MS = 150;
/** The sidecar reads at most this much of a field's text. */
const TEXT_READ_LIMIT = 2000;
/** Text fields Ember may type into with the borrowed keyboard: never cells, lists, tables or icons (Ctrl+A and Delete there hit everything). */
const TYPING_ROLES = new Set(["text", "entry", "paragraph", "document text", "section", "spin button"]);
const typable = (role: string, states: string[]) => TYPING_ROLES.has(role) && states.includes("editable");
/** Controls the mouse wheel changes (a scroll over one picks another value). */
const WHEEL_VALUE_ROLES = new Set(["combo box", "slider", "spin button", "page tab list"]);
/** How long content gets to move after one wheel notch before Ember looks again. */
const NOTCH_SETTLE_MS = 150;
/** Wheel notches less than about this far apart go on scrolling what the first one did (Chromium's wheel latching). */
const NOTCH_LATCH_MS = 400;
/** Controls whose use does more than give them the keyboard or select them (Tab and a hover reach them first). */
const ACTS_ITSELF = /^(push button|push button menu|button|split button|toggle button|link|menu item|check menu item|radio menu item)$/;
/** Fields: the step is to be in one, so reaching it (Tab, a click) is using it. A font dialog's search box is one of these. */
const FOCUS_IS_THE_STEP = /^(text|entry|password text|spin button|document text|paragraph|terminal|search|search box)$/;
/** Accessibility roles the user never needs to hear (a guide names the words on the control instead). */
const ROLE_IN_SAY = /\b(the\s+)?(table cell|list item|tree item|push button|toggle button|combo box|spin button|document text|password text|menu item|check box|radio button|page tab|text field|text area|entry|cell|row|item|control|element)\b/gi;
const PLAIN_ROLE: Record<string, string> = {
  "table cell": "row", "list item": "row", "tree item": "row", "push button": "button", text: "text area",
  entry: "text field", search: "search box", "search box": "search box",
};
/** A dialog's way out: Cancel, Close, and the same with a GTK mnemonic underscore. */
const DISMISS = /^(cancel|close|abort|discard|don't save|dont save|no)$/i;
/** How long an app gets to notice the pointer over its window before Ember looks where to click again. */
const POINTER_SETTLE_MS = 100;
/**
 * How long a switch or check box gets to show it turned (GTK carries out an accessible click on its next turn, and a
 * busy app later) before Ember says it didn't: a toggle is never reported done on the app's word alone.
 */
const TOGGLE_WAIT_MS = 1000;
/** Is a switch, check box or toggle button on? */
const isOn = (states: string[]) => states.includes("checked") || states.includes("pressed");
/** The control around an element that a click on the element goes to (a link around its text, a row around its label). */
type Handler = { role: string; name: string };
/** Items the pointer selects (and focuses) by only passing over them: menus, and the lists of a drop-down. */
const HOVER_SELECTS = /^(menu|menu item|check menu item|radio menu item|list item|tree item|table cell)$/;
/** Rows of a list or table: the pointer selects them only in a menu or a drop-down's list (elsewhere, a click does). */
const ROW_ROLES = /^(list item|tree item|table cell)$/;
/** What a drop-down's or a menu's list sits in. */
const POPUP_ROLES = /^(menu|menu bar|combo box|popup menu|window|tool tip)$/;
const isUnder = (p: { x: number; y: number }, b: Bounds) => p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;

/** A window that saves to a file, by its title: GTK gives every file dialog (Open, Insert Image, Attach) the same role. */
const SAVE_TITLE = /^\s*(save|export)\b|\bsave (file|as|a copy|image)\b|\bfile to save\b/i;
/** Windows that put a question to the user: there, the question's words may be spread over its labels. */
const QUESTION_ROLE = /^(dialog|alert|alert dialog)$/;
const RESTORE = /\b(restore|recover|reopen)\b/i;

/**
 * A note for windows where taking the app's suggestion would act on something the user never named: an offer to
 * restore an earlier session or recover documents (it brings back old, unsaved text), and a Save dialog when the
 * user named no file (its suggested name and folder are the app's guess). `said`: what the user said for the task.
 * Only a question window is read as a whole; elsewhere (Files' Trash with its Restore button, a document about
 * restoring) one control must make the offer itself (Firefox's "Restore Session").
 */
export function dialogNote(w: { name: string; role?: string }, nodes: readonly { name: string; text?: string }[], said = "", os: OS = "linux"): string {
  const asked = (re: RegExp) => re.test(said);
  const offer = (s: string, earlier: RegExp) => RESTORE.test(s) && earlier.test(s);
  const top = nodes.slice(0, 60);
  const offers = QUESTION_ROLE.test(w.role ?? "")
    ? offer([w.name, ...top.flatMap(n => [n.name, n.text ?? ""])].join(" \n "), /\b(session|unsaved|previous|last time|crash|documents?)\b/i)
    : [w.name, ...top.map(n => n.name)].some(s => offer(s, /\b(session|unsaved|previous|last time)\b/i));
  if (offers && !asked(RESTORE)) {
    return "\nNote: this asks whether to restore an earlier session or recover unsaved documents. The user didn't ask for that: answer No (or Don't restore), and work on the file the task is about.";
  }
  if (SAVE_TITLE.test(w.name) && !FILE_PATH_WORDS[os].test(said)) {
    return "\nNote: the user named no file. Don't accept this dialog's suggested name or folder: save to the file this task is about if you know it, or cancel and say in finish_task that you need to know where to save.";
  }
  return "";
}

/** A place Ember can point at: on screen, and large enough that a box around it would not be an empty orange frame. */
export function usableBounds(b: Bounds | null | undefined): Bounds | null {
  if (!b) return null;
  if (!(b.width > 2) || !(b.height > 2) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return null;
  return b;
}

/** Cancel, Close, and the same with a GTK mnemonic underscore ("_Cancel"). */
export function dismissName(name: string): boolean {
  return DISMISS.test(name.replace(/[_….]+/g, "").replace(/\s+/g, " ").trim());
}

/**
 * A search box or other field the user may click instead of the row Ember pointed at: one to type in, or a combo box
 * that searches (LibreOffice's "Find:"). Never a window, a page or a button because of the words in its name ("Find
 * and Replace", "Research notes.odt"), nor the document being written.
 */
function fieldLike(n: { role: string; name: string; states: string[] }): boolean {
  // A text editor's page (gedit, Mousepad: a multi-line "text") is the document, not a box to search in.
  if (n.states.includes("multi line")) return false;
  return /^(text|entry|password text|spin button)$/.test(n.role) || /search/i.test(n.role) || (n.role === "combo box" && /search|find/i.test(n.name));
}

/**
 * The instruction shown while Ember points: the words on the control, never its accessibility role
 * ("press Enter on the table cell" → "Press Enter on Monospace Bold").
 */
export function guideSay(say: string, element: { role: string; name: string }): string {
  const name = element.name.replace(/\s+/g, " ").trim();
  const role = PLAIN_ROLE[element.role] ?? element.role;
  const what = name || `the ${role}`;
  const out = say.replace(/\s+/g, " ").trim();
  if (name && out.toLowerCase().includes(name.toLowerCase())) return out;
  ROLE_IN_SAY.lastIndex = 0;
  if (!ROLE_IN_SAY.test(out)) return out;
  ROLE_IN_SAY.lastIndex = 0;
  return out.replace(ROLE_IN_SAY, what).replace(/\bthe\s+the\b/i, "the").replace(/\s+/g, " ").trim();
}

/**
 * The middle of the widest lane across `b` (a column when scrolling up or down, a row when scrolling sideways), inside
 * `frame`, that none of `controls` touches; null when there is none.
 */
export function clearLane(b: Bounds, controls: Bounds[], vertical: boolean, frame: Bounds | null): number | null {
  const span = (r: Bounds): [number, number] => (vertical ? [r.x, r.x + r.width] : [r.y, r.y + r.height]);
  const [lo, hi] = span(b);
  const [flo, fhi] = frame ? span(frame) : [-Infinity, Infinity];
  const start = Math.max(lo, flo) + 2, end = Math.min(hi, fhi) - 2;
  const gaps: [number, number][] = [];
  let at = start;
  for (const [s, e] of controls.map(span).sort((x, y) => x[0] - y[0])) {
    gaps.push([at, Math.min(s - 2, end)]);
    at = Math.max(at, e + 2);
  }
  gaps.push([at, end]);
  const widest = gaps.filter(([s, e]) => e - s >= 4).sort((x, y) => (y[1] - y[0]) - (x[1] - x[0]))[0];
  return widest ? Math.round((widest[0] + widest[1]) / 2) : null;
}

/**
 * The controls in a read that the wheel changes. A tab list counts as its strip of tabs only: GTK 3's covers its
 * pages too (a text editor's or a file manager's whole view), and the wheel over a page scrolls the page.
 */
export function wheelControls(nodes: AxNode[]): AxNode[] {
  const out: AxNode[] = [];
  for (const n of nodes) {
    if (!WHEEL_VALUE_ROLES.has(n.role) || !n.bounds) continue;
    if (n.role !== "page tab list") { out.push(n); continue; }
    const tabs = nodes.filter(t => t.parent === n.id && t.role === "page tab" && t.bounds).map(t => t.bounds!);
    if (!tabs.length) continue; // no tabs shown (a single document)
    const x = Math.min(...tabs.map(b => b.x)), y = Math.min(...tabs.map(b => b.y));
    out.push({ ...n, bounds: { x, y, width: Math.max(...tabs.map(b => b.x + b.width)) - x, height: Math.max(...tabs.map(b => b.y + b.height)) - y } });
  }
  return out;
}

/** What the wheel would change, of the elements at its spot (outermost first): a control it changes, or a tab it is over. */
export function wheelTarget(chain: PointElement[], spot: { x: number; y: number }): PointElement | undefined {
  return chain.find(n => (WHEEL_VALUE_ROLES.has(n.role) && n.role !== "page tab list") || (n.role === "page tab" && !!n.bounds && isUnder(spot, n.bounds)));
}

/**
 * Does a read show anything inside `region` (where the wheel goes) besides scroll bars and what holds all of it (the
 * window, a tab list, a pane: they stay put while what they hold scrolls)? If not, it can't see what the wheel would
 * land on (GTK 3 once hid a page scrolled past its first screen from reads).
 */
export function seesInside(nodes: AxNode[], region: Bounds): boolean {
  const parents = new Set(nodes.map(n => n.parent));
  const meets = (b: Bounds) => b.x < region.x + region.width && region.x < b.x + b.width && b.y < region.y + region.height && region.y < b.y + b.height;
  const holds = (b: Bounds) => b.x <= region.x + 2 && b.y <= region.y + 2 && b.x + b.width >= region.x + region.width - 2 && b.y + b.height >= region.y + region.height - 2;
  return nodes.some(n => !!n.bounds && n.role !== "scroll bar" && meets(n.bounds) && !(parents.has(n.id) && holds(n.bounds)));
}

/** The overlap of two rectangles; null when they don't meet. */
export function overlap(a: Bounds, b: Bounds): Bounds | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width), y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 > x && y1 > y ? { x, y, width: x1 - x, height: y1 - y } : null;
}
/** Is `a` inside `b`, give or take `slack` px? */
const insideOf = (a: Bounds, b: Bounds, slack = 2) =>
  a.x >= b.x - slack && a.y >= b.y - slack && a.x + a.width <= b.x + b.width + slack && a.y + a.height <= b.y + b.height + slack;
const sameRect = (a: Bounds, b: Bounds) => insideOf(a, b, 1) && insideOf(b, a, 1);
/** A tab list less deep than this beside its tabs is only its strip of tabs (Qt's tab bar). */
const MIN_PAGE_PX = 16;

/**
 * Where the wheel goes to scroll a tab list (`list`, of which `shown` shows): GTK 3's holds its pages too, its tabs
 * in a strip along one side, and the wheel scrolls the page showing (its tabs don't switch on the wheel), so the part
 * of `shown` beside the strip. All of `shown` when no tabs show; null when the list is only its tabs (Qt's tab bar:
 * its tabs hold nothing, and it is hardly thicker than they are): then the tabs are what the wheel would change.
 */
export function tabPage(nodes: AxNode[], list: Bounds, shown: Bounds): Bounds | null {
  const me = nodes.find(n => n.role === "page tab list" && !!n.bounds && sameRect(n.bounds, list));
  const strip = me ? wheelControls(nodes.filter(n => n === me || n.parent === me.id))[0]?.bounds : undefined;
  const s = strip && overlap(strip, shown);
  if (!s) return shown;
  const tabs = new Set(nodes.filter(t => t.parent === me!.id && t.role === "page tab").map(t => t.id));
  const holdsPages = nodes.some(n => n.parent !== null && tabs.has(n.parent));
  if (!holdsPages && (list.width >= list.height ? list.height - s.height : list.width - s.width) < MIN_PAGE_PX) return null;
  // The tabs run along one side (a few tabs may be wider than they run long): the page is the biggest part beside them.
  const right = s.x + s.width, bottom = s.y + s.height;
  const page = [
    { x: shown.x, y: shown.y, width: shown.width, height: s.y - shown.y },
    { x: shown.x, y: bottom, width: shown.width, height: shown.y + shown.height - bottom },
    { x: shown.x, y: shown.y, width: s.x - shown.x, height: shown.height },
    { x: right, y: shown.y, width: shown.x + shown.width - right, height: shown.height },
  ].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  return page.width >= MIN_PAGE_PX && page.height >= MIN_PAGE_PX ? page : null;
}

/** Controls a click does something of its own on: one of these at the spot, other than the element aimed at, takes the click. */
const CLICK_TAKERS = /^(push button|push button menu|button|split button|toggle button|link|menu item|check menu item|radio menu item|menu|check box|radio button|switch|combo box|page tab|text|entry|password text|spin button|slider|list item|table cell|tree item|icon)$/;
/**
 * What only holds others (a pane, a list, a page): one of these round the element aimed at tells nothing more (a
 * toolkit's answer can stop there). Not a web page's own boxes (a section, a header): Chromium answers with the deepest
 * element there, so a box of the page round it at its spot lies over it (a fixed header).
 */
const HOLDERS = /^(panel|filler|unknown|redundant object|glass pane|layered pane|root pane|scroll pane|viewport|split pane|internal frame|option pane|frame|window|dialog|document web|document frame|embedded|list|list box|table|tree|tree table|page tab list|tool bar|status bar|menu bar)$/;

/**
 * Of the elements at a spot (outermost first, from atPoint), does the one Ember aims at (role `role`, at `b`) show
 * there, the deepest one the app names (Chromium answers with the deepest element)? "yes": it, or something inside it
 * that isn't another control (its text, its picture, its label); "other": something else is there (a row scrolled almost
 * out of its list, with a button below it; a fixed header's button over it; a button inside the row aimed at); "unknown":
 * the app's answer stopped at what holds it (one of `ancestors`, the elements round it in the read, or a plain holder
 * of others: a pane, a list), or told nothing. `spot`: where the mouse goes (see atSpot). `inside`: the controls a read
 * found inside it (see takerInside).
 */
export function aimedAt(chain: PointElement[], role: string, b: Bounds, ancestors: { role: string; bounds: Bounds | null }[] = [], spot?: { x: number; y: number }, inside: PointElement[] = []): "yes" | "other" | "unknown" {
  const here = spot ? atSpot(chain, spot) : chain;
  const last = here[here.length - 1];
  if (!last?.bounds || last.empty) return "unknown";
  if (last.role === role && sameRect(last.bounds, b)) return "yes";
  // Inside it: its own text, picture or label; or another control in it, which a click there would work instead (also
  // round the text there: Chromium answers with the deepest element, the words of a row's own "Remove" button).
  if (insideOf(last.bounds, b)) return takerInside(here, role, b, inside) ? "other" : "yes";
  if (!insideOf(b, last.bounds)) return "other";
  // Round it: what holds it (the app stopped there), or something else lying over it (a header's button).
  const holds = ancestors.some(a => a.role === last.role && !!a.bounds && sameRect(a.bounds, last.bounds!));
  return holds || HOLDERS.test(last.role) ? "unknown" : "other";
}
/**
 * The control inside the element aimed at (role `role`, at `b`) that a click on the deepest of `here` (from atPoint,
 * outermost first) works instead: that element itself, or one round it on the way up to the element aimed at (a
 * button round its own text); undefined when there is none (its own text, label or picture). Chromium's answer goes
 * from the window straight to the deepest element there, leaving out what lies between: `inside`, the controls a read
 * found inside the element aimed at, are those round the deepest one.
 */
export function takerInside(here: PointElement[], role: string, b: Bounds, inside: PointElement[] = []): PointElement | undefined {
  for (let i = here.length - 1; i >= 0; i--) {
    const n = here[i];
    if (!n.bounds) continue;
    // Up to the element itself, or out of it (what holds it).
    if ((n.role === role && sameRect(n.bounds, b)) || !insideOf(n.bounds, b)) break;
    if (CLICK_TAKERS.test(n.role) && !sameRect(n.bounds, b)) return n;
  }
  const deepest = here[here.length - 1]?.bounds;
  return deepest ? inside.find(c => !!c.bounds && CLICK_TAKERS.test(c.role) && insideOf(deepest, c.bounds, 1) && insideOf(c.bounds, b) && !sameRect(c.bounds, b)) : undefined;
}
/**
 * The elements of `chain` (from atPoint, outermost first) down to the deepest that lies at `spot`: GTK's answer goes on
 * from a notebook's selected tab into the page it holds, which lies beside the tab (one without a position is kept).
 */
export function atSpot(chain: PointElement[], spot: { x: number; y: number }): PointElement[] {
  let end = chain.length;
  while (end > 1 && chain[end - 1].bounds && !insideOf({ ...spot, width: 0, height: 0 }, chain[end - 1].bounds!)) end--;
  return end === chain.length ? chain : chain.slice(0, end);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** The accessibility helper's word for an app that didn't answer in time (busy), as opposed to an element that is gone. */
const isBusy = (err: unknown) => /\bbusy\b|did not (receive a reply|answer)|timeout was reached/i.test(err instanceof Error ? err.message : String(err));
const BUSY = "The app is busy (it didn't answer in time). Wait a moment, then call perceive_window.";

/** How a waiting task's goal carries what the user added (tasks.ts). */
const STEERED = /\n\(The user then added: (.*)\)$/gm;

/**
 * What has the keyboard in a window: its role and name (or the label beside it), and whether it holds a secret. A
 * spreadsheet's cell says so (`grid`, see isSheetCell) and which sheet it is in (`sheet`: the sheet's name, as a
 * number: it goes to the audit log, which keeps no screen text). `withheld`: its name was withheld (nameWithheld).
 */
type Focus = { role: string; name: string; secret?: boolean; withheld?: boolean; grid?: boolean; sheet?: number };
/** A sheet's name as Focus keeps it (FNV-1a). */
const sheetKey = (name: string) => { let h = 0x811c9dc5; for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0; return h; };
/**
 * Has what the user said yes to (`approved`) the keyboard `now`? The same role and name; or, for a spreadsheet said
 * yes to, a cell of it (keys pressed in a sheet go to its cell with the keyboard, which a look need not come to).
 * Not the other way round: a cell said yes to is not every cell of its sheet.
 */
export const sameFocus = (now: Focus | undefined, approved: Focus | undefined) => {
  if (!now || !approved) return now === approved;
  if (now.role === approved.role && now.name === approved.name) return true;
  return now.sheet !== undefined && approved.role === "table" && sheetKey(approved.name) === now.sheet;
};
/** A spreadsheet's cell (the sidecar read it from the sheet's grid): that it is one, and its sheet; {} for anything else. */
export const cellOf = (n: Pick<AxNode, "grid" | "parent">, parentOf: (id: number) => AxNode | undefined): Pick<Focus, "grid" | "sheet"> => {
  if (n.grid === undefined) return {};
  const sheet = n.grid && n.parent !== null ? parentOf(n.parent) : undefined;
  return { grid: n.grid, ...(sheet ? { sheet: sheetKey(sheet.name) } : {}) };
};

/** How much of what a task typed into a field (or a window's fields) is kept (its end), and for how many fields. */
const TYPED_MAX = 500;
const TYPED_FIELDS = 32;
/** What Ember selected with the keys in a window: everything (Ctrl+A), some of it (Shift with a key that moves), or nothing it knows of. */
type Selected = "all" | "some" | null;
/**
 * Keys that only move the caret or the cell cursor (arrows, Home, End, Page Up and Down; Ctrl moves further on Linux
 * and Windows, Option by word and ⌘ to the line's or document's end on macOS), and with Shift select as they go
 * (Shift+Right, Ctrl+Shift+End; ⇧⌘→): `selects` and `moves`, as keyFamily spells them on each OS.
 */
const MOVE_KEYS: Readonly<Record<OS, { selects: RegExp; moves: RegExp }>> = (() => {
  const linux = { selects: /^(ctrl\+)?shift\+(up|down|left|right|home|end|prior|next)$/, moves: /^(ctrl\+)?(shift\+)?(up|down|left|right|home|end|prior|next)$/ };
  const darwin = {
    selects: /^(alt\+)?shift\+(up|down|left|right|home|end|prior|next)$|^shift\+cmd\+(up|down|left|right|home|end|prior|next)$/,
    moves: /^(alt\+)?(shift\+)?(up|down|left|right|home|end|prior|next)$|^(shift\+)?cmd\+(up|down|left|right|home|end|prior|next)$/,
  };
  return { linux, win32: linux, darwin };
})();
/**
 * After `keys` went into a field where this task had typed `typed`: what it has typed there now, and what is still
 * selected by the keys (until a key replaces it or moves the caret; Ctrl+C keeps it, and so do steps that move no
 * caret: a click on a toolbar button, a scroll). Moving the caret (arrows, Home, End), symbols and shortcuts keep what
 * was typed: pieces typed around a move are still judged together, and the field's own text with them (only another
 * field starts again).
 */
export function afterKeys(keys: string, typed: string, selected: Selected, kc: KeyConventions = KEYS.linux): { typed: string; selected: Selected } {
  const k = keyFamily(canonicalKeys(keys, kc) ?? "");
  const char = typedChar(keys, kc);
  if (k === canonicalKeys(kc.edit.selectAll, kc)) return { typed, selected: "all" };
  if (MOVE_KEYS[kc.os].selects.test(k)) return { typed, selected: selected === "all" ? "all" : "some" };
  const replaced = !!selected && replacesSelection(keys, kc);
  // Everything selected and replaced: what was typed there is gone. Part of it: which part is unknown, so it stays.
  const kept = replaced && selected === "all" ? "" : typed;
  const still = !replaced && !MOVES_CARET.test(k) ? selected : null;
  if (char !== null) return { typed: (kept + char).slice(-TYPED_MAX), selected: null };
  if (k === "backspace") return { typed: replaced ? kept : kept.slice(0, -1), selected: null };
  return { typed: kept, selected: still };
}
/** Text fields where those keys only move the caret, and where Tab only moves on (one-line fields; a cell, as below). */
const MOVES_IN = new Set(["text", "entry", "paragraph", "document text"]);
/**
 * Does `keys` only move, in what has the keyboard (`focus`)? Never in lists, menus, sliders, spin buttons or combo boxes
 * (an arrow there picks). What a key that moves (MOVE_KEYS, Shift selecting as it goes) then does to the selection is
 * judged when it comes (afterSelecting).
 */
function onlyMoves(keys: string, focus: Focus | undefined, kc: KeyConventions): boolean {
  if (!focus || focus.secret) return false;
  const k = keyFamily(canonicalKeys(keys, kc) ?? "");
  const cell = isSheetCell(focus);
  if (/^(shift\+)?tab$/.test(k)) return cell || focus.role === "entry";
  return MOVE_KEYS[kc.os].moves.test(k) && (cell || MOVES_IN.has(focus.role));
}
/** Roles whose text the screen reader reads (an empty one it leaves out: it holds ""), and the selection in it when it has the keyboard. */
const READ_TEXT_ROLES = new Set(["text", "entry", "paragraph", "document text", "spin button"]);
/** A document's blocks whose "selected" state says text in them is selected (Writer marks those Edit ▸ Select All took in). */
const TEXT_BLOCKS = new Set(["paragraph", "heading", "block quote"]);
/** Where a document's text may be selected: these, editable (a "text" only with several lines; a one-line one is a field). */
const DOCUMENT_ROLES = new Set(["document text", "document web", "document frame", "paragraph", "section", "static", "heading", "block quote", "text"]);
const editableDocument = (n: AxNode) => n.states.includes("editable") && DOCUMENT_ROLES.has(n.role) && (n.role !== "text" || n.states.includes("multi line"));
/** What a window says has the keyboard while it comes to the front (LibreOffice: its root pane, then the paragraph): not yet known. */
const unsureFocus = (f: Focus | undefined) => !f || /^(root pane|frame|window)$/.test(f.role);
/** How long the keyboard focus gets to settle before Ember takes what it sees (LibreOffice moves it about as its window comes to the front). */
const FOCUS_SETTLE_MS = 500;
/** And at least this many looks (a busy LibreOffice takes a second or more for each). */
const FOCUS_LOOKS = 3;
/**
 * "Select All" on a menu item or a button, in the languages of the policy's word lists (and GTK's, LibreOffice's and
 * the browsers' own words): it selects everything, as Ctrl+A does.
 */
const SELECT_ALL = new RegExp(`^\\s*(${foldLabel(["select all", "select everything", "tout sélectionner", "sélectionner tout", "alles auswählen",
  "alles markieren", "seleccionar todo", "seleziona tutto", "selecionar tudo", "selecionar todos", "alles selecteren", "zaznacz wszystko",
  "выделить всё", "выбрать всё", "markera allt", "välj alla", "vælg alt", "marker alt", "merk alt", "velg alt", "valitse kaikki", "vybrat vše",
  "označit vše", "tümünü seç", "すべて選択", "すべてを選択", "全选", "全部选择", "全選", "모두 선택", "전체 선택"].join("|"))})\\s*([(（][^)）]*[)）])?\\s*$`, "u");
/** Does clicking this select everything in its window? */
const selectsAll = (el: Focus) => /^(menu item|push button|button|toggle button|link)$/.test(el.role) && SELECT_ALL.test(foldLabel(el.name));
/** What a key types in a formula, symbols too ("parenleft" types "("): null for a key that types nothing. */
const KEY_TEXT: Record<string, string> = { equal: "=", plus: "+", minus: "-", at: "@", parenleft: "(", parenright: ")", quotedbl: "\"", apostrophe: "'",
  colon: ":", slash: "/", backslash: "\\", period: ".", comma: ",", semicolon: ";", numbersign: "#", dollar: "$", ampersand: "&", bracketleft: "[",
  bracketright: "]", underscore: "_", asterisk: "*", percent: "%", question: "?", exclam: "!", less: "<", greater: ">", asciicircum: "^",
  asciitilde: "~", grave: "`", bar: "|", braceleft: "{", braceright: "}" };
function keyText(keys: string, kc: KeyConventions): string | null {
  const c = typedChar(keys, kc);
  if (c !== null) return c;
  const m = /^(shift\+)?(\w+)$/.exec(keyFamily(canonicalKeys(keys, kc) ?? ""));
  return m ? KEY_TEXT[m[2]] ?? null : null;
}
/**
 * Is `n` where text goes into a spreadsheet's cell: a sheet's cell, what edits one (LibreOffice's "Cell B4" paragraph,
 * inside the spreadsheet document), or Calc's input line? A formula typed there runs as it goes in.
 */
function intoSheet(n: AxNode | undefined, byId: (id: number) => AxNode | undefined): boolean {
  for (let i = 0; n && i < 8; i++) {
    if (n.role === "document spreadsheet" || takesFormula(n)) return true;
    n = n.parent !== null ? byId(n.parent) : undefined;
  }
  return false;
}
/** Is `n` in a web page (inside a "document web": Chromium's, Firefox's, an Electron app's), where Enter in a field can send? */
/** A dialog as the policy reads it (ActionRequest.dialog): its title, its words, and whether it is a message box or a page's own. */
type Dialog = { name: string; text: string; alert?: boolean };
const DIALOG_ROLE = /^(dialog|alert|file chooser|color chooser|font chooser)$/;
/** The dialog `start` sits in (see Worker.dialogOf), looked up through `get` among `all` the nodes read. */
function dialogAround(start: AxNode | undefined, get: (id: number) => AxNode | undefined, all: Iterable<AxNode>): Dialog | undefined {
  let cur = start;
  for (let i = 0; cur && i < 40; i++) {
    if (DIALOG_ROLE.test(cur.role)) {
      const top = cur.id;
      const inside = (n: AxNode) => { let p = n.parent; for (let j = 0; p !== null && j < 40; j++) { if (p === top) return true; p = get(p)?.parent ?? null; } return false; };
      const words = [...all].filter(n => inside(n) && /label|static|heading|paragraph|text/.test(n.role) && !n.secret)
        .map(n => n.name || n.text || "").filter(Boolean).join(" ");
      const alert = cur.role === "alert" || inWebPage(cur, get);
      return { name: cur.name, text: words.slice(0, 400), ...(alert ? { alert } : {}) };
    }
    cur = cur.parent !== null ? get(cur.parent) : undefined;
  }
  return undefined;
}

function inWebPage(n: AxNode | undefined, byId: (id: number) => AxNode | undefined): boolean {
  for (let i = 0; n && i < 80; i++) {
    n = n.parent !== null ? byId(n.parent) : undefined;
    if (n?.role === "document web") return true;
  }
  return false;
}
/** Controls a click or Enter works, whose name says what they do. */
const WORKED_CONTROL = /^(push button|push button menu|button|split button|toggle button|link|menu item|check box|radio button|switch)$/;
/**
 * Was the name of `n` (called `name`, its label's if it has none) withheld because it may say what a secret field holds
 * (P10-1)? The reader says so; or it is a nameless control in a web page where the reader withheld names (`nodes`, those
 * of that window), which may be one whose name it withheld unmarked. Such a control is asked about whatever it does.
 */
function nameWithheld(n: AxNode, name: string, nodes: Iterable<AxNode>, byId: (id: number) => AxNode | undefined): boolean {
  if (n.withheld) return true;
  if (name || !WORKED_CONTROL.test(n.role) || !inWebPage(n, byId)) return false;
  for (const m of nodes) if (m.withheld) return true;
  return false;
}
/** A spreadsheet cell's address as a model may give it ("B5", "$B$5", "b5"). */
const CELL_ARG = /^\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6}$/;
/** The most arrow keys Ember presses to reach a cell (from the cell with the keyboard, or from A1); a cell further off is reached through the Name Box. */
const CELL_STEPS_MAX = 300;
/**
 * The most cells fill_cells fills in one go (one question, one borrow): as many as its question shows in full in
 * Ember's bubble and card on a 1024x600 screen (and reads aloud in well under a minute).
 */
const FILL_CELLS_MAX = 8;
/** How many more times a cell that still shows what it held after Enter is read, CELL_SETTLE_MS apart (Calc commits an entry in its own time). */
const CELL_SETTLE_LOOKS = 3;
const CELL_SETTLE_MS = 150;
/**
 * A spreadsheet cell to fill (typeInCell, fillCells): its address and place, its whole new content, what Ember expects
 * it holds (as the latest read listed it, or as found before; undefined: unknown), and the latest read's node for it.
 */
interface CellJob { cell: string; place: { col: number; row: number }; text: string; expected: string | undefined; seenKey: string; listed: AxNode | undefined }
/** Text for a question to the user, quoted (cut short past `max` characters, line breaks and tabs shown as spaces). */
const curly = (s: string, max: number) => { const t = s.replace(/\s+/g, " "); return `“${t.length > max ? t.slice(0, max - 1) + "…" : t}”`; };
/** Why `text` can't go into a cell with the keyboard (null: it can). */
function cellTextProblem(text: string): string | null {
  if (/[\n\r\t]/.test(text)) return "A cell takes one line: a line break or tab would move to another cell. Put each value in its own cell.";
  if (!typeableText(text)) return "Ember fills a cell with the keyboard, and can only type plain ASCII letters, digits and punctuation there. Tell the user in finish_task.";
  return null;
}
/** A cell's column (from 0) and row (from 1), by its address ("B5" → 1, 5). */
function cellPlace(address: string): { col: number; row: number } | null {
  const m = /^\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6})$/.exec(address.toUpperCase());
  return m ? { col: [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1, row: Number(m[2]) } : null;
}
/** A column's letters, by its number from 0 (0 → "A", 1023 → "AMJ"). */
const columnName = (col: number): string => (col >= 26 ? columnName(Math.floor(col / 26) - 1) : "") + String.fromCharCode(65 + (col % 26));
/** A sheet's size where it doesn't say: LibreOffice 6.4's (RHEL 8.4), to column AMJ and row 1048576; later ones have more columns. */
const SHEET_SIZE = { rows: 1_048_576, columns: 1024 };
/** Text without its spacing. */
const squashed = (s: string) => s.replace(/\s+/g, "");
/** A plain number as typed ("1,200.50", "-3", "1e3"), else NaN. */
const plainNumber = (s: string) => (/^\s*[-+]?(\d[\d,]*\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i.test(s) ? Number(s.replace(/[,\s]/g, "")) : NaN);
/** A date's day number as a spreadsheet keeps it (days since 1899-12-30), NaN for no such day. */
function dayNumber(y: number, m: number, d: number): number {
  const year = y < 100 ? y + (y < 30 ? 2000 : 1900) : y;
  const t = Date.UTC(year, m - 1, d);
  const at = new Date(t);
  return at.getUTCMonth() === m - 1 && at.getUTCDate() === d ? t / 86_400_000 + 25_569 : NaN;
}
/**
 * The numbers a spreadsheet may take `s` as, typed or shown (none for text): a plain number ("1,200.50"), an amount of
 * money ("$1,200.00"), a percentage ("5%": 0.05), a date ("2026-03-05", or "3/5/2026" either way round: its day number).
 */
export function sheetNumbers(s: string): number[] {
  const t = s.trim();
  const date = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})$/.exec(t);
  if (date) {
    const [a, b, c] = date.slice(1).map(Number);
    return (date[1].length === 4 ? [dayNumber(a, b, c)] : [dayNumber(c, a, b), dayNumber(c, b, a)]).filter(Number.isFinite);
  }
  // Spacing (\s takes in the no-break spaces Calc puts in amounts) and currency signs aside.
  const bare = t.replace(/[$€£¥\s]/g, "");
  const percent = bare.endsWith("%");
  const n = plainNumber(percent ? bare.slice(0, -1) : bare);
  return Number.isFinite(n) ? [percent ? n / 100 : n] : [];
}
/**
 * Does a cell that shows `shows` (and whose number is `value`, where the app tells it) hold what typing `typed` puts
 * there: the same text (spacing aside), or the same number however it is shown ("1200" in a cell showing "$1,200.00",
 * "0.05" in one showing "5%", "3/5/2026" in one showing "2026-03-05")? A text's number is 0: one only counts where it
 * shows no number of its own.
 */
export function sameCellValue(typed: string, shows: string, value?: number): boolean {
  if (squashed(shows) === squashed(typed)) return true;
  const want = sheetNumbers(typed);
  const shown = sheetNumbers(shows);
  const has = shown.length ? shown : value !== undefined && Number.isFinite(value) && value !== 0 && shows.trim() ? [value] : [];
  const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  return want.some(w => has.some(h => near(w, h)));
}
/**
 * Is a cell's formula as the app tells it (`formula`: LibreOffice's, without the "="; cut short at its first ":", which
 * it escapes, as "SUM(B2\") the formula `typed`, case and spacing aside?
 */
export function formulaIn(typed: string, formula: string | undefined): boolean {
  if (formula === undefined || !/^\s*=/.test(typed)) return false;
  const norm = (s: string) => s.replace(/\s+/g, "").toUpperCase();
  const want = norm(typed.replace(/^\s*=/, ""));
  const told = norm(formula);
  if (!told) return false;
  return told.endsWith("\\") ? told.length > 1 && want.startsWith(told.slice(0, -1)) : told.replace(/\\(.)/g, "$1") === want;
}
/**
 * Did a spreadsheet cell take what was typed into it (`typed`, "" to clear it), by what it held before (`before`) and
 * shows now (`shows`)? It shows something new (Calc shows a number or a date its own way, "3.10" as "3.1", and a
 * formula as what it works out to), or what it held where that is what was typed: the same text or number (see
 * sameCellValue, `cell.value` its number), or a formula the cell now has (`cell.formula`, see formulaIn), whose result
 * may be what was there or an error, which Calc shows as no text.
 */
export function cellTook(typed: string, before: string, shows: string, cell: { value?: number; formula?: string } = {}): boolean {
  if (squashed(shows) !== squashed(before)) return true;
  return sameCellValue(typed, shows, cell.value) || formulaIn(typed, cell.formula);
}
/**
 * Is a cell read back after Enter (see cellTook) done changing: it took what was typed, it shows text where text was
 * typed, and a formula's cell no longer shows what it held? Calc may show no text for a moment after Enter, and tells a
 * new formula a moment before it shows what it works out to (an empty cell shows "" until then), so those are read
 * again too; a formula whose result is what was there (or an error, shown as no text) still shows it once the looks
 * run out.
 */
export function cellSettled(typed: string, before: string, cell: { text: string; value?: number; formula?: string }): boolean {
  if (!cellTook(typed, before, cell.text, cell)) return false;
  if (squashed(typed) && !squashed(cell.text)) return false;
  return !/^\s*=/.test(typed) || squashed(cell.text) !== squashed(before);
}
/** How much text is kept for each window a task reads: enough to recognise it when it is typed somewhere else. */
const READ_TEXT_MAX = 20_000;

/** The chosen option among `options`: the exact name, else the one name equal to it but for case and spacing (never a part of a name). */
export function pickOption(options: string[], want: string): string | null {
  const w = want.trim();
  if (options.includes(w)) return w;
  const loose = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const same = [...new Set(options.filter(o => loose(o) === loose(w)))];
  return same.length === 1 ? same[0] : null;
}

/** One borrow per desk: every task's desk input waits its turn there (a desk has one keyboard and pointer). */
const deskBorrows = new WeakMap<DeskPlace, CursorBorrow>();
const deskBorrowFor = (place: DeskPlace) => {
  let b = deskBorrows.get(place);
  if (!b) { b = new CursorBorrow(place.input); deskBorrows.set(place, b); }
  return b;
};

function describeAfter(a: ElementInfo): string {
  const bits = [`${a.role} ${q(a.name, 80)}`];
  if (a.states.length) bits.push(`(${a.states.join(", ")})`);
  if (a.secret) bits.push("(secret: contents hidden)");
  if (a.open) bits.push("(open)");
  if (a.selected !== undefined) bits.push(`selected=${q(a.selected, 80)}`);
  if (a.value !== undefined) bits.push(`value=${a.value}`);
  if (a.text !== undefined) bits.push(`text=${q(a.text, 300)}`);
  return bits.join(" ");
}

/** What a field holds after type_text when that isn't the text asked for (spacing aside); null when it is, or can't be read. */
function textNotTaken(after: ElementInfo, value: string, mode: TextMode): string | null {
  if (after.secret || after.text === undefined || after.text.length >= TEXT_READ_LIMIT) return null;
  const squash = (s: string) => s.replace(/\s+/g, "");
  const has = squash(after.text), want = squash(value);
  return (mode === "replace" ? has === want : has.includes(want)) ? null : after.text;
}

const isDisabled = (states: string[]) => states.length > 0 && !states.includes("sensitive") && !states.includes("enabled");

export class Worker {
  private session: CopilotSession | null = null;
  private result: WorkerResult | null = null;
  /** Elements from this worker's latest perceive_window, by id. */
  private known = new Map<number, AxNode>();
  /** Labels borrowed by unnamed controls (a switch takes the label beside it). */
  private labels = new Map<number, string>();
  private window: { app: string; name: string; role?: string } = { app: "", name: "" };
  private target: WindowTarget;
  /** Apps the user allowed for this task only ("Allow once"). */
  private allowedApps = new Set<string>();
  /** Where the worker is acting: null for the user's screen, or Ember's desk. */
  private place: DeskPlace | null = null;
  /** True while this worker holds the user's mouse and keyboard. */
  private guideStep = 0;
  private userTookOver = false;
  /** Aborted when the task must stop: the user's Stop, or a limit. Every tool checks it before acting. */
  private halt = new AbortController();
  /** Why the task stopped on its own (a limit); null when the user stopped it. */
  private haltReason: string | null = null;
  private steps = 0;
  /** Something on screen asked for an action the user didn't (an off-task question): every step is confirmed from then on. */
  private tainted = false;
  /** What the user asked for in their own words, with what they added since (steer): what the policy checks risky steps against. */
  private userWords: string;
  /** Ember's questions the user answered with a yes or a choice, with those added since (TaskSpec.agreed). */
  private agreed: Agreement[];
  /** The user said no to a question (or let it go unanswered), and nothing was done after that. */
  private declined = false;
  /** The last authorize() asked the user (the screen may have changed while the question was up). */
  private asked = false;
  /**
   * A menu item the user allowed, whose menu closed when they clicked Allow (the click landed outside it). The yes
   * stands for reopening that menu and clicking the same item again, without a second question.
   */
  private carriedMenuApproval: { app: string; role: string; name: string; until: number } | null = null;
  /** The working window's frame from the latest perceive_window (an element outside it is scrolled away). */
  private frame: Bounds | null = null;
  /** Its scale (HiDPI): at 1, positions the app reports at a point compare with those read. */
  private axScale = 1;
  private clipboard: PasteClipboard | null;
  /** Windows this task has read or listed (by process, path and title), with what it read there: text it types elsewhere is checked against them. */
  private read = new Map<string, ReadSource>();
  /** The window keys went into last (windowKey: by process, and path or else title), and what the keys selected there. */
  private keyed: { window: string; selected: Selected } = { window: "", selected: null };
  /**
   * What this task typed into each field (fieldOf), by type_text or key by key, in order: text typed in pieces is
   * judged as a whole, also where the field's own text can't be read in full.
   */
  private typedIn = new Map<string, string>();
  /** What this task typed into each window's fields (windowKey), in order, another field's on a line of its own; and the field typed into last. */
  private typedWindows = new Map<string, { field: string; text: string }>();
  /** What the focused field held, and what is selected in it, at the latest look for keys (undefined: unknown or secret). */
  private focusText: string | undefined;
  private focusSelection: string | undefined;
  /** At that look: text may be selected beyond what the focused element tells (ActionRequest.selectionBeyond). */
  private focusBeyond: "selected" | "unknown" | undefined;
  /** At that look: the focus is where text goes into a spreadsheet's cell, which holds this so far ("" for a cell not being edited). */
  private focusFormula: string | undefined;
  /** At that look: the focused element takes several lines, and it is in a web page (ActionRequest.multiLine, inPage). */
  private focusMultiLine = false;
  private focusInPage = false;
  /** At that look: the dialog the focused element is in (Enter or Space there answers it, as a click does: dialogOf). */
  private focusDialog: Dialog | undefined;
  /** The latest look for the cell with the keyboard found none because the read was cut short (a busy app): see cellWithKeyboard. */
  private cellLookCut = false;
  /** The user said yes to a key that only moves (onlyMoves) in this window (windowKey): more of those there go without a question. */
  private moving: string | null = null;
  /** What spreadsheet cells the latest read didn't list were found to hold, by window (windowKey) and address: the next question says it. */
  private cellsSeen = new Map<string, string>();

  /** The OS's keys, words, apps, settings and security vocabulary. */
  private readonly sys: WorkerSystem;

  constructor(private d: WorkerDeps, readonly spec: TaskSpec) {
    this.sys = d.system ?? LINUX_WORKER_SYSTEM;
    this.target = { ...spec.target };
    // The user's own words only ("The user then added" would make "user" and "added" asked-for words).
    this.userWords = (spec.userWords ?? spec.goal).replace(STEERED, "\n$1");
    this.agreed = spec.agreed ?? [];
    // What Ember's conversation read on the user's screen before starting this task (its goal may carry it).
    if (spec.screen) this.read.set("described", { app: "", window: "", text: spec.screen.slice(0, READ_TEXT_MAX), described: true });
    this.window = { app: spec.target.app ?? "", name: spec.target.title ?? "" };
    this.clipboard = d.clipboard ? asPasteClipboard(d.clipboard) : null;
  }

  private get perception() { return this.place?.perception ?? this.d.perception; }
  /** How keys are named on this OS, and the ones Ember presses itself (Select All, Paste…). */
  private get kc(): KeyConventions { return this.sys.keys; }
  /** What to suggest where the user's keyboard or mouse would be needed and isn't available: the desk, when there is one. */
  private get deskHint(): string { return this.d.desk ? "Try open_on_desk." : "Tell the user in finish_task."; }
  private get sidecar() { return this.place?.sidecar ?? this.d.sidecar; }
  private get halted() { return this.halt.signal.aborted; }
  /** Ended by finish_task (or run() returning): a tool still in flight (a question, a window wait) then does nothing. */
  private ended = new AbortController();
  /** Aborts when the task stops or ends: questions, window waits and borrows give up on it. */
  private overSignal = AbortSignal.any([this.halt.signal, this.ended.signal]);
  private get isOver() { return this.halted || this.ended.signal.aborted; }
  /** Ember flies to controls on the user's screen; desk work shows in the mini-view instead. No box when there is nothing to point at. */
  private fly(b: Bounds | null): void { if (!this.place) this.d.flyTo(usableBounds(b)); }

  get sessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  /** Moving between the user's screen and the desk: element ids belong to the other screen's reader now. */
  private setPlace(place: DeskPlace | null): void {
    if (place === this.place) return;
    const previous = this.place;
    this.place = place;
    this.known = new Map();
    this.labels = new Map();
    this.window = { app: "", name: "" };
    this.frame = null;
    // Its steps there use the desk's own keyboard and mouse, not the user's.
    this.d.presenter.onDesk = place !== null;
    this.d.onDesk?.(place, previous);
  }

  /** Stops the task now. `reason` is set when a limit stopped it rather than the user. */
  private stopNow(reason: string | null): void {
    if (this.halted) return;
    this.haltReason = reason;
    // Motion stops at once: this task's borrow (and only this task's) lets go through its signal.
    this.halt.abort();
    void this.session?.abort().catch(() => undefined);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK types tool lists as Tool<any>[]
  tools(): Tool<any>[] {
    const all = this.allTools();
    const guide = new Set(["perceive_window", "list_windows", "switch_window", "point_at", "wait_for_click", "report_progress", "finish_task"]);
    return this.spec.mode === "guide" ? all.filter(t => guide.has(t.name)) : all.filter(t => t.name !== "point_at" && t.name !== "wait_for_click");
  }

  /**
   * One tool: arguments are checked against the schema here (the runtime does not
   * enforce it), the step limit is counted, and nothing runs once the task is stopped or finished.
   * Tools run one at a time, in the order called (the runtime may call several at once): two actions
   * or questions of one task never overlap.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK types tool lists as Tool<any>[]
  private tool<S extends z.ZodType>(name: string, description: string, parameters: S, handler: (a: z.infer<S>) => Promise<ToolResultObject | string>): Tool<any> {
    const maxSteps = this.d.limits?.maxSteps ?? 150;
    return defineTool(name, {
      description, parameters, skipPermission: true, defer: "never",
      handler: (raw: unknown) => {
        const run = this.toolTurn.then(() => this.runTool(name, parameters, handler, raw, maxSteps));
        this.toolTurn = run.catch(() => undefined);
        return run;
      },
    });
  }

  /** The tool call in progress (or queued last): the next one waits for it. */
  private toolTurn: Promise<unknown> = Promise.resolve();
  /** The turn ended without finish_task and only its summary is asked for now. */
  private wrappingUp = false;

  private async runTool<S extends z.ZodType>(name: string, parameters: S, handler: (a: z.infer<S>) => Promise<ToolResultObject | string>, raw: unknown, maxSteps: number): Promise<ToolResultObject | string> {
    if (this.halted) return STOPPED();
    if (this.result) return denied("The task is already finished. Stop now.");
    // Asked for its summary (its turn ended without one): nothing more is done in the user's apps.
    if (this.wrappingUp && name !== "finish_task" && name !== "report_progress") return denied("The task is over: call finish_task now with what you already did. Do nothing else.");
    if (++this.steps > maxSteps) {
      this.stopNow(`I stopped after ${maxSteps} steps without finishing, to be safe.`);
      return STOPPED();
    }
    const parsed = parameters.safeParse(raw ?? {});
    if (!parsed.success) {
      return fail(`Invalid arguments for ${name}: ${parsed.error.issues.map(i => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ")}`);
    }
    return handler(parsed.data);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK types tool lists as Tool<any>[]
  private allTools(): Tool<any>[] {
    const id = z.number().int().describe("Element id from your latest perceive_window");
    const words = this.sys.words;
    const settings = this.sys.settings.available;
    const settingNames = Object.keys(settings) as SettingName[];
    return [
      this.tool("perceive_window",
        "Read the window you are working in: its elements with ids, roles, names, states and positions." + (this.d.vision ? " Pass image=true to also get a screenshot with numbered marks." : ""),
        z.object({ image: z.boolean().optional().describe("Also return a marked screenshot") }),
        async ({ image }) => this.perceive(image === true && this.d.vision)),
      this.tool("list_windows", "List the open windows (app and title).", z.object({}), async () => {
        // Ember's own windows aren't for tasks.
        const wins = (await this.perception.windows()).filter(w => !isEmberWindow(w));
        // Their titles reach the model (an email's subject, a file's name): text typed elsewhere may carry them.
        for (const w of wins) this.remember(w, [w.name], true);
        // A busy app's window is listed as last seen: it is still there, so the model waits instead of giving up on it.
        const lines = wins.map(w => `- ${q(w.app, 60)}: ${q(w.name, 100)}${w.active ? " (focused by the user)" : ""}${w.busy ? " (busy, not answering)" : ""}`);
        return done(lines.length ? `<windows untrusted="true">\n${lines.join("\n")}\n</windows>` : "No windows found.");
      }),
      this.tool("switch_window", "Work in another open window from now on (does not raise it or take focus from the user).",
        z.object({ title: z.string().min(1).max(200).describe("Part of the window title, from list_windows") }),
        async ({ title }) => this.perceive(false, title)),
      this.tool("click", "Click (activate) a button, menu item, link or similar element.", z.object({ id }),
        async a => this.act("click", a.id, undefined, () => this.sidecar.doAction(a.id, "click"))),
      this.tool("toggle", "Turn a switch, check box or toggle button on or off.",
        z.object({ id, on: z.boolean().describe("true to turn it on, false to turn it off") }),
        async a => {
          const node = this.known.get(a.id);
          if (node) {
            const now = await this.sidecar.readElement(a.id).catch(() => null);
            if (this.isOver) return STOPPED();
            const on = now ? isOn(now.states) : null;
            if (on === a.on) return done(`Already ${a.on ? "on" : "off"}: ${describeAfter(now!)}`);
            // Its action would do nothing (Chromium's "uncheck" on a radio button): a radio button goes off when another goes on.
            if (on && /^radio/.test(now!.role)) return fail("A radio button turns off only when another one in its group is chosen: toggle that one on instead.");
          }
          return this.act("toggle", a.id, a.on ? "on" : "off", () => this.sidecar.doAction(a.id, "toggle"));
        }),
      this.tool("type_text",
        "Put text into a text field or document. mode: \"replace\" replaces everything in it, \"insert\" types at the caret, \"append\" adds at the end. " +
        "In a spreadsheet, give cell (its address, like \"B5\") instead of id to fill that cell, also an empty one that perceive_window doesn't list (mode \"replace\": the cell's whole new content).",
        z.object({
          id: id.optional(),
          cell: z.string().regex(CELL_ARG, "a cell address like B5").optional().describe("A spreadsheet cell's address (instead of id)"),
          text: z.string().max(5000), mode: z.enum(["replace", "insert", "append"]).describe("replace, insert or append"),
        }),
        async a => {
          if (a.cell !== undefined) return this.typeInCell(a.cell, a.text, a.mode);
          if (a.id === undefined) return fail("type_text needs the id of the field (or, in a spreadsheet, the cell's address as cell).");
          const target = a.id;
          return this.act("text", target, a.text, () => this.sidecar.setText(target, a.text, a.mode), a.mode);
        }),
      this.tool("fill_cells",
        `Fill several cells of the spreadsheet in your latest perceive_window at once, with one question to the user: each cell's address (like "B5") and its whole new content (text, a number or a formula; "" empties it). Prefer this to type_text whenever more than one cell is to be filled: at most ${FILL_CELLS_MAX} in one call (the user sees each one in the question); for more, call it again with the next ones. The cells are filled in the order given; it stops at the first that can't be filled and says which were.`,
        z.object({
          cells: z.array(z.object({
            cell: z.string().regex(CELL_ARG, "a cell address like B5").describe("The cell's address"),
            text: z.string().max(5000).describe("Its whole new content"),
          })).min(1).max(FILL_CELLS_MAX),
        }),
        async a => this.fillCells(a.cells)),
      this.tool("choose_option", "Choose an option in a combo box, drop-down or list by its full visible name.",
        z.object({ id, option: z.string().min(1).max(200) }),
        async a => this.chooseOption(a.id, a.option)),
      this.tool("set_value", "Set a slider or spin button to a number.", z.object({ id, value: z.number().finite() }),
        async a => this.act("value", a.id, String(a.value), () => this.sidecar.setValue(a.id, a.value))),
      // Only the settings this OS really changes and reads back; none, no tool (z.enum can't be empty).
      ...(settingNames.length ? [this.tool("change_setting", `Change a desktop setting directly: ${settingNames.map(k => `${k} (${settings[k]})`).join("; ")}.`,
        z.object({
          setting: z.enum(settingNames as [SettingName, ...SettingName[]]),
          value: z.string().max(20).describe('"on"/"off", or a number for text_size'),
        }),
        async a => this.system("setting", `${settings[a.setting]} → ${a.value}`, async () => {
          const r = await this.sys.settings.change(a.setting, a.value);
          return `${settings[a.setting]}: was ${r.before}, now ${r.after}.`;
        }))] : []),
      ...(this.d.desk ? [this.tool("open_on_desk",
        "Open an app on Ember's desk: a private screen the user doesn't see, where you can use mouse and keyboard freely without disturbing them (they can watch in a small view). Good for longer jobs and for apps that need typing or shortcuts. Save files the user should get into the folder this tool names.",
        z.object({ name: z.string().min(1).max(100) }),
        async a => {
          const app = findApp(listApps(), a.name);
          if (!app) return fail(`No installed app matches ${q(a.name, 100)}.`);
          if (isTerminalApp(app)) return this.refuse("open_app", "Ember doesn't run terminals", "Not allowed: Ember doesn't run terminals or shells. Don't try another way; tell the user in finish_task.", { app: app.name, value: app.name });
          return this.system("open_app", `${app.name} (on Ember's desk)`, async () => {
            const place = await this.d.desk!();
            // Stopped while the desk started: nothing is opened (and the desk view isn't shown for a task that is gone).
            if (this.isOver) throw new BorrowStopped();
            // The user is working on the desk: nothing is opened under their hands.
            if (place.userInControl()) throw new UserTookOver(0);
            this.setPlace(place);
            // The app's window is the one from the process just started, or else whichever window is new.
            const key = (w: { pid: number | null; name: string }) => `${w.pid}:${w.name}`;
            const before = new Set((await place.perception.windows().catch(() => [])).map(key));
            const pid = place.open(app);
            for (let i = 0; i < 60 && !this.isOver; i++) {
              await new Promise(r => setTimeout(r, 250));
              const wins = await place.perception.windows().catch(() => []);
              // LibreOffice shows a window with no name while it starts: the one with a name is its document's (one
              // with none is taken only after a few seconds).
              const named = (x: { name: string }) => !!x.name.trim() || i >= 20;
              const w = wins.find(x => pid !== undefined && x.pid === pid && named(x)) ?? wins.find(x => !before.has(key(x)) && named(x));
              if (w) { this.target = { title: w.name, pid: w.pid ?? undefined }; this.window = { app: w.app, name: w.name }; return `Opened ${app.name} on your desk (window ${q(w.name, 100)}). Everything you do now happens there. Save results in ${place.info.handOff}. Call perceive_window.`; }
            }
            return `Started ${app.name} on your desk, but its window hasn't appeared yet. Use list_windows.`;
          }, app.name);
        })] : []),
      this.tool("open_app", `Start an application by name (for example ${words.openAppExamples}).`, z.object({ name: z.string().min(1).max(100) }),
        async a => {
          const apps = this.sys.apps;
          const app = apps.find(apps.list(), a.name);
          if (!app) return fail(`No installed app matches ${q(a.name, 100)}.`);
          if (apps.isTerminalApp(app)) return this.refuse("open_app", "Ember doesn't run terminals", "Not allowed: Ember doesn't run terminals or shells. Don't try another way; tell the user in finish_task.", { app: app.name, value: app.name });
          return this.system("open_app", app.name, async () => {
            if (this.isOver) throw new BorrowStopped();
            this.setPlace(null);
            // The app's window is a new one of its program (or titled after it); an app that was already open
            // (it only raises its window) is found by its program, never by a title that happens to contain its name.
            const key = (w: { pid: number | null; name: string }) => `${w.pid}:${w.name}`;
            const before = new Set((await this.perception.windows().catch(() => [])).map(key));
            // Compared as the OS names programs (on Windows without ".exe").
            const programs = apps.programsOf(app);
            const ours = (w: { app: string }) => programs.has(apps.appKey(w.app));
            await apps.launch(app);
            for (let i = 0; i < 40 && !this.isOver; i++) {
              await new Promise(r => setTimeout(r, 250));
              const wins = await this.perception.windows().catch(() => []);
              const w = wins.find(x => !before.has(key(x)) && (ours(x) || x.name.toLowerCase().includes(app.name.toLowerCase())))
                ?? (i >= 8 ? wins.find(ours) : undefined);
              if (w) { this.target = { title: w.name, pid: w.pid ?? undefined }; this.window = { app: w.app, name: w.name }; return `Opened ${app.name}; now working in its window ${q(w.name, 100)}. Call perceive_window.`; }
            }
            return `Started ${app.name}, but its window hasn't appeared yet. Use list_windows and switch_window.`;
          }, app.name);
        }),
      ...(this.d.cursor || this.d.desk ? [
        this.tool("press_keys",
          `Press a key or shortcut in the window you are working in, e.g. ${words.keyExamples}. Borrows the user's keyboard, so the user is asked first; prefer element tools when they work.`,
          z.object({ keys: z.string().min(1).max(40) }),
          async a => this.pressKeys(a.keys)),
        this.tool("scroll", "Scroll an element (a list, document or page) up or down by a few steps. Borrows the user's mouse, so the user is asked first.",
          z.object({ id, direction: z.enum(["up", "down", "left", "right"]), steps: z.number().int().min(1).max(30).optional() }),
          async a => this.scroll(a.id, a.direction, a.steps ?? 5)),
      ] : []),
      this.tool("point_at", "Point at an element so the user can do this step themselves: Ember flies next to it, highlights it and shows your short instruction. Name the words on the control, never its role (not \"the table cell\").",
        z.object({ id, say: z.string().min(1).max(160).describe("A short instruction naming the control, e.g. \"Click Display\" or \"Press Enter on Monospace Bold\"") }),
        async a => {
          const node = this.known.get(a.id);
          if (!node?.bounds) return fail(`Element ${a.id} is not in your latest perceive_window (or has no position). Call perceive_window.`);
          // Where it is now (LibreOffice reports places 25 px off until the pointer has been over its window).
          const live = await this.sidecar.readElement(a.id).catch(() => null);
          if (this.isOver) return STOPPED();
          this.guideStep++;
          // The live read of this id can be another row after the list scrolled: only highlight the named control.
          this.fly(this.targetBox(a.id, node, live));
          const name = this.nameOf(a.id, node);
          this.d.presenter.guide(guideSay(a.say, { role: node.role, name }), `Step ${this.guideStep}`);
          this.audit({ event: "action", task: this.spec.id, kind: "point", app: this.window.app, element: { role: node.role, name }, ok: true });
          return done(`Pointing at [${a.id}]. Now call wait_for_click with id ${a.id}.`);
        }),
      this.tool("wait_for_click", "Wait until the user clicks the element you pointed at (or it changes, e.g. a switch turns on, or the window changes).",
        z.object({ id, timeoutSeconds: z.number().int().min(5).max(300).optional() }),
        async a => this.waitForClick(a.id, (a.timeoutSeconds ?? 90) * 1000)),
      this.tool("report_progress", "Tell the user briefly how the task is going (shown on Ember's task card).", z.object({ text: z.string().max(200) }),
        async a => { this.d.onProgress(a.text); this.d.presenter.progress(a.text); return done("Shown."); }),
      this.tool("finish_task", "End the task with a one or two sentence summary for the user. If they cancelled or closed a dialog without doing the step, success is false.",
        z.object({ success: z.boolean(), summary: z.string().max(400) }),
        async a => {
          // A cancelled guide step never gets here: it already ended the task (left() in waitForClick).
          this.result = { success: a.success, summary: a.summary };
          this.ended.abort();
          this.fly(null);
          // The task is over: end the turn, so a model that keeps going can't act any more.
          setTimeout(() => { void this.session?.abort().catch(() => undefined); }, 50);
          return done(a.success ? "Task closed. Stop now." : "Task closed (they didn't finish). Stop now.");
        }),
    ];
  }

  /** What the user stopping says: a guide has no actions of its own, so stopping it cancelled the guide. */
  private stoppedSummary(): string {
    return this.spec.mode === "guide" ? "The guide was cancelled." : "Stopped.";
  }

  async run(signal: AbortSignal): Promise<WorkerResult> {
    const d = this.d;
    // Stopped before it began (Stop pressed right after asking): nothing is created or sent.
    if (signal.aborted) return { success: false, summary: this.stoppedSummary(), stopped: true };
    // The runtime's default model only where the host allows it: it may be one the administrator didn't allow.
    if (!d.model && !d.runtimeDefault) return { success: false, summary: `No model is available for tasks. Pick one in settings (${this.sys.shortcuts.settings.label}).` };
    const onAbort = () => this.stopNow(null);
    signal.addEventListener("abort", onAbort, { once: true });
    const maxMs = d.limits?.maxMs ?? 20 * 60_000;
    const deadline = setTimeout(() => this.stopNow(`I stopped because the task took longer than ${Math.round(maxMs / 60_000)} minutes.`), maxMs);
    deadline.unref?.();
    let lastAnswer = "";
    try {
      fs.mkdirSync(d.workDir, { recursive: true });
      const tools = this.tools();
      const config = hardenedSessionConfig({
        sessionId: `ember-task-${this.spec.id}`,
        model: d.model ?? undefined,
        provider: d.provider,
        tools,
        systemMessage: this.spec.mode === "guide" ? guideSystemMessage({ words: this.sys.words })
          : workerSystemMessage({ words: this.sys.words, settings: this.sys.settings.available, desk: !!d.desk }),
        workingDirectory: d.workDir,
        onPermissionRequest: () => ({ kind: "reject", feedback: "Workers use only Ember's own tools." }),
      });
      this.session = await d.client.createSession(config);
      await verifySessionTools(this.session, tools.map(t => t.name));
      const session = this.session;
      // A turn ends at idle or error; after Stop it ends at the latest a moment later, even if the runtime is gone.
      const idle = () => new Promise<void>((resolve, reject) => {
        let grace: ReturnType<typeof setTimeout> | null = null;
        const settle = (fn: () => void) => { off(); if (grace) clearTimeout(grace); this.halt.signal.removeEventListener("abort", onHalt); fn(); };
        const off = session.on(e => {
          if (e.type === "session.idle") settle(resolve);
          if (e.type === "session.error") settle(() => reject(new Error(String((e.data as { message?: string }).message ?? "session error"))));
        });
        const onHalt = () => { grace = setTimeout(() => settle(resolve), STOP_GRACE_MS); };
        if (this.halted) onHalt(); else this.halt.signal.addEventListener("abort", onHalt, { once: true });
      });
      session.on(e => {
        d.presenter.event(e as { type: string; data?: Record<string, unknown> });
        if (e.type === "assistant.message") lastAnswer = String((e.data as { content?: string }).content ?? lastAnswer);
        if (e.type === "assistant.usage") d.onUsage?.(e.data.inputTokens ?? 0, e.data.outputTokens ?? 0);
        // The task card follows the current step ("Typing…"); the model's own progress notes replace it.
        if (e.type === "tool.execution_start") {
          const name = String((e.data as { toolName?: string }).toolName ?? "");
          const step = stepOf(name, !!this.place);
          if (name !== "report_progress" && name !== "finish_task" && step) { this.doing = `${step}…`; d.onProgress(this.doing); }
        }
      });
      if (!this.halted) {
        d.presenter.taskStarted();
        // Where the user was is screen text (a page can set its own title): it goes in as untrusted data.
        const t = this.spec.target;
        const where = t.title
          ? `\n<context untrusted="true">The user was in the window ${q(t.title, 160)}${t.app ? ` (app ${q(t.app, 60)})` : ""} when they asked; start there unless the goal needs another app.</context>`
          : "";
        // A request the runtime takes but never begins a turn for ends this task, plainly (the user can ask again);
        // a slow model doesn't (its turn has begun). Nor does a turn that hears nothing from Copilot for minutes
        // (a model request that never answers); a long step (a question, a wait for the user's click) isn't quiet.
        // Other tasks and the conversation go on. Out of file watchers, the runtime can't begin a task's turn
        // (the conversation, begun before, may still answer): Ember names them.
        const watch = new TurnWatch(d.limits?.turnStartMs ?? TURN_START_MS, why => {
          d.log.warn(why === "silent" ? "worker.turn_silent" : "worker.turn_not_started");
          let full = false;
          try { full = why === "not-started" && d.inotifyUsedUp?.() === true; } catch { /* can't be counted */ }
          this.stopNow(why === "silent" ? "Copilot didn't answer, so I stopped this task. You can ask me again in a moment."
            : full ? "Copilot can't work right now: this computer has run out of file watchers, so I stopped this task. Close a few apps, then ask me again."
            : "Copilot isn't answering, so I stopped this task. You can ask me again in a moment.");
        }, {
          slowMs: d.limits?.turnSlowMs, silentMs: d.limits?.turnSilentMs,
          // The task's card and its bubble say so (without a compositor the card's task row is one short line).
          onSlow: slow => { if (!this.halted) { d.onProgress(slow ? "Still waiting for Copilot…" : "Working…"); d.presenter.stalled(slow); } },
        });
        const unwatch = session.on(e => watch.event(e));
        const send = async (prompt: string) => {
          watch.sending();
          try { await session.send({ prompt }); } catch (err) { watch.unsent(); throw err; }
          watch.sent();
        };
        try {
          let wait = idle();
          await send(`Task: ${this.spec.goal}${where}`);
          await wait;
          if (!this.result && !this.halted) {
            this.wrappingUp = true;
            wait = idle();
            await send("Call finish_task now with a short summary of what you did. Do nothing else.");
            await wait;
          }
        } finally {
          unwatch();
          watch.dispose();
        }
      }
    } finally {
      this.ended.abort();
      clearTimeout(deadline);
      signal.removeEventListener("abort", onAbort);
      d.flyTo(null);
      if (this.place) d.onDesk?.(null, this.place);
    }
    if (this.halted && this.haltReason === null) return { success: false, summary: this.stoppedSummary(), stopped: true };
    if (this.haltReason) return { success: false, summary: this.result?.summary ? `${this.haltReason} ${this.result.summary}` : this.haltReason };
    // The user said "Not now" and nothing was done after it: that's the user's choice, not a failure.
    if (this.declined && !this.result?.success) return { success: false, stopped: true, declined: true, summary: this.result?.summary || "You said not now, so I left it." };
    const result = this.result ?? { success: false, summary: lastAnswer || "The worker stopped without a summary." };
    return this.userTookOver && !result.success ? { ...result, stopped: true } : result;
  }

  /**
   * The user's new instruction for this running task ("use Firefox instead"); `userWords`: what the user said in that
   * turn; `screen`: what the conversation read on the screen then; `agreed`: Ember's questions they answered (TaskSpec).
   */
  async steer(text: string, userWords?: string, screen?: string, agreed?: Agreement[]): Promise<boolean> {
    if (!this.session || this.halted || this.result) return false;
    if (agreed?.length) this.agreed = [...this.agreed, ...agreed];
    if (screen) {
      const had = this.read.get("described")?.text;
      this.read.set("described", { app: "", window: "", text: (had ? `${screen}\n${had}` : screen).slice(0, READ_TEXT_MAX), described: true });
    }
    const said = text.replace(/</g, "‹");
    // What the user added is part of what they asked for: "and then send it" makes Send asked-for. Their own words
    // when the task has them (the instruction is the conductor's).
    const words = userWords ?? (this.spec.userWords === undefined ? said : "");
    if (words) this.userWords = `${this.userWords}\n${words}`;
    await this.session.send({ prompt: `<user_update>The user changed the task: ${said}</user_update>`, mode: "immediate" });
    return true;
  }

  async dispose(): Promise<void> {
    // A hung runtime isn't waited for.
    if (this.session) await within(this.session.disconnect().catch(() => undefined), 3000);
  }

  /**
   * A row that only a click (or the keyboard) selects: one of a list or table in a window or dialog (a font chooser's
   * list), not of a menu or a drop-down's popup, where the pointer passing over selects it.
   */
  private clickSelects(node: AxNode): boolean {
    if (!ROW_ROLES.test(node.role)) return false;
    for (let p = node.parent, hops = 0; p !== null && hops < 16; hops++) {
      const up = this.known.get(p);
      if (!up) break;
      if (POPUP_ROLES.test(up.role)) return false;
      p = up.parent;
    }
    return true;
  }

  /** The pointed-at control sits in a dialog (a font chooser): closing that dialog is cancelling the step. */
  private inDialog(node: AxNode): boolean {
    if (/dialog|chooser/i.test(this.window.role ?? "")) return true;
    for (let p = node.parent, hops = 0; p !== null && hops < 16; hops++) {
      const up = this.known.get(p);
      if (!up) break;
      if (/^(dialog|alert|alert dialog|file chooser|color chooser|font chooser)$/i.test(up.role)) return true;
      p = up.parent;
    }
    return false;
  }

  /** Guide mode: done when the user presses inside the element, the element changes, or the window does. */
  private async waitForClick(id: number, timeoutMs: number): Promise<ToolResultObject> {
    const node = this.known.get(id);
    if (!node?.bounds) return fail(`Element ${id} is not in your latest perceive_window. Call perceive_window.`);
    const named = this.nameOf(id, node);
    const sameTarget = (e: { role: string; name: string } | null) => !!e && e.role === node.role && this.nameOf(id, e) === named;
    // Where it is, as each look finds it (LibreOffice reports places 25 px off until the pointer has been over its window).
    let b = node.bounds;
    const pad = FOCUS_IS_THE_STEP.test(node.role) ? 12 : 4;
    const inside = (p: { x: number; y: number }, box = b, extra = pad) => p.x >= box.x - extra && p.y >= box.y - extra && p.x < box.x + box.width + extra && p.y < box.y + box.height + extra;
    const before = await this.sidecar.readElement(id).catch(() => null);
    if (sameTarget(before) && before?.bounds) b = usableBounds(before.bounds) ?? b;
    // What counts is the user using it, never only reaching it (a hover selects a menu item, Tab focuses a button): a
    // press inside it; checked, pressed, expanded, a value, an option chosen, a menu opened (also with Alt+F or F10), a
    // tab or row selected, a field focused, the element gone. And once the user reached it (it had the keyboard, or was
    // the selected item): Enter or Space on it, or another window taking the keyboard (a menu item chosen with the
    // keyboard opened its dialog).
    const field = FOCUS_IS_THE_STEP.test(node.role);
    const marks = ["checked", "pressed", "expanded",
      ...((HOVER_SELECTS.test(node.role) && !this.clickSelects(node)) || ACTS_ITSELF.test(node.role) ? [] : ["selected"]), ...(field ? ["focused"] : [])];
    // A menu's item whose menu closed is gone from the screen (GTK keeps it, no longer showing).
    const key = (e: ElementInfo | null) => (e && !e.offscreen ? `${e.states.filter(s => marks.includes(s)).sort().join(",")}|${e.selected ?? ""}|${e.value ?? ""}|${e.open ?? ""}${field ? `|${e.text ?? ""}` : ""}` : "gone");
    const reached = (e: ElementInfo | null) => !!e && (e.states.includes("focused") || e.states.includes("selected"));
    // Reached during this step, by a look after it began: a dialog's default button had the keyboard before, untouched.
    let wasReached = false;
    let reachedNow = before ? reached(before) : null;
    const activeWindow = () => { try { return this.d.cursor?.activeWindow?.() ?? null; } catch { return null; } };
    // Ember's own windows (the ask box the user opens, its settings) are never where they chose something.
    const own = (w: { pid?: number | null } | null) => w?.pid != null && w.pid === process.pid;
    let windowBefore = activeWindow();
    if (own(windowBefore)) windowBefore = null;
    const keyDown = () => { try { return this.d.activationKey?.() === true; } catch { return false; } };
    const opens = ACTS_ITSELF.test(node.role) || /menu item$/.test(node.role);
    // Its dialog closing is the user leaving the step: a row or field in it, or anything there but a button that closes
    // the dialog itself (OK or Save chosen with Enter from a field never had the keyboard, and the dialog is gone).
    const leavesWithDialog = () => field || this.clickSelects(node) || (this.inDialog(node) && !ACTS_ITSELF.test(node.role));
    const usedIt = async (how: string) => {
      await new Promise(r => setTimeout(r, 400)); // let the app react before the next look
      this.audit({ event: "action", task: this.spec.id, kind: "user_clicked", app: this.window.app, element: { role: node.role, name: named }, ok: true });
      return done(`${how} Call perceive_window to see what changed.`);
    };
    const left = (how: string) => {
      // The user cancelled the guide: end it here, calmly, rather than let the model take more steps (its next
      // switch_window showed "Switching windows" for seconds) and report the closed dialog as a failure. Every tool
      // after this is refused, so no finish_task can call the cancelled step a success (that they picked a font).
      if (!this.result) {
        this.result = { success: false, stopped: true, summary: "The guide was cancelled." };
        this.ended.abort();
        setTimeout(() => { void this.session?.abort().catch(() => undefined); }, 50);
      }
      return done(how);
    };
    const t0 = Date.now();
    let wasDown = (this.d.pointer?.()?.mask ?? 0) & 256;
    let keyWasDown = keyDown();
    let lastCheck = 0;
    // The pointer is watched on its own timer: a quick click comes and goes while a look at the app is under way (an
    // app opening a dialog answers slowly), and it still counts.
    let pressed = false;
    const other = { kind: "", name: "" };
    const watchPointer = () => {
      const p = this.d.pointer?.();
      const down = (p?.mask ?? 0) & 256;
      if (p && down && !wasDown) {
        if (inside(p)) pressed = true;
        else {
          // Everything under the press but the window itself (its box is the whole window, its name the title):
          // Cancel or Close if one is there, else the innermost field.
          const hits = [...this.known.values()].filter(n => n.id !== id && n.depth > 0 && n.bounds && inside(p, n.bounds, 4));
          const dismiss = hits.find(n => dismissName(n.name));
          const box = dismiss ? undefined : hits.filter(fieldLike).sort((x, y) => y.depth - x.depth)[0];
          if (dismiss) { other.kind = "dismiss"; other.name = dismiss.name; }
          else if (box) { other.kind = "field"; other.name = box.name; }
        }
      }
      wasDown = down;
    };
    const watcher = setInterval(watchPointer, 15);
    // The highlight is up (point_at put it there): it comes back when the named control does, after a look hid it.
    let shown = true;
    try {
      while (Date.now() - t0 < timeoutMs) {
        if (this.isOver) return STOPPED();
        watchPointer();
        if (pressed) return await usedIt("The user clicked it.");
        if (other.kind === "dismiss") {
          return left(`The user pressed ${q(other.name || "Cancel", 40)}. They cancelled this step. Do not say they finished the goal. Call perceive_window, or finish_task with success false saying they cancelled.`);
        }
        if (other.kind === "field") {
          return done(`The user clicked the search box${other.name ? ` (${q(other.name, 40)})` : ""} instead of the element pointed at. Call perceive_window if searching was the step, and point_at that field.`);
        }
        // Enter or Space, while it has the keyboard (or is the menu item selected).
        const pressing = keyDown();
        if (pressing && !keyWasDown && reached(await this.sidecar.readElement(id).catch(() => null))) return usedIt("The user pressed Enter or Space on it.");
        keyWasDown = pressing;
        if (Date.now() - lastCheck > 500) {
          lastCheck = Date.now();
          let busy = false;
          const now = await this.sidecar.readElement(id).catch((err: unknown) => { busy = isBusy(err); return null; });
          if (pressed) return await usedIt("The user clicked it.");
          // The app didn't answer in time (a font list scrolling): it is busy, not gone, so nothing is known yet.
          if (busy) { lastCheck = Date.now(); continue; }
          if (key(now) !== key(before)) {
            if (now && !now.offscreen) {
              return done(`It changed: ${describeAfter(now)}. Call perceive_window for the next step.`);
            }
            this.fly(null);
            // A dialog's row or a field vanishing is the dialog closing, not the user choosing this row (Cancel).
            if (leavesWithDialog() || dismissName(named)) {
              return left(now
                ? "Its dialog closed without this being used (the user most likely pressed Cancel or closed it). Do not say they finished the goal. Call perceive_window, or finish_task with success false saying they cancelled."
                : "The window closed without this being used (the user most likely pressed Cancel or closed it). Do not say they finished the goal. Call perceive_window, or finish_task with success false saying they cancelled.");
            }
            return done(now ? "Its menu closed (the user chose it, or went elsewhere). Call perceive_window to see where they are." : "The window changed (the element is gone). Call perceive_window.");
          }
          // It moved (a list scrolled, the window was dragged): the highlight goes with the same named row, never another.
          if (sameTarget(now) && now?.bounds) {
            const next = usableBounds(now.bounds);
            if (next) {
              const moved = next.x !== b.x || next.y !== b.y || next.width !== b.width || next.height !== b.height;
              b = next;
              // Moved, or back where it was after a look hid it (the list scrolled back to it).
              if (moved || !shown) { this.fly(b); shown = true; }
            } else {
              // The control's box is gone (dialog closed, 0×0 leftover): never leave an empty orange frame.
              this.fly(null);
              shown = false;
              if (leavesWithDialog()) {
                return left("The control disappeared (the user most likely pressed Cancel or closed the dialog). Do not say they finished the goal. Call perceive_window, or finish_task with success false saying they cancelled.");
              }
              // OK or Save whose dialog closed by itself (Enter from a field): not a cancel, but this step is over.
              if (this.inDialog(node)) return done("The window changed (the element is gone). Call perceive_window.");
            }
          } else if (now && now.role === node.role && !sameTarget(now)) {
            // This id is another row now (the list filtered): don't highlight the wrong one.
            this.fly(null);
            shown = false;
          } else if (!now || now.offscreen || !usableBounds(now.bounds)) {
            this.fly(null);
            shown = false;
          }
          if (now) {
            const r = reached(now);
            if (r && reachedNow === false) wasReached = true;
            reachedNow = r;
          }
          // A titled window other than the one the user was in has the keyboard (an open menu's popup has no title). The
          // step began in Ember's own window: the user's is the first other one seen, while they hadn't reached it yet.
          const active = activeWindow();
          const w = active && !own(active) ? active : null;
          if (w && !windowBefore && !wasReached) windowBefore = w;
          const another = !!w && !!windowBefore && !!w.title.trim() && (w.title !== windowBefore.title || w.app !== windowBefore.app);
          if (another && wasReached) {
            return done(`Another window has the keyboard now (${q(w!.title, 80)}), right after the user reached the element pointed at: they most likely chose it with the keyboard. Call perceive_window to see where they are.`);
          }
          // A new window of the same app took the keyboard after Ember pointed at a menu item or a button that opens
          // things (Select Font… opened its dialog): that step is done, however it was chosen.
          if (another && opens && w!.pid != null && w!.pid === windowBefore!.pid) {
            return done(`A new window of the app has the keyboard now (${q(w!.title, 80)}): the user chose the element pointed at, and it opened. Call perceive_window to see the new window.`);
          }
          // Cancel in a font dialog: AT-SPI may still report the Size field, but the document has the keyboard again.
          if (another && !wasReached && leavesWithDialog()) {
            this.fly(null);
            return left(`The window changed (${q(w!.title, 80)} now has the keyboard). They cancelled or closed this step. Do not say they finished the goal. Call perceive_window, or finish_task with success false saying they cancelled.`);
          }
        }
        await new Promise(r => setTimeout(r, 30));
      }
      return done("The user hasn't clicked it yet. Finish kindly, saying where they got to, unless the goal is already done.");
    } finally {
      clearInterval(watcher);
      // The step is over: no highlight is left on a place that may hold something else now (the dialog it opened).
      this.fly(null);
    }
  }

  /**
   * Where to highlight element `id`: the live box when it is still the same named control, else its last read box.
   * Never a different row that reused the id after a list scrolled, nor another control with the same name (a
   * second "Close Document", or one of several unnamed icon buttons) when the live read fails.
   */
  private targetBox(id: number, node: AxNode, live: ElementInfo | null): Bounds | null {
    if (live && !live.offscreen && live.role === node.role && this.nameOf(id, { role: live.role, name: live.name }) === this.nameOf(id, node)) {
      return usableBounds(live.bounds) ?? usableBounds(node.bounds);
    }
    return usableBounds(node.bounds);
  }

  /** `expectTitle`: switch_window's request; nothing changes unless a window with that title is found. */
  private async perceive(image: boolean, expectTitle?: string): Promise<ToolResultObject> {
    const target = expectTitle ? { title: expectTitle } : this.target;
    const p = await this.perception.perceive({ image, scope: "window", target });
    if (this.isOver) return STOPPED();
    if (p.blocked) {
      this.audit({ event: "decision", task: this.spec.id, kind: "read", app: p.window?.app ?? "", window: p.window?.name ?? p.x11Window?.title ?? "", tier: "never", verdict: "deny", reason: "private window (never-look list or a password prompt)" });
      return denied("This window is private (on the user's never-look list, or a password prompt). Don't use it; finish the task and say so.");
    }
    // A busy app (a file dialog listing a big folder) isn't a closed one: the model is told to try again.
    if (!p.window) return fail(p.busy ? p.text : "That window can't be read (it is closed or exposes no accessibility information). Use list_windows.");
    // Never fall back to whatever the user is looking at: a title that matches nothing is an error.
    if (expectTitle && !p.window.name.toLowerCase().includes(expectTitle.toLowerCase())) {
      return fail(`No open window has ${q(expectTitle, 100)} in its title. Use list_windows and pick one of those titles.`);
    }
    // Ember's own windows (its settings, bubble or desk view): a task could answer its own questions there.
    if (isEmberWindow(p.window)) {
      return this.refuse("read", "Ember's own window", "That is one of Ember's own windows: tasks never use them. Use list_windows and pick another window.", { app: p.window.app });
    }
    this.window = { app: p.window.app, name: p.window.name, role: p.window.role };
    this.remember(p.window, [p.window.name, ...p.nodes.flatMap(n => (n.secret ? [n.name] : [n.name, n.text ?? ""]))]);
    this.frame = p.window.bounds;
    this.axScale = p.axScale ?? 1;
    // The window's own key (process and accessible path): later reads stay on exactly this window.
    this.target = { title: p.window.name, pid: p.window.pid ?? undefined, path: p.window.path };
    this.known = new Map(p.nodes.map(n => [n.id, n]));
    this.labels = inferLabels(p.nodes);
    const result: ToolResultObject = { textResultForLlm: `${p.text}${dialogNote(p.window, p.nodes, this.userWords, this.sys.os)}`, resultType: "success" };
    if (p.capture) result.binaryResultsForLlm = [{ type: "image", mimeType: p.capture.mimeType, data: p.capture.data.toString("base64"), description: "The window with numbered marks matching element ids" }];
    return result;
  }

  /**
   * A window this task has read (or only listed: its title), by process, path and title, with the text read there:
   * the newest first, up to READ_TEXT_MAX. A read is never turned back into a listing.
   */
  private remember(w: { app: string; name: string; pid: number | null; path?: string; role?: string }, lines: string[], listed = false): void {
    const key = `${w.pid}\n${w.path ?? ""}\n${w.name}`;
    const had = this.read.get(key);
    if (listed && had) return;
    const text = [...new Set([...lines, ...(had?.text?.split("\n") ?? [])].filter(Boolean))].join("\n").slice(0, READ_TEXT_MAX);
    this.read.set(key, { app: w.app, window: w.name, pid: w.pid, text, ...(w.path ? { path: w.path } : {}), ...(w.role ? { role: w.role } : {}), ...(listed ? { listed: true } : {}) });
  }

  /** The window acted in, as last read: the policy tells it apart from the windows read before. */
  private get windowId(): WindowId {
    return { pid: this.target.pid, path: this.target.path, role: this.window.role };
  }

  /**
   * The working window by process, and path or else title (keys pressed and text typed there are tracked by it): never
   * by a title that has a path besides, which changes as the window does ("*notes.txt" once it is edited).
   */
  private get windowKey(): string {
    return `${this.target.pid ?? ""}\n${this.target.path || this.window.name}`;
  }

  /** Did the last keys in the working window select everything (Ctrl+A)? Text typed at the caret then replaces it all. */
  private get allSelected(): boolean {
    return this.keyed.selected === "all" && this.keyed.window === this.windowKey;
  }

  /**
   * The dialog an element sits in (its title and text), if any: "OK" or "Yes" there agrees to whatever the
   * dialog says, so the policy reads the dialog, not just the window's title. `alert`: a message box, or a web page's
   * own dialog (whatever its OK agrees to is asked about).
   */
  private dialogOf(id: number): Dialog | undefined {
    return dialogAround(this.known.get(id), p => this.known.get(p), this.known.values());
  }

  /**
   * The element as it is now. The policy decides on what is on screen at the
   * moment of acting, not on a list read minutes ago (a "Next" button can become "Install").
   */
  private async fresh(id: number): Promise<{ node: AxNode; element: Focus } | ToolResultObject> {
    const node = this.known.get(id);
    if (!node) return fail(`Element ${id} is not in your latest perceive_window. Call perceive_window and use its ids.`);
    let busy = false;
    const live = await this.sidecar.readElement(id).catch((err: unknown) => { busy = isBusy(err); return null; });
    if (this.isOver) return STOPPED();
    if (!live) return fail(busy ? BUSY : `Element ${id} is gone (the window changed). Call perceive_window.`);
    if (live.role !== node.role) return fail(`Element ${id} has changed (it is now a ${q(live.role, 40)}). Call perceive_window.`);
    if (isDisabled(live.states)) return fail(`Element ${id} is disabled right now, so it can't be used. Call perceive_window to see why.`);
    // Everything the policy looks at is current, including what a field holds now (replacing it may need the user's OK).
    // A name withheld by the read or now stays withheld (P10-1).
    const current: AxNode = { ...node, name: live.name, states: live.states, bounds: live.bounds ?? node.bounds, text: live.text ?? node.text, secret: live.secret ?? node.secret,
      ...(live.withheld || node.withheld ? { withheld: true } : {}) };
    this.known.set(id, current);
    return { node: current, element: this.elementOf(id, current) };
  }

  /**
   * Where element `id` is when it has no name (an icon, an unnamed button), for the question asked about it: the named
   * control around it (not the window itself), else its place in the window.
   */
  private placeOf(id: number, element: Focus): Pick<ActionRequest, "place"> {
    // (A text area or field is named well enough by what it is: "the text area".)
    if (element.name || element.withheld || TYPING_ROLES.has(element.role)) return {};
    const node = this.known.get(id);
    if (!node) return {};
    for (let p = node.parent, hops = 0; p !== null && hops < 6; hops++) {
      const up = this.known.get(p);
      if (!up) break;
      if (/^(frame|window|dialog|alert|file chooser|application)$/.test(up.role)) break;
      if (up.name.trim() && !up.withheld && !up.secret) return { place: { role: up.role, name: up.name.trim() } };
      p = up.parent;
    }
    const b = node.bounds, f = this.frame;
    if (!b || !f || f.width <= 0 || f.height <= 0) return {};
    const cx = (b.x + b.width / 2 - f.x) / f.width, cy = (b.y + b.height / 2 - f.y) / f.height;
    const v = cy < 1 / 3 ? "top" : cy > 2 / 3 ? "bottom" : "middle";
    const h = cx < 1 / 3 ? "left" : cx > 2 / 3 ? "right" : "";
    return { place: { at: h ? (v === "middle" ? `${h} side` : `${v} ${h}`) : v === "middle" ? "middle" : v } };
  }

  /**
   * Element `id` as the policy and the audit log see it: its name (or the label beside it), whether the reader found it
   * secret, and whether its name was withheld (nameWithheld).
   */
  private elementOf(id: number, n: AxNode): Focus {
    const name = this.nameOf(id, n);
    const byId = (p: number) => this.known.get(p);
    return { role: n.role, name, ...(n.secret ? { secret: true } : {}), ...(nameWithheld(n, name, this.known.values(), byId) ? { withheld: true } : {}), ...cellOf(n, byId) };
  }

  /**
   * What an element is called: its name, else the label beside it. GTK names a combo box after the option it shows:
   * the label beside it (it is labelled only then) says which one it is, whatever it shows now.
   */
  private nameOf(id: number, n: { role: string; name: string }): string {
    const label = this.labels.get(id);
    return (n.role === "combo box" && label) || n.name || label || "";
  }

  /** A field, for typedIn: its window (windowKey: process, and path or else title) and its role and name (or the label beside it). */
  private fieldOf(element: Focus | undefined): string {
    return [this.windowKey, element?.role ?? "", element?.name ?? ""].join("\n");
  }

  /**
   * Text going into `node` where it goes into a spreadsheet's cell (what edits one, or Calc's input line): what the
   * cell will hold, judged as a formula ({} anywhere else).
   */
  private formulaOf(node: AxNode, value: string | undefined, mode: TextMode): { formula?: string } {
    if (!intoSheet(node, p => this.known.get(p))) return {};
    return { formula: mode === "replace" ? value ?? "" : `${node.text ?? ""}${value ?? ""}` };
  }

  /** A click on "Select All" (a menu item, a toolbar button) selected everything in the working window, as Ctrl+A does. */
  private noteSelectAll(element: Focus): void {
    if (selectsAll(element)) this.keyed = { window: this.windowKey, selected: "all" };
  }

  /**
   * What this task has typed into `field` now (its end), kept for the last TYPED_FIELDS fields; what it added there
   * goes on the window's record too (typedWindows), after what went into its other fields.
   */
  private noteTyped(field: string, typed: string): void {
    const had = this.typedIn.get(field) ?? "";
    this.typedIn.delete(field);
    if (typed) this.typedIn.set(field, typed.slice(-TYPED_MAX));
    if (this.typedIn.size > TYPED_FIELDS) this.typedIn.delete(this.typedIn.keys().next().value as string);
    // What is new: the end added to what was there, or all of it where it replaced that (a Backspace adds nothing).
    const added = typed.startsWith(had) ? typed.slice(had.length) : had.startsWith(typed) ? "" : typed;
    if (!added) return;
    const win = this.windowKey;
    const w = this.typedWindows.get(win);
    this.typedWindows.delete(win);
    this.typedWindows.set(win, { field, text: (w ? `${w.text}${w.field === field ? "" : "\n"}${added}` : added).slice(-TYPED_MAX) });
    if (this.typedWindows.size > TYPED_FIELDS) this.typedWindows.delete(this.typedWindows.keys().next().value as string);
  }

  /** What this task typed into the working window's fields, then `text` going into `field` (undefined when nothing went in before). */
  private typedHere(field: string, text: string): string | undefined {
    const w = this.typedWindows.get(this.windowKey);
    return w ? `${w.text}${w.field === field ? "" : "\n"}${text}` : undefined;
  }

  /**
   * ActionRequest.ownText where `field` holds just what this task typed there (`current`, as read now): rewriting it
   * takes nothing of the user's. Text that was there before the task, or that Ember can't read all of, still counts.
   */
  private ownText(field: string, current: string | undefined): { ownText?: true } {
    const typed = this.typedIn.get(field);
    return !!current && typed === current ? { ownText: true } : {};
  }

  /** After a question was up, the element must still be the one the user said yes to. */
  private async stillSame(id: number, element: Focus): Promise<ToolResultObject | null> {
    if (!this.asked) return null;
    const live = await this.sidecar.readElement(id).catch(() => null);
    if (this.isOver) return STOPPED();
    const name = live ? this.nameOf(id, live) : null;
    if (!live || live.role !== element.role || name !== element.name || (live.offscreen && /menu item$/.test(element.role))) {
      return this.changedWhileDeciding(id, element, live);
    }
    return null;
  }

  /** The element changed while a question was up. A menu item whose menu the Allow click closed keeps its yes (see carriedMenuApproval). */
  private changedWhileDeciding(id: number, element: Focus, live: ElementInfo | null): ToolResultObject {
    if (this.asked && /menu item$/.test(element.role) && (!live || live.offscreen || (live.role === element.role && this.nameOf(id, live) === element.name))) {
      this.carriedMenuApproval = { app: this.window.app.toLowerCase(), role: element.role, name: element.name, until: Date.now() + 60_000 };
      return fail(`The menu holding ${q(element.name || "the item", 60)} closed when you answered (the click landed outside it), so nothing was clicked. The user's OK still stands: reopen its menu and click it again, without asking.`);
    }
    return fail(`Element ${id} changed while the user was deciding, so nothing was done. Call perceive_window and ask again if it's still needed.`);
  }

  /** choose_option: the option is found first (its full name, never a part of one), and the policy judges the one that will be chosen. */
  private async chooseOption(id: number, option: string): Promise<ToolResultObject> {
    if (!this.known.has(id)) return fail(`Element ${id} is not in your latest perceive_window. Call perceive_window and use its ids.`);
    // A secret element's options say what it holds (a card's number, a security question): never listed.
    const held = this.known.get(id);
    if (held?.secret) {
      return this.refuse("select", "this looks like a password or payment field", "That element holds something secret (a password or payment detail): Ember doesn't choose there. The user must do it; say so in finish_task.",
        { element: this.elementOf(id, held) });
    }
    let error = "";
    let left = 0;
    const options = await this.sidecar.listOptions(id).then(r => { left = r.left ?? 0; return r.options; }, (err: unknown) => { error = err instanceof Error ? err.message : String(err); return null; });
    if (this.isOver) return STOPPED();
    if (!options) {
      if (error.includes("background_unavailable")) return fail("That element has no options Ember can choose by accessibility. This can't be done without the mouse; tell the user in finish_task.");
      return fail(isBusy(error) ? BUSY : `Its options couldn't be read: ${q(error, 200)}. Call perceive_window.`);
    }
    const chosen = pickOption(options, option);
    if (chosen === null && left > 0) {
      // A long list (a folder of many files): its rows further down weren't looked through in time.
      return fail(`None of the first ${options.length} rows is called exactly ${q(option, 100)}, and the list is too long for Ember to look through the other ${left} in time. Type the name instead: ${this.sys.words.fileDialogPathHint}.`);
    }
    if (chosen === null) {
      return fail(`No option is called exactly ${q(option, 100)}. <options untrusted="true">${options.slice(0, 40).map(o => q(o, 60)).join(", ")}</options> Use one of these names in full.`);
    }
    let unchecked = 0;
    const r = await this.act("select", id, chosen, () => this.sidecar.selectOption(id, chosen).then(res => { unchecked = res.unchecked ?? 0; return res; }));
    // A long list: another row of that name further down can't be ruled out.
    return unchecked > 0 && r.resultType === "success"
      ? { ...r, textResultForLlm: `${r.textResultForLlm} (The list is long: its last ${unchecked} rows weren't checked for another of that name in time.)` }
      : r;
  }

  /** Policy check, confirmation, lease, motion, action, audit: the one path every window action takes. */
  private async act(kind: ActionKind, id: number, value: string | undefined, run: () => Promise<ActionResult>, mode?: TextMode): Promise<ToolResultObject> {
    if (this.place?.userInControl()) return this.deskTaken(kind);
    const f = await this.fresh(id);
    if (!("node" in f)) return f;
    const { node, element } = f;
    // A spreadsheet's cell takes no text by accessibility: it is filled with the keyboard (typeInCell).
    if (kind === "text" && isSheetCell(node)) return this.typeInCell(node.name, value ?? "", mode ?? "replace");
    const dialog = this.dialogOf(id);
    // Text typed at the caret right after Ctrl+A replaces everything selected: judged as "replace".
    const overSelection = kind === "text" && mode === "insert" && this.allSelected;
    // Where accessibility can't do it, only the question that applies is asked: to borrow the mouse (not first one
    // about acting in the app, whose answer would achieve nothing), or none when neither way can.
    const route = await this.route(kind, id, node, element, mode);
    if (this.isOver) return STOPPED();
    if (!("via" in route)) return route;
    const { handler, selects, box } = route;
    // What a toggle must leave it: on or off as asked; a click on a list's check box, the other way (it flips it).
    const turns: "on" | "off" | undefined = kind === "toggle" ? (value === "on" ? "on" : "off") : kind === "click" && box ? (isOn(node.states) ? "off" : "on") : undefined;
    if (route.via === "borrow") {
      this.d.log.info("router.escalate", { task: this.spec.id, from: "tier1", to: this.place ? "tier2-desk" : "tier3", kind, role: node.role, probed: true });
      return this.cursorAct(kind === "text" ? "cursor_text" : "cursor_click", id, node, value, mode, overSelection, kind === "toggle", handler, selects, turns);
    }
    const judged: TextMode = overSelection ? "replace" : mode ?? "replace";
    // Text added to a field is judged after what this task typed there before.
    const field = this.fieldOf(element);
    const prior = kind === "text" && judged !== "replace" ? this.typedIn.get(field) ?? "" : "";
    const base: ActionRequest = {
      taskId: this.spec.id, kind, app: this.window.app, window: this.window.name, element, value,
      ...(kind === "text" ? { mode: judged, currentText: node.text, ...(prior ? { typed: prior + (value ?? "") } : {}), ...this.formulaOf(node, value, judged), ...this.ownText(field, node.text) } : {}),
      ...((kind === "click" || kind === "toggle") && selects ? { clickSelects: true } : {}),
      ...(dialog ? { dialog } : {}),
      ...this.placeOf(id, element),
    };
    // A click on text inside a link (or a row) works the link: the user is asked about what the click works.
    const req: ActionRequest = kind === "click" || kind === "toggle" ? { ...base, element: this.clickJudged(base, element, handler) } : base;
    const verdict = await this.authorize(req);
    if (verdict) return verdict;
    const changed = await this.stillSame(id, element);
    if (changed) return changed;
    // A switch the user flipped while deciding may already be where it should be: toggling would undo it.
    if (kind === "toggle" && this.asked) {
      const now = await this.sidecar.readElement(id).catch(() => null);
      if (this.isOver) return STOPPED();
      if (now && isOn(now.states) === (value === "on")) return done(`Already ${value}: ${describeAfter(now)}`);
    }
    const release = await this.d.lease(this.window.name || this.window.app, this.spec.id, this.overSignal);
    try {
      if (this.isOver) return STOPPED();
      if (node.bounds) this.fly(node.bounds);
      await new Promise(r => setTimeout(r, 350)); // let Ember arrive, so the user sees where it acts
      if (this.isOver) return STOPPED();
      // The user may have taken over the desk while Ember waited for the question, the window or its turn.
      if (this.place?.userInControl()) return this.deskTaken(kind, element);
      const res = await run();
      if (kind === "text" && res.ok) this.noteTyped(field, prior + (value ?? ""));
      // A row or an icon chosen by a click is all that is selected there now: what the keys selected before is gone.
      if (kind === "click" && res.ok && (res.action === "select row" || res.action === "select item")) this.keyed = { window: "", selected: null };
      // Edit ▸ Select All selects everything, as Ctrl+A does: a key that types replaces it all.
      if (kind === "click" && res.ok) this.noteSelectAll(element);
      // A click that closes its own dialog (Close, OK, Save) leaves nothing to read back: done, not an error.
      let after = res.after as ElementInfo | null | undefined;
      const busyAfter = (res as { busy?: boolean }).busy === true;
      // A toggle is done once it shows, not on the app's word: it may say yes and change nothing.
      const stuck = turns && res.ok && after ? await this.notTurned(id, turns, after) : null;
      if (stuck) after = stuck;
      if (after) this.known.set(id, { ...node, name: after.name, states: after.states, bounds: after.bounds ?? node.bounds });
      // A field can say yes and still not take the text (read-only, or fewer characters allowed).
      const holds = kind === "text" && res.ok && after ? textNotTaken(after, value ?? "", mode ?? "replace") : null;
      // Done by accessibility on Ember's desk: "What Ember did" says so (tier 2), not that it was the user's own app.
      this.audit({ event: "action", task: this.spec.id, kind, app: req.app, window: req.window, element: req.element, ok: res.ok && holds === null && !stuck, ...(this.place ? { tier: 2 } : {}), ...auditValue(req), ...(after ? { after: { states: after.states, selected: after.selected } } : busyAfter ? { busy: true } : { gone: true }), ...(stuck ? { error: `it didn't turn ${turns}` } : {}) });
      if (holds !== null) return fail(`The field didn't take the text as asked: it now holds ${q(holds, 200)} (it may be read-only, or take fewer characters). Tell the user in finish_task if it matters.`);
      if (stuck) return fail(Worker.stillTurned(turns!, "The app said it did it", stuck));
      // A list's row or an icon is selected as a single click selects it: it isn't opened (GTK's own action would).
      const selected = res.action === "select row" ? "Selected its row" : res.action === "select item" ? "Selected it" : "";
      const outcome = !res.ok ? "The app reported it did not work"
        : selected ? `${selected}, as a single click does; it wasn't opened: press Enter (press_keys) to open it if that's what the task needs` : "Done";
      if (!after) return done(`${outcome}. ${busyAfter ? "The app is busy, so the result can't be read yet: call perceive_window in a moment." : "The element is gone now (its dialog or window most likely closed). Call perceive_window."}`);
      return done(`${outcome}. Now: ${describeAfter(after)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.audit({ event: "action", task: this.spec.id, kind, app: req.app, element: req.element, ok: false, ...(this.place ? { tier: 2 } : {}), error: msg });
      if (msg.includes("background_unavailable")) {
        release();
        // The router: tier 1 can't do it after all, so try tier 3 (the user's mouse), with their OK.
        const next = this.withoutTier1(kind, node, msg.replace("background_unavailable: ", ""));
        if (next !== "borrow") return next;
        this.d.log.info("router.escalate", { task: this.spec.id, from: "tier1", to: this.place ? "tier2-desk" : "tier3", kind, role: node.role });
        // A list's check box the helper didn't say was one before: the click flips it.
        const flips = turns ?? (kind === "click" && /check box in a list/.test(msg) ? (isOn(node.states) ? "off" : "on") : undefined);
        return this.cursorAct(kind === "text" ? "cursor_text" : "cursor_click", id, node, value, mode, overSelection, kind === "toggle", handler, selects, flips);
      }
      // A slow app may still carry out a request after Ember stopped waiting for it.
      if (/did not answer/.test(msg)) return fail("The app didn't answer in time, so it's unknown whether this happened. Call perceive_window to check before trying again.");
      if (isBusy(msg)) return fail(BUSY);
      // The helper's words can carry the app's own text: quoted, like everything from the screen.
      return fail(`It didn't work: ${q(msg, 300)}. Call perceive_window to see the window as it is now.`);
    } finally {
      // The step is over: no highlight is left on a closed dialog (an empty orange box) or the control just used.
      this.fly(null);
      release();
    }
  }

  /**
   * How `kind` can be done on element `id`, found out before anything is asked: via "tier1" (by accessibility; also
   * when the helper can't tell, and then the mouse is borrowed if it can't after all), via "borrow" (the mouse is the
   * only way), or the tool result when neither can. For a click, `handler`: the control around the element that the
   * click goes to, when the helper found one; `selects`: the click only selects it (a list's row or an icon, selected by
   * accessibility; or what has no action of its own, clicked with the mouse), so a row's name is judged as what it holds;
   * `box`: a check box in a list, which only the mouse's click ticks (GTK's own action opens its row instead).
   */
  private async route(kind: ActionKind, id: number, node: AxNode, element: Focus, mode?: TextMode): Promise<{ via: "tier1" | "borrow"; handler?: Handler; selects?: boolean; box?: boolean } | ToolResultObject> {
    if ((kind !== "click" && kind !== "toggle" && kind !== "text" && kind !== "value") || typeof this.sidecar.canDo !== "function") return { via: "tier1" };
    const insert = kind === "text" && mode === "insert";
    const can = await this.sidecar.canDo(id, kind, insert).catch(() => null);
    const clicks = kind === "click" || kind === "toggle";
    const handler = clicks && can?.handler ? { role: String(can.handler.role), name: String(can.handler.name ?? "") } : undefined;
    const selectsOnly = can?.action === "select row" || can?.action === "select item";
    // A toggle on a list's row or an icon: a click there only selects it, so nothing would turn on or off.
    if (kind === "toggle" && selectsOnly) {
      this.audit({ event: "action", task: this.spec.id, kind, app: this.window.app, window: this.window.name, element, ok: false, ...(this.place ? { tier: 2 } : {}), error: "not a switch or check box" });
      return fail(can?.action === "select item"
        ? `Element ${id} is an icon, not a switch or check box: a click on it only selects it, and nothing turns on or off. To choose it, use click.`
        : `Element ${id} is a cell of a list's row, not a switch or check box: a click on it only selects it, and nothing turns on or off. To tick a check box in a list, toggle the check box's own cell in that row (it may have no name); to choose the row, use click.`);
    }
    const selects = clicks && !!can && !handler && (selectsOnly || (!can.tier1 && !can.action)) ? { selects: true } : {};
    const box = clicks && !!can && !can.tier1 && can.action === "toggle" ? { box: true } : {};
    // The click goes to a control around it that lies too deep for Ember to find: what it works can't be told, so it isn't done.
    if ((kind === "click" || kind === "toggle") && can?.handlerUnknown) {
      this.audit({ event: "action", task: this.spec.id, kind, app: this.window.app, window: this.window.name, element, ok: false, ...(this.place ? { tier: 2 } : {}), error: "the control a click goes to can't be found" });
      return fail(`Ember can't tell what a click on element ${id} works: the page hands it to a control around it that lies too deep for Ember to find, so nothing was clicked. Click the link or button itself instead, or tell the user in finish_task.`);
    }
    if (!can || can.tier1) return { via: "tier1", ...(handler ? { handler } : {}), ...selects };
    const next = this.withoutTier1(kind, node, can.why ?? "");
    if (next !== "borrow") {
      this.audit({ event: "action", task: this.spec.id, kind, app: this.window.app, window: this.window.name, element, ok: false, ...(this.place ? { tier: 2 } : {}), error: `background_unavailable: ${can.why ?? ""}` });
      return next;
    }
    // Typed where the caret is: a click would move it, so the caret must be in this field already. In the window the
    // user is in, a field without the keyboard won't have it once the mouse is borrowed either.
    if (insert && can.windowActive === true && can.focused === false) {
      return fail(`Ember can't put the caret in the right place in element ${id} with the mouse. Use mode "append" or "replace", or ask the user to click where the text should go.`);
    }
    return { via: "borrow", ...(handler ? { handler } : {}), ...selects, ...box };
  }

  /**
   * What a click on `element` is judged as (`req`, the request about it): the control around it that the click goes to
   * (`handler`: Chromium hands a click on a link's text to the link, the mouse on a row's label clicks the row), by its
   * name or else by what was clicked; or what was clicked, where only that is risky (or never done). The user is asked
   * about whichever is, so it is risky if either is.
   */
  private clickJudged(req: ActionRequest, element: Focus, handler?: Handler): Focus {
    if (!handler) return element;
    const around: Focus = { role: handler.role, name: handler.name || element.name };
    // Judged as a click by accessibility on Ember's desk: risky or never, whatever the grant (not counted again).
    const weight = (el: Focus) => {
      const d = this.d.policy.recheck({ ...req, kind: "click", element: el, onDesk: true, goal: this.userWords, readFrom: [...this.read.values()], windowId: this.windowId });
      return d.verdict === "deny" ? 2 : d.risky ? 1 : 0;
    };
    return weight(element) > weight(around) ? element : around;
  }

  /**
   * Tier 1 can't do `kind` on this element (`why`): "borrow" where the user's mouse (or the desk's) can, with their OK;
   * otherwise the tool result saying it can't be done. Text only into a text field: in a cell, a list or a file view
   * Ctrl+A and Delete would hit everything.
   */
  private withoutTier1(kind: ActionKind, node: AxNode, why: string): "borrow" | ToolResultObject {
    const borrowable = !!(this.place || this.d.cursor) && !!node.bounds;
    if (borrowable && (kind === "click" || kind === "toggle" || (kind === "text" && typable(node.role, node.states)))) return "borrow";
    if (borrowable && kind === "text") {
      return fail(`This element (${q(node.role, 40)}) doesn't take text by accessibility, and it isn't a text field Ember may type into with the keyboard (there ${keyLabel(this.kc.edit.selectAll, this.kc)} and Delete could hit far more than it). Tell the user in finish_task.`);
    }
    // A spreadsheet's cell that takes no number this way takes it typed: type_text fills a cell by its address.
    if (kind === "value" && isSheetCell(node)) return fail(`Cell ${q(node.name, 20)} takes no number by accessibility: use type_text with cell ${q(node.name, 20)} and the number as text.`);
    return fail(`The app can't do this by accessibility (${q(why, 200)}). This can't be done without the mouse; tell the user in finish_task.`);
  }

  /**
   * Tier 3: borrow the mouse (and keyboard) for one action, with the user's OK. `overSelection`: Ctrl+A selected
   * everything before this text goes in at the caret (it is judged as replacing it all). `toggle`: the click turns a
   * switch `value` ("on" or "off"). `handler`: the control around the element that the click goes to (see clickJudged).
   * `selects`: the click only selects it (see route). `turns`: what the click must leave it (a toggle's `value`; a list's
   * check box, the other way): checked once the mouse is back, and the click isn't done until it shows that.
   */
  private async cursorAct(kind: "cursor_click" | "cursor_text", id: number, node: AxNode, value?: string, mode: TextMode = "replace", overSelection = false, toggle = false, handler?: Handler, selects = false, turns?: "on" | "off"): Promise<ToolResultObject> {
    const text = value ?? "";
    // On the user's screen, text goes in by paste: typed keys depend on their keyboard layout (and Caps Lock). On the desk it is typed.
    // No text (clearing a field: Ctrl+A and Delete do it) needs no clipboard, so the user's is never touched for it.
    const paste = kind === "cursor_text" && !this.place && !!this.clipboard && text !== "";
    if (kind === "cursor_text" && !paste && !typeableText(text)) {
      return fail("This app only takes typed text, and Ember can only type plain ASCII letters, digits and punctuation with the keyboard. Tell the user in finish_task.");
    }
    const element = this.elementOf(id, node);
    const field = this.fieldOf(element);
    const judged: TextMode = mode === "insert" && (overSelection || this.allSelected) ? "replace" : mode;
    const prior = kind === "cursor_text" && judged !== "replace" ? this.typedIn.get(field) ?? "" : "";
    // "OK" in a dialog is judged by what the dialog says, as it is without the mouse (this may be the only question).
    const dialog = this.dialogOf(id);
    const clicks = !(kind === "cursor_text" && mode === "insert");
    // What refuses the click (a sliver of it shows, it is outside its window, something else is at the spot) refuses it
    // before the user is asked, not after (and again once its window is in front).
    if (clicks) {
      const pre = await this.sidecar.readElement(id, { shown: true }).catch(() => null);
      if (this.isOver) return STOPPED();
      try {
        const spot = this.landingSpot(id, node, element, pre);
        await this.mustAimAt(id, pre!, spot, spot.shown);
      } catch (err) {
        if (err instanceof BorrowStopped) return STOPPED();
        const msg = err instanceof Error ? err.message : String(err);
        this.audit({ event: "action", task: this.spec.id, kind, app: this.window.app, window: this.window.name, element, ok: false, tier: this.place ? 2 : 3, error: msg });
        return fail(msg);
      }
    }
    const base: ActionRequest = { taskId: this.spec.id, kind, app: this.window.app, window: this.window.name, element, value,
      ...(kind === "cursor_text" ? { mode: judged, currentText: node.text, ...(prior ? { typed: prior + text } : {}), ...this.formulaOf(node, text, judged), ...this.ownText(field, node.text) } : {}),
      ...(kind === "cursor_click" && selects ? { clickSelects: true } : {}),
      ...(dialog ? { dialog } : {}), ...this.placeOf(id, element) };
    const verdict = await this.authorize(kind === "cursor_click" ? { ...base, element: this.clickJudged(base, element, handler) } : base);
    if (verdict) return verdict;
    // Where it is now: the window may have moved or scrolled while the user decided.
    const live = await this.sidecar.readElement(id).catch(() => null);
    if (this.isOver) return STOPPED();
    if (!live?.bounds || live.role !== node.role || this.nameOf(id, live) !== element.name || (live.offscreen && /menu item$/.test(element.role))) {
      const closedMenu = this.asked && /menu item$/.test(element.role) && (!live || live.offscreen || (live.role === node.role && this.nameOf(id, live) === element.name));
      if (closedMenu) return this.changedWhileDeciding(id, element, live);
      return fail(`Element ${id} moved or changed while the user was deciding, so nothing was done. Call perceive_window and try again.`);
    }
    // A switch the user flipped while deciding may already be where it should be: a click would undo it.
    const goal = turns ?? (toggle && (value === "on" || value === "off") ? value : undefined);
    if (goal && this.asked && isOn(live.states) === (goal === "on")) {
      return done(`Already ${goal}: ${describeAfter(live)}`);
    }
    // The user's clipboard is saved before anything is borrowed: if it can't be saved in time, nothing is touched.
    let saved: ClipboardSnapshot | null = null;
    if (paste) {
      const got = await this.saveClipboard(element);
      if (!("items" in got)) return got;
      saved = got;
    }
    // Ember's text went on the clipboard, Ctrl+V may have gone in, and Ember has waited for the text to show up.
    const pasting = { written: false, pressed: false, waited: false, before: undefined as string | undefined };
    const landed = () => this.pasteLanded(id, text, mode, pasting.before).finally(() => { pasting.waited = true; });
    // A password manager's copy: its clear timer may fire while Ember's text is on the clipboard, so it isn't put back.
    let passwordDropped = false;
    let result: ToolResultObject;
    /** What the app said shows where the mouse clicked, as it clicked. */
    let landedOn: PointElement | undefined;
    try {
      result = await this.withCursor(kind, element, async hand => {
        // Text to be typed that the keyboard layout can't type is refused before anything is clicked or selected.
        if (kind === "cursor_text" && !paste && typeof hand.checkTyping === "function") hand.checkTyping(text);
        // The user may have copied something new while Ember waited for its turn (a picture always counts as new): that
        // is what goes back afterwards, so if it can't be saved, nothing is touched.
        if (paste && !(await this.clipboard!.unchanged(saved!).catch(() => false))) {
          saved = await this.clipboard!.save().catch((err: unknown) => {
            throw new Error(`The user's clipboard couldn't be saved again (${err instanceof Error ? err.message : String(err)}), so nothing was pasted and the field wasn't touched. Try again in a moment, or tell the user in finish_task.`);
          });
        }
        // And where it is once its window is in front (Ember may have waited seconds for its turn and for the user to be still).
        const now = await this.sidecar.readElement(id, { shown: true }).catch(() => null);
        const spot = this.landingSpot(id, node, element, now);
        if (!clicks) {
          // A click would move the caret: "insert" goes where the caret already is, in the field that has the keyboard.
          if (!spot.focused) throw new Error(`Ember can't put the caret in the right place in element ${id} with the mouse. Use mode "append" or "replace", or ask the user to click where the text should go.`);
        } else {
          // The pointer goes there first, then where the element is is read again: LibreOffice (gtk3) reports places
          // 25 px off until the pointer first moves over its window (and its hit test agrees with them).
          await hand.glideTo(spot.x, spot.y);
          await sleep(POINTER_SETTLE_MS);
          const there = await this.sidecar.readElement(id, { shown: true }).catch(() => null);
          const again = this.landingSpot(id, node, element, there);
          const aim = await this.mustAimAt(id, there!, again, again.shown);
          if (Math.abs(aim.x - spot.x) >= 1 || Math.abs(aim.y - spot.y) >= 1) await hand.glideTo(aim.x, aim.y);
          landedOn = aim.there;
          await hand.click();
        }
        if (kind !== "cursor_text") return;
        // Keys go wherever the keyboard is: this field must have it (a click can land on an overlay), or nothing is typed.
        await this.untilFocused(id, node, element);
        // "replace" clears what is there first; append goes to the end.
        if (mode === "replace") { await hand.keys(this.kc.edit.selectAll); await hand.keys("Delete"); }
        else if (mode === "append") await hand.keys(this.kc.edit.textEnd);
        if (!paste) { await hand.type(text); return; }
        // What the field holds before the paste: the text must be new there (the field may hold these words already).
        const prior = await this.sidecar.readElement(id).catch(() => null);
        pasting.before = prior && !prior.secret ? prior.text : undefined;
        if (this.isOver) throw new BorrowStopped();
        await this.clipboard!.writeText(text);
        pasting.written = true;
        pasting.pressed = true;
        await hand.keys(this.kc.edit.paste);
      }, id, async () => {
        // A switch or check box: the click is done once it shows turned, never on the click alone.
        if (goal && kind === "cursor_click") {
          const stuck = await this.notTurned(id, goal);
          if (stuck) throw new Error(Worker.stillTurned(goal, "Ember clicked it with the user's mouse (which is back where it was)", stuck));
        }
        // The mouse is back; the clipboard goes back once the app has pasted (a slow app would paste the user's own clipboard).
        if (!pasting.pressed) return;
        const ok = await landed();
        if (ok === false) throw new Error(`The pasted text didn't show up in the field within ${Math.round(this.pasteWaitMs / 1000)} seconds (the app may be busy), so it's unknown whether it went in. Call perceive_window to check before trying again.`);
      });
    } finally {
      if (pasting.written) {
        // Stopped or taken over right after Ctrl+V: the app still reads the clipboard when it gets to it.
        if (pasting.pressed && !pasting.waited) await landed().catch(() => null);
        // Only over Ember's own text: a clipboard cleared meanwhile (a password manager's timer) stays cleared.
        // A password is never put back (nothing would clear it again): Ember's text is cleared instead.
        passwordDropped = holdsPassword(saved!);
        await this.clipboard!.restore(passwordDropped ? { items: [] } : saved!, text).catch(err => this.d.log.warn("worker.clipboard_restore_failed", { err }));
      }
    }
    if (kind === "cursor_text" && result.resultType === "success") this.noteTyped(field, prior + text);
    // The mouse's click on a cell (a sheet's, a list's row) selects it alone: what the keys selected before is gone.
    if (kind === "cursor_click" && result.resultType === "success" && element.role === "table cell") this.keyed = { window: "", selected: null };
    if (kind === "cursor_click" && result.resultType === "success") this.noteSelectAll(element);
    // What the click hit, as the app said where the pointer was: not only the element meant.
    if (landedOn && kind === "cursor_click" && result.resultType === "success") {
      result = { ...result, textResultForLlm: `${result.textResultForLlm} The click landed on ${screenWord(landedOn.role)}${landedOn.name ? ` ${q(landedOn.name, 80)}` : ""}.` };
    }
    if (!passwordDropped) return result;
    return { ...result, textResultForLlm: `${result.textResultForLlm} The user's clipboard held a password from their password manager, so Ember didn't put it back (its timer couldn't clear it again): tell the user it is no longer on the clipboard.` };
  }

  /**
   * After a click that should leave element `id` `turns` ("on": checked or pressed): null once it shows that (read again
   * for up to TOGGLE_WAIT_MS), or where it can't be read (gone, busy: nothing says it didn't); else the element as it
   * still is. `first`: as the action left it (read again only if that isn't it yet).
   */
  private async notTurned(id: number, turns: "on" | "off", first?: ElementInfo): Promise<ElementInfo | null> {
    const t0 = Date.now();
    let now: ElementInfo | null = first ?? await this.sidecar.readElement(id).catch(() => null);
    for (;;) {
      if (!now || isOn(now.states) === (turns === "on")) return null;
      if (Date.now() - t0 >= TOGGLE_WAIT_MS || this.isOver) return now;
      await sleep(100);
      now = await this.sidecar.readElement(id).catch(() => null);
    }
  }

  /** What a toggle (or a list's check box clicked) that didn't turn says: `how` it was done, and how it still is. */
  private static stillTurned(turns: "on" | "off", how: string, now: ElementInfo): string {
    return `${how}, but it didn't turn ${turns}: it is still ${turns === "on" ? "off" : "on"} (${describeAfter(now)}). Call perceive_window to check before trying again, or tell the user in finish_task.`;
  }

  /** The user's clipboard, saved before Ember borrows anything (or the tool result when it can't be in time). */
  private async saveClipboard(element: Focus): Promise<ClipboardSnapshot | ToolResultObject> {
    if (this.isOver) return STOPPED();
    const stopped = new Promise<"stopped">(r => this.overSignal.addEventListener("abort", () => r("stopped"), { once: true }));
    try {
      const got = await Promise.race([this.clipboard!.save(), stopped]);
      if (got === "stopped" || this.isOver) return STOPPED();
      return got;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.audit({ event: "action", task: this.spec.id, kind: "cursor_text", app: this.window.app, window: this.window.name, element, ok: false, tier: 3, error: `clipboard: ${msg}` });
      const why = err instanceof ClipboardTimeout ? "The user's clipboard didn't answer in time (the app that owns it may be frozen or busy)" : "Ember couldn't save the user's clipboard";
      return fail(`${why}, so nothing was pasted and the field wasn't touched (Ember only pastes when it can put the clipboard back). Try again in a moment, or tell the user in finish_task.`);
    }
  }

  /** After the click: field `id` must have the keyboard and take text before any key goes in; otherwise nothing is typed. */
  private async untilFocused(id: number, node: AxNode, element: Focus): Promise<void> {
    for (let i = 0; ; i++) {
      const now = await this.sidecar.readElement(id).catch(() => null);
      if (this.isOver) throw new BorrowStopped();
      const same = !!now && now.role === node.role && this.nameOf(id, now) === element.name;
      if (now && same && now.states.includes("focused") && typable(now.role, now.states)) return;
      if (!same || i >= 6) {
        throw new Error(`Element ${id} didn't get the keyboard${same ? "" : " (it changed)"}, so Ember typed nothing (the keys would have gone somewhere else). Call perceive_window; if it's the right field, ask the user to click into it.`);
      }
      await sleep(80);
    }
  }

  /**
   * Where to aim at an element now (in the part of it that shows: inside its list's scroll pane and its window), and
   * that part; or an error if it changed, has no position, or shows only a sliver or nothing (scrolled away).
   */
  private landingSpot(id: number, node: AxNode, element: Focus, now: ElementInfo | null): { x: number; y: number; focused: boolean; shown: Bounds } {
    if (!now?.bounds || now.role !== node.role || this.nameOf(id, now) !== element.name) {
      throw new Error(`Element ${id} moved or changed before Ember could reach it, so nothing was done. Call perceive_window and try again.`);
    }
    const b = now.bounds;
    // A row scrolled almost out of its list still says it shows, at its full size: its middle can be on what lies
    // below the list. And an element taller than its window (a long list) is aimed at in the part that is in it.
    const seen = now.shown ?? b;
    const v = this.frame ? overlap(seen, this.frame) : seen.width > 0 && seen.height > 0 ? seen : null;
    if (!v) {
      throw new Error(`Element ${id} is outside its window now (scrolled away, or the window moved), so nothing was done. Call perceive_window and try again.`);
    }
    if (v.width < Math.min(SLIVER_PX, b.width) || v.height < Math.min(SLIVER_PX, b.height)) {
      throw new Error(`Element ${id} is scrolled almost all the way out of view (only a sliver of it shows), so nothing was done: the mouse could land on what lies beside it. Scroll it into view first, then call perceive_window.`);
    }
    return { x: v.x + Math.min(v.width / 2, 120), y: v.y + v.height / 2, focused: now.states.includes("focused"), shown: v };
  }

  /**
   * Before the user's mouse clicks or turns the wheel over element `id` (as it is `now`, aimed at `spot` in `shown`, the
   * part of it that shows): the app is asked what shows at the spot. When that is something else (a row scrolled almost
   * out of its list, with a button below it; a fixed header's button or a popover over it; another control inside it,
   * such as a row's own "Remove" button), its left part (where a row's label is) and its middle are tried too, and
   * when none shows it, nothing is done. Where the app can't tell (no answer; a web page in a HiDPI window, whose
   * positions don't compare), the mouse goes ahead at `spot`, unless a spot tried before was seen covered. Returns the
   * spot to use, and what shows there when the app said.
   */
  private async mustAimAt(id: number, now: ElementInfo, spot: { x: number; y: number }, shown?: Bounds): Promise<{ x: number; y: number; there?: PointElement }> {
    // The app reports k physical pixels per pixel (HiDPI); a Chromium page in a HiDPI window reports physical ones
    // inside a frame that doesn't, and isn't asked.
    const k = typeof this.sidecar.scaleOf === "function" ? this.sidecar.scaleOf(id) : 1;
    if (typeof this.perception.atPoint !== "function" || k !== this.axScale || this.target.pid == null || !this.target.path || !now.bounds) return spot;
    const ancestors = this.ancestorsOf(id);
    const inside = this.controlsInside(id, now.bounds);
    const v = shown ?? now.bounds;
    const spots = [spot, { x: v.x + Math.min(12, v.width / 4), y: spot.y }, { x: v.x + v.width / 2, y: spot.y }]
      .filter((s, i, all) => all.findIndex(o => Math.abs(o.x - s.x) < 3) === i);
    let other: PointElement | undefined;
    for (const s of spots) {
      const chain = await this.perception.atPoint(this.target, s, k).catch(() => null);
      if (this.isOver) throw new BorrowStopped();
      // Where the app can't tell (no answer, or one that stops at what holds it), the mouse goes ahead only while no
      // spot tried before was seen covered: once one was (a notification over the row), only a spot that shows it will do.
      if (!chain?.length) {
        if (other) break;
        return spot;
      }
      const here = atSpot(chain, s);
      const seen = aimedAt(here, now.role, now.bounds, ancestors, undefined, inside);
      if (seen === "yes") return { ...s, there: here[here.length - 1] };
      if (seen === "unknown") {
        if (other) continue;
        return s;
      }
      // The control a click there works (a row's own button, rather than the words on it), else what is there.
      other ??= takerInside(here, now.role, now.bounds, inside) ?? here[here.length - 1];
      // An open menu over it (the app's answer starts in it): a click beside the menu would only close it.
      if (/^(menu|window)$/.test(chain[0].role)) {
        const what = `${q(other.name || other.role, 60)} (${q(other.role, 40)})`;
        throw new Error(`An open menu or popup lies over element ${id} (${what} is where the mouse would click): a click there would choose from it, and beside it would only close it. Nothing was done. Choose from the menu if that is the step, or close it with press_keys "Escape", then call perceive_window.`);
      }
    }
    const what = `${q(other!.name || other!.role, 60)} (${q(other!.role, 40)})`;
    if (other!.bounds && insideOf(other!.bounds, now.bounds)) {
      throw new Error(`Another control inside element ${id} is where the mouse would click (${what}), and the click would work it instead, so nothing was done. If that control is what you mean, use its own id; otherwise tell the user in finish_task.`);
    }
    throw new Error(`Something else shows where element ${id} should be (${what}): it may be scrolled almost out of view, or covered. Nothing was done. Scroll it into view, then call perceive_window and try again.`);
  }

  /** The elements round element `id` in the latest read (its parent first). */
  private ancestorsOf(id: number): AxNode[] {
    const out: AxNode[] = [];
    let p = this.known.get(id)?.parent ?? null;
    for (let i = 0; p !== null && i < 40; i++) {
      const n = this.known.get(p);
      if (!n) break;
      out.push(n);
      p = n.parent;
    }
    return out;
  }

  /**
   * The controls inside element `id` in the latest read (a row's own buttons and links), where they are now: moved with
   * it to `now` (the page may have scrolled since the read). See takerInside.
   */
  private controlsInside(id: number, now: Bounds): PointElement[] {
    const read = this.known.get(id)?.bounds;
    if (!read) return [];
    const dx = now.x - read.x, dy = now.y - read.y;
    const out: PointElement[] = [];
    for (const n of this.known.values()) {
      if (n.id === id || !n.bounds || !CLICK_TAKERS.test(n.role)) continue;
      let p = n.parent;
      for (let i = 0; p !== null && p !== id && i < 40; i++) p = this.known.get(p)?.parent ?? null;
      if (p === id) out.push({ role: n.role, name: n.name, bounds: { ...n.bounds, x: n.bounds.x + dx, y: n.bounds.y + dy } });
    }
    return out;
  }

  /**
   * Has the pasted text shown up in field `id` (null: its text can't be read)? Spacing is ignored (single-line
   * fields drop line breaks). Inserted or appended text must be new there: once more than before the paste.
   */
  private async holds(id: number, text: string, mode: TextMode, before: string | undefined): Promise<boolean | null> {
    const e = await this.sidecar.readElement(id).catch(() => null);
    if (!e || e.secret || e.text === undefined) return null;
    const squash = (s: string) => s.replace(/\s+/g, "");
    const t = squash(text);
    if (!t) return true;
    const count = (s: string) => squash(s).split(t).length - 1;
    if (mode === "replace" ? squash(e.text) === t : before !== undefined && count(e.text) > count(before)) return true;
    // Only the start of a long field is read (text added further on can't be seen), and without the text from before, nothing can be compared.
    return e.text.length >= TEXT_READ_LIMIT || (mode !== "replace" && before === undefined) ? null : false;
  }

  private get pasteWaitMs() { return this.d.limits?.pasteWaitMs ?? PASTE_WAIT_MS; }

  /** Waits for a paste into field `id`: true once the text shows, false if it didn't within pasteWaitMs, null if the field can't be read. */
  private async pasteLanded(id: number, text: string, mode: TextMode, before: string | undefined): Promise<boolean | null> {
    const t0 = Date.now();
    await sleep(PASTE_MIN_MS);
    for (;;) {
      const now = await this.holds(id, text, mode, before);
      if (now === true || Date.now() - t0 >= (now === null ? Math.min(PASTE_BLIND_MS, this.pasteWaitMs) : this.pasteWaitMs)) return now;
      await sleep(100);
    }
  }

  /**
   * Fills a spreadsheet's cell (`address`, "B5") with the keyboard, empty or not, with one question. In one borrow the
   * cell cursor goes there with the arrow keys (from the cell with the keyboard, or from A1 by Ctrl+Home, whichever
   * is nearer), or through the Name Box when both are far (see toCellByName), Ember checks that the cell with the
   * keyboard is that one and holds what the question said, then types
   * over it (typing over a selected cell replaces it: no Ctrl+A), presses Delete (drops what LibreOffice's AutoInput
   * offers to complete it with) and Enter. Nothing is typed when the cell can't be reached, or holds something the
   * question didn't say would go (its text is noted: asked again, the question says it). Empty text clears the cell.
   */
  private async typeInCell(address: string, text: string, mode: TextMode): Promise<ToolResultObject> {
    const at = this.cellAddress(address);
    if (typeof at === "string") return fail(at);
    if (this.place?.userInControl()) return this.deskTaken("cursor_text");
    if (mode !== "replace") return fail(`In a spreadsheet's cell Ember replaces what the cell holds: call type_text with mode "replace" and the cell's whole new content.`);
    const bad = cellTextProblem(text);
    if (bad) return fail(bad);
    if (!this.place && !this.d.cursor) return fail(`Filling a cell needs the keyboard, which isn't available here. ${this.deskHint}`);
    if (![...this.known.values()].some(n => isSheetCell(n))) return fail("Your latest perceive_window shows no spreadsheet cells. Call perceive_window in the spreadsheet's window first.");
    const job = this.cellJob(at.cell, at.place, text);
    const { cell, expected } = job;
    if (job.listed?.secret) return fail(`Cell ${cell} holds something secret: Ember doesn't type there.`);
    const element: Focus = { role: "table cell", name: cell };
    const verdict = await this.authorize({ taskId: this.spec.id, kind: "cursor_text", app: this.window.app, window: this.window.name, element, value: text, mode: "replace",
      ...(expected !== undefined ? { currentText: expected, ...this.ownText(this.fieldOf(element), expected) } : {}) });
    if (verdict) return verdict;
    let filled: { did: string; shows: string | undefined; says?: string } | undefined;
    const result = await this.withCursor("cursor_text", element, async hand => { filled = await this.fillCell(hand, job, this.cursorHints(cell)); }, undefined, undefined, true);
    if (result.resultType !== "success" || !filled) return result;
    if (filled.shows === undefined) return done(`Done: ${filled.did} (the cell cursor moved on), but Ember couldn't read ${cell} back. Call perceive_window to see what it shows now.`);
    return done(`Done: ${filled.did} (the cell cursor moved on).${text && filled.says ? ` It ${filled.says}.` : ""}`);
  }

  /**
   * fill_cells: several cells of the working window's spreadsheet with one question and in one borrow, each as
   * typeInCell fills one, in the order given. Each cell is judged as typing into it alone would be (see authorizeCells);
   * after a step the user didn't ask for, each cell is asked about (as type_text's). Stops at the first cell that can't
   * be filled (or didn't take it), saying which were.
   */
  private async fillCells(cells: { cell: string; text: string }[]): Promise<ToolResultObject> {
    const jobs: CellJob[] = [];
    for (const c of cells) {
      const at = this.cellAddress(c.cell);
      if (typeof at === "string") return fail(/nothing was typed/.test(at) ? at : `${at} Nothing was typed.`);
      const bad = cellTextProblem(c.text);
      if (bad) return fail(`${at.cell}: ${bad} Nothing was typed.`);
      if (jobs.some(j => j.cell === at.cell)) return fail(`${at.cell} is given twice: give each cell once, with its whole new content. Nothing was typed.`);
      jobs.push(this.cellJob(at.cell, at.place, c.text));
    }
    if (this.place?.userInControl()) return this.deskTaken("cursor_text");
    if (!this.place && !this.d.cursor) return fail(`Filling cells needs the keyboard, which isn't available here. ${this.deskHint}`);
    if (![...this.known.values()].some(n => isSheetCell(n))) return fail("Your latest perceive_window shows no spreadsheet cells. Call perceive_window in the spreadsheet's window first.");
    const secret = jobs.find(j => j.listed?.secret);
    if (secret) return fail(`Cell ${secret.cell} holds something secret: Ember doesn't type there. Nothing was typed: fill the other cells without it.`);
    const verdict = this.tainted ? "each" : await this.authorizeCells(jobs);
    if (verdict === "each") return this.fillEach(cells);
    if (verdict) return verdict;
    const filled: { job: CellJob; shows: string | undefined; says?: string }[] = [];
    const element: Focus = { role: "table cell", name: jobs.map(j => j.cell).join(", ") };
    const result = await this.withCursor("cursor_text", element, async hand => {
      for (const [i, job] of jobs.entries()) {
        // After Enter the cell cursor is below the cell filled before (or beside it): looked for there first.
        const prev = i > 0 ? jobs[i - 1].place : null;
        const near = prev ? [`${columnName(prev.col)}${prev.row + 1}`, `${columnName(prev.col + 1)}${prev.row}`, job.cell] : this.cursorHints(job.cell);
        try {
          const { shows, says } = await this.fillCell(hand, job, near);
          filled.push({ job, shows, says });
        } catch (err) {
          if (err instanceof BorrowStopped || err instanceof UserTookOver) throw err;
          const rest = jobs.slice(i + 1).map(j => j.cell);
          throw new Error(`${err instanceof Error ? err.message : String(err)}${rest.length ? ` The cells after it (${rest.join(", ")}) weren't typed.` : ""}`, { cause: err });
        }
      }
    }, undefined, undefined, true);
    const told = filled.map(f => f.shows === undefined ? `${f.job.cell} couldn't be read back` : `${f.job.cell} ${f.says ?? `shows ${q(f.shows, 80)}`}`).join(", ");
    if (result.resultType !== "success") return filled.length ? { ...result, textResultForLlm: `Filled ${filled.length} cell${filled.length > 1 ? "s" : ""} first (${told}). ${result.textResultForLlm}` } : result;
    const unread = filled.some(f => f.shows === undefined) ? " Call perceive_window to see what the others show." : "";
    return done(`Done: filled ${filled.length} cell${filled.length > 1 ? "s" : ""}, pressing Enter after each: ${told}.${unread}`);
  }

  /** fill_cells after a step the user didn't ask for: each cell as type_text fills it, each asked about; stops at the first that isn't filled. */
  private async fillEach(cells: { cell: string; text: string }[]): Promise<ToolResultObject> {
    const filled: string[] = [];
    for (const [i, c] of cells.entries()) {
      const r = await this.typeInCell(c.cell, c.text, "replace");
      if (r.resultType !== "success") {
        const rest = cells.slice(i + 1).map(o => o.cell.toUpperCase());
        const text = `${filled.length ? `Filled ${filled.join(", ")} first (each asked about: a step came up that the user didn't ask for). ` : ""}${r.textResultForLlm}${rest.length ? ` The cells after it (${rest.join(", ")}) weren't typed.` : ""}`;
        return { ...r, textResultForLlm: text };
      }
      filled.push(c.cell.toUpperCase());
    }
    return done(`Done: filled ${filled.join(", ")}, each asked about (a step came up that the user didn't ask for). Call perceive_window to see what they show.`);
  }

  /**
   * One question for filling several cells (fill_cells): each cell's request is judged as typing into it alone would be
   * (the policy's own judgement, counted as one action), and the batch is asked about once, listing each cell with what
   * goes in (and what it replaces), with every note the cells' own questions would have (text carried from another app,
   * a long text replaced). The batch is refused where a cell isn't allowed, or takes a formula that reaches outside the
   * sheet (that one is asked about on its own). "each": a step came up that the user didn't ask for (see fillEach).
   */
  private async authorizeCells(jobs: CellJob[]): Promise<ToolResultObject | null | "each"> {
    this.asked = false;
    if (this.isOver) return STOPPED();
    this.keyed = { window: "", selected: null };
    this.moving = null;
    const base = { taskId: this.spec.id, kind: "cursor_text" as const, app: this.window.app, window: this.window.name, mode: "replace" as const,
      onDesk: !!this.place, goal: this.userWords, agreed: this.agreed, readFrom: [...this.read.values()], windowId: this.windowId };
    // Judged after what was typed into the window's other fields before, as each cell would be one after the other.
    let typed = this.typedWindows.get(this.windowKey);
    const judged = jobs.map((job, i) => {
      const element: Focus = { role: "table cell", name: job.cell };
      const field = this.fieldOf(element);
      const typedHere = typed ? `${typed.text}${typed.field === field ? "" : "\n"}${job.text}` : undefined;
      const req: ActionRequest = { ...base, element, value: job.text, ...(typedHere ? { typedHere } : {}),
        ...(job.expected !== undefined ? { currentText: job.expected, ...this.ownText(field, job.expected) } : {}) };
      if (job.text) typed = { field, text: (typedHere ?? job.text).slice(-TYPED_MAX) };
      return { job, req, d: i === 0 ? this.d.policy.decide(req) : this.d.policy.recheck(req) };
    });
    // "What Ember did" shows the batch's decisions as one line (on the last cell's): refused (a cell isn't allowed),
    // asked (the one question), or none where no question is asked of the batch (all allowed, or each cell on its own).
    const no = judged.find(j => j.d.verdict === "deny");
    const asks = judged.find(j => j.d.verdict !== "allow");
    const alone = judged.some(j => j.d.aligned === false) || jobs.some(j => reachesOut(j.text));
    const batchVerdict = no ? "deny" : alone || !asks ? "none" : "ask";
    for (const [i, { req, d }] of judged.entries()) {
      const batch = jobs.length > 1 ? { batch: jobs.length, at: i, ...(i === jobs.length - 1 ? { batchVerdict, ...(no ?? asks ? { batchReason: (no ?? asks)!.d.reason } : {}) } : {}) } : {};
      this.audit({ event: "decision", task: this.spec.id, kind: req.kind, app: req.app, window: req.window, element: req.element, ...auditValue(req), tier: d.tier, verdict: d.verdict, reason: d.reason, ...(d.aligned === false ? { aligned: false } : {}), ...(req.onDesk ? { onDesk: true } : {}), ...batch });
    }
    if (no) return denied(`Not allowed in ${no.job.cell}: ${no.d.reason}. Nothing was typed. Don't try another way for that cell; fill the others without it if that still makes sense, and tell the user in finish_task.`);
    const out = jobs.find(j => reachesOut(j.text));
    if (out) return fail(`The formula for ${out.cell} can fetch from the internet or read other files, which the user is asked about on its own. Nothing was typed: fill ${out.cell} with type_text (cell ${out.cell}), and the other cells with fill_cells.`);
    if (judged.some(j => j.d.aligned === false)) {
      this.tainted = true;
      return "each";
    }
    if (judged.every(j => j.d.verdict === "allow")) return null;
    // Each cell, with what goes in (and what it replaces): the values cut short, all of them listed.
    const list = jobs.map(j => `${j.cell} ${j.text ? curly(j.text, 24) : "emptied"}${j.expected ? ` (replacing ${curly(j.expected, 16)})` : ""}`).join(", ");
    // What each cell's own question would add (text carried from another app, a long text replaced), once each.
    const notes = new Map<string, string[]>();
    for (const { job, req, d } of judged) {
      const plain = plainQuestion(req, this.kc);
      const note = d.prompt.startsWith(plain) ? d.prompt.slice(plain.length).trim() : "";
      if (note) notes.set(note, [...notes.get(note) ?? [], job.cell]);
    }
    const added = [...notes].map(([note, at]) => (at.length === jobs.length ? note : `${at.join(", ")}: ${note}`)).join(" ");
    const app = this.window.app ? ` in ${friendlyApp(this.window.app)}` : "";
    const prompt = `${this.place ? "Fill" : "Borrow your keyboard to fill"} ${jobs.length} cell${jobs.length > 1 ? "s" : ""}${app}${this.place ? " on my desk" : ""}: ${list}?${added ? ` ${added}` : ""}`;
    const context = this.spec.goal.length > 200 ? this.spec.goal.slice(0, 199) + "…" : this.spec.goal;
    this.asked = true;
    const answer = await this.d.confirmer.ask({ title: "May I?", context, prompt, options: [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }], task: this.spec.id }, this.overSignal);
    this.audit({ event: "confirm", task: this.spec.id, kind: "cursor_text", app: this.window.app, element: { role: "table cell", name: jobs.map(j => j.cell).join(", ") }, chars: jobs.reduce((n, j) => n + j.text.length, 0), mode: "replace", ...(this.place ? { onDesk: true } : {}), answer: this.isOver ? "stopped" : answer ?? "expired" });
    if (this.isOver) return STOPPED();
    if (answer === "once") return null;
    this.declined = true;
    return denied("The user said no (or didn't answer). Don't retry or work around it; finish the task and say what wasn't done.");
  }

  /** A cell's address as given ("b5", "$B$5"), as "B5" and its place; or why there is no such cell. */
  private cellAddress(address: string): { cell: string; place: { col: number; row: number } } | string {
    const cell = address.replace(/\$/g, "").toUpperCase();
    const place = CELL_ARG.test(address) ? cellPlace(cell) : null;
    if (!place) return `${q(address, 20)} isn't a cell's address (like B5).`;
    // Past the sheet's last column or row there is no such cell (through the Name Box the address would name a new range).
    const size = this.sheetSize();
    if (place.col >= size.columns || place.row > size.rows) {
      const past = place.col >= size.columns ? `column (${columnName(size.columns - 1)})` : `row (${size.rows})`;
      return `${cell} lies past the sheet's last ${past}: there is no such cell, so nothing was typed. Check the address.`;
    }
    return { cell, place };
  }

  /** A cell to fill (see CellJob): what it holds as the latest read listed it, or as Ember found it before; unknown for a cell not listed (empty, or scrolled away). */
  private cellJob(cell: string, place: { col: number; row: number }, text: string): CellJob {
    const listed = [...this.known.values()].find(n => isSheetCell(n) && n.name.replace(/\$/g, "") === cell);
    const seenKey = `${this.windowKey}\n${cell}`;
    const expected = listed && !listed.secret ? listed.text ?? "" : this.cellsSeen.get(seenKey);
    return { cell, place, text, expected, seenKey, listed };
  }

  /**
   * Fills one cell in a borrow (see typeInCell): the cell cursor taken there (looked for at `near` first), checked,
   * typed over, Enter, and the cell read back. Returns what was done, what the cell shows now (undefined: it couldn't
   * be read back) and what to say about it; throws (nothing typed into the cell) when it can't be reached, is on another
   * sheet than the one read, is protected or holds what the user wasn't asked about, and when it didn't take the text.
   */
  private async fillCell(hand: Hand, job: CellJob, near: string[]): Promise<{ did: string; shows: string | undefined; says?: string }> {
    const { cell, place, text, expected, seenKey, listed } = job;
    const element: Focus = { role: "table cell", name: cell };
    const steps = (a: { col: number; row: number }, b: { col: number; row: number }) => Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
    // Text the keyboard layout can't type is refused before any key goes in.
    if (typeof hand.checkTyping === "function") hand.checkTyping(text);
    const start = await this.cellWithKeyboard(undefined, near);
    if (!start) {
      throw new Error(this.cellLookCut ? "The spreadsheet was too busy to be read in time, so Ember couldn't tell which cell has the keyboard, and nothing was typed. Call perceive_window and try again."
        : "No cell of the spreadsheet has the keyboard in that window (a cell may be being edited: press Escape; or a dialog is open), so nothing was typed. Call perceive_window.");
    }
    // The cells asked about are the sheet's that was read: the user may have gone to another sheet since.
    const sheet = this.readSheet();
    if (sheet !== undefined && start.sheet !== undefined && start.sheet !== sheet) {
      throw new Error(`The sheet in front is now ${q(start.sheet, 60)}, not ${q(sheet, 60)} that was read and asked about, so nothing was typed. Call perceive_window to see it, and tell the user in finish_task if the cells belong on the other sheet.`);
    }
    let at = cellPlace(start.name) ?? { col: 0, row: 1 };
    const fromA1 = place.col + place.row - 1;
    // Far from both the cell cursor and A1: the Name Box takes it there.
    const byName = Math.min(steps(at, place), fromA1) > CELL_STEPS_MAX;
    if (byName) await this.toCellByName(hand, cell);
    else {
      if (steps(at, place) > fromA1) { await hand.keys(this.kc.edit.sheetHome); at = { col: 0, row: 1 }; }
      for (let i = 0; i < Math.abs(place.col - at.col); i++) await hand.keys(place.col > at.col ? "Right" : "Left");
      for (let i = 0; i < Math.abs(place.row - at.row); i++) await hand.keys(place.row > at.row ? "Down" : "Up");
    }
    const there = await this.cellWithKeyboard(cell);
    if (there?.name !== cell) {
      const how = byName ? "through the Name Box" : "with the arrow keys (hidden rows or columns, or merged cells, may be in the way)";
      // No cell has the keyboard: one may still be being edited (the arrow keys then move in its text).
      const editing = there ? "" : this.cellLookCut ? " The spreadsheet was too busy to be read in time: call perceive_window and try again."
        : " A cell may still be being edited: press Escape, call perceive_window, and try again.";
      throw new Error(`Ember couldn't reach ${cell} ${how}: the cell cursor is on ${there ? there.name : "no cell Ember can see"} now, and nothing was typed.${editing || " Tell the user in finish_task."}`);
    }
    if (there.text !== (expected ?? "")) {
      this.cellsSeen.set(seenKey, there.text);
      // Asked again, the question says what it holds (also where the latest read listed it holding something else).
      if (listed) this.known.set(listed.id, { ...listed, text: there.text });
      throw new Error(`${cell} holds ${q(there.text, 80)}${expected === undefined ? "" : ` now, not ${q(expected, 40)}`}, which the user wasn't asked about, so nothing was typed. If it should be replaced, call type_text again: the question will say what goes.`);
    }
    // A protected cell takes no keys (Calc puts up a message box at the first one): nothing is typed.
    if (!there.states.includes("editable")) throw new Error(`${cell} is protected (the sheet doesn't take changes there), so nothing was typed. Tell the user in finish_task.`);
    // What it held right before typing, and the quick look's id that finds the cell again.
    const found = { text: there.text, id: there.id };
    if (!text) await this.clearCell(hand);
    else {
      await hand.type(text);
      await hand.keys("Delete");
      await hand.keys("Return");
    }
    const did = text ? `typed ${q(text, 80)} into ${cell} and pressed Enter` : `cleared ${cell} and pressed Enter`;
    // What the cell holds now, read back. Calc commits an entry in its own time: while it shows what it held and that
    // isn't what was typed (see cellTook), or it shows no text yet or a formula's result isn't shown yet (see
    // cellSettled), it is read again a few times.
    let now = await this.cellNow(cell, found.id);
    for (let i = 0; i < CELL_SETTLE_LOOKS && now && !cellSettled(text, found.text, now); i++) {
      await sleep(CELL_SETTLE_MS);
      if (this.isOver) throw new BorrowStopped();
      now = await this.cellNow(cell, found.id) ?? now;
    }
    if (this.isOver) throw new BorrowStopped();
    if (now === undefined) {
      this.cellsSeen.delete(seenKey);
      this.noteTyped(this.fieldOf(element), text);
      return { did, shows: undefined };
    }
    const shows = now.text;
    // What it shows now is what it holds (typed again, the question says so: no second question), taken or not.
    this.cellsSeen.set(seenKey, shows);
    if (listed) this.known.set(listed.id, { ...listed, text: shows });
    if (!cellTook(text, found.text, shows, now)) {
      const what = shows ? `still shows ${q(shows, 80)}` : "is still empty";
      // Why, as the app tells it: a message box (its validity rules), the cell still being edited.
      const refused = await this.cellRefused(hand, cell);
      if (refused) throw new Error(`Ember ${did}, but ${cell} ${what}: ${refused}`);
      throw new Error(/^\s*[=+\-@]/.test(text)
        ? `Ember ${did}, but ${cell} ${what}, as before: the sheet may not have taken it (a read-only document), or the formula works out to what was there. Call perceive_window to check before trying again.`
        : `Ember ${did}, but ${cell} ${what}: the sheet didn't take it (the document may be read-only). Tell the user in finish_task.`);
    }
    this.noteTyped(this.fieldOf(element), text);
    return { did, shows, says: Worker.cellNowSays(text, shows, found.text, now.value) };
  }

  /**
   * What a filled cell (see fillCell) is said to hold now, by what was typed, what it held before and its number where
   * the app tells it (`value`): "holds “45”", "shows “3.1”" (Calc's own way, a formula's result), "shows “$1,200.00” as
   * before (the same value)". A formula that shows nothing works out to the number the app tells, where that isn't 0
   * (Calc may not show it yet); else to an error (Calc shows #DIV/0! or #N/A as no text, and tells 0) or to nothing.
   */
  private static cellNowSays(text: string, shows: string, before: string, value?: number): string {
    if (!shows && /^\s*=/.test(text) && value !== undefined && Number.isFinite(value) && value !== 0) {
      return `works out to ${Number(value.toPrecision(15))}, as the app tells it (the cell showed no text for it yet)`;
    }
    if (!shows) return /^\s*=/.test(text) ? "shows nothing: its formula went in, and works out to an error (such as #DIV/0! or #N/A) or to nothing" : "is empty";
    if (squashed(shows) === squashed(text)) return `holds ${q(shows, 80)}`;
    return squashed(shows) === squashed(before) ? `shows ${q(shows, 80)} as before (the same value)` : `shows ${q(shows, 80)}`;
  }

  /**
   * Why a cell that shows what it held before Enter didn't take what was typed, as the app tells it; null when nothing
   * says so. A message box the Enter brought up (LibreOffice's for a value its validity rules refuse): its words, quoted
   * as the app's; it is left for the user (Ember's keys only go to the window asked about). The cell still being edited:
   * Escape leaves it as it was.
   */
  private async cellRefused(hand: Hand, cell: string): Promise<string | null> {
    const seen = await this.perception.read(this.target, null, undefined, { keep: false, cells: [cell] }).catch(() => null);
    if (this.isOver) throw new BorrowStopped();
    const box = (seen?.others ?? []).find(o => o.active || o.modal);
    if (box) {
      const words = await this.windowWords(box.name);
      const app = this.window.app ? friendlyApp(this.window.app) : "The app";
      return `${app} put up a message ${q(box.name || "(untitled)", 60)}${words ? ` saying ${q(words, 200)}` : ""} (the value may be one the cell doesn't allow), and it is still open over the sheet. Tell the user in finish_task: closing it (Escape or its own button) leaves ${cell} as it was.`;
    }
    const nodes = seen?.window && !seen.blocked ? seen.nodes : [];
    const f = focusedElement(nodes);
    if (f && !isSheetCell(f) && intoSheet(f, id => nodes.find(n => n.id === id))) {
      await hand.keys("Escape");
      return `${cell} was still being edited, so Ember pressed Escape, which leaves it as it was. Call perceive_window to check before trying again.`;
    }
    return null;
  }

  /** The words a window of the working app shows (its labels and text, never a secret field's), read by its title: "" where it can't be read. */
  private async windowWords(title: string): Promise<string> {
    const seen = await this.perception.read({ ...(this.target.pid != null ? { pid: this.target.pid } : {}), title }, null, undefined, { keep: false }).catch(() => null);
    if (!seen?.window || seen.blocked) return "";
    return seen.nodes.filter(n => /^(label|static|paragraph|text|heading)$/.test(n.role) && !n.secret).map(n => n.name || n.text || "").filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 300);
  }

  /** The sheet the latest perceive_window read (its name, as "Sheet Data"), undefined where it read none. */
  private readSheet(): string | undefined {
    for (const n of this.known.values()) {
      const sheet = isSheetCell(n) && n.parent !== null ? this.known.get(n.parent) : undefined;
      if (sheet?.role === "table") return sheet.name;
    }
    return undefined;
  }

  /** The sheet's size, as the latest read found it (see AxNode.size), else LibreOffice 6.4's (SHEET_SIZE). */
  private sheetSize(): { rows: number; columns: number } {
    for (const n of this.known.values()) {
      const sheet = isSheetCell(n) && n.parent !== null ? this.known.get(n.parent)?.size : undefined;
      if (sheet && sheet.rows > 0 && sheet.columns > 0) return sheet;
    }
    return SHEET_SIZE;
  }

  /**
   * What spreadsheet cell `cell` ("B5") holds now (its text, its number and formula where the app tells them): asked of
   * it by `id` (a quick look's, see cellWithKeyboard), else looked for in a quick read of the window; undefined when
   * neither can tell (an empty cell isn't listed in a read).
   */
  private async cellNow(cell: string, id: number): Promise<{ text: string; value?: number; formula?: string } | undefined> {
    const e = await this.sidecar.readElement(id, { formula: true }).catch(() => null);
    if (e && e.role === "table cell" && e.name.replace(/\$/g, "").toUpperCase() === cell && !e.secret) return { text: e.text ?? "", value: e.value, formula: e.formula };
    const seen = await this.perception.read(this.target, null, undefined, { keep: false, cells: [cell] }).catch(() => null);
    const n = seen?.window && !seen.blocked ? seen.nodes.find(x => isSheetCell(x) && x.name.replace(/\$/g, "") === cell) : undefined;
    return n && !n.secret ? { text: n.text ?? "", value: n.value } : undefined;
  }

  /**
   * Clears the cell with the keyboard, and only it: Delete would clear every cell selected with it (B2:B5, B2 the cell
   * cursor's). Typing starts an entry in that cell alone, whatever is selected; Space, Backspace and Enter leave it empty.
   */
  private async clearCell(hand: Hand): Promise<void> {
    await hand.type(" ");
    await hand.keys("BackSpace");
    await hand.keys("Return");
  }

  /**
   * Where the cell cursor is likely to be before Ember moves it to `cell`: the cell that had the keyboard in the latest
   * perceive_window, and `cell` itself.
   */
  private cursorHints(cell: string): string[] {
    const last = [...this.known.values()].find(n => isSheetCell(n) && n.states.includes("focused"));
    return [...(last ? [last.name.replace(/\$/g, "")] : []), cell];
  }

  /**
   * Takes the cell cursor to `cell` through the spreadsheet's Name Box: Ctrl+Shift+F5 gives it the keyboard
   * (LibreOffice Calc), then the address and Enter go there. Only once the sheet has lost the keyboard in a window still
   * active, with no dialog in front, to nothing Ember can see (LibreOffice doesn't expose its Name Box) or to the Name
   * Box itself: the address is never typed into a cell or another field. Otherwise Escape, and an error. The address goes
   * in absolute ("$B$900"): the Name Box takes a bare one it has no cell for ("ZZZ5" past the last column) as the name
   * of a new range for the cells selected, and changes the document; "$" is never part of a name.
   */
  private async toCellByName(hand: Hand, cell: string): Promise<void> {
    await hand.keys(this.kc.edit.nameBox);
    for (let i = 0; ; i++) {
      await sleep(100);
      const seen = await this.perception.read(this.target, null, undefined, { keep: false }).catch(() => null);
      if (this.isOver) throw new BorrowStopped();
      const f = seen?.window && !seen.blocked ? focusedElement(seen.nodes) : null;
      const inFront = !!seen?.window?.active && !seen.blocked && !(seen.others ?? []).some(o => o.active);
      if (inFront && (!f || (/^(text|entry|combo box)$/.test(f.role) && /name box/i.test(f.name)))) break;
      if (i >= 4) {
        await hand.keys("Escape");
        throw new Error(`Cell ${cell} is too far from the cell cursor and A1 for the arrow keys (Ember presses ${CELL_STEPS_MAX} at most), and the spreadsheet's Name Box didn't take the keyboard, so nothing was typed. Tell the user in finish_task.`);
      }
    }
    await hand.type(cell.replace(/^([A-Z]+)(\d+)$/, "$$$1$$$2"));
    await hand.keys("Return");
  }

  /**
   * The spreadsheet cell with the keyboard in the working window (its address, what it holds, its states, its sheet's
   * name, and its id in the quick look, good until the next quick look: it finds that cell of the sheet however the
   * cursor moves), or null. `want`: the cell it should be by now: the app is given a moment to get there (a look may
   * come before the last arrow key is seen). The read looks in `want` and `near` first (see cursorHints): in a big,
   * zoomed-out sheet it can't ask every cell.
   */
  private async cellWithKeyboard(want?: string, near: string[] = []): Promise<{ name: string; text: string; id: number; states: string[]; sheet?: string } | null> {
    const cells = [...new Set([...(want ? [want] : []), ...near])];
    for (let i = 0; ; i++) {
      const seen = await this.perception.read(this.target, null, undefined, { keep: false, cells }).catch(() => null);
      if (this.isOver) throw new BorrowStopped();
      const f = seen?.window && !seen.blocked ? focusedElement(seen.nodes) : null;
      const sheet = f && f.parent !== null ? seen!.nodes.find(n => n.id === f.parent && n.role === "table")?.name : undefined;
      const cell = f && isSheetCell(f) && !f.secret ? { name: f.name.replace(/\$/g, ""), text: f.text ?? "", id: f.id, states: f.states, ...(sheet !== undefined ? { sheet } : {}) } : null;
      // No cell found because the read was cut short (a busy Calc), or while the keyboard is still on the window itself
      // (a Calc just opened or brought to the front moves it about): looked at again, a few times.
      this.cellLookCut = !cell && (!seen || seen.busy || !!seen.truncated);
      const unsure = !cell && (this.cellLookCut || unsureFocus(f ?? undefined));
      // (Looking for no cell in particular, none found is no answer: `cell?.name === want` would take it for one.)
      if ((!want && !(unsure && i < 4)) || (!!cell && cell.name === want) || i >= 5) return cell;
      await sleep(100);
    }
  }

  /**
   * The element with the keyboard in the working window (undefined: none it reports), "blocked" for a private window,
   * "gone" for one that can't be read (closed), "busy" for an app that didn't answer. `wait`: give a window just brought
   * to the front a moment to say. Notes what the focused field holds and what is selected in it (focusText,
   * focusSelection): an empty field's text is "" (the reader leaves it out), and its selection is "" when nothing is
   * selected, for a field whose text the reader reads (a heading's or a quotation's, when the reader tells it). Notes
   * too whether text may be selected beyond that (focusBeyond: the document's paragraphs say they are selected, as after
   * Edit ▸ Select All in Writer; or nothing says it has the keyboard where an editable document is), and what a
   * spreadsheet's cell being typed into holds so far (focusFormula).
   */
  private async focusIn(wait = false): Promise<Focus | undefined | "blocked" | "gone" | "busy"> {
    for (let i = 0; ; i++) {
      // A quick look (its ids aren't acted on): the ids of the latest perceive_window stay known however many keys go in.
      const seen = await this.perception.read(this.target, null, undefined, { keep: false }).catch(() => null);
      if (seen?.blocked) return "blocked";
      const f = seen?.window ? focusedElement(seen.nodes) : null;
      const read = !!f && !f.secret && READ_TEXT_ROLES.has(f.role);
      this.focusText = f && !f.secret ? f.text ?? (read ? "" : undefined) : undefined;
      this.focusSelection = read ? f!.selection ?? "" : f && !f.secret ? f.selection : undefined;
      const nodes = seen?.window ? seen.nodes : [];
      const byId = (id: number) => nodes.find(n => n.id === id);
      const selectedBlocks = nodes.some(n => TEXT_BLOCKS.has(n.role) && n.states.includes("selected"));
      const known = f && !unsureFocus(f) ? f : null;
      this.focusBeyond = known ? (DOCUMENT_ROLES.has(known.role) && (known.states.includes("selected") || selectedBlocks) ? "selected" : undefined)
        : nodes.some(editableDocument) ? (selectedBlocks ? "selected" : "unknown") : undefined;
      // A cell being typed into: LibreOffice says both the cell and what edits it (a paragraph) have the keyboard.
      const editing = nodes.find(n => n.states.includes("focused") && !n.secret && READ_TEXT_ROLES.has(n.role) && intoSheet(n, byId));
      this.focusFormula = !f || f.secret ? undefined : editing ? editing.text ?? "" : isSheetCell(f) ? "" : intoSheet(f, byId) ? f.text ?? "" : undefined;
      this.focusMultiLine = !!f && f.states.includes("multi line");
      this.focusInPage = !!f && (f.role === "document web" || inWebPage(f, byId));
      this.focusDialog = f ? dialogAround(f, byId, nodes) : undefined;
      if (seen?.window && f) {
        const name = f.name || inferLabels(seen.nodes).get(f.id) || "";
        return { role: f.role, name, ...(f.secret ? { secret: true } : {}), ...(nameWithheld(f, name, nodes, byId) ? { withheld: true } : {}), ...cellOf(f, byId) };
      }
      if (!wait || i >= 2 || this.isOver) return !seen ? "busy" : !seen.window ? (seen.busy ? "busy" : "gone") : undefined;
      await sleep(150);
    }
  }

  /**
   * focusIn, given a moment to settle (FOCUS_SETTLE_MS, and FOCUS_LOOKS looks: a busy LibreOffice takes a second or
   * more to read, so time alone would allow one look): LibreOffice moves the keyboard focus between its paragraph, its
   * root pane and nothing as its window comes to the front. Looks again while what it finds is nothing, a frame or a
   * root pane (not yet known), or, with `o.want`, isn't that (unless that was nothing and now a real element has it).
   */
  private async steadyFocus(wait: boolean, o?: { want: Focus | undefined }): Promise<Focus | undefined | "blocked" | "gone" | "busy"> {
    const t0 = Date.now();
    for (let looks = 1; ; looks++) {
      const look = await this.focusIn(wait);
      if (look === "blocked" || look === "gone" || look === "busy" || this.isOver) return look;
      const settled = o ? sameFocus(look, o.want) || (o.want === undefined && !unsureFocus(look)) : !unsureFocus(look);
      if (settled || (Date.now() - t0 >= FOCUS_SETTLE_MS && looks >= FOCUS_LOOKS)) return look;
      await sleep(100);
    }
  }

  /**
   * Keys go to whatever has the keyboard in the window, so the policy decides on that element (never a secret field),
   * and again once the window is in front, on what has the keyboard then: when that is something else, nothing is
   * pressed and the user is asked about it. Enter or Space with nothing Ember can see focused isn't pressed at all.
   * Nothing is asked where nothing could be pressed: on a desk the user has taken over, or in a window that is gone.
   */
  private async pressKeys(keys: string): Promise<ToolResultObject> {
    if (this.place?.userInControl()) return this.deskTaken("keys");
    const seen = await this.steadyFocus(false);
    if (this.isOver) return STOPPED();
    if (seen === "blocked") {
      return this.refuse("keys", "private window (never-look list or a password prompt)", "This window is private (on the user's never-look list, or a password prompt). Don't use it; finish the task and say so.", { value: keys });
    }
    if (seen === "busy") return fail(BUSY);
    if (seen === "gone") return fail("That window can't be read (it is closed, or exposes no accessibility information), so nothing was pressed. Use list_windows.");
    const activating = isActivatingKey(keys, this.kc);
    // Letters and digits typed key by key are judged as typed text (text read elsewhere is asked about): with what the
    // field holds (the caret may be anywhere in it) and after what this task typed there before. A key that types
    // replaces what is selected: the policy judges the selection the screen reader tells, and what the keys selected.
    const here = this.windowKey;
    if (this.keyed.window !== here) this.keyed = { window: here, selected: null };
    const char = typedChar(keys, this.kc);
    let element: Focus | undefined = seen;
    for (let round = 0; round < 3; round++) {
      const before = this.typedIn.get(this.fieldOf(element)) ?? "";
      const selected = this.keyed.selected;
      const req: ActionRequest = {
        taskId: this.spec.id, kind: "keys", app: this.window.app, window: this.window.name, element, value: keys,
        ...(char !== null ? { typed: (selected === "all" ? "" : before) + char } : {}),
        ...(this.focusText !== undefined ? { currentText: this.focusText } : {}),
        ...(this.focusSelection !== undefined ? { selection: this.focusSelection } : {}),
        ...(selected === "all" ? { afterSelectAll: true } : selected === "some" ? { afterSelecting: true } : {}),
        ...(this.focusBeyond ? { selectionBeyond: this.focusBeyond } : {}),
        // In a spreadsheet's cell: what it will hold, symbols too (a formula typed key by key).
        ...(this.focusFormula !== undefined ? { formula: this.focusFormula + (keyText(keys, this.kc) ?? "") } : {}),
        // Where Enter can send (a page's field), or only starts a line (an editor's text); and text that is all Ember's own.
        ...(element ? { inPage: this.focusInPage, ...(this.focusMultiLine ? { multiLine: true } : {}), ...this.ownText(this.fieldOf(element), this.focusText) } : {}),
        // The dialog the keys go to: Enter on its focused "Save Anyway" or "OK" answers it, as a click on it does.
        ...(element && this.focusDialog ? { dialog: this.focusDialog } : {}),
      };
      // On the user's screen, once they said yes to a key that only moves here, more of those go without a question.
      const moves = !this.place && onlyMoves(keys, element, this.kc);
      const covered = moves && this.moving === here;
      const verdict = await this.authorize(req, { covered, ...(moves && !covered ? { note: "Keys that only move there after this one won't be asked about." } : {}) });
      if (verdict) return verdict;
      const said = this.asked;
      const approved = element;
      const turn: { moved?: { to: Focus | undefined }; into?: Focus } = {};
      this.inputValue = { value: keys };
      const result = await this.withCursor("keys", approved, async hand => {
        // LibreOffice moves the focus about as its window comes to the front: what the user said yes to gets a moment to come back.
        const look = await this.steadyFocus(approved !== undefined || activating, { want: approved });
        if (look === "blocked") throw new Error("That window is private now (a password prompt, or on the never-look list), so nothing was pressed.");
        if (look === "gone" || look === "busy") throw new Error(`That window ${look === "gone" ? "can't be read any more (it may have closed)" : "isn't answering"}, so nothing was pressed. Call perceive_window.`);
        const now = look;
        // Nothing known before (or only the window, a root pane: LibreOffice's while it comes to the front) and something
        // harmless now is what the user said yes to ("I can't tell what it will activate").
        if (!sameFocus(now, approved) && !(unsureFocus(approved) && now && this.harmlessKeys({ ...req, element: now, inPage: this.focusInPage, multiLine: this.focusMultiLine }))) {
          turn.moved = { to: now };
          throw new Error(`Once the window was in front, ${now ? `${q(now.name, 60)} (${q(now.role, 40)})` : "nothing Ember can see"} had the keyboard, not what the user said yes to, so nothing was pressed.`);
        }
        if (!now && activating) throw new Error("Ember can't tell what that key would activate in this window (nothing there says it has the keyboard), so nothing was pressed. Click the control you mean instead.");
        turn.into = now;
        await hand.keys(keys);
      }).finally(() => { this.inputValue = {}; });
      if (!turn.moved) {
        if (result.resultType === "success") {
          const into = this.fieldOf(turn.into ?? approved);
          const next = afterKeys(keys, this.typedIn.get(into) ?? "", this.keyed.selected, this.kc);
          this.keyed = { window: here, selected: next.selected };
          this.noteTyped(into, next.typed);
        }
        // The user's yes to a key that only moves covers the next ones here; any other key (or one not pressed) ends that.
        this.moving = result.resultType === "success" && moves && (covered || said) ? here : null;
        return result;
      }
      element = turn.moved.to;
    }
    return fail("The keyboard focus kept moving in that window, so nothing was pressed. Call perceive_window.");
  }

  /** Would these keys on this element be pressed without a question where nothing needs borrowing (judged as on the desk)? */
  private harmlessKeys(req: ActionRequest): boolean {
    return this.d.policy.recheck({ ...req, onDesk: true, goal: this.userWords, windowId: this.windowId, readFrom: [...this.read.values()] }).verdict === "allow";
  }

  private async scroll(id: number, direction: "up" | "down" | "left" | "right", steps: number): Promise<ToolResultObject> {
    const f = await this.fresh(id);
    if (!("node" in f)) return f;
    const { node, element } = f;
    if (!node.bounds) return fail(`Element ${id} has no position on screen. Call perceive_window.`);
    const blind = (i: number, why: string) => new Error(i === 0
      ? `Ember couldn't see what the wheel would land on there (${why}), so nothing was scrolled. Call perceive_window and try again; if it happens again, tell the user in finish_task.`
      : `Scrolled ${i} of ${steps} steps, then stopped: Ember couldn't see what would come under the wheel next (${why}). Call perceive_window.`);
    const look = async (i: number) => {
      // Its ids aren't acted on: those of the latest perceive_window stay known, however many notches are read.
      const seen = await this.perception.read(this.target, null, undefined, { keep: false }).catch(() => null);
      if (!seen || seen.blocked || seen.busy) throw blind(i, "the app didn't answer in time");
      return seen;
    };
    type Seen = Awaited<ReturnType<typeof look>>;
    /**
     * Where the wheel goes, read now (bounds read earlier may scroll something else): in the part of the element that
     * shows (a list taller than its window shows only in it), and what Ember can see there (it doesn't scroll over
     * what it can't). `direct`: the wheel stays over the element itself (a control it changes, a scroll bar).
     */
    const plan = async () => {
      const now = await this.sidecar.readElement(id, { shown: true }).catch(() => null);
      const landed = this.landingSpot(id, node, element, now);
      let spot: { x: number; y: number } = { x: landed.x, y: landed.y };
      let region = landed.shown;
      // GTK 3's tab list holds its pages: the wheel there scrolls the page showing, which is checked notch by notch
      // like any page (nothing over it is listed on its own, so this is the element a model picks to scroll it).
      let tabs: Seen | undefined;
      if (node.role === "page tab list") {
        const seen = await look(0);
        const page = tabPage(seen.nodes, now!.bounds!, region);
        if (page) {
          tabs = seen;
          region = page;
          spot = { x: page.x + Math.min(page.width / 2, 120), y: page.y + page.height / 2 };
        }
      }
      // The wheel changes a combo box, slider or spin button (or a tab bar's tabs) under the pointer: only the one
      // asked for, once the app says it shows there. A scroll bar stays put while what it scrolls moves.
      if ((WHEEL_VALUE_ROLES.has(node.role) && !tabs) || node.role === "scroll bar") {
        const aim = await this.mustAimAt(id, now!, spot, landed.shown);
        return { direct: true as const, spot: { x: aim.x, y: aim.y } };
      }
      const first = await readAll(0, region, tabs);
      // After that, each notch is checked at the wheel's spot alone (a few calls, where a read of the window takes
      // hundreds while the user's mouse is held), in a window whose positions compare as read (scale 1).
      const byPoint = typeof this.perception.atPoint === "function" && (first.axScale ?? 1) === 1 && this.target.pid != null && !!this.target.path;
      if (!byPoint && first.truncated) throw blind(0, "the window has more in it than Ember reads at once");
      const found = wheelControls(first.nodes);
      const vertical = direction === "up" || direction === "down";
      // Content moves along the scroll, so the wheel goes in a lane across it that none of those on screen touches
      // (a label column, the scroll bar); and one notch at a time, looking again once the content has moved, for
      // ones scrolled into view: never with one under the wheel. (A tab list's own tabs stay put beside its page.)
      const moving = tabs ? found.filter(n => n.role !== "page tab list" || overlap(n.bounds!, region)) : found;
      const lane = clearLane(region, moving.map(n => n.bounds!), vertical, this.frame);
      if (lane !== null) spot = vertical ? { x: lane, y: spot.y } : { x: spot.x, y: lane };
      return { direct: false as const, spot, region, first, byPoint, found };
    };
    const readAll = async (i: number, region: Bounds, got?: Seen) => {
      const seen = got ?? await look(i);
      if (!seesInside(seen.nodes, region)) throw blind(i, "the app reports nothing there");
      return seen;
    };
    type Plan = Exclude<Awaited<ReturnType<typeof plan>>, { direct: true }>;
    /** What the wheel would change at its spot after `i` notches, if anything. */
    const underWheel = async (p: Plan, i: number): Promise<PointElement | undefined> => {
      const spot = p.spot;
      const before = i === 0 ? p.found.find(n => isUnder(spot, n.bounds!)) : undefined;
      if (!p.byPoint) {
        if (i === 0) return before;
        const seen = await readAll(i, p.region);
        // A read that left part of the window out can't be trusted.
        if (seen.truncated) throw blind(i, "the window has more in it than Ember reads at once");
        return wheelControls(seen.nodes).find(n => isUnder(spot, n.bounds!));
      }
      const ask = () => this.perception.atPoint(this.target, spot).catch(() => null);
      const t0 = Date.now();
      let chain = await ask();
      // A slow answer (the helper was busy with another read) may tell of the page as it was early in that wait,
      // while it still moved after the last notch; and a notch that long after the last isn't held to what that
      // one scrolled (Chromium): it goes to whatever is under the wheel then. So the app is asked again.
      if (chain && i > 0 && Date.now() - t0 > NOTCH_LATCH_MS) chain = await ask();
      if (!chain) throw blind(i, "the app didn't answer in time");
      if (!chain.length) throw blind(i, "the app reports nothing there");
      const under = before ?? wheelTarget(chain, spot);
      if (under || !chain[chain.length - 1].empty) return under;
      // The app's answer ended on an empty container (Chromium's can stop on an empty panel lying over its page):
      // this notch is checked by a read of the window instead, which must hold all of it.
      const seen = i === 0 ? p.first : await readAll(i, p.region);
      if (seen.truncated) throw blind(i, "the window has more in it than Ember reads at once");
      return wheelControls(seen.nodes).find(n => isUnder(spot, n.bounds!));
    };
    const landsOn = (under: PointElement, i: number) => {
      const what = `${q(under.name || under.role, 60)} (${q(under.role, 40)})`;
      return new Error(i === 0
        ? `The wheel would land on ${what}, which scrolling would change, so nothing was scrolled. Scroll another element, or use set_value or choose_option for that control.`
        : `Scrolled ${i} of ${steps} steps, then stopped: ${what} came under the wheel, and scrolling would change it. Call perceive_window.`);
    };
    // What would stop it (only a sliver shows, it is outside its window, Ember can't see under the wheel, a control the
    // wheel would change is there) stops it before the user is asked; and again once its window is in front.
    try {
      const p = await plan();
      const under = p.direct ? undefined : await underWheel(p, 0);
      if (under) throw landsOn(under, 0);
    } catch (err) {
      if (err instanceof BorrowStopped || this.isOver) return STOPPED();
      const msg = err instanceof Error ? err.message : String(err);
      this.audit({ event: "action", task: this.spec.id, kind: "scroll", app: this.window.app, window: this.window.name, element, ok: false, tier: this.place ? 2 : 3, value: direction, error: msg });
      return fail(msg);
    }
    const verdict = await this.authorize({ taskId: this.spec.id, kind: "scroll", app: this.window.app, window: this.window.name, element, value: direction });
    if (verdict) return verdict;
    return this.withCursor("scroll", element, async hand => {
      const p = await plan();
      if (p.direct) {
        await hand.glideTo(p.spot.x, p.spot.y);
        await hand.scroll(direction, steps);
        return;
      }
      for (let i = 0; i < steps; i++) {
        if (i > 0) await sleep(NOTCH_SETTLE_MS);
        const under = await underWheel(p, i);
        if (under) throw landsOn(under, i);
        if (i === 0) await hand.glideTo(p.spot.x, p.spot.y);
        await hand.scroll(direction, 1);
      }
    });
  }

  /** A hand that checks `check` before every move, click, key and few typed characters. */
  private guardedHand(hand: Hand, check: () => void, kind: ActionKind): Hand {
    // The keys that put text in a field (Ctrl+A, Delete, Ctrl+V) are its typing.
    const keysAre = kind === "cursor_text" ? "type" : "keys";
    return {
      ...hand,
      glideTo: async (x, y) => { check(); await hand.glideTo(x, y); },
      click: async b => { check(); this.showDoing("click"); await hand.click(b); },
      keys: async k => { check(); this.showDoing(keysAre); await hand.keys(k); },
      type: async t => {
        // All or nothing: text the keyboard layout can't type is refused before the first key (then typed a few letters at a time).
        if ("checkTyping" in hand && typeof hand.checkTyping === "function") hand.checkTyping(t);
        this.showDoing("type");
        for (const part of t.match(/[\s\S]{1,8}/g) ?? []) { check(); await hand.type(part); }
      },
      scroll: async (dir, n) => { check(); this.showDoing("scroll"); await hand.scroll(dir, n); },
    };
  }

  /** What the task's card says now: the step its tool started with, or what the borrowed hand is doing. */
  private doing: string | null = null;

  /** The card follows the hand: "Pressing keys…" while keys go in, though the tool's step said "Clicking…". */
  private showDoing(what: HandStep): void {
    const step = `${handStep(what, !!this.place)}…`;
    if (step === this.doing) return;
    this.doing = step;
    this.d.onProgress(step);
  }

  /** `afterBorrow`: runs once the mouse is given back, before the result is told (a paste waits for its text there). */
  /** What the action lines of the input under way record beyond its kind (the keys pressed: "What Ember did" names them). */
  private inputValue: Record<string, unknown> = {};

  private async withCursor(kind: ActionKind, element: Focus | undefined, fn: (hand: Hand) => Promise<void>, verifyId?: number, afterBorrow?: () => Promise<void>, keysOnly = kind === "keys"): Promise<ToolResultObject> {
    if (this.isOver) return STOPPED();
    if (this.place) return this.onDeskInput(this.place, kind, element, fn, verifyId, afterBorrow);
    if (!this.d.cursor) return fail(`This needs the mouse or keyboard, which isn't available here. ${this.deskHint}`);
    const c = this.d.cursor;
    // A password or authentication prompt has the keyboard: those are the user's alone (M8.3).
    const authPrompt = () => { const w = c.activeWindow?.(); return !!w && this.sys.privacy.isSecurityWindow(w); };
    if (authPrompt()) {
      this.audit({ event: "decision", task: this.spec.id, kind, app: this.window.app, window: this.window.name, element, tier: "never", verdict: "deny", reason: "an authentication prompt has the keyboard" });
      return denied("An authentication prompt is open on the user's screen. That's for the user only: wait, or finish the task saying what's left.");
    }
    // GNOME Shell's own prompts (polkit, keyring) aren't X windows: the shell is asked too.
    if (await Promise.resolve().then(() => this.perception.systemDialogOpen()).catch(() => false)) {
      this.audit({ event: "decision", task: this.spec.id, kind, app: this.window.app, window: this.window.name, element, tier: "never", verdict: "deny", reason: "a system dialog is open" });
      return denied("A system dialog (such as a password prompt) is open on the user's screen. That's for the user only: wait, or finish the task saying what's left.");
    }
    const check = () => {
      if (this.isOver) throw new BorrowStopped();
      if (authPrompt()) throw new Error("an authentication prompt took the keyboard, so Ember stopped");
    };
    // Exactly the window the user approved, or nothing: no known window, or a title several windows share (or none), is refused.
    if (!this.window.name) {
      this.audit({ event: "action", task: this.spec.id, kind, app: this.window.app, element, ok: false, tier: 3, error: "no window known yet" });
      return fail("Ember doesn't know which window to use yet. Call perceive_window first.");
    }
    const win = c.findWindow(this.window.name, this.target.pid);
    if (!win) {
      this.audit({ event: "action", task: this.spec.id, kind, app: this.window.app, window: this.window.name, element, ok: false, tier: 3, error: "the window couldn't be told apart (none or several with that title)" });
      return fail("Ember can't tell which window that is (none or several have that title), so it didn't use the mouse. Call perceive_window.");
    }
    const release = await this.d.lease(this.window.name || this.window.app, this.spec.id, this.overSignal);
    // Stopped while waiting for another task's window: the approved borrow never starts.
    if (this.isOver) { release(); return STOPPED(); }
    // Asked for first, so the status sees it waiting ("Waiting until you let go of the mouse…").
    const borrowed = c.borrow.borrow(hand => fn(this.guardedHand(hand, check, kind)), {
      window: win,
      signal: this.overSignal,
      onStart: () => c.setBorrowing("active"),
      // Keys alone (press_keys, a spreadsheet's cells): the status says "your keyboard", not "your mouse".
      ...(keysOnly ? { keysOnly: true } : {}),
    });
    c.setBorrowing("waiting");
    this.fly(null); // Ember rides along with the cursor
    // The status goes back to normal as soon as the mouse is back (a paste may still be waited for after that).
    let borrowing = true;
    const borrowOver = () => { if (borrowing) { borrowing = false; c.setBorrowing("off"); } };
    try {
      await borrowed;
      borrowOver();
      await afterBorrow?.();
      const after = verifyId !== undefined ? await this.sidecar.readElement(verifyId).catch(() => null) : null;
      this.audit({ event: "action", task: this.spec.id, kind, app: this.window.app, window: this.window.name, element, ok: true, tier: 3, ...this.inputValue });
      return done(`Done with the user's mouse, which is back where it was.${after ? ` Now: ${describeAfter(after)}` : " Call perceive_window to check the result."}`);
    } catch (err) {
      const tookOver = err instanceof UserTookOver;
      const msg = err instanceof Error ? err.message : String(err);
      this.audit({ event: "action", task: this.spec.id, kind, app: this.window.app, element, ok: false, tier: 3, error: msg, ...this.inputValue, ...(tookOver ? { tookOverAfterMs: err.afterMs } : {}) });
      if (tookOver) this.userTookOver = true;
      if (tookOver) return denied("The user took the mouse back, so you stopped. Don't try again; finish the task and say what's left.");
      if (err instanceof BorrowStopped) return STOPPED();
      return fail(msg);
    } finally {
      borrowOver();
      release();
    }
  }

  /** Tier 2: full mouse and keyboard on Ember's own desk (the user's input is never touched). */
  private async onDeskInput(place: DeskPlace, kind: ActionKind, element: Focus | undefined, fn: (hand: Hand) => Promise<void>, verifyId?: number, afterBorrow?: () => Promise<void>): Promise<ToolResultObject> {
    if (place.userInControl()) return this.deskTaken(kind, element);
    // Exactly the window approved, as on the user's screen: a refusal is in the audit log too.
    if (!this.window.name) {
      this.audit({ event: "action", task: this.spec.id, kind, app: this.window.app, element, ok: false, tier: 2, error: "no window known yet" });
      return fail("Ember doesn't know which window on its desk to use yet. Call perceive_window first.");
    }
    const release = await this.d.lease(`desk:${this.window.name}`, this.spec.id, this.overSignal);
    if (this.isOver) { release(); return STOPPED(); }
    // One keyboard and pointer per desk: every task's desk input goes through the same queue.
    const deskBorrow = deskBorrowFor(place);
    // Taking over the desk ("Take over" in its view) stops Ember's input there at once, also a borrow that waited its turn.
    const check = () => {
      if (this.isOver) throw new BorrowStopped();
      if (place.userInControl()) throw new UserTookOver(0);
    };
    const win = place.input.findWindow(this.window.name, this.target.pid) || this.deskDialogWindow(place);
    if (!win) {
      release();
      this.audit({ event: "action", task: this.spec.id, kind, app: this.window.app, window: this.window.name, element, ok: false, tier: 2, error: "the window couldn't be told apart (none or several with that title)" });
      return fail("Ember can't tell which window on its desk that is (none or several have that title). Call perceive_window.");
    }
    try {
      await deskBorrow.borrow(hand => { check(); return fn(this.guardedHand(hand, check, kind)); }, { idleMs: 0, window: win, signal: this.overSignal });
      await afterBorrow?.();
      const after = verifyId !== undefined ? await place.sidecar.readElement(verifyId).catch(() => null) : null;
      this.audit({ event: "action", task: this.spec.id, kind, app: this.window.app, window: this.window.name, element, ok: true, tier: 2, ...this.inputValue });
      return done(`Done on your desk.${after ? ` Now: ${describeAfter(after)}` : " Call perceive_window to check the result."}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.audit({ event: "action", task: this.spec.id, kind, app: this.window.app, element, ok: false, tier: 2, error: msg, ...this.inputValue });
      if (err instanceof UserTookOver) return denied("The user took over your desk. Stop and finish the task, saying where you got to.");
      if (err instanceof BorrowStopped) return STOPPED();
      return fail(msg);
    } finally {
      release();
    }
  }

  /**
   * A dialog read on the desk whose X title isn't its accessible name (GTK's message dialogs are "Question" or
   * "Information" there, titled otherwise or not at all): its process's one window where it was read, else 0.
   * Only on the desk: on the user's screen the title must match.
   */
  private deskDialogWindow(place: DeskPlace): number {
    const pid = this.target.pid;
    if (pid === undefined || !this.frame || !DIALOG_ROLES.has(this.window.role ?? "")) return 0;
    try { return deskWindowAt(place.x11.stack(), pid, this.frame); } catch { return 0; }
  }

  /** Tier 0 actions (settings, launching): policy and audit, no window. `app`: the app being launched. */
  private async system(kind: "setting" | "open_app", value: string, run: () => Promise<string>, app = ""): Promise<ToolResultObject> {
    const verdict = await this.authorize({ taskId: this.spec.id, kind, app, window: "", value });
    if (verdict) return verdict;
    if (this.isOver) return STOPPED();
    try {
      const text = await run();
      this.audit({ event: "action", task: this.spec.id, kind, value, ok: true });
      return done(text);
    } catch (err) {
      if (err instanceof BorrowStopped) return STOPPED();
      if (err instanceof UserTookOver) return this.deskTaken(kind);
      const msg = err instanceof Error ? err.message : String(err);
      this.audit({ event: "action", task: this.spec.id, kind, value, ok: false, error: msg });
      return fail(msg);
    }
  }

  /** A refusal Ember makes itself (not the policy engine): written to the audit log like the policy's, then told to the model. */
  private refuse(kind: ActionKind, reason: string, text: string, o: { app?: string; element?: Focus; value?: string; never?: boolean } = {}): ToolResultObject {
    this.audit({
      event: "decision", task: this.spec.id, kind, app: o.app ?? this.window.app, window: this.window.name,
      ...(o.element ? { element: o.element } : {}), ...(o.value !== undefined ? { value: o.value.slice(0, 120) } : {}),
      ...(o.never === false ? {} : { tier: "never" }), verdict: "deny", reason,
    });
    return denied(text);
  }

  private deskTaken(kind: ActionKind, element?: Focus): ToolResultObject {
    return this.refuse(kind, "the user has taken over Ember's desk", "The user has taken over your desk. Wait for them, or finish the task saying where you got to.", { element, never: false });
  }

  /** Every audit entry goes through here: an action (tried or done) after a "Not now" means the task went on. */
  private audit(e: AuditEntry): void {
    if (e.event === "action") this.declined = false;
    this.d.audit.write(e);
  }

  /**
   * null when the action may go ahead; otherwise the tool result to return. `note`: added to the question, if one is
   * asked. `covered`: a key that only moves, after the user said yes to one in this window: it goes without a question
   * unless something else makes it need one (it would be asked on Ember's desk too, or every step is checked).
   */
  private async authorize(request: ActionRequest, o: { note?: string; covered?: boolean } = {}): Promise<ToolResultObject | null> {
    this.asked = false;
    if (this.isOver) return STOPPED();
    // The user's click on Allow closed the menu this item is in: their yes covers reopening it and clicking the same item.
    const carried = this.carriedMenuApproval;
    if (carried && Date.now() > carried.until) this.carriedMenuApproval = null;
    else if (carried && (request.kind === "click" || request.kind === "cursor_click") && request.app.toLowerCase() === carried.app
      && request.element?.role === carried.role && request.element.name === carried.name) {
      this.carriedMenuApproval = null;
      this.audit({ event: "decision", task: this.spec.id, kind: request.kind, app: request.app, window: request.window, element: request.element, ...auditValue(request), tier: "reversible", verdict: "allow", reason: "the user already allowed this menu item; their answer closed its menu" });
      return null;
    }
    const inWindow = request.kind !== "open_app" && request.kind !== "setting";
    // What the keys selected ends where text goes in, or the mouse clicks or types into a text field (that moves the
    // caret). A click by accessibility (a toolbar button), a scroll or a look move no caret: the selection stays.
    if (request.kind === "text" || request.kind === "cursor_text" || (request.kind === "cursor_click" && TYPING_ROLES.has(request.element?.role ?? ""))) {
      this.keyed = { window: "", selected: null };
    }
    if (request.kind !== "keys") this.moving = null;
    // Text going into a field is judged after what this task typed into the window's other fields too.
    const adds = request.kind === "text" || request.kind === "cursor_text" ? request.value ?? "" : request.kind === "keys" ? typedChar(request.value ?? "", this.kc) ?? "" : "";
    const typedHere = adds && inWindow ? this.typedHere(this.fieldOf(request.element), adds) : undefined;
    const req = { ...request, ...(typedHere ? { typedHere } : {}), onDesk: !!this.place, goal: this.userWords, agreed: this.agreed, readFrom: [...this.read.values()], ...(inWindow ? { windowId: this.windowId } : {}) };
    let decision = this.d.policy.decide(req);
    if (decision.aligned === false) this.tainted = true;
    // After a step the user didn't ask for came up (a page may have steered Ember, or the model went its own way),
    // nothing more happens without the user's click, and every question says why (one that would have been asked
    // anyway too; the step that was flagged says so itself).
    if (this.tainted && decision.verdict !== "deny" && decision.tier !== "read" && decision.aligned !== false) {
      // An app the user already allowed for this task: the step alone is asked about, not working in the app again.
      const step = decision.stepPrompt && this.allowedApps.has(req.app.toLowerCase()) ? decision.stepPrompt : decision.prompt;
      const prompt = `${step} (I'm checking each step: a step came up that you didn't ask for.)`;
      decision = decision.verdict === "allow"
        ? { ...decision, verdict: "confirm", tier: "confirm", everyTime: true, remember: false, reason: `${decision.reason}; a step came up that the user didn't ask for`, prompt }
        : { ...decision, everyTime: true, remember: false, prompt };
    }
    if (o.covered && decision.verdict === "confirm" && !this.tainted && decision.aligned !== false && this.harmlessKeys(req)) {
      decision = { ...decision, verdict: "allow", tier: "reversible", reason: "a key that only moves, after the user said yes to moving there" };
    } else if (o.note && decision.verdict === "confirm") {
      decision = { ...decision, prompt: `${decision.prompt} ${o.note}` };
    }
    // "Allow" earlier in this task covers ordinary steps in that app, but not once something on screen tried to steer Ember.
    // A yes to keys that only move (Ctrl+End) never puts the app on that list: typing or a save is asked about itself.
    const sessionAllowed = decision.verdict === "confirm" && !decision.risky && !decision.everyTime && !this.tainted
      && this.allowedApps.has(req.app.toLowerCase());
    this.audit({ event: "decision", task: this.spec.id, kind: req.kind, app: req.app, window: req.window, element: req.element, ...auditValue(req), tier: decision.tier, verdict: sessionAllowed ? "allow" : decision.verdict, reason: decision.reason, ...(decision.aligned === false ? { aligned: false } : {}), ...(req.onDesk ? { onDesk: true } : {}) });
    if (decision.verdict === "deny") return denied(`Not allowed: ${decision.reason}. Don't try another way; tell the user in finish_task.`);
    if (decision.verdict === "allow" || sessionAllowed) return null;
    // "Always in this app" isn't offered once something on screen tried to steer Ember.
    const remember = !!decision.needsGrant && !!decision.remember && !!req.app && !this.tainted;
    const options = remember
      ? [{ id: "once", label: "Allow", primary: true }, { id: "always", label: `Always in ${friendlyApp(req.app)}` }, { id: "deny", label: "Not now" }]
      : [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }];
    const context = this.spec.goal.length > 200 ? this.spec.goal.slice(0, 199) + "…" : this.spec.goal;
    this.asked = true;
    const answer = await this.d.confirmer.ask({ title: "May I?", context, prompt: decision.prompt, options, task: this.spec.id }, this.overSignal);
    this.audit({ event: "confirm", task: this.spec.id, kind: req.kind, app: req.app, element: req.element, ...auditValue(req), ...(req.onDesk ? { onDesk: true } : {}), answer: this.isOver ? "stopped" : answer ?? "expired" });
    if (this.isOver) return STOPPED();
    if (answer === "always" && remember) {
      this.d.settings.update({ grants: { ...this.d.settings.get().grants, [req.app.toLowerCase()]: "act" } });
    }
    if (answer === "once" || answer === "always") {
      // Keys that only move don't let Ember type or save later without asking (a yes to Ctrl+End is only that).
      if (decision.needsGrant && req.app && !(req.kind === "keys" && onlyMoves(req.value ?? "", req.element, this.kc))) {
        this.allowedApps.add(req.app.toLowerCase());
      }
      return null;
    }
    this.declined = true;
    return denied("The user said no (or didn't answer). Don't retry or work around it; finish the task and say what wasn't done.");
  }
}

/** What the audit log keeps about an action's value: keys and choices in full, typed text only as a length. */
function auditValue(r: ActionRequest): Record<string, unknown> {
  if (r.value === undefined) return {};
  if (r.kind === "text" || r.kind === "cursor_text") return { chars: r.value.length, ...(r.mode ? { mode: r.mode } : {}) };
  return { value: r.value.slice(0, 120) };
}
