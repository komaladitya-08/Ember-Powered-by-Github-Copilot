/**
 * Voice Match: the features the voiceprint model takes (against kaldi-native-fbank's own numbers), the voiceprint
 * helpers, the gate that holds each request until its voice is checked, enrolment, and where the voiceprint is kept.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { fbank } from "../../app/voice/fbank";
import { APPROVAL_MIN_SECONDS, Enrolment, VoiceGate, afterWakePhrase, voicedSeconds, type EnrolState, type Printer } from "../../app/voice/match";
import { VOICE_MATCH_THRESHOLD, averagePrint, consistentPrints, decodePrint, encodePrint, similarity, unit } from "../../app/voice/voiceprint";
import { voiceprintStore } from "../../app/main/voiceprint-store";
import type { VoiceEvent } from "../../app/voice/engine";

const sherpa = createRequire(import.meta.url)("sherpa-onnx");

describe("fbank", () => {
  it("matches kaldi-native-fbank (80 bins, no dither, edges not snipped, 20 Hz to 7.6 kHz)", () => {
    const f = fbank(sherpa.readWave("test/fixtures/voice/wake.wav").samples as Float32Array);
    expect(f).toHaveLength(339);
    // kaldi_native_fbank.OnlineFbank with those options, on the same clip.
    const pick = (r: Float32Array) => [r[0], r[10], r[40], r[79]];
    pick(f[150]).forEach((v, i) => expect(v).toBeCloseTo([-12.7967, -9.8544, -4.3495, 0.2394][i], 2));
    pick(f[200]).forEach((v, i) => expect(v).toBeCloseTo([-8.95, -2.5435, 1.7618, -4.2843][i], 2));
  });
});

describe("voiceprints", () => {
  const v = (...x: number[]) => Float32Array.from(x);

  it("compares by the angle between them, whatever their length", () => {
    expect(similarity(v(1, 0), v(5, 0))).toBeCloseTo(1);
    expect(similarity(v(1, 0), v(0, 2))).toBeCloseTo(0);
    expect(similarity(v(1, 0), v(1, 2, 3))).toBe(0);
  });

  it("averages phrases made unit length first, so a loud one doesn't count for more", () => {
    expect(Array.from(averagePrint([v(10, 0), v(0, 1)]))).toEqual([Math.SQRT1_2, Math.SQRT1_2].map(x => expect.closeTo(x, 5)));
  });

  it("drops the one phrase unlike the others (another voice, or noise)", () => {
    const owner = [v(1, 0.1, 0), v(1, 0, 0.1), v(1, 0.05, 0.05)];
    expect(consistentPrints(owner)).toEqual({ keep: [0, 1, 2], dropped: null });
    expect(consistentPrints([...owner, v(0, 1, 0)])).toEqual({ keep: [0, 1, 2], dropped: 3 });
  });

  it("stores as base64 and reads back only a whole, finite voiceprint", () => {
    const p = unit(Float32Array.from({ length: 256 }, (_, i) => Math.sin(i)));
    expect(Array.from(decodePrint(encodePrint(p))!)).toEqual(Array.from(p));
    expect(decodePrint(encodePrint(p.subarray(0, 100)))).toBeNull();
    expect(decodePrint(encodePrint(new Float32Array(256).fill(Number.NaN)))).toBeNull();
    expect(decodePrint(42)).toBeNull();
  });
});

/** A printer whose voiceprint is the audio's first two samples: a test says whose voice a clip is by them. */
const fakePrinter = (fail = false): Printer => ({ print: async s => { if (fail) throw new Error("no model"); return unit(Float32Array.from([s[0], s[1]])); } });
const owner = unit(Float32Array.from([1, 0]));
const flush = () => new Promise(r => setTimeout(r, 0));
/** `seconds` of a voice at 16 kHz, as fakePrinter hears it (its first two samples: [1, 0.1] the owner's, [0, 1] another's). */
const voice = (seconds: number, [x, y] = [1, 0.1]) => { const a = new Float32Array(Math.round(seconds * 16_000)); for (let i = 0; i + 1 < a.length; i += 2) { a[i] = x; a[i + 1] = y; } return a; };
const ownerAudio = (seconds: number) => voice(seconds);
const joined = (...parts: Float32Array[]) => { const a = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { a.set(p, at); at += p.length; } return a; };

