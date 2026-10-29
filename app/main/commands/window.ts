/**
 * The command window's controller ("Ember commands", §3.9-§3.10, §8.5): the card that shows a whole command before
 * Allow, the announcement that counts down before a command the user asked for runs, a tab per run with its live
 * output, its status line, Stop, and the user's typing straight to the process (R1, R7), and a line for a task whose
 * command has no tab yet ("Starting Ubuntu…" while the first command's checks start a stopped distro).
 *
 * Plain Node (L13): the window comes from `create()` (windows.ts's createCommandWindow, S0b) and the IPC from `ipc`.
 * Every message from a page is taken only from this window's own webContents and checked field by field. What the user
 * types is never logged, never kept here and never sent anywhere but the run. The window is made only when something
 * needs it (a card, an announcement, a run, or the user opening it), so with commands off nothing new appears.
 */

import { createHash } from "node:crypto";
import { COMMANDS_IPC } from "../../shared/commands";
import { SHORTCUTS, type OS } from "../../shared/shortcuts";
import { parseTargetId } from "../../shared/targets";
import type { Logger } from "../logger";
import type { BrowserWindowLike, IpcLike, WebContentsLike } from "../targets/types";
import type { CommandCard, CommandWindowPort, DangerClass, RunExit, RunningCommand } from "./types";
import { RUNNING_STATUS, WAITING_STATUS, announceKeyText, headerLine, outsideText, reaskEndText, reaskText, statusLine, typingHint, waitingTimeoutText } from "../../renderer/command/copy";
import { SECRET_PROMPT } from "./prompts";
import { COMMANDS_EXTRA_IPC, type AnswerMsg, type OutputMsg, type SeenMsg, type Snapshot, type TabView, type WindowView } from "../../renderer/command/model";

/** Runs whose tabs are kept (the newest first; running ones are never dropped). */
export const MAX_TABS = 20;
/** Output kept per run for a page that (re)loads: the tail, in bytes. */
export const REPLAY_BYTES = 256 * 1024;
/** Output is sent to the page in batches at most this far apart, and at most this big. */
const FLUSH_MS = 16;
const FLUSH_BYTES = 64 * 1024;
/** One typing message (a paste) at most, in characters; it goes to the run in pieces of at most 4 KiB (cmd.input's limit). */
const INPUT_MAX_CHARS = 64 * 1024;
const INPUT_PIECE = 4096;
/** A run's terminal size until the page has said what fits. */
export const DEFAULT_TERM_SIZE = Object.freeze({ cols: 100, rows: 30 });
/** How long an announcement counts down when the flow gives no usable time. */
const DEFAULT_ANNOUNCE_MS = 4000;
/**
 * The least time an announcement counts down while a screen reader runs (review #46, WCAG 2.2.1): enough to hear the
 * announcement, find Stop or the stop chord, and act.
 */
export const ANNOUNCE_SCREEN_READER_MS = 15_000;

/** What the controller adds to the port for the targets runtime (beyond the contract; see the package report). */
export interface CommandWindowExtras {
  /**
   * Answers from the card's own buttons (already checked: this window, the card on screen, its sha256, armed and seen).
   * `fn` returns false when the answer wasn't taken (the Confirmer refused it): the card's buttons come back.
   */
  onAnswer(fn: (a: AnswerMsg) => boolean | void): () => void;
  /** The terminal size new runs should start at (what the window's page says fits, else 100×30). */
  termSize(): { cols: number; rows: number };
  /** A note in a running tab's status line ("Starting Ubuntu…", the stalled-link countdown), or null to clear it. */
  note(runId: string, text: string | null): void;
  /**
   * A line for task `taskId` whose command has no tab yet ("Starting Ubuntu…": the flow's followPending, while the
   * first command's checks start a stopped distro), shown until the task's run gets its tab or the text is cleared
   * with null. It brings the window up (not on top): the run's tab follows there.
   */
  pending(taskId: string, text: string | null): void;
  /** How long an announcement should count down, given the flow's usual `base`: longer while a screen reader runs. */
  announceMs(base: number): number;
  /**
   * Calls `fn` when a run starts or stops waiting at a prompt for the user to type (review #263): the flow says so in
   * the task's bubble. Returns the unsubscribe.
   */
  onWaiting(fn: (runId: string, waiting: boolean) => void): () => void;
  /**
   * No OK is coming for run `runId`, which the remote's own check sent back for one (review #274): the user said no or
   * let the question go ("no"), the task stopped ("stopped"), or the retry was sent back too, which is the remote's
   * refusal ("refused"). Its tab stops saying an OK is awaited, and no later run replaces it.
   */
  reaskEnded(runId: string, why: "no" | "stopped" | "refused"): void;
}

/**
 * What windows.ts's createCommandWindow adds to its window (review #262): a guard its close button asks first, which
 * keeps the window when it returns true. Ember quitting or the session ending never asks it.
 */
export interface CloseGuarded { setCloseGuard(fn: () => boolean): void }

