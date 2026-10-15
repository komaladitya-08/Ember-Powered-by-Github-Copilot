/**
 * The real recognizers (sherpa-onnx WASM) on synthesized speech. Needs the
 * models and clips from `node scripts/voice/prepare.mjs` (skipped otherwise;
 * EMBER_VOICE_TEST=1 requires them).
 */

import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { VoiceEngine, type VoiceEvent } from "../../app/voice/engine";
import { sherpaBackend } from "../../app/voice/sherpa";
import { modelPaths, modelsReady } from "../../app/voice/models";

const dir = path.resolve(process.env.EMBER_VOICE_DIR ?? ".cache/voice");
const ready = modelsReady(path.join(dir, "models")) && fs.existsSync(path.join(dir, "clips", "wake.wav"));
const sherpa = createRequire(import.meta.url)("sherpa-onnx");

describe.skipIf(!ready && process.env.EMBER_VOICE_TEST !== "1")("voice on real models", () => {
  let backend: ReturnType<typeof sherpaBackend>;
  beforeAll(() => { backend = sherpaBackend(modelPaths(path.join(dir, "models")), { monitor: true }); }, 60_000);

  /** Plays a clip through the engine in 32 ms frames, like the microphone would, with real time. */
  const play = (name: string, opts: { monitor?: boolean; followUp?: boolean } = {}) => {
    const { samples } = sherpa.readWave(path.join(dir, "clips", `${name}.wav`));
    const events: VoiceEvent[] = [];
    let t = 0;
    const engine = new VoiceEngine(backend, e => { if (e.type !== "level" && e.type !== "speech") events.push(e); }, { now: () => t });
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
    return { events, rtf: cpu / (all.length / 16) };
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

  it("ignores similar words and ordinary speech", () => {
    for (const name of ["amber", "remember", "chat"]) {
      expect(play(name).events.filter(e => e.type === "wake"), name).toEqual([]);
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
