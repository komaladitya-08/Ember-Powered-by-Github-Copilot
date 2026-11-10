/**
 * A wake checked mid-word must be judged again from the finished phrase, while the
 * full-phrase name and near-miss guards still decide what may become a request.
 */
import path from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VoiceEngine, type VoiceEvent } from "../../app/voice/engine";
import { modelPaths, modelsReady } from "../../app/voice/models";
import { sherpaBackend } from "../../app/voice/sherpa";

const dir = path.resolve(process.env.EMBER_VOICE_DIR ?? ".cache/voice");
const ready = modelsReady(path.join(dir, "models"));
const clips = path.resolve("test/fixtures/voice");
const sherpa = createRequire(import.meta.url)("sherpa-onnx");
const capiDir = process.env.EMBER_SHERPA_CAPI ? path.resolve(process.env.EMBER_SHERPA_CAPI) : undefined;

describe.skipIf(!ready && process.env.EMBER_VOICE_TEST !== "1")("a wake checked before the question finishes", { timeout: 120_000 }, () => {
  let backend: ReturnType<typeof sherpaBackend>;
  beforeAll(() => {
    backend = sherpaBackend(modelPaths(path.join(dir, "models")), { monitor: true, ...(capiDir ? { runtime: { capiDir } } : {}) });
    if (capiDir) expect(backend.info.backend).toBe("native");
  }, 60_000);
  afterAll(() => backend?.free());

  const play = (name: string) => {
    const samples: Float32Array = sherpa.readWave(path.join(clips, name + ".wav")).samples;
    const all = new Float32Array(samples.length + 32_000);
    all.set(samples);
    const events: VoiceEvent[] = [];
    let at = 0;
    const engine = new VoiceEngine(backend, e => { if (e.type !== "speech") events.push(e); }, { now: () => at });
    const silence = new Float32Array(512);
    for (let i = 0; i + 512 <= all.length; i += 512) {
      engine.feedMonitor(silence);
      engine.feed(all.subarray(i, i + 512));
      at += 32;
    }
    backend.resetVad();
    return events;
  };

  it.each(["wake_question", "wake_question_repeat"])("hears the finished question despite an ambiguous partial check (%s, listening-ci-r7-1)", name => {
    const events = play(name);
    expect(events.filter(e => e.type === "rejected" && e.reason === "check")).toEqual([]);
    expect(events.filter(e => e.type === "utterance")).toEqual([
      expect.objectContaining({ text: expect.stringMatching(/^What's on my screen\?$/i), window: "wake" }),
    ]);
  });

  it.each(["amber", "remember", "chat", "bigger", "followup", "embers"])("never turns an unchanged negative clip into a request (%s, listening-ci-r7-1)", name => {
    const events = play(name);
    expect(events.filter(e => e.type === "utterance")).toEqual([]);
    expect(events.filter(e => e.type === "wake").length).toBeLessThanOrEqual(events.filter(e => e.type === "rejected" && e.reason === "check").length);
  });
});
