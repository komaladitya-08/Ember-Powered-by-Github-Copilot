/**
 * Questions Ember asks with buttons in its bubble ("Allow" / "Not now").
 * Only a click in Ember's own bubble answers them (never voice, never the
 * model). One question shows at a time; the rest wait their turn. Unanswered
 * questions expire as "no", counted from when they appear on screen.
 *
 * A question can't be answered by accident: clicks in its first moments are
 * ignored (a double-click or a click already on its way lands on nothing),
 * and the next question appears only after a short gap, so the second click of
 * a double-click never approves it. While Ember borrows the mouse, nothing is
 * answered at all (a borrowed click must never approve anything). Keyboard
 * users answer with shortcuts (main registers them while a question is up,
 * and the bubble names them).
 *
 * A question whose whole content shows in a window of Ember's own (the command card, a consent card: its `panel`) is
 * allowed only from that window's own buttons, carrying the hash of what it showed, or with the approve keys while that
 * window shows all of it (`panelReady`); never from the bubble, which only brings the window up (R7). "Not now" is
 * taken from anywhere. Without the `panelReady` wiring such a question can't be allowed at all (fail closed).
 *
 * A question whose sentence shows a typed text only in part (`detail`: its two ends and its length) shows all of it in a
 * block that scrolls under the sentence (review #116). Allow, from its button or the approve key, works only once the
 * page showing it has said all of it was in view (`wholeSeen`), as the command card's and the consent cards' do, and it
 * has been armed again since; before then the approve key shows the next part instead, and a key pressed again too soon
 * (held down, or once more than needed) never allows. Not now works at once. Such a question waits longer, by the
 * length of its text (timeoutOf).
 */

import type { BubbleState, EmberState } from "../../shared/overlay";
import type { ConsentPanel } from "../../shared/consent";
import type { CommandCard } from "../commands/types";

/** How an answer arrived: a bubble button, Ember's approve/deny keys, or the panel window's own buttons. */
export type AnswerVia = "bubble" | "key" | "panel";

/** A question whose full content shows in a window of Ember's own (the command card, a consent card). */
export type QuestionPanel =
  | { kind: "command"; card: CommandCard }
  | { kind: "consent"; consent: ConsentPanel };

export interface Question {
  title: string;
  /** What the bubble is titled with once answered (e.g. the task's name). */
  context?: string;
  prompt: string;
  options: { id: string; label: string; primary?: boolean }[];
  /** The task asking (its id): the question's bubble, and the one after the answer, belong to it. */
  task?: string;
  /** Where the asking task acts ("on build-01"): a badge in the bubble and the panel. */
  where?: string;
  /** How long clicks are ignored after it shows (default ConfirmerTiming.armMs). */
  armMs?: number;
  /** Its full content shows in a panel window; only that window's buttons (or the keys while it is fully shown) allow it. */
  panel?: QuestionPanel;
  /** The keys can't allow it (consent cards: a click only). */
  clickOnly?: boolean;
  /**
   * The whole of what its sentence shows only in part: a typed text cut to its two ends (Decision.detail), or fill_cells'
   * cells each with all of its content, one to a line. Shown as the sentence shows typed text (policy.ts typedUnits).
   */
  detail?: string;
}

/** The hash a panel question's yes must carry back: the command card's, or the consent card's. */
const panelSha256 = (panel: QuestionPanel): string => (panel.kind === "command" ? panel.card.sha256 : panel.consent.sha256);
/** A SHA-256 as sha256Hex writes it: a card whose hash isn't one (empty, cut short) can't be allowed (fail closed). */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * A question with a whole text to read (Question.detail): whether all of it has been in view and since when (`seenAt`),
 * how many times the approve key asked for more, and when that key was last pressed (`keyAt`).
 */
interface WholeRead { seen: boolean; page: number; seenAt: number; keyAt: number }
interface Pending { n: number; q: Question; resolve: (answer: string | null) => void; timer: ReturnType<typeof setTimeout> | null; shownAt: number; off?: () => void; whole?: WholeRead }

