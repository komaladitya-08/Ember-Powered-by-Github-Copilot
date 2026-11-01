/**
 * Which build of sherpa-onnx runs Ember's speech, behind one small interface (Sherpa) the recognizers (sherpa.ts) and
 * Ember's voice (tts-process.ts) use:
 * - "native": sherpa-onnx's Node addon (the binaries sherpa-onnx-node 1.13.8 loads, from its per-platform packages
 *   sherpa-onnx-win-<arch> and sherpa-onnx-darwin-<arch>), on Windows and macOS only. It runs onnxruntime's own CPU
 *   build with several threads, and CoreML on macOS.
 * - "wasm": sherpa-onnx's WebAssembly build (sherpa-onnx 1.13.8), everywhere else, and wherever the addon doesn't load.
 *   It is single-threaded and has no GPU, but runs on RHEL 8's glibc 2.28 (the Linux addon needs 2.32, so it never
 *   ships for Linux: layout.mjs leaves the packages out and npm installs none there).
 * Ember depends on the platform packages themselves, not on sherpa-onnx-node's JavaScript, whose optional
 * dependencies would install the Linux addon too (check-symvers.sh would then fail on node_modules); the few calls
 * here are what that JavaScript makes.
 * EMBER_VOICE_BACKEND=wasm forces the WebAssembly build (it loads no code from anywhere, so it is honoured in an
 * installed Ember too); EMBER_VOICE_PROVIDER=cpu turns CoreML off.
 */

import { createRequire } from "node:module";
import os from "node:os";

export type SherpaBackend = "native" | "wasm";

/** The keyword spotter (a streaming zipformer transducer) and its keywords. */
export interface KwsSpec {
  encoder: string; decoder: string; joiner: string; tokens: string;
  keywords: string; maxActivePaths: number; numTrailingBlanks: number; keywordsScore: number; keywordsThreshold: number;
}

/** A Silero VAD. */
export interface VadSpec {
  model: string; threshold: number; minSilenceDuration: number; minSpeechDuration: number; maxSpeechDuration: number;
  windowSize: number; bufferSizeInSeconds: number;
}

/** Moonshine (v2: one merged decoder). */
export interface MoonshineSpec { encoder: string; mergedDecoder: string; tokens: string }

/** A voice: a Piper (VITS) voice, or Kokoro (native only: in WebAssembly it is several times slower than real time). */
export type TtsSpec =
  | { kind: "vits"; model: string; tokens: string; dataDir: string; noiseScale: number; noiseScaleW: number; lengthScale: number }
  | { kind: "kokoro"; model: string; voices: string; tokens: string; dataDir: string; lexicon: string; lang: string; lengthScale: number };

/** How a model runs: onnxruntime's execution provider and its CPU threads. */
export interface RunSpec { provider: string; numThreads: number }

export interface KwsStream { acceptWaveform(sampleRate: number, samples: Float32Array): void; free(): void }
export interface Spotter {
  createStream(): KwsStream;
  isReady(s: KwsStream): boolean;
  decode(s: KwsStream): void;
  getResult(s: KwsStream): { keyword?: string };
  reset(s: KwsStream): void;
  free(): void;
}
export interface Vad {
  acceptWaveform(samples: Float32Array): void;
  isEmpty(): boolean;
  isDetected(): boolean;
  /** The oldest segment (a copy: the build's own memory is never handed out). */
  front(): { samples: Float32Array; start: number };
  pop(): void;
  clear(): void;
  reset(): void;
  flush(): void;
  free(): void;
}
export interface OfflineStream { acceptWaveform(sampleRate: number, samples: Float32Array): void; free(): void }
export interface Recognizer {
  createStream(): OfflineStream;
  decode(s: OfflineStream): void;
  getResult(s: OfflineStream): { text?: string };
  free(): void;
}
export interface Tts {
  sampleRate: number;
  numSpeakers: number;
  generate(o: { text: string; sid: number; speed: number }): { samples: Float32Array; sampleRate: number };
  free(): void;
}

/**
 * One build of sherpa-onnx. Every create* throws when the model can't be made (a missing or damaged file): the
 * WebAssembly build throws bare numbers, or gives an empty handle, which is thrown here as an Error.
 */
