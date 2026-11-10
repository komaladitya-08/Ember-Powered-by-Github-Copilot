/**
 * The real recognizers on synthesized speech: the clips in test/fixtures/voice. They run on the build Ember picks
 * (runtime.ts: the native addon on Windows and macOS, WebAssembly elsewhere); EMBER_VOICE_BACKEND=wasm forces
 * WebAssembly, and EMBER_SHERPA_ADDON=<path to a sherpa-onnx.node> runs an addon where none is installed (Linux:
 * sherpa-onnx-linux-x64's, to try the native path there), and EMBER_SHERPA_CAPI=<folder> runs sherpa-onnx's C API
 * through koffi (the folder scripts/voice/fetch-capi.mjs prints). Needs the models from `node scripts/voice/prepare.mjs`
 * (skipped otherwise; EMBER_VOICE_TEST=1 requires them).
 */

import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { VoiceEngine, type VoiceEvent } from "../../app/voice/engine";
import { ModelLoadError, sherpaBackend } from "../../app/voice/sherpa";
import { DEFAULT_VOICE, modelPaths, modelReady, modelsReady } from "../../app/voice/models";
import { nativePackage, sherpaRuntime, type RuntimeOptions } from "../../app/voice/runtime";
import { kittenSpec } from "../../app/voice/tts-spec";
import { Enrolment, VoiceGate, type EnrolState, type Printer } from "../../app/voice/match";
import { VOICE_MATCH_THRESHOLD, printFeatures, similarity, unit } from "../../app/voice/voiceprint";

const dir = path.resolve(process.env.EMBER_VOICE_DIR ?? ".cache/voice");
const clips = path.resolve("test/fixtures/voice");
const ready = modelsReady(path.join(dir, "models")) && fs.existsSync(path.join(clips, "wake.wav"));
const sherpa = createRequire(import.meta.url)("sherpa-onnx");
const addonFile = process.env.EMBER_SHERPA_ADDON ? path.resolve(process.env.EMBER_SHERPA_ADDON) : undefined;
// EMBER_SHERPA_CAPI=<the folder scripts/voice/fetch-capi.mjs prints>: the C API through koffi (Linux x64).
const capiDir = process.env.EMBER_SHERPA_CAPI ? path.resolve(process.env.EMBER_SHERPA_CAPI) : undefined;
const runtime: RuntimeOptions | undefined = addonFile ? { prefer: "native", addonFile } : capiDir ? { capiDir } : undefined;
const defaultVoiceReady = modelReady(path.join(dir, "models"), "tts");
const defaultVoiceNative = process.env.EMBER_VOICE_BACKEND !== "wasm" && (!!capiDir || !!addonFile || nativePackage() !== null);