/**
 * What windows.ts adds to the command and prompt windows (review #272): moving the window to the display the user is on
 * (nearest the pointer), and keeping it on every workspace (and over a full-screen app on macOS) while a card is up.
 */
export interface Placeable { placeNearUser(): void; setOnAllWorkspaces(on: boolean): void }

/** A window's bounds or a display's work area, in DIP. */
export interface Rect { x: number; y: number; width: number; height: number }

/**
 * Where a window goes on the display the user is on: null (stay) when its centre is already in that display's work
 * area, else centred in it and shrunk to fit.
 */
export function placeOnDisplay(bounds: Rect, area: Rect): Rect | null {
  const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2;
  if (cx >= area.x && cx < area.x + area.width && cy >= area.y && cy < area.y + area.height) return null;
  const width = Math.min(bounds.width, area.width), height = Math.min(bounds.height, area.height);
  return { x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height };
}

/** How long an interactive run's output must sit at a prompt before the window says it waits for typing (review #263). */
export const WAITING_MS = 2000;

/** Terminal escape sequences (prompts.ts's own pattern), removed before a prompt is looked for (a coloured prompt is still one). */
// eslint-disable-next-line no-control-regex -- terminal escape sequences are exactly what this removes
const ESCAPES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_]|[ -/]+[0-~])|[\x9b][0-?]*[ -/]*[@-~]/g;

/**
 * Whether output that stopped here leaves the program waiting for the user to type: its last line (escape sequences
 * aside) is a short question or prompt with words in it, ending in ":", "?", ">" or a bracketed choice ("[y/N]"), or a
 * password-like prompt (prompts.ts). A progress line ("Downloading 45%") or a finished line is not.
 */
export function awaitsTyping(text: string): boolean {
  const plain = text.replace(ESCAPES, "");
  const last = plain.slice(Math.max(plain.lastIndexOf("\n"), plain.lastIndexOf("\r")) + 1);
  if (SECRET_PROMPT.test(last)) return true;
  const line = last.trim();
  return line.length > 0 && line.length <= 200 && /\p{L}/u.test(line) && /([:?>]|\[[^\]]{1,20}\])$/.test(line);
}

/** At most this many pending lines are kept (one per task; a task past it isn't shown). */
export const MAX_PENDING = 8;

/** The port, what the targets runtime needs of the window, and the extras. */
export type CommandWindowController = CommandWindowPort & CommandWindowExtras & { show(): void; owns(sender: WebContentsLike): boolean; dispose(): void };

interface Tab {
  seq: number;
  card: CommandCard;
  run: RunningCommand;
  ended: boolean;
  outcome: TabView["outcome"];
  status: string;
  note: string | null;
  size: { cols: number; rows: number };
  /** Recent output: chunks from byte `start` up to byte `total`. */
  kept: Uint8Array[];
  keptBytes: number;
  start: number;
  total: number;
  /** Output not yet sent to the page, from byte `pendingAt`. */
  pending: Uint8Array[];
  pendingAt: number;
  pendingBytes: number;
  flush: ReturnType<typeof setTimeout> | null;
  unsubscribe: () => void;
  /** The remote's own check sent it back for the user's OK (it never ran): the retry's run takes its place. */
  reask?: boolean;
  /** That end, for the remote's refusal line if no OK comes (reaskEnded). */
  reaskExit?: RunExit;
  /** The end of its decoded output (an interactive run's), and the timer that looks for a prompt there (review #263). */
  tail: string;
  decoder: TextDecoder;
  waitTimer: ReturnType<typeof setTimeout> | null;
  /** Its output has sat at a prompt: it waits for the user to type. */
  waiting: boolean;
}

