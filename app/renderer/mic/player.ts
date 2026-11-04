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
  /** A volume control for ducking; a stand-in without one just doesn't duck. */
  createGain?(): PlayerGain;
}

export interface PlayerGain {
  gain: { setTargetAtTime(level: number, at: number, seconds: number): void };
  connect(to: unknown): void;
}

export interface PlayerSource {
  buffer: unknown;
  onended: (() => void) | null;
  connect(to: unknown): void;
  start(when: number): void;
  stop(): void;
}

/** The parts of an AudioContext playerAudio() needs (a stand-in in tests). */
export interface PlayerContext extends PlayerAudio {
  createMediaStreamDestination(): { stream: unknown };
}

/** The parts of an <audio> element playerAudio() needs. */
export interface PlayerElement {
  srcObject: unknown;
  play(): Promise<void>;
}

/**
 * The audio the player writes to. `element` false: the context's own output, as always. True: a media stream played by
 * an <audio> element instead, which Chromium's echo cancellation is documented to cover where Web Audio isn't (the
 * microphone then hears less of Ember's own voice; scripts/voice/echo-check.mjs measures it).
 */
export function playerAudio(ctx: PlayerContext, element: boolean, makeElement: () => PlayerElement = () => new Audio()): PlayerAudio {
  if (!element) return ctx;
  const dest = ctx.createMediaStreamDestination();
  const out = makeElement();
  out.srcObject = dest.stream;
  // A hidden page plays without a gesture (voice.ts sets the autoplay policy); a refusal is tried again on resume, and
  // with the next chunk while the context runs (it never needs resuming then, and the element would stay silent).
  let refused = false;
  const play = () => out.play().then(() => { refused = false; }, () => { refused = true; });
  void play();
  return {
    get currentTime() { return ctx.currentTime; },
    get state() { return ctx.state; },
    resume: async () => { await ctx.resume(); await play(); },
    createBuffer: (channels, length, rate) => ctx.createBuffer(channels, length, rate),
    createBufferSource: () => {
      if (refused && ctx.state === "running") void play();
      return ctx.createBufferSource();
    },
    ...(ctx.createGain ? { createGain: () => ctx.createGain!() } : {}),
    destination: dest,
  };
}

/**
 * How far Ember's voice drops while speech is heard over it (12 dB…), and how fast (s): at once, so the user hears they
 * were heard. It is also what lets their words through: over Ember at full volume the echo canceller suppressed them
 * (measured on a laptop: "Wait, tell me about the weather instead." came through as "Other in step.", 3.5 s late).
 */
const DUCK_LEVEL = 0.15;
const DUCK_SECONDS = 0.02;

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
  /** Ember's voice goes through this (made with the context), and is ducked now. */
  private volume: PlayerGain | null = null;
  private ducked = false;

  /**
   * `scheduled`: told of each chunk as it is scheduled (when it starts on the audio clock, and its samples), so the
   * page can show Ember's voice level as it plays (app/shared/level.ts).
   */
  constructor(private make: () => PlayerAudio, private speaking: (on: boolean) => void, private scheduled?: (at: number, samples: Float32Array, rate: number) => void) {}

  /** Schedules a chunk of reply `id`; returns how long it plays (s), or 0 when it was dropped (its reply was hushed). */
  chunk(id: number, samples: Float32Array, rate: number): number {
    if (id <= this.hushed || !samples.length) return 0;
    this.open.add(id);
    const ctx = (this.ctx ??= this.make());
    if (!this.volume && ctx.createGain) { this.volume = ctx.createGain(); this.volume.connect(ctx.destination); }
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    const buffer = ctx.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.volume ?? ctx.destination);
    const at = Math.max(ctx.currentTime + LEAD_S, this.nextAt);
    src.onended = () => { this.playing.delete(src); this.settle(); };
    src.start(at);
    this.nextAt = at + buffer.duration;
    this.playing.add(src);
    this.scheduled?.(at, samples, rate);
    this.tell(true);
    return buffer.duration;
  }

  /** Reply `id` has no more chunks. */
  done(id: number): void {
    this.open.delete(id);
    this.settle();
  }

  /** Speech was heard over Ember, so its voice drops; or that passed, and it comes back. */
  duck(on: boolean): void {
    if (on === this.ducked) return;
    this.ducked = on;
    if (this.volume && this.ctx) this.volume.gain.setTargetAtTime(on ? DUCK_LEVEL : 1, this.ctx.currentTime, DUCK_SECONDS);
  }

  /** Stops at once; chunks of replies up to `upTo` that are still on their way are dropped. */
  stop(upTo = Number.MAX_SAFE_INTEGER): void {
    this.hushed = Math.max(this.hushed, Math.min(upTo, Math.max(0, ...this.open)));
    this.open.clear();
    for (const src of this.playing) { src.onended = null; try { src.stop(); } catch { /* not started yet */ } }
    this.playing.clear();
    this.nextAt = 0;
    this.duck(false);
    this.tell(false);
  }

  /** The audio clock now (s), or null before anything has played. */
  get time(): number | null {
    return this.ctx ? this.ctx.currentTime : null;
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
