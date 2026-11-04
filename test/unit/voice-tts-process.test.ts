/**
 * Ember's voice process (app/voice/tts-process.ts) with a stand-in for Electron's parent port and for sherpa-onnx
 * (runtime.ts): which voice it loads, on which build, and what it tells main about it.
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sherpa, Tts, TtsSpec } from "../../app/voice/runtime";

/** The stand-in build: `cost` is the seconds a voice takes per second of speech (its clock moves on by that). */
const fake = vi.hoisted(() => ({
  backend: "native" as "native" | "wasm",
  cost: { kokoro: 0.3, kitten: 0.25 } as Record<string, number>,
  failKokoro: false,
  failKitten: false,
  freed: [] as string[],
  emptyText: "",
  failText: "",
  /** The providers tried (the real list depends on the OS: CoreML first on macOS) and each one's speed-up. */
  providers: ["cpu"] as string[],
  speedup: { cpu: 1, coreml: 1 } as Record<string, number>,
  made: [] as { kind: string; provider: string; numThreads: number }[],
  clock: 0,
}));

vi.mock("../../app/voice/runtime", async importOriginal => {
  const real = await importOriginal<typeof import("../../app/voice/runtime")>();
  return {
    ...real,
    providers: () => fake.providers,
    sherpaRuntime: (o: { prefer?: string } = {}): Partial<Sherpa> => {
      const backend = o.prefer === "wasm" ? "wasm" : fake.backend;
      return {
        backend, detail: backend === "native" ? "sherpa-onnx 1.13.8" : "WebAssembly asked for",
        createTts(spec: TtsSpec, run: { provider: string; numThreads: number }): Tts {
          if (spec.kind === "kokoro" && fake.failKokoro) throw new Error("Kokoro failed");
          if (spec.kind === "kitten" && fake.failKitten) throw new Error("Kitten failed");
          fake.made.push({ kind: spec.kind, provider: run.provider, numThreads: run.numThreads });
          return {
            sampleRate: 24_000, numSpeakers: 8, free() { fake.freed.push(spec.kind); },
            generate: ({ text }) => {
              if (text === fake.failText) throw new Error("Synthesis failed");
              if (text === fake.emptyText) return { samples: new Float32Array(), sampleRate: 24_000 };
              const seconds = text.length / 15, rate = 24_000;
              fake.clock += (seconds * fake.cost[spec.kind] * 1000) / fake.speedup[run.provider];
              return { samples: new Float32Array(Math.round(seconds * rate)), sampleRate: rate };
            },
          };
        },
      };
    },
  };
});

let dirs: string[] = [];
const folder = (name: string, files: string[]) => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ember-tts-")), name);
  fs.mkdirSync(dir);
  for (const f of files) fs.writeFileSync(path.join(dir, f), "");
  dirs.push(path.dirname(dir));
  return dir;
};

async function speechProcess() {
  vi.resetModules();
  const parent = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  (process as unknown as { parentPort: unknown }).parentPort = parent;
  await import("../../app/voice/tts-process");
  return {
    init: (o: { model?: string; natural?: string | null; wasm?: boolean } = {}) => parent.emit("message", { data: { type: "init", model: o.model ?? folder("kitten-nano-en-v0_8-fp32", ["model.fp32.onnx", "voices.bin", "tokens.txt", "espeak-ng-data"]), ...o } }),
    sent: () => parent.postMessage.mock.calls.map(c => c[0] as { type: string; voice?: Record<string, unknown>; rate?: number }),
  };
}

beforeEach(() => {
  fake.backend = "native"; fake.cost = { kokoro: 0.3, kitten: 0.25 }; fake.failKokoro = false; fake.failKitten = false; fake.freed = []; fake.made = []; fake.clock = 0;
  fake.emptyText = ""; fake.failText = "";
  fake.providers = ["cpu"]; fake.speedup = { cpu: 1, coreml: 1 };
  vi.spyOn(performance, "now").mockImplementation(() => fake.clock);
});
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); dirs = []; });