export interface Sherpa {
  backend: SherpaBackend;
  /** native: the addon's version and onnxruntime's; wasm: why the addon isn't used (on Windows and macOS). */
  detail: string;
  createKws(spec: KwsSpec, run: RunSpec): Spotter;
  createVad(spec: VadSpec, run: RunSpec): Vad;
  createMoonshine(spec: MoonshineSpec, run: RunSpec): Recognizer;
  createTts(spec: TtsSpec, run: RunSpec, maxNumSentences: number): Tts;
}

/** The addon's platform package for `platform`/`arch` (npm's names), or null where none ships (Linux, 32-bit). */
export function nativePackage(platform: string = process.platform, arch: string = process.arch): string | null {
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) return `sherpa-onnx-win-${arch}`;
  if (platform === "darwin" && (arch === "x64" || arch === "arm64")) return `sherpa-onnx-darwin-${arch}`;
  return null;
}

/**
 * The execution providers to try for a model, best first; the last is always "cpu". CoreML on macOS (onnxruntime's
 * macOS build has it). DirectML isn't in the prebuilt Windows addon (its onnxruntime.dll imports neither DirectML.dll
 * nor d3d12.dll, and sherpa-onnx quietly runs on the CPU when asked for it), so Windows runs on the CPU.
 * Per-frame models (the spotter and the VADs: a few milliseconds every 32 ms) always run on the CPU: handing so little
 * work to the GPU costs more than it saves.
 */
export function providers(backend: SherpaBackend, platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (backend === "wasm") return ["cpu"];
  const forced = env.EMBER_VOICE_PROVIDER?.trim().toLowerCase();
  if (forced) return forced === "cpu" ? ["cpu"] : [forced, "cpu"];
  return platform === "darwin" ? ["coreml", "cpu"] : ["cpu"];
}

/** CPU threads for a model: WebAssembly has one; natively, up to `max`, leaving a core for everything else. */
export function threads(backend: SherpaBackend, max: number, cores: number = os.availableParallelism?.() ?? os.cpus().length): number {
  if (backend === "wasm") return 1;
  return Math.max(1, Math.min(max, cores - 1));
}

/* eslint-disable @typescript-eslint/no-explicit-any -- sherpa-onnx ships untyped JS */
const requireCjs = createRequire(__filename);
const SAMPLE_RATE = 16_000;

