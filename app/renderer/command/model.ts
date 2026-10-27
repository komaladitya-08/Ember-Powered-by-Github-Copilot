/**
 * The command window's page as a pure model (§3.9.1, §3.10; critique security-13): what main sends it, what it sends
 * back, and a reducer for everything the page keeps. The card's state ("seen", "in view", armed) is computed only
 * from the card element's own measurements; output bytes only ever become writes into their run's terminal, so no
 * output byte, OSC, DCS or APC sequence can change the card, its scroll position or the "seen" flag
 * (renderer-command.test.ts pins it). Renderer-safe: no DOM, no xterm, no Node.
 */

import type { CommandCard } from "../../main/commands/types";
import type { CommandTabView, CommandWindowState } from "../../shared/commands";
import type { OS } from "../../shared/shortcuts";
import { READ_ALL_HINT } from "./copy";

/**
 * Channels of the command window beyond COMMANDS_IPC (they share its "commands:" prefix, so the trusted-sender rule
 * covers them): the page reports the terminal size that fits it, so new runs start at that size (§3.10).
 */
export const COMMANDS_EXTRA_IPC = { size: "commands:size" } as const;

/** A run's tab as main sends it: the contract's view plus what the page needs to draw it. */
export interface TabView extends CommandTabView {
  /** Unique per tab (a run id shown again gets a new one): the page keeps one terminal per seq. */
  seq: number;
  /** The tab's tooltip: the task's title. */
  title: string;
  /** The hint under the terminal (typingHint). */
  typing: string;
  /** The terminal's size for this run (fixed for the run). */
  cols: number;
  rows: number;
  /** How it is going, for the tab's symbol (its words are the status line). */
  outcome: "running" | "done" | "failed" | "stopped";
}

/** A task whose command has no tab yet, and its line ("Starting Ubuntu…"). */
export interface PendingView { taskId: string; text: string }

/** Everything the window draws, pushed whole on every change (the contract's state with richer tabs). */
export interface WindowView extends CommandWindowState {
  tabs: TabView[];
  /** Grows with every push: the page ignores an older state that arrives late. */
  rev: number;
  /** Lines for tasks whose command has no tab yet, until the tab comes (absent: none). */
  pending?: PendingView[];
  /** The PC's OS, for its keys in a run's terminal (keys.ts; absent: not a Mac). */
  os?: OS;
}

/** At most this many pending lines are drawn. */
export const MAX_PENDING_LINES = 4;

/**
 * The pending lines the page draws above the tabs: each different text once, in order, non-empty ones only, at most
 * MAX_PENDING_LINES (two tasks waiting for the same distro say "Starting Ubuntu…" once).
 */
export function pendingLines(view: WindowView | null): string[] {
  const out: string[] = [];
  for (const p of Array.isArray(view?.pending) ? view.pending : []) {
    const text = typeof p?.text === "string" ? p.text.trim() : "";
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= MAX_PENDING_LINES) break;
  }
  return out;
}

/** A run's output bytes from byte `at` of its output (offsets let the page drop what it already wrote). */
export interface OutputMsg { runId: string; seq: number; at: number; bytes: Uint8Array }

/** What the page pulls when it loads (main may have pushed before it listened): the state and each run's recent output. */
export interface Snapshot { state: WindowView; replay: OutputMsg[] }

/** The card's answer (§3.9.1): Allow sends "once" with the card's sha256, Not now "deny". */
export interface AnswerMsg { n: number; answer: "once" | "deny"; sha256: string }

/** Whether question n's whole command is in view now, and whether it has been since the card came up. */
export interface SeenMsg { n: number; inView: boolean; seen: boolean }

/** The page's bridge (app/preload/command.ts exposes exactly this as `window.emberCommands`). */
export interface CommandsApi {
  pull(): Promise<Snapshot | null>;
  onState(fn: (s: WindowView) => void): void;
  onOutput(fn: (m: OutputMsg) => void): void;
  answer(a: AnswerMsg): void;
  stop(runId: string): void;
  input(runId: string, data: string): void;
  cardSeen(m: SeenMsg): void;
  close(runId: string): void;
  size(s: { cols: number; rows: number }): void;
}