describe("VoiceGate", () => {
  const utterance = (text: string): VoiceEvent => ({ type: "utterance", text, ms: 100, window: "wake" });

  it("lets every voice through while Voice Match is off", () => {
    const sent: VoiceEvent[] = [];
    const g = new VoiceGate(() => fakePrinter(), e => sent.push(e), () => undefined);
    g.event(utterance("Open the terminal."), Float32Array.from([0, 1]));
    expect(sent).toEqual([utterance("Open the terminal.")]);
  });

  it("sends the owner's request marked verified, and turns another voice's away as a wake taken back (in order)", async () => {
    const sent: VoiceEvent[] = [];
    const g = new VoiceGate(() => fakePrinter(), e => sent.push(e), () => undefined);
    g.setOwner(owner);
    g.event(utterance("Someone else."), Float32Array.from([0, 1]));
    g.event(utterance("The owner."), ownerAudio(APPROVAL_MIN_SECONDS + 0.1));
    expect(sent).toEqual([]);
    await flush();
    expect(sent).toEqual([
      { type: "rejected", keyword: "", reason: "voice", score: 0 },
      { type: "listening", on: false, reason: "rejected", window: "wake" },
      // Verified: only such a request may answer a question with a spoken yes (voice-answer.ts).
      { ...utterance("The owner."), verified: true },
    ]);
    expect(similarity(Float32Array.from([1, 0.1]), owner)).toBeGreaterThanOrEqual(VOICE_MATCH_THRESHOLD);
  });

  it("vouches for the owner's voice only with enough of it: a short match is heard but marked short, never verified (security review of #127)", async () => {
    const sent: VoiceEvent[] = [];
    const g = new VoiceGate(() => fakePrinter(), e => sent.push(e), () => undefined);
    g.setOwner(owner);
    g.event(utterance("Allow."), ownerAudio(0.4));
    await flush();
    expect(sent).toEqual([{ ...utterance("Allow."), short: true }]);
  });

  it("counts voiced frames, not samples: half a second of the owner's voice padded with silence is short (security review of #127)", async () => {
    const sent: VoiceEvent[] = [];
    const g = new VoiceGate(() => fakePrinter(), e => sent.push(e), () => undefined);
    g.setOwner(owner);
    g.event(utterance("Allow."), joined(ownerAudio(0.5), new Float32Array(16_000 * 1.1)));
    await flush();
    expect(sent).toEqual([{ ...utterance("Allow."), short: true }]);
    expect(voicedSeconds(joined(ownerAudio(0.5), new Float32Array(16_000 * 1.1)))).toBeLessThan(0.6);
    expect(voicedSeconds(ownerAudio(1.6))).toBeGreaterThanOrEqual(APPROVAL_MIN_SECONDS);
  });

  it("vouches only for what follows the wake phrase, on its own: a recorded “Hey Ember” can't make up the voice (security review of #127)", async () => {
    // The owner's "Hey Ember" (0.8 s) then a short "allow": what follows isn't enough.
    const short: VoiceEvent[] = [];
    const g1 = new VoiceGate(() => fakePrinter(), e => short.push(e), () => undefined);
    g1.setOwner(owner);
    g1.event(utterance("Allow."), joined(ownerAudio(0.8), ownerAudio(0.6)), true);
    await flush();
    expect(short).toEqual([{ ...utterance("Allow."), short: true }]);
    // The owner's "Hey Ember", then another voice at length: heard (the clip starts as the owner's), never verified.
    const other: VoiceEvent[] = [];
    const g2 = new VoiceGate(() => fakePrinter(), e => other.push(e), () => undefined);
    g2.setOwner(owner);
    g2.event(utterance("Yes, go ahead and allow it."), joined(ownerAudio(0.8), voice(1.8, [0, 1])), true);
    await flush();
    expect(other).toEqual([{ ...utterance("Yes, go ahead and allow it."), short: true }]);
    // The owner throughout, at length: verified.
    const own: VoiceEvent[] = [];
    const g3 = new VoiceGate(() => fakePrinter(), e => own.push(e), () => undefined);
    g3.setOwner(owner);
    g3.event(utterance("Yes, go ahead and allow it."), ownerAudio(2.6), true);
    await flush();
    expect(own).toEqual([{ ...utterance("Yes, go ahead and allow it."), verified: true }]);
    // Without the wake phrase in the clip, all of it counts.
    expect(afterWakePhrase(ownerAudio(2), false).length).toBe(32_000);
    expect(voicedSeconds(afterWakePhrase(ownerAudio(2), true))).toBeCloseTo(1.2, 1);
  });

  it("never holds a stop, or anything that isn't a request", () => {
    const sent: VoiceEvent[] = [];
    const g = new VoiceGate(() => fakePrinter(), e => sent.push(e), () => undefined);
    g.setOwner(owner);
    g.event({ type: "stop" }, null);
    g.event({ type: "wake", keyword: "ember" }, null);
    expect(sent).toEqual([{ type: "stop" }, { type: "wake", keyword: "ember" }]);
  });

  it("hears the request when the model fails (Voice Match failing never leaves Ember deaf), unverified, and says so", async () => {
    const sent: VoiceEvent[] = [], errors: unknown[] = [];
    const g = new VoiceGate(() => fakePrinter(true), e => sent.push(e), err => errors.push(err));
    g.setOwner(owner);
    g.event(utterance("Open the terminal."), Float32Array.from([0, 1]));
    await flush();
    expect(sent).toEqual([utterance("Open the terminal.")]);
    expect(errors).toHaveLength(1);
  });
});