function wasmSherpa(detail: string): Sherpa {
  const w = requireCjs("sherpa-onnx") as any;
  const made = (what: string, m: any): any => {
    if (!m?.handle) throw new Error(`the ${what} couldn't be made`);
    return m;
  };
  return {
    backend: "wasm", detail,
    createKws(s) {
      return made("keyword spotter", w.createKws({
        featConfig: { samplingRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: { transducer: { encoder: s.encoder, decoder: s.decoder, joiner: s.joiner }, tokens: s.tokens, numThreads: 1, provider: "cpu", debug: 0 },
        maxActivePaths: s.maxActivePaths, numTrailingBlanks: s.numTrailingBlanks, keywordsScore: s.keywordsScore, keywordsThreshold: s.keywordsThreshold, keywords: s.keywords,
      }));
    },
    createVad(s) {
      return made("voice activity detector", w.createVad({
        sileroVad: { model: s.model, threshold: s.threshold, minSilenceDuration: s.minSilenceDuration, minSpeechDuration: s.minSpeechDuration, maxSpeechDuration: s.maxSpeechDuration, windowSize: s.windowSize },
        sampleRate: SAMPLE_RATE, numThreads: 1, provider: "cpu", debug: 0, bufferSizeInSeconds: s.bufferSizeInSeconds,
      }));
    },
    createMoonshine(s) {
      return made("speech recognizer", w.createOfflineRecognizer({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: { moonshine: { encoder: s.encoder, mergedDecoder: s.mergedDecoder }, tokens: s.tokens, numThreads: 1, provider: "cpu", debug: 0 },
        decodingMethod: "greedy_search",
      }));
    },
    createTts(s, _run, maxNumSentences) {
      if (s.kind !== "vits") throw new Error("Kokoro needs the native build");
      const tts = made("voice", w.createOfflineTts({
        offlineTtsModelConfig: {
          offlineTtsVitsModelConfig: { model: s.model, tokens: s.tokens, dataDir: s.dataDir, noiseScale: s.noiseScale, noiseScaleW: s.noiseScaleW, lengthScale: s.lengthScale },
          numThreads: 1, provider: "cpu", debug: 0,
        },
        maxNumSentences,
      }));
      return {
        sampleRate: Number(tts.sampleRate), numSpeakers: Number(tts.numSpeakers ?? 1),
        generate: o => tts.generate(o),
        free: () => tts.free(),
      };
    },
  };
}

/**
 * The addon's calls, as sherpa-onnx-node's JavaScript makes them. Its objects are freed by the garbage collector
 * (free() only drops them). `enableExternalBuffer: false` everywhere: Electron's V8 sandbox refuses buffers that
 * point into the addon's memory, so audio comes back copied.
 */
function nativeSherpa(a: any): Sherpa {
  const stream = (h: any, accept: (h: any, w: { samples: Float32Array; sampleRate: number }) => void) => ({
    h, acceptWaveform: (sampleRate: number, samples: Float32Array) => accept(h, { samples, sampleRate }), free() {},
  });
  return {
    backend: "native", detail: `sherpa-onnx ${a.version} (${a.gitSha1}), onnxruntime ${a.onnxruntimeVersion}`,
    createKws(s, run) {
      const h = a.createKeywordSpotter({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: { transducer: { encoder: s.encoder, decoder: s.decoder, joiner: s.joiner }, tokens: s.tokens, numThreads: run.numThreads, provider: run.provider, debug: 0 },
        maxActivePaths: s.maxActivePaths, numTrailingBlanks: s.numTrailingBlanks, keywordsScore: s.keywordsScore, keywordsThreshold: s.keywordsThreshold,
        keywordsBuf: s.keywords, keywordsBufSize: Buffer.byteLength(s.keywords),
      });
      if (!h) throw new Error("the keyword spotter couldn't be made");
      return {
        createStream: () => stream(a.createKeywordStream(h), a.acceptWaveformOnline),
        isReady: st => a.isKeywordStreamReady(h, (st as any).h),
        decode: st => a.decodeKeywordStream(h, (st as any).h),
        getResult: st => JSON.parse(a.getKeywordResultAsJson(h, (st as any).h)),
        reset: st => a.resetKeywordStream(h, (st as any).h),
        free() {},
      };
    },
    createVad(s, run) {
      const h = a.createVoiceActivityDetector({
        sileroVad: { model: s.model, threshold: s.threshold, minSilenceDuration: s.minSilenceDuration, minSpeechDuration: s.minSpeechDuration, maxSpeechDuration: s.maxSpeechDuration, windowSize: s.windowSize },
        sampleRate: SAMPLE_RATE, numThreads: run.numThreads, provider: run.provider, debug: 0,
      }, s.bufferSizeInSeconds);
      if (!h) throw new Error("the voice activity detector couldn't be made");
      return {
        acceptWaveform: x => a.voiceActivityDetectorAcceptWaveform(h, x),
        isEmpty: () => a.voiceActivityDetectorIsEmpty(h),
        isDetected: () => a.voiceActivityDetectorIsDetected(h),
        front: () => a.voiceActivityDetectorFront(h, false),
        pop: () => a.voiceActivityDetectorPop(h),
        clear: () => a.voiceActivityDetectorClear(h),
        reset: () => a.voiceActivityDetectorReset(h),
        flush: () => a.voiceActivityDetectorFlush(h),
        free() {},
      };
    },
    createMoonshine(s, run) {
      const h = a.createOfflineRecognizer({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: { moonshine: { encoder: s.encoder, mergedDecoder: s.mergedDecoder }, tokens: s.tokens, numThreads: run.numThreads, provider: run.provider, debug: 0 },
        decodingMethod: "greedy_search",
      });
      if (!h) throw new Error("the speech recognizer couldn't be made");
      return {
        createStream: () => stream(a.createOfflineStream(h), a.acceptWaveformOffline),
        decode: st => a.decodeOfflineStream(h, (st as any).h),
        getResult: st => JSON.parse(a.getOfflineStreamResultAsJson((st as any).h)),
        free() {},
      };
    },
    createTts(s, run, maxNumSentences) {
      const model = s.kind === "vits"
        ? { vits: { model: s.model, tokens: s.tokens, dataDir: s.dataDir, noiseScale: s.noiseScale, noiseScaleW: s.noiseScaleW, lengthScale: s.lengthScale } }
        : { kokoro: { model: s.model, voices: s.voices, tokens: s.tokens, dataDir: s.dataDir, lexicon: s.lexicon, lang: s.lang, lengthScale: s.lengthScale } };
      const h = a.createOfflineTts({ model: { ...model, numThreads: run.numThreads, provider: run.provider, debug: 0 }, maxNumSentences });
      if (!h) throw new Error("the voice couldn't be made");
      return {
        sampleRate: Number(a.getOfflineTtsSampleRate(h)), numSpeakers: Number(a.getOfflineTtsNumSpeakers(h)),
        generate: o => a.offlineTtsGenerate(h, { text: o.text, sid: o.sid, speed: o.speed, enableExternalBuffer: false }),
        free() {},
      };
    },
  };
}

let addon: { loaded: any } | { error: string } | null = null;

/** The addon, loaded once per process (`file`: a sherpa-onnx.node to load instead, for tests). */
function loadAddon(pkg: string, file?: string): any {
  if (addon && !file) {
    if ("error" in addon) throw new Error(addon.error);
    return addon.loaded;
  }
  try {
    const loaded = requireCjs(file ?? `${pkg}/sherpa-onnx.node`);
    if (typeof loaded?.createOfflineRecognizer !== "function") throw new Error("it isn't sherpa-onnx's addon");
    if (!file) addon = { loaded };
    return loaded;
  } catch (err) {
    const message = `${pkg} didn't load: ${String((err as Error)?.message ?? err).split("\n")[0]}`;
    if (!file) addon = { error: message };
    throw new Error(message, { cause: err });
  }
}

export interface RuntimeOptions {
  /** "wasm": the WebAssembly build; "native": the addon wherever it loads; "auto" (default): native on Windows and macOS. */
  prefer?: "auto" | "native" | "wasm";
  platform?: string;
  arch?: string;
  /** A sherpa-onnx.node to load (tests on Linux, where no addon is installed). */
  addonFile?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The build that runs speech in this process: the addon on Windows and macOS when it loads, otherwise WebAssembly
 * (`detail` then says why). Never throws for the addon: whatever goes wrong loading it, WebAssembly runs.
 */
export function sherpaRuntime(o: RuntimeOptions = {}): Sherpa {
  const env = o.env ?? process.env;
  const prefer = o.prefer && o.prefer !== "auto" ? o.prefer : env.EMBER_VOICE_BACKEND === "wasm" ? "wasm" : o.prefer ?? "auto";
  if (prefer === "wasm") return wasmSherpa("WebAssembly asked for");
  const pkg = nativePackage(o.platform, o.arch);
  if (!pkg && !o.addonFile) return wasmSherpa(`no native build for ${o.platform ?? process.platform}-${o.arch ?? process.arch}`);
  try {
    return nativeSherpa(loadAddon(pkg ?? "sherpa-onnx native addon", o.addonFile));
  } catch (err) {
    return wasmSherpa((err as Error).message);
  }
}

/** What trying one provider came to: loaded (and how long the probe took, ms), or why not. */
export interface ProviderTry { provider: string; ms?: number; error?: string }

/**
 * Makes a model with each provider in `list` and keeps the fastest: with one provider, it is made and kept as it is;
 * with more, each is made and `probe`d twice (the first run compiles, for CoreML), and the one whose second probe took
 * least is kept. A provider that fails to make the model, or to run it, is skipped; if every one fails, the last
 * error is thrown.
 */
export function fastestProvider<T>(list: string[], make: (provider: string) => T, probe: (made: T) => void, now: () => number = () => performance.now()): { made: T; provider: string; tried: ProviderTry[] } {
  const tried: ProviderTry[] = [];
  let best: { made: T; provider: string; ms: number } | null = null;
  let last: unknown = null;
  for (const provider of list) {
    try {
      const made = make(provider);
      if (list.length === 1) return { made, provider, tried: [{ provider }] };
      probe(made);
      const t0 = now();
      probe(made);
      const ms = Math.round((now() - t0) * 10) / 10;
      tried.push({ provider, ms });
      if (!best || ms < best.ms) best = { made, provider, ms };
    } catch (err) {
      last = err;
      tried.push({ provider, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (!best) throw last;
  return { made: best.made, provider: best.provider, tried };
}
