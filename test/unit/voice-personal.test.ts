/**
 * Voice personalisation (docs/ASSISTANT.md "Personalisation"): Voice Match that keeps learning and its guards against
 * drift and poisoning, where what it learnt is kept, the transcript corrected against the user's own words (never into
 * a risky request), what the user might say next, and the words Settings and the conversation show.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ADAPT, ADAPT_QUIET_MS, adapt, adaptGuard, adaptedThreshold, fromEnrolment, gateMatches, sane, towards, type SampleContext } from "../../app/voice/adapt";
import { oneVoice } from "../../app/voice/adapt-sample";
import { VoiceGate, type Printer } from "../../app/voice/match";
import { VOICE_MATCH_THRESHOLD, encodePrint, similarity, unit } from "../../app/voice/voiceprint";
import type { VoiceEvent } from "../../app/voice/engine";
import { voiceprintStore } from "../../app/main/voiceprint-store";
import { editDistance, soundKey, soundsLike } from "../../app/main/personal/phonetic";
import { COMMON, correctTranscript, learnFrom, memoryNames, type Lexicon } from "../../app/main/personal/correct";
import { followUpMs, predictNext, type PredictInput } from "../../app/main/personal/predict";
import { PersonalVoice, type PersonalSettings } from "../../app/main/personal/service";
import { wordsStore } from "../../app/main/personal/words-store";
import { isRiskyLabel } from "../../app/main/policy/policy";
import { suggestOf, suggestionsShown, suggestAction, IDLE_BUBBLE } from "../../app/shared/overlay";
import { boxRows } from "../../app/renderer/ask/field";
import { PERSONAL_TEXT, learntText, teachOutcomeText, wordRowText, forgetWordLabel } from "../../app/renderer/home/copy";

/** A seeded random unit voiceprint of 256 numbers. */
function randomPrint(seed: number): Float32Array {
  let r = seed >>> 0 || 1;
  const rnd = () => { r = (r * 1664525 + 1013904223) >>> 0; return r / 2 ** 32 - 0.5; };
  return unit(Float32Array.from({ length: 256 }, rnd));
}
/** A voice `cos` away from `p` (towards another, random one). */
const near = (p: Float32Array, cos: number, seed: number) => towards(p, randomPrint(seed), cos);
const risky = (w: string) => isRiskyLabel(w, "linux");

