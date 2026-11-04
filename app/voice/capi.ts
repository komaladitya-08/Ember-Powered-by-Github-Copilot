/**
 * sherpa-onnx's C API through koffi (docs/ASSISTANT.md phase 1.1): native speech on Linux without a Node addon. The
 * release's prebuilt libsherpa-onnx-c-api.so and libonnxruntime.so need only GLIBC_2.17, GLIBCXX_3.4.19 and
 * CXXABI_1.3.7, inside RHEL 8's limits (check-symvers.sh), where the Node addon needs glibc 2.32. They load from one
 * folder (the C API's RPATH is $ORIGIN) given by scripts/voice/fetch-capi.mjs in development.
 *
 * It implements the same Sherpa interface as the addon and WebAssembly builds (runtime.ts), so the recognizers and the
 * voice don't change. The struct layouts are generated from the release's own header (capi-structs.ts). koffi loads
 * lazily, inside capiSherpa(), so importing this module loads nothing; nothing here calls koffi.view(), and audio coming
 * back from the library is copied (koffi.decode) before its memory is freed.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { CAPI_STRUCTS, CAPI_VERSION } from "./capi-structs";
import type { KwsStream, OfflineStream, Sherpa } from "./runtime";

const SAMPLE_RATE = 16_000;

/** The library files, in the order they load. */
export const CAPI_LIBS = ["libonnxruntime.so", "libsherpa-onnx-c-api.so"] as const;

/** Whether `dir` holds the C API's libraries. */
export const hasCapi = (dir: string): boolean => CAPI_LIBS.every(f => fs.existsSync(path.join(dir, f)));

/**
 * The processor features (/proc/cpuinfo's flag names) the libraries need beyond x86-64's baseline; a processor without
 * one runs speech on WebAssembly (runtime.ts capiChoice). None for 1.13.8, measured by disassembling both (objdump -d):
 * libsherpa-onnx-c-api.so has no AVX-encoded instruction, and every AVX, AVX2 and AVX-512 instruction in
 * libonnxruntime.so is in MLAS's kernels, which onnxruntime picks at run time from CPUID; the rest is SSE2 (its tzcnt
 * runs as bsf on a processor without BMI1). A build that needs more lists it here.
 */
export const CAPI_CPU_NEEDS: readonly string[] = [];

/**
 * Which of `needs` the processor lacks, from /proc/cpuinfo's text (its "flags" lines). It fails closed: without the
 * text (null: unreadable) or a flags line in it, all of `needs` count as missing.
 */
export function cpuLacks(needs: readonly string[], cpuinfo: string | null): string[] {
  if (!needs.length) return [];
  const lines = cpuinfo?.split("\n").filter(l => /^flags\s*:/.test(l)) ?? [];
  if (!lines.length) return [...needs];
  // Every processor's line: a feature counts only if all of them have it (a task may run on any of them).
  const sets = lines.map(l => new Set(l.slice(l.indexOf(":") + 1).trim().split(/\s+/)));
  return needs.filter(n => !sets.every(s => s.has(n)));
}

/** koffi's error for a type defined twice ("Duplicate type name 'X'"): the struct was defined by an earlier capiSherpa(). */
export const isDuplicateType = (err: unknown): boolean => /^Duplicate type name\b/.test(String((err as Error)?.message ?? err));

/* eslint-disable @typescript-eslint/no-explicit-any -- koffi's functions are untyped */
type Fn = (...a: any[]) => any;

/** Each folder's bound library, so its libraries load and its functions bind once per process. */
const loaded = new Map<string, Sherpa>();

/**
 * The C API's sherpa-onnx in `dir` (throws if it can't be loaded). Bound once per folder and process: a later call
 * returns the same object. A load that throws isn't kept.
 */
export function capiSherpa(dir: string): Sherpa {
  const key = path.resolve(dir);
  let s = loaded.get(key);
  if (!s) { s = bindCapi(key); loaded.set(key, s); }
  return s;
}

