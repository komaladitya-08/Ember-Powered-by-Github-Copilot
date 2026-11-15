/**
 * The speakers' own stream as a room hears it. The stream is digital and carries what no speaker plays: a web page's
 * audio with a loud low hum under its own "Ember, allow it." reached the room, and the microphone, as the words alone,
 * while in the stream the hum was 32 dB over them, and neither the stream's keyword spotter nor the recognizer could
 * read them there: the yes by name was the user's, 6 of 48 times on the real models (voice-safety-x9-2). So the engine
 * also compares the microphone's loudness with the stream's (engine.ts followsSpeakers) in LEVEL_BAND only, 1 kHz and
 * up, which every speaker plays, a laptop's and a phone's too, and which carries a voice's syllables: there the stream
 * holds nothing the room didn't hear. A sound loud enough there to bury the words is heard in the room too, and buries
 * them for the microphone's own recognizer as well.
 *
 * A 4th-order Butterworth high-pass (two biquads, RBJ's cookbook) run twice, whose state runs on from frame to frame. At
 * 16 kHz it takes 300 Hz down about 85 dB, 500 Hz 49 dB and 700 Hz 26 dB, 1 kHz 6 dB, and leaves 2 kHz and up within 0.1 dB.
 */

/** A band's lower edge (Hz, 3 dB down per filter), and how many times its filter runs. */
export interface Band { low: number; times?: number }
export const LEVEL_BAND: Band = { low: 1000, times: 2 };
const SAMPLE_RATE = 16_000;
/** The two sections' Q of a 4th-order Butterworth filter. */
const BUTTERWORTH_Q = [0.541_196_1, 1.306_563] as const;

/** One biquad section, normalized: b0, b1, b2, a1, a2. */
type Section = readonly [number, number, number, number, number];

function highPass(hz: number): Section[] {
  return BUTTERWORTH_Q.map(q => {
    const w = (2 * Math.PI * hz) / SAMPLE_RATE, c = Math.cos(w), alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha;
    const b0 = (1 + c) / 2;
    return [b0 / a0, -(1 + c) / a0, b0 / a0, (-2 * c) / a0, (1 - alpha) / a0] as const;
  });
}

/** Band-limits one stream of 16 kHz frames (see the module comment): one per stream, as it keeps the filters' state. */
export class BandFilter {
  private filters: Section[] = [];
  /** Each section's last two inputs and outputs. */
  private state: number[][];
  private work = new Float64Array(0);

  constructor(band: Band) {
    for (let i = 0; i < (band.times ?? 1); i++) this.filters.push(...highPass(band.low));
    this.state = this.filters.map(() => [0, 0, 0, 0]);
  }

  /** The energy (mean square) of the stream's next frame within the band. */
  energy(frame: Float32Array): number {
    if (this.work.length !== frame.length) this.work = new Float64Array(frame.length);
    const out = this.work;
    out.set(frame);
    this.filters.forEach(([b0, b1, b2, a1, a2], k) => {
      let [x1, x2, y1, y2] = this.state[k];
      for (let i = 0; i < out.length; i++) {
        const x = out[i], y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        out[i] = y;
      }
      // (A stream that sent something that isn't a number starts afresh rather than stay broken for good.)
      this.state[k] = [x1, x2, y1, y2].every(Number.isFinite) ? [x1, x2, y1, y2] : [0, 0, 0, 0];
    });
    let sum = 0;
    for (let i = 0; i < out.length; i++) sum += out[i] * out[i];
    return sum / Math.max(1, out.length);
  }
}
