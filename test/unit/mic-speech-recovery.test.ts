/** The actual mic renderer wires recovery, cancellation and local-only voice selection together. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MicApi, SpeakRequest, SpeechAudio } from "../../app/shared/voice";
import type { PlayerSource } from "../../app/renderer/mic/player";

async function renderer(search = "") {
  vi.useFakeTimers();
  vi.resetModules();
  let speak!: (r: SpeakRequest) => void, hush!: (generation: number) => void;
  let audio!: (a: SpeechAudio) => void, done!: (id: number) => void;
  let changed!: () => void;
  const api: MicApi = {
    status: vi.fn(), speaking: vi.fn(), speech: vi.fn(), played: vi.fn(), level: vi.fn(),
    onSpeak: fn => { speak = fn; }, onDuck: () => undefined, onOutputWatch: () => undefined, outputBusy: () => undefined, onHush: fn => { hush = fn; },
    onAudio: fn => { audio = fn; }, onAudioDone: fn => { done = fn; }, onLevelOn: vi.fn(),
  };
  const local = { name: "Local", lang: "en-US", localService: true, default: false };
  const synth = { getVoices: vi.fn(() => [local]), speak: vi.fn(), cancel: vi.fn(), addEventListener: (_name: string, fn: () => void) => { changed = fn; } };
  const sources: PlayerSource[] = [];
  const addEventListener = vi.fn(), getUserMedia = vi.fn().mockRejectedValue(new Error("No audio source in this test"));
  vi.stubGlobal("window", { emberMic: api, addEventListener });
  vi.stubGlobal("navigator", { language: "en-US", mediaDevices: { getUserMedia, addEventListener: vi.fn() } });
  vi.stubGlobal("location", { search });
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
  const startCapture = () => addEventListener.mock.calls.find(([name]) => name === "message")![1]({ data: "ember-voice-port", ports: [{}] });
  return { api, synth, local, sources, speak, hush: (generation = 0) => hush(generation), audio, done, changed, startCapture, getUserMedia };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("mic renderer speech recovery", () => {
  it.each([["", true], ["?testMicWav=1", false]] as const)("keeps echo cancellation on except for synthetic WAV capture (%s)", async (search, echoCancellation) => {
    const r = await renderer(search);
    r.startCapture();
    expect(r.getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: { echoCancellation, noiseSuppression: false, autoGainControl: false, channelCount: 1 }, video: false });
  });

  it("tags playback and ignores a retired system utterance's late completion (review turn ownership)", async () => {
    const r = await renderer();
    r.hush(1);
    r.speak({ text: "Old answer." });
    const old = r.synth.speak.mock.calls[0][0];
    old.onstart();
    expect(r.api.speaking).toHaveBeenLastCalledWith(true, 1);
    r.hush(2);
    r.speak({ text: "New answer." });
    const current = r.synth.speak.mock.calls[1][0];
    current.onstart();
    old.onend();
    old.onerror({ error: "cancelled" });
    expect(r.api.speaking).toHaveBeenLastCalledWith(true, 2);
    current.onend();
    expect(r.api.speaking).toHaveBeenLastCalledWith(false, 2);
  });

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

  it("starts watching a queued system reply only when the previous one ends", async () => {
    const r = await renderer();
    r.speak({ text: "A long first reply." });
    const first = r.synth.speak.mock.calls[0][0];
    first.onstart();
    r.speak({ text: "The queued second reply.", append: true });
    const second = r.synth.speak.mock.calls[1][0];
    vi.advanceTimersByTime(10_000);
    expect(r.api.speech).not.toHaveBeenCalledWith(false);
    first.onend();
    vi.advanceTimersByTime(7900);
    expect(r.api.speech).not.toHaveBeenCalledWith(false);
    vi.advanceTimersByTime(200);
    expect(r.api.speech).toHaveBeenLastCalledWith(false);
    expect(r.api.speaking).toHaveBeenLastCalledWith(false, 0);
    second.onstart();
    expect(r.api.speech).toHaveBeenLastCalledWith(true);
    r.hush();
  });

  it("cancels a head reply's startup watch when the system queue is hushed", async () => {
    const r = await renderer();
    r.speak({ text: "First cancelled reply." });
    r.speak({ text: "Second cancelled reply.", append: true });
    r.hush(1);
    vi.advanceTimersByTime(10_000);
    expect(r.api.speech).not.toHaveBeenCalled();
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
