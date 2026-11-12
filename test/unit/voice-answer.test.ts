/**
 * Spoken answers to Ember's questions and "Work without asking" by voice (owner decision of 2026-11-02): what counts as
 * an answer, when a yes may be taken (only the owner's verified voice, never Ember's own, only during the question,
 * never "Always"), that anyone may say "Not now", and the voice switch's plans.
 */

import { describe, expect, it } from "vitest";
import { SHORT_YES_FLOOR, TASK_VOICE_MS, TaskVoiceTrust, heardAnswer, heardUnchecked, refusalEndsTrust, refusalNote, rejectionEndsTrust, spokenAnswer, voiceAnswer, voiceAnswerSaid, VOICE_ANSWER_REFUSED, type VoiceAnswerInput } from "../../app/main/agent/voice-answer";
import { Confirmer, type Question } from "../../app/main/agent/confirm";
import { questionAloud } from "../../app/main/agent/presenter";
import { AUTONOMY_NOT_SAVED, autonomyIntent, planAutonomyIntent } from "../../app/main/agent/autonomy-intent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentHost } from "../../app/main/agent/host";
import { SettingsStore } from "../../app/main/settings";
import { ALL_SCOPES, autonomyConsented } from "../../app/main/policy/autonomy";
import { FEATURE_CONSENT_VERSION } from "../../app/shared/consent";
import type { Logger } from "../../app/main/logger";

const options = [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }];
const withAlways = [{ id: "always", label: "Always in gedit", primary: true }, { id: "once", label: "Allow" }, { id: "deny", label: "Not now" }];
const q = (o: Partial<Question> = {}): Question => ({ title: "May I?", prompt: "Click the “Bold” button?", options, ...o });

/** A Confirmer at a controllable clock; `bubbles` collects what it shows. */
function confirmer(o: { blocked?: () => boolean; panelReady?: (n: number) => boolean } = {}) {
  let t = 1000;
  const bubbles: Record<string, unknown>[] = [];
  const c = new Confirmer(p => { if (p.bubble) bubbles.push(p.bubble as unknown as Record<string, unknown>); }, { armMs: 500, gapMs: 0, now: () => t, ...o });
  return { c, bubbles, later: (ms: number) => { t += ms; } };
}

describe("spokenAnswer", () => {
  it("hears short yeses and noes, with or without the name, whole utterances only", () => {
    for (const yes of ["Allow.", "Hey Ember, allow", "Ember, yes allow", "Yes, allow it please", "Go ahead.", "Okay, go ahead", "yes"]) expect(spokenAnswer(yes), yes).toBe("allow");
    for (const no of ["Not now.", "Ember, not now", "No.", "Don't.", "No, don't", "Hey Ember, no thanks"]) expect(spokenAnswer(no), no).toBe("deny");
    // "Cancel" and "never mind" are requests of their own (cancel a task, drop a request), not answers (review of #127).
    for (const other of ["Cancel", "Never mind"]) expect(spokenAnswer(other), other).toBeNull();
    expect(spokenAnswer("Yes, go ahead and allow it.")).toBe("allow");
    for (const other of ["Always", "Always allow", "Allow always in gedit", "Allow it to delete everything and then send the report to Sam", "Open the terminal", "", "yes and also delete the files"]) {
      expect(spokenAnswer(other), other).toBeNull();
    }
  });
});

