/**
 * Notices microphone frames that stop arriving: once per stall, after 3 s without one (10 s before the first).
 * A check that itself comes late (the computer slept, or the process was busy or frozen) says nothing about the
 * microphone: frames couldn't have been taken either, so the wait starts again from then.
 */
export class FrameWatchdog {
  private last: number;
  private lastCheck: number;
  private seen = false;
  private fired = false;

  constructor(private onStall: (ms: number) => void, private now: () => number = Date.now, private gapMs = 3000, private firstMs = 10_000) {
    this.last = this.lastCheck = now();
  }

  frame(): void {
    this.last = this.now();
    this.seen = true;
    this.fired = false;
  }

  check(): void {
    const now = this.now();
    if (now - this.lastCheck > this.gapMs) this.last = Math.max(this.last, now);
    this.lastCheck = now;
    const gap = now - this.last;
    if (this.fired || gap <= (this.seen ? this.gapMs : this.firstMs)) return;
    this.fired = true;
    this.onStall(gap);
  }
}

/**
 * Notices a microphone that sends only digital silence (every sample exactly 0): a muted input, or a monitor or unused
 * input chosen as the default. A live microphone always has some noise, so such audio means nothing can be heard. Says
 * so once after `ms` of it (a minute: a headset whose noise gate closes in a quiet room shouldn't be called muted at
 * once), and again as soon as any sound comes back (review #255).
 */
export class SilenceWatch {
  private zeroMs = 0;
  private silent = false;

  constructor(private onChange: (silent: boolean) => void, private ms = 60_000, private rate = 16_000) {}

  frame(f: Float32Array): void {
    let zero = true;
    for (let i = 0; i < f.length && zero; i++) zero = f[i] === 0;
    if (!zero) {
      this.zeroMs = 0;
      if (this.silent) { this.silent = false; this.onChange(false); }
      return;
    }
    this.zeroMs += (f.length * 1000) / this.rate;
    if (!this.silent && this.zeroMs >= this.ms) { this.silent = true; this.onChange(true); }
  }
}
