/**
 * The daily question fails closed (r10-memory-y10-2, settled by the integrator, the owner can overrule): it asks only
 * about a name the user called their own person or project ("my colleague Priya", "our Atlas project"), and it is
 * text in Home's conversation only, never said aloud and never in the bubble or a corner card. No list names every
 * clinic, group or medicine that can stand where a person's name goes ("Book me in at Marie Stopes", "Email Dr Shah
 * about the scan"), and the bubble and the voice reach whoever is near.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IDLE_MS, MemoryLearning } from "../../app/main/memory/learning";
import { Gaps, QUESTION_EVERY_MS, askableNames, gapQuestion, namedAsTheirs } from "../../app/main/memory/questions";
import { MemoryService } from "../../app/main/memory/service";
import { MEMORY_QUESTIONS_HINT } from "../../app/renderer/home/copy";

const quiet = { info: () => undefined, warn: () => undefined };
const top = (requests: string[]) => { const g = new Gaps(); for (const r of requests) g.missed(r, () => false); return g.top(); };

/** Names that stand where someone or a project does, but that the user never called theirs: private ones among them. */
const NOT_THEIRS: [string, string][] = [
  ["Book me in with Marie Stopes", "Send the form to Marie Stopes"],
  ["Email Dr Shah about the results", "Did Dr Shah reply about the results"],
  ["Ask Mounjaro about the delivery", "Message Mounjaro about my order"],
  ["Draft a note to Relate about Tuesday", "Send the letter to Relate"],
  ["Lunch with Planned Parenthood volunteers", "Email Planned Parenthood about Saturday"],
  // Neighbours: a support group, a medicine's brand, a clinic, a lawyer's firm, a person merely named.
  ["Call Nar-Anon about the meeting", "Ask Nar-Anon about the meeting"],
  ["Email Saxenda support about the pens", "Write to Saxenda support about the refund"],
  ["Ask Dean Street about my appointment", "Email Dean Street about the appointment"],
  ["Send the papers to Slater Gordon", "Ask Slater Gordon about the papers"],
  ["Ask Priya about the roadmap", "Email Priya the notes"],
];

/** The user's own people and projects, said as theirs. */
const THEIRS: [string, string, string][] = [
  ["Email my colleague Priya the notes", "Ask Priya about the roadmap", "Priya"],
  ["What's the status of our Atlas project", "Summarise the Atlas notes", "Atlas"],
  ["Remind me to call my sister Asha", "Message my sister Asha about Sunday", "Asha"],
  ["Ask Bob, my manager, about the budget", "Send the deck to Bob", "Bob"],
  ["Book lunch with my new teammate Omar", "Lunch with Omar on Friday", "Omar"],
];

function learning() {
  let now = Date.parse("2026-11-12T10:00:00Z");
  const s = new MemoryService({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ember-memtheirs-")), log: quiet });
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

describe("the daily question asks only about the user's own people and projects", () => {
  it.each(NOT_THEIRS)("never asks about a name from “%s” and “%s”, never called theirs (r10-memory-y10-2)", async (a, b) => {
    expect(askableNames(a)).toEqual([]);
    expect(top([a, b, a, b])).toBeNull();
    const r = learning();
    for (const q of [a, b, a, b]) await r.ask(q);
    await r.idle();
    expect(r.said).toEqual([]);
  });

  it.each(THEIRS)("asks about the name in “%s” and “%s” (r10-memory-y10-2)", async (a, b, name) => {
    expect(namedAsTheirs(a)).toEqual([name]);
    const r = learning();
    await r.ask(a);
    await r.ask(b);
    await r.idle();
    expect(r.said).toEqual([gapQuestion(name)]);
  });

  it("counts a team lead or a project manager called theirs (r10-memory-y10-2)", () => {
    expect(namedAsTheirs("Email my team lead Joe")).toEqual(["Joe"]);
    expect(namedAsTheirs("Ask my project manager Lena about it")).toEqual(["Lena"]);
  });

  it("never counts a name the user calls their doctor's, therapist's, lawyer's or sponsor's (r10-memory-y10-2)", () => {
    for (const r of ["Email my doctor Dr Shah", "Ask my therapist Anna about Friday", "Send it to my lawyer Ruth", "Call my sponsor Dave", "Ask my counsellor Jo",
      "Book my GP Dr Patel", "Our clinic Marie Stopes", "My caseworker Sam called", "Message my colleague at Marie Stopes", "Ask my sister about Planned Parenthood",
      "Message my partner about Mounjaro", "Email my wife's therapist Dr Grey", "Book my son into Great Ormond Street"]) {
      expect(namedAsTheirs(r), r).toEqual([]);
    }
  });
});

describe("where the daily question is shown", () => {
  const read = (file: string) => fs.readFileSync(path.join(__dirname, "../../app/main", file), "utf8");

  it("is a line in Home's conversation only, never the bubble, a corner card or the voice (r10-memory-y10-2)", () => {
    const host = read("agent/host.ts");
    const body = host.slice(host.indexOf("  noteFromMemory(text: string): boolean {"), host.indexOf("\n  }\n", host.indexOf("  noteFromMemory(text: string): boolean {")));
    expect(body).toContain('this.remember("ember", text);');
    expect(body).not.toMatch(/presenter|onAnswer|onTurnStart|speak|say\(/);
    expect(host).not.toContain("sayFromMemory");
    // Only while Home is open to read it.
    expect(read("main.ts")).toContain("    say: text => homeOpen() && (agent?.noteFromMemory(text) ?? false),");
    // And Settings › Memory says so under its switch.
    expect(MEMORY_QUESTIONS_HINT).toBe("At most one question a day, only while you're not using Ember, about someone or a project you've called yours that it knows nothing about. It's written here in Home, never said aloud. Your answer is kept as something you told it.");
  });
});
