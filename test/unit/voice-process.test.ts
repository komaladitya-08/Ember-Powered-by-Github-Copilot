/**
 * The voice utility process (app/voice/process.ts) with a stand-in for Electron's parent port and the recognizers:
 * what it tells main when the recognizers fail on some audio or can't load.
 */

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceBackend } from "../../app/voice/engine";

const sherpa = vi.hoisted(() => ({ make: null as null | ((o: { onError?: (err: unknown) => void }) => VoiceBackend), ModelLoadError: class extends Error {} }));
vi.mock("../../app/voice/sherpa", () => ({ sherpaBackend: (_models: unknown, o: { onError?: (err: unknown) => void }) => sherpa.make!(o), ModelLoadError: sherpa.ModelLoadError }));

/** A backend that hears nothing, unless `spot` is told otherwise. */
function quiet(over: Partial<VoiceBackend> = {}): VoiceBackend {
  return { spot: () => [], vad: () => [], speaking: () => false, flushVad: () => [], resetVad: () => undefined, transcribe: () => "", ...over };
}

/** A fresh voice process on a fake parent port; `backend` stands in for the recognizers (it may throw, as loading can). */
async function voiceProcess(backend: (o: { onError?: (err: unknown) => void }) => VoiceBackend) {
  vi.resetModules();
  const parent = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  (process as unknown as { parentPort: unknown }).parentPort = parent;
  sherpa.make = backend;
  await import("../../app/voice/process");
  const port = Object.assign(new EventEmitter(), { start: vi.fn() });
  return {
    init: () => parent.emit("message", { data: { type: "init", models: { kws: "k", vad: "v", asr: "a" }, monitor: false, dev: false }, ports: [port] }),
    frame: (f = new Float32Array(512).fill(0.01)) => port.emit("message", { data: f }),
    sent: () => parent.postMessage.mock.calls.map(c => c[0] as { type: string }),
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("the voice process", () => {
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
    expect(p.sent()).toEqual([{ type: "error", message: "The speech recognition model couldn't be loaded.", models: true }]);
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

  it("passes on other errors at start as they are", async () => {
    const p = await voiceProcess(() => { throw new Error("Cannot find module 'sherpa-onnx'"); });
    p.init();
    expect(p.sent()).toEqual([{ type: "error", message: "Cannot find module 'sherpa-onnx'" }]);
  });
});
