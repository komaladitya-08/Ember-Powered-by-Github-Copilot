/**
 * Is the computer playing other sound (a song, a video, a call)? Only while a conversation is open, and only where the
 * platform can say (Windows' system audio loopback): with the microphone open and no name needed, a song's words would
 * otherwise be taken for requests. It reads how loud the output is, nothing else: no audio is kept, sent or recognized,
 * and Chromium makes us ask for a screen's video to get it, which is stopped before anything of it is looked at.
 * The rule is pure (OutputBusy), so it is tested without a page.
 */

/** Output at or above this RMS is sound: Windows' loopback gives digital silence otherwise (measured -109 dB against -13 dB). */
const SOUND_RMS = 0.0005;
/** Sound counts as over after this long (ms): the gaps between a song's lines and a video's sentences aren't silence. */
const HOLD_MS = 2500;
const LOOK_MS = 200;
/**
 * Ember's voice stays in the output a moment after the page says it stopped. Counted as other sound, it turned the answer
 * on in the gap between two of Ember's sentences, where it then stood through the whole of the next (log of 2026-11-05
 * 03:33:01–03:33:24), and everything said over it was thrown away.
 */
const EMBER_TAIL_MS = 1000;

/** Follows the output's level; says when the answer to "is other sound playing?" changes. */
export class OutputBusy {
  private soundAt = Number.NEGATIVE_INFINITY;
  private emberAt = Number.NEGATIVE_INFINITY;
  private busy = false;

  constructor(private tell: (on: boolean) => void) {}

  /**
   * A look at the output: its RMS, and whether Ember's own voice is playing. Ember's voice isn't other sound, and over it
   * nothing can be told, so the answer stands until it ends.
   */
  look(rms: number, emberSpeaking: boolean, now: number): void {
    if (emberSpeaking) { this.soundAt = Number.NEGATIVE_INFINITY; this.emberAt = now; return; }
    if (now - this.emberAt < EMBER_TAIL_MS) return;
    if (rms >= SOUND_RMS) this.soundAt = now;
    this.set(now - this.soundAt < HOLD_MS);
  }

  /** The watch stopped: nothing is known of the output any more. */
  reset(): void {
    this.soundAt = Number.NEGATIVE_INFINITY;
    this.set(false);
  }

  private set(on: boolean): void {
    if (on === this.busy) return;
    this.busy = on;
    this.tell(on);
  }
}

/** Starts watching the output; the result stops it. A computer that refuses just goes without (nothing is "playing"). */
export async function watchOutput(busy: OutputBusy, emberSpeaking: () => boolean): Promise<() => void> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  for (const t of stream.getVideoTracks()) t.stop();
  const audio = stream.getAudioTracks();
  if (!audio.length) return () => undefined;
  const ctx = new AudioContext();
  const meter = ctx.createAnalyser();
  meter.fftSize = 2048;
  ctx.createMediaStreamSource(new MediaStream(audio)).connect(meter);
  if (ctx.state !== "running") await ctx.resume();
  const samples = new Float32Array(meter.fftSize);
  const timer = setInterval(() => {
    meter.getFloatTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    busy.look(Math.sqrt(sum / samples.length), emberSpeaking(), performance.now());
  }, LOOK_MS);
  return () => {
    clearInterval(timer);
    for (const t of audio) t.stop();
    void ctx.close().catch(() => undefined);
    busy.reset();
  };
}
