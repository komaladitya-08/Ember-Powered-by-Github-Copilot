/**
 * The command window's controller ("Ember commands", §3.9-§3.10, §8.5): the card that shows a whole command before
 * Allow, the announcement that counts down before a command the user asked for runs, and a tab per run with its live
 * output, its status line, Stop, and the user's typing straight to the process (R1, R7).
 *
 * Plain Node (L13): the window comes from `create()` (windows.ts's createCommandWindow, S0b) and the IPC from `ipc`.
 * Every message from a page is taken only from this window's own webContents and checked field by field. What the user
 * types is never logged, never kept here and never sent anywhere but the run. The window is made only when something
 * needs it (a card, an announcement, a run, or the user opening it), so with commands off nothing new appears.
 */

import { createHash } from "node:crypto";
import { COMMANDS_IPC } from "../../shared/commands";
import type { OS } from "../../shared/shortcuts";
import { parseTargetId } from "../../shared/targets";
import type { Logger } from "../logger";
import type { BrowserWindowLike, IpcLike, WebContentsLike } from "../targets/types";
import type { CommandCard, CommandWindowPort, RunExit, RunningCommand } from "./types";
import { RUNNING_STATUS, headerLine, statusLine, typingHint } from "../../renderer/command/copy";
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

/** What the controller adds to the port for the targets runtime (beyond the contract; see the package report). */
export interface CommandWindowExtras {
  /** Answers from the card's own buttons (already checked: this window, the card on screen, its sha256, armed and seen). */
  onAnswer(fn: (a: AnswerMsg) => void): () => void;
  /** The terminal size new runs should start at (what the window's page says fits, else 100×30). */
  termSize(): { cols: number; rows: number };
  /** A note in a running tab's status line ("Starting Ubuntu…", the stalled-link countdown), or null to clear it. */
  note(runId: string, text: string | null): void;
}

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
}

interface Announcement {
  card: CommandCard;
  ms: number;
  endsAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  settle: (ok: boolean) => void;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
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
export function createCommandWindowPort(o: { create: () => BrowserWindowLike; ipc: IpcLike; log: Logger; os: OS; keyHint: () => string | null }):
  CommandWindowPort & { show(): void; owns(sender: WebContentsLike): boolean; dispose(): void } {
  return createCommandWindowController(o);
}

/** createCommandWindowPort with its extras typed: the same object (the targets runtime may call this name instead). */
export function createCommandWindowController(o: { create: () => BrowserWindowLike; ipc: IpcLike; log: Logger; os: OS; keyHint: () => string | null }): CommandWindowController {
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
  let card: { n: number; card: CommandCard; shownAt: number } | null = null;
  let view: SeenMsg | null = null;
  const queue: Announcement[] = [];
  const answerFns = new Set<(a: AnswerMsg) => void>();
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
    try { wire(); } catch (err) { note("error", "commands.ipc_failed", { err }); }
    w.on("closed", () => {
      if (win !== w) return;
      win = null;
      view = null;
      // Closed during a countdown: the user didn't get to see it to the end, so no command waiting there runs (fail
      // closed), and the window doesn't come back for the next one.
      cancelAnnouncements();
    });
    return w;
  }

  function keyHint(): string | null {
    try {
      const h = o.keyHint();
      return typeof h === "string" && h ? h : null;
    } catch { return null; } // a hint that can't be built shows none
  }

  function tabView(t: Tab): TabView {
    const interactive = !t.ended && t.run.interactive === true;
    return {
      runId: t.card.runId, seq: t.seq, header: headerLine(t.card), command: t.card.command,
      status: t.note && !t.ended ? t.note : t.status, interactive, ended: t.ended, title: t.card.taskTitle,
      typing: typingHint({ interactive, ended: t.ended }), cols: t.size.cols, rows: t.size.rows, outcome: t.outcome,
    };
  }

  function stateNow(): WindowView {
    const head = queue[0];
    return {
      rev: ++rev,
      tabs: tabs.map(tabView),
      card: card ? { ...card.card, n: card.n } : null,
      announce: head && head.endsAt !== null ? { card: head.card, endsAt: head.endsAt } : null,
      keyHint: card ? keyHint() : null,
    };
  }

  function push(): void {
    const w = live();
    if (!w) return;
    safe("send-state", () => w.webContents.send(COMMANDS_IPC.state, stateNow()));
  }

  /** Brings the window up without taking the keyboard from the user's app; on top while a card or countdown is up. */
  function reveal(): void {
    const w = ensure();
    if (!w) return;
    const onTop = !!card || queue.length > 0;
    safe("reveal", () => {
      if (onTop) w.setAlwaysOnTop(true, "floating");
      if (!w.isVisible() || w.isMinimized()) w.showInactive();
      if (onTop) w.moveTop();
    });
  }

  /** A card or countdown went: no longer on top; hidden again when there is nothing else to show. */
  function settle(): void {
    const w = live();
    if (!w || card || queue.length) return;
    safe("settle", () => {
      w.setAlwaysOnTop(false);
      if (!tabs.length && w.isVisible()) w.hide();
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
      if (raw.answer === "once") {
        const armed = Date.now() >= card.shownAt + card.card.armMs;
        const seen = view?.n === card.n && view.seen;
        if (!armed || !seen) { note("warn", "commands.allow_too_early", { n: card.n, armed, seen }); return; }
      }
      const a: AnswerMsg = { n: raw.n, answer: raw.answer, sha256: raw.sha256 };
      for (const fn of [...answerFns]) safe("answer", () => fn(a));
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
      card = { n, card: c, shownAt: Date.now() };
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
      // The same run shown again (a retry after the remote asked): its old tab goes.
      for (const old of tabs.filter(t => t.card.runId === c.runId)) dropTab(old);
      tabs = tabs.filter(t => t.card.runId !== c.runId);
      const t: Tab = {
        seq: seqNext++, card: c, run, ended: false, outcome: "running", status: RUNNING_STATUS, note: null, size: size ?? { ...DEFAULT_TERM_SIZE },
        kept: [], keptBytes: 0, start: 0, total: 0, pending: [], pendingAt: 0, pendingBytes: 0, flush: null, unsubscribe: () => undefined,
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
        t.ended = true;
        t.outcome = outcomeOf(exit);
        t.status = statusLine(exit ?? { code: null, signal: null, ended: "failed-to-start", ms: 0, error: "Ember lost track of it" }, { label: c.targetLabel, os: o.os });
        push();
      };
      Promise.resolve(run.done).then(finish, () => finish(null));
      reveal();
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

    note(runId, text) {
      const t = tabs.find(x => x.card.runId === runId);
      if (!t || t.ended) return;
      t.note = typeof text === "string" && text ? text.slice(0, 500) : null;
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
      answerFns.clear();
      const w = live();
      win = null;
      if (w) safe("close", () => w.close());
    },
  };
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
