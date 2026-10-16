/**
 * The real recognizers: sherpa-onnx compiled to WebAssembly (runs on RHEL 8's
 * glibc 2.28; the native addon needs 2.32). Keyword spotting with a 3.3M
 * zipformer, Silero VAD, and Moonshine tiny for transcription.
 * WebAssembly memory never shrinks, so every buffer here is bounded: a VAD
 * that hears speech for minutes (a TV, colleagues) would otherwise grow until
 * the process runs out of memory.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { Ring, SAMPLE_RATE, type VoiceBackend } from "./engine";

export interface ModelPaths {
  kws: string;
  vad: string;
  asr: string;
}

/**
 * BPE pieces for the keyword model (tokenized with its bpe.model), with boost and threshold. The wake word's
 * threshold is low: the transcript check takes back near-misses (measured on 153 renderings of the eval's wake
 * phrases, the spotter missed 8 at 0.15 and 3 at 0.08, with no false wakes in 150 near-miss phrases or 12 min of
 * talk, babble and music).
 * "Ember, stop" stays as it is: other spellings, boosts and thresholds didn't hear it better in the voices that
 * miss it (alan 14/30, ryan 8/30; amy 30/30); "Hey Ember, stop" and Ctrl+Alt+X are there for those.
 */
export const KEYWORDS = [
  "▁HE Y ▁E M BER :2.0 #0.08 @hey_ember",
  "▁O K ▁E M BER :2.0 #0.08 @hey_ember",
  "▁E M BER ▁ST O P :2.0 #0.15 @ember_stop",
].join("\n");

/** Silence fed to the spotter when the speaker pauses, so it decides without waiting for more audio. */
const PAD_SAMPLES = Math.round(0.32 * SAMPLE_RATE);
/** The idle voice check's speech threshold (Silero's probability; 0.5 is its usual). */
const CHECK_THRESHOLD = 0.35;
/** The listening VAD ends a segment after 0.6 s of silence; a segment gets 0.3 s of what followed it (Moonshine drops a last word cut at its very end). */
const MIN_SILENCE = 0.6;
const AFTER_SEGMENT = Math.round(0.3 * SAMPLE_RATE);
/** Neither VAD's own maximum is a hard cap: the listening one is flushed after 20 s of speech (the engine ends requests sooner), the voice check starts afresh after 10 s. */
const VAD_MAX_SAMPLES = 20 * SAMPLE_RATE;
const CHECK_MAX_SAMPLES = 10 * SAMPLE_RATE;

/* eslint-disable @typescript-eslint/no-explicit-any -- sherpa-onnx ships untyped JS */
export function sherpaBackend(models: ModelPaths, opts: { monitor?: boolean } = {}): VoiceBackend & { free(): void } {
  const requireCjs = createRequire(__filename);
  const sherpa = requireCjs("sherpa-onnx") as any;
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
    maxActivePaths: 4, numTrailingBlanks: 1, keywordsScore: 1.0, keywordsThreshold: 0.25, keywords: KEYWORDS,
  };
  const kws = sherpa.createKws(kwsConfig);
  let micStream = kws.createStream();
  let monStream: any = null;
  const vad = sherpa.createVad({
    sileroVad: { model: models.vad, threshold: 0.5, minSilenceDuration: MIN_SILENCE, minSpeechDuration: 0.2, maxSpeechDuration: 15, windowSize: 512 },
    sampleRate: SAMPLE_RATE, numThreads: 1, provider: "cpu", debug: 0, bufferSizeInSeconds: 30,
  });
  // The voice check for the idle spotter: a second Silero, eager (low threshold, a 64 ms onset), with its own state.
  // Its segments aren't needed: they're dropped as they come.
  const check = sherpa.createVad({
    sileroVad: { model: models.vad, threshold: CHECK_THRESHOLD, minSilenceDuration: 0.25, minSpeechDuration: 0.064, maxSpeechDuration: 30, windowSize: 512 },
    sampleRate: SAMPLE_RATE, numThreads: 1, provider: "cpu", debug: 0, bufferSizeInSeconds: 30,
  });
  const a = (f: string) => path.join(models.asr, f);
  const asr = sherpa.createOfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      moonshine: { preprocessor: a("preprocess.onnx"), encoder: a("encode.int8.onnx"), uncachedDecoder: a("uncached_decode.int8.onnx"), cachedDecoder: a("cached_decode.int8.onnx") },
      tokens: a("tokens.txt"), numThreads: 1, provider: "cpu", debug: 0,
    },
    decodingMethod: "greedy_search",
  });

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
  /** What the listening VAD was fed lately (for the audio that followed a segment), how much since its reset, and how long it has heard speech. */
  const recent = new Ring(1);
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
      const s = asr.createStream();
      try {
        s.acceptWaveform(SAMPLE_RATE, samples);
        asr.decode(s);
        return String(asr.getResult(s).text ?? "").trim();
      } finally {
        s.free();
      }
    },
    free() {
      micStream.free(); monStream?.free(); kws.free(); vad.free(); check.free(); asr.free();
    },
  };
}