interface Announcement {
  card: CommandCard;
  ms: number;
  endsAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  settle: (ok: boolean) => void;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** The danger classes a card may carry (anything else: not a card Ember made). */
const DANGER_CLASSES: readonly DangerClass[] = ["destroy", "publish", "remote-delete", "secret", "system", "escape", "unclear"];
const isRunId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{16}$/.test(v);
const isSha = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const isN = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const str = (v: unknown, max: number, min = 0) => typeof v === "string" && v.length >= min && v.length <= max;

/** What an approval binds to (§3.9.1, R-cmd-1): sha256Hex(`${target}\0${shell}\0${cwd}\0${command}`). */
export function cardSha256(c: Pick<CommandCard, "target" | "shell" | "cwd" | "command">): string {
  return createHash("sha256").update(`${c.target}\0${c.shell}\0${c.cwd}\0${c.command}`, "utf8").digest("hex");
}

/**
 * A card the window can show: every field of the right type and size, and its sha256 the hash of exactly the target,
 * shell, folder and command it shows (so the hash an Allow carries back is of what the user saw), for a target id Ember
 * knows (the header names the place from it). A malformed card is never shown, so it can't be allowed.
 */
export function validCard(c: unknown): c is CommandCard {
  if (!isObj(c)) return false;
  return isRunId(c.runId) && str(c.target, 200) && parseTargetId(c.target as string) !== null && str(c.targetLabel, 200, 1) && (c.login === undefined || str(c.login, 255))
    && ["bash", "zsh", "sh", "powershell", "cmd"].includes(c.shell as string) && str(c.cwd, 4096) && str(c.command, 64 * 1024)
    && (c.command as string).length > 0 && isSha(c.sha256) && str(c.taskId, 200) && str(c.taskTitle, 1000)
    && ["ask", "announce", "run"].includes(c.mode as string) && Array.isArray(c.says) && c.says.length <= 64
    && c.says.every(l => str(l, 4000)) && typeof c.unasked === "boolean" && typeof c.armMs === "number" && Number.isFinite(c.armMs) && c.armMs >= 0
    && (c.classes === undefined || (Array.isArray(c.classes) && c.classes.length <= DANGER_CLASSES.length && c.classes.every(x => DANGER_CLASSES.includes(x as DangerClass))))
    && cardSha256(c as unknown as CommandCard) === c.sha256;
}

/** Text typed into a run, as bytes in pieces of at most `piece` bytes, never splitting a character. */
export function typedPieces(data: string, piece = INPUT_PIECE): Uint8Array[] {
  const out: Uint8Array[] = [];
  const enc = new TextEncoder();
  let buf: number[] = [];
  for (const ch of data) {
    const b = enc.encode(ch);
    if (buf.length + b.length > piece && buf.length) { out.push(Uint8Array.from(buf)); buf = []; }
    for (const x of b) buf.push(x);
  }
  if (buf.length) out.push(Uint8Array.from(buf));
  return out;
}

/** The command window as the command flow drives it, plus what the targets runtime needs of it. */
export function createCommandWindowPort(o: CommandWindowOptions): CommandWindowPort & { show(): void; owns(sender: WebContentsLike): boolean; dispose(): void } {
  return createCommandWindowController(o);
}

/**
 * What the controller is made from: the window's factory, ipcMain, the log, the OS, the card's key hint, whether a
 * screen reader runs (main's sys.a11y.screenReaderOn: each run's terminal then mirrors its output for it, review #43),
 * and the stop chord as Ember holds it now (null while another app holds it: the announcement names none then, as the
 * bubble and the spoken words don't, cross-review X0; absent: the OS's own).
 */
export interface CommandWindowOptions {
  create: () => BrowserWindowLike;
  ipc: IpcLike;
  log: Logger;
  os: OS;
  keyHint: () => string | null;
  screenReader?: () => boolean;
  stopKey?: () => string | null;
}

/** createCommandWindowPort with its extras typed: the same object (the targets runtime may call this name instead). */
export function createCommandWindowController(o: CommandWindowOptions): CommandWindowController {
  /** Logs, never letting a logger that fails stop the fail-closed path it reports. */
  const note = (level: "warn" | "error", msg: string, fields: Record<string, unknown>) => {
    try { o.log[level](msg, fields); } catch { /* nothing else to do: the caller goes on failing closed */ }
  };
  let win: BrowserWindowLike | null = null;
  let disposed = false;
  let rev = 0;
  let seqNext = 1;
  /** Newest first. */
  let tabs: Tab[] = [];
  /** The card on screen; `retry` counts the answers from its buttons that weren't taken (the page re-enables them). */
  let card: { n: number; card: CommandCard; shownAt: number; retry: number } | null = null;
  let view: SeenMsg | null = null;
  const queue: Announcement[] = [];
  /** Tasks whose command has no tab yet, and the line each shows (insertion order). */
  const pendings = new Map<string, string>();
  const answerFns = new Set<(a: AnswerMsg) => boolean | void>();
  const waitingFns = new Set<(runId: string, waiting: boolean) => void>();
  /** The user closed the window while commands ran: the page asks whether to stop them (review #262). */
  let closeAsk = false;
  /** The window is closing because the user said so (or Ember closes it): the guard lets it go. */
  let closing = false;
  let size: { cols: number; rows: number } | null = null;

  const live = (): BrowserWindowLike | null => (win && !win.isDestroyed() ? win : null);
  const owns = (sender: WebContentsLike | undefined): boolean => {
    const w = live();
    return !!w && !!sender && typeof sender.id === "number" && sender.id === w.webContents.id;
  };
  const safe = (what: string, f: () => void) => {
    try { f(); } catch (err) { note("warn", "commands.window_call_failed", { what, err }); }
  };

  function ensure(): BrowserWindowLike | null {
    if (disposed) return null;
    const w0 = live();
    if (w0) return w0;
    let w: BrowserWindowLike;
    try { w = o.create(); } catch (err) {
      note("error", "commands.window_failed", { err });
      win = null;
      return null;
    }
    win = w;
    closing = false;
    closeAsk = false;
    try { wire(); } catch (err) { note("error", "commands.ipc_failed", { err }); }
    // Closing the window while a command runs never leaves it running unseen (R1): the page asks first (review #262).
    safe("close-guard", () => (w as BrowserWindowLike & Partial<CloseGuarded>).setCloseGuard?.(() => keepOnClose(w)));
    w.on("closed", () => {
      if (win !== w) return;
      win = null;
      view = null;
      closeAsk = false;
      // Closed during a countdown: the user didn't get to see it to the end, so no command waiting there runs (fail
      // closed), and the window doesn't come back for the next one.
      cancelAnnouncements();
    });
    return w;
  }

  /** The runs still going in the window. */
  const runningTabs = () => tabs.filter(t => !t.ended);

  /**
   * The window's close button was pressed: true keeps the window and asks whether to stop the commands still running in
   * it. Nothing running, Ember closing it, or the user pressing it again while it asks: it closes (the second press
   * stops them first, so none runs on unseen).
   */
  function keepOnClose(w: BrowserWindowLike): boolean {
    if (disposed || closing || w !== live()) return false;
    const running = runningTabs();
    if (!running.length) return false;
    // Pressed again while it asks: the commands stop and this close goes ahead (no second close from inside this one).
    if (closeAsk) { stopAll(); closing = true; return false; }
    closeAsk = true;
    push();
    safe("close-ask", () => { w.show(); w.focus(); });
    return true;
  }

  /** Stops every running command (the user's Stop) and every countdown. */
  function stopAll(): void {
    closeAsk = false;
    for (const t of runningTabs()) safe("stop", () => t.run.stop("user"));
    cancelAnnouncements();
  }

  /** Stops every running command and countdown, then closes the window (the page's Stop and close). */
  function stopAllAndClose(): void {
    stopAll();
    const w = live();
    if (!w) return;
    closing = true;
    safe("close", () => w.close());
  }

  function keyHint(): string | null {
    try {
      const h = o.keyHint();
      return typeof h === "string" && h ? h : null;
    } catch { return null; } // a hint that can't be built shows none
  }

  /** Under an announcement's countdown: the stop chord Ember holds now, or "" (taken, or the check failed). */
  function announceKeys(): string {
    let key: string | null = null;
    try { key = o.stopKey ? o.stopKey() : SHORTCUTS[o.os].stop.label; } catch { /* named none: it may be taken */ }
    return announceKeyText(o.os, typeof key === "string" && key ? key : null);
  }

  /** A screen reader runs (main asks the OS each time); false when it isn't told or asking fails. */
  function screenReader(): boolean {
    try { return o.screenReader?.() === true; } catch { return false; } // not known: the terminals stay as they are
  }

  function tabView(t: Tab): TabView {
    const interactive = !t.ended && t.run.interactive === true;
    const kind = parseTargetId(t.card.target)?.kind;
    return {
      runId: t.card.runId, seq: t.seq, header: headerLine(t.card), command: t.card.command,
      // The tab names the computer when it isn't this one (review #275).
      ...(kind && kind !== "local" ? { where: outsideText(t.card.targetLabel, 40) } : {}),
      status: t.note && !t.ended ? t.note : t.waiting && !t.ended ? WAITING_STATUS : t.status, interactive, ended: t.ended, title: t.card.taskTitle,
      ...(t.waiting && !t.ended ? { waiting: true } : {}),
      typing: typingHint({ interactive, ended: t.ended }, o.os), cols: t.size.cols, rows: t.size.rows, outcome: t.outcome,
    };
  }

  function stateNow(): WindowView {
    const head = queue[0];
    const keys = head && head.endsAt !== null ? announceKeys() : "";
    return {
      rev: ++rev,
      tabs: tabs.map(tabView),
      card: card ? { ...card.card, n: card.n, ...(card.retry ? { retry: card.retry } : {}) } : null,
      announce: head && head.endsAt !== null ? { card: head.card, endsAt: head.endsAt } : null,
      ...(keys ? { announceKeys: keys } : {}),
      keyHint: card ? keyHint() : null,
      pending: [...pendings].map(([taskId, text]) => ({ taskId, text })),
      os: o.os,
      screenReader: screenReader(),
      closing: closeAsk ? { running: runningTabs().length } : null,
    };
  }

  function push(): void {
    const w = live();
    if (!w) return;
    safe("send-state", () => w.webContents.send(COMMANDS_IPC.state, stateNow()));
  }

  /**
   * Brings the window up without taking the keyboard from the user's app; on top while a card or countdown is up.
   * `raise`: above the user's other windows even when nothing asks (a new run, a run waiting for typing: review #263).
   */
  function reveal(raise = false): void {
    const w = ensure();
    if (!w) return;
    const onTop = !!card || queue.length > 0;
    const p = w as BrowserWindowLike & Partial<Placeable>;
    safe("reveal", () => {
      const hidden = !w.isVisible() || w.isMinimized();
      // On the display the user is on (a card always; otherwise when it comes up from hidden), and on every workspace
      // while a card or countdown is up, so its Allow or Stop is where the bubble is (review #272).
      if (onTop || hidden) p.placeNearUser?.();
      if (onTop) { w.setAlwaysOnTop(true, "floating"); p.setOnAllWorkspaces?.(true); }
      if (hidden) w.showInactive();
      if (onTop || raise) w.moveTop();
    });
  }

  /** The window asks for attention (the taskbar or dock flashes) while a run waits for typing, or stops asking. */
  function flash(on: boolean): void {
    const w = live() as (BrowserWindowLike & { flashFrame?: (flag: boolean) => void }) | null;
    if (w && typeof w.flashFrame === "function") safe("flash", () => w.flashFrame!(on));
  }

  /** Run `t` starts or stops waiting for the user to type: its tab, the window and the listeners hear it. */
  function setWaiting(t: Tab, on: boolean): void {
    if (t.waiting === on) return;
    t.waiting = on;
    push();
    if (on) reveal(true);
    if (on || !tabs.some(x => x.waiting)) flash(on);
    for (const fn of [...waitingFns]) safe("waiting", () => fn(t.card.runId, on));
  }

  /** A card or countdown went: no longer on top; hidden again when there is nothing else to show. */
  function settle(): void {
    const w = live();
    if (!w || card || queue.length) return;
    safe("settle", () => {
      w.setAlwaysOnTop(false);
      (w as BrowserWindowLike & Partial<Placeable>).setOnAllWorkspaces?.(false);
      if (!tabs.length && !pendings.size && w.isVisible()) w.hide();
    });
  }

  // ───── Output ─────
  function flush(t: Tab): void {
    if (t.flush) { clearTimeout(t.flush); t.flush = null; }
    if (!t.pending.length) return;
    const bytes = t.pending.length === 1 ? t.pending[0] : concat(t.pending, t.pendingBytes);
    const msg: OutputMsg = { runId: t.card.runId, seq: t.seq, at: t.pendingAt, bytes };
    t.pending = [];
    t.pendingBytes = 0;
    t.pendingAt = t.total;
    const w = live();
    if (w) safe("send-output", () => w.webContents.send(COMMANDS_IPC.output, msg));
  }

  function onOutput(t: Tab, chunk: Uint8Array): void {
    if (disposed || !tabs.includes(t) || !(chunk instanceof Uint8Array) || !chunk.length) return;
    const copy = chunk.slice();
    // An interactive run whose output then sits at a prompt for WAITING_MS waits for the user to type (review #263).
    if (t.run.interactive === true && !t.ended) {
      t.tail = (t.tail + t.decoder.decode(copy, { stream: true })).slice(-1024);
      if (t.waiting) setWaiting(t, false);
      if (t.waitTimer) clearTimeout(t.waitTimer);
      t.waitTimer = setTimeout(() => {
        t.waitTimer = null;
        if (!disposed && tabs.includes(t) && !t.ended && awaitsTyping(t.tail)) setWaiting(t, true);
      }, WAITING_MS);
    }
    // Kept for a page that loads later: the newest REPLAY_BYTES.
    t.kept.push(copy);
    t.keptBytes += copy.length;
    while (t.kept.length > 1 && t.keptBytes - t.kept[0].length >= REPLAY_BYTES) {
      t.keptBytes -= t.kept[0].length;
      t.start += t.kept.shift()!.length;
    }
    if (t.keptBytes > REPLAY_BYTES) {
      const cut = t.keptBytes - REPLAY_BYTES;
      t.kept[0] = t.kept[0].subarray(cut);
      t.keptBytes -= cut;
      t.start += cut;
    }
    if (!t.pending.length) t.pendingAt = t.total;
    t.total += copy.length;
    t.pending.push(copy);
    t.pendingBytes += copy.length;
    if (t.pendingBytes >= FLUSH_BYTES) flush(t);
    else if (!t.flush) t.flush = setTimeout(() => flush(t), FLUSH_MS);
  }

  function dropTab(t: Tab): void {
    if (t.flush) clearTimeout(t.flush);
    t.flush = null;
    if (t.waitTimer) clearTimeout(t.waitTimer);
    t.waitTimer = null;
    if (t.waiting) { t.waiting = false; if (!tabs.some(x => x !== t && x.waiting)) flash(false); }
    safe("unsubscribe", t.unsubscribe);
  }

  function snapshot(): Snapshot {
    for (const t of tabs) flush(t);
    return {
      state: stateNow(),
      replay: tabs.filter(t => t.keptBytes > 0).map(t => ({ runId: t.card.runId, seq: t.seq, at: t.start, bytes: concat(t.kept, t.keptBytes) })),
    };
  }

  // ───── Announcements (D4.4, §3.9.2): one counts down at a time, each for its whole time once shown ─────
  function startHead(): void {
    const a = queue[0];
    if (!a || a.endsAt !== null || disposed) return;
    reveal();
    // No window to count down in (it couldn't be made): the command doesn't run (R1: it runs only where it's seen).
    if (!live()) { settleAnnouncement(a, false); return; }
    a.endsAt = Date.now() + a.ms;
    a.timer = setTimeout(() => settleAnnouncement(a, true), a.ms);
    push();
  }

  /** Every announcement, shown or waiting, ends as "don't run" at once. */
  function cancelAnnouncements(): void {
    for (const a of queue.splice(0)) {
      if (a.timer) clearTimeout(a.timer);
      a.settle(false);
    }
    push();
    settle();
  }

  function settleAnnouncement(a: Announcement, ok: boolean): void {
    const at = queue.indexOf(a);
    if (at < 0) return;
    queue.splice(at, 1);
    if (a.timer) clearTimeout(a.timer);
    a.settle(ok && !disposed);
    if (at === 0) startHead();
    push();
    settle();
  }

  // ───── Messages from the page (each from this window's own page only, every field checked) ─────
  // Wired when the window is first made: no window, no handlers (commands off, nothing new anywhere).
  let wired = false;
  function wire(): void {
    if (wired) return;
    wired = true;
    const refused = (channel: string) => note("warn", "commands.ipc_refused", { channel });

    o.ipc.handle(COMMANDS_IPC.state, e => {
      if (disposed || !owns(e?.sender)) { refused(COMMANDS_IPC.state); return null; }
      return snapshot();
    });

    o.ipc.on(COMMANDS_IPC.answer, (e, raw) => {
      if (disposed || !owns(e?.sender)) { refused(COMMANDS_IPC.answer); return; }
      if (!isObj(raw) || !isN(raw.n) || (raw.answer !== "once" && raw.answer !== "deny") || !isSha(raw.sha256)) return;
      // Only the card on screen, with its own hash; Allow only once it was armed and its whole command was seen.
      if (!card || card.n !== raw.n || card.card.sha256 !== raw.sha256) return;
      const shown = card;
      // The page disabled its buttons when it sent this: one that isn't taken gives them back (review #271).
      const notTaken = () => { shown.retry += 1; push(); };
      if (raw.answer === "once") {
        const armed = Date.now() >= shown.shownAt + shown.card.armMs;
        const seen = view?.n === shown.n && view.seen;
        if (!armed || !seen) { note("warn", "commands.allow_too_early", { n: shown.n, armed, seen }); notTaken(); return; }
      }
      const a: AnswerMsg = { n: raw.n, answer: raw.answer, sha256: raw.sha256 };
      let taken = answerFns.size > 0;
      for (const fn of [...answerFns]) safe("answer", () => { if (fn(a) === false) taken = false; });
      if (!taken && card === shown) notTaken();
    });

    o.ipc.on(COMMANDS_IPC.cardSeen, (e, raw) => {
      if (disposed || !owns(e?.sender)) { refused(COMMANDS_IPC.cardSeen); return; }
      if (!isObj(raw) || !isN(raw.n) || typeof raw.inView !== "boolean" || typeof raw.seen !== "boolean") return;
      if (!card || card.n !== raw.n) return;
      // "Seen" sticks for a card (the page can't take it back), and "in view" needs it.
      const seen = raw.seen || (view?.n === raw.n && view.seen);
      view = { n: raw.n, seen, inView: raw.inView && seen };
    });

    o.ipc.on(COMMANDS_IPC.stop, (e, raw) => {
      if (disposed || !owns(e?.sender)) { refused(COMMANDS_IPC.stop); return; }
      const runId = isObj(raw) ? raw.runId : raw;
      if (!isRunId(runId)) return;
      const a = queue.find(x => x.card.runId === runId);
      if (a) { settleAnnouncement(a, false); return; }
      const t = tabs.find(x => x.card.runId === runId && !x.ended);
      if (t) safe("stop", () => t.run.stop("user"));
    });

    o.ipc.on(COMMANDS_IPC.input, (e, raw) => {
      if (disposed || !owns(e?.sender)) { refused(COMMANDS_IPC.input); return; }
      if (!isObj(raw) || !isRunId(raw.runId) || typeof raw.data !== "string" || !raw.data) return;
      // Never logged: only that typing was refused, without a byte of it.
      if (raw.data.length > INPUT_MAX_CHARS) { note("warn", "commands.input_too_long", { chars: raw.data.length }); return; }
      const t = tabs.find(x => x.card.runId === raw.runId);
      if (!t || t.ended || t.run.interactive !== true) return;
      for (const piece of typedPieces(raw.data)) safe("input", () => t.run.input(piece));
      // The user is answering: the run no longer waits on them.
      setWaiting(t, false);
    });

    o.ipc.on(COMMANDS_IPC.close, (e, raw) => {
      if (disposed || !owns(e?.sender)) { refused(COMMANDS_IPC.close); return; }
      const runId = isObj(raw) ? raw.runId : raw;
      if (!isRunId(runId)) return;
      const t = tabs.find(x => x.card.runId === runId && x.ended);
      if (!t) return;
      dropTab(t);
      tabs = tabs.filter(x => x !== t);
      push();
      settle();
    });

    o.ipc.on(COMMANDS_EXTRA_IPC.closeWindow, (e, raw) => {
      if (disposed || !owns(e?.sender)) { refused(COMMANDS_EXTRA_IPC.closeWindow); return; }
      if (!closeAsk || !isObj(raw) || typeof raw.stop !== "boolean") return;
      if (raw.stop) { stopAllAndClose(); return; }
      closeAsk = false;
      push();
    });

    o.ipc.on(COMMANDS_EXTRA_IPC.size, (e, raw) => {
      if (disposed || !owns(e?.sender)) { refused(COMMANDS_EXTRA_IPC.size); return; }
      if (!isObj(raw)) return;
      const { cols, rows } = raw;
      if (Number.isInteger(cols) && Number.isInteger(rows) && (cols as number) >= 20 && (cols as number) <= 500 && (rows as number) >= 5 && (rows as number) <= 200) {
        size = { cols: cols as number, rows: rows as number };
      }
    });
  }

  // ───── The port ─────
  return {
    showCard(n, c) {
      if (disposed) return;
      if (!isN(n) || !validCard(c)) { note("error", "commands.card_refused", { n }); return; }
      // The same question shown again: it comes back up as it was (its arm time and what the page saw stay; the page
      // keeps its own state for the same card, so it wouldn't report "seen" again).
      if (card && card.n === n && card.card.sha256 === c.sha256) { reveal(); push(); return; }
      // One card at a time: a new question replaces the one shown (its "seen" doesn't carry over).
      card = { n, card: c, shownAt: Date.now(), retry: 0 };
      view = null;
      reveal();
      push();
    },

    hideCard(n) {
      if (!card || card.n !== n) return;
      card = null;
      view = null;
      push();
      settle();
    },

    cardReady(n) {
      const w = live();
      if (!w || !card || card.n !== n || !view || view.n !== n || !view.inView) return false;
      try {
        return w.isVisible() && !w.isMinimized() && (w.isAlwaysOnTop() || w.isFocused());
      } catch { return false; } // a window that can't say isn't ready
    },

    announce(c, ms, signal) {
      if (disposed || signal?.aborted || !validCard(c)) return Promise.resolve(false);
      return new Promise<boolean>(resolve => {
        const onAbort = () => settleAnnouncement(a, false);
        const a: Announcement = {
          card: c, ms: Number.isFinite(ms) && ms > 0 ? Math.min(ms, 60_000) : DEFAULT_ANNOUNCE_MS, endsAt: null, timer: null,
          settle: ok => { signal?.removeEventListener("abort", onAbort); resolve(ok); },
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        queue.push(a);
        if (queue.length === 1) startHead();
        else { reveal(); push(); }
      });
    },

    cancelAnnounce(runId) {
      for (const a of queue.filter(x => x.card.runId === runId)) settleAnnouncement(a, false);
    },

    attach(c, run) {
      if (!run || typeof run.onOutput !== "function") return;
      // R1: a command runs only where the user can watch and stop it. One this window can't show (a malformed card, no
      // window, the window gone at quit) is stopped at once rather than left running unseen.
      const unseen = (why: string) => {
        note("error", "commands.run_unshown", { why });
        safe("stop-unshown", () => run.stop("task"));
      };
      if (disposed) { unseen("disposed"); return; }
      if (!validCard(c)) { unseen("card"); return; }
      if (!ensure()) { unseen("window"); return; }
      // The task's run has its tab now: its pending line ("Starting Ubuntu…") gives way to it.
      pendings.delete(c.taskId);
      // The same run shown again, or the retry of a run the remote's own check sent back for the user's OK (the same
      // command for the same task, under a new run id): the old tab goes (review #274).
      const replaced = (t: Tab) => t.card.runId === c.runId || (t.reask === true && t.card.taskId === c.taskId && t.card.sha256 === c.sha256);
      for (const old of tabs.filter(replaced)) dropTab(old);
      tabs = tabs.filter(t => !replaced(t));
      const t: Tab = {
        seq: seqNext++, card: c, run, ended: false, outcome: "running", status: RUNNING_STATUS, note: null, size: size ?? { ...DEFAULT_TERM_SIZE },
        kept: [], keptBytes: 0, start: 0, total: 0, pending: [], pendingAt: 0, pendingBytes: 0, flush: null, unsubscribe: () => undefined,
        tail: "", decoder: new TextDecoder(), waitTimer: null, waiting: false,
      };
      tabs.unshift(t);
      // Keep the newest MAX_TABS: the oldest finished ones go first; a run still going is never dropped.
      while (tabs.length > MAX_TABS) {
        const oldest = [...tabs].reverse().find(x => x.ended);
        if (!oldest) break;
        dropTab(oldest);
        tabs = tabs.filter(x => x !== oldest);
      }
      try { t.unsubscribe = run.onOutput(chunk => onOutput(t, chunk)); } catch (err) { note("warn", "commands.output_unavailable", { err }); }
      const finish = (exit: RunExit | null) => {
        if (t.ended || !tabs.includes(t)) return;
        flush(t);
        const waited = t.waiting;
        if (t.waitTimer) clearTimeout(t.waitTimer);
        t.waitTimer = null;
        setWaiting(t, false);
        t.ended = true;
        // The last run ended while the window asked whether to stop it: nothing left to ask about.
        if (closeAsk && !runningTabs().length) closeAsk = false;
        // The remote's own check wants the user's OK first: nothing ran, and the question comes up now (§3.16).
        if (exit?.ended === "refused-remote" && exit.needsConfirm === true) {
          t.reask = true;
          t.reaskExit = exit;
          t.outcome = "stopped";
          t.status = reaskText(c.targetLabel);
          push();
          return;
        }
        t.outcome = outcomeOf(exit);
        t.status = exit?.ended === "timeout" && waited ? waitingTimeoutText(exit.ms)
          : statusLine(exit ?? { code: null, signal: null, ended: "failed-to-start", ms: 0, error: "Ember lost track of it" }, { label: c.targetLabel, os: o.os });
        push();
        // What the run left running carrying its marker, once its runner has looked (§3.13): named on the status line.
        const left = exit ? stragglersOf(run) : null;
        if (left && exit) {
          void left.then(names => {
            if (!names.length || disposed || !tabs.includes(t)) return;
            t.status = statusLine({ ...exit, stragglers: names }, { label: c.targetLabel, os: o.os });
            push();
          });
        }
      };
      Promise.resolve(run.done).then(finish, () => finish(null));
      // Every run brings the window above the user's others, without the keyboard (R1: where they can watch it).
      reveal(true);
      push();
    },

    show() {
      const w = ensure();
      if (!w) return;
      safe("show", () => { w.show(); w.moveTop(); w.focus(); });
      push();
    },

    owns: sender => owns(sender),

    onAnswer(fn) {
      answerFns.add(fn);
      return () => { answerFns.delete(fn); };
    },

    termSize: () => ({ ...(size ?? DEFAULT_TERM_SIZE) }),

    announceMs: base => (screenReader() ? Math.max(base, ANNOUNCE_SCREEN_READER_MS) : base),

    reaskEnded(runId, why) {
      const t = tabs.find(x => x.card.runId === runId && x.reask === true);
      if (disposed || !t) return;
      t.reask = false;
      if (why === "refused" && t.reaskExit) {
        t.outcome = "failed";
        t.status = statusLine(t.reaskExit, { label: t.card.targetLabel, os: o.os });
      } else {
        t.status = reaskEndText(why === "no" ? "no" : "stopped");
      }
      push();
    },

    onWaiting(fn) {
      waitingFns.add(fn);
      return () => { waitingFns.delete(fn); };
    },

    note(runId, text) {
      const t = tabs.find(x => x.card.runId === runId);
      if (!t || t.ended) return;
      t.note = typeof text === "string" && text ? text.slice(0, 500) : null;
      push();
    },

    pending(taskId, text) {
      if (disposed || !str(taskId, 200, 1)) return;
      // One short line, every invisible character shown (it names a distro); nothing to show clears it.
      const line = typeof text === "string" ? outsideText(text, 200) : "";
      if (!line) {
        if (!pendings.delete(taskId)) return;
        push();
        settle();
        return;
      }
      if (pendings.get(taskId) === line) return;
      if (!pendings.has(taskId) && pendings.size >= MAX_PENDING) return;
      pendings.set(taskId, line);
      reveal();
      push();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnnouncements();
      for (const t of tabs) dropTab(t);
      tabs = [];
      card = null;
      view = null;
      pendings.clear();
      answerFns.clear();
      waitingFns.clear();
      const w = live();
      win = null;
      if (w) safe("close", () => w.close());
    },
  };
}

/**
 * The names a run says it left running (RUN's and WA's runs: `stragglers`, a promise settled after their last sweep or
 * the look a run that ended by itself gets), as plain strings; null for a run that doesn't say (a remote's).
 */
export function stragglersOf(run: RunningCommand): Promise<string[]> | null {
  const s = (run as RunningCommand & { stragglers?: unknown }).stragglers;
  if (!s || typeof (s as PromiseLike<unknown>).then !== "function") return null;
  return Promise.resolve(s as PromiseLike<unknown>).then(
    v => (Array.isArray(v) ? v.filter((n): n is string => typeof n === "string" && n !== "").slice(0, 64) : []),
    () => [],
  );
}

/** A finished run's symbol: done (exit 0), stopped (by the user, its task or the kill switch), else failed. */
export function outcomeOf(exit: RunExit | null): TabView["outcome"] {
  if (!exit) return "failed";
  if (exit.ended === "exit" && exit.code === 0) return "done";
  if (exit.ended === "stopped-user" || exit.ended === "stopped-task" || exit.ended === "killswitch") return "stopped";
  return "failed";
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
