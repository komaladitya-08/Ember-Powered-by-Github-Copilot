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
  cost: { vits: 0.05, kokoro: 0.3 } as Record<string, number>,
  failKokoro: false,
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
          if (spec.kind === "kokoro" && (fake.failKokoro || backend === "wasm")) throw new Error("Kokoro failed");
          fake.made.push({ kind: spec.kind, provider: run.provider, numThreads: run.numThreads });
          return {
            sampleRate: spec.kind === "kokoro" ? 24_000 : 22_050, numSpeakers: 1, free() {},
            generate: ({ text }) => {
              const seconds = text.length / 15, rate = spec.kind === "kokoro" ? 24_000 : 22_050;
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
    init: (o: { natural?: string | null; wasm?: boolean } = {}) => parent.emit("message", { data: { type: "init", model: folder("vits-piper-en_US-kristin-medium", ["en_US-kristin-medium.onnx", "tokens.txt"]), ...o } }),
    sent: () => parent.postMessage.mock.calls.map(c => c[0] as { type: string; voice?: Record<string, unknown>; rate?: number }),
  };
}

beforeEach(() => {
  fake.backend = "native"; fake.cost = { vits: 0.05, kokoro: 0.3 }; fake.failKokoro = false; fake.made = []; fake.clock = 0;
  fake.providers = ["cpu"]; fake.speedup = { cpu: 1, coreml: 1 };
  vi.spyOn(performance, "now").mockImplementation(() => fake.clock);
});
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); dirs = []; });

describe("Ember's voice process", () => {
  it("speaks in the Piper voice natively, on two threads at most, timed (main decides from it whether to fetch Kokoro)", async () => {
    const p = await speechProcess();
    p.init();
    const ready = p.sent().find(m => m.type === "ready")!;
    expect(ready).toMatchObject({ rate: 22_050, voice: { voice: "piper", backend: "native", provider: "cpu", rtf: 0.05 } });
    expect(ready.voice).not.toHaveProperty("natural");
    expect(fake.made[0].numThreads).toBeLessThanOrEqual(2);
  });

  it("speaks in Kokoro when it is downloaded and fast enough here (its speaker: af_bella in v0.19)", async () => {
    const p = await speechProcess();
    p.init({ natural: folder("kokoro-en-v0_19", ["model.onnx", "voices.bin", "tokens.txt"]) });
    expect(p.sent().find(m => m.type === "ready")).toMatchObject({ rate: 24_000, voice: { voice: "kokoro", backend: "native", rtf: 0.3 } });
    expect(fake.made.map(m => m.kind)).toEqual(["kokoro"]);
  });

  it("times CoreML against the CPU (macOS) and keeps the faster, saying what each took", async () => {
    fake.providers = ["coreml", "cpu"];
    fake.speedup = { coreml: 2, cpu: 1 };
    let p = await speechProcess();
    p.init();
    let ready = p.sent().find(m => m.type === "ready")!;
    expect(ready.voice).toMatchObject({ voice: "piper", provider: "coreml", tried: [{ provider: "coreml" }, { provider: "cpu" }] });
    fake.speedup = { coreml: 0.5, cpu: 1 };
    p = await speechProcess();
    p.init();
    ready = p.sent().find(m => m.type === "ready")!;
    expect(ready.voice).toMatchObject({ provider: "cpu" });
  });

  it("falls back to the Piper voice when Kokoro is too slow here, or doesn't load, saying why", async () => {
    fake.cost.kokoro = 0.9;
    let p = await speechProcess();
    p.init({ natural: folder("kokoro-en-v0_19", ["model.onnx", "voices.bin", "tokens.txt"]) });
    expect(p.sent().find(m => m.type === "ready")).toMatchObject({ voice: { voice: "piper", natural: "too slow here: 0.9 of real time (at most 0.5)" } });
    fake.failKokoro = true;
    p = await speechProcess();
    p.init({ natural: folder("kokoro-en-v0_19", ["model.onnx", "voices.bin", "tokens.txt"]) });
    expect(p.sent().find(m => m.type === "ready")).toMatchObject({ voice: { voice: "piper", natural: "it couldn't be loaded: Kokoro failed" } });
  });

  it("remembers that Kokoro is too slow here, so the next start doesn't load and time it again for a week (laptop: 8.0 s against 2.2 s)", async () => {
    fake.cost.kokoro = 0.9;
    const kokoro = folder("kokoro-multi-lang-v1_0", ["model.onnx", "voices.bin", "tokens.txt"]);
    let p = await speechProcess();
    p.init({ natural: kokoro });
    expect(fake.made.map(m => m.kind)).toEqual(["kokoro", "vits"]);
    fake.made = [];
    p = await speechProcess();
    p.init({ natural: kokoro });
    expect(fake.made.map(m => m.kind)).toEqual(["vits"]);
    expect(p.sent().find(m => m.type === "ready")).toMatchObject({ voice: { voice: "piper", natural: "too slow here: 0.9 of real time (at most 0.5; timed before)" } });
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 8 * 24 * 3_600_000);
    fake.made = [];
    fake.cost.kokoro = 0.3;
    p = await speechProcess();
    p.init({ natural: kokoro });
    expect(p.sent().find(m => m.type === "ready")).toMatchObject({ voice: { voice: "kokoro", rtf: 0.3 } });
  });

  it("runs the Piper voice in WebAssembly when told to (a process before died loading natively), untimed", async () => {
    const p = await speechProcess();
    p.init({ wasm: true, natural: folder("kokoro-en-v0_19", ["model.onnx", "voices.bin", "tokens.txt"]) });
    const ready = p.sent().find(m => m.type === "ready")!;
    expect(ready).toMatchObject({ voice: { voice: "piper", backend: "wasm", natural: "it needs the native build (WebAssembly asked for)" } });
    expect(ready.voice).not.toHaveProperty("rtf");
  });

  it("says when the voice can't be loaded at all", async () => {
    const p = await speechProcess();
    const parentEmit = (process as unknown as { parentPort: EventEmitter }).parentPort;
    parentEmit.emit("message", { data: { type: "init", model: folder("empty", []) } });
    expect(p.sent()).toEqual([expect.objectContaining({ type: "error", message: expect.stringMatching(/no voice model/) })]);
  });
});
