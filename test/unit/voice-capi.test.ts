/**
 * Native speech through sherpa-onnx's C API (app/voice/capi.ts, docs/ASSISTANT.md phase 1.1): the struct layouts are
 * complete and ordered, a folder without the libraries falls back to WebAssembly, and (where the libraries and the
 * models are present: node scripts/voice/fetch-capi.mjs and prepare.mjs, Linux x64) the binding runs Ember's own models.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CAPI_STRUCTS, CAPI_VERSION } from "../../app/voice/capi-structs";
import { sherpaRuntime } from "../../app/voice/runtime";
import { modelPaths } from "../../app/voice/models";
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

  it("is never used when WebAssembly is asked for", () => {
    expect(sherpaRuntime({ prefer: "wasm", capiDir: "/anywhere" }).backend).toBe("wasm");
  });

  it.skipIf(!runnable)("runs Ember's own models natively: hears the wake clip's request and speaks with Piper", () => {
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
