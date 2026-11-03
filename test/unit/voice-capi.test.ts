/**
 * Native speech through sherpa-onnx's C API (app/voice/capi.ts, docs/ASSISTANT.md phase 1.1): the struct layouts are
 * complete and ordered, the libraries are pinned, the choice of build (capiChoice) and its processor check fall back to
 * WebAssembly whenever the libraries are missing, can't run or don't load, and (where the libraries and the
 * models are present: node scripts/voice/fetch-capi.mjs and prepare.mjs, Linux x64) the binding runs Ember's own models.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CAPI_STRUCTS, CAPI_VERSION } from "../../app/voice/capi-structs";
import { capiChoice, sherpaRuntime } from "../../app/voice/runtime";
import { CAPI_CPU_NEEDS, CAPI_LIBS, cpuLacks, isDuplicateType } from "../../app/voice/capi";
import { CAPI_RELEASE, modelPaths } from "../../app/voice/models";
import { piperSpec } from "../../app/voice/tts-spec";

const root = path.join(__dirname, "../..");
const capiDir = path.join(root, `.cache/voice/capi/sherpa-onnx-v${CAPI_VERSION}-linux-x64-shared/lib`);
const models = path.join(root, ".cache/voice/models");
const runnable = process.platform === "linux" && process.arch === "x64" && fs.existsSync(path.join(capiDir, "libsherpa-onnx-c-api.so")) && fs.existsSync(path.join(models, "silero_vad.onnx"));

describe("the C API's struct layouts (capi-structs.ts)", () => {
  it("are the same release Ember's speech pins, and every struct field names one defined before it", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(CAPI_VERSION).toBe(pkg.dependencies["sherpa-onnx"]);
    const seen = new Set<string>();
    for (const s of CAPI_STRUCTS) {
      for (const [, t] of s.fields) expect(["int32_t", "float", "const char *", "float *", "void *"].includes(t) || seen.has(t), `${s.name}: ${t}`).toBe(true);
      seen.add(s.name);
    }
    for (const r of ["SherpaOnnxKeywordSpotterConfig", "SherpaOnnxVadModelConfig", "SherpaOnnxOfflineRecognizerConfig", "SherpaOnnxOfflineTtsConfig", "SherpaOnnxSpeechSegment", "SherpaOnnxGeneratedAudio"]) expect(seen.has(r), r).toBe(true);
  });
});

describe("sherpaRuntime with a C API folder", () => {
  it("falls back to WebAssembly, saying why, when the folder has no libraries", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ember-capi-"));
    const s = sherpaRuntime({ capiDir: empty });
    expect(s.backend).toBe("wasm");
    expect(s.detail).toMatch(/no C API libraries/);
  });

  it("ignores only a struct defined twice in one process, never another layout error (voice audit)", () => {
    expect(isDuplicateType(new Error("Duplicate type name 'SherpaOnnxVadModelConfig'"))).toBe(true);
    expect(isDuplicateType(new Error("Unknown or invalid type name 'float32'"))).toBe(false);
    expect(isDuplicateType("boom")).toBe(false);
  });

  it("are fetched again unless every library matches its own SHA-256 pin, and refused if they still don't (voice audit)", () => {
    const fetch = fs.readFileSync(path.join(root, "scripts/voice/fetch-capi.mjs"), "utf8");
    expect(fetch).toContain('crypto.createHash("sha256").update(fs.readFileSync(path.join(lib, f))).digest("hex") !== sha');
    expect(fetch).toContain("if (wrong().length) await fetchModel(dir, CAPI_RELEASE, httpsDownloader);");
    expect(fetch).toContain("if (still.length) {");
  });

  it("pins the very libraries Ember loads, in the order they load, from the release its speech already pins", () => {
    expect(Object.keys(CAPI_RELEASE.libs)).toEqual([...CAPI_LIBS]);
    for (const sha of Object.values(CAPI_RELEASE.libs)) expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(CAPI_RELEASE.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(CAPI_RELEASE.target).toBe(`sherpa-onnx-v${CAPI_VERSION}-linux-x64-shared`);
    expect(CAPI_RELEASE.url).toBe(`https://github.com/k2-fsa/sherpa-onnx/releases/download/v${CAPI_VERSION}/${CAPI_RELEASE.target}.tar.bz2`);
  });

  it.skipIf(!runnable)("has the pinned bytes in the folder fetch-capi.mjs filled", () => {
    for (const [f, sha] of Object.entries(CAPI_RELEASE.libs)) expect(crypto.createHash("sha256").update(fs.readFileSync(path.join(capiDir, f))).digest("hex"), f).toBe(sha);
  });

  it("runs on WebAssembly, without loading anything, on a processor without a feature the libraries need", () => {
    // A folder with files named like the libraries (not loadable): the processor check comes before any load.
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), "ember-capi-"));
    for (const f of CAPI_LIBS) fs.writeFileSync(path.join(fake, f), "not a library");
    const s = sherpaRuntime({ capiDir: fake, env: {}, cpuNeeds: ["avx2"], cpuinfo: () => "processor\t: 0\nflags\t\t: fpu sse sse2 avx\n" });
    expect(s).toMatchObject({ backend: "wasm", detail: "this processor lacks avx2" });
    // With the processor able to run them, a library that won't load is WebAssembly too, saying why.
    expect(sherpaRuntime({ capiDir: fake, env: {}, cpuNeeds: ["avx2"], cpuinfo: () => "flags\t\t: fpu sse sse2 avx avx2\n" })).toMatchObject({ backend: "wasm", detail: expect.stringMatching(/^the C API didn't load: /) });
  });
});

describe("cpuLacks (the C API's processor check)", () => {
  it("names what the processor lacks, counting a feature only when every processor has it", () => {
    const two = "processor\t: 0\nflags\t\t: fpu sse2 avx avx2\n\nprocessor\t: 1\nflags\t\t: fpu sse2 avx\n";
    expect(cpuLacks(["avx", "avx2"], two)).toEqual(["avx2"]);
    expect(cpuLacks(["avx"], two)).toEqual([]);
  });

  it("fails closed: without /proc/cpuinfo, or without a flags line, everything needed counts as missing", () => {
    expect(cpuLacks(["avx"], null)).toEqual(["avx"]);
    expect(cpuLacks(["avx"], "processor\t: 0\nmodel name\t: Somebody's CPU\n")).toEqual(["avx"]);
  });

  it("needs nothing to be read when nothing is needed", () => {
    expect(cpuLacks([], null)).toEqual([]);
  });

  it("is told that sherpa-onnx 1.13.8's libraries need nothing beyond x86-64: onnxruntime picks AVX kernels from CPUID", () => {
    expect(CAPI_CPU_NEEDS).toEqual([]);
  });
});

describe("capiChoice (which build runs speech on Linux)", () => {
  const has = () => true;
  it("is native when Ember's own libraries are there and this processor can run them", () => {
    expect(capiChoice({ capiDir: "/opt/ember/resources/voice-native", env: {}, has, cpuNeeds: ["avx"], cpuinfo: () => "flags\t: sse2 avx\n" })).toEqual({ backend: "native", why: "sherpa-onnx's C API" });
    // Nothing needed: /proc/cpuinfo isn't even read.
    expect(capiChoice({ capiDir: "/x", env: {}, has, cpuNeeds: [], cpuinfo: () => { throw new Error("read"); } }).backend).toBe("native");
  });

  it("is WebAssembly when EMBER_VOICE_BACKEND=wasm asks for it, also with the libraries there", () => {
    expect(capiChoice({ capiDir: "/x", env: { EMBER_VOICE_BACKEND: "wasm" }, has })).toEqual({ backend: "wasm", why: "EMBER_VOICE_BACKEND=wasm" });
  });

  it("is WebAssembly without a folder, or with the libraries missing from it", () => {
    expect(capiChoice({ capiDir: null, env: {}, has })).toEqual({ backend: "wasm", why: "no native build here" });
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ember-capi-"));
    expect(capiChoice({ capiDir: empty, env: {} })).toEqual({ backend: "wasm", why: `no C API libraries in ${empty}` });
  });

  it("is WebAssembly on a processor without what the libraries need, or when it can't tell", () => {
    expect(capiChoice({ capiDir: "/x", env: {}, has, cpuNeeds: ["avx", "avx2"], cpuinfo: () => "flags\t: sse2\n" })).toEqual({ backend: "wasm", why: "this processor lacks avx, avx2" });
    expect(capiChoice({ capiDir: "/x", env: {}, has, cpuNeeds: ["avx2"], cpuinfo: () => null })).toEqual({ backend: "wasm", why: "this processor lacks avx2" });
  });

  it("is never used when WebAssembly is asked for", () => {
    expect(sherpaRuntime({ prefer: "wasm", capiDir: "/anywhere" }).backend).toBe("wasm");
  });

  // Loading and running real models takes seconds on a busy CI machine (as in test/integration/voice.test.ts).
  it.skipIf(!runnable)("runs Ember's own models natively: hears the wake clip's request and speaks with Piper", { timeout: 20_000 }, () => {
    const s = sherpaRuntime({ capiDir });
    expect(s.backend).toBe("native");
    expect(s.detail).toMatch(/C API through koffi/);
    const p = modelPaths(models);
    const b = fs.readFileSync(path.join(root, "test/fixtures/voice/wake.wav"));
    const at = b.indexOf("data") + 8;
    const audio = new Float32Array((b.length - at) / 2).map((_, i) => b.readInt16LE(at + i * 2) / 32768);
    const a = (f: string) => path.join(p.asr, f);
    const asr = s.createMoonshine({ encoder: a("encoder_model.ort"), mergedDecoder: a("decoder_model_merged.ort"), tokens: a("tokens.txt") }, { provider: "cpu", numThreads: 2 });
    const st = asr.createStream();
    st.acceptWaveform(16_000, audio);
    asr.decode(st);
    expect(asr.getResult(st).text?.toLowerCase()).toMatch(/night light/);
    st.free(); asr.free();
    const tts = s.createTts(piperSpec(p.tts), { provider: "cpu", numThreads: 1 }, 1);
    const out = tts.generate({ text: "Night Light is on.", sid: 0, speed: 1 });
    expect(out.sampleRate).toBe(tts.sampleRate);
    expect(out.samples.length / out.sampleRate).toBeGreaterThan(0.5);
    tts.free();
  });
});
