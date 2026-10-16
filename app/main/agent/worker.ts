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
import path from "node:path";
import { defineTool, type CopilotClient, type CopilotSession, type ProviderConfig, type Tool, type ToolResultObject } from "@github/copilot-sdk";
import { z } from "zod";
import { hardenedSessionConfig, verifySessionTools } from "./session-config";
import { workerSystemMessage, guideSystemMessage } from "./worker-persona";
import { TURN_START_MS, TurnWatch, within } from "./conductor";
import { asPasteClipboard, ClipboardTimeout, holdsPassword, type ClipboardSnapshot, type PasteClipboard, type TextClipboard } from "./clipboard";
import { TOOL_STEPS, type Presenter } from "./presenter";
import type { Confirmer } from "./confirm";
import type { Perception, WindowTarget } from "../perception";
import type { AtspiSidecar, AxNode, Bounds, ActionResult, ElementInfo, PointElement } from "../perception/sidecar";
import type { PolicyEngine, ActionKind, ActionRequest, ReadSource, TextMode, WindowId } from "../policy/policy";
import type { AuditEntry, AuditLog } from "../policy/audit";
import { inferLabels, quoteUntrusted as q, screenWord } from "../perception/elements";
import { canonicalKeys, foldLabel, isActivatingKey, isEmberWindow, isSecurityWindow, keyFamily, MOVES_CARET, replacesSelection, takesFormula, typedChar } from "../policy/policy";
import { SETTINGS, changeSetting, execArgv, findApp, isTerminalApp, launchApp, listApps, type DesktopApp, type SettingName } from "../hands/system";
import { BorrowStopped, CursorBorrow, UserTookOver, typeableText, type Hand } from "../hands/borrow";
import type { DeskPlace } from "../desk/place";
import { focusedElement, isSheetCell } from "../perception/elements";
import { SLIVER_PX } from "../perception/marks";
import { friendlyApp } from "../../shared/apps";
import type { Logger } from "../logger";
import type { SettingsStore } from "../settings";

export interface WorkerDeps {
  client: CopilotClient;
  log: Logger;
  model: string | null;
  vision: boolean;
  provider?: ProviderConfig;
  workDir: string;
  perception: Perception;
  sidecar: AtspiSidecar;
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
}

export interface TaskSpec {
  id: string;
  goal: string;
  /**
   * What the user said or typed in the turn that started the task (and in turns that changed it): risky steps are
   * checked against these, never against the goal the conductor wrote (it may have read screen text). Without
   * them (tests) the goal stands in.
   */
  userWords?: string;
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
/** Fields: the step is to be in one, so reaching it (Tab, a click) is using it. */
const FOCUS_IS_THE_STEP = /^(text|entry|password text|spin button|document text|paragraph|terminal)$/;
/** How long an app gets to notice the pointer over its window before Ember looks where to click again. */
const POINTER_SETTLE_MS = 100;
/** The control around an element that a click on the element goes to (a link around its text, a row around its label). */
type Handler = { role: string; name: string };
/** Items the pointer selects (and focuses) by only passing over them: menus, and the lists of a drop-down. */
const HOVER_SELECTS = /^(menu|menu item|check menu item|radio menu item|list item|tree item|table cell)$/;
const isUnder = (p: { x: number; y: number }, b: Bounds) => p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;

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
 * of others: a pane, a list), or told nothing. `spot`: where the mouse goes (see atSpot).
 */
