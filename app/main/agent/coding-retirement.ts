/** Retains only disposal witnesses; it carries no session, prompt, or Host authority. */
export interface CodingCleanupReceipt { wait(): Promise<void> }

/** No Host or raw exception is retained when a cleanup owner could not even issue its disposal witness. */
export function unconfirmedCodingCleanupReceipt(): CodingCleanupReceipt {
  return Object.freeze({ wait: async () => { throw new Error("Ember couldn't confirm that the coding runtime stopped. Coding remains unavailable."); } });
}

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

  /** A retained retry must not retain the Host and its conversations alongside these boolean witnesses. */
  cleanupReceipt(stopVerified = true): CodingCleanupReceipt {
    return retirementCleanupReceipt(this, stopVerified);
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

function retirementCleanupReceipt(retirement: CodingRetirement, stopVerified: boolean): CodingCleanupReceipt {
  return Object.freeze({ wait: async () => {
    const retired = await retirement.wait(5000).catch(() => false);
    if (!stopVerified || !retired) throw new Error("Ember couldn't confirm that the coding runtime stopped. Coding remains unavailable.");
  } });
}