export interface ConfirmerTiming {
  /** How long a question stays up before it expires as "no" (read as each one shows: the user's setting may change). */
  timeoutMs?: number | (() => number);
  /** Clicks this soon after a question appears are ignored. */
  armMs?: number;
  /** The pause between one question being answered and the next appearing. */
  gapMs?: number;
  now?: () => number;
  /** No answers are taken while this is true (Ember is using the mouse). */
  blocked?: () => boolean;
  /** A question appeared (or the last one went away): for keyboard shortcuts, speaking it, showing Ember. */
  onChange?: (q: { n: number; question: Question } | null) => void;
  /** The keys that answer a question, shown under it (e.g. "Ctrl+Alt+Y allow · Ctrl+Alt+N not now"). */
  keyHint?: () => string | undefined;
  /**
   * The keys under a question whose whole text hasn't all been shown yet, when the approve key shows its next part
   * instead of allowing (e.g. "Ctrl+Alt+Y shows the next part · Ctrl+Alt+N not now"). Absent: no keys are named then,
   * never keyHint's "allow", which the key doesn't do yet.
   */
  readKeyHint?: () => string | undefined;
  /**
   * Question n's panel window is on screen showing all of it (main wires TargetsRuntime.panelReady): only then may the
   * approve key allow a panel question. Absent (tests, the eval): panel questions can't be allowed at all.
   */
  panelReady?: (n: number) => boolean;
  /** Under a panel question, how to reach its window from the keyboard (main wires the targets runtime's panelHint). */
  panelHint?: (panel: QuestionPanel) => string | undefined;
}

export class Confirmer {
  private queue: Pending[] = [];
  private current: Pending | null = null;
  private n = 0;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private timeoutMs: number | (() => number);
  private armMs: number;
  private gapMs: number;
  private now: () => number;
  private blocked: () => boolean;
  private onChange: ConfirmerTiming["onChange"];
  private keyHint: ConfirmerTiming["keyHint"];
  private readKeyHint: ConfirmerTiming["readKeyHint"];
  private panelReady: ConfirmerTiming["panelReady"];
  private panelHint: ConfirmerTiming["panelHint"];
  /** Waiting for no question to be up or queued (settled()). */
  private settledWaiters: (() => void)[] = [];

  constructor(private show: (patch: Partial<EmberState>) => void, timing: number | ConfirmerTiming = {}) {
    const t = typeof timing === "number" ? { timeoutMs: timing } : timing;
    this.timeoutMs = t.timeoutMs ?? 120_000;
    this.armMs = t.armMs ?? 500;
    this.gapMs = t.gapMs ?? 700;
    this.now = t.now ?? Date.now;
    this.blocked = t.blocked ?? (() => false);
    this.onChange = t.onChange;
    this.keyHint = t.keyHint;
    this.readKeyHint = t.readKeyHint;
    this.panelReady = t.panelReady;
    this.panelHint = t.panelHint;
  }

  /**
   * Resolves with the chosen option id, or null if it expired, was cancelled,
   * or `signal` aborted (the task stopped) before the user answered.
   */
  ask(q: Question, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise(resolve => {
      const p: Pending = { n: ++this.n, q, resolve, timer: null, shownAt: 0, ...(q.detail ? { whole: { seen: false, page: 0, seenAt: 0, keyAt: 0 } } : {}) };
      if (signal) {
        const onAbort = () => this.finish(p, null);
        signal.addEventListener("abort", onAbort, { once: true });
        p.off = () => signal.removeEventListener("abort", onAbort);
      }
      this.queue.push(p);
      if (!this.current && !this.gapTimer) this.next();
    });
  }

  get waiting(): boolean {
    return this.current !== null;
  }

  /** Resolves once no question is up or waiting its turn (at once if none is). */
  settled(): Promise<void> {
    if (this.isSettled()) return Promise.resolve();
    return new Promise(resolve => this.settledWaiters.push(resolve));
  }

  private isSettled(): boolean {
    return !this.current && !this.queue.length && !this.gapTimer;
  }

  private checkSettled(): void {
    if (!this.isSettled()) return;
    for (const w of this.settledWaiters.splice(0)) w();
  }

  /**
   * An answer to the question up now: a bubble button (`via` "bubble"), Ember's keys ("key"), or a panel window's own
   * button ("panel", with the hash of what it showed in `proof`). Returns false if it didn't belong to the question up,
   * came too soon, or came from somewhere that may not give it (see allowedFrom).
   */
  answer(actionId: string, via: AnswerVia = "bubble", proof?: { sha256: string }): boolean {
    const m = /^q(\d+):(.+)$/.exec(actionId);
    if (!m || !this.current || Number(m[1]) !== this.current.n) return false;
    if (!this.current.q.options.some(o => o.id === m[2])) return false;
    if (this.now() - this.current.shownAt < this.armOf(this.current.q) || this.blocked()) return false;
    if (!this.allowedFrom(this.current, m[2], via, proof)) return false;
    this.finish(this.current, m[2]);
    return true;
  }

