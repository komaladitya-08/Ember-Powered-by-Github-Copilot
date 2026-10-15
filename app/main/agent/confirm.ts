/**
 * Questions Ember asks with buttons in its bubble ("Allow" / "Not now").
 * Only a click in Ember's own bubble answers them (never voice, never the
 * model). One question shows at a time; the rest wait their turn. Unanswered
 * questions expire as "no".
 */

import type { BubbleState, EmberState } from "../../shared/overlay";

export interface Question {
  title: string;
  prompt: string;
  options: { id: string; label: string; primary?: boolean }[];
}

interface Pending { n: number; q: Question; resolve: (answer: string | null) => void; timer: ReturnType<typeof setTimeout> }

export class Confirmer {
  private queue: Pending[] = [];
  private current: Pending | null = null;
  private n = 0;

  constructor(
    private show: (patch: Partial<EmberState>) => void,
    private timeoutMs = 120_000,
  ) {}

  /** Resolves with the chosen option id, or null if it expired or was cancelled. */
  ask(q: Question): Promise<string | null> {
    return new Promise(resolve => {
      const p: Pending = { n: ++this.n, q, resolve, timer: setTimeout(() => this.finish(p, null), this.timeoutMs) };
      this.queue.push(p);
      if (!this.current) this.next();
    });
  }

  get waiting(): boolean {
    return this.current !== null;
  }

  /** A bubble button was clicked. Returns false if it didn't belong to a question. */
  answer(actionId: string): boolean {
    const m = /^q(\d+):(.+)$/.exec(actionId);
    if (!m || !this.current || Number(m[1]) !== this.current.n) return false;
    if (!this.current.q.options.some(o => o.id === m[2])) return false;
    this.finish(this.current, m[2]);
    return true;
  }

  cancelAll(): void {
    for (const p of [...this.queue]) this.finish(p, null);
    if (this.current) this.finish(this.current, null);
  }

  private next(): void {
    this.current = this.queue.shift() ?? null;
    if (!this.current) return;
    const { n, q } = this.current;
    const bubble: BubbleState = {
      visible: true, mood: "attention", title: q.title, thought: q.prompt, step: null, streaming: false,
      actions: q.options.map(o => ({ id: `q${n}:${o.id}`, label: o.label, primary: o.primary })),
    };
    this.show({ emotion: "curious", talking: false, bubble });
  }

  private finish(p: Pending, answer: string | null): void {
    clearTimeout(p.timer);
    this.queue = this.queue.filter(x => x !== p);
    const wasCurrent = this.current === p;
    if (wasCurrent) {
      this.current = null;
      this.show({ emotion: answer && answer !== "deny" ? "focused" : "neutral", bubble: { visible: true, mood: "acting", title: p.q.title, thought: answer && answer !== "deny" ? "Thanks! Carrying on." : "Okay, I won't.", step: null, streaming: false, actions: [] } });
    }
    p.resolve(answer);
    if (wasCurrent) this.next();
  }
}
