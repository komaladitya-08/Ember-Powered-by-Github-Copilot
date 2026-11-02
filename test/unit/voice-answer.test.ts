/**
 * Spoken answers to Ember's questions and "Work without asking" by voice (owner decision of 2026-11-02): what counts as
 * an answer, when a yes may be taken (only the owner's verified voice, never Ember's own, only during the question,
 * never "Always"), that anyone may say "Not now", and the voice switch's plans.
 */

import { describe, expect, it } from "vitest";
import { spokenAnswer, voiceAnswer, VOICE_ANSWER_REFUSED, type VoiceAnswerInput } from "../../app/main/agent/voice-answer";
import { Confirmer, type Question } from "../../app/main/agent/confirm";
import { autonomyIntent, planAutonomyIntent } from "../../app/main/agent/autonomy-intent";
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
  const base: VoiceAnswerInput = { text: "Ember, allow", questionUp: true, matchOn: true, verified: true, selfSpoke: false };

  it("takes a yes only from the owner's voice as Voice Match verified it", () => {
    expect(voiceAnswer(base)).toEqual({ kind: "answer", answer: "allow", verified: true });
    expect(voiceAnswer({ ...base, matchOn: false, verified: false })).toEqual({ kind: "refused", answer: "allow", why: "voice-match-off" });
    expect(voiceAnswer({ ...base, verified: false })).toEqual({ kind: "refused", answer: "allow", why: "unverified" });
    // A request heard without a check (the model failed) can't be a verified yes while Voice Match is off.
    expect(voiceAnswer({ ...base, matchOn: false, verified: true })).toEqual({ kind: "refused", answer: "allow", why: "voice-match-off" });
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
    expect(voiceAnswer({ ...base, text: "Not now", matchOn: false, verified: false })).toEqual({ kind: "answer", answer: "deny", verified: false });
    expect(voiceAnswer({ ...base, text: "No", verified: false })).toEqual({ kind: "answer", answer: "deny", verified: false });
  });

  it("asks for a little more when the owner's yes was too short for Voice Match to vouch for (security review of #127)", () => {
    expect(voiceAnswer({ ...base, verified: false, short: true })).toEqual({ kind: "refused", answer: "allow", why: "too-short" });
    expect(VOICE_ANSWER_REFUSED["too-short"]).toMatch(/“Ember, yes, go ahead and allow it\.”/);
  });

  it("says how to set Voice Match up when a yes can't be taken", () => {
    expect(VOICE_ANSWER_REFUSED["voice-match-off"]).toMatch(/Voice Match.*Settings › Voice/);
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
    expect(c.lockVoice()).toBe(true);
    expect(c.answerVoice("allow", { verified: true })).toBe("locked");
    expect(c.answerVoice("deny", { verified: false })).toBe("answered");
    expect(await answer).toBe("deny");
    expect(c.lockVoice()).toBe(false);
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
        set: on => settings.update({ autonomy: { ...settings.get().autonomy, on, ...(on ? { scopes: { ...ALL_SCOPES } } : {}) } }),
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
