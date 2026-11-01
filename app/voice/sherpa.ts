/**
 * The real recognizers: sherpa-onnx compiled to WebAssembly (runs on RHEL 8's
 * glibc 2.28; the native addon needs 2.32). Keyword spotting with a 3.3M
 * zipformer, Silero VAD, and Moonshine v2 tiny for transcription.
 * WebAssembly memory never shrinks, so every buffer here is bounded: a VAD
 * that hears speech for minutes (a TV, colleagues) would otherwise grow until
 * the process runs out of memory.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { MIN_TRANSCRIBE_SAMPLES, Ring, SAMPLE_RATE, type VoiceBackend } from "./engine";

export interface ModelPaths {
  kws: string;
  vad: string;
  asr: string;
  /** Ember's voice (app/voice/tts.ts); the recognizers don't use it. */
  tts: string;
  /** The voiceprint model (Voice Match, app/voice/voiceprint.ts). */
  speaker: string;
}

/**
 * BPE pieces for the keyword model (tokenized with its bpe.model), with boost and threshold. The wake word's
 * threshold is low: the transcript check takes back near-misses (measured on 153 renderings of the eval's wake
 * phrases, the spotter missed 8 at 0.15 and 3 at 0.08, with no false wakes in 150 near-miss phrases or 12 min of
 * talk, babble and music).
 * "Ember, stop" stays as it is: other spellings, boosts and thresholds didn't hear it better in the voices that
 * miss it (alan 14/30, ryan 8/30; amy 30/30); "Hey Ember, stop" and Ctrl+Alt+X are there for those.
 * The bare name ("Ember, open the terminal") is two syllables, heard inside "remember" and "September" too (the
 * engine's check takes those back before anything shows), and comes before "stop" in "Ember, stop" (the spotter takes
 * the name first, and the check hears the stop). Its threshold, measured on 36 renderings of four "Ember, …" requests
 * and 45 of five near-miss phrases: 0.2 spotted 30 and 16, 0.1 spotted 34 and 17.
 */
export const KEYWORDS = [
  "▁HE Y ▁E M BER :2.0 #0.08 @hey_ember",
  "▁O K ▁E M BER :2.0 #0.08 @hey_ember",
  "▁E M BER ▁ST O P :2.0 #0.15 @ember_stop",
  "▁E M BER :2.0 #0.1 @ember",
].join("\n");

/** Silence fed to the spotter when the speaker pauses, so it decides without waiting for more audio. */
const PAD_SAMPLES = Math.round(0.32 * SAMPLE_RATE);
/** The idle voice check's speech threshold (Silero's probability; 0.5 is its usual). */
const CHECK_THRESHOLD = 0.35;
/**
 * The listening VAD ends a segment after 0.6 s of silence; a segment gets 0.3 s of what followed it (Moonshine drops a
 * last word cut at its very end), and the 0.1 s before it is kept aside (a second try at a short one Moonshine heard
 * nothing in: see the engine's handleSegment).
 */
const MIN_SILENCE = 0.6;
const AFTER_SEGMENT = Math.round(0.3 * SAMPLE_RATE);
const BEFORE_SEGMENT = Math.round(0.1 * SAMPLE_RATE);
/**
 * Neither VAD's own maximum is a hard cap: the listening one is flushed after 25 s of speech (the engine ends requests
 * sooner: 20 s at most), the voice check starts afresh after 10 s. Past its maximum, Silero ends speech at the next
 * 0.1 s pause, so the listening one's is beyond the engine's (a long request isn't split mid-sentence).
 */
const VAD_MAX_SAMPLES = 25 * SAMPLE_RATE;
const VAD_MAX_SPEECH_SECONDS = 30;
const CHECK_MAX_SAMPLES = 10 * SAMPLE_RATE;

/**
 * Moonshine v2 in this WebAssembly build throws on audio past about 9 s (measured: 9 s of fast talk transcribed, 9.5 s
 * threw), so a longer request is transcribed in pieces of at most 7 s, each cut at its quietest tenth of a second
 * between 4 and 7 s in (a pause between words, wherever the speaker took one), and the pieces' words are joined.
 */
