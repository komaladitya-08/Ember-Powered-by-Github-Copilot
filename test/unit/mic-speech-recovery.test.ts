/** The actual mic renderer wires recovery, cancellation and local-only voice selection together. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MicApi, SpeakRequest, SpeechAudio } from "../../app/shared/voice";
import type { PlayerSource } from "../../app/renderer/mic/player";

async function renderer() {
  vi.useFakeTimers();
  vi.resetModules();
  let speak!: (r: SpeakRequest) => void, hush!: () => void;
  let audio!: (a: SpeechAudio) => void, done!: (id: number) => void;
  let changed!: () => void;
  const api: MicApi = {
    status: vi.fn(), speaking: vi.fn(), speech: vi.fn(), played: vi.fn(), level: vi.fn(),
    onSpeak: fn => { speak = fn; }, onHush: fn => { hush = fn; },
    onAudio: fn => { audio = fn; }, onAudioDone: fn => { done = fn; }, onLevelOn: vi.fn(),
  };
  const local = { name: "Local", lang: "en-US", localService: true, default: false };
  const synth = { getVoices: vi.fn(() => [local]), speak: vi.fn(), cancel: vi.fn(), addEventListener: (_name: string, fn: () => void) => { changed = fn; } };
  const sources: PlayerSource[] = [];
  vi.stubGlobal("window", { emberMic: api, addEventListener: vi.fn() });
  vi.stubGlobal("navigator", { language: "en-US" });
  vi.stubGlobal("location", { search: "" });
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("SpeechSynthesisUtterance", class { constructor(public text: string) {} });
  vi.stubGlobal("AudioContext", class {
    state = "running"; currentTime = 0; destination = {};
    createBuffer() { return { duration: 1, copyToChannel() {} }; }
    createBufferSource() {
      const s: PlayerSource = { buffer: null, onended: null, connect() {}, start() {}, stop: vi.fn() };
      sources.push(s); return s;
    }
  });
  await import("../../app/renderer/mic/main");
  return { api, synth, local, sources, speak, hush, audio, done, changed };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("mic renderer speech recovery", () => {
  it("drains PCM before submitting suffix and next reply to explicitly local synthesis", async () => {
    const r = await renderer();
    r.audio({ id: 1, samples: new Float32Array(10), rate: 10 });
    r.done(1);
    r.speak({ text: "Suffix.", append: true });
    r.speak({ text: "Next reply.", append: true });
    expect(r.synth.speak).not.toHaveBeenCalled();
    r.sources[0].onended?.();
    expect(r.synth.speak.mock.calls.map(([u]) => [u.text, u.voice])).toEqual([["Suffix.", r.local], ["Next reply.", r.local]]);
    r.hush();
  });

  it("recovers without PCM and never uses an online default while local voices load", async () => {
    const r = await renderer();
    r.synth.getVoices.mockReturnValue([{ ...r.local, localService: false, default: true }]);
    r.done(1); r.speak({ text: "Whole reply.", append: true });
    expect(r.synth.speak).not.toHaveBeenCalled();
    r.synth.getVoices.mockReturnValue([r.local]); r.changed();
    expect(r.synth.speak).toHaveBeenCalledWith(expect.objectContaining({ text: "Whole reply.", voice: r.local }));
    r.hush();
  });

  it("hush cancels delayed voices and a replacement stops PCM before speaking", async () => {
    const r = await renderer();
    r.synth.getVoices.mockReturnValue([]);
    r.speak({ text: "Cancelled." }); r.hush();
    r.synth.getVoices.mockReturnValue([r.local]); r.changed();
    vi.advanceTimersByTime(3000);
    expect(r.synth.speak).not.toHaveBeenCalled();
    expect(r.api.speech).not.toHaveBeenCalledWith(false);
    r.audio({ id: 2, samples: new Float32Array(10), rate: 10 });
    r.speak({ text: "Obsolete suffix.", append: true });
    r.speak({ text: "Replacement." });
    expect(r.sources[0].stop).toHaveBeenCalledOnce();
    expect(r.synth.speak.mock.calls.map(([u]) => u.text)).toEqual(["Replacement."]);
    r.hush();
  });

  it("clears a missing-local-voice warning after a previously working system voice returns", async () => {
    const r = await renderer();
    r.speak({ text: "Before." }); r.synth.speak.mock.calls[0][0].onstart();
    r.synth.getVoices.mockReturnValue([]); r.speak({ text: "Unavailable." });
    vi.advanceTimersByTime(3000);
    expect(r.api.speech).toHaveBeenLastCalledWith(false);
    r.synth.getVoices.mockReturnValue([r.local]); r.speak({ text: "After." });
    r.synth.speak.mock.calls[1][0].onstart();
    expect(r.api.speech).toHaveBeenLastCalledWith(true);
    r.hush();
  });

  it("reports unavailable rather than submitting an unrestricted utterance", async () => {
    const r = await renderer(); r.synth.getVoices.mockReturnValue([]);
    r.speak({ text: "Private words." });
    vi.advanceTimersByTime(3000);
    expect(r.api.speech).toHaveBeenCalledWith(false);
    expect(r.synth.speak).not.toHaveBeenCalled();
    r.synth.getVoices.mockReturnValue([r.local]); r.changed();
    expect(r.synth.speak).not.toHaveBeenCalled();
  });
});