describe("Voice Match that keeps learning", () => {
  const anchor = randomPrint(1);

  it("learns only from a request that matched well above the threshold, and the enrolment too", () => {
    const st = fromEnrolment(anchor);
    const weak = near(anchor, VOICE_MATCH_THRESHOLD + 0.02, 2);
    expect(adapt(st, weak, similarity(weak, st.print)).outcome).toBe("weak");
    const strong = near(anchor, 0.9, 3);
    const r = adapt(st, strong, similarity(strong, st.print));
    expect(r.outcome).toBe("learnt");
    expect(r.state.clips).toHaveLength(1);
    expect(r.state.anchor).toBe(st.anchor);
    // A sample that scores well against a print but not against the enrolment isn't learnt (the print can't walk away).
    const moved = { ...st, print: near(anchor, 0.9, 4) };
    const elsewhere = near(moved.print, 0.95, 5);
    if (similarity(elsewhere, anchor) < ADAPT.anchorMatch) expect(adapt(moved, elsewhere, 0.95).outcome).toBe("unlike-enrolment");
  });

  it("moves the print at most ADAPT.maxStep a sample, and keeps at most ADAPT.maxClips samples", () => {
    let st = fromEnrolment(anchor);
    for (let i = 0; i < 40; i++) {
      const s = near(anchor, 0.86, 100 + i);
      const before = st.print;
      st = adapt(st, s, Math.max(similarity(s, st.print), VOICE_MATCH_THRESHOLD + ADAPT.margin)).state;
      expect(1 - similarity(before, st.print)).toBeLessThanOrEqual(ADAPT.maxStep + 1e-4);
    }
    expect(st.clips).toHaveLength(ADAPT.maxClips);
  });

  it("can't be carried away from the enrolment: 1,000 crafted samples just over the margin leave it within ADAPT.anchorMin (drift attack)", () => {
    const attacker = randomPrint(7);
    let st = fromEnrolment(anchor);
    for (let i = 0; i < 1000; i++) {
      const sample = towards(st.print, attacker, VOICE_MATCH_THRESHOLD + ADAPT.margin + 0.001);
      st = adapt(st, sample, similarity(sample, st.print)).state;
    }
    expect(similarity(st.print, anchor)).toBeGreaterThanOrEqual(ADAPT.anchorMin - 1e-4);
    // The attacker's own voice is no nearer to being let in.
    expect(similarity(attacker, st.print)).toBeLessThan(VOICE_MATCH_THRESHOLD);
  });

  it("learns nothing from samples just under the threshold, however many (drift attack)", () => {
    const attacker = randomPrint(8);
    let st = fromEnrolment(anchor);
    for (let i = 0; i < 500; i++) {
      const sample = towards(st.print, attacker, VOICE_MATCH_THRESHOLD - 0.01);
      st = adapt(st, sample, similarity(sample, st.print)).state;
    }
    expect(st.print).toBe(st.anchor);
    expect(st.clips).toHaveLength(0);
  });

  it("asks more of a print that learnt (it matches every voice a little more), and the enrolment's match too", () => {
    expect(adaptedThreshold(0)).toBe(VOICE_MATCH_THRESHOLD);
    expect(adaptedThreshold(ADAPT.raiseClips / 2)).toBeCloseTo(VOICE_MATCH_THRESHOLD + ADAPT.raise / 2);
    expect(adaptedThreshold(ADAPT.maxClips)).toBeCloseTo(VOICE_MATCH_THRESHOLD + ADAPT.raise);
    const print = near(anchor, 0.97, 30);
    // Close to the print but not to the enrolment: turned away once something was learnt.
    const drifted = towards(print, near(print, 0.5, 31), 0.8);
    if (similarity(drifted, anchor) < ADAPT.anchorFloor) {
      expect(gateMatches(drifted, print, 0.75, null)).toBe(true);
      expect(gateMatches(drifted, print, 0.75, anchor)).toBe(false);
    }
    expect(gateMatches(anchor, print, adaptedThreshold(ADAPT.maxClips), anchor)).toBe(true);
  });

  it("checks a request against the enrolment too once the print learnt (VoiceGate)", async () => {
    const sent: VoiceEvent[] = [];
    // The printer reads a clip's voiceprint from a table (its first sample says which).
    // The print learnt as far as it may (ADAPT.anchorMin) towards one voice; a stranger further along the same way.
    const away = randomPrint(41);
    const prints = [anchor, towards(anchor, away, ADAPT.anchorMin)];
    const printer: Printer = { print: async s => prints[Math.round(s[0])] ?? prints[0] };
    const g = new VoiceGate(() => printer, e => sent.push(e), () => undefined);
    const learntPrint = prints[1];
    const stranger = towards(learntPrint, away, 0.8);
    prints.push(stranger);
    g.setOwner(learntPrint, { anchor, threshold: adaptedThreshold(ADAPT.maxClips) });
    const clip = (n: number) => new Float32Array(16_000 * 2).fill(n);
    g.event({ type: "utterance", text: "Stranger.", ms: 100, window: "follow-up" }, clip(2));
    g.event({ type: "utterance", text: "Owner.", ms: 100, window: "follow-up" }, clip(0));
    await new Promise(r => setTimeout(r, 0));
    expect(sent.map(e => e.type)).toEqual(["rejected", "listening", "utterance"]);
  });

  it("puts a print out of reach of the enrolment (a changed file) back within reach", () => {
    const far = { anchor, clips: [], print: randomPrint(9) };
    expect(similarity(sane(far).print, anchor)).toBeGreaterThanOrEqual(ADAPT.anchorMin - 1e-4);
    const ok = adapt(fromEnrolment(anchor), near(anchor, 0.9, 10), 0.9).state;
    expect(sane(ok).print).toBe(ok.print);
  });

  it("learns from nothing while another voice is about, Ember spoke, the room is busy or a stop came (poisoning guards)", () => {
    const base: SampleContext = { learning: true, matchOn: true, verified: true, selfSpoke: false, strangerNear: false, busyRoom: false, stoppedLately: false, lastAt: 0, now: 1_000_000 };
    expect(adaptGuard(base)).toBeNull();
    expect(adaptGuard({ ...base, learning: false })).toBe("off");
    expect(adaptGuard({ ...base, matchOn: false })).toBe("off");
    expect(adaptGuard({ ...base, verified: false })).toBe("unverified");
    expect(adaptGuard({ ...base, selfSpoke: true })).toBe("self");
    expect(adaptGuard({ ...base, strangerNear: true })).toBe("stranger");
    expect(adaptGuard({ ...base, busyRoom: true })).toBe("busy");
    expect(adaptGuard({ ...base, stoppedLately: true })).toBe("stopped");
    expect(adaptGuard({ ...base, lastAt: base.now - ADAPT.minGapMs + 1 })).toBe("too-soon");
  });
});