const PIECE_MAX = 7 * SAMPLE_RATE;
const PIECE_MIN = 4 * SAMPLE_RATE;
const CUT_WINDOW = SAMPLE_RATE / 10;
const CUT_STEP = SAMPLE_RATE / 100;

/** `samples` in pieces the recognizer can take (see PIECE_MAX); audio no longer than that is one piece. */
export function recognizerPieces(samples: Float32Array): Float32Array[] {
  const out: Float32Array[] = [];
  let from = 0;
  while (samples.length - from > PIECE_MAX) {
    let cut = from + PIECE_MAX, quietest = Infinity;
    for (let at = from + PIECE_MIN; at + CUT_WINDOW <= from + PIECE_MAX; at += CUT_STEP) {
      let e = 0;
      for (let i = at; i < at + CUT_WINDOW; i++) e += samples[i] * samples[i];
      if (e < quietest) { quietest = e; cut = at + CUT_WINDOW / 2; }
    }
    out.push(samples.subarray(from, cut));
    from = cut;
  }
  out.push(samples.subarray(from));
  return out;
}

/**
 * The recognizer's words with a looping repeat taken out: on a short clip Moonshine v2 can repeat what it heard until
 * its token limit ("pay embers pay embers pay embers pay em"), or say a whole sentence twice. A word said three times or
 * more in a row, or a phrase of two words or more said twice or more, is kept once, along with a cut-off repeat at the
 * very end. A word said twice ("very, very") stays.
 */
export function withoutRepeats(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, "");
  const same = (a: number, b: number, k: number) => { for (let j = 0; j < k; j++) if (norm(words[a + j]) !== norm(words[b + j])) return false; return true; };
  for (let k = 1; k <= words.length / 2; k++) {
    for (let i = 0; i + 2 * k <= words.length; i++) {
      if (!norm(words[i])) continue;
      let n = 1;
      while (i + (n + 1) * k <= words.length && same(i, i + n * k, k)) n++;
      if (n < (k === 1 ? 3 : 2)) continue;
      let end = i + n * k, j = 0;
      while (end + j < words.length && j < k && norm(words[i + j]).startsWith(norm(words[end + j])) && (norm(words[end + j]) === norm(words[i + j]) || end + j === words.length - 1)) j++;
      if (end + j === words.length) end += j;
      words.splice(i + k, end - (i + k));
    }
  }
  return words.join(" ");
}

/**
 * A speech model couldn't be loaded: one of its files is missing (an antivirus quarantined it), cut short or damaged.
 * Downloading the models again repairs it (review #254).
 */
export class ModelLoadError extends Error {}

/**
 * `monitor`: also spot the speakers' stream. `onError`: the recognizer failed on some audio (WebAssembly throws bare
 * numbers): that audio is heard as nothing, and the voice process carries on (review #253). Throws ModelLoadError when
 * a model can't be loaded.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- sherpa-onnx ships untyped JS */