  /**
   * May `option` be chosen for this question from `via`? "Not now" always. Otherwise: a click-only question never by the
   * keys; a panel window answers only its own question; a panel question only from its panel with the hash of exactly
   * what it showed, or by the keys while that panel shows all of it, and never without the `panelReady` wiring.
   */
  private allowedFrom(p: Pending, option: string, via: AnswerVia, proof: { sha256: string } | undefined): boolean {
    if (option === "deny") return true;
    // Its whole text not yet all in view: nothing but Not now (review #116). Once it has been, Allow is armed afresh, so
    // the press or scroll that brought its end into view can't also allow it.
    if (p.whole && (!p.whole.seen || this.now() - p.whole.seenAt < this.armOf(p.q))) return false;
    if (via === "key" && p.q.clickOnly) return false;
    const panel = p.q.panel;
    if (!panel) return via !== "panel";
    if (!this.panelReady) return false;
    if (via === "panel") {
      const want = panelSha256(panel);
      return typeof want === "string" && SHA256_HEX.test(want) && proof?.sha256 === want;
    }
    if (via !== "key") return false;
    // A readiness check that fails can't say the whole card is in view (fail closed).
    try {
      return this.panelReady(p.n) === true;
    } catch {
      return false;
    }
  }

  /** How to reach a panel question's window from the keyboard, or null when main doesn't say (a hint that throws says nothing). */
  private panelHintFor(panel: QuestionPanel): string | null {
    try { return this.panelHint?.(panel) || null; } catch { return null; }
  }

  /** How long the question showing now waits for an answer (a setting that can't be read: the default 2 minutes). */
  private timeout(): number {
    const t = this.timeoutMs;
    if (typeof t === "number") return t;
    try { const v = t(); return Number.isFinite(v) && v > 0 ? v : 120_000; } catch { return 120_000; }
  }

  /**
   * How long question `p` waits: the question time, and for a whole text to read, half as much again for every 1000
   * characters of it (a minute at the usual 2 minutes, ten with More time to read and answer), so paging through 5000
   * characters, or hearing them read out, doesn't run its time out (final review U1).
   */
  private timeoutOf(p: Pending): number {
    const t = this.timeout();
    return p.whole && p.q.detail ? Math.round(t * (1 + p.q.detail.length / 2000)) : t;
  }

  /** How long clicks are ignored after `q` shows: its own arm time, or the default when it has none (or none that is a time). */
  private armOf(q: Question): number {
    return typeof q.armMs === "number" && Number.isFinite(q.armMs) && q.armMs >= 0 ? q.armMs : this.armMs;
  }

  /**
   * A keyboard answer: the primary option ("Allow"), "deny" ("Not now") or "always". Before all of a question's whole text
   * has been in view, a yes by key shows the next part of it instead (the keyboard's way through it: the bubble takes no
   * keyboard focus), and answers nothing. After that, a yes by key is taken only once the key has rested for the arm time
   * since its last press: a press too soon is refused and starts the wait again, so a key held down (the system repeating
   * it) or pressed once more than needed pages through to the end but never allows.
   */
  answerKey(which: "primary" | "deny" | "always"): boolean {
    const c = this.current;
    if (!c) return false;
    if (which !== "deny" && c.whole) {
      const now = this.now();
      if (!c.whole.seen) {
        if (!this.blocked()) {
          c.whole.page += 1;
          c.whole.keyAt = now;
          this.show({ bubble: this.bubbleOf(c) });
        }
        return false;
      }
      if (now - c.whole.keyAt < this.armOf(c.q)) { c.whole.keyAt = now; return false; }
    }
    const opt = which === "primary" ? c.q.options.find(o => o.primary) ?? c.q.options[0] : c.q.options.find(o => o.id === which);
    return opt ? this.answer(`q${c.n}:${opt.id}`, "key") : false;
  }

  /**
   * The page showing question `n` says all of its whole text has been in view (scrolled to its end, or it fits): its
   * Allow works from now on. False if `n` isn't the question up, has no whole text, or was already read.
   */
  wholeSeen(n: number): boolean {
    const c = this.current;
    if (!c || c.n !== n || !c.whole || c.whole.seen) return false;
    c.whole.seen = true;
    c.whole.seenAt = this.now();
    this.show({ bubble: this.bubbleOf(c) });
    return true;
  }

