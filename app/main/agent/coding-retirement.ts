/** Tracks coding runtimes until their processes and private state have actually been retired. */
export class CodingRetirement {
  private readonly live = new Set<Promise<boolean>>();
  private readonly retiring = new Set<Promise<boolean>>();
  private readonly tracked = new WeakMap<Promise<boolean>, Promise<boolean>>();
  private failed = false;

  /** New coding work is held during retirement, and for the rest of this run after an unconfirmed cleanup. */
  get blocked(): boolean { return this.failed || this.retiring.size > 0; }

  track(disposed: Promise<boolean>): void {
    if (this.tracked.has(disposed)) return;
    const done = Promise.resolve(disposed).then(ok => ok === true, () => false).then(ok => {
      if (!ok) this.failed = true;
      this.live.delete(done);
      this.retiring.delete(done);
      return ok;
    });
    this.tracked.set(disposed, done);
    this.live.add(done);
  }

  /** One worker's retirement need not hold unrelated live work. Omit the promise for an account/vault-wide barrier. */
  retire(disposed?: Promise<boolean>): void {
    if (disposed === undefined) { for (const done of this.live) this.retiring.add(done); return; }
    // Register first if retirement reaches the host before its normal tracking call. Repeated calls are idempotent.
    this.track(disposed);
    const done = this.tracked.get(disposed)!;
    if (this.live.has(done)) this.retiring.add(done);
  }

  /** A timeout is not a success. Late confirmed cleanup releases the hold; a failed cleanup stays blocked. */
  async wait(ms: number): Promise<boolean> {
    this.retire();
    const pending = [...this.retiring];
    if (!pending.length) return !this.failed;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); timer.unref?.(); });
    try {
      const done = await Promise.race([Promise.all(pending).then(results => results.every(Boolean)), timeout]);
      return done && !this.failed && !this.retiring.size;
    } finally { if (timer) clearTimeout(timer); }
  }
}