export function sherpaBackend(models: ModelPaths, opts: { monitor?: boolean; onError?: (err: unknown) => void; keywords?: string } = {}): VoiceBackend & { free(): void } {
  const requireCjs = createRequire(__filename);
  const sherpa = requireCjs("sherpa-onnx") as any;
  // A damaged file throws a bare number out of WebAssembly; a missing one only gives an empty handle (and a recognizer
  // that hears nothing, ever).
  const load = (what: string, make: () => any): any => {
    let made: any;
    try {
      made = make();
    } catch (err) {
      throw new ModelLoadError(`The ${what} couldn't be loaded.`, { cause: err });
    }
    if (!made?.handle) throw new ModelLoadError(`The ${what} couldn't be loaded.`);
    return made;
  };
  const k = (f: string) => path.join(models.kws, f);
  const kwsConfig = {
    featConfig: { samplingRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: k("encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
        decoder: k("decoder-epoch-12-avg-2-chunk-16-left-64.onnx"),
        joiner: k("joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
      },
      tokens: k("tokens.txt"), numThreads: 1, provider: "cpu", debug: 0,
    },
    maxActivePaths: 4, numTrailingBlanks: 1, keywordsScore: 1.0, keywordsThreshold: 0.25, keywords: opts.keywords ?? KEYWORDS,
  };
  const kws = load("wake word model", () => sherpa.createKws(kwsConfig));
  let micStream = kws.createStream();
  let monStream: any = null;
  const vad = load("voice activity model", () => sherpa.createVad({
    sileroVad: { model: models.vad, threshold: 0.5, minSilenceDuration: MIN_SILENCE, minSpeechDuration: 0.2, maxSpeechDuration: VAD_MAX_SPEECH_SECONDS, windowSize: 512 },
    sampleRate: SAMPLE_RATE, numThreads: 1, provider: "cpu", debug: 0, bufferSizeInSeconds: 30,
  }));
  // The voice check for the idle spotter: a second Silero, eager (low threshold, a 64 ms onset), with its own state.
  // Its segments aren't needed: they're dropped as they come.
  const check = load("voice activity model", () => sherpa.createVad({
    sileroVad: { model: models.vad, threshold: CHECK_THRESHOLD, minSilenceDuration: 0.25, minSpeechDuration: 0.064, maxSpeechDuration: 30, windowSize: 512 },
    sampleRate: SAMPLE_RATE, numThreads: 1, provider: "cpu", debug: 0, bufferSizeInSeconds: 30,
  }));
  const a = (f: string) => path.join(models.asr, f);
  const asr = load("speech recognition model", () => sherpa.createOfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      moonshine: { encoder: a("encoder_model.ort"), mergedDecoder: a("decoder_model_merged.ort") },
      tokens: a("tokens.txt"), numThreads: 1, provider: "cpu", debug: 0,
    },
    decodingMethod: "greedy_search",
  }));

  const spotIn = (stream: any, frame: Float32Array): string[] => {
    stream.acceptWaveform(SAMPLE_RATE, frame);
    const hits: string[] = [];
    while (kws.isReady(stream)) {
      kws.decode(stream);
      const r = kws.getResult(stream);
      if (r.keyword) { hits.push(r.keyword); kws.reset(stream); }
    }
    return hits;
  };
  /** A new spotter stream: it misfires without some leading silence for context, so it's primed with half a second. */
  const freshStream = (): any => {
    const s = kws.createStream();
    spotIn(s, new Float32Array(SAMPLE_RATE / 2));
    return s;
  };
  // VAD consumes fixed 512-sample windows.
  const windows = (vadLike: { acceptWaveform(s: Float32Array): void }, rest: Float32Array, frame: Float32Array): Float32Array<ArrayBuffer> => {
    const joined = new Float32Array(rest.length + frame.length);
    joined.set(rest);
    joined.set(frame, rest.length);
    let i = 0;
    for (; i + 512 <= joined.length; i += 512) vadLike.acceptWaveform(joined.subarray(i, i + 512));
    return joined.slice(i);
  };
  // The speakers' stream is digital silence between sounds, where the spotter (trained on recordings) misses
  // phrases: a whisper of noise (-80 dB) is added (measured on videos' "Hey Ember": spotted 35 of 48 → 44).
  let seed = 1;
  const dither = (frame: Float32Array): Float32Array => {
    const out = new Float32Array(frame.length);
    for (let i = 0; i < frame.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; out[i] = frame[i] + (seed / 0x7fffffff - 0.5) * 3.5e-4; }
    return out;
  };
  let pending: Float32Array = new Float32Array(0);
  let checkPending: Float32Array = new Float32Array(0);
  /**
   * What the listening VAD was fed lately (for the audio around a segment), how much since its reset, and how long it
   * has heard speech; and what it heard before each segment it gave (while the segment is still about).
   */
  const recent = new Ring(2);
  const before = new WeakMap<Float32Array, Float32Array>();
  let fed = 0, speechFrom = -1, checkSpeech = 0;
  const drain = (): Float32Array[] => {
    if (vad.isEmpty()) return [];
    const out: Float32Array[] = [];
    const heard = recent.read();
    while (!vad.isEmpty()) {
      const { samples, start } = vad.front() as { samples: Float32Array; start: number };
      vad.pop();
      // A segment that ended in silence gets the 0.3 s that followed it (already heard): Moonshine keeps its last word then.
      const since = fed - (start + samples.length);
      const after = since > 0 && since <= heard.length ? heard.subarray(heard.length - since, heard.length - since + AFTER_SEGMENT) : new Float32Array(0);
      const seg = new Float32Array(samples.length + after.length);
      seg.set(samples);
      seg.set(after, samples.length);
      const ago = fed - start;
      if (ago < heard.length) before.set(seg, heard.slice(Math.max(0, heard.length - ago - BEFORE_SEGMENT), heard.length - ago));
      out.push(seg);
    }
    return out;
  };

  const reset = () => {
    vad.reset();
    pending = new Float32Array(0);
    recent.clear();
    fed = 0;
    speechFrom = -1;
  };
  // Flushed mid-speech, Silero would carry on as if speaking, and its next end of speech comes out garbled (a
  // negative length): it starts afresh instead (the next words are heard as they begin).
  const flush = (): Float32Array[] => {
    vad.flush();
    const out = drain();
    reset();
    return out;
  };

  return {
    spot: frame => spotIn(micStream, frame),
    resetSpot() {
      micStream.free();
      micStream = freshStream();
    },
    // 0.32 s of silence completes the chunk the last words are in (the stream just hears a longer pause).
    padSpot: () => spotIn(micStream, new Float32Array(PAD_SAMPLES)),
    ...(opts.monitor ? {
      spotMonitor: (frame: Float32Array) => { monStream ??= freshStream(); return spotIn(monStream, dither(frame)); },
      padMonitor: () => (monStream ? spotIn(monStream, dither(new Float32Array(PAD_SAMPLES))) : []),
      resetMonitor() { monStream?.free(); monStream = null; },
    } : {}),
    hearsSpeech(frame) {
      checkPending = windows(check, checkPending, frame);
      if (!check.isEmpty()) check.clear();
      const on = check.isDetected();
      // Its buffer keeps all the speech it hears: in continuous talk it starts afresh every 10 s (it hears the next word at once).
      checkSpeech = on ? checkSpeech + frame.length : 0;
      if (checkSpeech > CHECK_MAX_SAMPLES) { check.reset(); checkPending = new Float32Array(0); checkSpeech = 0; }
      return on;
    },
    resetHearsSpeech() {
      check.reset();
      checkPending = new Float32Array(0);
      checkSpeech = 0;
    },
    vad(frame) {
      pending = windows(vad, pending, frame);
      recent.push(frame);
      fed += frame.length;
      const out = drain();
      if (!vad.isDetected()) speechFrom = -1;
      else if (speechFrom < 0) speechFrom = fed;
      else if (fed - speechFrom > VAD_MAX_SAMPLES) out.push(...flush());
      return out;
    },
    speaking: () => vad.isDetected(),
    flushVad: () => flush(),
    resetVad: () => reset(),
    transcribe(samples) {
      if (samples.length < MIN_TRANSCRIBE_SAMPLES) return "";
      const words: string[] = [];
      for (const piece of recognizerPieces(samples)) {
        if (piece.length < MIN_TRANSCRIBE_SAMPLES) continue;
        let s: any = null;
        try {
          s = asr.createStream();
          s.acceptWaveform(SAMPLE_RATE, piece);
          asr.decode(s);
          const text = withoutRepeats(String(asr.getResult(s).text ?? "").trim());
          if (text) words.push(text);
        } catch (err) {
          opts.onError?.(err);
          return "";
        } finally {
          s?.free();
        }
      }
      return words.join(" ");
    },
    before: seg => before.get(seg) ?? null,
    free() {
      micStream.free(); monStream?.free(); kws.free(); vad.free(); check.free(); asr.free();
    },
  };
}