/** The card's command block and its window as the page measured them (CSS px; `visible`: the page can be seen). */
export interface CardMetrics {
  scrollTop: number; scrollHeight: number; clientHeight: number;
  scrollWidth: number; clientWidth: number;
  /** The block's box in the viewport. */
  top: number; bottom: number; left: number; right: number;
  viewWidth: number; viewHeight: number;
  /**
   * What the block's scrolling ancestors leave visible (the card area scrolls), in viewport coordinates: the block
   * counts as on screen only inside it. Absent: nothing but the viewport clips it.
   */
  clip?: { top: number; bottom: number; left: number; right: number };
  visible: boolean;
}

/** What the page knows about the question card on screen. */
export interface CardModel {
  n: number;
  sha256: string;
  /** When the page first drew it (ms, the page's clock). */
  shownAt: number;
  armMs: number;
  /** The whole command fits in its block (no scrolling needed). */
  fits: boolean;
  /** The block is scrolled to its end. */
  atEnd: boolean;
  /** The whole command has been in view since the card came up (Allow's second condition). */
  seen: boolean;
  /** The whole command is in view now (the approve chord's guard). */
  inView: boolean;
}

/** The page's model. */
export interface PageModel {
  view: WindowView | null;
  card: CardModel | null;
  /** The selected tab's run id. */
  selected: string | null;
  /** Bytes of each tab's output already written to its terminal (by seq). */
  written: Readonly<Record<number, number>>;
  /** The last SeenMsg sent, so only changes are reported. */
  reported: SeenMsg | null;
}

export type PageEvent =
  | { type: "state"; view: WindowView; now: number }
  | { type: "output"; msg: OutputMsg }
  | { type: "card-metrics"; n: number; metrics: CardMetrics }
  | { type: "select"; runId: string };

export type Effect =
  | { kind: "write"; seq: number; bytes: Uint8Array }
  | { kind: "report"; msg: SeenMsg };

export const INITIAL_MODEL: PageModel = { view: null, card: null, selected: null, written: {}, reported: null };

/** One CSS pixel of slack for sub-pixel layout. */
const SLACK = 1;

/**
 * The block shows its whole content: nothing to scroll in it, and the block itself inside the window and inside what
 * its scrolling ancestors show. `atEnd` (scrolled through to its end) never holds while a line runs off to the side:
 * the command wraps, so a block that scrolls sideways is one the user can't have read whole (fail closed).
 */
export function judgeMetrics(m: CardMetrics): { fits: boolean; atEnd: boolean; onScreen: boolean } {
  const narrow = m.scrollWidth <= m.clientWidth + SLACK;
  const fits = m.scrollHeight <= m.clientHeight + SLACK && narrow;
  const atEnd = narrow && m.scrollTop + m.clientHeight >= m.scrollHeight - SLACK;
  const c = m.clip;
  const inClip = !c || ([c.top, c.bottom, c.left, c.right].every(Number.isFinite)
    && m.top >= c.top - SLACK && m.left >= c.left - SLACK && m.bottom <= c.bottom + SLACK && m.right <= c.right + SLACK);
  const onScreen = m.visible && inClip && m.top >= -SLACK && m.left >= -SLACK && m.bottom <= m.viewHeight + SLACK && m.right <= m.viewWidth + SLACK
    && m.clientHeight > 0 && m.clientWidth > 0;
  return { fits, atEnd, onScreen };
}

/**
 * The reducer. Output events touch only `written` and produce writes; card events touch only `card` and `reported`;
 * state events replace `view` (and reset the card when its question changes). It never throws on odd input.
 */
