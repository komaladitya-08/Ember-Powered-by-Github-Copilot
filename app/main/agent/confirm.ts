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
 * users answer with shortcuts (main registers them while a question is up).
 */

import type { BubbleState, EmberState } from "../../shared/overlay";

export interface Question {
  title: string;
  /** What the bubble is titled with once answered (e.g. the task's name). */
  context?: string;
  prompt: string;
  options: { id: string; label: string; primary?: boolean }[];
}

interface Pending { n: number; q: Question; resolve: (answer: string | null) => void; timer: ReturnType<typeof setTimeout> | null; shownAt: number; off?: () => void }

export interface ConfirmerTiming {
  /** How long a question stays up before it expires as "no". */
  timeoutMs?: number;
  /** Clicks this soon after a question appears are ignored. */
  armMs?: number;
  /** The pause between one question being answered and the next appearing. */
  gapMs?: number;
  now?: () => number;
  /** No answers are taken while this is true (Ember is using the mouse). */
  blocked?: () => boolean;
  /** A question appeared (or the last one went away): for keyboard shortcuts, speaking it, showing Ember. */
  onChange?: (q: { n: number; question: Question } | null) => void;
}

export class Confirmer {
  private queue: Pending[] = [];
  private current: Pending | null = null;
  private n = 0;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private timeoutMs: number;
  private armMs: number;
  private gapMs: number;
  private now: () => number;
  private blocked: () => boolean;
  private onChange: ConfirmerTiming["onChange"];

  constructor(private show: (patch: Partial<EmberState>) => void, timing: number | ConfirmerTiming = {}) {
    const t = typeof timing === "number" ? { timeoutMs: timing } : timing;
    this.timeoutMs = t.timeoutMs ?? 120_000;
    this.armMs = t.armMs ?? 500;
    this.gapMs = t.gapMs ?? 700;
    this.now = t.now ?? Date.now;
    this.blocked = t.blocked ?? (() => false);
    this.onChange = t.onChange;
  }

  /**
   * Resolves with the chosen option id, or null if it expired, was cancelled,
   * or `signal` aborted (the task stopped) before the user answered.
   */
  ask(q: Question, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise(resolve => {
      const p: Pending = { n: ++this.n, q, resolve, timer: null, shownAt: 0 };
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

  /** A bubble button was clicked. Returns false if it didn't belong to a question (or came too soon). */
  answer(actionId: string): boolean {
    const m = /^q(\d+):(.+)$/.exec(actionId);
    if (!m || !this.current || Number(m[1]) !== this.current.n) return false;
    if (!this.current.q.options.some(o => o.id === m[2])) return false;
    if (this.now() - this.current.shownAt < this.armMs || this.blocked()) return false;
    this.finish(this.current, m[2]);
    return true;
  }

  /** A keyboard answer: the primary option ("Allow"), "deny" ("Not now") or "always". */
  answerKey(which: "primary" | "deny" | "always"): boolean {
    const c = this.current;
    if (!c) return false;
    const opt = which === "primary" ? c.q.options.find(o => o.primary) ?? c.q.options[0] : c.q.options.find(o => o.id === which);
    return opt ? this.answer(`q${c.n}:${opt.id}`) : false;
  }

  cancelAll(): void {
    if (this.gapTimer) { clearTimeout(this.gapTimer); this.gapTimer = null; }
    for (const p of [...this.queue]) this.finish(p, null);
    if (this.current) this.finish(this.current, null);
  }

  private next(): void {
    this.gapTimer = null;
    this.current = this.queue.shift() ?? null;
    if (!this.current) return;
    const p = this.current;
    p.shownAt = this.now();
    p.timer = setTimeout(() => this.finish(p, null), this.timeoutMs);
    const bubble: BubbleState = {
      visible: true, mood: "attention", title: p.q.title, thought: p.q.prompt, step: null, streaming: false,
      actions: p.q.options.map(o => ({ id: `q${p.n}:${o.id}`, label: o.label, primary: o.primary })),
    };
    this.show({ emotion: "curious", talking: false, bubble });
    this.onChange?.({ n: p.n, question: p.q });
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
      this.show({ emotion: answer && answer !== "deny" ? "focused" : "neutral", bubble: { visible: true, mood: "acting", title: p.q.context ?? p.q.title, thought: answer && answer !== "deny" ? "Thanks! Carrying on." : "Okay, I won't.", step: null, streaming: false, actions: [] } });
    }
    p.resolve(answer);
    if (wasCurrent) this.onChange?.(null);
    if (wasCurrent && this.queue.length) {
      if (this.gapTimer) clearTimeout(this.gapTimer);
      this.gapTimer = setTimeout(() => this.next(), this.gapMs);
    }
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