describe("a sample's one voice (adapt-sample.ts)", () => {
  const ownerPrint = unit(Float32Array.from([1, 0]));
  // A printer whose voiceprint is the clip's first two samples (as voice-match.test.ts's).
  const printer: Printer = { print: async s => unit(Float32Array.from([s[0], s[1]])) };
  const clip = (seconds: number, [x, y]: number[]) => { const a = new Float32Array(Math.round(seconds * 16_000)); for (let i = 0; i + 1 < a.length; i += 2) { a[i] = x; a[i + 1] = y; } return a; };
  const joined = (a: Float32Array, b: Float32Array) => { const out = new Float32Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };

  it("takes a short request as one voice, and checks a long one half by half", async () => {
    expect(await oneVoice(printer, clip(2, [1, 0.1]), ownerPrint, VOICE_MATCH_THRESHOLD)).toBe(true);
    expect(await oneVoice(printer, clip(4, [1, 0.1]), ownerPrint, VOICE_MATCH_THRESHOLD)).toBe(true);
    // The owner, then someone else talking: not learnt from (a busy room).
    expect(await oneVoice(printer, joined(clip(2, [1, 0.1]), clip(2, [0.1, 1])), ownerPrint, VOICE_MATCH_THRESHOLD)).toBe(false);
  });

  it("is offered only a request the gate verified", async () => {
    const sent: VoiceEvent[] = [];
    const samples: number[] = [];
    const g = new VoiceGate(() => printer, e => sent.push(e), () => undefined);
    g.onSample = (_p, score) => samples.push(score);
    g.setOwner(ownerPrint);
    g.event({ type: "utterance", text: "Owner.", ms: 100, window: "wake" }, clip(2, [1, 0.1]));
    g.event({ type: "utterance", text: "Short.", ms: 100, window: "wake" }, clip(0.5, [1, 0.1]));
    g.event({ type: "utterance", text: "Another.", ms: 100, window: "wake" }, clip(2, [0, 1]));
    await new Promise(r => setTimeout(r, 0));
    expect(sent.map(e => e.type)).toEqual(["utterance", "utterance", "rejected", "listening"]);
    expect(samples).toHaveLength(1);
  });
});