function bindCapi(dir: string): Sherpa {
  const koffi = createRequire(__filename)("koffi") as typeof import("koffi");
  // onnxruntime first, from this folder, so the C API's own load finds it whatever the RPATH resolves to.
  koffi.load(path.join(dir, CAPI_LIBS[0]));
  const lib = koffi.load(path.join(dir, CAPI_LIBS[1]));
  for (const s of CAPI_STRUCTS) {
    // Defined once per process: a second capiSherpa() in the same process finds them.
    // Any other error (a layout koffi refuses) is real: it propagates, and speech runs on WebAssembly (runtime.ts).
    try { koffi.struct(s.name, Object.fromEntries(s.fields)); } catch (err) { if (!isDuplicateType(err)) throw err; }
  }
  const fn = (decl: string): Fn => lib.func(decl) as Fn;
  const freeJson = fn("void SherpaOnnxFreeKeywordResultJson(void *s)");
  const freeOfflineJson = fn("void SherpaOnnxDestroyOfflineStreamResultJson(void *s)");
  const jsonOf = (ptr: unknown, free: Fn): any => {
    if (!ptr) return {};
    try { return JSON.parse(koffi.decode(ptr, "char", -1) as string); } finally { free(ptr); }
  };
  const c = {
    version: fn("const char *SherpaOnnxGetVersionStr()"),
    gitSha1: fn("const char *SherpaOnnxGetGitSha1()"),
    createKws: fn("void *SherpaOnnxCreateKeywordSpotter(const SherpaOnnxKeywordSpotterConfig *config)"),
    destroyKws: fn("void SherpaOnnxDestroyKeywordSpotter(void *spotter)"),
    createKwsStream: fn("void *SherpaOnnxCreateKeywordStream(void *spotter)"),
    destroyOnlineStream: fn("void SherpaOnnxDestroyOnlineStream(void *stream)"),
    acceptOnline: fn("void SherpaOnnxOnlineStreamAcceptWaveform(void *stream, int32_t sample_rate, const float *samples, int32_t n)"),
    kwsReady: fn("int32_t SherpaOnnxIsKeywordStreamReady(void *spotter, void *stream)"),
    kwsDecode: fn("void SherpaOnnxDecodeKeywordStream(void *spotter, void *stream)"),
    kwsResultJson: fn("void *SherpaOnnxGetKeywordResultAsJson(void *spotter, void *stream)"),
    kwsReset: fn("void SherpaOnnxResetKeywordStream(void *spotter, void *stream)"),
    createVad: fn("void *SherpaOnnxCreateVoiceActivityDetector(const SherpaOnnxVadModelConfig *config, float buffer_size_in_seconds)"),
    destroyVad: fn("void SherpaOnnxDestroyVoiceActivityDetector(void *p)"),
    vadAccept: fn("void SherpaOnnxVoiceActivityDetectorAcceptWaveform(void *p, const float *samples, int32_t n)"),
    vadEmpty: fn("int32_t SherpaOnnxVoiceActivityDetectorEmpty(void *p)"),
    vadDetected: fn("int32_t SherpaOnnxVoiceActivityDetectorDetected(void *p)"),
    vadPop: fn("void SherpaOnnxVoiceActivityDetectorPop(void *p)"),
    vadClear: fn("void SherpaOnnxVoiceActivityDetectorClear(void *p)"),
    vadFront: fn("void *SherpaOnnxVoiceActivityDetectorFront(void *p)"),
    destroySegment: fn("void SherpaOnnxDestroySpeechSegment(void *p)"),
    vadReset: fn("void SherpaOnnxVoiceActivityDetectorReset(void *p)"),
    vadFlush: fn("void SherpaOnnxVoiceActivityDetectorFlush(void *p)"),
    createRecognizer: fn("void *SherpaOnnxCreateOfflineRecognizer(const SherpaOnnxOfflineRecognizerConfig *config)"),
    destroyRecognizer: fn("void SherpaOnnxDestroyOfflineRecognizer(void *recognizer)"),
    createOfflineStream: fn("void *SherpaOnnxCreateOfflineStream(void *recognizer)"),
    destroyOfflineStream: fn("void SherpaOnnxDestroyOfflineStream(void *stream)"),
    acceptOffline: fn("void SherpaOnnxAcceptWaveformOffline(void *stream, int32_t sample_rate, const float *samples, int32_t n)"),
    decodeOffline: fn("void SherpaOnnxDecodeOfflineStream(void *recognizer, void *stream)"),
    offlineResultJson: fn("void *SherpaOnnxGetOfflineStreamResultAsJson(void *stream)"),
    createTts: fn("void *SherpaOnnxCreateOfflineTts(const SherpaOnnxOfflineTtsConfig *config)"),
    destroyTts: fn("void SherpaOnnxDestroyOfflineTts(void *tts)"),
    ttsRate: fn("int32_t SherpaOnnxOfflineTtsSampleRate(void *tts)"),
    ttsSpeakers: fn("int32_t SherpaOnnxOfflineTtsNumSpeakers(void *tts)"),
    ttsGenerate: fn("void *SherpaOnnxOfflineTtsGenerate(void *tts, const char *text, int32_t sid, float speed)"),
    destroyAudio: fn("void SherpaOnnxDestroyOfflineTtsGeneratedAudio(void *p)"),
  };
  /** Samples the library owns, copied out (its memory is freed right after). */
  const floats = (ptr: unknown, n: number) => (n > 0 && ptr ? Float32Array.from(koffi.decode(ptr, "float", n) as number[]) : new Float32Array(0));
  const made = (what: string, h: unknown) => { if (!h) throw new Error(`the ${what} couldn't be made`); return h; };
  const onlineStream = (h: unknown): KwsStream & { h: unknown } => ({
    h, acceptWaveform: (rate, samples) => c.acceptOnline(h, rate, samples, samples.length), free: () => c.destroyOnlineStream(h),
  });
  const offlineStream = (h: unknown): OfflineStream & { h: unknown } => ({
    h, acceptWaveform: (rate, samples) => c.acceptOffline(h, rate, samples, samples.length), free: () => c.destroyOfflineStream(h),
  });
  const handle = (s: unknown) => (s as { h: unknown }).h;

  return {
    backend: "native",
    detail: `sherpa-onnx ${c.version() as string} (${c.gitSha1() as string}, C API through koffi, layouts from ${CAPI_VERSION})`,
    createKws(s, run) {
      const h = made("keyword spotter", c.createKws({
        feat_config: { sample_rate: SAMPLE_RATE, feature_dim: 80 },
        model_config: { transducer: { encoder: s.encoder, decoder: s.decoder, joiner: s.joiner }, tokens: s.tokens, num_threads: run.numThreads, provider: run.provider, debug: 0 },
        max_active_paths: s.maxActivePaths, num_trailing_blanks: s.numTrailingBlanks, keywords_score: s.keywordsScore, keywords_threshold: s.keywordsThreshold,
        keywords_buf: s.keywords, keywords_buf_size: Buffer.byteLength(s.keywords),
      }));
      return {
        createStream: () => onlineStream(made("keyword stream", c.createKwsStream(h))),
        isReady: st => c.kwsReady(h, handle(st)) === 1,
        decode: st => c.kwsDecode(h, handle(st)),
        getResult: st => jsonOf(c.kwsResultJson(h, handle(st)), freeJson),
        reset: st => c.kwsReset(h, handle(st)),
        free: () => c.destroyKws(h),
      };
    },
    createVad(s, run) {
      const h = made("voice activity detector", c.createVad({
        silero_vad: { model: s.model, threshold: s.threshold, min_silence_duration: s.minSilenceDuration, min_speech_duration: s.minSpeechDuration, window_size: s.windowSize, max_speech_duration: s.maxSpeechDuration },
        sample_rate: SAMPLE_RATE, num_threads: run.numThreads, provider: run.provider, debug: 0,
      }, s.bufferSizeInSeconds));
      return {
        acceptWaveform: x => c.vadAccept(h, x, x.length),
        isEmpty: () => c.vadEmpty(h) === 1,
        isDetected: () => c.vadDetected(h) === 1,
        front: () => {
          const seg = c.vadFront(h);
          if (!seg) return { samples: new Float32Array(0), start: 0 };
          try {
            const v = koffi.decode(seg, "SherpaOnnxSpeechSegment") as { start: number; samples: unknown; n: number };
            return { samples: floats(v.samples, v.n), start: v.start };
          } finally { c.destroySegment(seg); }
        },
        pop: () => c.vadPop(h),
        clear: () => c.vadClear(h),
        reset: () => c.vadReset(h),
        flush: () => c.vadFlush(h),
        free: () => c.destroyVad(h),
      };
    },
    createMoonshine(s, run) {
      const h = made("speech recognizer", c.createRecognizer({
        feat_config: { sample_rate: SAMPLE_RATE, feature_dim: 80 },
        model_config: { moonshine: { encoder: s.encoder, merged_decoder: s.mergedDecoder }, tokens: s.tokens, num_threads: run.numThreads, provider: run.provider, debug: 0 },
        decoding_method: "greedy_search",
      }));
      return {
        createStream: () => offlineStream(made("recognizer stream", c.createOfflineStream(h))),
        decode: st => c.decodeOffline(h, handle(st)),
        getResult: st => jsonOf(c.offlineResultJson(handle(st)), freeOfflineJson),
        free: () => c.destroyRecognizer(h),
      };
    },
    createTts(s, run, maxNumSentences) {
      const model = s.kind === "vits"
        ? { vits: { model: s.model, tokens: s.tokens, data_dir: s.dataDir, noise_scale: s.noiseScale, noise_scale_w: s.noiseScaleW, length_scale: s.lengthScale } }
        : s.kind === "kitten" ? { kitten: { model: s.model, voices: s.voices, tokens: s.tokens, data_dir: s.dataDir, length_scale: s.lengthScale } }
        : { kokoro: { model: s.model, voices: s.voices, tokens: s.tokens, data_dir: s.dataDir, lexicon: s.lexicon, lang: s.lang, length_scale: s.lengthScale } };
      const h = made("voice", c.createTts({ model: { ...model, num_threads: run.numThreads, provider: run.provider, debug: 0 }, max_num_sentences: maxNumSentences }));
      return {
        sampleRate: Number(c.ttsRate(h)), numSpeakers: Number(c.ttsSpeakers(h)),
        generate: o => {
          const a = c.ttsGenerate(h, o.text, o.sid, o.speed);
          if (!a) throw new Error("the voice made no audio");
          try {
            const v = koffi.decode(a, "SherpaOnnxGeneratedAudio") as { samples: unknown; n: number; sample_rate: number };
            return { samples: floats(v.samples, v.n), sampleRate: v.sample_rate };
          } finally { c.destroyAudio(a); }
        },
        free: () => c.destroyTts(h),
      };
    },
  };
}
