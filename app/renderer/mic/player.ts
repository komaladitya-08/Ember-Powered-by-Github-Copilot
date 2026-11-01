/**
 * Plays Ember's own voice: the chunks of each reply, back to back without gaps, as they arrive (the next is made
 * while one plays). Says when speech starts and when the last scheduled chunk of the last reply has finished, so
 * main knows while Ember speaks. A hush stops everything at once. The AudioContext is made on first use (a page
 * that only listens never has one) and plays at the voice's own rate (Chromium resamples for the device).
 */

/** The parts of Web Audio the player uses (a stand-in in tests). */
export interface PlayerAudio {
  readonly currentTime: number;
  readonly state: string;
  resume(): Promise<void>;
  createBuffer(channels: number, length: number, rate: number): { copyToChannel(data: Float32Array, channel: number): void; readonly duration: number };
  createBufferSource(): PlayerSource;
  readonly destination: unknown;
}

export interface PlayerSource {
  buffer: unknown;
  onended: (() => void) | null;
  connect(to: unknown): void;
  start(when: number): void;
  stop(): void;
}

/** A moment between a chunk arriving and its sound, so it never starts in the past (s). */
const LEAD_S = 0.03;

export class Player {
  private ctx: PlayerAudio | null = null;
  private playing = new Set<PlayerSource>();
  /** Replies with chunks still to come (their "done" hasn't arrived). */
  private open = new Set<number>();
  private nextAt = 0;
  private on = false;
  /** Replies at or below this were hushed: their late chunks are dropped. */
  private hushed = 0;

  constructor(private make: () => PlayerAudio, private speaking: (on: boolean) => void) {}

  /** Schedules a chunk of reply `id`; returns how long it plays (s), or 0 when it was dropped (its reply was hushed). */
  chunk(id: number, samples: Float32Array, rate: number): number {
    if (id <= this.hushed || !samples.length) return 0;
    this.open.add(id);
    const ctx = (this.ctx ??= this.make());
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    const buffer = ctx.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + LEAD_S, this.nextAt);
    src.onended = () => { this.playing.delete(src); this.settle(); };
    src.start(at);
    this.nextAt = at + buffer.duration;
    this.playing.add(src);
    this.tell(true);
    return buffer.duration;
  }

  /** Reply `id` has no more chunks. */
  done(id: number): void {
    this.open.delete(id);
    this.settle();
  }

  /** Stops at once; chunks of replies up to `upTo` that are still on their way are dropped. */
  stop(upTo = Number.MAX_SAFE_INTEGER): void {
    this.hushed = Math.max(this.hushed, Math.min(upTo, Math.max(0, ...this.open)));
    this.open.clear();
    for (const src of this.playing) { src.onended = null; try { src.stop(); } catch { /* not started yet */ } }
    this.playing.clear();
    this.nextAt = 0;
    this.tell(false);
  }

  /** Whether Ember's voice is playing, or about to (a reply's next chunk is on its way). */
  get active(): boolean {
    return this.on;
  }

  private settle(): void {
    if (!this.playing.size && !this.open.size) { this.nextAt = 0; this.tell(false); }
  }

  private tell(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.speaking(on);
  }
}