export function aimedAt(chain: PointElement[], role: string, b: Bounds, ancestors: { role: string; bounds: Bounds | null }[] = [], spot?: { x: number; y: number }): "yes" | "other" | "unknown" {
  const here = spot ? atSpot(chain, spot) : chain;
  const last = here[here.length - 1];
  if (!last?.bounds || last.empty) return "unknown";
  if (last.role === role && sameRect(last.bounds, b)) return "yes";
  // Inside it: its own text, picture or label; or another control in it, which a click there would work instead.
  if (insideOf(last.bounds, b)) return CLICK_TAKERS.test(last.role) && !sameRect(last.bounds, b) ? "other" : "yes";
  if (!insideOf(b, last.bounds)) return "other";
  // Round it: what holds it (the app stopped there), or something else lying over it (a header's button).
  const holds = ancestors.some(a => a.role === last.role && !!a.bounds && sameRect(a.bounds, last.bounds!));
  return holds || HOLDERS.test(last.role) ? "unknown" : "other";
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
/** Interpreters and launchers: an app started through one isn't known by their name. */
const LAUNCHERS = /^(python[\d.]*|sh|bash|env|flatpak|java|perl|ruby|node|gjs|mono|gtk-launch)$/;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** The accessibility helper's word for an app that didn't answer in time (busy), as opposed to an element that is gone. */
const isBusy = (err: unknown) => /\bbusy\b|did not (receive a reply|answer)|timeout was reached/i.test(err instanceof Error ? err.message : String(err));
const BUSY = "The app is busy (it didn't answer in time). Wait a moment, then call perceive_window.";

/** How a waiting task's goal carries what the user added (tasks.ts). */
const STEERED = /\n\(The user then added: (.*)\)$/gm;

/**
 * What has the keyboard in a window: its role and name (or the label beside it), and whether it holds a secret. A
 * spreadsheet's cell says so (`grid`, see isSheetCell) and which sheet it is in (`sheet`: the sheet's name, as a
 * number: it goes to the audit log, which keeps no screen text).
 */
type Focus = { role: string; name: string; secret?: boolean; grid?: boolean; sheet?: number };
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
/** Shift with a key that moves the caret selects as it goes (Shift+Right, Ctrl+Shift+End). */
const SELECTS = /^(ctrl\+)?shift\+(up|down|left|right|home|end|prior|next)$/;
/**
 * After `keys` went into a field where this task had typed `typed`: what it has typed there now, and what is still
 * selected by the keys (until a key replaces it or moves the caret; Ctrl+C keeps it, and so do steps that move no
 * caret: a click on a toolbar button, a scroll). Moving the caret (arrows, Home, End), symbols and shortcuts keep what
 * was typed: pieces typed around a move are still judged together, and the field's own text with them (only another
 * field starts again).
 */
export function afterKeys(keys: string, typed: string, selected: Selected): { typed: string; selected: Selected } {
  const k = keyFamily(canonicalKeys(keys) ?? "");
  const char = typedChar(keys);
  if (k === "ctrl+a") return { typed, selected: "all" };
  if (SELECTS.test(k)) return { typed, selected: selected === "all" ? "all" : "some" };
  const replaced = !!selected && replacesSelection(keys);
  // Everything selected and replaced: what was typed there is gone. Part of it: which part is unknown, so it stays.
  const kept = replaced && selected === "all" ? "" : typed;
  const still = !replaced && !MOVES_CARET.test(k) ? selected : null;
  if (char !== null) return { typed: (kept + char).slice(-TYPED_MAX), selected: null };
  if (k === "backspace") return { typed: replaced ? kept : kept.slice(0, -1), selected: null };
  return { typed: kept, selected: still };
}
/**
 * Keys that only move the caret or the cell cursor (arrows, Home, End, Page Up and Down, with Ctrl too), and with Shift
 * select as they go (Shift+End): what a key then does to the selection is judged when it comes (afterSelecting).
 */
const MOVE_KEY = /^(ctrl\+)?(shift\+)?(up|down|left|right|home|end|prior|next)$/;
/** Text fields where those keys only move the caret, and where Tab only moves on (one-line fields; a cell, as below). */
const MOVES_IN = new Set(["text", "entry", "paragraph", "document text"]);
/** Does `keys` only move, in what has the keyboard (`focus`)? Never in lists, menus, sliders, spin buttons or combo boxes (an arrow there picks). */
function onlyMoves(keys: string, focus: Focus | undefined): boolean {
  if (!focus || focus.secret) return false;
  const k = keyFamily(canonicalKeys(keys) ?? "");
  const cell = isSheetCell(focus);
  if (/^(shift\+)?tab$/.test(k)) return cell || focus.role === "entry";
  return MOVE_KEY.test(k) && (cell || MOVES_IN.has(focus.role));
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
function keyText(keys: string): string | null {
  const c = typedChar(keys);
  if (c !== null) return c;
  const m = /^(shift\+)?(\w+)$/.exec(keyFamily(canonicalKeys(keys) ?? ""));
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
/** A spreadsheet cell's address as a model may give it ("B5", "$B$5", "b5"). */
const CELL_ARG = /^\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6}$/;
/** The most arrow keys Ember presses to reach a cell (from the cell with the keyboard, or from A1); a cell further off is reached through the Name Box. */
const CELL_STEPS_MAX = 300;
/** A cell's column (from 0) and row (from 1), by its address ("B5" → 1, 5). */
function cellPlace(address: string): { col: number; row: number } | null {
  const m = /^\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6})$/.exec(address.toUpperCase());
  return m ? { col: [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1, row: Number(m[2]) } : null;
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

/** The programs an app's windows belong to: its launcher's file name and its desktop id (never an interpreter's name). */
function programsOf(app: DesktopApp): Set<string> {
  const argv = app.exec ? execArgv(app.exec) : [];
  const names = [app.id.replace(/\.desktop$/, ""), ...argv.filter(a => !/^[-%]/.test(a)).map(a => path.basename(a))];
  return new Set(names.map(n => n.toLowerCase()).filter(n => n && !LAUNCHERS.test(n)));
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
  /** The user said no to a question (or let it go unanswered), and nothing was done after that. */
  private declined = false;
  /** The last authorize() asked the user (the screen may have changed while the question was up). */
  private asked = false;
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
  /** The user said yes to a key that only moves (onlyMoves) in this window (windowKey): more of those there go without a question. */
  private moving: string | null = null;
  /** What spreadsheet cells the latest read didn't list were found to hold, by window (windowKey) and address: the next question says it. */
  private cellsSeen = new Map<string, string>();

  constructor(private d: WorkerDeps, readonly spec: TaskSpec) {
    this.target = { ...spec.target };
    // The user's own words only ("The user then added" would make "user" and "added" asked-for words).
    this.userWords = (spec.userWords ?? spec.goal).replace(STEERED, "\n$1");
    // What Ember's conversation read on the user's screen before starting this task (its goal may carry it).
    if (spec.screen) this.read.set("described", { app: "", window: "", text: spec.screen.slice(0, READ_TEXT_MAX), described: true });
    this.window = { app: spec.target.app ?? "", name: spec.target.title ?? "" };
    this.clipboard = d.clipboard ? asPasteClipboard(d.clipboard) : null;
  }

  private get perception() { return this.place?.perception ?? this.d.perception; }
  private get sidecar() { return this.place?.sidecar ?? this.d.sidecar; }
  private get halted() { return this.halt.signal.aborted; }
  /** Ended by finish_task (or run() returning): a tool still in flight (a question, a window wait) then does nothing. */
  private ended = new AbortController();
  /** Aborts when the task stops or ends: questions, window waits and borrows give up on it. */
  private overSignal = AbortSignal.any([this.halt.signal, this.ended.signal]);
  private get isOver() { return this.halted || this.ended.signal.aborted; }
  /** Ember flies to controls on the user's screen; desk work shows in the mini-view instead. */
  private fly(b: Bounds | null): void { if (!this.place) this.d.flyTo(b); }

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

  private async runTool<S extends z.ZodType>(name: string, parameters: S, handler: (a: z.infer<S>) => Promise<ToolResultObject | string>, raw: unknown, maxSteps: number): Promise<ToolResultObject | string> {
    if (this.halted) return STOPPED();
    if (this.result) return denied("The task is already finished. Stop now.");
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
            const isOn = now ? now.states.includes("checked") || now.states.includes("pressed") : null;
            if (isOn === a.on) return done(`Already ${a.on ? "on" : "off"}: ${describeAfter(now!)}`);
            // Its action would do nothing (Chromium's "uncheck" on a radio button): a radio button goes off when another goes on.
            if (isOn && /^radio/.test(now!.role)) return fail("A radio button turns off only when another one in its group is chosen: toggle that one on instead.");
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
      this.tool("choose_option", "Choose an option in a combo box, drop-down or list by its full visible name.",
        z.object({ id, option: z.string().min(1).max(200) }),
        async a => this.chooseOption(a.id, a.option)),
      this.tool("set_value", "Set a slider or spin button to a number.", z.object({ id, value: z.number().finite() }),
        async a => this.act("value", a.id, String(a.value), () => this.sidecar.setValue(a.id, a.value))),
      this.tool("change_setting", `Change a desktop setting directly: ${Object.entries(SETTINGS).map(([k, v]) => `${k} (${v})`).join("; ")}.`,
        z.object({
          setting: z.enum(Object.keys(SETTINGS) as [SettingName, ...SettingName[]]),
          value: z.string().max(20).describe('"on"/"off", or a number for text_size'),
        }),
        async a => this.system("setting", `${SETTINGS[a.setting]} → ${a.value}`, async () => {
          const r = await changeSetting(a.setting, a.value);
          return `${SETTINGS[a.setting]}: was ${r.before}, now ${r.after}.`;
        })),
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
              const w = wins.find(x => pid !== undefined && x.pid === pid) ?? wins.find(x => !before.has(key(x)));
              if (w) { this.target = { title: w.name, pid: w.pid ?? undefined }; this.window = { app: w.app, name: w.name }; return `Opened ${app.name} on your desk (window ${q(w.name, 100)}). Everything you do now happens there. Save results in ${place.info.handOff}. Call perceive_window.`; }
            }
            return `Started ${app.name} on your desk, but its window hasn't appeared yet. Use list_windows.`;
          }, app.name);
        })] : []),
      this.tool("open_app", "Start an application by name (for example Text Editor, Files, Settings).", z.object({ name: z.string().min(1).max(100) }),
        async a => {
          const app = findApp(listApps(), a.name);
          if (!app) return fail(`No installed app matches ${q(a.name, 100)}.`);
          if (isTerminalApp(app)) return this.refuse("open_app", "Ember doesn't run terminals", "Not allowed: Ember doesn't run terminals or shells. Don't try another way; tell the user in finish_task.", { app: app.name, value: app.name });
          return this.system("open_app", app.name, async () => {
            if (this.isOver) throw new BorrowStopped();
            this.setPlace(null);
            // The app's window is a new one of its program (or titled after it); an app that was already open
            // (it only raises its window) is found by its program, never by a title that happens to contain its name.
            const key = (w: { pid: number | null; name: string }) => `${w.pid}:${w.name}`;
            const before = new Set((await this.perception.windows().catch(() => [])).map(key));
            const programs = programsOf(app);
            const ours = (w: { app: string }) => programs.has(w.app.toLowerCase());
            launchApp(app);
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
          "Press a key or shortcut in the window you are working in, e.g. \"ctrl+s\", \"Return\", \"ctrl+shift+t\". Borrows the user's keyboard, so the user is asked first; prefer element tools when they work.",
          z.object({ keys: z.string().min(1).max(40) }),
          async a => this.pressKeys(a.keys)),
        this.tool("scroll", "Scroll an element (a list, document or page) up or down by a few steps. Borrows the user's mouse, so the user is asked first.",
          z.object({ id, direction: z.enum(["up", "down", "left", "right"]), steps: z.number().int().min(1).max(30).optional() }),
          async a => this.scroll(a.id, a.direction, a.steps ?? 5)),
      ] : []),
      this.tool("point_at", "Point at an element so the user can do this step themselves: Ember flies next to it, highlights it and shows your short instruction.",
        z.object({ id, say: z.string().min(1).max(160).describe("A short instruction, e.g. \"Click Display\"") }),
        async a => {
          const node = this.known.get(a.id);
          if (!node?.bounds) return fail(`Element ${a.id} is not in your latest perceive_window (or has no position). Call perceive_window.`);
          // Where it is now (LibreOffice reports places 25 px off until the pointer has been over its window).
          const live = await this.sidecar.readElement(a.id).catch(() => null);
          if (this.isOver) return STOPPED();
          this.guideStep++;
          this.fly(live?.bounds && live.role === node.role ? live.bounds : node.bounds);
          this.d.presenter.guide(a.say, `Step ${this.guideStep}`);
          this.audit({ event: "action", task: this.spec.id, kind: "point", app: this.window.app, element: { role: node.role, name: this.nameOf(a.id, node) }, ok: true });
          return done(`Pointing at [${a.id}]. Now call wait_for_click with id ${a.id}.`);
        }),
      this.tool("wait_for_click", "Wait until the user clicks the element you pointed at (or it changes, e.g. a switch turns on, or the window changes).",
        z.object({ id, timeoutSeconds: z.number().int().min(5).max(300).optional() }),
        async a => this.waitForClick(a.id, (a.timeoutSeconds ?? 90) * 1000)),
      this.tool("report_progress", "Tell the user briefly how the task is going (shown on Ember's task card).", z.object({ text: z.string().max(200) }),
        async a => { this.d.onProgress(a.text); return done("Shown."); }),
      this.tool("finish_task", "End the task with a one or two sentence summary for the user.",
        z.object({ success: z.boolean(), summary: z.string().max(400) }),
        async a => {
          this.result = { success: a.success, summary: a.summary };
          this.ended.abort();
          // The task is over: end the turn, so a model that keeps going can't act any more.
          setTimeout(() => { void this.session?.abort().catch(() => undefined); }, 50);
          return done("Task closed. Stop now.");
        }),
    ];
  }

  async run(signal: AbortSignal): Promise<WorkerResult> {
    const d = this.d;
    // Stopped before it began (Stop pressed right after asking): nothing is created or sent.
    if (signal.aborted) return { success: false, summary: "Stopped.", stopped: true };
    // Never the runtime's default model: it may be one the administrator didn't allow.
    if (!d.model) return { success: false, summary: "No model is available for tasks. Pick one in settings (Ctrl+Alt+E)." };
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
        model: d.model,
        provider: d.provider,
        tools,
        systemMessage: this.spec.mode === "guide" ? guideSystemMessage() : workerSystemMessage(),
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
          if (name !== "report_progress" && name !== "finish_task" && TOOL_STEPS[name]) d.onProgress(`${TOOL_STEPS[name]}…`);
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
            wait = idle();
            await send("Call finish_task now with a short summary of what you did.");
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
    if (this.halted && this.haltReason === null) return { success: false, summary: "Stopped.", stopped: true };
    if (this.haltReason) return { success: false, summary: this.result?.summary ? `${this.haltReason} ${this.result.summary}` : this.haltReason };
    // The user said "Not now" and nothing was done after it: that's the user's choice, not a failure.
    if (this.declined && !this.result?.success) return { success: false, stopped: true, declined: true, summary: this.result?.summary || "You said not now, so I left it." };
    const result = this.result ?? { success: false, summary: lastAnswer || "The worker stopped without a summary." };
    return this.userTookOver && !result.success ? { ...result, stopped: true } : result;
  }

  /**
   * The user's new instruction for this running task ("use Firefox instead"); `userWords`: what the user said in that
   * turn; `screen`: what the conversation read on the screen then.
   */
  async steer(text: string, userWords?: string, screen?: string): Promise<boolean> {
    if (!this.session || this.halted || this.result) return false;
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

  /** Guide mode: done when the user presses inside the element, the element changes, or the window does. */
  private async waitForClick(id: number, timeoutMs: number): Promise<ToolResultObject> {
    const node = this.known.get(id);
    if (!node?.bounds) return fail(`Element ${id} is not in your latest perceive_window. Call perceive_window.`);
    // Where it is, as each look finds it (LibreOffice reports places 25 px off until the pointer has been over its window).
    let b = node.bounds;
    const pad = 4;
    const inside = (p: { x: number; y: number }) => p.x >= b.x - pad && p.y >= b.y - pad && p.x < b.x + b.width + pad && p.y < b.y + b.height + pad;
    const before = await this.sidecar.readElement(id).catch(() => null);
    if (before?.bounds && before.role === node.role) b = before.bounds;
    // What counts is the user using it, never only reaching it (a hover selects a menu item, Tab focuses a button): a
    // press inside it; checked, pressed, expanded, a value, an option chosen, a menu opened (also with Alt+F or F10), a
    // tab or row selected, a field focused, the element gone. And once the user reached it (it had the keyboard, or was
    // the selected item): Enter or Space on it, or another window taking the keyboard (a menu item chosen with the
    // keyboard opened its dialog).
    const marks = ["checked", "pressed", "expanded",
      ...(HOVER_SELECTS.test(node.role) || ACTS_ITSELF.test(node.role) ? [] : ["selected"]), ...(FOCUS_IS_THE_STEP.test(node.role) ? ["focused"] : [])];
    const key = (e: ElementInfo | null) => (e ? `${e.states.filter(s => marks.includes(s)).sort().join(",")}|${e.selected ?? ""}|${e.value ?? ""}|${e.open ?? ""}` : "gone");
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
    const usedIt = async (how: string) => {
      await new Promise(r => setTimeout(r, 400)); // let the app react before the next look
      this.audit({ event: "action", task: this.spec.id, kind: "user_clicked", app: this.window.app, element: { role: node.role, name: node.name }, ok: true });
      return done(`${how} Call perceive_window to see what changed.`);
    };
    const t0 = Date.now();
    let wasDown = (this.d.pointer?.()?.mask ?? 0) & 256;
    let keyWasDown = keyDown();
    let lastCheck = 0;
    while (Date.now() - t0 < timeoutMs) {
      if (this.isOver) return STOPPED();
      const p = this.d.pointer?.();
      const down = (p?.mask ?? 0) & 256;
      if (p && down && !wasDown && inside(p)) return usedIt("The user clicked it.");
      wasDown = down;
      // Enter or Space, while it has the keyboard (or is the menu item selected).
      const pressing = keyDown();
      if (pressing && !keyWasDown && reached(await this.sidecar.readElement(id).catch(() => null))) return usedIt("The user pressed Enter or Space on it.");
      keyWasDown = pressing;
      if (Date.now() - lastCheck > 500) {
        lastCheck = Date.now();
        const now = await this.sidecar.readElement(id).catch(() => null);
        if (key(now) !== key(before)) {
          return done(now ? `It changed: ${describeAfter(now)}. Call perceive_window for the next step.` : "The window changed (the element is gone). Call perceive_window.");
        }
        if (now?.bounds && now.role === node.role) b = now.bounds;
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
        if (w && wasReached && windowBefore && w.title.trim() && (w.title !== windowBefore.title || w.app !== windowBefore.app)) {
          return done(`Another window has the keyboard now (${q(w.title, 80)}), right after the user reached the element pointed at: they most likely chose it with the keyboard. Call perceive_window to see where they are.`);
        }
      }
      await new Promise(r => setTimeout(r, 30));
    }
    return done("The user hasn't clicked it yet. Finish kindly, saying where they got to, unless the goal is already done.");
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
    const result: ToolResultObject = { textResultForLlm: p.text, resultType: "success" };
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
   * dialog says, so the policy reads the dialog, not just the window's title.
   */
  private dialogOf(id: number): { name: string; text: string } | undefined {
    const DIALOG = /^(dialog|alert|file chooser|color chooser|font chooser)$/;
    let cur = this.known.get(id);
    for (let i = 0; cur && i < 40; i++) {
      if (DIALOG.test(cur.role)) {
        const top = cur.id;
        const inside = (n: AxNode) => { let p = n.parent; for (let j = 0; p !== null && j < 40; j++) { if (p === top) return true; p = this.known.get(p)?.parent ?? null; } return false; };
        const words = [...this.known.values()].filter(n => inside(n) && /label|static|heading|paragraph|text/.test(n.role) && !n.secret)
          .map(n => n.name || n.text || "").filter(Boolean).join(" ");
        return { name: cur.name, text: words.slice(0, 400) };
      }
      cur = cur.parent !== null ? this.known.get(cur.parent) : undefined;
    }
    return undefined;
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
    const current: AxNode = { ...node, name: live.name, states: live.states, bounds: live.bounds ?? node.bounds, text: live.text ?? node.text, secret: live.secret ?? node.secret };
    this.known.set(id, current);
    return { node: current, element: this.elementOf(id, current) };
  }

  /** Element `id` as the policy and the audit log see it: its name (or the label beside it), and whether the reader found it secret. */
  private elementOf(id: number, n: Pick<AxNode, "role" | "name" | "secret" | "grid" | "parent">): Focus {
    return { role: n.role, name: this.nameOf(id, n), ...(n.secret ? { secret: true } : {}), ...cellOf(n, p => this.known.get(p)) };
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

  /** After a question was up, the element must still be the one the user said yes to. */
  private async stillSame(id: number, element: Focus): Promise<ToolResultObject | null> {
    if (!this.asked) return null;
    const live = await this.sidecar.readElement(id).catch(() => null);
    if (this.isOver) return STOPPED();
    const name = live ? this.nameOf(id, live) : null;
    if (!live || live.role !== element.role || name !== element.name) {
      return fail(`Element ${id} changed while the user was deciding, so nothing was done. Call perceive_window and ask again if it's still needed.`);
    }
    return null;
  }

  /** choose_option: the option is found first (its full name, never a part of one), and the policy judges the one that will be chosen. */
  private async chooseOption(id: number, option: string): Promise<ToolResultObject> {
    if (!this.known.has(id)) return fail(`Element ${id} is not in your latest perceive_window. Call perceive_window and use its ids.`);
    let error = "";
    const options = await this.sidecar.listOptions(id).then(r => r.options, (err: unknown) => { error = err instanceof Error ? err.message : String(err); return null; });
    if (this.isOver) return STOPPED();
    if (!options) {
      if (error.includes("background_unavailable")) return fail("That element has no options Ember can choose by accessibility. This can't be done without the mouse; tell the user in finish_task.");
      return fail(isBusy(error) ? BUSY : `Its options couldn't be read: ${q(error, 200)}. Call perceive_window.`);
    }
    const chosen = pickOption(options, option);
    if (chosen === null) {
      return fail(`No option is called exactly ${q(option, 100)}. <options untrusted="true">${options.slice(0, 40).map(o => q(o, 60)).join(", ")}</options> Use one of these names in full.`);
    }
    return this.act("select", id, chosen, () => this.sidecar.selectOption(id, chosen));
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
    const { handler } = route;
    if (route.via === "borrow") {
      this.d.log.info("router.escalate", { task: this.spec.id, from: "tier1", to: this.place ? "tier2-desk" : "tier3", kind, role: node.role, probed: true });
      return this.cursorAct(kind === "text" ? "cursor_text" : "cursor_click", id, node, value, mode, overSelection, kind === "toggle", handler);
    }
    const judged: TextMode = overSelection ? "replace" : mode ?? "replace";
    // Text added to a field is judged after what this task typed there before.
    const field = this.fieldOf(element);
    const prior = kind === "text" && judged !== "replace" ? this.typedIn.get(field) ?? "" : "";
    const base: ActionRequest = {
      taskId: this.spec.id, kind, app: this.window.app, window: this.window.name, element, value,
      ...(kind === "text" ? { mode: judged, currentText: node.text, ...(prior ? { typed: prior + (value ?? "") } : {}), ...this.formulaOf(node, value, judged) } : {}),
      ...(dialog ? { dialog } : {}),
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
      const isOn = now ? now.states.includes("checked") || now.states.includes("pressed") : null;
      if (now && isOn === (value === "on")) return done(`Already ${value}: ${describeAfter(now)}`);
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
      // Edit ▸ Select All selects everything, as Ctrl+A does: a key that types replaces it all.
      if (kind === "click" && res.ok) this.noteSelectAll(element);
      // A click that closes its own dialog (Close, OK, Save) leaves nothing to read back: done, not an error.
      const after = res.after as ElementInfo | null | undefined;
      const busyAfter = (res as { busy?: boolean }).busy === true;
      if (after) this.known.set(id, { ...node, name: after.name, states: after.states, bounds: after.bounds ?? node.bounds });
      // A field can say yes and still not take the text (read-only, or fewer characters allowed).
      const holds = kind === "text" && res.ok && after ? textNotTaken(after, value ?? "", mode ?? "replace") : null;
      // Done by accessibility on Ember's desk: "What Ember did" says so (tier 2), not that it was the user's own app.
      this.audit({ event: "action", task: this.spec.id, kind, app: req.app, window: req.window, element: req.element, ok: res.ok && holds === null, ...(this.place ? { tier: 2 } : {}), ...auditValue(req), ...(after ? { after: { states: after.states, selected: after.selected } } : busyAfter ? { busy: true } : { gone: true }) });
      if (holds !== null) return fail(`The field didn't take the text as asked: it now holds ${q(holds, 200)} (it may be read-only, or take fewer characters). Tell the user in finish_task if it matters.`);
      const outcome = res.ok ? "Done" : "The app reported it did not work";
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
        return this.cursorAct(kind === "text" ? "cursor_text" : "cursor_click", id, node, value, mode, overSelection, kind === "toggle", handler);
      }
      // A slow app may still carry out a request after Ember stopped waiting for it.
      if (/did not answer/.test(msg)) return fail("The app didn't answer in time, so it's unknown whether this happened. Call perceive_window to check before trying again.");
      if (isBusy(msg)) return fail(BUSY);
      // The helper's words can carry the app's own text: quoted, like everything from the screen.
      return fail(`It didn't work: ${q(msg, 300)}. Call perceive_window to see the window as it is now.`);
    } finally {
      release();
    }
  }

  /**
   * How `kind` can be done on element `id`, found out before anything is asked: via "tier1" (by accessibility; also
   * when the helper can't tell, and then the mouse is borrowed if it can't after all), via "borrow" (the mouse is the
   * only way), or the tool result when neither can. For a click, `handler`: the control around the element that the
   * click goes to, when the helper found one.
   */
  private async route(kind: ActionKind, id: number, node: AxNode, element: Focus, mode?: TextMode): Promise<{ via: "tier1" | "borrow"; handler?: Handler } | ToolResultObject> {
    if ((kind !== "click" && kind !== "toggle" && kind !== "text" && kind !== "value") || typeof this.sidecar.canDo !== "function") return { via: "tier1" };
    const insert = kind === "text" && mode === "insert";
    const can = await this.sidecar.canDo(id, kind, insert).catch(() => null);
    const handler = (kind === "click" || kind === "toggle") && can?.handler ? { role: String(can.handler.role), name: String(can.handler.name ?? "") } : undefined;
    // The click goes to a control around it that lies too deep for Ember to find: what it works can't be told, so it isn't done.
    if ((kind === "click" || kind === "toggle") && can?.handlerUnknown) {
      this.audit({ event: "action", task: this.spec.id, kind, app: this.window.app, window: this.window.name, element, ok: false, ...(this.place ? { tier: 2 } : {}), error: "the control a click goes to can't be found" });
      return fail(`Ember can't tell what a click on element ${id} works: the page hands it to a control around it that lies too deep for Ember to find, so nothing was clicked. Click the link or button itself instead, or tell the user in finish_task.`);
    }
    if (!can || can.tier1) return { via: "tier1", ...(handler ? { handler } : {}) };
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
    return { via: "borrow", ...(handler ? { handler } : {}) };
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
      return fail(`This element (${q(node.role, 40)}) doesn't take text by accessibility, and it isn't a text field Ember may type into with the keyboard (there Ctrl+A and Delete could hit far more than it). Tell the user in finish_task.`);
    }
    // A spreadsheet's cell that takes no number this way takes it typed: type_text fills a cell by its address.
    if (kind === "value" && isSheetCell(node)) return fail(`Cell ${q(node.name, 20)} takes no number by accessibility: use type_text with cell ${q(node.name, 20)} and the number as text.`);
    return fail(`The app can't do this by accessibility (${q(why, 200)}). This can't be done without the mouse; tell the user in finish_task.`);
  }

  /**
   * Tier 3: borrow the mouse (and keyboard) for one action, with the user's OK. `overSelection`: Ctrl+A selected
   * everything before this text goes in at the caret (it is judged as replacing it all). `toggle`: the click turns a
   * switch `value` ("on" or "off"). `handler`: the control around the element that the click goes to (see clickJudged).
   */
  private async cursorAct(kind: "cursor_click" | "cursor_text", id: number, node: AxNode, value?: string, mode: TextMode = "replace", overSelection = false, toggle = false, handler?: Handler): Promise<ToolResultObject> {
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
      ...(kind === "cursor_text" ? { mode: judged, currentText: node.text, ...(prior ? { typed: prior + text } : {}), ...this.formulaOf(node, text, judged) } : {}),
      ...(dialog ? { dialog } : {}) };
    const verdict = await this.authorize(kind === "cursor_click" ? { ...base, element: this.clickJudged(base, element, handler) } : base);
    if (verdict) return verdict;
    // Where it is now: the window may have moved or scrolled while the user decided.
    const live = await this.sidecar.readElement(id).catch(() => null);
    if (this.isOver) return STOPPED();
    if (!live?.bounds || live.role !== node.role || this.nameOf(id, live) !== element.name) {
      return fail(`Element ${id} moved or changed while the user was deciding, so nothing was done. Call perceive_window and try again.`);
    }
    // A switch the user flipped while deciding may already be where it should be: a click would undo it.
    if (toggle && this.asked && (live.states.includes("checked") || live.states.includes("pressed")) === (value === "on")) {
      return done(`Already ${value}: ${describeAfter(live)}`);
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
        if (mode === "replace") { await hand.keys("ctrl+a"); await hand.keys("Delete"); }
        else if (mode === "append") await hand.keys("ctrl+End");
        if (!paste) { await hand.type(text); return; }
        // What the field holds before the paste: the text must be new there (the field may hold these words already).
        const prior = await this.sidecar.readElement(id).catch(() => null);
        pasting.before = prior && !prior.secret ? prior.text : undefined;
        if (this.isOver) throw new BorrowStopped();
        await this.clipboard!.writeText(text);
        pasting.written = true;
        pasting.pressed = true;
        await hand.keys("ctrl+v");
      }, id, async () => {
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
    if (kind === "cursor_click" && result.resultType === "success") this.noteSelectAll(element);
    // What the click hit, as the app said where the pointer was: not only the element meant.
    if (landedOn && kind === "cursor_click" && result.resultType === "success") {
      result = { ...result, textResultForLlm: `${result.textResultForLlm} The click landed on ${screenWord(landedOn.role)}${landedOn.name ? ` ${q(landedOn.name, 80)}` : ""}.` };
    }
    if (!passwordDropped) return result;
    return { ...result, textResultForLlm: `${result.textResultForLlm} The user's clipboard held a password from their password manager, so Ember didn't put it back (its timer couldn't clear it again): tell the user it is no longer on the clipboard.` };
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
      const seen = aimedAt(here, now.role, now.bounds, ancestors);
      if (seen === "yes") return { ...s, there: here[here.length - 1] };
      if (seen === "unknown") {
        if (other) continue;
        return s;
      }
      other ??= here[here.length - 1];
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
    const cell = address.replace(/\$/g, "").toUpperCase();
    const place = CELL_ARG.test(address) ? cellPlace(cell) : null;
    if (!place) return fail(`${q(address, 20)} isn't a cell's address (like B5).`);
    if (this.place?.userInControl()) return this.deskTaken("cursor_text");
    if (mode !== "replace") return fail(`In a spreadsheet's cell Ember replaces what the cell holds: call type_text with mode "replace" and the cell's whole new content.`);
    if (/[\n\r\t]/.test(text)) return fail("A cell takes one line: a line break or tab would move to another cell. Put each value in its own cell.");
    if (!typeableText(text)) return fail("Ember fills a cell with the keyboard, and can only type plain ASCII letters, digits and punctuation there. Tell the user in finish_task.");
    if (!this.place && !this.d.cursor) return fail("Filling a cell needs the keyboard, which isn't available here. Try open_on_desk.");
    if (![...this.known.values()].some(n => isSheetCell(n))) return fail("Your latest perceive_window shows no spreadsheet cells. Call perceive_window in the spreadsheet's window first.");
    // What it holds: as the latest read listed it, or as Ember found it before; unknown for a cell not listed (empty, or scrolled away).
    const listed = [...this.known.values()].find(n => isSheetCell(n) && n.name.replace(/\$/g, "") === cell);
    const seenKey = `${this.windowKey}\n${cell}`;
    const expected = listed && !listed.secret ? listed.text ?? "" : this.cellsSeen.get(seenKey);
    if (listed?.secret) return fail(`Cell ${cell} holds something secret: Ember doesn't type there.`);
    const element: Focus = { role: "table cell", name: cell };
    const verdict = await this.authorize({ taskId: this.spec.id, kind: "cursor_text", app: this.window.app, window: this.window.name, element, value: text, mode: "replace",
      ...(expected !== undefined ? { currentText: expected } : {}) });
    if (verdict) return verdict;
    const steps = (a: { col: number; row: number }, b: { col: number; row: number }) => Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
    const result = await this.withCursor("cursor_text", element, async hand => {
      // Text the keyboard layout can't type is refused before any key goes in.
      if (typeof hand.checkTyping === "function") hand.checkTyping(text);
      const start = await this.cellWithKeyboard(undefined, this.cursorHints(cell));
      if (!start) throw new Error("No cell of the spreadsheet has the keyboard in that window (a cell may be being edited: press Escape; or a dialog is open), so nothing was typed. Call perceive_window.");
      let at = cellPlace(start.name) ?? { col: 0, row: 1 };
      const fromA1 = place.col + place.row - 1;
      // Far from both the cell cursor and A1: the Name Box takes it there.
      const byName = Math.min(steps(at, place), fromA1) > CELL_STEPS_MAX;
      if (byName) await this.toCellByName(hand, cell);
      else {
        if (steps(at, place) > fromA1) { await hand.keys("ctrl+Home"); at = { col: 0, row: 1 }; }
        for (let i = 0; i < Math.abs(place.col - at.col); i++) await hand.keys(place.col > at.col ? "Right" : "Left");
        for (let i = 0; i < Math.abs(place.row - at.row); i++) await hand.keys(place.row > at.row ? "Down" : "Up");
      }
      const there = await this.cellWithKeyboard(cell);
      if (there?.name !== cell) {
        const how = byName ? "through the Name Box" : "with the arrow keys (hidden rows or columns, or merged cells, may be in the way)";
        // No cell has the keyboard: one may still be being edited (the arrow keys then move in its text).
        const editing = there ? "" : " A cell may still be being edited: press Escape, call perceive_window, and try again.";
        throw new Error(`Ember couldn't reach ${cell} ${how}: the cell cursor is on ${there ? there.name : "no cell Ember can see"} now, and nothing was typed.${editing || " Tell the user in finish_task."}`);
      }
      if (there.text !== (expected ?? "")) {
        this.cellsSeen.set(seenKey, there.text);
        throw new Error(`${cell} holds ${q(there.text, 80)}${expected === undefined ? "" : ` now, not ${q(expected, 40)}`}, which the user wasn't asked about, so nothing was typed. If it should be replaced, call type_text again: the question will say what goes.`);
      }
      if (!text) { await this.clearCell(hand); return; }
      await hand.type(text);
      await hand.keys("Delete");
      await hand.keys("Return");
    });
    if (result.resultType === "success") {
      // What Ember just put there is what it holds now (typed again, the question says so: no second question); a
      // formula shows what it works out to, unknown here.
      if (/^\s*[=+\-@]/.test(text)) this.cellsSeen.delete(seenKey);
      else {
        this.cellsSeen.set(seenKey, text);
        if (listed) this.known.set(listed.id, { ...listed, text });
      }
      this.noteTyped(this.fieldOf(element), text);
      return done(`Done: ${text ? `typed ${q(text, 80)} into ${cell} and pressed Enter (the cell cursor moved on)` : `cleared ${cell} and pressed Enter (the cell cursor moved on)`}. Call perceive_window to see what the cell shows now.`);
    }
    return result;
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
   * Box itself: the address is never typed into a cell or another field. Otherwise Escape, and an error.
   */
  private async toCellByName(hand: Hand, cell: string): Promise<void> {
    await hand.keys("ctrl+shift+F5");
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
    await hand.type(cell);
    await hand.keys("Return");
  }

  /**
   * The spreadsheet cell with the keyboard in the working window (its address and what it holds), or null. `want`: the
   * cell it should be by now: the app is given a moment to get there (a look may come before the last arrow key is seen).
   * The read looks in `want` and `near` first (see cursorHints): in a big, zoomed-out sheet it can't ask every cell.
   */
  private async cellWithKeyboard(want?: string, near: string[] = []): Promise<{ name: string; text: string } | null> {
    const cells = [...new Set([...(want ? [want] : []), ...near])];
    for (let i = 0; ; i++) {
      const seen = await this.perception.read(this.target, null, undefined, { keep: false, cells }).catch(() => null);
      if (this.isOver) throw new BorrowStopped();
      const f = seen?.window && !seen.blocked ? focusedElement(seen.nodes) : null;
      const cell = f && isSheetCell(f) && !f.secret ? { name: f.name.replace(/\$/g, ""), text: f.text ?? "" } : null;
      if (!want || cell?.name === want || i >= 5) return cell;
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
      if (seen?.window && f) {
        return { role: f.role, name: f.name || inferLabels(seen.nodes).get(f.id) || "", ...(f.secret ? { secret: true } : {}), ...cellOf(f, byId) };
      }
      if (!wait || i >= 2 || this.isOver) return !seen ? "busy" : !seen.window ? (seen.busy ? "busy" : "gone") : undefined;
      await sleep(150);
    }
  }

  /**
   * focusIn, given a moment to settle (FOCUS_SETTLE_MS): LibreOffice moves the keyboard focus between its paragraph, its
   * root pane and nothing as its window comes to the front. Looks again while what it finds is nothing, a frame or a
   * root pane (not yet known), or, with `o.want`, isn't that (unless that was nothing and now a real element has it).
   */
  private async steadyFocus(wait: boolean, o?: { want: Focus | undefined }): Promise<Focus | undefined | "blocked" | "gone" | "busy"> {
    const t0 = Date.now();
    for (;;) {
      const look = await this.focusIn(wait);
      if (look === "blocked" || look === "gone" || look === "busy" || this.isOver) return look;
      const settled = o ? sameFocus(look, o.want) || (o.want === undefined && !unsureFocus(look)) : !unsureFocus(look);
      if (settled || Date.now() - t0 >= FOCUS_SETTLE_MS) return look;
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
    const activating = isActivatingKey(keys);
    // Letters and digits typed key by key are judged as typed text (text read elsewhere is asked about): with what the
    // field holds (the caret may be anywhere in it) and after what this task typed there before. A key that types
    // replaces what is selected: the policy judges the selection the screen reader tells, and what the keys selected.
    const here = this.windowKey;
    if (this.keyed.window !== here) this.keyed = { window: here, selected: null };
    const char = typedChar(keys);
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
        ...(this.focusFormula !== undefined ? { formula: this.focusFormula + (keyText(keys) ?? "") } : {}),
      };
      // On the user's screen, once they said yes to a key that only moves here, more of those go without a question.
      const moves = !this.place && onlyMoves(keys, element);
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
        // Nothing known before and something harmless now is what the user said yes to ("I can't tell what it will activate").
        if (!sameFocus(now, approved) && !(approved === undefined && now && this.harmlessKeys({ ...req, element: now }))) {
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
          const next = afterKeys(keys, this.typedIn.get(into) ?? "", this.keyed.selected);
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
  private guardedHand(hand: Hand, check: () => void): Hand {
    return {
      ...hand,
      glideTo: async (x, y) => { check(); await hand.glideTo(x, y); },
      click: async b => { check(); await hand.click(b); },
      keys: async k => { check(); await hand.keys(k); },
      type: async t => {
        // All or nothing: text the keyboard layout can't type is refused before the first key (then typed a few letters at a time).
        if ("checkTyping" in hand && typeof hand.checkTyping === "function") hand.checkTyping(t);
        for (const part of t.match(/[\s\S]{1,8}/g) ?? []) { check(); await hand.type(part); }
      },
      scroll: async (dir, n) => { check(); await hand.scroll(dir, n); },
    };
  }

  /** `afterBorrow`: runs once the mouse is given back, before the result is told (a paste waits for its text there). */
  /** What the action lines of the input under way record beyond its kind (the keys pressed: "What Ember did" names them). */
  private inputValue: Record<string, unknown> = {};

  private async withCursor(kind: ActionKind, element: Focus | undefined, fn: (hand: Hand) => Promise<void>, verifyId?: number, afterBorrow?: () => Promise<void>): Promise<ToolResultObject> {
    if (this.isOver) return STOPPED();
    if (this.place) return this.onDeskInput(this.place, kind, element, fn, verifyId, afterBorrow);
    if (!this.d.cursor) return fail("This needs the mouse or keyboard, which isn't available here. Try open_on_desk.");
    const c = this.d.cursor;
    // A password or authentication prompt has the keyboard: those are the user's alone (M8.3).
    const authPrompt = () => { const w = c.activeWindow?.(); return !!w && isSecurityWindow(w); };
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
    const borrowed = c.borrow.borrow(hand => fn(this.guardedHand(hand, check)), {
      window: win,
      signal: this.overSignal,
      onStart: () => c.setBorrowing("active"),
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
    const win = place.input.findWindow(this.window.name, this.target.pid);
    if (!win) {
      release();
      this.audit({ event: "action", task: this.spec.id, kind, app: this.window.app, window: this.window.name, element, ok: false, tier: 2, error: "the window couldn't be told apart (none or several with that title)" });
      return fail("Ember can't tell which window on its desk that is (none or several have that title). Call perceive_window.");
    }
    try {
      await deskBorrow.borrow(hand => { check(); return fn(this.guardedHand(hand, check)); }, { idleMs: 0, window: win, signal: this.overSignal });
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
    const inWindow = request.kind !== "open_app" && request.kind !== "setting";
    // What the keys selected ends where text goes in, or the mouse clicks or types into a text field (that moves the
    // caret). A click by accessibility (a toolbar button), a scroll or a look move no caret: the selection stays.
    if (request.kind === "text" || request.kind === "cursor_text" || (request.kind === "cursor_click" && TYPING_ROLES.has(request.element?.role ?? ""))) {
      this.keyed = { window: "", selected: null };
    }
    if (request.kind !== "keys") this.moving = null;
    // Text going into a field is judged after what this task typed into the window's other fields too.
    const adds = request.kind === "text" || request.kind === "cursor_text" ? request.value ?? "" : request.kind === "keys" ? typedChar(request.value ?? "") ?? "" : "";
    const typedHere = adds && inWindow ? this.typedHere(this.fieldOf(request.element), adds) : undefined;
    const req = { ...request, ...(typedHere ? { typedHere } : {}), onDesk: !!this.place, goal: this.userWords, readFrom: [...this.read.values()], ...(inWindow ? { windowId: this.windowId } : {}) };
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
    const sessionAllowed = decision.verdict === "confirm" && !decision.risky && !decision.everyTime && !this.tainted && this.allowedApps.has(req.app.toLowerCase());
    this.audit({ event: "decision", task: this.spec.id, kind: req.kind, app: req.app, window: req.window, element: req.element, ...auditValue(req), tier: decision.tier, verdict: sessionAllowed ? "allow" : decision.verdict, reason: decision.reason, ...(decision.aligned === false ? { aligned: false } : {}) });
    if (decision.verdict === "deny") return denied(`Not allowed: ${decision.reason}. Don't try another way; tell the user in finish_task.`);
    if (decision.verdict === "allow" || sessionAllowed) return null;
    // "Always in this app" isn't offered once something on screen tried to steer Ember.
    const remember = !!decision.needsGrant && !!decision.remember && !!req.app && !this.tainted;
    const options = remember
      ? [{ id: "once", label: "Allow", primary: true }, { id: "always", label: `Always in ${friendlyApp(req.app)}` }, { id: "deny", label: "Not now" }]
      : [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }];
    const context = this.spec.goal.length > 40 ? this.spec.goal.slice(0, 39) + "…" : this.spec.goal;
    this.asked = true;
    const answer = await this.d.confirmer.ask({ title: "May I?", context, prompt: decision.prompt, options, task: this.spec.id }, this.overSignal);
    this.audit({ event: "confirm", task: this.spec.id, kind: req.kind, app: req.app, element: req.element, ...auditValue(req), answer: this.isOver ? "stopped" : answer ?? "expired" });
    if (this.isOver) return STOPPED();
    if (answer === "always" && remember) {
      this.d.settings.update({ grants: { ...this.d.settings.get().grants, [req.app.toLowerCase()]: "act" } });
    }
    if (answer === "once" || answer === "always") {
      if (decision.needsGrant && req.app) this.allowedApps.add(req.app.toLowerCase());
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