export function reduce(model: PageModel, ev: PageEvent): { model: PageModel; effects: Effect[] } {
  switch (ev.type) {
    case "state": {
      const v = ev.view;
      if (model.view && v.rev < model.view.rev) return { model, effects: [] };
      const c = v.card;
      let card = model.card;
      if (!c) card = null;
      else if (!card || card.n !== c.n || card.sha256 !== c.sha256) {
        card = { n: c.n, sha256: c.sha256, shownAt: ev.now, armMs: Math.max(0, Number(c.armMs) || 0), fits: false, atEnd: false, seen: false, inView: false };
      }
      // A tab that went: its terminal goes with it. A new tab is selected (the newest run is the one to watch).
      const seqs = new Set(v.tabs.map(t => t.seq));
      const written = Object.fromEntries(Object.entries(model.written).filter(([s]) => seqs.has(Number(s))));
      const known = new Set(model.view?.tabs.map(t => t.seq) ?? []);
      const fresh = v.tabs.find(t => !known.has(t.seq));
      let selected = model.selected;
      if (fresh) selected = fresh.runId;
      if (!selected || !v.tabs.some(t => t.runId === selected)) selected = v.tabs[0]?.runId ?? null;
      const effects: Effect[] = [];
      let reported = model.reported;
      // The card went or changed: say so at once (main never takes an old card's "in view" for a new one).
      if (reported && (!card || reported.n !== card.n) && reported.inView) {
        reported = { ...reported, inView: false };
        effects.push({ kind: "report", msg: reported });
      }
      return { model: { view: v, card, selected, written, reported }, effects };
    }
    case "output": {
      const { msg } = ev;
      if (!(msg.bytes instanceof Uint8Array) || !Number.isFinite(msg.at) || msg.at < 0) return { model, effects: [] };
      if (!model.view?.tabs.some(t => t.seq === msg.seq && t.runId === msg.runId)) return { model, effects: [] };
      const done = model.written[msg.seq] ?? 0;
      const end = msg.at + msg.bytes.length;
      if (end <= done) return { model, effects: [] };
      // Bytes already written are skipped; a gap (bytes main no longer kept) is written from where it starts.
      const bytes = msg.at >= done ? msg.bytes : msg.bytes.subarray(done - msg.at);
      return { model: { ...model, written: { ...model.written, [msg.seq]: end } }, effects: [{ kind: "write", seq: msg.seq, bytes }] };
    }
    case "card-metrics": {
      const card = model.card;
      if (!card || card.n !== ev.n) return { model, effects: [] };
      const { fits, atEnd, onScreen } = judgeMetrics(ev.metrics);
      const seen = card.seen || (onScreen && (fits || atEnd));
      const inView = seen && onScreen && fits;
      const next: CardModel = { ...card, fits, atEnd, seen, inView };
      const msg: SeenMsg = { n: card.n, inView, seen };
      const changed = !model.reported || model.reported.n !== msg.n || model.reported.inView !== msg.inView || model.reported.seen !== msg.seen;
      return { model: { ...model, card: next, reported: changed ? msg : model.reported }, effects: changed ? [{ kind: "report", msg }] : [] };
    }
    case "select": {
      if (!model.view?.tabs.some(t => t.runId === ev.runId)) return { model, effects: [] };
      return { model: { ...model, selected: ev.runId }, effects: [] };
    }
  }
  return { model, effects: [] };
}

/** Allow can be pressed: the card's arm time has passed and its whole command has been in view. */
export function allowEnabled(card: CardModel | null, now: number): boolean {
  return !!card && card.seen && now >= card.shownAt + card.armMs;
}

/** The hint under a disarmed Allow: only when the command needs scrolling to be read through. */
export function allowHint(card: CardModel | null): string | null {
  return card && !card.seen && !card.fits ? READ_ALL_HINT : null;
}

/** The answer Allow sends for the card on screen (null when Allow can't be pressed now). */
export function allowAnswer(card: (CommandCard & { n: number }) | null, model: CardModel | null, now: number): AnswerMsg | null {
  if (!card || !model || card.n !== model.n || card.sha256 !== model.sha256 || !allowEnabled(model, now)) return null;
  return { n: card.n, answer: "once", sha256: card.sha256 };
}
