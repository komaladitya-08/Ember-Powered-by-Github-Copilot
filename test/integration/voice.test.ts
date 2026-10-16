/**
 * The real recognizers (sherpa-onnx WASM) on synthesized speech: the clips in
 * test/fixtures/voice. Needs the models from `node scripts/voice/prepare.mjs`
 * (skipped otherwise; EMBER_VOICE_TEST=1 requires them).
 */

import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { VoiceEngine, type VoiceEvent } from "../../app/voice/engine";
import { sherpaBackend } from "../../app/voice/sherpa";
import { modelPaths, modelsReady } from "../../app/voice/models";

const dir = path.resolve(process.env.EMBER_VOICE_DIR ?? ".cache/voice");
const clips = path.resolve("test/fixtures/voice");
const ready = modelsReady(path.join(dir, "models")) && fs.existsSync(path.join(clips, "wake.wav"));
const sherpa = createRequire(import.meta.url)("sherpa-onnx");

// Real recognizers on a loaded CI machine: a clip can take several seconds, so each test gets 20.
describe.skipIf(!ready && process.env.EMBER_VOICE_TEST !== "1")("voice on real models", { timeout: 20_000 }, () => {
  let backend: ReturnType<typeof sherpaBackend>;
  beforeAll(() => { backend = sherpaBackend(modelPaths(path.join(dir, "models")), { monitor: true }); }, 60_000);

  const read = (name: string): Float32Array => sherpa.readWave(path.join(clips, `${name}.wav`)).samples;
  /** Plays a clip (or audio) through the engine in 32 ms frames, like the microphone would, with real time; `at`: when each event came (ms). */
  const play = (clip: string | Float32Array, opts: { monitor?: boolean; followUp?: boolean } = {}) => {
    const samples = typeof clip === "string" ? read(clip) : clip;
    const events: VoiceEvent[] = [];
    const at: number[] = [];
    let t = 0;
    const engine = new VoiceEngine(backend, e => { if (e.type !== "speech") { events.push(e); at.push(t); } }, { now: () => t });
    if (opts.followUp) engine.followUp(8000);
    const tail = new Float32Array(16000 * 2);
    const all = new Float32Array(samples.length + tail.length);
    all.set(samples);
    let cpu = 0;
    for (let i = 0; i + 512 <= all.length; i += 512) {
      const f = all.subarray(i, i + 512);
      const t0 = performance.now();
      if (opts.monitor) engine.feedMonitor(f);
      engine.feed(f);
      cpu += performance.now() - t0;
      t += 32;
    }
    backend.resetVad();
    return { events, at, rtf: cpu / (all.length / 16) };
  };

  it("wakes on 'Hey Ember' and hears the request in the same breath", () => {
    const { events, rtf } = play("wake");
    expect(events.map(e => e.type)).toEqual(["wake", "listening", "utterance", "listening"]);
    expect(events.find(e => e.type === "utterance")).toMatchObject({ text: expect.stringMatching(/^Turn on night ?light\.?$/i) });
    expect(rtf).toBeLessThan(1);
  });

  it("waits for the request after a pause", () => {
    const { events } = play("wake_pause");
    expect(events.find(e => e.type === "utterance")).toMatchObject({ text: expect.stringMatching(/make the text bigger/i) });
  });

  it("stops on 'Ember stop'", () => {
    expect(play("stop").events).toContainEqual({ type: "stop" });
  });

  it("doesn't stop on 'Ember, stop' that comes out of the speakers", () => {
    const { events } = play("stop", { monitor: true });
    expect(events).not.toContainEqual({ type: "stop" });
    expect(events).toContainEqual({ type: "rejected", keyword: "ember_stop", reason: "speakers" });
  });

  it("ends a request when the speaker does, though someone keeps talking in the background", () => {
    // Another voice 14 dB down (the test clips' other lines, back to back) starts with the request and goes on for 20 s.
    const trim = (s: Float32Array) => { let a = 0, b = s.length; while (a < b && Math.abs(s[a]) < 0.01) a++; while (b > a && Math.abs(s[b - 1]) < 0.01) b--; return s.subarray(a, b); };
    const talk = ["chat", "remember", "bigger", "followup", "amber"].map(n => trim(read(n)));
    const wake = read("wake"), lead = 16000;
    const audio = new Float32Array(lead + 22 * 16000);
    for (let at = lead + 8000, k = 0; at < audio.length; k++) {
      const s = talk[k % talk.length];
      for (let i = 0; i < s.length && at + i < audio.length; i++) audio[at + i] += s[i] * 0.2;
      at += s.length + 2400;
    }
    audio.set(wake.map((x, i) => x + audio[lead + i]), lead);
    const { events, at } = play(audio);
    const sent = events.findIndex(e => e.type === "utterance");
    expect(events[sent]).toMatchObject({ text: expect.stringMatching(/night ?light/i) });
    expect((events[sent] as { text: string }).text.length).toBeLessThan(60);
    let end = wake.length;
    while (end > 0 && Math.abs(wake[end - 1]) < 0.01) end--;
    expect(at[sent] / 1000 - (lead + end) / 16000).toBeLessThan(2.5); // not when the talk pauses (20 s on)
  });

  it("ignores similar words and ordinary speech", () => {
    for (const name of ["amber", "remember", "chat"]) {
      const { events } = play(name);
      // A near-miss may light Ember up for a moment, but the check takes it back: no request is taken.
      expect(events.filter(e => e.type === "utterance"), name).toEqual([]);
      expect(events.filter(e => e.type === "rejected" && e.reason === "check").length, name).toBeGreaterThanOrEqual(events.filter(e => e.type === "wake").length);
    }
  });

  it("takes a follow-up without the wake word", () => {
    const { events } = play("followup", { followUp: true });
    expect(events.find(e => e.type === "utterance")).toMatchObject({ text: expect.stringMatching(/do not disturb/i) });
  });

  it("rejects 'Hey Ember' that comes out of the speakers", () => {
    const { events } = play("wake", { monitor: true });
    expect(events.filter(e => e.type === "wake")).toEqual([]);
    expect(events).toContainEqual({ type: "rejected", keyword: "hey_ember", reason: "speakers" });
  });
});