describe("VoiceGate's first look, at the wake phrase", () => {
  const wake: VoiceEvent = { type: "wake", keyword: "hey_ember" };
  const on: VoiceEvent = { type: "listening", on: true, reason: "wake", window: "wake" };
  const off: VoiceEvent = { type: "listening", on: false, reason: "stop", window: "wake" };

  it("shows the owner's wake once it looked, with what came meanwhile, in order", async () => {
    const sent: VoiceEvent[] = [];
    const g = new VoiceGate(() => fakePrinter(), e => sent.push(e), () => undefined);
    g.setOwner(owner);
    g.event(wake, Float32Array.from([1, 0.2]));
    g.event(on, null);
    expect(sent).toEqual([]);
    await flush();
    expect(sent).toEqual([wake, on]);
  });

  it("turns another voice away before Ember shows it listens, and ends its window unseen", async () => {
    const sent: VoiceEvent[] = [];
    let cancelled = 0;
    const g: VoiceGate = new VoiceGate(() => fakePrinter(), e => sent.push(e), () => undefined, undefined, () => { cancelled++; g.event(off, null); });
    g.setOwner(owner);
    g.event(wake, Float32Array.from([0, 1]));
    g.event(on, null);
    await flush();
    expect(sent).toEqual([{ type: "rejected", keyword: "hey_ember", reason: "voice", score: 0 }]);
    expect(cancelled).toBe(1);
    // The next window is heard as usual.
    g.event({ type: "stop" }, null);
    expect(sent.at(-1)).toEqual({ type: "stop" });
  });

  it("lets a stop through at once while it looks", () => {
    const sent: VoiceEvent[] = [];
    const g = new VoiceGate(() => fakePrinter(), e => sent.push(e), () => undefined);
    g.setOwner(owner);
    g.event(wake, Float32Array.from([0, 1]));
    g.event({ type: "stop" }, null);
    expect(sent).toEqual([{ type: "stop" }]);
  });

  it("doesn't look at a bare-name wake (it shows with its request, which is checked)", () => {
    const sent: VoiceEvent[] = [];
    const g = new VoiceGate(() => fakePrinter(), e => sent.push(e), () => undefined);
    g.setOwner(owner);
    g.event({ type: "wake", keyword: "ember" }, Float32Array.from([0, 1]));
    expect(sent).toEqual([{ type: "wake", keyword: "ember" }]);
  });
});

describe("Enrolment", () => {
  const phrase = (a: number, b: number) => { const s = new Float32Array(16_000 * 2); s[0] = a; s[1] = b; return s; };

  it("keeps four phrases of one voice, asks again for a short one and an unlike one, and makes their voiceprint", async () => {
    const states: EnrolState[] = [];
    const e = new Enrolment(fakePrinter(), s => states.push(s), 4);
    await e.heard(phrase(1, 0.1));
    await e.heard(new Float32Array(8000)); // half a second
    await e.heard(phrase(1, 0));
    await e.heard(phrase(1, 0.05));
    await e.heard(phrase(0, 1)); // someone else
    await e.heard(phrase(1, 0.02));
    expect(states.map(s => s.state + ("why" in s ? `:${s.why}` : ""))).toEqual(["listening", "heard", "again:short", "heard", "heard", "again:unlike", "done"]);
    const done = states.at(-1) as Extract<EnrolState, { state: "done" }>;
    expect(similarity(done.print, owner)).toBeGreaterThan(0.99);
    expect(e.done).toBe(true);
  });

  it("gives up after three phrases' worth of tries each", async () => {
    const states: EnrolState[] = [];
    const e = new Enrolment(fakePrinter(true), s => states.push(s), 2);
    for (let i = 0; i < 8; i++) await e.heard(phrase(1, 0));
    expect(states.at(-1)?.state).toBe("cancelled");
  });
});

describe("voiceprintStore", () => {
  it("keeps the voiceprint apart, readable by the user alone, for the model that made it; forgetting deletes it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-print-"));
    try {
      const p = encodePrint(unit(Float32Array.from({ length: 256 }, (_, i) => i + 1)));
      const store = voiceprintStore(dir, "model-a.onnx");
      expect(store.read()).toBeNull();
      store.write(p);
      expect(store.read()).toBe(p);
      if (process.platform !== "win32") expect(fs.statSync(path.join(dir, "voiceprint.json")).mode & 0o777).toBe(0o600);
      expect(voiceprintStore(dir, "model-b.onnx").read()).toBeNull();
      store.forget();
      expect(store.read()).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
