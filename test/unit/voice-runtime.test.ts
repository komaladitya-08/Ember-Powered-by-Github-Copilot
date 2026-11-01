/**
 * Which build of sherpa-onnx runs speech (app/voice/runtime.ts): the native addon's package per platform, the
 * providers and threads each model gets, choosing the faster provider, and falling back to WebAssembly.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fastestProvider, modelKey, nativePackage, providerCache, providers, sherpaRuntime, threads } from "../../app/voice/runtime";

describe("the native addon's package", () => {
  it("is sherpa-onnx-node's own per-platform package on Windows and macOS (npm's names: win, not win32)", () => {
    expect(nativePackage("win32", "x64")).toBe("sherpa-onnx-win-x64");
    expect(nativePackage("win32", "arm64")).toBe("sherpa-onnx-win-arm64");
    expect(nativePackage("darwin", "arm64")).toBe("sherpa-onnx-darwin-arm64");
    expect(nativePackage("darwin", "x64")).toBe("sherpa-onnx-darwin-x64");
  });

  it("doesn't exist for Linux (RHEL 8's glibc 2.28 can't load it) or 32-bit Windows", () => {
    expect(nativePackage("linux", "x64")).toBeNull();
    expect(nativePackage("linux", "arm64")).toBeNull();
    expect(nativePackage("win32", "ia32")).toBeNull();
  });

  it("is installed only where it runs: the lockfile lists the four packages, each for its own OS and CPU, and no Linux build", () => {
    const lock = JSON.parse(fs.readFileSync(path.resolve("package-lock.json"), "utf8")) as { packages: Record<string, { version?: string; os?: string[]; cpu?: string[]; optional?: boolean }> };
    const sherpa = Object.entries(lock.packages).filter(([k]) => /node_modules\/sherpa-onnx-/.test(k));
    expect(sherpa.map(([k, v]) => [k.replace(/^node_modules\//, ""), v.version, v.os, v.cpu, v.optional]).sort()).toEqual([
      ["sherpa-onnx-darwin-arm64", "1.13.8", ["darwin"], ["arm64"], true],
      ["sherpa-onnx-darwin-x64", "1.13.8", ["darwin"], ["x64"], true],
      ["sherpa-onnx-win-arm64", "1.13.8", ["win32"], ["arm64"], true],
      ["sherpa-onnx-win-x64", "1.13.8", ["win32"], ["x64"], true],
    ]);
    // sherpa-onnx-node's JavaScript would bring sherpa-onnx-linux-x64 with it (an optional dependency of its own).
    expect(Object.keys(lock.packages).filter(k => /sherpa-onnx-(node|linux)/.test(k))).toEqual([]);
  });
});

describe("providers and threads", () => {
  it("runs on the CPU everywhere, and times CoreML against it on macOS only for a model worth a GPU (Kokoro)", () => {
    expect(providers("native", "darwin", {})).toEqual(["cpu"]);
    expect(providers("native", "darwin", {}, { gpu: true })).toEqual(["coreml", "cpu"]);
    // No DirectML in the prebuilt Windows addon; WebAssembly has the CPU alone.
    expect(providers("native", "win32", {}, { gpu: true })).toEqual(["cpu"]);
    expect(providers("wasm", "darwin", {}, { gpu: true })).toEqual(["cpu"]);
  });

  it("takes EMBER_VOICE_PROVIDER: cpu turns CoreML off; another provider is tried before the CPU", () => {
    expect(providers("native", "darwin", { EMBER_VOICE_PROVIDER: "cpu" })).toEqual(["cpu"]);
    expect(providers("native", "win32", { EMBER_VOICE_PROVIDER: "DirectML" })).toEqual(["directml", "cpu"]);
    expect(providers("wasm", "win32", { EMBER_VOICE_PROVIDER: "directml" })).toEqual(["cpu"]);
  });

  it("gives WebAssembly one thread, and the addon up to the cap, leaving a core free", () => {
    expect(threads("wasm", 4, 16)).toBe(1);
    expect(threads("native", 4, 16)).toBe(4);
    expect(threads("native", 4, 4)).toBe(3);
    expect(threads("native", 2, 2)).toBe(1);
    expect(threads("native", 2, 1)).toBe(1);
  });
});

describe("fastestProvider", () => {
  /** A clock each probe moves on by its provider's cost. */
  const timed = (cost: Record<string, number>) => {
    let t = 0;
    return { now: () => t, probe: (p: string) => { t += cost[p]; } };
  };

  it("makes the model once, with no probe, when there is one provider", () => {
    let probes = 0;
    const r = fastestProvider(["cpu"], p => p, () => { probes++; });
    expect(r).toEqual({ made: "cpu", provider: "cpu", tried: [{ provider: "cpu" }] });
    expect(probes).toBe(0);
  });

  it("keeps the provider whose second probe was quicker (the first compiles)", () => {
    const c = timed({ coreml: 40, cpu: 90 });
    expect(fastestProvider(["coreml", "cpu"], p => p, c.probe, { now: c.now })).toEqual({ made: "coreml", provider: "coreml", tried: [{ provider: "coreml", ms: 40 }, { provider: "cpu", ms: 90 }] });
    const slow = timed({ coreml: 300, cpu: 90 });
    expect(fastestProvider(["coreml", "cpu"], p => p, slow.probe, { now: slow.now }).provider).toBe("cpu");
  });

  it("skips a provider that can't make or run the model, and throws when none can", () => {
    const c = timed({ cpu: 10 });
    const r = fastestProvider(["coreml", "cpu"], p => { if (p === "coreml") throw new Error("no CoreML"); return p; }, c.probe, { now: c.now });
    expect(r.provider).toBe("cpu");
    expect(r.tried).toEqual([{ provider: "coreml", error: "no CoreML" }, { provider: "cpu", ms: 10 }]);
    const r2 = fastestProvider(["coreml", "cpu"], p => p, p => { if (p === "coreml") throw new Error("CoreML failed to run it"); }, { now: () => 0 });
    expect(r2.provider).toBe("cpu");
    expect(() => fastestProvider(["coreml", "cpu"], () => { throw new Error("damaged"); }, () => undefined)).toThrow("damaged");
  });
});

