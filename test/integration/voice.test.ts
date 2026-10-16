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

  const at = (seconds: number) => Math.round(seconds * 16000);
  const silence = (seconds: number) => new Float32Array(at(seconds));
  const cat = (...parts: Float32Array[]) => { const o = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
  const trimmed = (name: string) => { const s = read(name); let a = 0, b = s.length; while (a < b && Math.abs(s[a]) < 0.01) a++; while (b > a && Math.abs(s[b - 1]) < 0.01) b--; return s.subarray(a, b); };
  /** A quiet room's noise (white, 0.001 RMS) added, from a fixed seed. */
  const inRoom = (s: Float32Array) => { let seed = 5; return s.map(x => x + ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 0.001 / 0.2887); };
  /** One engine fed in turns (`hear`), with the speakers' stream when given, and what it said (`at`: when, in ms). */
  const session = () => {
    const events: (VoiceEvent & { at: number })[] = [];
    let t = 0;
    const engine = new VoiceEngine(backend, e => { if (e.type !== "speech") events.push({ ...e, at: t }); }, { now: () => t });
    const hear = (mic: Float32Array, o: { speakers?: Float32Array; onFrame?: (frame: number) => void } = {}) => {
      for (let i = 0, k = 0; i + 512 <= mic.length; i += 512, k++) {
        o.onFrame?.(k);
        if (o.speakers) engine.feedMonitor(o.speakers.slice(i, i + 512));
        engine.feed(mic.subarray(i, i + 512));
        t += 32;
      }
    };
    return { engine, events, hear, end: () => backend.resetVad() };
  };
  const sent = (events: VoiceEvent[]) => events.flatMap(e => (e.type === "utterance" ? [e] : []));

  it("doesn't cut a request at a pause in a quiet room (the speaker's own pauses are left to the VAD)", () => {
    // "Hey Ember, turn on… night light." "Hey Ember, turn on do not… disturb.": a pause spliced in at a word boundary.
    for (const [clip, split, last] of [["wake", 1.91, /light/i], ["dnd", 2.45, /disturb/i]] as const) {
      for (const pause of [0.3, 0.5]) {
        const s = read(clip), { events, hear, end } = session();
        hear(inRoom(cat(s.subarray(0, at(split)), silence(pause), s.subarray(at(split)), silence(2))));
        end();
        expect(sent(events).map(u => u.text), `${clip}, a ${pause} s pause`).toEqual([expect.stringMatching(last)]);
      }
    }
  });

  it("hears a follow-up in the voice that woke Ember, and not the room's talk", () => {
    // Someone else talking 14 dB down for 9 s after the answer: nothing is sent, and the window closes.
    const talk = cat(...["chat", "remember", "bigger", "chat"].flatMap(n => [trimmed(n).map(x => x * 0.2), silence(0.3)]));
    const room = session();
    room.hear(inRoom(cat(read("wake"), silence(1))));
    room.engine.followUp(8000);
    room.hear(inRoom(cat(talk, silence(1))));
    room.end();
    expect(sent(room.events)).toMatchObject([{ text: expect.stringMatching(/night ?light/i), window: "wake" }]);
    expect(room.events.at(-1)).toMatchObject({ type: "listening", on: false, reason: "timeout", window: "follow-up" });
    // The user's own follow-up is heard.
    const user = session();
    user.hear(inRoom(cat(read("wake"), silence(1))));
    user.engine.followUp(8000);
    user.hear(inRoom(cat(read("followup"), silence(1))));
    user.end();
    expect(sent(user.events)).toMatchObject([{ window: "wake" }, { text: expect.stringMatching(/do not disturb/i), window: "follow-up" }]);
  });

  it("stops on 'Hey Ember, stop' said while Ember speaks, and takes no wake then", () => {
    const heyStop = cat(read("wake_pause").subarray(0, at(1.52)), silence(0.1), read("stop").subarray(at(1.09)), silence(1));
    const stop = session();
    stop.engine.selfSpeaking(true);
    stop.hear(inRoom(heyStop));
    stop.end();
    expect(stop.events.filter(e => e.type === "stop")).toHaveLength(1);
    const wake = session();
    wake.engine.selfSpeaking(true);
    wake.hear(inRoom(cat(read("wake"), silence(1))));
    wake.end();
    expect(wake.events.filter(e => e.type !== "rejected")).toEqual([]);
  });

  it("keeps a reply that starts the moment Ember's voice ends (the microphone hears the speakers 64 ms late)", () => {
    const answer = cat(silence(0.5), trimmed("chat"), trimmed("remember")), reply = trimmed("followup"), lag = 1024;
    const speakers = cat(answer, silence(0.032), new Float32Array(reply.length + at(2)));
    const mic = new Float32Array(speakers.length);
    for (let i = 0; i < answer.length; i++) mic[i + lag] = answer[i] * 0.3; // the echo
    mic.set(reply, answer.length + lag);
    const s = session(), endFrame = Math.ceil(answer.length / 512);
    s.engine.selfSpeaking(true);
    s.hear(inRoom(mic), { speakers, onFrame: k => { if (k === endFrame) { s.engine.selfSpeaking(false); s.engine.followUp(8000); } } });
    s.end();
    expect(sent(s.events).map(u => u.text)).toEqual([expect.stringMatching(/^and turn on,? do not disturb/i)]);
  });

  it("takes a long request in a quiet room whole (over 10 s)", () => {
    const long = cat(...[read("wake").subarray(0, at(2.7)), trimmed("followup"), trimmed("chat"), trimmed("bigger"), trimmed("remember")].flatMap(p => [p, silence(0.25)]), silence(2));
    expect(long.length / 16000).toBeGreaterThan(12);
    const s = session();
    s.hear(inRoom(long));
    s.end();
    expect(sent(s.events)).toEqual([expect.objectContaining({ text: expect.stringMatching(/night ?light.*weather was nice/i), window: "wake" })]);
    expect(sent(s.events)[0]).not.toHaveProperty("cut");
  });
});
