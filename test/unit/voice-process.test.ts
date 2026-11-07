/**
 * The voice utility process (app/voice/process.ts) with a stand-in for Electron's parent port and the recognizers:
 * what it tells main when the recognizers fail on some audio or can't load.
 */

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodePrint } from "../../app/voice/voiceprint";
import type { VoiceBackend } from "../../app/voice/engine";

const sherpa = vi.hoisted(() => ({ make: null as null | ((o: { onError?: (err: unknown) => void; runtime?: { prefer?: string } }) => VoiceBackend), ModelLoadError: class extends Error {} }));
vi.mock("../../app/voice/sherpa", () => ({ sherpaBackend: (_models: unknown, o: { onError?: (err: unknown) => void }) => sherpa.make!(o), ModelLoadError: sherpa.ModelLoadError }));

const workers = vi.hoisted(() => ({ instances: [] as { emit: (event: string, value: unknown) => boolean; postMessage: ReturnType<typeof vi.fn> }[] }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return { Worker: class extends EventEmitter {
    postMessage = vi.fn();
    constructor() { super(); workers.instances.push(this); }
    terminate() { return Promise.resolve(0); }
  } };
});
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/** A backend that hears nothing, unless `spot` is told otherwise. */
function quiet(over: Partial<VoiceBackend> = {}): VoiceBackend {
  return { spot: () => [], vad: () => [], speaking: () => false, flushVad: () => [], resetVad: () => undefined, transcribe: () => "", ...over };
}

