/**
 * The real recognizers: sherpa-onnx compiled to WebAssembly (runs on RHEL 8's
 * glibc 2.28; the native addon needs 2.32). Keyword spotting with a 3.3M
 * zipformer, Silero VAD, and Moonshine tiny for transcription.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { SAMPLE_RATE, type VoiceBackend } from "./engine";

export interface ModelPaths {
  kws: string;
  vad: string;
  asr: string;
}

/** BPE pieces for the keyword model (tokenized with its bpe.model), with boost and threshold. */
export const KEYWORDS = [
  "▁HE Y ▁E M BER :2.0 #0.20 @hey_ember",
  "▁O K ▁E M BER :2.0 #0.20 @hey_ember",
  "▁E M BER ▁ST O P :2.0 #0.15 @ember_stop",
].join("\n");

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
  const monStream = opts.monitor ? kws.createStream() : null;
  const vad = sherpa.createVad({
    sileroVad: { model: models.vad, threshold: 0.5, minSilenceDuration: 0.6, minSpeechDuration: 0.2, maxSpeechDuration: 15, windowSize: 512 },
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
  // VAD consumes fixed 512-sample windows.
  let pending = new Float32Array(0);
  const drain = (): Float32Array[] => {
    const out: Float32Array[] = [];
    while (!vad.isEmpty()) { out.push(Float32Array.from(vad.front().samples)); vad.pop(); }
    return out;
  };

  return {
    spot: frame => spotIn(micStream, frame),
    resetSpot() {
      micStream.free();
      micStream = kws.createStream();
      // The spotter misfires without some leading silence for context: prime it with half a second.
      spotIn(micStream, new Float32Array(SAMPLE_RATE / 2));
    },
    ...(monStream ? { spotMonitor: (frame: Float32Array) => spotIn(monStream, frame) } : {}),
    vad(frame) {
      const joined = new Float32Array(pending.length + frame.length);
      joined.set(pending);
      joined.set(frame, pending.length);
      let i = 0;
      for (; i + 512 <= joined.length; i += 512) vad.acceptWaveform(joined.subarray(i, i + 512));
      pending = joined.slice(i);
      return drain();
    },
    speaking: () => vad.isDetected(),
    flushVad() {
      vad.flush();
      return drain();
    },
    resetVad() {
      vad.reset();
      pending = new Float32Array(0);
    },
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
      micStream.free(); monStream?.free(); kws.free(); vad.free(); asr.free();
    },
  };
}
