/** Host-owned limits for a native coding task; time spent answering its questions does not count. */
export class CodingBudget {
  private steps = 0;
  private left: number;
  private since = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private asking = 0;
  private over = false;

  constructor(private readonly exceeded: (reason: string) => void, private readonly maxSteps = 150, private readonly maxMs = 20 * 60_000) {
    this.left = maxMs;
    this.go();
  }

  /** Reserve one tool call before any asynchronous safety or permission check can yield. */
  tool(): boolean {
    if (this.over) return false;
    if (++this.steps <= this.maxSteps) return true;
    this.stop();
    this.exceeded(`I stopped because the coding task reached its limit of ${this.maxSteps} tool calls.`);
    return false;
  }

  private go(): void {
    this.since = performance.now();
    this.timer = setTimeout(() => {
      this.stop();
      this.exceeded(`I stopped because the coding task took longer than ${Math.round(this.maxMs / 60_000)} minutes.`);
    }, Math.max(0, this.left));
    this.timer.unref?.();
  }

  async waiting<T>(answer: () => Promise<T>): Promise<T> {
    if (this.asking++ === 0 && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.left -= performance.now() - this.since;
    }
    try { return await answer(); }
    finally { if (--this.asking === 0 && !this.over) this.go(); }
  }

  stop(): void {
    this.over = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
