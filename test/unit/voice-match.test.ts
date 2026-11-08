/**
 * Voice Match: the features the voiceprint model takes (against kaldi-native-fbank's own numbers), the voiceprint
 * helpers, the gate that holds each request until its voice is checked, enrolment, and where the voiceprint is kept.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { fbank } from "../../app/voice/fbank";
import { APPROVAL_MIN_SECONDS, ENROL_LIMITS, Enrolment, VoiceGate, afterWakePhrase, voicedSeconds, type EnrolState, type Printer } from "../../app/voice/match";
import { VOICE_MATCH_THRESHOLD, averagePrint, consistentPrints, decodePrint, encodePrint, similarity, unit } from "../../app/voice/voiceprint";
import { voiceprintStore } from "../../app/main/voiceprint-store";
import { PERSONAL_TEXT } from "../../app/renderer/home/copy";
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

  it("hears nothing said over a song with no name while Voice Match is off (it can't tell the singer from the owner), and says it dropped it (voice-listening-10)", () => {
    const sent: VoiceEvent[] = [];
    const g = new VoiceGate(() => fakePrinter(), e => sent.push(e), () => undefined);
    g.event({ ...utterance("Dancing in the moonlight."), overSound: true } as VoiceEvent, Float32Array.from([0, 1]));
    expect(sent).toEqual([{ type: "dropped", reason: "over-sound" }]);
  });

  it("over a song with no name, hears the owner and drops any other voice without a word against it (only that it was dropped; voice-listening-10)", async () => {
    const sent: VoiceEvent[] = [];
    const g = new VoiceGate(() => fakePrinter(), e => sent.push(e), () => undefined);
    g.setOwner(owner);
    g.event({ ...utterance("Dancing in the moonlight."), overSound: true } as VoiceEvent, Float32Array.from([0, 1]));
    g.event({ ...utterance("Turn it down."), overSound: true } as VoiceEvent, ownerAudio(APPROVAL_MIN_SECONDS + 0.1));
    await flush();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ type: "dropped", reason: "over-sound" });
    expect(sent[1]).toMatchObject({ type: "utterance", text: "Turn it down." });
    expect(sent.some(e => e.type === "rejected")).toBe(false);
  });

  it("says once a conversation, on the status line, that what was said over the music wasn't heard, and the hint says to use the name (voice-listening-10)", () => {
    const main = fs.readFileSync(new URL("../../app/main/main.ts", import.meta.url), "utf8");
    expect(main).toContain('const OVER_SOUND_STATUS = "Music or a video is playing: say “Ember” first.";');
    expect(main).toMatch(/case "dropped":\s*if \(!conversing \|\| overSoundSaid \|\| statusBy\.listen !== CONVERSATION_STATUS\) break;\s*overSoundSaid = true;\s*setStatus\("listen", OVER_SOUND_STATUS\);/);
    expect(main).toContain("if (on !== conversing) overSoundSaid = false;");
    expect(PERSONAL_TEXT.conversationHint).toContain("no name needed after the first time (while music or a video plays, start with “Ember”)");
  });

  it("lets every voice through while Voice Match is off", () => {
    const sent: VoiceEvent[] = [];
    const g = new VoiceGate(() => fakePrinter(), e => sent.push(e), () => undefined);
    g.event(utterance("Open the terminal."), Float32Array.from([0, 1]));
    expect(sent).toEqual([utterance("Open the terminal.")]);
  });

  it("sends the owner's request marked verified, and hears another voice's unverified (in order)", async () => {
    const sent: VoiceEvent[] = [];
    const g = new VoiceGate(() => fakePrinter(), e => sent.push(e), () => undefined);
    g.setOwner(owner);
    g.event(utterance("Someone else."), Float32Array.from([0, 1]));
    g.event(utterance("The owner."), ownerAudio(APPROVAL_MIN_SECONDS + 0.1));
    expect(sent).toEqual([]);
    await flush();
    expect(sent).toEqual([
      { type: "rejected", keyword: "", reason: "voice", score: 0 },
      utterance("Someone else."),
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
    // Too little of it even to score: short, with no score of its own.
    g.event(utterance("Yes."), ownerAudio(0.2));
    await flush();
    // (No wake phrase in it: the whole was scored, and that is its own score.)
    expect(sent).toEqual([{ ...utterance("Allow."), short: true, restScore: expect.closeTo(0.995, 3) }, { ...utterance("Yes."), short: true }]);
    expect(APPROVAL_MIN_SECONDS).toBe(0.5); // owner decision of 2026-11-03 (was 1.5 s)
  });

  it("counts voiced frames, not samples: half a second of the owner's voice padded with silence is short (security review of #127)", async () => {
    const sent: VoiceEvent[] = [];
    const g = new VoiceGate(() => fakePrinter(), e => sent.push(e), () => undefined);
    g.setOwner(owner);
    g.event(utterance("Allow."), joined(ownerAudio(0.4), new Float32Array(16_000 * 1.1)));
    await flush();
    expect(sent).toEqual([{ ...utterance("Allow."), short: true, restScore: expect.closeTo(0.995, 3) }]);
    expect(voicedSeconds(joined(ownerAudio(0.4), new Float32Array(16_000 * 1.1)))).toBeLessThan(APPROVAL_MIN_SECONDS);
    expect(voicedSeconds(ownerAudio(0.6))).toBeGreaterThanOrEqual(APPROVAL_MIN_SECONDS);
  });

  it("vouches only for what follows the wake phrase, on its own: a recorded “Hey Ember” can't make up the voice (security review of #127)", async () => {
    // The owner's "Hey Ember" (0.8 s) then a short "allow": what follows isn't enough, and says its own score.
    const short: VoiceEvent[] = [];
    const g1 = new VoiceGate(() => fakePrinter(), e => short.push(e), () => undefined);
    g1.setOwner(owner);
    g1.event(utterance("Allow."), joined(ownerAudio(0.8), ownerAudio(0.35)), true);
    await flush();
    expect(short).toEqual([{ ...utterance("Allow."), short: true, restScore: expect.closeTo(0.995, 3) }]);
    // The owner's "Hey Ember", then another voice: heard (the clip starts as the owner's), never verified, and its own
    // score says it is another voice (what task-voice trust refuses: voice-answer.ts SHORT_YES_FLOOR).
    const other: VoiceEvent[] = [];
    const g2 = new VoiceGate(() => fakePrinter(), e => other.push(e), () => undefined);
    g2.setOwner(owner);
    g2.event(utterance("Yes, go ahead and allow it."), joined(ownerAudio(0.8), voice(1.8, [0, 1])), true);
    g2.event(utterance("Allow."), joined(ownerAudio(0.8), voice(0.4, [0, 1])), true);
    await flush();
    expect(other).toEqual([{ ...utterance("Yes, go ahead and allow it."), short: true, restScore: 0 }, { ...utterance("Allow."), short: true, restScore: 0 }]);
    // The owner's "Hey Ember", then the owner's own half-second "go ahead": verified now (APPROVAL_MIN_SECONDS).
    const half: VoiceEvent[] = [];
    const g4 = new VoiceGate(() => fakePrinter(), e => half.push(e), () => undefined);
    g4.setOwner(owner);
    g4.event(utterance("Go ahead."), joined(ownerAudio(0.8), ownerAudio(0.6)), true);
    await flush();
    expect(half).toEqual([{ ...utterance("Go ahead."), verified: true }]);
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

  it("scores what follows the wake phrase unrounded, and none at all when it is very quiet next to a loud “Hey Ember” (security review of #143)", async () => {
    const sent: VoiceEvent[] = [];
    const g = new VoiceGate(() => fakePrinter(), e => sent.push(e), () => undefined);
    g.setOwner(owner);
    // A score between 0.4996 and 0.5 mustn't reach main as 0.5 (the floor's own value): the number goes out as it is.
    const closeCall = Float32Array.from([1, 1.7321]); // cosine to the owner's [1, 0]: 0.49998…
    g.event(utterance("Allow."), joined(ownerAudio(0.8), voice(0.4, [1, 1.7321])), true);
    // The recorded wake phrase loud, then a quiet, clipped “yes” with no voiced frame of its own: nothing to score.
    const quiet = voice(0.6, [0, 1]).map(x => x * 0.002); // under the voiced floor (VOICED_RMS 0.003)
    g.event(utterance("Allow."), joined(ownerAudio(0.8), quiet), true);
    await flush();
    const [first, second] = sent as Extract<VoiceEvent, { type: "utterance" }>[];
    // (Whole clip matches the owner through its wake phrase: its first samples are the owner's.)
    expect(first.short).toBe(true);
    expect(first.restScore).toBeCloseTo(similarity(closeCall, owner), 6);
    expect(first.restScore!).toBeLessThan(0.5);
    expect(Math.round(first.restScore! * 1000) / 1000).toBe(0.5); // rounded, it would have met the floor
    expect(second).toEqual({ ...utterance("Allow."), short: true });
    expect(voicedSeconds(afterWakePhrase(joined(ownerAudio(0.8), quiet), true))).toBeLessThan(0.25);
  });

  it("never holds a stop, or anything that isn't a request", () => {
    const sent: VoiceEvent[] = [];
    const g = new VoiceGate(() => fakePrinter(), e => sent.push(e), () => undefined);
    g.setOwner(owner);
    g.event({ type: "stop" }, null);
    g.event({ type: "wake", keyword: "ember" }, null);
    expect(sent).toEqual([{ type: "stop" }, { type: "wake", keyword: "ember" }]);
  });

  it("survives a later request's check failing while an earlier one is still being checked (no unhandled rejection ends the voice process)", async () => {
    const unhandled: unknown[] = [];
    const note = (r: unknown) => unhandled.push(r);
    process.on("unhandledRejection", note);
    try {
      let calls = 0;
      // The first check is slow; the second fails at once (the voiceprint thread answered it with an error).
      const printer: Printer = { print: s => ++calls === 1 ? new Promise(r => setTimeout(() => r(unit(Float32Array.from([s[0], s[1]]))), 30)) : Promise.reject(new Error("no voiceprint")) };
      const sent: VoiceEvent[] = [], errors: unknown[] = [];
      const g = new VoiceGate(() => printer, e => sent.push(e), err => errors.push(err));
      g.setOwner(owner);
      g.event(utterance("Someone else."), Float32Array.from([0, 1]));
      g.event(utterance("Open the files."), Float32Array.from([0, 1]));
      await new Promise(r => setTimeout(r, 60));
      expect(unhandled).toEqual([]);
      // Both are dealt with in order: the first unmatched and heard, the second heard unverified with the failure reported.
      expect(sent.map(e => e.type)).toEqual(["rejected", "utterance", "utterance"]);
      expect(errors).toHaveLength(1);
    } finally {
      process.off("unhandledRejection", note);
    }
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

  it("learns nothing from a screen reader reading its prompts aloud, and asks again when the owner's phrase ran into the reading (voice-listening-r4-1)", async () => {
    // Home tells screen readers each prompt ("Say: “Ember, what's the weather like today?”", "Heard 1 of 4. Say: …"),
    // and over speakers the teaching microphone heard it: on the real models the voiceprint came out mostly the screen
    // reader's, which Voice Match then took for the owner, and the owner's own phrases scored 0.47-0.66 (threshold 0.75).
    let now = 0;
    const words = new Map<Float32Array, string>();
    const said = (text: string, a = 1, b = 0) => { const s = phrase(a, b); words.set(s, text); return s; };
    const printed: Float32Array[] = [];
    const printer = fakePrinter();
    const counting: Printer = { print: s => { printed.push(s); return printer.print(s); } };
    const states: EnrolState[] = [];
    const e = new Enrolment(counting, s => states.push(s), 4, ENROL_LIMITS, { said: s => words.get(s) ?? "", now: () => now });
    // The reading starts as the prompt shows: never the owner, who first has to hear which phrase to say.
    await e.heard(said("Say, Ember, what's the weather like today?", 0, 1), 400);
    // Read slowly, its second part begins later, in the prompt's own words.
    await e.heard(said("Say. Ember, what's the weather like today?", 0, 1), 2400);
    await e.heard(said("That was too short. Say it again.", 0, 1), 2900);
    const first = said("Ember, what's the weather like today?");
    now = 4000;
    await e.heard(first, 3800);
    expect(states.map(s => s.state)).toEqual(["listening", "heard"]);
    // The owner answered so soon after the reading that the two came as one segment: said again, never learnt.
    now = 6000;
    await e.heard(said("Heard 1 of 4. Say, hey Ember, open my calendar. Hey Ember, open my calendar.", 0.5, 0.5), 4300);
    expect(states.at(-1)).toEqual({ state: "again", got: 1, of: 4, why: "over" });
    await e.heard(said("Your screen reader was still reading. Wait for it to finish, then say, hey Ember, open my calendar.", 0, 1), 6400);
    now = 9000;
    const second = said("Hey Ember, open my calendar.", 1, 0.05);
    await e.heard(second, 8500);
    expect(states.map(s => s.state + ("why" in s ? `:${s.why}` : ""))).toEqual(["listening", "heard", "again:over", "heard"]);
    expect(printed).toEqual([first, second]);
    e.cancel();
  });

  it("asks again, never silently, for a phrase said as soon as its prompt showed with a screen reader on headphones, and waits for the owner after a reading (voice-listening-r5-2)", async () => {
    // A phrase begun under 1.5 s after its prompt was dropped without a word: the prompt stayed as it was, Home said
    // nothing, and the owner was left waiting or said it again with no idea why.
    vi.useFakeTimers();
    try {
      let now = 0;
      const words = new Map<Float32Array, string>();
      const said = (text: string, a = 1, b = 0) => { const s = phrase(a, b); words.set(s, text); return s; };
      const states: EnrolState[] = [];
      const e = new Enrolment(fakePrinter(), s => states.push(s), 4, ENROL_LIMITS, { said: s => words.get(s) ?? "", now: () => now });
      const shown = () => states.map(s => s.state + ("why" in s ? `:${s.why}` : ""));
      // On headphones nothing is read into the microphone: the owner says the phrase 1 s after it showed, then waits.
      now = 3000;
      await e.heard(said("Ember, what's the weather like today?"), 1000);
      expect(shown()).toEqual(["listening"]);
      vi.advanceTimersByTime(4999);
      expect(shown()).toEqual(["listening"]);
      vi.advanceTimersByTime(1);
      expect(states.at(-1)).toEqual({ state: "again", got: 0, of: 4, why: "over" });
      // Said again once the prompt has been read, it is kept.
      now = 12_000;
      await e.heard(said("Ember, what's the weather like today?"), 9000);
      expect(shown()).toEqual(["listening", "again:over", "heard"]);
      // Over speakers, a reading whose first word the recognizer missed sounds like the phrase: the owner's own phrase,
      // begun before the wait is up, is what is heard next, and nothing is asked meanwhile.
      now = 13_400;
      await e.heard(said("Hey Ember, open my calendar.", 0.5, 0.5), 12_300);
      vi.advanceTimersByTime(2000);
      e.speechBegan();
      vi.advanceTimersByTime(10_000);
      expect(shown()).toEqual(["listening", "again:over", "heard"]);
      now = 18_000;
      await e.heard(said("Hey Ember, open my calendar.", 1, 0.05), 15_500);
      expect(shown()).toEqual(["listening", "again:over", "heard", "heard"]);
      // A reading in a prompt's own words, or one that says nothing of the phrase, still asks nothing.
      now = 19_000;
      await e.heard(said("Heard 2 of 4. Say, Ember, turn on Do Not Disturb.", 0, 1), 18_200);
      await e.heard(said("Mm.", 0, 1), 18_600);
      vi.advanceTimersByTime(10_000);
      expect(shown()).toEqual(["listening", "again:over", "heard", "heard"]);
      // Nor does a wait outlast the teaching.
      now = 21_000;
      await e.heard(said("Ember, turn on Do Not Disturb."), 19_200);
      e.cancel();
      vi.advanceTimersByTime(10_000);
      expect(states.at(-1)).toEqual({ state: "cancelled", got: 2, of: 4 });
    } finally { vi.useRealTimers(); }
  });

  it("gives up after three phrases' worth of tries each, and says it gave up rather than that it was cancelled (voice-listening-5)", async () => {
    const states: EnrolState[] = [];
    const e = new Enrolment(fakePrinter(true), s => states.push(s), 2);
    for (let i = 0; i < 8; i++) await e.heard(phrase(1, 0));
    expect(states.at(-1)).toEqual({ state: "cancelled", got: 0, of: 2, why: "gave-up" });
  });

  it("ends teaching that hears no phrase for 45 s, or that goes on for 3 minutes, as timed out (voice-listening-v1)", async () => {
    vi.useFakeTimers();
    try {
      expect(ENROL_LIMITS).toEqual({ quietMs: 45_000, totalMs: 180_000 });
      const quiet: EnrolState[] = [];
      new Enrolment(fakePrinter(), s => quiet.push(s), 4);
      vi.advanceTimersByTime(44_999);
      expect(quiet.map(s => s.state)).toEqual(["listening"]);
      vi.advanceTimersByTime(1);
      expect(quiet.at(-1)).toEqual({ state: "cancelled", got: 0, of: 4, why: "timeout" });
      // Someone keeps the room talking (each segment heard resets the quiet wait), but no voiceprint comes of it.
      const busy: EnrolState[] = [];
      const e = new Enrolment(fakePrinter(), s => busy.push(s), 4);
      for (let t = 0; t < 180_000; t += 30_000) { await e.heard(new Float32Array(8000)); vi.advanceTimersByTime(30_000); }
      expect(busy.at(-1)).toEqual({ state: "cancelled", got: 0, of: 4, why: "timeout" });
      expect(busy.filter(s => s.state === "cancelled")).toHaveLength(1);
      // A user's Cancel says no reason, and ends the timers with it.
      const cancelled: EnrolState[] = [];
      new Enrolment(fakePrinter(), s => cancelled.push(s), 4).cancel();
      vi.advanceTimersByTime(200_000);
      expect(cancelled).toEqual([{ state: "listening", got: 0, of: 4 }, { state: "cancelled", got: 0, of: 4 }]);
    } finally {
      vi.useRealTimers();
    }
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
