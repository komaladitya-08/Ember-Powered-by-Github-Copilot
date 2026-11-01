/**
 * The real recognizers (sherpa-onnx WASM) on synthesized speech: the clips in
 * test/fixtures/voice. Needs the models from `node scripts/voice/prepare.mjs`
 * (skipped otherwise; EMBER_VOICE_TEST=1 requires them).
 */

import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { VoiceEngine, type VoiceEvent } from "../../app/voice/engine";
import { ModelLoadError, sherpaBackend } from "../../app/voice/sherpa";
import { modelPaths, modelsReady } from "../../app/voice/models";
import { Enrolment, VoiceGate, type EnrolState, type Printer } from "../../app/voice/match";
import { VOICE_MATCH_THRESHOLD, printFeatures, similarity, unit } from "../../app/voice/voiceprint";

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

  it("wakes on the bare name, 'Ember', and hears the request in the same breath", () => {
    const { events } = play("name_wake");
    expect(events.map(e => e.type)).toEqual(["wake", "listening", "utterance", "listening"]);
    expect(events[0]).toEqual({ type: "wake", keyword: "ember" });
    expect(events.find(e => e.type === "utterance")).toMatchObject({ text: expect.stringMatching(/^Turn on night ?light\.?$/i) });
  });

  it("shows no wake for the name inside other words ('the embers', 'I remember')", () => {
    for (const clip of ["embers", "remember"]) {
      const { events } = play(clip);
      expect(events.filter(e => e.type !== "rejected"), clip).toEqual([]);
    }
  });

  it("stops on 'Ember, stop' though the bare name is spotted first", () => {
    const { events } = play("stop");
    expect(events.filter(e => e.type === "stop")).toHaveLength(1);
    expect(events.filter(e => e.type === "utterance")).toEqual([]);
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
    // The spotter takes the bare name first in "Ember, stop" (see KEYWORDS): either is rejected as the speakers'.
    expect(events).toContainEqual({ type: "rejected", keyword: expect.stringMatching(/^ember(_stop)?$/), reason: "speakers" });
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

  it("hears a one-word reply in a follow-up (the VAD hears speech only 0.2 s into it)", () => {
    // "Bigger." alone, and "Stop!" 3 dB softer than the request: both were dropped before the recognizer.
    for (const [word, then] of [[trimmed("bigger").subarray(at(1.45)), "utterance"], [trimmed("stop").subarray(at(0.45)).map(x => x * 0.7), "stop"]] as const) {
      const s = session();
      s.hear(inRoom(cat(read("wake"), silence(1))));
      s.engine.followUp(8000);
      s.hear(inRoom(cat(silence(0.5), word, silence(2))));
      s.end();
      expect(s.events.filter(e => e.type === "utterance" || e.type === "stop").map(e => e.type), then).toEqual(["utterance", then]);
    }
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

  it("cuts in on Ember's answer when its speakers didn't say 'Hey Ember': Ember is hushed, and the request is heard (VO9-2)", () => {
    // Ember reads an answer (its echo in the microphone, 20 dB down); the user says "Hey Ember, turn on night light" over it.
    // Main hushes Ember on a wake: its speakers go quiet 150 ms later.
    const answer = cat(trimmed("chat"), silence(0.2), trimmed("remember"), silence(0.2), trimmed("chat")), wake = read("wake"), from = at(1.2);
    const speakers = cat(answer, silence(4)), voice = new Float32Array(speakers.length);
    voice.set(wake, from);
    const mic = inRoom(voice.map((x, i) => x + speakers[i] * 0.1));
    const s = session();
    let hushAt = -1;
    s.engine.selfSpeaking(true);
    s.hear(mic, {
      speakers,
      onFrame: k => {
        if (hushAt < 0 && s.events.some(e => e.type === "wake")) hushAt = k + 5;
        if (k === hushAt) { speakers.fill(0, k * 512); for (let i = k * 512; i < mic.length; i++) mic[i] -= speakers[i]; s.engine.selfSpeaking(false); }
      },
    });
    s.end();
    expect(s.events.filter(e => e.type === "wake")).toHaveLength(1);
    expect(sent(s.events)).toMatchObject([{ text: expect.stringMatching(/night ?light/i), window: "wake" }]);
  });

  it("hears nothing in under 0.1 s of audio instead of failing (the recognizer throws a bare number on it, review #253)", () => {
    for (const n of [0, 800, 1599]) expect(backend.transcribe(new Float32Array(n))).toBe("");
  });

  it("fails to load, with a ModelLoadError, when a model file is cut short or missing (review #254)", () => {
    const models = modelPaths(path.join(dir, "models"));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ember-damaged-"));
    try {
      // The recognition model's folder, its encoder cut to 1000 bytes (as an antivirus or a disk error leaves it), then gone.
      const asr = path.join(tmp, "asr");
      fs.mkdirSync(asr);
      for (const f of fs.readdirSync(models.asr)) if (f !== "encoder_model.ort") fs.symlinkSync(path.join(models.asr, f), path.join(asr, f));
      fs.writeFileSync(path.join(asr, "encoder_model.ort"), fs.readFileSync(path.join(models.asr, "encoder_model.ort")).subarray(0, 1000));
      expect(() => sherpaBackend({ ...models, asr })).toThrow(ModelLoadError);
      fs.rmSync(path.join(asr, "encoder_model.ort"));
      expect(() => sherpaBackend({ ...models, asr })).toThrow("The speech recognition model couldn't be loaded.");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("cuts in while a listening window is open, and the voice process carries on (review #253)", () => {
    // "Hey Ember." and a pause: the window waits for the request. Then Ember speaks (a task is announced) and the user says
    // "Hey Ember, turn on night light" over it; the speakers' stream is on (it plays talk without the phrase).
    const talk = cat(trimmed("chat"), trimmed("remember"));
    const playing = (n: number) => new Float32Array(n).map((_, i) => talk[i % talk.length] * 0.5);
    const first = cat(silence(3), read("wake_pause").subarray(0, at(1.52)), silence(1));
    const s = session();
    s.hear(inRoom(first), { speakers: playing(first.length) });
    expect(s.engine.listening).toBe(true);
    s.engine.selfSpeaking(true);
    const second = cat(read("wake"), silence(1.5));
    s.hear(inRoom(second), { speakers: playing(second.length) });
    s.end();
    expect(s.events.filter(e => e.type === "wake")).toHaveLength(2);
  });

  it("doesn't send others' talk (10 dB under the user) after a bare 'Hey Ember' (VO9-3)", () => {
    const talk = cat(...["chat", "remember", "bigger", "chat", "remember"].flatMap(n => [trimmed(n).map(x => x * 0.3), silence(0.15)]));
    const hey = read("wake_pause").subarray(0, at(1.52)), from = at(2);
    const audio = cat(talk, silence(1));
    for (let i = 0; i < hey.length; i++) audio[from + i] += hey[i];
    const s = session();
    s.hear(inRoom(audio));
    s.end();
    expect(s.events.filter(e => e.type === "wake")).toHaveLength(1);
    expect(sent(s.events)).toEqual([]);
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

  it("takes a long request whose pauses are short and few (a breath every 4–5 s) whole", () => {
    const long = cat(read("wake").subarray(0, at(2.7)), silence(0.25), trimmed("followup"), silence(0.15), trimmed("chat"), silence(0.25), trimmed("bigger"), silence(0.15), trimmed("remember"), silence(2));
    expect(long.length / 16000).toBeGreaterThan(12);
    const s = session();
    s.hear(inRoom(long));
    s.end();
    expect(sent(s.events)).toEqual([expect.objectContaining({ text: expect.stringMatching(/night ?light.*weather was nice/i), window: "wake" })]);
    expect(sent(s.events)[0]).not.toHaveProperty("cut");
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

  it("teaches Voice Match a voice from four phrases, and lets a fifth in that voice through", async () => {
    // The voiceprint model as the worker runs it (voiceprint-worker.ts), in this thread.
    const ort = createRequire(import.meta.url)("onnxruntime-web");
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = "error";
    const session = await ort.InferenceSession.create(modelPaths(path.join(dir, "models")).speaker, { executionProviders: ["wasm"] });
    const printer: Printer = {
      async print(samples) {
        const { data, frames } = printFeatures(samples);
        const out = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", data, [1, frames, 80]) });
        return unit(out[session.outputNames[0]].data as Float32Array);
      },
    };
    const states: EnrolState[] = [];
    const enrol = new Enrolment(printer, st => states.push(st), 4);
    for (const clip of ["wake", "dnd", "chat", "remember"]) await enrol.heard(read(clip));
    const done = states.find(st => st.state === "done") as Extract<EnrolState, { state: "done" }> | undefined;
    expect(done).toBeDefined();
    expect(similarity(await printer.print(read("followup")), done!.print)).toBeGreaterThanOrEqual(VOICE_MATCH_THRESHOLD);
    const sent: VoiceEvent[] = [];
    const gate = new VoiceGate(() => printer, e => sent.push(e), () => undefined);
    gate.setOwner(done!.print);
    gate.event({ type: "utterance", text: "And turn on do not disturb too.", ms: 100, window: "follow-up" }, read("followup"));
    await new Promise(r => setTimeout(r, 2000));
    expect(sent.map(e => e.type)).toEqual(["utterance"]);
  });
});