/** A fresh voice process on a fake parent port; `backend` stands in for the recognizers (it may throw, as loading can). */
async function voiceProcess(backend: (o: { onError?: (err: unknown) => void; runtime?: { prefer?: string } }) => VoiceBackend) {
  vi.resetModules();
  workers.instances.length = 0;
  const parent = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  (process as unknown as { parentPort: unknown }).parentPort = parent;
  sherpa.make = backend;
  await import("../../app/voice/process");
  const port = Object.assign(new EventEmitter(), { start: vi.fn() });
  return {
    init: (o: { wasm?: boolean; voiceprint?: string } = {}) => parent.emit("message", { data: { type: "init", generation: 0, models: { kws: "k", vad: "v", asr: "a" }, monitor: false, dev: false, ...o }, ports: [port] }),
    message: (data: unknown) => parent.emit("message", { data }),
    frame: (f = new Float32Array(512).fill(0.01)) => port.emit("message", { data: f }),
    sent: () => parent.postMessage.mock.calls.map(c => c[0] as { type: string }),
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("the voice process", () => {
  for (const change of ["cancel", "voiceprint", "enrol"] as const) {
    it(`revokes in-flight inference when main sends ${change} (SR-1, SR-2)`, async () => {
      vi.useFakeTimers();
      const owner = new Float32Array(256); owner[0] = 1;
      let next = true;
      const p = await voiceProcess(() => quiet({ vad: () => next ? (next = false, [new Float32Array(32_000).fill(0.1)]) : [], transcribe: () => "Open the calendar." }));
      p.init({ voiceprint: encodePrint(owner) });
      p.message({ type: "follow-up", ms: 8000 });
      p.frame();
      const worker = workers.instances[0];
      expect(worker).toBeDefined();
      const print = worker.postMessage.mock.calls.find(c => c[0].type === "print")![0];
      p.message({ type: change, generation: 1, print: null });
      vi.advanceTimersByTime(1100);
      worker.emit("message", { id: print.id, print: owner });
      await flush();
      expect(p.sent().filter(m => m.type === "utterance" || m.type === "voice-sample")).toEqual([]);
    });
  }

  it("revokes an asynchronous learning sample when Stop arrives after the request was sent (SR-1)", async () => {
    vi.useFakeTimers();
    const owner = new Float32Array(256); owner[0] = 1;
    let next = true;
    const p = await voiceProcess(() => quiet({ vad: () => next ? (next = false, [new Float32Array(64_000).fill(0.1)]) : [], transcribe: () => "Open the calendar." }));
    p.init({ voiceprint: encodePrint(owner) });
    p.message({ type: "learning", on: true });
    p.message({ type: "follow-up", ms: 8000 });
    p.frame();
    const worker = workers.instances[0];
    const prints = () => worker.postMessage.mock.calls.filter(c => c[0].type === "print").map(c => c[0] as { id: number });
    worker.emit("message", { id: prints()[0].id, print: owner });
    await flush();
    expect(p.sent().filter(m => m.type === "utterance")).toHaveLength(1);
    expect(prints()).toHaveLength(2); // first half of the learning sample is still being checked
    p.message({ type: "cancel", generation: 1 });
    worker.emit("message", { id: prints()[1].id, print: owner });
    await flush();
    worker.emit("message", { id: prints()[2].id, print: owner });
    await flush();
    expect(p.sent().filter(m => m.type === "voice-sample")).toEqual([]);
  });

  it("carries on when the recognizers fail on some audio, and tells main (at most once a minute) (review #253)", async () => {
    vi.useFakeTimers();
    let fail = true;
    // WebAssembly throws bare numbers.
    const p = await voiceProcess(() => quiet({ spot: () => { if (fail) throw 92691224; return []; } }));
    p.init();
    expect(p.sent()[0]).toMatchObject({ type: "ready" });
    expect(() => { p.frame(); p.frame(); }).not.toThrow();
    expect(p.sent().filter(m => m.type === "engine-error")).toEqual([{ type: "engine-error", message: "the speech recognizer failed (92691224)", count: 1 }]);
    fail = false;
    p.frame();
    vi.advanceTimersByTime(61_000);
    fail = true;
    p.frame();
    expect(p.sent().filter(m => m.type === "engine-error").at(-1)).toEqual({ type: "engine-error", message: "the speech recognizer failed (92691224)", count: 2 });
  });

  it("says the recognizers are broken, once, when they keep failing (more than 20 times in 10 s), and stops feeding them (review #253)", async () => {
    vi.useFakeTimers();
    let calls = 0;
    // A WebAssembly abort leaves the module unusable: every frame fails from then on.
    const p = await voiceProcess(() => quiet({ spot: () => { calls++; throw 93407216; } }));
    p.init();
    for (let i = 0; i < 20; i++) p.frame();
    expect(p.sent().filter(m => m.type === "engine-broken")).toEqual([]);
    p.frame();
    expect(p.sent().filter(m => m.type === "engine-broken")).toEqual([{ type: "engine-broken", message: "the speech recognizer failed (93407216)" }]);
    const before = calls;
    for (let i = 0; i < 50; i++) p.frame();
    expect(p.sent().filter(m => m.type === "engine-broken")).toHaveLength(1);
    expect(calls).toBe(before);
  });

  it("isn't broken by failures spread out over time (review #253)", async () => {
    vi.useFakeTimers();
    const p = await voiceProcess(() => quiet({ spot: () => { throw 93407216; } }));
    p.init();
    for (let i = 0; i < 60; i++) { p.frame(); vi.advanceTimersByTime(600); }
    expect(p.sent().filter(m => m.type === "engine-broken")).toEqual([]);
  });

  it("reports a failure the recognizer caught itself (the audio is heard as nothing) (review #253)", async () => {
    let report: ((err: unknown) => void) | undefined;
    const p = await voiceProcess(o => { report = o.onError; return quiet(); });
    p.init();
    report?.(new Error("Invalid input shape"));
    expect(p.sent().filter(m => m.type === "engine-error")).toEqual([{ type: "engine-error", message: "Invalid input shape", count: 1 }]);
  });

  it("says the speech models couldn't be loaded, not a bare number, when loading throws one (review #254)", async () => {
    const p = await voiceProcess(() => { throw 37825408; });
    p.init();
    expect(p.sent()).toEqual([{ type: "error", message: "The speech models couldn't be loaded.", models: true }]);
  });

  it("tells main when a model file is missing or damaged, so it can offer the download again (review #254)", async () => {
    const p = await voiceProcess(() => { throw new sherpa.ModelLoadError("The speech recognition model couldn't be loaded."); });
    p.init();
    expect(p.sent()).toEqual([{ type: "error", message: "The speech recognition model couldn't be loaded.", models: true, model: "asr" }]);
  });

  it("names the damaged model, so main forgets only that one", async () => {
    for (const [what, model] of [["wake word model", "kws"], ["voice activity model", "vad"]]) {
      const p = await voiceProcess(() => { throw new sherpa.ModelLoadError(`The ${what} couldn't be loaded.`); });
      p.init();
      expect(p.sent()[0]).toEqual({ type: "error", message: `The ${what} couldn't be loaded.`, models: true, model });
    }
  });

  it("says it's alive every second once started, so main can tell a frozen process from a quiet room (review #257)", async () => {
    vi.useFakeTimers();
    const p = await voiceProcess(() => quiet());
    p.init();
    vi.advanceTimersByTime(3000);
    expect(p.sent().filter(m => m.type === "alive")).toHaveLength(3);
  });

  it("tells main when the microphone sends only digital silence for a minute, and when sound comes back (review #255)", async () => {
    const p = await voiceProcess(() => quiet());
    p.init();
    const zeros = new Float32Array(512);
    for (let i = 0; i < 1874; i++) p.frame(zeros); // just under 60 s
    expect(p.sent().filter(m => m.type === "silent")).toEqual([]);
    p.frame(zeros);
    p.frame(zeros);
    expect(p.sent().filter(m => m.type === "silent")).toEqual([{ type: "silent", on: true }]);
    p.frame(new Float32Array(512).fill(0.0001)); // even a quiet room's noise is sound
    expect(p.sent().filter(m => m.type === "silent")).toEqual([{ type: "silent", on: true }, { type: "silent", on: false }]);
  });

  describe("while Ember learns a voice (Voice Match)", () => {
    const relevant = (p: { sent: () => { type: string }[] }) => p.sent().filter(m => !["alive", "stats", "ready"].includes(m.type));

    it("still hears “Ember, stop”: it stops everything and the teaching ends, saying why (voice-listening-v1)", async () => {
      vi.useFakeTimers();
      let spotted = 0;
      const p = await voiceProcess(() => quiet({ spot: () => { spotted++; return spotted === 30 ? ["ember_stop"] : []; }, transcribe: () => "Ember, stop." }));
      p.init();
      p.message({ type: "enrol", generation: 1 });
      for (let i = 0; i < 60; i++) { p.frame(); vi.advanceTimersByTime(32); }
      expect(spotted).toBeGreaterThan(0);
      expect(relevant(p)).toEqual([
        { type: "enrol", state: "listening", got: 0, of: 4 },
        { type: "enrol", state: "cancelled", got: 0, of: 4, why: "stopped" },
        { type: "stop", generation: 1 },
      ]);
    });

    it("takes no wake or request meanwhile: its phrases (“Hey Ember, open my calendar.”) aren't requests (voice-listening-v1)", async () => {
      vi.useFakeTimers();
      const p = await voiceProcess(() => quiet({ spot: () => ["hey_ember"], transcribe: () => "Hey Ember, open my calendar." }));
      p.init();
      p.message({ type: "enrol", generation: 1 });
      p.message({ type: "follow-up", ms: 8000 });
      for (let i = 0; i < 60; i++) { p.frame(); vi.advanceTimersByTime(32); }
      expect(relevant(p)).toEqual([{ type: "enrol", state: "listening", got: 0, of: 4 }]);
    });

    it("ends the teaching as stopped when the kill switch stops listening (voice-listening-v1)", async () => {
      const p = await voiceProcess(() => quiet());
      p.init();
      p.message({ type: "enrol", generation: 1 });
      p.message({ type: "enrol-cancel", why: "stopped" });
      expect(relevant(p).at(-1)).toEqual({ type: "enrol", state: "cancelled", got: 0, of: 4, why: "stopped" });
    });

    it("hears wakes again once the teaching is over", async () => {
      vi.useFakeTimers();
      let wake = false;
      const p = await voiceProcess(() => quiet({ spot: () => wake ? ["hey_ember"] : [], transcribe: () => "Hey Ember." }));
      p.init();
      p.message({ type: "enrol", generation: 1 });
      p.message({ type: "enrol-cancel" });
      wake = true;
      for (let i = 0; i < 10; i++) { p.frame(); vi.advanceTimersByTime(32); }
      expect(relevant(p).map(m => m.type)).toContain("wake");
    });
  });

  it("passes on other errors at start as they are", async () => {
    const p = await voiceProcess(() => { throw new Error("Cannot find module 'sherpa-onnx'"); });
    p.init();
    expect(p.sent()).toEqual([{ type: "error", message: "Cannot find module 'sherpa-onnx'" }]);
  });

  it("tells main which build runs the recognizers, and runs WebAssembly when told to (a process before died loading natively)", async () => {
    const info = { backend: "native", detail: "sherpa-onnx 1.13.8", provider: "cpu", threads: 2, tried: [{ provider: "cpu" }] };
    const asked: (string | undefined)[] = [];
    let p = await voiceProcess(o => { asked.push(o.runtime?.prefer); return Object.assign(quiet(), { info }); });
    p.init();
    expect(p.sent()[0]).toMatchObject({ type: "ready", backend: info });
    p = await voiceProcess(o => { asked.push(o.runtime?.prefer); return Object.assign(quiet(), { info: { ...info, backend: "wasm" } }); });
    p.init({ wasm: true });
    expect(asked).toEqual([undefined, "wasm"]);
  });
});
