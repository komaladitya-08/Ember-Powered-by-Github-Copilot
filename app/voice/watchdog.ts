/** Notices microphone frames that stop arriving: once per stall, after 3 s without one (10 s before the first). */
export class FrameWatchdog {
  private last: number;
  private seen = false;
  private fired = false;

  constructor(private onStall: (ms: number) => void, private now: () => number = Date.now, private gapMs = 3000, private firstMs = 10_000) {
    this.last = now();
  }

  frame(): void {
    this.last = this.now();
    this.seen = true;
    this.fired = false;
  }

  check(): void {
    const gap = this.now() - this.last;
    if (this.fired || gap <= (this.seen ? this.gapMs : this.firstMs)) return;
    this.fired = true;
    this.onStall(gap);
  }
}
