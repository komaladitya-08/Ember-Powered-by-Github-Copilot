/**
 * Voice Match in the voice process (see voiceprint.ts): VoiceGate holds each request the engine heard until its
 * voiceprint has been compared with the owner's, then lets it through or turns it away; Enrolment takes the owner's
 * phrases and makes their voiceprint. The model is behind Printer, so both are tested without it.
 */

import type { VoiceEvent } from "./engine";
import { ENROL_MIN_SECONDS, ENROL_PHRASES, VOICE_MATCH_THRESHOLD, averagePrint, consistentPrints, similarity } from "./voiceprint";

/** Makes a voiceprint (unit length) of 16 kHz audio. */
export interface Printer {
  print(samples: Float32Array): Promise<Float32Array>;
}

/** What enrolment tells main: `got` of `of` phrases kept; `again`: the last one wasn't kept (`why`). */
export type EnrolState =
  | { state: "listening" | "heard"; got: number; of: number }
  | { state: "again"; got: number; of: number; why: "short" | "unlike" | "failed" }
  | { state: "done"; got: number; of: number; print: Float32Array }
  | { state: "cancelled"; got: number; of: number };

export class VoiceGate {
  private owner: Float32Array | null = null;
  /** Requests waiting for their check finish in order (a later one never overtakes an earlier). */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private printer: () => Printer,
    private send: (e: VoiceEvent) => void,
    private onError: (err: unknown) => void,
    private threshold = VOICE_MATCH_THRESHOLD,
  ) {}

  /** The owner's voiceprint (null: Voice Match off, every voice is heard). */
  setOwner(print: Float32Array | null): void {
    this.owner = print;
  }

  get on(): boolean {
    return !!this.owner;
  }

  /**
   * An event from the engine. A request ("utterance") is checked when Voice Match is on and its audio is known; a
   * stop never is (anyone may stop Ember), nor is anything else. A request turned away is followed by the end of its
   * window as main knows it for a wake taken back ("rejected"), so the bubble goes back to what it showed.
   */
  event(e: VoiceEvent, audio: Float32Array | null): void {
    const owner = this.owner;
    if (e.type !== "utterance" || !owner || !audio?.length) { this.send(e); return; }
    const check = this.printer().print(audio);
    this.queue = this.queue.then(async () => {
      let score: number;
      try {
        score = similarity(await check, owner);
      } catch (err) {
        // The model failed: the request is heard (Voice Match failing must not leave Ember deaf), and main is told.
        this.onError(err);
        this.send(e);
        return;
      }
      if (score >= this.threshold) { this.send(e); return; }
      this.send({ type: "rejected", keyword: "", reason: "voice", score: Math.round(score * 1000) / 1000 });
      this.send({ type: "listening", on: false, reason: "rejected", window: e.window });
    });
  }
}

/** Enrolment: the owner says `of` phrases (any speech the VAD hands over counts as one); their voiceprint comes at the end. */
export class Enrolment {
  private prints: Float32Array[] = [];
  private tries = 0;
  private finished = false;
  /** Gives up after this many phrases heard (some kept, some said again). */
  private readonly maxTries: number;

  constructor(private printer: Printer, private tell: (s: EnrolState) => void, readonly of = ENROL_PHRASES.length) {
    this.maxTries = of * 3;
    tell({ state: "listening", got: 0, of });
  }

  /** A phrase the VAD heard. */
  async heard(samples: Float32Array): Promise<void> {
    if (this.finished) return;
    if (samples.length < ENROL_MIN_SECONDS * 16_000) { this.again("short"); return; }
    this.tries++;
    let print: Float32Array;
    try {
      print = await this.printer.print(samples);
    } catch {
      this.again("failed");
      return;
    }
    if (this.finished) return;
    this.prints.push(print);
    const { keep, dropped } = consistentPrints(this.prints);
    this.prints = keep.map(i => this.prints[i]);
    if (dropped !== null) { this.again("unlike"); return; }
    if (this.prints.length >= this.of) {
      this.finished = true;
      this.tell({ state: "done", got: this.prints.length, of: this.of, print: averagePrint(this.prints) });
      return;
    }
    this.tell({ state: "heard", got: this.prints.length, of: this.of });
  }

  cancel(): void {
    if (this.finished) return;
    this.finished = true;
    this.tell({ state: "cancelled", got: this.prints.length, of: this.of });
  }

  get done(): boolean {
    return this.finished;
  }

  private again(why: "short" | "unlike" | "failed"): void {
    if (this.tries >= this.maxTries) { this.cancel(); return; }
    this.tell({ state: "again", got: this.prints.length, of: this.of, why });
  }
}
