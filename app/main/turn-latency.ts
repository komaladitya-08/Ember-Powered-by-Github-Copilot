/**
 * How long a spoken request takes to be answered aloud, step by step (docs/ASSISTANT.md phase 0): from the moment its
 * transcript arrives to the request being sent to Copilot, the answer's first words streaming in, the first chunk handed
 * to the voice and the first sound played. Main logs one `voice.latency` line per spoken turn, with times only (never
 * words: CLAUDE.md privacy), so every change to the voice path is measured the same way. Plain Node and pure: main
 * passes the clock and the log.
 */

/** One spoken turn's timings, in ms from when its transcript arrived (absent: that step didn't happen). */
export interface TurnTimes {
  /** Transcribing the request (the engine's own figure). */
  asrMs: number;
  sentMs?: number;
  firstTokenMs?: number;
  firstChunkMs?: number;
  firstAudioMs?: number;
}

type Step = "sent" | "firstToken" | "firstChunk" | "firstAudio";

/** A turn's steps not seen within this long are given up on, and the turn is logged as it stands. */
export const TURN_GIVE_UP_MS = 60_000;

export class TurnLatency {
  private turn: { at: number; asrMs: number; marks: Partial<Record<Step, number>> } | null = null;

  constructor(private o: { now?: () => number; log: (times: TurnTimes) => void }) {}

  private now(): number { return (this.o.now ?? Date.now)(); }

  /** A spoken request's transcript arrived (`asrMs`: what transcribing it took). Ends a turn still open. */
  heard(asrMs: number): void {
    this.end();
    this.turn = { at: this.now(), asrMs: Math.max(0, Math.round(asrMs)), marks: {} };
  }

  /** A step of the open turn happened (only its first time counts). The first sound ends the turn. */
  mark(step: Step): void {
    const t = this.turn;
    if (!t) return;
    if (this.now() - t.at > TURN_GIVE_UP_MS) { this.end(); return; }
    t.marks[step] ??= this.now() - t.at;
    if (step === "firstAudio") this.end();
  }

  /** Logs the open turn as it stands (a reply that was only shown, a stop, a new request). */
  end(): void {
    const t = this.turn;
    this.turn = null;
    if (!t) return;
    const m = t.marks;
    this.o.log({
      asrMs: t.asrMs,
      ...(m.sent !== undefined ? { sentMs: m.sent } : {}),
      ...(m.firstToken !== undefined ? { firstTokenMs: m.firstToken } : {}),
      ...(m.firstChunk !== undefined ? { firstChunkMs: m.firstChunk } : {}),
      ...(m.firstAudio !== undefined ? { firstAudioMs: m.firstAudio } : {}),
    });
  }
}
