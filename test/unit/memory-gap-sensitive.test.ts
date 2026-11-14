/**
 * The daily question shows beside the cursor and is spoken by default while Ember has nothing to do, which says
 * nothing of who is at the screen (memory-c10-1). So it never asks about a name from a request about health, sexual
 * health or medicines, addiction, a crisis line, the law, money trouble, dating or sexuality, or faith: "You've
 * mentioned “HIV” a few times. Who or what is that?" must never be shown or said. Names from other requests are
 * asked about as before.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IDLE_MS, MemoryLearning } from "../../app/main/memory/learning";
import { Gaps, QUESTION_EVERY_MS, sensitiveRequest } from "../../app/main/memory/questions";
import { MemoryService } from "../../app/main/memory/service";

const quiet = { info: () => undefined, warn: () => undefined };

/** The challenger's requests, each asked twice in other words, then three neighbours of each kind. */
const SENSITIVE: [string, string][] = [
  ["Find an HIV clinic near me", "Is the HIV clinic open on Saturday?"],
  ["Find Alcoholics Anonymous meetings tonight", "When is the next Alcoholics Anonymous meeting?"],
  ["Look up Chlamydia symptoms", "Is Chlamydia treated with antibiotics?"],
  ["Look up Prozac side effects", "Order more Prozac"],
  ["Find the Samaritans number", "Call the Samaritans"],
  ["Email my lawyer at Slater Gordon about the divorce", "Ask Slater Gordon about custody"],
  ["Search for Tinder alternatives", "Open Tinder"],
  // Neighbours: health, a crisis, the law, money, dating, faith.
  ["Book a session with my therapist Anna", "Move Anna's therapy session to Friday"],
  ["Remind me to take the Sertraline", "Did I take the Sertraline today"],
  ["Find the Refuge helpline", "Call Refuge"],
  ["Email Brown & Co about the court date", "Ask Brown about the tribunal"],
  ["Reply to StepChange about my debt", "Open the StepChange letter about the debt plan"],
  ["Message Alex on Grindr", "Did Alex reply on Grindr"],
  ["Find the times at St Mary's church", "Is St Mary's mass at nine"],
];

/** Ordinary requests whose names Ember still asks about. */
const ORDINARY: [string, string, string][] = [
  ["Draft a note to Priya about Atlas", "Email Priya the Atlas plan", "Priya"],
  ["Ask Hopper about payroll", "Message Hopper about lunch", "Hopper"],
  ["Book a table with Sam for Friday", "Remind me about dinner with Sam", "Sam"],
];

function learning() {
  let now = Date.parse("2026-11-12T10:00:00Z");
  const s = new MemoryService({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ember-memgapsens-")), log: quiet });
  const said: string[] = [];
  let askedAt: string | null = null;
  const l = new MemoryLearning({
    memory: s, inForce: () => true, questionsOn: () => true, askedAt: () => askedAt, setAskedAt: at => { askedAt = at; }, idle: () => true, locked: () => false,
    say: text => { said.push(text); return true; }, log: quiet, now: () => now,
  });
  const tools = l.conductorMemory();
  return {
    said,
    ask: async (request: string) => { await tools.forRequest(request, true); },
    idle: async () => { now += QUESTION_EVERY_MS + IDLE_MS + 1000; await l.tick(); await l.tick(); },
  };
}

describe("the daily question never names something private from past requests (memory-c10-1)", () => {
  it.each(SENSITIVE)("never asks about a name from “%s” and “%s” (memory-c10-1)", async (a, b) => {
    expect(sensitiveRequest(a)).toBe(true);
    // Its names are never asked about, nor from a later request that names them alone ("Call Refuge").
    const g = new Gaps();
    for (const q of [a, b, a, b, b]) g.missed(q, () => false);
    expect(g.top()).toBeNull();
    const r = learning();
    for (const q of [a, b, a]) await r.ask(q);
    await r.idle();
    expect(r.said).toEqual([]);
  });

  it.each(ORDINARY)("still asks about a name from “%s” and “%s” (memory-c10-1)", async (a, b, name) => {
    expect(sensitiveRequest(a) || sensitiveRequest(b)).toBe(false);
    const r = learning();
    await r.ask(a);
    await r.ask(b);
    await r.idle();
    expect(r.said.join("\n")).toContain(`“${name}”`);
  });
});

/** The review's private requests that avoid every listed word (r10-memory-x10-2), then neighbours of each kind. */
const UNLISTED: [string, string][] = [
  ["Find the nearest Planned Parenthood", "Is Planned Parenthood open Saturday?"],
  ["Book me in at Marie Stopes", "What time does Marie Stopes open?"],
  ["Find a Gamblers Help group near me", "Is the Gamblers Help group on tonight?"],
  ["Email my oncologist Dr Shah about the PET scan", "Did Dr Shah reply about the PET scan?"],
  ["Find Narcotics meetings near me", "When is the next Narcotics meeting?"],
  ["Search for StepChange advice on my overdraft", "Did StepChange reply?"],
  ["Book a session with Dr Shah at the Tavistock", "Move my Tavistock session to Friday"],
  ["Look up Mounjaro side-effects", "Is Mounjaro covered?"],
  ["Remind me about my Weight Watchers weigh-in", "When is Weight Watchers?"],
  ["Find Al-Anon meetings near me", "When does Al-Anon meet?"],
  ["Find a Ramadan iftar near me", "Is the Ramadan iftar on tonight?"],
  // Neighbours: a brand of medicine, a clinic by its name, a group by its name, a specialist.
  ["Is Wegovy cheaper than Saxenda", "Does Saxenda work faster?"],
  ["Book me in at Dean Street", "What time does Dean Street close?"],
  ["Look up Nar-Anon in Leeds", "When does Nar-Anon meet?"],
  ["Email my psychiatrist Dr Patel", "Did Dr Patel reply?"],
  ["Find a Diwali puja near me", "Is the Diwali puja on tonight?"],
];

describe("the daily question asks only about a name where someone or a project stands (r10-memory-x10-2)", () => {
  it.each(UNLISTED)("never asks about a name from “%s” and “%s” (r10-memory-x10-2)", async (a, b) => {
    const r = learning();
    for (const q of [a, b, a, b]) await r.ask(q);
    await r.idle();
    expect(r.said).toEqual([]);
  });

  it("asks about someone named after “with”, “to”, “about” or a person's verb, never as a question's subject (r10-memory-x10-2)", () => {
    const top = (qs: string[]) => { const g = new Gaps(); for (const q of qs) g.missed(q, () => false); return g.top(); };
    expect(top(["Is Krita any good for sketches", "Does Krita do layers"])).toBeNull();
    expect(top(["Did Omar reply", "Has Omar sent it"])).toBeNull();
    expect(top(["Search for StepChange", "Look for StepChange"])).toBeNull();
    expect(top(["Lunch with Omar on Friday", "Send the deck to Omar"])).toBe("Omar");
    expect(top(["What's the status of Atlas", "Summarise the Atlas notes"])).toBe("Atlas");
  });
});