describe("voiceAnswer (who may answer by voice)", () => {
  const base: VoiceAnswerInput = { text: "Ember, allow", questionUp: true, matchOn: true, matchOff: false, verified: true, selfSpoke: false };

  it("with Voice Match switched on, takes a yes only from the owner's voice as Voice Match verified it", () => {
    expect(voiceAnswer(base)).toEqual({ kind: "answer", answer: "allow", verified: true });
    expect(voiceAnswer({ ...base, verified: false })).toEqual({ kind: "refused", answer: "allow", why: "unverified" });
    // Switched on but not in use (never taught, or its model not in): no yes at all, verified or not.
    expect(voiceAnswer({ ...base, matchOn: false, verified: false })).toEqual({ kind: "refused", answer: "allow", why: "voice-match-unready" });
    expect(voiceAnswer({ ...base, matchOn: false, verified: true })).toEqual({ kind: "refused", answer: "allow", why: "voice-match-unready" });
  });

  it("never takes Ember's own voice as an answer, either way", () => {
    expect(voiceAnswer({ ...base, selfSpoke: true })).toEqual({ kind: "refused", answer: "allow", why: "own-voice" });
    expect(voiceAnswer({ ...base, text: "not now", selfSpoke: true })).toEqual({ kind: "refused", answer: "deny", why: "own-voice" });
  });

  it("answers nothing outside a question: the words are an ordinary request", () => {
    expect(voiceAnswer({ ...base, questionUp: false })).toEqual({ kind: "none" });
    expect(voiceAnswer({ ...base, text: "What's the weather like?" })).toEqual({ kind: "none" });
  });

  it("takes “Not now” from anyone, without Voice Match", () => {
    expect(voiceAnswer({ ...base, text: "Not now", matchOn: false, matchOff: true, verified: false })).toEqual({ kind: "answer", answer: "deny", verified: false });
    expect(voiceAnswer({ ...base, text: "No", verified: false })).toEqual({ kind: "answer", answer: "deny", verified: false });
  });

  it("asks for a little more when the owner's yes was too short for Voice Match to vouch for (security review of #127)", () => {
    expect(voiceAnswer({ ...base, verified: false, short: true })).toEqual({ kind: "refused", answer: "allow", why: "too-short" });
    expect(VOICE_ANSWER_REFUSED["too-short"]).toBe("I couldn't hear enough of your voice to be sure it's you. Say it a little longer, like “Yes, please go ahead”, so I can tell.");
    // The longer yes it suggests is one Ember takes.
    expect(spokenAnswer("Yes, please go ahead.")).toBe("allow");
  });

  it("says how to finish setting Voice Match up, or turn it off, when it is on and a yes can't be taken", () => {
    expect(VOICE_ANSWER_REFUSED["voice-match-unready"]).toMatch(/Voice Match.*Settings › Voice, or turn it off/);
    for (const words of Object.values(VOICE_ANSWER_REFUSED)) expect(words).not.toMatch(/"|Ctrl\+/);
  });
});

describe("Confirmer.answerVoice", () => {
  it("allows the question up with a verified yes once armed, and records the channel", async () => {
    const { c, later } = confirmer();
    const question = q();
    const answer = c.ask(question);
    expect(c.answerVoice("allow", { verified: true })).toBe("not-yet");
    later(600);
    expect(c.answerVoice("allow", { verified: false })).toBe("unverified");
    expect(c.answerVoice("allow", { verified: true })).toBe("answered");
    expect(await answer).toBe("once");
    expect(c.howAnswered(question)).toEqual({ via: "voice", verified: true });
  });

  it("takes Not now at once and from anyone, recorded as unverified", async () => {
    const { c } = confirmer();
    const question = q();
    const answer = c.ask(question);
    expect(c.answerVoice("deny", { verified: false })).toBe("answered");
    expect(await answer).toBe("deny");
    expect(c.howAnswered(question)).toEqual({ via: "voice", verified: false });
  });

  it("answers nothing when no question is up", () => {
    expect(confirmer().c.answerVoice("allow", { verified: true })).toBe("no-question");
    expect(confirmer().c.answerVoice("deny", { verified: false })).toBe("no-question");
  });

  it("never says Always by voice: a question whose primary option is Always isn't allowed by it", async () => {
    const { c, later } = confirmer();
    const answer = c.ask(q({ options: withAlways }));
    later(600);
    expect(c.answerVoice("allow", { verified: true })).toBe("not-yet");
    expect(c.answerVoice("deny", { verified: true })).toBe("answered");
    expect(await answer).toBe("deny");
  });

  it("takes no yes on a click-only question (a consent card), nor while Ember borrows the mouse, nor on a panel not shown whole", async () => {
    const clickOnly = confirmer();
    void clickOnly.c.ask(q({ clickOnly: true }));
    clickOnly.later(600);
    expect(clickOnly.c.answerVoice("allow", { verified: true })).toBe("click-only");
    let borrowing = true;
    const borrowed = confirmer({ blocked: () => borrowing });
    const answer = borrowed.c.ask(q());
    borrowed.later(600);
    expect(borrowed.c.answerVoice("allow", { verified: true })).toBe("not-yet");
    borrowing = false;
    expect(borrowed.c.answerVoice("allow", { verified: true })).toBe("answered");
    expect(await answer).toBe("once");
    const card = { kind: "command" as const, card: { sha256: "a".repeat(64) } as never };
    const unwired = confirmer();
    void unwired.c.ask(q({ panel: card }));
    unwired.later(600);
    expect(unwired.c.answerVoice("allow", { verified: true })).toBe("not-yet");
    let shown = false;
    const wired = confirmer({ panelReady: () => shown });
    const ran = wired.c.ask(q({ panel: card }));
    wired.later(600);
    expect(wired.c.answerVoice("allow", { verified: true })).toBe("not-yet");
    shown = true;
    expect(wired.c.answerVoice("allow", { verified: true })).toBe("answered");
    expect(await ran).toBe("once");
  });

  it("takes no yes before a whole text has been read, and says why under the question without replacing it", async () => {
    const { c, later, bubbles } = confirmer();
    const answer = c.ask(q({ detail: "x".repeat(400) }));
    later(600);
    expect(c.answerVoice("allow", { verified: true })).toBe("not-yet");
    expect(c.note("Read it through first, then say “Allow” again.")).toBe(true);
    expect(bubbles.at(-1)).toMatchObject({ title: "May I?", step: "Read it through first, then say “Allow” again." });
    expect((bubbles.at(-1)!.actions as { id: string }[]).map(a => a.id)).toEqual(["q1:once", "q1:deny"]);
    c.answerKey("deny");
    expect(await answer).toBe("deny");
    expect(c.note("x")).toBe(false);
  });

  it("takes an answer only for the question up when it was said, after it was armed (security review of #127)", async () => {
    const { c, later } = confirmer();
    const answer = c.ask(q());
    const n = c.currentNumber;
    expect(n).toBe(1);
    // Said before the question came up (no question then), or before it was armed: not taken, either way.
    expect(c.answerVoice("allow", { verified: true, question: null, startedAt: 2000 })).toBe("stale");
    later(600);
    expect(c.answerVoice("allow", { verified: true, question: n, startedAt: 1100 })).toBe("stale");
    expect(c.answerVoice("deny", { verified: true, question: n, startedAt: 1100 })).toBe("stale");
    expect(c.answerVoice("deny", { verified: false, question: 7, startedAt: 2000 })).toBe("stale");
    expect(c.answerVoice("allow", { verified: true, question: n, startedAt: 1500 })).toBe("answered");
    expect(await answer).toBe("once");
  });

  it("takes no spoken yes for a question once another voice was turned away during it; Not now still works (security review of #127)", async () => {
    const { c, later } = confirmer();
    const answer = c.ask(q());
    later(600);
    expect(c.voiceLocked).toBe(false);
    expect(c.lockVoice()).toBe(true);
    // Said so while it is up: Voice Match learns nothing meanwhile (main's onSample, review of #145).
    expect(c.voiceLocked).toBe(true);
    expect(c.answerVoice("allow", { verified: true })).toBe("locked");
    expect(c.answerVoice("deny", { verified: false })).toBe("answered");
    expect(await answer).toBe("deny");
    expect(c.lockVoice()).toBe(false);
    expect(c.voiceLocked).toBe(false);
  });

  it("records a click as a click", async () => {
    const { c, later } = confirmer();
    const question = q();
    const answer = c.ask(question);
    later(600);
    expect(c.answer("q1:once")).toBe(true);
    await answer;
    expect(c.howAnswered(question)).toEqual({ via: "bubble" });
  });
});

describe("a spoken yes from anyone heard while Voice Match is off, its default (owner's report of 2026-11-12; owner decision B)", () => {
  const off: VoiceAnswerInput = { text: "Allow.", questionUp: true, matchOn: false, matchOff: true, verified: false, selfSpoke: false };

  it("allows the question when someone says “allow” or “okay, go with it”, and refuses it on “no”, with Voice Match off (owner's report of 2026-11-12)", () => {
    for (const yes of ["Allow.", "Okay, go with it.", "Yes please.", "Ember, go ahead.", "I accept."]) {
      expect(voiceAnswer({ ...off, text: yes }), yes).toEqual({ kind: "answer", answer: "allow", verified: false, anyone: true });
    }
    for (const no of ["No.", "Not now.", "Don't."]) expect(voiceAnswer({ ...off, text: no }), no).toEqual({ kind: "answer", answer: "deny", verified: false });
  });

  it("still never takes Ember's own voice, or what was said over it, either way", () => {
    expect(voiceAnswer({ ...off, selfSpoke: true })).toEqual({ kind: "refused", answer: "allow", why: "own-voice" });
    expect(voiceAnswer({ ...off, text: "No.", selfSpoke: true })).toEqual({ kind: "refused", answer: "deny", why: "own-voice" });
  });

  it("keeps Voice Match's rules while it is switched on, ready or not: a yes it can't take never asks to be said again", () => {
    // On and ready: only the owner's verified voice, as before.
    expect(voiceAnswer({ ...off, matchOff: false, matchOn: true })).toEqual({ kind: "refused", answer: "allow", why: "unverified" });
    // A setting that says both (it can't, as main reads them): Voice Match's rules win.
    expect(voiceAnswer({ ...off, matchOn: true })).toEqual({ kind: "refused", answer: "allow", why: "unverified" });
    // On but not ready: refused as such before the echo guard, whose note would say to say it again.
    expect(voiceAnswer({ ...off, matchOff: false, selfSpoke: true })).toEqual({ kind: "refused", answer: "allow", why: "voice-match-unready" });
    expect(voiceAnswer({ ...off, matchOff: false, text: "Not now." })).toEqual({ kind: "answer", answer: "deny", verified: false });
  });

  it("is taken by the Confirmer only as the approve key would be, and audited as an unverified spoken answer", async () => {
    const { c, later } = confirmer();
    const question = q();
    const answer = c.ask(question);
    // Not before it is armed, and without the opt-in still unverified (fail closed).
    expect(c.answerVoice("allow", { verified: false, anyone: true })).toBe("not-yet");
    later(600);
    expect(c.answerVoice("allow", { verified: false })).toBe("unverified");
    expect(c.answerVoice("allow", { verified: false, anyone: true, question: 1, startedAt: 1100 })).toBe("stale");
    expect(c.answerVoice("allow", { verified: false, anyone: true, question: 1, startedAt: 1600 })).toBe("answered");
    expect(await answer).toBe("once");
    expect(c.howAnswered(question)).toEqual({ via: "voice", verified: false });
  });

  it("allows a command card only while it shows whole and armed, and never a consent card, “Always” or a question locked to clicks", async () => {
    const card = { kind: "command" as const, card: { sha256: "a".repeat(64) } as never };
    let shown = false;
    const wired = confirmer({ panelReady: () => shown });
    const ran = wired.c.ask(q({ panel: card }));
    wired.later(600);
    expect(wired.c.answerVoice("allow", { verified: false, anyone: true })).toBe("not-yet");
    shown = true;
    expect(wired.c.answerVoice("allow", { verified: false, anyone: true })).toBe("answered");
    expect(await ran).toBe("once");
    const consent = { kind: "consent" as const, consent: { sha256: "b".repeat(64) } as never };
    for (const asked of [q({ panel: consent, clickOnly: true }), q({ panel: consent }), q({ clickOnly: true })]) {
      const k = confirmer({ panelReady: () => true });
      void k.c.ask(asked);
      k.later(600);
      expect(k.c.answerVoice("allow", { verified: false, anyone: true })).toBe("click-only");
    }
    const always = confirmer();
    void always.c.ask(q({ options: withAlways }));
    always.later(600);
    expect(always.c.answerVoice("allow", { verified: false, anyone: true })).toBe("not-yet");
    const locked = confirmer();
    void locked.c.ask(q());
    locked.later(600);
    locked.c.lockVoice();
    expect(locked.c.answerVoice("allow", { verified: false, anyone: true })).toBe("locked");
    let borrowing = true;
    const borrowed = confirmer({ blocked: () => borrowing });
    void borrowed.c.ask(q({ detail: "x".repeat(400) }));
    borrowed.later(600);
    expect(borrowed.c.answerVoice("allow", { verified: false, anyone: true })).toBe("not-yet");
    // Its whole text not read yet: as the key, never.
    borrowing = false;
    expect(borrowed.c.answerVoice("allow", { verified: false, anyone: true })).toBe("not-yet");
  });

  it("says a question is locked to clicks and keys, never to say a yes again, once Voice Match turned a voice away during it (cause 9)", () => {
    for (const why of ["own-voice", "stale", "heard-over", "unverified", "too-short", "not-yet"] as const) {
      expect(refusalNote(why, { answer: "allow", locked: true, unready: false }), why).toBe("locked");
      expect(refusalNote(why, { answer: "deny", locked: true, unready: false }), why).toBe(why);
      expect(refusalNote(why, { answer: "allow", locked: false, unready: false }), why).toBe(why);
    }
    // Voice Match switched on but not ready: no yes can be taken, so none is asked for again.
    expect(refusalNote("heard-over", { answer: "allow", locked: false, unready: true })).toBe("voice-match-unready");
    expect(refusalNote("heard-over", { answer: "deny", locked: false, unready: true })).toBe("heard-over");
    // A consent card says it needs a click, whatever else holds.
    expect(refusalNote("click-only", { answer: "allow", locked: true, unready: true })).toBe("click-only");
    expect(VOICE_ANSWER_REFUSED.locked).not.toMatch(/again/i);
  });

  it("ends nothing Ember says while a question is up on an answer, so the end of its own voice never answers it (owner's report of 2026-11-12)", () => {
    // An answer window opens once Ember stops speaking: whatever the microphone still catches of its last words must be
    // no answer, yes or no, from any of its trailing words.
    const keys = [["Control Alt Y to allow", "Control Alt N for not now"], ["Windows key, Alt, Y to allow", "Windows key, Alt, N for not now"], ["Control Shift Command Y to allow"], ["Control Alt N for not now"]];
    const said: string[] = [];
    for (const k of keys) {
      said.push(questionAloud({ prompt: "Click Save in gedit?" }, { keys: k }).say);
      said.push(questionAloud({ prompt: "Type “Dear…Bye” into the “Message” field?", detail: "Dear team, … Bye", where: "on build-01" }, { keys: ["Control Alt Y to show the next part", ...k.slice(1)] }).say);
      for (const why of Object.keys(VOICE_ANSWER_REFUSED) as (keyof typeof VOICE_ANSWER_REFUSED)[]) said.push(voiceAnswerSaid(why, k), VOICE_ANSWER_REFUSED[why]);
    }
    for (const line of said) {
      const words = line.split(/\s+/);
      for (let i = 0; i < words.length; i++) expect(spokenAnswer(words.slice(i).join(" ")), `${line} → ${words.slice(i).join(" ")}`).toBeNull();
    }
    expect(questionAloud({ prompt: "Click Save?" }, { keys: ["Control Alt Y to allow", "Control Alt N for not now"] }).say).toBe("Ember asks: Click Save? To allow, press Control Alt Y; for not now, press Control Alt N.");
  });

  it("listens for a bare answer once each question and each note about it is said, and never sends what it hears there to Copilot (source pins)", () => {
    const main = fs.readFileSync(path.join(__dirname, "../../app/main/main.ts"), "utf8");
    expect(main).toMatch(/if \(maySpeak\(\)\) voice\?\.speak\(words \?\? aloud\.say\);\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*voice\?\.answerWindow\(\);/);
    expect(main).toMatch(/if \(maySpeak\(\)\) voice\?\.speak\(voiceAnswerSaid\(note, heldKeys\(\)\.map\(k => k\.say\)\)\);\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*voice\?\.answerWindow\(\);/);
    expect(main).toMatch(/if \(spokenReply\.kind === "none" && e\.window === "answer"\) break;/);
  });

  it("stops Ember and says once a question that it was still speaking, for any answer said over its voice, and listens for it again (owner's report of 2026-11-12)", () => {
    const main = fs.readFileSync(path.join(__dirname, "../../app/main/main.ts"), "utf8");
    // One place decides it, for every way such an answer arrives: an utterance said over Ember (own-voice), the engine's
    // answer-over (said in Ember's own words), and a wake Ember turned away as its own (heard-over).
    expect(main).toMatch(/const answerOverEmber = \(why: "own-voice" \| "heard-over", answer: "allow" \| "deny"\) => \{\s*if \(!confirmer\?\.waiting\) return;\s*log\.info\("voice\.answer_heard_over", \{ why, answer \}\);\s*voice\?\.hush\(\);\s*if \(heardOverFor !== confirmer\.currentNumber\) \{ heardOverFor = confirmer\.currentNumber; refuseVoiceAnswer\(why, answer\); \} else voice\?\.answerWindow\(\);\s*\};/);
    expect(main).toMatch(/if \(o\.kind === "refused" && o\.why === "own-voice"\) \{ answerOverEmber\("own-voice", o\.answer\); return; \}/);
    expect(main).toMatch(/case "answer-over":\s*answerOverEmber\("own-voice", e\.answer\);/);
    expect(main).toMatch(/if \(over\) answerOverEmber\("heard-over", over\);/);
    expect(VOICE_ANSWER_REFUSED["own-voice"]).toBe("I was still speaking, so I didn't take that as an answer. Say it again now.");
  });

  it("says once a question when an answer said over other sound wasn't taken, and how to be heard, rather than nothing (owner's report of 2026-11-12)", () => {
    expect(VOICE_ANSWER_REFUSED["over-sound"]).toBe("Something else was playing, so I couldn't tell that was for me: say my name first, then your answer.");
    const main = fs.readFileSync(path.join(__dirname, "../../app/main/main.ts"), "utf8");
    // Whichever window it was said in: a conversation over a playing video (the default) or a follow-up too.
    expect(main).toMatch(/if \(e\.answer && confirmer\?\.waiting && overSoundFor !== confirmer\.currentNumber\) \{ overSoundFor = confirmer\.currentNumber; refuseVoiceAnswer\(e\.reason, e\.answer\); \}/);
  });

  it("says why a yes without the name wasn't taken where nothing can tell whether other sound plays, and how to be heard (owner's report of 2026-11-12)", () => {
    expect(VOICE_ANSWER_REFUSED["sound-unknown"]).toBe("I can't tell here whether something else is playing, so I didn't take that as a yes: say my name first, then your answer.");
    expect(voiceAnswerSaid("sound-unknown", ["Control Alt Y to allow"])).toBe("I can't tell here whether something else is playing, so I didn't take that as a yes: say my name first, then your answer.");
  });

  it("watches whether other sound plays (Windows) while a conversation is open, a question is up or a task is at work, not only in a conversation (owner's report of 2026-11-12)", () => {
    const main = fs.readFileSync(path.join(__dirname, "../../app/main/main.ts"), "utf8");
    expect(main).toMatch(/const syncOutputWatch = \(\) => \{\s*const on = conversing \|\| questionIsUp \|\| !\(agent\?\.idle \?\? true\);\s*if \(on === outputWatched\) return;\s*outputWatched = on;\s*voice\?\.watchOutput\(on\);\s*\};\s*setInterval\(syncOutputWatch, 1000\)\.unref\?\.\(\);/);
    expect(main).toMatch(/voice\?\.questionUp\(q !== null\);\s*questionIsUp = q !== null;\s*syncOutputWatch\(\);/);
    expect(main).toMatch(/conversing = on;\s*syncOutputWatch\(\);/);
    expect(main).not.toContain("voice?.watchOutput(on);\n    if (on !== conversing)");
  });

  it("is wired in main from Voice Match's switch, not from whether it is ready, and every refusal goes through refusalNote (source pins)", () => {
    const main = fs.readFileSync(path.join(__dirname, "../../app/main/main.ts"), "utf8");
    expect(main).toMatch(/const matchOff = !settings\.get\(\)\.voice\.match;/);
    expect(main).toMatch(/confirmer\.answerVoice\(o\.answer, \{ verified: o\.verified, \.\.\.\(o\.kind === "answer" && o\.anyone \? \{ anyone: true \} : \{\}\),/);
    expect(main).toMatch(/const note = refusalNote\(why, \{ answer, locked: confirmer\.voiceLocked, unready: settings\.get\(\)\.voice\.match && !matchNow\(\) \}\);/);
  });
});

describe("“Work without asking” by voice (autonomy-intent.ts)", () => {
  it("hears turning it on and off, whole requests only", () => {
    for (const on of ["Ember, work without asking", "Hey Ember, stop asking for permission", "Work without asking from now on.", "You don't need to ask me first", "Can you work without asking?"]) expect(autonomyIntent(on), on).toBe("on");
    for (const off of ["Ask me first again", "Ember, ask me first", "Stop working without asking", "Start asking for permission again", "Check with me first"]) expect(autonomyIntent(off), off).toBe("off");
    for (const other of ["Work on my report without asking Sam", "Ember, stop", "What does work without asking do?", "Open Files"]) expect(autonomyIntent(other), other).toBeNull();
  });

  it("turns it on only from the owner's verified voice with its card agreed to; otherwise opens it in Settings", () => {
    const ready = { on: false, consented: true, managed: false, verified: true };
    expect(planAutonomyIntent("on", ready)).toMatchObject({ set: true, reply: expect.stringMatching(/^Okay, I'll work without asking.*still ask before anything risky.*“Ask me first again”.*“Ember, stop”/) });
    expect(planAutonomyIntent("on", { ...ready, verified: false })).toEqual({ open: { consent: false }, reply: expect.stringMatching(/Voice Match/) });
    expect(planAutonomyIntent("on", { ...ready, consented: false })).toEqual({ open: { consent: true }, reply: expect.stringMatching(/I've opened it in Settings/) });
    expect(planAutonomyIntent("on", { ...ready, consented: false, verified: false })).toMatchObject({ open: { consent: true } });
    expect(planAutonomyIntent("on", { ...ready, managed: true })).toEqual({ reply: "Your organisation doesn't allow that, so I'll keep asking first." });
    expect(planAutonomyIntent("on", { ...ready, on: true }).set).toBeUndefined();
  });

  it("asks for a little more, not for Voice Match's set-up, when the owner's voice was too short to vouch for (review of #127)", () => {
    const plan = planAutonomyIntent("on", { on: false, consented: true, managed: false, verified: false, short: true });
    expect(plan).toEqual({ reply: expect.stringMatching(/^Say a little more/) });
    expect(plan.reply).not.toMatch(/Voice Match/);
  });

  it("turns it off for anyone, verified or not", () => {
    expect(planAutonomyIntent("off", { on: true, consented: true, managed: false, verified: false })).toEqual({ set: false, reply: "Okay, I'll ask you first again." });
    expect(planAutonomyIntent("off", { on: false, consented: false, managed: true, verified: false })).toEqual({ reply: "I already ask you first." });
  });
});

describe("AgentHost's “Work without asking” switch by voice (no conductor tool, no Copilot turn)", () => {
  const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
  const host = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-autonomy-voice-"));
    const settings = new SettingsStore(path.join(dir, "settings.json"));
    settings.load();
    const answers: string[] = [];
    const opened: boolean[] = [];
    const h = new AgentHost({
      userData: dir, runtimePath: "/nowhere/copilot-runtime", settings, log: quiet, setState: () => undefined, onStatus: () => undefined, onAnswer: t => answers.push(t),
      autonomy: {
        state: () => ({ on: settings.get().autonomy.on, consented: autonomyConsented(settings.get().autonomy), managed: false }),
        set: on => { settings.update({ autonomy: { ...settings.get().autonomy, on, ...(on ? { scopes: { ...ALL_SCOPES } } : {}) } }); return true; },
        open: consent => { opened.push(consent); },
      },
    });
    return { h, settings, answers, opened };
  };

  it("opens its card instead of turning it on before the card is agreed to, even from a verified voice", async () => {
    const { h, settings, opened } = host();
    expect(await h.ask("Ember, work without asking", null, h.stopEpoch, { verified: true })).toBe(true);
    expect(settings.get().autonomy.on).toBe(false);
    expect(opened).toEqual([true]);
  });

  it("never says it works without asking when the change couldn't be recorded (review of #127)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-autonomy-voice-"));
    const settings = new SettingsStore(path.join(dir, "settings.json"));
    settings.load();
    const answers: string[] = [];
    const h = new AgentHost({
      userData: dir, runtimePath: "/nowhere/copilot-runtime", settings, log: quiet, setState: () => undefined, onStatus: () => undefined, onAnswer: t => answers.push(t),
      autonomy: { state: () => ({ on: false, consented: true, managed: false }), set: () => false, open: () => undefined },
    });
    await h.ask("Ember, work without asking", null, h.stopEpoch, { verified: true, spoken: true });
    expect(answers).toEqual([AUTONOMY_NOT_SAVED]);
  });

  it("turns it on only from a verified voice once agreed to, and off for anyone", async () => {
    const { h, settings, answers, opened } = host();
    settings.update({ autonomy: { ...settings.get().autonomy, consent: { version: FEATURE_CONSENT_VERSION.autonomy, at: "2026-11-02T10:00:00.000Z" } } });
    await h.ask("work without asking");
    expect(settings.get().autonomy.on).toBe(false);
    expect(opened).toEqual([false]);
    await h.ask("work without asking", null, h.stopEpoch, { verified: true });
    expect(settings.get().autonomy.on).toBe(true);
    await h.ask("Ask me first again");
    expect(settings.get().autonomy.on).toBe(false);
    expect(answers.at(-1)).toBe("Okay, I'll ask you first again.");
  });
});

describe("spoken answers as people say them (owner report of 2026-11-03: “Ember, allow” and “Ember, go ahead” did nothing on Windows)", () => {
  it("hears the yeses people naturally say, and the recognizer's ways with them", () => {
    for (const yes of [
      "Ember, allow.", "Allow it.", "Go ahead.", "Yes, do it.", "Okay, go ahead.", "Sure.", "Yeah, go ahead.", "Please go ahead.", "Allow, please.",
      "Hey, Ember. Allow.", "Amber, allow.", "Emma, go ahead.", "Yes.", "Yep, go ahead.", "Um, yes, go ahead.", "Please allow it.",
      // Moonshine's ways with "allow" and "go ahead".
      "Aloud.", "A loud.", "A low.", "Allowed.", "Go a head.", "Ember, aloud.",
      "Yes, please go ahead and allow it.", "Go ahead and allow that.",
    ]) expect(spokenAnswer(yes), yes).toBe("allow");
  });

  it("hears “okay, go with it”, “I accept”, “continue” and the other ways people say yes or no (owner's report of 2026-11-12)", () => {
    for (const yes of [
      "Allow.", "Yes.", "Yes please.", "Yeah.", "Yep.", "Sure.", "Okay.", "OK.", "Okay, go with it.", "Go with it.", "Go ahead.", "Go on.",
      "Accept.", "I accept.", "Continue.", "Confirm.", "Do it.", "Sounds good.", "That's fine.", "Fine.", "Alright.",
      "Hey Ember, I accept.", "Yes, continue.", "Okay, sounds good.", "Yes, go with it.",
    ]) expect(spokenAnswer(yes), yes).toBe("allow");
    for (const no of ["No.", "Deny.", "Don't.", "No thanks.", "Not now."]) expect(spokenAnswer(no), no).toBe("deny");
    // Still not answers: requests of their own (review of #127), or more than an answer.
    for (const other of ["Cancel.", "Never mind.", "Continue with the next file.", "I accept the terms and delete the rest.", "Confirm my order and pay."]) expect(spokenAnswer(other), other).toBeNull();
  });

  it("hears the noes people naturally say", () => {
    for (const no of ["Nah.", "No, not yet.", "Not right now.", "Don't allow it.", "No, no.", "Deny it.", "Ember, not now, thanks.", "Okay, no."]) expect(spokenAnswer(no), no).toBe("deny");
  });

  it("still never hears Always, a yes inside a longer request, or an answer it can't be sure of", () => {
    for (const other of [
      "Always.", "Always allow.", "Yes, always.", "Allow always.", "Go ahead and always allow it.", "Yes and also delete the files.",
      "Allow it to delete everything and then send the report to Sam", "No, go ahead.", "Go ahead, no.", "Hello.", "Read it aloud.", "Okay, so what's next?",
    ]) expect(spokenAnswer(other), other).toBeNull();
  });
});

describe("refusals of a spoken yes say exactly what to do, and are said aloud too", () => {
  const base: VoiceAnswerInput = { text: "Ember, allow", questionUp: true, matchOn: false, matchOff: false, verified: false, selfSpoke: false };

  it("tells Voice Match turned on but not ready (never taught, or its model not in) how to finish it or turn it off", () => {
    expect(voiceAnswer(base)).toEqual({ kind: "refused", answer: "allow", why: "voice-match-unready" });
    expect(VOICE_ANSWER_REFUSED["voice-match-unready"]).toBe("Voice Match is on but isn't ready yet, so I can't take a yes by voice: finish setting it up in Settings › Voice, or turn it off. Until then, click Allow or use the keys.");
    // "Not now" is still taken from anyone.
    expect(voiceAnswer({ ...base, text: "Not now" })).toEqual({ kind: "answer", answer: "deny", verified: false });
  });

  it("says them in words fit for speech: the menu path as words, no quote marks", () => {
    expect(voiceAnswerSaid("voice-match-unready")).toBe("Voice Match is on but isn't ready yet, so I can't take a yes by voice: finish setting it up in Settings, then Voice, or turn it off. Until then, click Allow or use the keys.");
    expect(voiceAnswerSaid("too-short")).toBe("I couldn't hear enough of your voice to be sure it's you. Say it a little longer, like Yes, please go ahead, so I can tell.");
    for (const why of Object.keys(VOICE_ANSWER_REFUSED) as (keyof typeof VOICE_ANSWER_REFUSED)[]) expect(voiceAnswerSaid(why), why).not.toMatch(/[›“”"]/);
  });

  it("asks again for an answer said over Ember's own voice, and never takes it", () => {
    expect(VOICE_ANSWER_REFUSED["heard-over"]).toBe("I heard you over my own voice, so I didn't take it. Say it again now that I've stopped.");
    // What the recognizer heard round the wake word Ember turned away while it spoke.
    expect(heardAnswer("Ember, allow.")).toBe("allow");
    expect(heardAnswer("Hey Ember, go ahead.")).toBe("allow");
    expect(heardAnswer("Ember, not now.")).toBe("deny");
    // Ember's own question read out ("Ember asks: … Press … for not now") is no answer.
    expect(heardAnswer("Ember asks: Click Save in gedit? Press Windows key, Alt, N for not now.")).toBeNull();
    expect(heardAnswer("Ember, stop.")).toBeNull();
    expect(heardAnswer("allow")).toBeNull();
  });
});

describe("spoken answers can't be padded or asked (review of #143)", () => {
  it("never takes a yes asked as a question", () => {
    for (const asked of ["Hey Ember, allowed?", "Ember, you can?", "Proceed?", "That's fine?", "Sure?", "Aloud?", "Ember, yes, you can go ahead?", "Go ahead? ", "Allow it?”", "Allow it?!", "allow it?.", "Allow?.", "Allow it?!?", "Allow it ?…", "Allow it？"]) {
      expect(spokenAnswer(asked), asked).toBeNull();
    }
    // A no is one either way, and the yeses themselves still count.
    expect(spokenAnswer("Not now?")).toBe("deny");
    for (const yes of ["Hey Ember, allowed.", "Ember, yes, you can go ahead.", "Proceed."]) expect(spokenAnswer(yes), yes).toBe("allow");
  });

  it("takes one filler word before an answer, never a run of them", () => {
    for (const padded of ["Oh, okay. Well, alright.", "Okay, okay, okay, okay, okay.", "Um, um, um, yes.", "So, um, okay.", "You can.", "Hey hey Ember, allow.", "Allow, please, please, please."]) {
      expect(spokenAnswer(padded), padded).toBeNull();
    }
    for (const yes of ["Okay, go ahead.", "Yes, you can.", "Um, yes.", "Okay, Ember, allow.", "Hey Ember, um, go ahead.", "Please do.", "Allow it, please, Ember.", "Yes, thank you."]) {
      expect(spokenAnswer(yes), yes).toBe("allow");
    }
  });

  it("takes a bare “okay” or “go on” as a yes, with one filler at most (owner's report of 2026-11-12)", () => {
    // Settled point (9) of 2026-11-12: these were bare acknowledgements (review of #143), and are yeses now.
    for (const yes of ["Okay.", "OK.", "Alright.", "All right.", "Go on.", "So okay.", "Um okay.", "Ember, okay."]) expect(spokenAnswer(yes), yes).toBe("allow");
  });

  it("counts “please” once in all, wherever it stands (review of #143)", () => {
    for (const padded of ["Please please do.", "Please, please go ahead.", "Yes please please.", "Please go ahead please.", "Allow it please please."]) {
      expect(spokenAnswer(padded), padded).toBeNull();
    }
    for (const yes of ["Please do.", "Yes please.", "Please go ahead.", "Go ahead, please."]) expect(spokenAnswer(yes), yes).toBe("allow");
  });

  it("has no refusal that reads as an answer or names Ember (it is said aloud, and heard back)", () => {
    for (const [why, words] of Object.entries(VOICE_ANSWER_REFUSED)) {
      for (const said of [words, voiceAnswerSaid(why as keyof typeof VOICE_ANSWER_REFUSED)]) {
        expect(spokenAnswer(said), why).toBeNull();
        expect(heardAnswer(said), why).toBeNull();
        expect(said.toLowerCase(), why).not.toMatch(/\b(?:ember|amber|emma)\b/);
      }
    }
  });
});

describe("a short yes on the task's voice trust (owner decision of 2026-11-03, “also trust the task's voice”)", () => {
  const short: VoiceAnswerInput = { text: "Ember, allow", questionUp: true, matchOn: true, matchOff: false, verified: false, short: true, restScore: 0.62, taskTrust: true, selfSpoke: false };

  it("takes the owner's short yes for a trusted task's question, unverified and marked as task-voice", () => {
    expect(voiceAnswer(short)).toEqual({ kind: "answer", answer: "allow", verified: false, trust: "task-voice" });
    // Too little voice to score at all (a very quiet or clipped yes next to a loud “Hey Ember”): never taken on trust,
    // since the floor could never apply to it and only the mostly-wake-phrase whole clip was matched (review of #143).
    const { restScore: _drop, ...unscored } = short;
    expect(voiceAnswer(unscored)).toEqual({ kind: "refused", answer: "allow", why: "too-short" });
    expect(voiceAnswer({ ...unscored, taskTrust: false })).toEqual({ kind: "refused", answer: "allow", why: "too-short" });
    // A verified yes stays a verified one, trust or not.
    expect(voiceAnswer({ ...short, verified: true, short: false })).toEqual({ kind: "answer", answer: "allow", verified: true });
  });

  it("refuses a stranger's clear mismatch, trusted task or not", () => {
    expect(voiceAnswer({ ...short, restScore: SHORT_YES_FLOOR - 0.01 })).toEqual({ kind: "refused", answer: "allow", why: "unverified" });
    expect(voiceAnswer({ ...short, restScore: 0.1, taskTrust: false })).toEqual({ kind: "refused", answer: "allow", why: "unverified" });
    expect(voiceAnswer({ ...short, restScore: SHORT_YES_FLOOR })).toMatchObject({ kind: "answer", trust: "task-voice" });
    // Compared as it is: a score just under the floor is under it (the voice process no longer rounds it up to it).
    expect(voiceAnswer({ ...short, restScore: 0.4996 })).toEqual({ kind: "refused", answer: "allow", why: "unverified" });
  });

  it("refuses when any of its conditions is broken", () => {
    // No trust (another task's question, none of a task's, time out, a voice turned away: TaskVoiceTrust says so).
    expect(voiceAnswer({ ...short, taskTrust: false })).toEqual({ kind: "refused", answer: "allow", why: "too-short" });
    // Not short: a request Voice Match couldn't check carries neither flag, and is never trusted.
    expect(voiceAnswer({ ...short, short: false })).toEqual({ kind: "refused", answer: "allow", why: "unverified" });
    // The echo guard, Voice Match off or unready: as ever.
    expect(voiceAnswer({ ...short, selfSpoke: true })).toEqual({ kind: "refused", answer: "allow", why: "own-voice" });
    expect(voiceAnswer({ ...short, matchOn: false })).toEqual({ kind: "refused", answer: "allow", why: "voice-match-unready" });
    // Voice Match switched off: a yes from anyone, never on the task's trust (it has no part in it then).
    expect(voiceAnswer({ ...short, matchOn: false, matchOff: true })).toEqual({ kind: "answer", answer: "allow", verified: false, anyone: true });
    // Never "Always", never a yes asked, never outside a question.
    expect(voiceAnswer({ ...short, text: "Always" })).toEqual({ kind: "none" });
    expect(voiceAnswer({ ...short, text: "Allow?" })).toEqual({ kind: "none" });
    expect(voiceAnswer({ ...short, questionUp: false })).toEqual({ kind: "none" });
  });

  describe("what ends every task's trust (main.ts wires these two; review of #143)", () => {
    it("ends when Voice Match turns another voice away, not for Ember's own speech, the speakers' stream or a failed check of the name", () => {
      expect(rejectionEndsTrust("voice")).toBe(true);
      for (const reason of ["self", "speakers", "check"] as const) expect(rejectionEndsTrust(reason), reason).toBe(false);
    });

    it("ends when a yes is turned away as not the owner's voice, and not for a no or a yes that was only too short, another task's or locked", () => {
      expect(refusalEndsTrust("unverified", "allow")).toBe(true);
      expect(refusalEndsTrust("unverified", "deny")).toBe(false);
      for (const result of ["too-short", "untrusted", "locked", "stale", "not-yet", "click-only", "own-voice", "voice-match-unready", "answered", "no-question"]) {
        expect(refusalEndsTrust(result, "allow"), result).toBe(false);
      }
      // And a stranger's clear mismatch is exactly what voiceAnswer calls "unverified".
      const stranger = voiceAnswer({ text: "Ember, allow", questionUp: true, matchOn: true, matchOff: false, verified: false, short: true, restScore: 0.2, taskTrust: true, selfSpoke: false });
      expect(stranger).toEqual({ kind: "refused", answer: "allow", why: "unverified" });
      expect(refusalEndsTrust(stranger.kind === "refused" ? stranger.why : "", "allow")).toBe(true);
    });

    it("is what main.ts calls, at both places, and when the voiceprint is forgotten, taught again or Voice Match is switched (source pins)", () => {
      const main = fs.readFileSync(path.join(__dirname, "../../app/main/main.ts"), "utf8");
      expect(main).toMatch(/if \(refusalEndsTrust\(result, o\.answer\)\) voiceTrust\.endAll\("other-voice"\);/);
      expect(main).toMatch(/if \(rejectionEndsTrust\(e\.reason\)\) voiceTrust\.endAll\("other-voice"\);/);
      // Forget my voice (which deletes the voiceprint and the learnt words: PersonalVoice.forgetVoice), a finished enrolment and the switch each end it (and only these three do, so a new place is a decision).
      expect(main.match(/voiceTrust\.endAll\("voice-changed"\)/g)).toHaveLength(3);
      expect(main).toMatch(/personal\.forgetVoice\(\);\s*\/\/[^\n]*\n\s*voiceTrust\.endAll\("voice-changed"\);/);
      expect(main).toMatch(/voiceprints\.write\(p\.print\);\s*\/\/[^\n]*\n\s*voiceTrust\.endAll\("voice-changed"\);/);
      expect(main).toMatch(/matchOn = next\.voice\.match;\s*\/\/[^\n]*\n\s*voiceTrust\.endAll\("voice-changed"\);/);
      // It decides before the Confirmer sees the yes, from the trust of the task whose question is up.
      expect(main).toMatch(/const taskTrust = voiceTrust\.holds\(confirmer\?\.currentTask\);/);
    });
  });

  describe("TaskVoiceTrust", () => {
    const at = (t0 = 10_000) => { let t = t0; const trust = new TaskVoiceTrust(() => t); return { trust, later: (ms: number) => { t += ms; } }; };

    it("holds for the task the verified request started, for TASK_VOICE_MS, and never for another task or none", () => {
      const { trust, later } = at();
      trust.grant("1-a", 10_000);
      expect(trust.holds("1-a")).toBe(true);
      expect(trust.holds("2-b")).toBe(false);
      expect(trust.holds(undefined)).toBe(false);
      later(TASK_VOICE_MS);
      expect(trust.holds("1-a")).toBe(true);
      later(1);
      expect(trust.holds("1-a")).toBe(false);
      expect(TASK_VOICE_MS).toBe(10 * 60_000);
    });

    it("ends for every task when Voice Match turns a voice away, and for one task changed by an unverified request", () => {
      const { trust } = at();
      trust.grant("1-a", 10_000);
      trust.grant("2-b", 10_000);
      trust.end("1-a", "steered");
      expect([trust.holds("1-a"), trust.holds("2-b")]).toEqual([false, true]);
      trust.endAll("other-voice");
      expect(trust.holds("2-b")).toBe(false);
      // A task asked for after it holds its own.
      trust.grant("3-c", 10_000);
      expect(trust.holds("3-c")).toBe(true);
    });

    it("ends for every task when the owner's voiceprint is forgotten or taught again, and a task asked for after holds its own", () => {
      const { trust } = at();
      trust.grant("1-a", 10_000);
      trust.endAll("voice-changed");
      expect(trust.holds("1-a")).toBe(false);
      trust.grant("2-b", 10_000);
      expect(trust.holds("2-b")).toBe(true);
    });

    it("never holds for a request dated in the future (a clock that jumped back)", () => {
      const { trust } = at();
      trust.grant("1-a", 20_000);
      expect(trust.holds("1-a")).toBe(false);
    });
  });

  describe("Confirmer.answerVoice with a task's trust", () => {
    const panel = { kind: "command", card: { sha256: "abc" } } as unknown as Question["panel"];

    it("allows only the trusting task's own question, as a verified yes would, and records it as task-voice", async () => {
      const { c, later } = confirmer();
      const question = q({ task: "1-a" });
      const answer = c.ask(question);
      expect(c.answerVoice("allow", { verified: false, trust: { task: "1-a" } })).toBe("not-yet");
      later(600);
      expect(c.currentTask).toBe("1-a");
      expect(c.answerVoice("allow", { verified: false, trust: { task: "2-b" } })).toBe("untrusted");
      expect(c.answerVoice("allow", { verified: false })).toBe("unverified");
      expect(c.answerVoice("allow", { verified: false, trust: { task: "1-a" } })).toBe("answered");
      expect(await answer).toBe("once");
      expect(c.howAnswered(question)).toEqual({ via: "voice", verified: false, trust: "task-voice" });
    });

    it("never for a question no task raised, a panel's (command card, consent card), a click-only one, one locked or one said before it", () => {
      for (const [o, want] of [
        [{}, "untrusted"], [{ task: "1-a", panel }, "untrusted"], [{ task: "1-a", clickOnly: true }, "click-only"],
      ] as const) {
        const { c, later } = confirmer();
        void c.ask(q(o));
        later(600);
        expect(c.answerVoice("allow", { verified: false, trust: { task: "1-a" } }), want).toBe(want);
      }
      const locked = confirmer();
      void locked.c.ask(q({ task: "1-a" }));
      locked.later(600);
      locked.c.lockVoice();
      expect(locked.c.answerVoice("allow", { verified: false, trust: { task: "1-a" } })).toBe("locked");
      const stale = confirmer();
      void stale.c.ask(q({ task: "1-a" }));
      stale.later(600);
      expect(stale.c.answerVoice("allow", { verified: false, trust: { task: "1-a" }, startedAt: 1000 })).toBe("stale");
      expect(stale.c.answerVoice("allow", { verified: false, trust: { task: "1-a" }, question: 99 })).toBe("stale");
    });

    it("never takes “Always”: only the primary option is allowed, and an “Always” primary not at all", () => {
      const { c, later } = confirmer();
      void c.ask(q({ task: "1-a", options: withAlways }));
      later(600);
      expect(c.answerVoice("allow", { verified: false, trust: { task: "1-a" } })).toBe("not-yet");
    });
  });
});

describe("whose words a heard request counts as, for commands", () => {
  it("never a song's: speech over other sound without a full match stays unchecked (PR 181 security review)", () => {
    expect(heardUnchecked({ overSound: true }, false, true)).toBe(true);
  });

  it("the owner's, over other sound, once Voice Match fully matched", () => {
    expect(heardUnchecked({ overSound: true, verified: true }, false, true)).toBe(false);
  });

  it("the user's in a quiet room where Ember can tell them from its speakers", () => {
    expect(heardUnchecked({}, false, true)).toBe(false);
  });

  it("nobody's after a click, or where Ember can't tell the user from its speakers, even when verified", () => {
    expect(heardUnchecked({ verified: true }, true, true)).toBe(true);
    expect(heardUnchecked({ verified: true }, false, false)).toBe(true);
  });
});

describe("a refused spoken yes keeps the keys that answer the question (tasks-approvals-6)", () => {
  it("shows the keys under the note, so a keyboard user keeps a way to answer", async () => {
    const shown: { bubble?: { step?: string | null } }[] = [];
    const c = new Confirmer(p => shown.push(p as never), { armMs: 0, gapMs: 0, keyHint: () => "Ctrl+Alt+Y allow · Ctrl+Alt+N not now" });
    const answer = c.ask({ title: "May I?", prompt: "Click “Send”?", options: [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }], task: "t1" });
    expect(shown.at(-1)?.bubble?.step).toBe("Ctrl+Alt+Y allow · Ctrl+Alt+N not now");
    c.note(VOICE_ANSWER_REFUSED["voice-match-unready"]);
    // On a line of their own under it: the bubble sets them as keycaps there (packages/bubble stepParts).
    expect(shown.at(-1)?.bubble?.step).toBe(`${VOICE_ANSWER_REFUSED["voice-match-unready"]}\nCtrl+Alt+Y allow · Ctrl+Alt+N not now`);
    c.note(VOICE_ANSWER_REFUSED.locked);
    expect(shown.at(-1)?.bubble?.step).toBe(`${VOICE_ANSWER_REFUSED.locked}\nCtrl+Alt+Y allow · Ctrl+Alt+N not now`);
    c.answerKey("deny");
    expect(await answer).toBe("deny");
  });

  it("says the keys Ember holds aloud where the line points to a click or the keys, and none it doesn't hold", () => {
    const keys = ["Control Alt Y to allow", "Control Alt N for not now"];
    expect(voiceAnswerSaid("voice-match-unready", keys)).toBe("Voice Match is on but isn't ready yet, so I can't take a yes by voice: finish setting it up in Settings, then Voice, or turn it off. Until then, click Allow or use the keys. Or, to allow, press Control Alt Y; for not now, press Control Alt N.");
    expect(voiceAnswerSaid("locked", keys)).toBe("I heard a voice that isn't yours, so for this question I'll take a click or the keys only. To allow, press Control Alt Y; for not now, press Control Alt N.");
    // The keys can't allow a click-only card, and other lines say what to say instead.
    expect(voiceAnswerSaid("click-only", keys)).toBe(voiceAnswerSaid("click-only"));
    expect(voiceAnswerSaid("too-short", keys)).toBe(voiceAnswerSaid("too-short"));
    expect(voiceAnswerSaid("voice-match-unready", [])).toBe(voiceAnswerSaid("voice-match-unready"));
  });
});