// Real recognizers on a loaded CI machine: a clip can take several seconds, so each test gets 20.
describe.skipIf(!ready && process.env.EMBER_VOICE_TEST !== "1" && process.env.EMBER_KITTEN_TEST !== "1")("voice on real models", { timeout: 120_000 }, () => {
  let backend: ReturnType<typeof sherpaBackend>;
  /**
   * The recognizers the speakers' stream is tested on. Speaker rejection runs only on Linux (it needs parec), which runs
   * WebAssembly: where the picked build is the native addon (Windows, macOS), those tests run on a WebAssembly backend,
   * the build that runs them in Ember. (The addon's spotter decides a hair differently on a phrase at its threshold:
   * on Windows, "Ember, stop" from the speakers came out as "ember_stop" on one stream and the bare name on the other.)
   */
  let speakersBackend: ReturnType<typeof sherpaBackend> | null = null;
  const forSpeakers = () => {
    if (backend.info.backend === "wasm") return backend;
    speakersBackend ??= sherpaBackend(modelPaths(path.join(dir, "models")), { monitor: true, runtime: { prefer: "wasm" } });
    return speakersBackend;
  };
  beforeAll(() => {
    const t0 = performance.now();
    backend = sherpaBackend(modelPaths(path.join(dir, "models")), { monitor: true, runtime });
    console.log(`voice backend: ${JSON.stringify(backend.info)}, loaded in ${Math.round(performance.now() - t0)} ms`);
  }, 60_000);

  const read = (name: string): Float32Array => sherpa.readWave(path.join(clips, `${name}.wav`)).samples;
  /** Plays a clip (or audio) through the engine in 32 ms frames, like the microphone would, with real time; `at`: when each event came (ms). */
  const play = (clip: string | Float32Array, opts: { monitor?: boolean; followUp?: boolean } = {}) => {
    const samples = typeof clip === "string" ? read(clip) : clip;
    const events: VoiceEvent[] = [];
    const at: number[] = [];
    let t = 0;
    const b = opts.monitor ? forSpeakers() : backend;
    const engine = new VoiceEngine(b, e => { if (e.type !== "speech") { events.push(e); at.push(t); } }, { now: () => t });
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
    b.resetVad();
    return { events, at, rtf: cpu / (all.length / 16) };
  };

  it("runs on the native addon on Windows and macOS (WebAssembly on Linux)", () => {
    const native = !!addonFile || !!capiDir || ((process.platform === "win32" || process.platform === "darwin") && process.env.EMBER_VOICE_BACKEND !== "wasm");
    expect(backend.info).toMatchObject({ backend: native ? "native" : "wasm" });
    expect(backend.info.threads).toBe(native ? Math.max(1, Math.min(2, os.availableParallelism() - 1)) : 1);
  });

  it.skipIf(!defaultVoiceNative && process.env.EMBER_KITTEN_TEST !== "1")("generates finite speech with the pinned default Kitten model through the production native adapter", () => {
    expect(defaultVoiceReady).toBe(true);
    const runtimePicked = sherpaRuntime(runtime);
    expect(runtimePicked.backend).toBe("native");
    const voice = runtimePicked.createTts(kittenSpec(path.join(dir, "models", DEFAULT_VOICE.target)), { provider: "cpu", numThreads: 1 }, 1);
    try {
      expect(voice.numSpeakers).toBe(8);
      expect(fs.readFileSync(path.join(dir, "models", DEFAULT_VOICE.target, "LICENSE"), "utf8")).toContain("Apache License");
      const out = voice.generate({ text: "Night Light is on.", sid: 0, speed: 1 });
      expect(out.sampleRate).toBe(24_000);
      expect(out.samples.length / out.sampleRate).toBeGreaterThan(0.5);
      expect(out.samples.every(Number.isFinite)).toBe(true);
      expect(out.samples.some(s => Math.abs(s) > 0.01)).toBe(true);
    } finally { voice.free(); }
  });

  it("wakes on 'Hey Ember' and hears the request in the same breath", () => {
    const { events, rtf } = play("wake");
    console.log(`voice: 'Hey Ember, turn on night light' processed at ${rtf.toFixed(3)} of real time (${backend.info.backend}, ${backend.info.provider})`);
    expect(events.map(e => e.type)).toEqual(["wake", "listening", "utterance", "listening"]);
    expect(events.find(e => e.type === "utterance")).toMatchObject({ text: expect.stringMatching(/^Turn on night ?light\.?$/i) });
    expect(rtf).toBeLessThan(1);
  });

  it("hears a request ahead of the VAD's end of it, in the same words and at the same moment, and doesn't wait for Moonshine then (docs/ASSISTANT.md phase 1.5)", () => {
    // (Not a bare "Ember, …": what it says decides whether it was a wake at all, on the VAD's own segment.)
    for (const [clip, said] of [["wake", /^turn on night ?light$/], ["dnd", /^turn(ed)? on do not disturb$/]] as const) {
      const samples = read(clip);
      /** The request, when it came, and how many transcriptions ran on the frame that sent it. */
      const hear = (transcribeAhead: boolean) => {
        let t = 0, calls = 0, onSend = -1;
        const transcribe = backend.transcribe;
        backend.transcribe = s => { calls++; return transcribe(s); };
        try {
          let sent: (Extract<VoiceEvent, { type: "utterance" }> & { at: number }) | undefined;
          const engine = new VoiceEngine(backend, e => { if (e.type === "utterance") sent = { ...e, at: t }; }, { now: () => t, transcribeAhead });
          const all = new Float32Array(samples.length + 32_000);
          all.set(samples);
          for (let i = 0; i + 512 <= all.length; i += 512) {
            const before = calls;
            engine.feed(all.subarray(i, i + 512));
            if (sent && onSend < 0) onSend = calls - before;
            t += 32;
          }
          return { sent, onSend };
        } finally {
          backend.transcribe = transcribe;
          backend.resetVad();
        }
      };
      const on = hear(true), off = hear(false);
      // The words heard right either way (the recognizer writes "Night Light" or "turned on" now and then, with a moment
      // more or less of quiet around the speech), at the same moment.
      const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9' ]/g, "").trim();
      expect(on.sent?.at, clip).toBe(off.sent!.at);
      expect(words(on.sent!.text), clip).toMatch(said);
      expect(words(off.sent!.text), clip).toMatch(said);
      expect(off.onSend, clip).toBeGreaterThan(0);
      expect(on.onSend, clip).toBe(0);
    }
  });

  it("wakes on the bare name, 'Ember', and hears the request in the same breath", () => {
    const { events } = play("name_wake");
    expect(events.map(e => e.type)).toEqual(["wake", "listening", "utterance", "listening"]);
    expect(events[0]).toEqual({ type: "wake", keyword: "ember" });
    expect(events.find(e => e.type === "utterance")).toMatchObject({ text: expect.stringMatching(/^Turn on night ?light\.?$/i) });
  });

  it("wakes on the bare name wherever the microphone's frames happen to start", () => {
    // A real microphone's 32 ms frames fall anywhere against the speech: the VAD's segment then started up to a window
    // into "Ember" and the check heard "Remember", "Ever" or "Amber" (7 of these 16 placements were turned away), until
    // it was tried again with the moment before the segment (the voice end-to-end test found it).
    const clip = read("name_wake");
    const missed: string[] = [];
    for (let off = 0; off < 512; off += 32) {
      const audio = new Float32Array(off + clip.length);
      audio.set(clip, off);
      const { events } = play(audio);
      const wake = events.find(e => e.type === "wake" || e.type === "rejected");
      if (wake?.type !== "wake" || !events.some(e => e.type === "utterance" && /night ?light/i.test(e.text))) missed.push(`${off}: ${JSON.stringify(wake)}`);
    }
    expect(missed).toEqual([]);
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
  /**
   * One engine fed in turns (`hear`), with the speakers' stream when given, and what it said (`at`: when, in ms).
   * `speakers`: the session feeds the speakers' stream (it runs on forSpeakers()).
   */
  const session = (o: { speakers?: boolean } = {}) => {
    const events: (VoiceEvent & { at: number })[] = [];
    let t = 0;
    const b = o.speakers ? forSpeakers() : backend;
    const engine = new VoiceEngine(b, e => { if (e.type !== "speech") events.push({ ...e, at: t }); }, { now: () => t });
    const hear = (mic: Float32Array, o: { speakers?: Float32Array; onFrame?: (frame: number) => void } = {}) => {
      for (let i = 0, k = 0; i + 512 <= mic.length; i += 512, k++) {
        o.onFrame?.(k);
        if (o.speakers) engine.feedMonitor(o.speakers.slice(i, i + 512));
        engine.feed(mic.subarray(i, i + 512));
        t += 32;
      }
    };
    return { engine, events, hear, end: () => b.resetVad() };
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

  it("keeps the last words of a softer third request after Ember's spoken replies (PR #149 voice smoke)", () => {
    // The smoke's committed clips, 6 s gaps, room floor and 16-bit PCM rounding. Chromium can place a frame anywhere
    // against them: this 4 ms offset, with the third request just 3.1 dB softer, reproduced CI's "And make the text."
    // at 25.600 s, before "a bit bigger" was said. Do not relax the last-word assertion or amplify the fixture to pass.
    for (const gain of [0.7, 1]) {
      let seed = 12345;
      const recording = cat(silence(5), read("wake"), silence(6), read("followup"), silence(6), read("bigger").map(x => x * gain), silence(3));
      const pcm = recording.map(x => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return Math.max(-32768, Math.min(32767, Math.round((x + (seed / 0x7fffffff - 0.5) * 7e-4) * 32767))) / 32768;
      });
      const audio = cat(new Float32Array(64), pcm), events: VoiceEvent[] = [];
      let t = 0, speakAt = Infinity, quietAt = Infinity;
      const engine = new VoiceEngine(backend, e => {
        events.push(e);
        if (e.type === "utterance") { speakAt = t + 80; quietAt = t + 670; }
      }, { now: () => t });
      try {
        for (let i = 0; i + 512 <= audio.length; i += 512) {
          if (t >= speakAt) { engine.selfSpeaking(true); speakAt = Infinity; }
          if (t >= quietAt) { engine.selfSpeaking(false); engine.followUp(8000); quietAt = Infinity; }
          engine.feed(audio.subarray(i, i + 512));
          t += 32;
        }
        expect(sent(events), `third request gain ${gain}`).toMatchObject([
          { text: expect.stringMatching(/night ?light/i), window: "wake" },
          { text: expect.stringMatching(/do not disturb/i), window: "follow-up" },
          { text: expect.stringMatching(/make the text.*bigger/i), window: "follow-up" },
        ]);
        expect(events.filter(e => e.type === "wake")).toHaveLength(1);
      } finally { backend.resetVad(); }
    }
  });

  it("hears a request said softer than 'Hey Ember' after a pause, also right after Ember's answer where it can't hear its speakers (Windows)", () => {
    // Ember's answer reaches the microphone 10 dB down (Web Audio's playback isn't echo-cancelled), then 1.2 s on: "Hey
    // Ember." … 1.5 s … "And make the text a bit bigger." 6 dB softer. Ember's voice isn't the room's talk (VO9-3), nor the
    // request; and "Hey Ember" said again in the follow-up window after an answer is a wake.
    const answer = cat(trimmed("chat"), silence(0.2), trimmed("remember")).map(x => x * 0.3);
    const ask = cat(silence(1.2), read("wake_pause").subarray(0, at(1.52)), silence(1.5), trimmed("bigger").map(x => x * 0.5), silence(2));
    // In a quiet room too: measured on the wake phrase's loudness, the request was cut at its softer words ("And make the text.").
    const quiet = session();
    quiet.hear(inRoom(cat(silence(4), ask)));
    quiet.end();
    expect(sent(quiet.events).map(u => u.text)).toEqual([expect.stringMatching(/bigger/i)]);
    const after = session();
    after.hear(inRoom(silence(1)));
    after.engine.selfSpeaking(true);
    after.hear(inRoom(answer));
    after.engine.selfSpeaking(false);
    after.hear(inRoom(ask));
    after.end();
    expect(sent(after.events).map(u => u.text)).toEqual([expect.stringMatching(/bigger/i)]);
    const followUp = session();
    followUp.hear(inRoom(cat(read("wake"), silence(1))));
    followUp.engine.selfSpeaking(true);
    followUp.hear(inRoom(answer));
    followUp.engine.selfSpeaking(false);
    followUp.engine.followUp(8000);
    followUp.hear(inRoom(ask));
    followUp.end();
    expect(sent(followUp.events)).toMatchObject([{ text: expect.stringMatching(/night ?light/i), window: "wake" }, { text: expect.stringMatching(/bigger/i), window: "wake" }]);
  });

  it("waits out a 0.7–0.9 s pause after “And make the text a”, and hears the request whole (voice-listening-3)", () => {
    // "And make the text a" … a pause to think … "bit bigger.": at 0.7 s or more the VAD ended the request and Ember sent
    // "And make the text a." (the rest lost, or a second turn in a conversation). Split at the quietest 100 ms between
    // 40 % and 65 % of the speech, as measured (frame 58).
    const b = read("bigger");
    const rms = (a: Float32Array) => Math.sqrt(a.reduce((n, x) => n + x * x, 0) / a.length);
    const loud: number[] = [];
    for (let i = 0; i + 512 <= b.length; i += 512) loud.push(rms(b.subarray(i, i + 512)));
    const voiced = loud.flatMap((e, i) => (e > 0.01 ? [i] : []));
    const first = voiced[0], last = voiced.at(-1)!;
    let cut = first, low = Infinity;
    for (let i = Math.round(first + (last - first) * 0.4); i < first + (last - first) * 0.65; i++) { const e = loud[i] + loud[i + 1] + loud[i + 2]; if (e < low) { low = e; cut = i + 1; } }
    const head = b.subarray(0, cut * 512), rest = b.subarray(cut * 512);
    for (const pause of [0.7, 0.9]) {
      const followUp = session();
      followUp.engine.followUp(8000);
      followUp.hear(inRoom(cat(silence(0.5), head, silence(pause), rest, silence(3))));
      followUp.end();
      expect(sent(followUp.events).map(u => u.text), `follow-up, ${pause} s`).toEqual([expect.stringMatching(/make the text a bit bigger/i)]);
      const woken = session();
      woken.engine.conversation(true);
      woken.hear(inRoom(cat(silence(1), read("wake_pause").subarray(0, at(1.52)), silence(1), head, silence(pause), rest, silence(3))));
      woken.end();
      expect(sent(woken.events).map(u => u.text), `after "Hey Ember", ${pause} s`).toEqual([expect.stringMatching(/make the text a bit bigger/i)]);
    }
  });

  it("sends “And make the text a” alone when a TV or colleague talks on after the pause, never with their words (voice-listening-c1-2)", () => {
    // The same split as above; then the room's talk (the test clips' lines, 12–19 dB under), from 0.75 or 1 s after the
    // voice stopped. It was joined to the half request in 12 of these 18 cases.
    const b = read("bigger");
    const rms = (a: Float32Array) => Math.sqrt(a.reduce((n, x) => n + x * x, 0) / a.length);
    const loud: number[] = [];
    for (let i = 0; i + 512 <= b.length; i += 512) loud.push(rms(b.subarray(i, i + 512)));
    const voiced = loud.flatMap((e, i) => (e > 0.01 ? [i] : []));
    const first = voiced[0], last = voiced.at(-1)!;
    let cut = first, low = Infinity;
    for (let i = Math.round(first + (last - first) * 0.4); i < first + (last - first) * 0.65; i++) { const e = loud[i] + loud[i + 1] + loud[i + 2]; if (e < low) { low = e; cut = i + 1; } }
    const head = b.subarray(0, cut * 512);
    let voiceEnd = head.length;
    while (voiceEnd > 0 && Math.abs(head[voiceEnd - 1]) < 0.01) voiceEnd--;
    const talk = (g: number) => cat(...["chat", "remember", "followup", "chat"].flatMap(n => [trimmed(n).map(x => x * g), silence(0.25)]));
    const mix = (a: Float32Array, add: Float32Array, from: number) => { const o = a.slice(); for (let i = 0; i < add.length && from + i < o.length; i++) o[from + i] += add[i]; return o; };
    for (const g of [0.08, 0.12, 0.18]) for (const gap of [0.75, 1]) {
      const heard = inRoom(mix(cat(head, silence(12)), talk(g), voiceEnd + at(gap)));
      const woken = session();
      woken.hear(cat(inRoom(cat(silence(1), read("wake_pause").subarray(0, at(1.52)), silence(1))), heard));
      woken.end();
      const followUp = session();
      followUp.engine.followUp(8000);
      followUp.hear(cat(inRoom(silence(0.5)), heard));
      followUp.end();
      // Listen once (it hears only audio captured after the press).
      const events: VoiceEvent[] = [];
      let t = 0;
      const once = new VoiceEngine(backend, e => events.push(e), { now: () => t });
      once.listenOnce(0, 8000);
      const mic = cat(inRoom(silence(0.5)), heard);
      try { for (let i = 0; i + 512 <= mic.length; i += 512) { once.feed(mic.subarray(i, i + 512), t + 1); t += 32; } } finally { backend.resetVad(); }
      for (const [window, said] of [["wake", sent(woken.events)], ["follow-up", sent(followUp.events)], ["manual", sent(events)]] as const) {
        expect(said.map(u => u.text), `${window}, talk at ${g}, ${gap} s on`).toEqual([expect.stringMatching(/^And make the text a\.?$/i)]);
      }
    }
  });

  it("stops on “Ember, stop” and “Hey Ember, stop” while Voice Match is taught, and takes its phrases as nothing (voice-listening-r1)", () => {
    // The engine as the voice process runs it then: stopsOnly, the VAD fed apart from it (the enrolment's). The spotter
    // takes the bare name in "Ember, stop" and "Hey Ember" in "Hey Ember, stop": only "ember_stop" counted, and teaching
    // stopped 0 times in 24 on these clips (24 of 24 when not teaching).
    const teaching = (clip: Float32Array) => {
      const events: VoiceEvent[] = [];
      let t = 0;
      const engine = new VoiceEngine(backend, e => { if (e.type !== "speech") events.push(e); }, { now: () => t });
      engine.cancel();
      engine.stopsOnly(true);
      const mic = inRoom(cat(silence(4), clip, silence(3)));
      try {
        for (let i = 0; i + 512 <= mic.length; i += 512) { const f = mic.subarray(i, i + 512); engine.feed(f, t + 1); backend.vad(f); t += 32; }
      } finally { backend.resetVad(); backend.resetSpot?.(); }
      return events;
    };
    const stop = read("stop");
    const heyStop = cat(read("wake_pause").subarray(0, at(1.52)), silence(0.1), stop.subarray(at(1.09)), silence(1));
    for (const [name, clip] of [["Ember, stop!", stop], ["Ember, stop! (softer)", stop.map(x => x * 0.6)], ["Ember, … stop!", cat(stop.subarray(0, at(0.62)), silence(0.6), stop.subarray(at(0.62)))], ["Hey Ember, stop", heyStop]] as const) {
      for (const lead of [0, 0.1, 0.25]) expect(teaching(cat(silence(lead), clip)).filter(e => e.type === "stop"), `${name}, ${lead} s in`).toHaveLength(1);
    }
    // Phrases like the teaching's, and the name inside another word: nothing.
    for (const clip of ["wake", "dnd", "name_wake", "remember"]) expect(teaching(read(clip)), clip).toEqual([]);
  });

  it("ends Listen once at 8 s when only a TV talks, and hears the user's own request past it to its end, begun late or at once (voice-listening-c1-1, voice-listening-1, voice-listening-r2-1, voice-listening-3)", () => {
    /** Listen once pressed `from` ms into `mic`: the request heard (`at`, ms after the press) and how the window ended. */
    const once = (mic: Float32Array, from = 0) => {
      const events: (VoiceEvent & { at: number })[] = [];
      let t = 0;
      const engine = new VoiceEngine(backend, e => { if (e.type !== "speech") events.push({ ...e, at: t - from }); }, { now: () => t });
      try {
        for (let i = 0; i + 512 <= mic.length; i += 512) {
          if (t === from) engine.listenOnce(from, 8000);
          if (t >= from) engine.feed(mic.subarray(i, i + 512), t + 1);
          t += 32;
        }
      } finally { backend.resetVad(); }
      return { sent: sent(events), ended: events.find(e => e.type === "listening" && !e.on) };
    };
    const mix = (a: Float32Array, b: Float32Array, from: number) => { const o = a.slice(); for (let i = 0; i < b.length && from + i < o.length; i++) o[from + i] += b[i]; return o; };
    // A TV's (or colleague's) talk, 8–14 dB under the user, the test clips' lines back to back, for 25 s.
    const tv = (g: number) => { const lines = cat(...["chat", "remember", "followup", "chat", "amber", "chat"].flatMap(n => [trimmed(n).map(x => x * g), silence(0.25)])); return cat(lines, lines, lines); };
    for (const g of [0.2, 0.4]) {
      // Nothing said: it went on for 20 s, and sent the TV's words as the request. Talk begun in the window's first second
      // (from 0.5 s, or on as it opened but between two lines at the press: 1 and 5 s in) can't be told from a request
      // begun then by its loudness: it goes on to 12 s at most, and none of it is sent (voice-listening-r2-1).
      for (const [how, mic, from, by] of [["from 0.5 s", inRoom(mix(new Float32Array(at(26)), tv(g), at(0.5))), 0, 12_000], ["on as it opens", inRoom(mix(new Float32Array(at(29)), tv(g), 0)), 3200, 8000], ["on as it opens, between two lines", inRoom(mix(new Float32Array(at(27)), tv(g), 0)), 992, 12_000], ["on as it opens, 5 s in", inRoom(mix(new Float32Array(at(31)), tv(g), 0)), 4992, 12_000]] as const) {
        const r = once(mic, from);
        expect(r.sent, `TV at ${g}, ${how}`).toEqual([]);
        expect(r.ended, `TV at ${g}, ${how}`).toMatchObject({ reason: "timeout", window: "manual" });
        expect((r.ended as { at: number }).at, `TV at ${g}, ${how}`).toBeGreaterThanOrEqual(8000);
        expect((r.ended as { at: number }).at, `TV at ${g}, ${how}`).toBeLessThanOrEqual(by);
      }
    }
    // The user's own 7 s request, begun at 6.5 s, over the TV and in a quiet room: heard to its end, whole.
    const long = cat(trimmed("bigger"), silence(0.3), trimmed("followup"), silence(0.3), trimmed("chat"));
    for (const [how, mic] of [["over the TV", inRoom(mix(mix(new Float32Array(at(18)), tv(0.1), at(0.5)), long, at(6.5)))], ["in a quiet room", inRoom(cat(silence(6.5), long, silence(4)))]] as const) {
      expect(once(mic).sent.map(u => u.text), how).toEqual([expect.stringMatching(/^And make the text a bit bigger.*lunch\.?$/i)]);
    }
    // Begun at 7.9 s: the VAD hears speech 0.25 s into it, after the deadline ("No request heard").
    expect(once(inRoom(cat(silence(7.9), trimmed("bigger"), silence(4)))).sent.map(u => u.text)).toEqual([expect.stringMatching(/make the text a bit bigger/i)]);
    // A 9.7 s request begun at once, 0.2–0.8 s after the press, in a quiet room or over a TV at 0.1 from 0.2 s: measured
    // against the window's first second (its own voice), it was thrown away at 8 s with "No request heard" (3 of 3).
    const longer = cat(long, silence(0.3), trimmed("remember"));
    for (const [how, mic] of [...[0.2, 0.5, 0.8].map(s => [`begun at ${s} s`, inRoom(cat(silence(s), longer, silence(4)))] as const), ["begun at 0.5 s over the TV", inRoom(mix(mix(new Float32Array(at(22)), tv(0.1), at(0.2)), longer, at(0.5)))] as const]) {
      expect(once(mic).sent.map(u => u.text), how).toEqual([expect.stringMatching(/^And make the text a bit bigger.*September weather was nice\.?$/i)]);
    }
    // "…and make the text a", a 0.8 s pause, "bit bigger" said across the deadline, by a user who began at 0.3 or 0.6 s:
    // the window ended at the held half's deadline, and nothing was sent (voice-listening-3).
    const b = read("bigger");
    const level: number[] = [];
    for (let i = 0; i + 512 <= b.length; i += 512) level.push(Math.sqrt(b.subarray(i, i + 512).reduce((n, x) => n + x * x, 0) / 512));
    const voiced = level.flatMap((e, i) => (e > 0.01 ? [i] : [])), [v0, v1] = [voiced[0], voiced.at(-1)!];
    let split = v0, low = Infinity;
    for (let i = Math.round(v0 + (v1 - v0) * 0.4); i < v0 + (v1 - v0) * 0.65; i++) { const e = level[i] + level[i + 1] + level[i + 2]; if (e < low) { low = e; split = i + 1; } }
    const edges = (s: Float32Array) => { let a = 0, z = s.length; while (a < z && Math.abs(s[a]) < 0.01) a++; while (z > a && Math.abs(s[z - 1]) < 0.01) z--; return s.subarray(a, z); };
    const [half, rest] = [edges(b.subarray(0, split * 512)), edges(b.subarray(split * 512))];
    const lead = cat(trimmed("followup"), silence(0.3), trimmed("chat"), silence(0.3));
    for (const s of [0.3, 0.6]) {
      expect(once(inRoom(cat(silence(s), lead, half, silence(0.8), rest, silence(4)))).sent.map(u => u.text), `begun at ${s} s`).toEqual([expect.stringMatching(/^And turn on do not disturb.*make the text a bit bigger\.?$/i)]);
    }
    // The same half request ("…make the text a") over a TV on from the press, and nothing more said: it went as nothing.
    for (const [g, s] of [[0.1, 1.5], [0.2, 2]] as const) {
      expect(once(inRoom(mix(mix(new Float32Array(at(26)), tv(g), 0), cat(lead, half), at(s)))).sent.map(u => u.text), `TV at ${g}, begun at ${s} s`).toEqual([expect.stringMatching(/^And turn on do not disturb.*make the text/i)]);
    }
    // Silence still ends it at 8 s.
    expect(once(inRoom(silence(10))).ended).toMatchObject({ reason: "timeout", at: 8000 });
  });

  it("hears a Listen once request said after a screen reader's announcement of the window, never the announcement (voice-listening-c2-1)", () => {
    // A screen reader saying a status line through the speakers as the window opens, 14–20 dB under the user (the "chat"
    // clip stands in for it: its words are what main tells the voice process the windows say), then the user's request
    // 0.3 or 0.8 s after it. Without them the announcement was sent before the request, or alone as the request, the
    // user's words then lost (with a synthesized "Listening for one request": 36 of 36 and 4 of 4).
    const reader = trimmed("chat"), user = trimmed("followup");
    for (const g of [0.1, 0.2]) for (const after of [0.3, 0.8]) {
      const events: VoiceEvent[] = [];
      let t = 0;
      const engine = new VoiceEngine(backend, e => events.push(e), { now: () => t });
      engine.listenOnce(0, 8000, ["Let's meet at the station after lunch."]);
      const mic = inRoom(cat(silence(0.25), reader.map(x => x * g), silence(after), user, silence(4)));
      try { for (let i = 0; i + 512 <= mic.length; i += 512) { engine.feed(mic.subarray(i, i + 512), t + 1); t += 32; } } finally { backend.resetVad(); }
      expect(sent(events).map(u => u.text), `at ${g}, ${after} s after it`).toEqual([expect.stringMatching(/^and turn on\.? do not disturb,? (too|to|2)\.?$/i)]);
    }
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

  it("stops on 'Hey Ember, stop' said while Ember speaks; without the speakers' stream 'Hey Ember' then cuts in, and sends nothing said over Ember's voice", () => {
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
    // Whether or not it cut in (natively the check heard the clip's greeting less often), nothing is sent: Ember hasn't said
    // it stopped speaking, so all of the one-breath request was said over its voice.
    expect(wake.events.filter(e => e.type === "utterance")).toEqual([]);
    // "Hey Ember." over the start of Ember's answer (20 dB down at the microphone, as in VO9-2); main hushes Ember on the wake; then the request.
    const answer = cat(trimmed("chat"), silence(0.2), trimmed("remember"), silence(0.2), trimmed("chat")).map(x => x * 0.1), hey = read("wake_pause").subarray(0, at(1.52));
    const over = answer.slice(0, at(0.2 + 1.52 + 0.15)); // (its voice stops once main hushes it)
    over.set(hey.map((x, i) => x + answer[at(0.2) + i]), at(0.2));
    const cut = session();
    cut.engine.selfSpeaking(true);
    let hushed = false;
    const hush = { onFrame: () => { if (!hushed && cut.events.some(e => e.type === "wake")) { hushed = true; cut.engine.selfSpeaking(false); } } };
    cut.hear(inRoom(over), hush);
    cut.hear(inRoom(cat(silence(0.8), trimmed("bigger"), silence(2))), hush);
    cut.end();
    expect(cut.events.filter(e => e.type === "wake")).toHaveLength(1);
    expect(sent(cut.events).map(u => u.text)).toEqual([expect.stringMatching(/bigger/i)]);
  });

  it("cuts in on Ember's answer when its speakers didn't say 'Hey Ember': Ember is hushed, and the request is heard (VO9-2)", () => {
    // Ember reads an answer (its echo in the microphone, 20 dB down); the user says "Hey Ember, turn on night light" over it.
    // Main hushes Ember on a wake: its speakers go quiet 150 ms later.
    const answer = cat(trimmed("chat"), silence(0.2), trimmed("remember"), silence(0.2), trimmed("chat")), wake = read("wake"), from = at(1.2);
    const speakers = cat(answer, silence(4)), voice = new Float32Array(speakers.length);
    voice.set(wake, from);
    const mic = inRoom(voice.map((x, i) => x + speakers[i] * 0.1));
    const s = session({ speakers: true });
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

  it("fails to load, with a ModelLoadError, when a model file is cut short or missing (review #254); natively, a cut one ends the process", () => {
    const models = modelPaths(path.join(dir, "models"));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ember-damaged-"));
    try {
      // The recognition model's folder, its encoder cut to 1000 bytes (as an antivirus or a disk error leaves it), then gone.
      const asr = path.join(tmp, "asr");
      fs.mkdirSync(asr);
      // (Copies: Windows makes symbolic links only with Developer Mode on.)
      for (const f of ["decoder_model_merged.ort", "tokens.txt"]) fs.copyFileSync(path.join(models.asr, f), path.join(asr, f));
      fs.writeFileSync(path.join(asr, "encoder_model.ort"), fs.readFileSync(path.join(models.asr, "encoder_model.ort")).subarray(0, 1000));
      // WebAssembly throws. The addon's onnxruntime aborts the process instead (an uncaught C++ exception: nothing in
      // JavaScript can catch it), so main starts a voice process that died loading again on WebAssembly, which says the
      // models are damaged (VoiceService.nativeFailed).
      expect(() => sherpaBackend({ ...models, asr }, { runtime: { prefer: "wasm" } })).toThrow(ModelLoadError);
      // (The addon's: on the C API, EMBER_SHERPA_CAPI, there is no addon to load in a process of its own.)
      if (backend.info.backend === "native" && !capiDir) {
        const file = addonFile ?? createRequire(import.meta.url).resolve(`${nativePackage()}/sherpa-onnx.node`);
        const make = `const a = require(process.env.ADDON), d = process.env.ASR; a.createOfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: { moonshine: { encoder: d + "/encoder_model.ort", mergedDecoder: d + "/decoder_model_merged.ort" }, tokens: d + "/tokens.txt", numThreads: 1, provider: "cpu", debug: 0 } }); console.log("loaded");`;
        const r = spawnSync(process.execPath, ["-e", make], { env: { ...process.env, ADDON: file, ASR: asr }, encoding: "utf8", timeout: 30_000 });
        expect(r.stdout).not.toContain("loaded");
        expect(r.status !== 0 || r.signal !== null).toBe(true);
      }
      fs.rmSync(path.join(asr, "encoder_model.ort"));
      // A missing file is refused before onnxruntime sees it, by either build.
      expect(() => sherpaBackend({ ...models, asr }, { runtime })).toThrow("The speech recognition model couldn't be loaded.");
      expect(() => sherpaBackend({ ...models, asr }, { runtime: { prefer: "wasm" } })).toThrow("The speech recognition model couldn't be loaded.");
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
    const s = session({ speakers: true });
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
    const s = session({ speakers: true }), endFrame = Math.ceil(answer.length / 512);
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

  it("doesn't end a request that never goes quiet at the speaker's softer words, in a fan's noise: it's cut at the cap (early end)", () => {
    // "Hey Ember, …" and 30 s of talk with no pause, at half the clips' level, over a fan's noise (low-passed, -45 dBFS)
    // that the room's first 3 s teach. It ended at 5.9 s, mid-sentence and not marked cut ("…make the text of the text.").
    const talk = cat(read("wake").subarray(0, at(1.6)), ...Array.from({ length: 4 }, () => ["chat", "followup", "bigger"].map(trimmed)).flat());
    const audio = cat(silence(3), talk.map(x => x * 0.5), silence(1));
    let seed = 9, lp = 0;
    const fan = audio.map(() => { const w = (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5; lp = 0.97 * lp + 0.03 * w; return lp * 6 + w * 0.3; });
    const gain = 10 ** (-45 / 20) / Math.sqrt(fan.reduce((s, x) => s + x * x, 0) / fan.length);
    const s = session();
    s.hear(audio.map((x, i) => x + fan[i] * gain));
    s.end();
    const u = s.events.find(e => e.type === "utterance")!;
    expect(u).toMatchObject({ window: "wake", cut: true });
    expect(u.at / 1000 - 3).toBeGreaterThan(9.5); // at the cap (10 s of speech), not at a softer word
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

  // The test-only Ryan voice reads the prompts (node scripts/voice/prepare.mjs --voice ryan): skipped without it.
  const readerVoice = path.join(dir, "vits-piper-en_US-ryan-low");
  it.skipIf(!fs.existsSync(path.join(readerVoice, "en_US-ryan-low.onnx")))("learns the owner's voice, not a screen reader's reading each prompt aloud 14 dB down just before each phrase (voice-listening-r4-1)", async () => {
    // Over speakers, the teaching microphone heard Home's prompts as a screen reader read them, and took them for
    // phrases: the owner's held-out clips then scored 0.47-0.66 against the voiceprint, the screen reader's 0.70-0.82.
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
    const tts = sherpa.createOfflineTts({ offlineTtsModelConfig: { offlineTtsVitsModelConfig: { model: path.join(readerVoice, "en_US-ryan-low.onnx"), tokens: path.join(readerVoice, "tokens.txt"), dataDir: path.join(readerVoice, "espeak-ng-data") }, numThreads: 1, debug: 0 }, maxNumSentences: 1 });
    const spoken = new Map<string, Float32Array>();
    const rms = (x: Float32Array) => Math.sqrt(x.reduce((n, v) => n + v * v, 0) / x.length);
    const owner = ["wake", "dnd", "chat", "remember"].map(trimmed);
    /** What a screen reader says (match-copy.ts's prompts), 14 dB under the owner's voice. */
    const reads = (text: string) => {
      let samples = spoken.get(text);
      if (!samples) {
        const raw: Float32Array = tts.generate({ text, sid: 0, speed: 1 }).samples;
        let a = 0, b = raw.length;
        while (a < b && Math.abs(raw[a]) < 0.01) a++;
        while (b > a && Math.abs(raw[b - 1]) < 0.01) b--;
        const level = (rms(owner[0]) / rms(raw.subarray(a, b))) * 10 ** (-14 / 20);
        samples = raw.slice(a, b).map(x => x * level);
        spoken.set(text, samples);
      }
      return samples;
    };
    const phrase = ["Ember, what's the weather like today?", "Hey Ember, open my calendar.", "Ember, turn on Do Not Disturb.", "Ember, set a timer for ten minutes."];
    const prompt = (st: EnrolState) => {
      const say = st.state === "again" ? { short: "That was too short. Say it again:", unlike: "That didn't sound like the others (another voice, or noise). Say it again:", failed: "Ember couldn't hear that clearly. Say it again:", over: "Your screen reader was still reading. Wait for it to finish, then say:" }[st.why] : "Say:";
      return `${st.state === "heard" ? `Heard ${st.got} of ${st.of}. ` : ""}${say} ${phrase[Math.min(st.got, 3)]}`;
    };
    // The room as it goes: each prompt read 0.4 s after it shows, the owner's phrase 0.7 s after the reading ends (said
    // again when nothing came of it for 6 s), the voice process's VAD dating each segment from where it heard speech begin.
    let t = 0;
    const scene: { from: number; samples: Float32Array }[] = [];
    const playAt = (samples: Float32Array, ms: number) => { scene.push({ from: at(ms / 1000), samples }); return ms + samples.length / 16; };
    /** The phrase the owner said last, and when it ends (ms). */
    const owed: { phrase: { i: number; at: number } | null } = { phrase: null };
    let told = 0;
    const states: EnrolState[] = [];
    const enrol = new Enrolment(printer, st => {
      states.push(st);
      told = t;
      if (st.state === "done" || st.state === "cancelled") return;
      const i = Math.min(st.got, 3);
      owed.phrase = { i, at: playAt(owner[i], playAt(reads(prompt(st)), t + 400) + 700) };
    }, 4, { quietMs: 600_000, totalMs: 600_000 }, { said: samples => backend.transcribe(samples), now: () => t });
    let from: number | null = null;
    let seed = 5;
    try {
      for (let n = 0; t < 120_000 && !enrol.done; n++) {
        const frame = new Float32Array(512);
        for (const c of scene) for (let k = 0; k < 512; k++) { const j = n * 512 + k - c.from; if (j >= 0 && j < c.samples.length) frame[k] += c.samples[j]; }
        for (let k = 0; k < 512; k++) frame[k] += ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 0.001 / 0.2887;
        for (const seg of backend.vad(frame)) { await enrol.heard(seg, from ?? t); from = null; }
        if (!backend.speaking()) from = null;
        // (As the voice process does: speech beginning means a phrase said as its prompt showed is followed by more.)
        else if (from === null) { from = t; enrol.speechBegan(); }
        t += 32;
        const w = owed.phrase;
        if (w && t > w.at + 6000 && told < w.at) owed.phrase = { i: w.i, at: playAt(owner[w.i], t) };
      }
    } finally { backend.resetVad(); }
    const done = states.find(st => st.state === "done") as Extract<EnrolState, { state: "done" }> | undefined;
    expect(done, states.map(st => st.state).join(" ")).toBeDefined();
    for (const clip of ["followup", "bigger"]) expect(similarity(await printer.print(read(clip)), done!.print)).toBeGreaterThanOrEqual(VOICE_MATCH_THRESHOLD);
    expect(similarity(await printer.print(reads("Ember, what time is my next meeting?")), done!.print)).toBeLessThan(VOICE_MATCH_THRESHOLD);
  }, 240_000);
});
