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