describe("Ember's voice process", () => {
  it("drops a hushed reply before it generates a chunk, then speaks the newer reply", async () => {
    const p = await speechProcess();
    p.init();
    const port = (process as unknown as { parentPort: EventEmitter }).parentPort;
    port.emit("message", { data: { type: "say", id: 1, text: "Old reply." } });
    port.emit("message", { data: { type: "hush", id: 1 } });
    port.emit("message", { data: { type: "say", id: 2, text: "New reply." } });
    await vi.waitFor(() => expect(p.sent()).toContainEqual({ type: "done", id: 2 }));
    expect(p.sent().filter(m => m.type === "audio")).toEqual([expect.objectContaining({ id: 2 })]);
    expect(p.sent()).not.toContainEqual({ type: "done", id: 1 });
  });

  it("honours a hush between generated chunks without sending the cancelled suffix", async () => {
    const p = await speechProcess();
    p.init();
    const port = (process as unknown as { parentPort: EventEmitter & { postMessage: ReturnType<typeof vi.fn> } }).parentPort;
    port.postMessage.mockImplementation((m: { type: string; id?: number }) => {
      if (m.type !== "audio" || m.id !== 1) return;
      port.emit("message", { data: { type: "hush", id: 1 } });
      port.emit("message", { data: { type: "say", id: 2, text: "New reply." } });
    });
    port.emit("message", { data: { type: "say", id: 1, text: "The first sentence. The second sentence." } });
    await vi.waitFor(() => expect(p.sent()).toContainEqual({ type: "done", id: 2 }));
    expect(p.sent().filter(m => m.type === "audio")).toEqual([
      expect.objectContaining({ id: 1, remaining: "The second sentence." }), expect.objectContaining({ id: 2 }),
    ]);
    expect(p.sent()).not.toContainEqual({ type: "done", id: 1 });
  });

  it.each(["throw", "empty"])("reports the exact ungenerated suffix before a later chunk fails (%s)", async kind => {
    const p = await speechProcess();
    p.init();
    if (kind === "throw") fake.failText = "The second sentence.";
    else fake.emptyText = "The second sentence.";
    const port = (process as unknown as { parentPort: EventEmitter }).parentPort;
    port.emit("message", { data: { type: "say", id: 1, text: "The first sentence. The second sentence." } });
    await vi.waitFor(() => expect(p.sent().some(m => m.type === "failed")).toBe(true));
    expect(p.sent().filter(m => m.type === "audio")).toEqual([
      expect.objectContaining({ id: 1, remaining: "The second sentence." }),
    ]);
    expect(p.sent().filter(m => m.type === "done")).toEqual([]);
  });

  it("speaks in default Kitten on one native thread after its real-time probe passes", async () => {
    const p = await speechProcess();
    p.init();
    const ready = p.sent().find(m => m.type === "ready")!;
    expect(ready).toMatchObject({ rate: 24_000, voice: { voice: "kitten", backend: "native", provider: "cpu", rtf: 0.25 } });
    expect(ready.voice).not.toHaveProperty("natural");
    expect(fake.made).toEqual([{ kind: "kitten", provider: "cpu", numThreads: 1 }]);
  });

  it("speaks in Kokoro when it is downloaded and fast enough here (its speaker: af_bella in v0.19)", async () => {
    const p = await speechProcess();
    p.init({ natural: folder("kokoro-en-v0_19", ["model.onnx", "voices.bin", "tokens.txt"]) });
    expect(p.sent().find(m => m.type === "ready")).toMatchObject({ rate: 24_000, voice: { voice: "kokoro", backend: "native", rtf: 0.3 } });
    expect(fake.made.map(m => m.kind)).toEqual(["kokoro"]);
  });

  it("reports a slow default to main for the OS voice, freeing the model", async () => {
    fake.cost.kitten = 0.9;
    const p = await speechProcess();
    p.init();
    expect(p.sent()).toEqual([{ type: "error", reason: "slow", message: "too slow here: 0.9 of real time (at most 0.5)" }]);
    expect(fake.made.map(m => m.kind)).toEqual(["kitten"]);
    expect(fake.freed).toEqual(["kitten"]);
  });

  it("reuses a slow Kitten verdict without loading it, and retries after a week", async () => {
    const model = folder("kitten-nano-en-v0_8-fp32", ["model.fp32.onnx", "voices.bin", "tokens.txt", "espeak-ng-data"]);
    fake.cost.kitten = 0.9;
    let p = await speechProcess();
    p.init({ model });
    expect(p.sent()).toEqual([expect.objectContaining({ type: "error", reason: "slow" })]);
    fake.made = [];
    p = await speechProcess();
    p.init({ model });
    expect(fake.made).toEqual([]);
    expect(p.sent()).toEqual([expect.objectContaining({ type: "error", reason: "slow", message: expect.stringMatching(/timed before/) })]);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 7 * 24 * 3_600_000);
    fake.cost.kitten = 0.25;
    p = await speechProcess();
    p.init({ model });
    expect(fake.made.map(m => m.kind)).toEqual(["kitten"]);
    expect(p.sent()).toEqual([expect.objectContaining({ type: "ready", voice: expect.objectContaining({ voice: "kitten", rtf: 0.25 }) })]);
  });

  it("rejects a probe with no audio and frees its model for the OS fallback", async () => {
    fake.emptyText = "I opened the terminal and ran the tests; all of them passed.";
    const p = await speechProcess();
    p.init();
    expect(p.sent()).toEqual([expect.objectContaining({ type: "error", reason: "load", message: expect.stringMatching(/no usable audio/) })]);
    expect(fake.freed).toEqual(["kitten"]);
  });

  it("keeps all neural speech out of WebAssembly and reports the OS fallback reason", async () => {
    const p = await speechProcess();
    p.init({ wasm: true });
    expect(p.sent()).toEqual([{ type: "error", reason: "native", message: expect.stringMatching(/native speech runtime/) }]);
    expect(fake.made).toEqual([]);
    const port = (process as unknown as { parentPort: EventEmitter }).parentPort;
    port.emit("message", { data: { type: "say", id: 1, text: "Hello." } });
    await new Promise<void>(r => setImmediate(r));
    expect(p.sent().filter(m => m.type === "audio" || m.type === "ready")).toEqual([]);
  });

  it("times CoreML against the CPU (macOS) and keeps the faster, saying what each took", async () => {
    fake.providers = ["coreml", "cpu"];
    fake.speedup = { coreml: 2, cpu: 1 };
    let p = await speechProcess();
    p.init({ natural: folder("kokoro-en-v0_19", ["model.onnx", "voices.bin", "tokens.txt"]) });
    let ready = p.sent().find(m => m.type === "ready")!;
    expect(ready.voice).toMatchObject({ voice: "kokoro", provider: "coreml", tried: [{ provider: "coreml" }, { provider: "cpu" }] });
    fake.speedup = { coreml: 0.5, cpu: 1 };
    p = await speechProcess();
    p.init({ natural: folder("kokoro-en-v0_19", ["model.onnx", "voices.bin", "tokens.txt"]) });
    ready = p.sent().find(m => m.type === "ready")!;
    expect(ready.voice).toMatchObject({ provider: "cpu" });
  });

  it("falls back to Kitten when Kokoro is too slow here, or doesn't load, saying why", async () => {
    fake.cost.kokoro = 0.9;
    let p = await speechProcess();
    p.init({ natural: folder("kokoro-en-v0_19", ["model.onnx", "voices.bin", "tokens.txt"]) });
    expect(p.sent().find(m => m.type === "ready")).toMatchObject({ voice: { voice: "kitten", natural: "too slow here: 0.9 of real time (at most 0.5)" } });
    fake.failKokoro = true;
    p = await speechProcess();
    p.init({ natural: folder("kokoro-en-v0_19", ["model.onnx", "voices.bin", "tokens.txt"]) });
    expect(p.sent().find(m => m.type === "ready")).toMatchObject({ voice: { voice: "kitten", natural: "it couldn't be loaded: Kokoro failed" } });
  });

  it("skips loading slow Kokoro on the next start and tries it again after a week", async () => {
    fake.cost.kokoro = 0.9;
    const kokoro = folder("kokoro-multi-lang-v1_0", ["model.onnx", "voices.bin", "tokens.txt"]);
    let p = await speechProcess();
    p.init({ natural: kokoro });
    expect(fake.made.map(m => m.kind)).toEqual(["kokoro", "kitten"]);
    fake.made = [];
    p = await speechProcess();
    p.init({ natural: kokoro });
    expect(fake.made.map(m => m.kind)).toEqual(["kitten"]);
    expect(p.sent().find(m => m.type === "ready")).toMatchObject({ voice: { voice: "kitten", naturalWhy: "slow", natural: "too slow here: 0.9 of real time (at most 0.5; timed before)" } });
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 7 * 24 * 3_600_000);
    fake.made = [];
    fake.cost.kokoro = 0.3;
    p = await speechProcess();
    p.init({ natural: kokoro });
    expect(fake.made.map(m => m.kind)).toEqual(["kokoro"]);
    expect(p.sent().find(m => m.type === "ready")).toMatchObject({ voice: { voice: "kokoro", rtf: 0.3 } });
  });

  it("retries a slow natural voice immediately when its model file changes", async () => {
    fake.cost.kokoro = 0.9;
    const kokoro = folder("kokoro-multi-lang-v1_0", ["model.onnx", "voices.bin", "tokens.txt"]);
    let p = await speechProcess();
    p.init({ natural: kokoro });
    fs.writeFileSync(path.join(kokoro, "model.onnx"), "replacement");
    fake.made = [];
    fake.cost.kokoro = 0.3;
    p = await speechProcess();
    p.init({ natural: kokoro });
    expect(fake.made.map(m => m.kind)).toEqual(["kokoro"]);
    expect(p.sent().find(m => m.type === "ready")).toMatchObject({ voice: { voice: "kokoro" } });
  });

  it("reports an unavailable default model without constructing another engine", async () => {
    fake.failKitten = true;
    const p = await speechProcess();
    p.init();
    expect(p.sent()).toEqual([{ type: "error", reason: "load", message: expect.stringMatching(/Kitten failed/) }]);
    expect(fake.made).toEqual([]);
  });

  it("does not fall back to another neural engine when Kokoro and default Kitten both fail", async () => {
    fake.failKokoro = true; fake.failKitten = true;
    const p = await speechProcess();
    p.init({ natural: folder("kokoro-en-v0_19", ["model.onnx", "voices.bin", "tokens.txt"]) });
    expect(p.sent()).toEqual([{ type: "error", reason: "load", message: expect.stringMatching(/Kitten failed/) }]);
    expect(fake.made).toEqual([]);
  });

  it("says when the voice can't be loaded at all", async () => {
    const p = await speechProcess();
    const parentEmit = (process as unknown as { parentPort: EventEmitter }).parentPort;
    parentEmit.emit("message", { data: { type: "init", model: folder("empty", []) } });
    expect(p.sent()).toEqual([expect.objectContaining({ type: "error", reason: "load", message: expect.stringMatching(/Kitten voice is missing/) })]);
  });
});