describe("remembering the fastest provider", () => {
  it("times once per model, then uses the verdict without timing; times again when it can't be made, or the model changed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-providers-"));
    try {
      const store = providerCache(path.join(dir, "providers.json"));
      const model = path.join(dir, "model.onnx");
      fs.writeFileSync(model, "x");
      const key = modelKey(model, ["coreml", "cpu"], 2);
      expect(key).not.toBeNull();
      let t = 0, probes = 0;
      const probe = (p: string) => { probes++; t += p === "coreml" ? 90 : 40; };
      const first = fastestProvider(["coreml", "cpu"], p => p, probe, { now: () => t, cache: { store, key } });
      expect(first.provider).toBe("cpu");
      expect(probes).toBe(4);
      const again = fastestProvider(["coreml", "cpu"], p => p, probe, { now: () => t, cache: { store, key } });
      expect(again).toEqual({ made: "cpu", provider: "cpu", tried: [{ provider: "cpu", cached: true }] });
      expect(probes).toBe(4);
      // The remembered provider can't make it: timed again.
      const broken = fastestProvider(["coreml", "cpu"], p => { if (p === "cpu") throw new Error("gone"); return p; }, probe, { now: () => t, cache: { store, key } });
      expect(broken.provider).toBe("coreml");
      // A replaced model has another key; a damaged file is no verdict.
      fs.writeFileSync(model, "xy");
      expect(modelKey(model, ["coreml", "cpu"], 2)).not.toBe(key);
      fs.writeFileSync(path.join(dir, "providers.json"), "{oops");
      expect(store.get(key!)).toBeUndefined();
      expect(modelKey(path.join(dir, "missing.onnx"), ["cpu"], 1)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a verdict for a provider that isn't being tried (EMBER_VOICE_PROVIDER=cpu)", () => {
    const store = { get: () => "coreml", set: () => undefined };
    expect(fastestProvider(["cpu"], p => p, () => undefined, { cache: { store, key: "k" } }).provider).toBe("cpu");
  });
});

describe("sherpaRuntime", () => {
  it("runs WebAssembly on Linux, saying why", () => {
    const s = sherpaRuntime({ platform: "linux", arch: "x64", env: {} });
    expect(s).toMatchObject({ backend: "wasm", detail: "no native build for linux-x64" });
  });

  it("runs WebAssembly when EMBER_VOICE_BACKEND=wasm, also where the addon would load", () => {
    expect(sherpaRuntime({ platform: "darwin", arch: "arm64", env: { EMBER_VOICE_BACKEND: "wasm" } })).toMatchObject({ backend: "wasm", detail: "WebAssembly asked for" });
  });

  it("falls back to WebAssembly when the addon doesn't load, saying why", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-addon-"));
    try {
      const file = path.join(dir, "sherpa-onnx.node");
      fs.writeFileSync(file, "not an addon");
      const s = sherpaRuntime({ prefer: "native", addonFile: file, env: {} });
      expect(s.backend).toBe("wasm");
      expect(s.detail).toMatch(/didn't load/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // On Linux no platform package is installed: asked for Windows's, it isn't there.
    if (process.platform === "linux") expect(sherpaRuntime({ platform: "win32", arch: "x64", env: {} })).toMatchObject({ backend: "wasm", detail: expect.stringMatching(/^sherpa-onnx-win-x64 didn't load/) });
  });

  it("refuses Kokoro in WebAssembly (it would speak several times slower than real time)", () => {
    const s = sherpaRuntime({ prefer: "wasm" });
    expect(() => s.createTts({ kind: "kokoro", model: "m", voices: "v", tokens: "t", dataDir: "d", lexicon: "", lang: "", lengthScale: 1 }, { provider: "cpu", numThreads: 1 }, 1)).toThrow("Kokoro needs the native build");
  });

  it("throws for a model that can't be made, in WebAssembly too (where it would be an empty handle)", () => {
    const s = sherpaRuntime({ prefer: "wasm" });
    expect(() => s.createVad({ model: path.join(os.tmpdir(), "no-such-vad.onnx"), threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.2, maxSpeechDuration: 10, windowSize: 512, bufferSizeInSeconds: 10 }, { provider: "cpu", numThreads: 1 })).toThrow();
  });
});