  cancelAll(): void {
    if (this.gapTimer) { clearTimeout(this.gapTimer); this.gapTimer = null; }
    for (const p of [...this.queue]) this.finish(p, null);
    if (this.current) this.finish(this.current, null);
    this.checkSettled();
  }

  private next(): void {
    this.gapTimer = null;
    this.current = this.queue.shift() ?? null;
    if (!this.current) { this.checkSettled(); return; }
    const p = this.current;
    p.shownAt = this.now();
    p.timer = setTimeout(() => this.finish(p, null), this.timeoutOf(p));
    this.show({ emotion: "curious", talking: false, bubble: this.bubbleOf(p) });
    this.onChange?.({ n: p.n, question: p.q });
  }

  /** The bubble for question `p`: shown when it comes up, and again when its whole text has been read or paged on. */
  private bubbleOf(p: Pending): BubbleState {
    // The whole task, so a step like "press Enter" is read as part of what the user asked for (typing and saving too).
    const task = p.q.context?.trim();
    const panel = p.q.panel;
    return {
      visible: true, mood: "attention", title: p.q.title,
      thought: task && task !== p.q.prompt ? `${p.q.prompt}\nYour task: ${task}` : p.q.prompt,
      // A panel question is answered in its window, which names the keys while they work there; its step says how to
      // get there from the keyboard (the bubble's own buttons are mouse-only). Until all of a whole text has been shown,
      // the approve key shows its next part: the keys say that, not "allow".
      step: panel ? this.panelHintFor(panel) : (p.whole && !p.whole.seen ? this.readKeyHint?.() : this.keyHint?.()) || null, streaming: false,
      // A panel question's bubble only brings its window up (or says no): what is allowed must be seen whole first.
      actions: panel
        ? [{ id: `ui:panel:${p.n}`, label: panel.kind === "command" ? "Show the command" : "Read it" }, { id: `q${p.n}:deny`, label: "Not now" }]
        : p.q.options.map(o => ({ id: `q${p.n}:${o.id}`, label: o.label, primary: o.primary })),
      ...(p.q.task ? { task: p.q.task } : {}),
      ...(p.q.where ? { where: p.q.where } : {}),
      // All of a typed text its sentence cuts short, under it (review #116).
      ...(p.whole && p.q.detail ? { whole: { n: p.n, text: p.q.detail, seen: p.whole.seen, page: p.whole.page } } : {}),
    };
  }

  private finish(p: Pending, answer: string | null): void {
    if (p.timer) clearTimeout(p.timer);
    p.off?.();
    const queued = this.queue.includes(p);
    const wasCurrent = this.current === p;
    if (!queued && !wasCurrent) return; // already answered
    this.queue = this.queue.filter(x => x !== p);
    if (wasCurrent) {
      this.current = null;
      // "Not now" (or no answer) leaves Ember idle, not still working.
      const yes = !!answer && answer !== "deny";
      this.show({ emotion: yes ? "focused" : "neutral", talking: false, bubble: { visible: true, mood: yes ? "acting" : "idle", title: p.q.context ?? p.q.title, thought: yes ? "Thanks! Carrying on." : "Okay, I won't.", step: null, streaming: false, actions: [], ...(p.q.task ? { task: p.q.task } : {}), ...(p.q.where ? { where: p.q.where } : {}) } });
    }
    p.resolve(answer);
    if (wasCurrent) this.onChange?.(null);
    if (wasCurrent && this.queue.length) {
      if (this.gapTimer) clearTimeout(this.gapTimer);
      this.gapTimer = setTimeout(() => this.next(), this.gapMs);
    }
    this.checkSettled();
  }
}

/**
 * Wraps a state setter so that, while a question is on screen, nothing else
 * replaces the bubble or Ember's face (a worker's reasoning would otherwise
 * wipe the buttons before the user can click them). Other fields still pass.
 */
export function guardWhileAsking(asking: () => boolean, show: (patch: Partial<EmberState>) => void): (patch: Partial<EmberState>) => void {
  return next => {
    if (asking() && (next.bubble || next.emotion || next.talking !== undefined)) {
      const { bubble: _b, emotion: _e, talking: _t, ...rest } = next;
      if (Object.keys(rest).length) show(rest);
      return;
    }
    show(next);
  };
}
