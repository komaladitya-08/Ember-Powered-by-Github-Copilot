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
import { longEnough, oneVoice, sampleOffered } from "../../app/voice/adapt-sample";
import { VoiceGate, type Printer } from "../../app/voice/match";
import { VOICE_MATCH_THRESHOLD, encodePrint, similarity, unit } from "../../app/voice/voiceprint";
import type { VoiceEvent } from "../../app/voice/engine";
import { voiceprintStore } from "../../app/main/voiceprint-store";
import { editDistance, soundKey, soundsLike } from "../../app/main/personal/phonetic";
import { COMMON, LOOKS_UP, correctTranscript, isNumberWord, learnFrom, learnable, memoryNames, type Lexicon } from "../../app/main/personal/correct";
import { CONSENT_VERSION } from "../../app/shared/consent";
import { followUpMs, predictNext, type PredictInput } from "../../app/main/personal/predict";
import { PersonalVoice, type PersonalSettings } from "../../app/main/personal/service";
import { wordsStore } from "../../app/main/personal/words-store";
import { isRiskyLabel } from "../../app/main/policy/policy";
import { suggestOf, suggestionsShown, suggestAction, IDLE_BUBBLE } from "../../app/shared/overlay";
import { boxRows } from "../../app/renderer/ask/field";
import { PERSONAL_TEXT, learntText, personalView, teachOutcomeText, wordRowText, forgetWordLabel } from "../../app/renderer/home/copy";

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
    expect(sent.map(e => e.type)).toEqual(["rejected", "utterance", "utterance"]);
  });

  it("vouches for a request (verified) only when it matches the enrolment at its own threshold too: learning never lowers that bar (review of #145)", async () => {
    const sent: VoiceEvent[] = [];
    const away = randomPrint(42);
    const learntPrint = towards(anchor, away, ADAPT.anchorMin);
    // Close to the learnt print, and to the enrolment by the hearing floor (0.74) but under its own threshold (0.75).
    const between = towards(anchor, away, (ADAPT.anchorFloor + VOICE_MATCH_THRESHOLD) / 2);
    expect(similarity(between, learntPrint)).toBeGreaterThanOrEqual(adaptedThreshold(ADAPT.maxClips));
    const prints = [anchor, between];
    const printer: Printer = { print: async s => prints[Math.round(s[0])] ?? prints[0] };
    const g = new VoiceGate(() => printer, e => sent.push(e), () => undefined);
    g.setOwner(learntPrint, { anchor, threshold: adaptedThreshold(ADAPT.maxClips) });
    // Voiced clips (the printer reads which print by the first sample, rounded).
    const clip = (n: number) => new Float32Array(16_000 * 3).fill(n + 0.01);
    g.event({ type: "utterance", text: "Between.", ms: 100, window: "follow-up" }, clip(1));
    g.event({ type: "utterance", text: "Owner.", ms: 100, window: "follow-up" }, clip(0));
    await new Promise(r => setTimeout(r, 0));
    expect(sent[1]).toEqual({ type: "utterance", text: "Owner.", ms: 100, window: "follow-up", verified: true });
    // Heard, never verified: short, with its score against the ENROLMENT (#143's restScore), under the enrolment's own threshold.
    expect(sent[0]).toMatchObject({ type: "utterance", text: "Between.", short: true });
    expect(sent[0]).not.toHaveProperty("verified");
    const between1 = (sent[0] as { restScore: number }).restScore;
    expect(between1).toBeGreaterThanOrEqual(ADAPT.anchorFloor);
    expect(between1).toBeLessThan(VOICE_MATCH_THRESHOLD);
  });

  it("puts a print out of reach of the enrolment (a changed file) back within reach", () => {
    const far = { anchor, clips: [], print: randomPrint(9) };
    expect(similarity(sane(far).print, anchor)).toBeGreaterThanOrEqual(ADAPT.anchorMin - 1e-4);
    const ok = adapt(fromEnrolment(anchor), near(anchor, 0.9, 10), 0.9).state;
    expect(sane(ok).print).toBe(ok.print);
  });

  it("learns from nothing while another voice is about, Ember spoke, the room is busy or a stop came (poisoning guards)", () => {
    const base: SampleContext = { learning: true, matchOn: true, verified: true, selfSpoke: false, strangerNear: false, busyRoom: false, stoppedLately: false, voicedSeconds: 3, lastAt: 0, now: 1_000_000 };
    expect(adaptGuard(base)).toBeNull();
    expect(adaptGuard({ ...base, learning: false })).toBe("off");
    expect(adaptGuard({ ...base, matchOn: false })).toBe("off");
    expect(adaptGuard({ ...base, verified: false })).toBe("unverified");
    // Main checks the voice after the wake phrase again: a sample under ADAPT.minVoicedSeconds is never learnt (S3).
    expect(adaptGuard({ ...base, voicedSeconds: ADAPT.minVoicedSeconds - 0.1 })).toBe("short");
    expect(adaptGuard({ ...base, voicedSeconds: ADAPT.minVoicedSeconds })).toBeNull();
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

  const gate = (p: Float32Array) => similarity(p, ownerPrint) >= VOICE_MATCH_THRESHOLD;

  it("takes a short request as one voice, and checks a long one half by half, as the gate would", async () => {
    expect(await oneVoice(printer, clip(2, [1, 0.1]), gate)).toBe(true);
    expect(await oneVoice(printer, clip(4, [1, 0.1]), gate)).toBe(true);
    // The owner, then someone else talking: not learnt from (a busy room).
    expect(await oneVoice(printer, joined(clip(2, [1, 0.1]), clip(2, [0.1, 1])), gate)).toBe(false);
    // The gate's own test decides each half (a learnt threshold, the enrolment), not a fixed threshold.
    expect(await oneVoice(printer, clip(4, [1, 0.1]), () => false)).toBe(false);
  });

  it("learns from nothing shorter than ADAPT.minVoicedSeconds of voice, whatever an answer may be (review of #145)", () => {
    expect(longEnough(clip(ADAPT.minVoicedSeconds - 0.3, [1, 0.1]))).toBe(false);
    expect(longEnough(clip(ADAPT.minVoicedSeconds + 0.3, [1, 0.1]))).toBe(true);
    // Silence padding doesn't count: a short "allow" in a long clip is still short.
    expect(longEnough(joined(clip(0.6, [1, 0.1]), new Float32Array(16_000 * 3)))).toBe(false);
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
    expect(sent.map(e => e.type)).toEqual(["utterance", "utterance", "rejected", "utterance"]);
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
    expect(correctTranscript("Find the notes from Pria.", lex, risky)).toMatchObject({ text: "Find the notes from Priya.", counts: { memory: 1 } });
    expect(correctTranscript("Open jeera.", lex, risky)).toMatchObject({ text: "Open Jira.", counts: { learned: 1 } });
  });

  it("never changes who a request addresses: a name in a request to message, tell, call or invite someone stays as heard (review of #145)", () => {
    const people: Lexicon = { entries: [{ text: "Priya", source: "memory" }, { text: "Sandra", source: "memory" }], learned: [{ heard: "pria", meant: "Priya" }] };
    for (const said of ["Message Pria hello", "Tell Sandro I'm late", "Call Pria about lunch", "Text Pria the address", "Invite Sandro to the review", "Write to Pria about Friday", "DM Sandro the link", "Reply to Pria", "Email Sandro the notes"]) {
      expect(correctTranscript(said, people, risky), said).toMatchObject({ text: said, counts: {} });
    }
    // Ember's own name is still heard right.
    expect(correctTranscript("Amber, message Pria hello", people, risky)).toMatchObject({ text: "Ember, message Pria hello", counts: { name: 1 } });
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
    expect(learnFrom("Open the sherd folder", "Open the shred folder", risky)).toEqual({ heard: "sherd", meant: "shred" });
    expect(learnFrom("Open my mail", "Delete my mail", risky)).toBeNull();
  });

  it("never corrects into a person's name from memory unless the request only looks something up (review of #145)", () => {
    const sandra: Lexicon = { entries: [{ text: "Sandra", source: "memory" }, { text: "Slack", source: "app" }], learned: [] };
    // Requests that may hand something to the person, by verbs no list covers: the name stays as heard.
    for (const said of ["ask Sandro to come", "remind Sandro tomorrow", "add Sandro to the meeting", "give Sandro access", "let Sandro know", "assign it to Sandro",
      "Slack Sandro the file", "WhatsApp Sandro hello", "Zoom Sandro now", "book lunch with Sandro", "Ember, put Sandro on the list", "grant Sandro edit rights"]) {
      expect(correctTranscript(said, sandra, risky), said).toMatchObject({ text: said, counts: {} });
    }
    // Looking something up may use it.
    for (const said of ["Find Sandro in the directory", "What is Sandro working on", "Who is Sandro", "Where is Sandro today", "Ember, find Sandro", "Hey Ember, please find Sandro", "Can you look up Sandro", "Show me Sandro's team"]) {
      expect(LOOKS_UP.test(said), said).toBe(true);
    }
    expect(correctTranscript("Find Sandro in the directory", sandra, risky)).toMatchObject({ text: "Find Sandra in the directory", counts: { memory: 1 } });
    expect(correctTranscript("What is Sandro working on", sandra, risky)).toMatchObject({ text: "What is Sandra working on", counts: { memory: 1 } });
    // Suggestion words, which can carry a name too, are held to the same rule; an app's name isn't a person's.
    const suggested: Lexicon = { entries: [{ text: "Sandra", source: "predicted" }], learned: [] };
    expect(correctTranscript("give Sandro access", suggested, risky).text).toBe("give Sandro access");
    expect(correctTranscript("Find Sandro", suggested, risky).text).toBe("Find Sandra");
    expect(correctTranscript("Open Slak please", sandra, risky)).toMatchObject({ text: "Open Slack please", counts: { app: 1 } });
  });

  it("never learns a number word or a digit: fifteen for fifty changes what is asked (review of #145)", () => {
    expect(learnFrom("set it to fifteen", "set it to fifty", risky)).toBeNull();
    expect(learnFrom("set it to 15", "set it to 50", risky)).toBeNull();
    expect(learnFrom("move it to the thirteenth", "move it to the thirtieth", risky)).toBeNull();
    expect(learnFrom("twenty-five of them", "twenty-six of them", risky)).toBeNull();
    expect(learnFrom("wait a Jira", "wait an Jira", risky)).toBeNull();
    for (const w of ["zero", "ten", "nineteen", "ninety", "hundred", "thousand", "million", "second", "twelfth", "twenty-five", "a", "an", "7"]) expect(isNumberWord(w), w).toBe(true);
    for (const w of ["Jira", "Sandra", "ember", "fiftyfold-ish"]) expect(isNumberWord(w), w).toBe(w === "fiftyfold-ish" ? false : false);
    expect(learnable(["fifteen"], ["fifty"])).toBe(false);
    // An entry kept before this rule is held to it too.
    const old: Lexicon = { entries: [], learned: [{ heard: "fifteen", meant: "fifty" }] };
    expect(correctTranscript("set it to fifteen", old, risky)).toMatchObject({ text: "set it to fifteen", counts: {} });
  });

  it("never learns a common word for another, or a change of verb (open for close, allow for deny: review of #145)", () => {
    expect(learnFrom("Open the notes", "Close the notes", risky)).toBeNull();
    expect(learnFrom("Allow it", "Deny it", risky)).toBeNull();
    expect(learnFrom("Start the timer", "Stop the timer", risky)).toBeNull();
    expect(learnable(["jeera"], ["Jira"])).toBe(true);
    expect(learnable(["open"], ["close"])).toBe(false);
    expect(learnable(["opun"], ["open"])).toBe(false);
    // A correction kept before these rules (or written into words.json by hand) is held to them too.
    const old: Lexicon = { entries: [], learned: [{ heard: "open", meant: "close" }, { heard: "allow", meant: "deny" }] };
    expect(correctTranscript("Open the notes and allow it", old, risky)).toMatchObject({ text: "Open the notes and allow it", counts: {} });
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
    expect(predictNext({ ...base, lastRequest: "Send the report to Sam", people, lastRequestOwn: true }, risky).map(s => s.text)).toContain("Send it to Priya");
    // The same words that weren't the user's own (heard unchecked, a chosen suggestion, or unsaid) authorise nothing risky.
    for (const own of [false, undefined]) expect(predictNext({ ...base, lastRequest: "Send the report to Sam", people, lastRequestOwn: own }, risky).map(s => s.text)).not.toContain("Send it to Priya");
  });

  it("keeps the follow-up window open longer only when Ember asked something, as the consent text says (review of #145)", () => {
    expect(followUpMs({ lastReply: "Done." })).toBe(8000);
    expect(followUpMs({ lastReply: "Which one?" })).toBe(12_000);
  });

  it("suggests nothing risky but what the user's own risky request built, and never repeats a risky request (review of #145)", () => {
    // "delete the tmp folder" is risky; a suggestion that isn't built from it ("Remove old logs", said twice before) isn't offered.
    const s = predictNext({ ...base, lastRequest: "delete the tmp folder", history: ["Remove old logs", "Remove old logs", "Open my notes", "Open my notes"] }, risky).map(x => x.text);
    expect(s.some(t => risky(t))).toBe(false);
    expect(s).toContain("Open my notes");
    expect(predictNext({ ...base, lastRequest: "Open the report", history: ["Delete the drafts", "Delete the drafts"] }, risky).some(x => risky(x.text))).toBe(false);
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

  it("learns nothing while a question Voice Match locked (a stranger was turned away during it) is up (review of #145)", () => {
    const { p, dir, anchor } = make();
    try {
      const s = { print: encodePrint(near(anchor, 0.9, 24)), score: 0.9, oneVoice: true, voiced: 3 };
      expect(p.sample(s, { ...ok, locked: true })).toBeNull();
      expect(p.sample(s, ok)).not.toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forgets the voiceprint, all it learnt and the words learnt with Forget my voice (review of #145)", () => {
    const { p, dir, voiceprints } = make();
    try {
      const h = p.heard("Open jeera board");
      expect(p.teach(h.id, "Open Jira board").outcome).toBe("learnt");
      expect(fs.existsSync(path.join(dir, "words.json"))).toBe(true);
      p.forgetVoice();
      expect(voiceprints.read()).toBeNull();
      expect(fs.existsSync(path.join(dir, "voiceprint.json"))).toBe(false);
      expect(fs.existsSync(path.join(dir, "words.json"))).toBe(false);
      expect(p.words()).toEqual([]);
      expect(p.heardItems()).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never lets a request heard unchecked, or a suggestion the user chose, authorise a risky suggestion (review of #145)", () => {
    const { dir } = make();
    // Memory knows Priya: a request to send something, then "Send it to Priya" if it were the user's own.
    try {
      const people = new PersonalVoice({
        log: { info: () => undefined, warn: () => undefined }, settings: () => ({ learnVoice: true, matchOn: true, learnWords: true, suggest: true }),
        voiceprints: voiceprintStore(dir, "m.onnx"), words: wordsStore(dir), apps: () => [], risky,
        memory: () => [{ text: "Priya Raman is my manager", source: "user" }],
      });
      for (const how of [{}, { unchecked: true }, { suggested: true }] as const) {
        people.asked("Send it to Alice", how);
        const offered = people.answered("Sent.", { spoken: true }).suggestions.map(s => s.text);
        expect(offered.some(t => t.startsWith("Send it to Priya")), JSON.stringify(how)).toBe(Object.keys(how).length === 0);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a request heard, a typed one, apart: only the heard row (by its id) can be taught, and a chosen suggestion never comes back", () => {
    const { p, dir } = make();
    try {
      const h = p.heard("Open jeera board");
      expect(p.teach(h.id + 1, "Open Jira board")).toEqual({ outcome: "unknown" });
      p.asked("Open my notes", { suggested: true });
      p.asked("Open my notes", { unchecked: true });
      p.asked("Open the calendar");
      expect(p.answered("Opened.", { spoken: true }).suggestions.map(s => s.text)).not.toContain("Open my notes");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("learns from a verified request, but not after another voice was turned away, nor twice a minute", () => {
    const { p, dir, anchor, tick } = make();
    try {
      const s = { print: encodePrint(near(anchor, 0.9, 22)), score: 0.9, oneVoice: true, voiced: 3 };
      expect(p.sample(s, ok)).not.toBeNull();
      expect(p.sample(s, ok)).toBeNull(); // too soon
      tick(ADAPT.minGapMs);
      p.strangerTurnedAway();
      expect(p.sample(s, ok)).toBeNull();
      tick(ADAPT_QUIET_MS);
      expect(p.sample({ ...s, oneVoice: false, voiced: 3 }, ok)).toBeNull();
      expect(p.sample(s, { ...ok, selfSpoke: true })).toBeNull();
      expect(p.sample(s, null)).toBeNull();
      expect(p.sample({ ...s, voiced: ADAPT.minVoicedSeconds - 0.1 }, ok)).toBeNull(); // main checks the voice after the wake phrase too (S3)
      expect(p.sample(s, ok)).not.toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("learns nothing while Keep learning my voice is off", () => {
    const { p, dir, anchor } = make({ learnVoice: false });
    try {
      expect(p.sample({ print: encodePrint(near(anchor, 0.9, 23)), score: 0.9, oneVoice: true, voiced: 3 }, ok)).toBeNull();
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
      const h = p.heard("Open jeera board");
      expect(p.heardItems().map(x => x.shown)).toEqual(["Open Spotify.", "Open jeera board"]);
      expect(p.teach(h.id, "Open Jira board")).toEqual({ outcome: "learnt", word: { heard: "jeera", meant: "Jira" } });
      expect(p.words()).toEqual([expect.objectContaining({ heard: "jeera", meant: "Jira" })]);
      expect(p.heard("Open jeera board").text).toBe("Open Jira board");
      if (process.platform !== "win32") expect(fs.statSync(path.join(dir, "words.json")).mode & 0o777).toBe(0o600);
      expect(p.teach(999, "x")).toEqual({ outcome: "unknown" });
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
    expect(boxRows(1, false, false, 1)).toBe(2);
    expect(boxRows(4, true, true, 1)).toBe(7);
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
    expect(teachOutcomeText("learnt", " Jira ")).toBe("Got it: Ember will hear that as “Jira” from now on.");
    expect(teachOutcomeText("off", "x")).toBe("Learn my words is off (Settings › Voice), so Ember didn't keep that.");
    expect(teachOutcomeText("same", "x")).toBe("That's what Ember heard, so there's nothing to learn.");
    expect(teachOutcomeText("unlike", "x")).toBe("That's a different request, not a misheard word, so Ember didn't keep it. Ask again to have it done.");
    expect(teachOutcomeText("unknown", "x")).toBe("Ember can't find that request any more.");
  });

  it("offers Reset to my enrolment only while Voice Match is on, its model is in, and it learnt something (review of #145)", () => {
    const m = { enrolled: true, on: true, model: true, enrolling: null, learnt: 3 };
    expect(personalView(m, false)).toEqual({ learnRow: true, reset: true, learnt: "Learnt from 3 of your requests since you taught it." });
    expect(personalView({ ...m, on: false }, false).reset).toBe(false);
    expect(personalView({ ...m, model: false }, false).reset).toBe(false);
    expect(personalView({ ...m, learnt: 0 }, false)).toEqual({ learnRow: true, reset: false, learnt: "" });
    expect(personalView(m, true)).toEqual({ learnRow: false, reset: false, learnt: "" });
    expect(personalView(undefined, false)).toEqual({ learnRow: false, reset: false, learnt: "" });
  });
});

describe("words.json", () => {
  it("drops an entry that doesn't read and keeps the rest, instead of reading as empty and then being written over", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-words-"));
    try {
      fs.writeFileSync(path.join(dir, "words.json"), JSON.stringify({ version: 1, words: [{ heard: "jeera", meant: "Jira", at: "2026-11-03T09:00:00.000Z" }, { heard: 42 }, { heard: "shivan", meant: "Siobhan", at: "2026-11-03T09:10:00.000Z" }] }));
      const store = wordsStore(dir);
      expect(store.list().map(w => w.meant)).toEqual(["Jira", "Siobhan"]);
      store.add({ heard: "sersha", meant: "Saoirse" });
      expect(wordsStore(dir).list().map(w => w.meant)).toEqual(["Jira", "Siobhan", "Saoirse"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a repeated or stale forget request cannot delete the next or replacement correction", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-word-forget-"));
    try {
      const store = wordsStore(dir);
      const [first] = store.add({ heard: "jeera", meant: "Jira" }, new Date("2026-11-03T09:00:00Z"));
      store.add({ heard: "shivan", meant: "Siobhan" });
      expect(store.forget(first).map(w => w.meant)).toEqual(["Siobhan"]);
      expect(store.forget(first).map(w => w.meant)).toEqual(["Siobhan"]);
      const replacement = store.add({ heard: "jeera", meant: "Jira" }, new Date("2026-11-03T10:00:00Z"));
      expect(store.forget(first)).toEqual(replacement);
      expect(store.forget(0)).toEqual(replacement);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("what the voice process offers main as a sample (adapt-sample.ts)", () => {
  const voiced = (seconds: number) => { const a = new Float32Array(Math.round(seconds * 16_000)); for (let i = 0; i < a.length; i++) a[i] = 0.3 * Math.sin(i / 7); return a; };
  const base = { learning: true, hasOwner: true, score: VOICE_MATCH_THRESHOLD + ADAPT.margin, rest: voiced(ADAPT.minVoicedSeconds + 0.5), now: 1_000_000, sampledAt: 0 };

  it("offers a verified request that matched by the margin, with enough voice after its wake phrase, once a minute", () => {
    expect(sampleOffered(base)).toBe(true);
    expect(sampleOffered({ ...base, learning: false })).toBe(false);
    expect(sampleOffered({ ...base, hasOwner: false })).toBe(false);
    expect(sampleOffered({ ...base, score: base.score - 0.01 })).toBe(false);
    expect(sampleOffered({ ...base, sampledAt: base.now - ADAPT.minGapMs + 1 })).toBe(false);
    expect(sampleOffered({ ...base, sampledAt: base.now - ADAPT.minGapMs })).toBe(true);
  });

  it("offers nothing with under ADAPT.minVoicedSeconds of voice after the wake phrase, however long the clip is (S3)", () => {
    expect(sampleOffered({ ...base, rest: voiced(ADAPT.minVoicedSeconds - 0.4) })).toBe(false);
    expect(sampleOffered({ ...base, rest: Float32Array.from([...voiced(0.8), ...new Float32Array(16_000 * 4)]) })).toBe(false);
  });
});

describe("VoiceGate's spoken yes after a learnt print (match.ts vouched)", () => {
  const A = unit(Float32Array.from([1, 0]));
  const pair = (deg: number) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
  const voice = (samples: number, [x, y]: number[]) => { const a = new Float32Array(samples); for (let i = 0; i + 1 < a.length; i += 2) { a[i] = x; a[i + 1] = y; } return a; };
  const joined = (a: Float32Array, b: Float32Array) => { const o = new Float32Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
  const printer: Printer = { print: async s => unit(Float32Array.from([s[0], s[1]])) };

  it("is verified only if the part after the wake phrase matches the enrolment at its own threshold, not the 0.74 that is enough to be heard (review of #145)", async () => {
    // The learnt print sits 38 degrees from the enrolment. After the wake phrase (exactly 0.8 s of voice) one request is at
    // 41.8 degrees (0.745 from the enrolment: heard, not verified), one at 36 degrees (0.81: verified).
    const learnt = unit(Float32Array.from(pair(38)));
    const sent: VoiceEvent[] = [];
    const g = new VoiceGate(() => printer, e => sent.push(e), () => undefined);
    g.setOwner(learnt, { anchor: A, threshold: adaptedThreshold(ADAPT.maxClips) });
    const wake = voice(12_800, pair(38));
    g.event({ type: "utterance", text: "Between.", ms: 100, window: "wake" }, joined(wake, voice(16_000 * 3, pair(41.8))), true);
    g.event({ type: "utterance", text: "Owner.", ms: 100, window: "wake" }, joined(wake, voice(16_000 * 3, pair(36))), true);
    await new Promise(r => setTimeout(r, 10));
    expect(sent[1]).toEqual({ type: "utterance", text: "Owner.", ms: 100, window: "wake", verified: true });
    expect(sent[0]).toMatchObject({ type: "utterance", text: "Between.", short: true });
    expect(sent[0]).not.toHaveProperty("verified");
    // Its restScore is the cosine to the enrolled voiceprint (or lower), never the learnt print's higher one.
    const score = (sent[0] as { restScore: number }).restScore;
    expect(score).toBeCloseTo(Math.cos((41.8 * Math.PI) / 180), 3);
    expect(score).toBeLessThan(VOICE_MATCH_THRESHOLD);
  });
});

describe("main's wiring of voice personalisation (main.ts source)", () => {
  const MAIN = fs.readFileSync(path.join(__dirname, "../../app/main/main.ts"), "utf8");
  it("learns nothing from a spoken answer to a question: the heard request is cleared before it is answered (review of #145)", () => {
    expect(MAIN).toContain('if (spokenReply.kind !== "none") { lastHeard = null; answerByVoice(spokenReply); break; }');
  });
  it("judges a spoken answer on the raw words, ends trust and learning on another voice, and forgets the words with the voice (merge with #143)", () => {
    // voiceAnswer reads what the recogniser wrote (e.text), never personal.heard()'s corrected words.
    expect(MAIN).toContain("text: e.text, questionUp: confirmer?.waiting ?? false");
    expect(MAIN).toContain('if (e.reason === "voice") personal.strangerTurnedAway();');
    expect(MAIN).toContain('if (rejectionEndsTrust(e.reason)) voiceTrust.endAll("other-voice");');
    expect(MAIN).toContain('personal.forgetVoice();\n    // A task\'s voice trust was granted against the voiceprint that is gone (voice-answer.ts TaskVoiceTrust).\n    voiceTrust.endAll("voice-changed");');
    expect(MAIN).toContain("...(voice ? { natural: voice.naturalStatus } : {}),");
    expect(MAIN).toContain("enrolling, learnt: voiceprints.learnt().clips, ...(enrolEnded ? { ended: enrolEnded } : {}) },");
  });
  it("holds learning while a question Voice Match locked is up (review of #145)", () => {
    expect(MAIN).toContain("locked: confirmer?.voiceLocked ?? false");
  });
  it("takes a suggestion's click only for a chip the bubble shows now, and sends it as Ember's words the user chose (review of #145)", () => {
    // Each pinned with its surrounding line: a changed check or a dropped `suggested` changes the line.
    expect(MAIN).toContain('if (text && personal.isSuggestion(text)) { log.info("bubble.suggestion", { n: suggested }); captureContext(); void askEmber(text, { suggested: true }); }');
    expect(MAIN).toContain("const text = suggestionsShown(lastState)[suggested];");
    // A queued suggestion must not change the spoken ownership of the turn still answering.
    const start = MAIN.slice(MAIN.indexOf("      onTurnStart: turn =>"), MAIN.indexOf("      onAnswerInterrupted:"));
    expect(start).toContain("lastAskByVoice = turn.spoken && !turn.manual;");
  });
  it("takes an Ask box suggestion only if it offers it now, and sends it as Ember's words the user chose (review of #145)", () => {
    expect(MAIN).toContain('if (!askWindow.owns(event.sender) || typeof text !== "string" || text.length > 200 || !personal.isSuggestion(text)) return;\n    askWindow.hide();\n    log.info("ask.suggestion");\n    void askEmber(text, { suggested: true });');
  });
  it("keeps a retried suggestion (or one heard unchecked) what it was: Try again resubmits it with its provenance (review of #145)", () => {
    expect(MAIN).toContain("let recentAsks: { text: string; voiceUnchecked?: boolean; suggested?: boolean }[] = [];");
    expect(MAIN).toContain("recentAsks = [...recentAsks, { text, ...(how.voiceUnchecked ? { voiceUnchecked: true } : {}), ...(how.suggested ? { suggested: true } : {}) }].slice(-4);");
    expect(MAIN).toContain("void askEmber(again, { voiceUnchecked: how ? how.voiceUnchecked : true, ...(how?.suggested ? { suggested: true } : {}) });");
  });
  it("pairs a Voice Match sample with the utterance it came from by its number, not the latest one heard", () => {
    expect(MAIN).toContain("const r = lastHeard && lastHeard.utterance === s.utterance ? lastHeard : null;");
  });
});

describe("what Ember keeps for Voice Match and words, and asking again (review of #145)", () => {
  const SENTENCE = "If you teach Ember your voice, it keeps your voiceprint and keeps refining it from requests it is sure are yours (numbers, never audio), and it keeps the words you correct when it mishears you, on this computer until you forget them.";
  it("is said in 'Before Ember starts' and the microphone's card, including temporary listening", () => {
    const html = fs.readFileSync(path.join(__dirname, "../../app/renderer/home/index.html"), "utf8");
    expect(html.split(SENTENCE)).toHaveLength(3); // the full text's microphone line, and the card's text
    expect(CONSENT_VERSION).toBeGreaterThanOrEqual(3);
  });
});