describe("voiceprintStore with what Voice Match learnt", () => {
  it("keeps the enrolment as the anchor and what it learnt beside it, readable by the user alone; resets and forgets", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-print-"));
    try {
      const anchor = randomPrint(11);
      const store = voiceprintStore(dir, "m.onnx");
      store.write(encodePrint(anchor));
      expect(store.learnt()).toEqual({ clips: 0, at: 0 });
      const learnt = adapt(store.state()!, near(anchor, 0.9, 12), 0.9).state;
      store.writeState(learnt, 1234);
      expect(store.read()).toBe(encodePrint(learnt.print));
      expect(store.learnt()).toEqual({ clips: 1, at: 1234 });
      if (process.platform !== "win32") expect(fs.statSync(path.join(dir, "voiceprint.json")).mode & 0o777).toBe(0o600);
      // Numbers only: the file holds base64 voiceprints and a time, nothing else.
      expect(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "voiceprint.json"), "utf8"))).sort()).toEqual(["anchor", "at", "clips", "learntAt", "model", "print", "version"]);
      expect(store.reset()).toBe(true);
      expect(store.read()).toBe(encodePrint(anchor));
      expect(store.learnt().clips).toBe(0);
      store.forget();
      expect(store.read()).toBeNull();
      expect(store.reset()).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a version 1 file as its enrolment alone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-print-"));
    try {
      const p = encodePrint(randomPrint(13));
      fs.writeFileSync(path.join(dir, "voiceprint.json"), JSON.stringify({ version: 1, model: "m.onnx", print: p }));
      const store = voiceprintStore(dir, "m.onnx");
      expect(store.read()).toBe(p);
      expect(store.state()!.clips).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("how alike words sound (phonetic.ts)", () => {
  it("gives near-misses the same sound key", () => {
    expect(soundKey("Priya")).toBe(soundKey("Pria"));
    expect(soundKey("Slack")).toBe(soundKey("slak"));
    expect(soundKey("Philip")).toBe(soundKey("Filip"));
    expect(editDistance("kitten", "sitting")).toBe(3);
  });

  it("scores a near-miss high and a different word low", () => {
    expect(soundsLike("Pria", "Priya")).toBeGreaterThanOrEqual(0.85);
    expect(soundsLike("Spotfy", "Spotify")).toBeGreaterThanOrEqual(0.85);
    expect(soundsLike("close", "Clocks")).toBeLessThan(0.85);
  });
});

describe("the transcript corrected against the user's own words (correct.ts)", () => {
  const lex: Lexicon = {
    entries: [{ text: "Firefox", source: "app" }, { text: "Spotify", source: "app" }, { text: "Clocks", source: "app" }, { text: "Priya", source: "memory" }, { text: "Send Anywhere", source: "app" }],
    learned: [{ heard: "jeera", meant: "Jira" }],
  };

  it("hears Ember's name at the start of a request", () => {
    expect(correctTranscript("Amber, open my calendar.", lex, risky)).toMatchObject({ text: "Ember, open my calendar.", counts: { name: 1 } });
    expect(correctTranscript("Hey Emma, what time is it?", lex, risky).text).toBe("Hey Ember, what time is it?");
    expect(correctTranscript("Tell Amber I'm late.", lex, risky).text).toBe("Tell Amber I'm late.");
  });

  it("corrects an app's or a remembered name's near-miss, and what the user taught", () => {
    expect(correctTranscript("Open Spotfy.", lex, risky)).toMatchObject({ text: "Open Spotify.", counts: { app: 1 } });
    expect(correctTranscript("Open fire fox please", lex, risky).text).toBe("Open Firefox please");
    expect(correctTranscript("Call Pria about lunch.", lex, risky)).toMatchObject({ text: "Call Priya about lunch.", counts: { memory: 1 } });
    expect(correctTranscript("Open jeera.", lex, risky)).toMatchObject({ text: "Open Jira.", counts: { learned: 1 } });
  });

  it("never turns a common word into a name", () => {
    expect(correctTranscript("Close it.", lex, risky).text).toBe("Close it.");
    for (const w of ["close", "files", "open", "send", "note"]) expect(COMMON.has(w)).toBe(true);
  });

  it("leaves a risky request as heard but for the name, and undoes a correction that would make one risky", () => {
    expect(correctTranscript("Amber, send it to Pria.", lex, risky)).toMatchObject({ text: "Ember, send it to Pria.", held: "risky" });
    // "Sand Anywhere" would become "Send Anywhere", which says "send": the raw words go to policy instead.
    const r = correctTranscript("Open Sand Anywhere.", lex, risky);
    expect(risky("Open Send Anywhere.")).toBe(true);
    expect(r).toMatchObject({ text: "Open Sand Anywhere.", held: "newly-risky", counts: {} });
  });

  it("learns a few misheard words from what the user retyped, never a different request or a risky one", () => {
    expect(learnFrom("Open jeera board", "Open Jira board", risky)).toEqual({ heard: "jeera", meant: "Jira" });
    expect(learnFrom("Open the weather", "Close every window on the left", risky)).toBeNull();
    expect(learnFrom("Open the shared folder", "Open the shred folder", risky)).toEqual({ heard: "shared", meant: "shred" });
    expect(learnFrom("Open my mail", "Delete my mail", risky)).toBeNull();
  });

  it("takes names only from what the user said themselves (memory's user facts)", () => {
    expect(memoryNames([{ text: "Priya Raman is my manager", source: "user" }, { text: "Bob likes tea", source: "conversation" }])).toEqual(["Priya Raman"]);
  });
});

describe("what the user might say next (predict.ts)", () => {
  const base: PredictInput = { lastRequest: "", lastReply: "", spoken: true, task: null, history: [], hour: 14, people: [] };

  it("suggests the usual next step", () => {
    expect(predictNext({ ...base, lastRequest: "Open my notes", lastReply: "Opened Notes." }, risky).map(s => s.text)).toContain("Close it");
    expect(predictNext({ ...base, lastRequest: "Turn on night light", lastReply: "Night light is on." }, risky).map(s => s.text)).toContain("Turn night light off");
    expect(predictNext({ ...base, lastRequest: "Summarise this email", lastReply: "x".repeat(80), spoken: false }, risky).map(s => s.text)).toContain("Read it out");
    expect(predictNext({ ...base, lastRequest: "Shall I?", lastReply: "Do you want the PDF too?" }, risky).map(s => s.text)).toEqual(expect.arrayContaining(["Yes, please", "No, thanks"]));
    expect(predictNext({ ...base, lastRequest: "Archive the first email", task: { status: "done" } }, risky).map(s => s.text)).toContain("Do the same for the next one");
  });

  it("never suggests a risky step unless the user's own last words were about it", () => {
    const people = ["Priya"];
    expect(predictNext({ ...base, lastRequest: "Draft a reply to Sam", people }, risky).some(s => risky(s.text))).toBe(false);
    expect(predictNext({ ...base, lastRequest: "Send the report to Sam", people }, risky).map(s => s.text)).toContain("Send it to Priya");
  });

  it("keeps the follow-up window open longer only when a follow-up is likely", () => {
    expect(followUpMs({ lastReply: "Done.", task: null }, [])).toBe(8000);
    expect(followUpMs({ lastReply: "Which one?", task: null }, [])).toBe(12_000);
  });
});

describe("PersonalVoice", () => {
  const make = (set: Partial<PersonalSettings> = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-personal-"));
    const voiceprints = voiceprintStore(dir, "m.onnx");
    const anchor = randomPrint(21);
    voiceprints.write(encodePrint(anchor));
    let now = 10_000_000;
    const events: { event: string; fields?: Record<string, unknown> }[] = [];
    const p = new PersonalVoice({
      log: { info: (event, fields) => events.push({ event, fields }), warn: (event, fields) => events.push({ event, fields }) },
      settings: () => ({ learnVoice: true, matchOn: true, learnWords: true, suggest: true, ...set }),
      voiceprints, words: wordsStore(dir), apps: () => ["Spotify", "Firefox"], memory: () => null, risky, now: () => now,
    });
    return { p, dir, anchor, voiceprints, events, tick: (ms: number) => { now += ms; } };
  };
  const ok = { verified: true, cut: false, selfSpoke: false, locked: false };

  it("learns from a verified request, but not after another voice was turned away, nor twice a minute", () => {
    const { p, dir, anchor, tick } = make();
    try {
      const s = { print: encodePrint(near(anchor, 0.9, 22)), score: 0.9, oneVoice: true };
      expect(p.sample(s, ok)).not.toBeNull();
      expect(p.sample(s, ok)).toBeNull(); // too soon
      tick(ADAPT.minGapMs);
      p.strangerTurnedAway();
      expect(p.sample(s, ok)).toBeNull();
      tick(ADAPT_QUIET_MS);
      expect(p.sample({ ...s, oneVoice: false }, ok)).toBeNull();
      expect(p.sample(s, { ...ok, selfSpoke: true })).toBeNull();
      expect(p.sample(s, null)).toBeNull();
      expect(p.sample(s, ok)).not.toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("learns nothing while Keep learning my voice is off", () => {
    const { p, dir, anchor } = make({ learnVoice: false });
    try {
      expect(p.sample({ print: encodePrint(near(anchor, 0.9, 23)), score: 0.9, oneVoice: true }, ok)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("corrects what it heard, logs counts only, and learns what the user retypes (That's not what I said)", () => {
    const { p, dir, events } = make();
    try {
      const c = p.heard("Open Spotfy.");
      expect(c.text).toBe("Open Spotify.");
      expect(events.find(e => e.event === "voice.corrected")?.fields).toEqual({ app: 1 });
      expect(JSON.stringify(events)).not.toContain("Spotfy");
      p.heard("Open jeera board");
      expect(p.heardItems().map(h => h.shown)).toEqual(["Open Spotify.", "Open jeera board"]);
      expect(p.teach("Open jeera board", "Open Jira board")).toEqual({ outcome: "learnt", word: { heard: "jeera", meant: "Jira" } });
      expect(p.words()).toEqual([expect.objectContaining({ heard: "jeera", meant: "Jira" })]);
      expect(p.heard("Open jeera board").text).toBe("Open Jira board");
      if (process.platform !== "win32") expect(fs.statSync(path.join(dir, "words.json")).mode & 0o777).toBe(0o600);
      expect(p.teach("Nothing heard", "x")).toEqual({ outcome: "unknown" });
      p.forgetWords();
      expect(p.words()).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("predicts only while Suggest is on, and a stop clears what it suggested", () => {
    const on = make();
    const off = make({ suggest: false });
    try {
      on.p.asked("Open my notes");
      expect(on.p.answered("Opened Notes.", { spoken: true }).suggestions.map(s => s.text)).toContain("Close it");
      expect(on.p.isSuggestion("Close it")).toBe(true);
      on.p.stopped();
      expect(on.p.current()).toEqual([]);
      off.p.asked("Open my notes");
      expect(off.p.answered("Opened Notes.", { spoken: true }).suggestions).toEqual([]);
    } finally {
      fs.rmSync(on.dir, { recursive: true, force: true });
      fs.rmSync(off.dir, { recursive: true, force: true });
    }
  });
});

describe("the suggestions under the bubble", () => {
  const answer = { ...IDLE_BUBBLE, visible: true, thought: "Opened Notes." };
  it("show only under the answer they were made for", () => {
    const suggest = { thought: "Opened Notes.", items: ["Close it", "Read it out"] };
    expect(suggestionsShown({ bubble: answer, suggest })).toEqual(["Close it", "Read it out"]);
    expect(suggestionsShown({ bubble: { ...answer, thought: "Something else." }, suggest })).toEqual([]);
    expect(suggestionsShown({ bubble: { ...answer, mood: "attention", actions: [{ id: "q1:allow", label: "Allow" }] }, suggest })).toEqual([]);
    expect(suggestionsShown({ bubble: { ...answer, visible: false }, suggest })).toEqual([]);
    expect(suggestOf(suggestAction(2))).toBe(2);
    expect(suggestOf("ui:suggest:9")).toBeNull();
  });

  it("take a row of their own in the Ask box", () => {
    expect(boxRows(1, false, false, true)).toBe(2);
    expect(boxRows(4, true, true, true)).toBe(7);
  });
});

describe("Settings › Voice's personalisation words", () => {
  it("says what each row does (copy.ts)", () => {
    expect(PERSONAL_TEXT.learn).toBe("Keep learning my voice");
    expect(PERSONAL_TEXT.reset).toBe("Reset to my enrolment");
    expect(PERSONAL_TEXT.words).toBe("Learn my words");
    expect(PERSONAL_TEXT.suggest).toBe("Suggest what I might say next");
    expect(PERSONAL_TEXT.notSaid).toBe("That's not what I said");
    expect(learntText(0)).toBe("");
    expect(learntText(1)).toBe("Learnt from 1 of your requests since you taught it.");
    expect(learntText(5)).toBe("Learnt from 5 of your requests since you taught it.");
    expect(wordRowText({ heard: "jeera", meant: "Jira" })).toBe("“jeera” → “Jira”");
    expect(forgetWordLabel({ meant: "Jira" })).toBe("Forget “Jira”");
    expect(teachOutcomeText("learnt", " Open Jira ")).toBe("Got it: Ember will hear that as “Open Jira” from now on.");
    expect(teachOutcomeText("off", "x")).toBe("Learn my words is off (Settings › Voice), so Ember didn't keep that.");
  });
});
