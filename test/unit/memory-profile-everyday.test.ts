/**
 * A new name or answer length said the everyday way replaces the one from Tell Ember about you (memory-r10-2): "I go
 * by Raj these days, not Ram", "It's Raj, not Ram", "Call me Dr. Patel please", "My friends call me Raj, and so can
 * you", "Keep it brief", "Stop rambling", "Less waffle please". The profile goes with every request,
 * so before this the old name and length went on being sent while the new fact sat beside them, unsent.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryLearning } from "../../app/main/memory/learning";
import { lengthSaid, nameSaid } from "../../app/main/memory/profile";
import { MemoryService } from "../../app/main/memory/service";

const quiet = { info: () => undefined, warn: () => undefined };
const USER = [{ name: "User", kind: "person" as const }];

function rig() {
  const n = { e: 0, f: 0 };
  let now = Date.parse("2026-11-12T10:00:00Z");
  const clock = { now: () => new Date(now), id: (p: "e" | "f") => `${p}${++n[p]}` };
  const s = new MemoryService({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ember-memeveryday-")), log: quiet, clock });
  const l = new MemoryLearning({ memory: s, inForce: () => true, questionsOn: () => false, askedAt: () => null, setAskedAt: () => undefined, idle: () => true, locked: () => false, say: () => true, log: quiet, now: () => now });
  const tools = l.conductorMemory();
  return {
    l, s,
    day: () => { now += 86_400_000; },
    remember: (said: string, fact: string) => { tools.began(); return tools.remember(fact, USER, said); },
    list: () => s.list().map(i => `${i.source}: ${i.text}`).sort(),
    profile: async () => (await tools.forRequest("Draft a hello to the team", true)).replace(/^- \[[^\]]+\] \([^)]*\) /gm, "- "),
  };
}

describe("a name said the everyday way replaces the one from Tell Ember about you (memory-r10-2)", () => {
  const NAMES: [string, string, string][] = [
    ["I go by Raj these days, not Ram.", "Goes by Raj", "Raj"],
    ["It's Raj, not Ram.", "Likes to be called Raj", "Raj"],
    ["Call me Dr. Patel please.", "Likes to be called Dr. Patel", "Dr. Patel"],
    ["My friends call me Raj, and so can you.", "Likes to be called Raj", "Raj"],
    // Neighbours.
    ["I go by Raj nowadays.", "Goes by Raj", "Raj"],
    ["Ember, it's Raj, not Ram.", "Likes to be called Raj", "Raj"],
    ["Please call me Mrs. Shah from now on.", "Likes to be called Mrs. Shah", "Mrs. Shah"],
    ["Everyone calls me Raj, and you can too.", "Likes to be called Raj", "Raj"],
  ];
  it.each(NAMES)("“%s” saved as “%s” leaves one name, the new one, with every request (memory-r10-2)", async (said, fact, name) => {
    expect(nameSaid(said, "Ram")).toBe(name);
    const r = rig();
    r.l.introduce({ name: "Ram", length: "detailed" });
    r.day();
    expect(r.remember(said, fact)).toMatch(/^Remembered \[f3\], replacing \[f1\]\.$/);
    expect(r.list()).toEqual(["user: Prefers detailed answers", `user: Likes to be called ${name}`].sort());
    expect(await r.profile()).toContain(`- Likes to be called ${name}\n`);
    expect(await r.profile()).not.toContain("Ram");
  });

  it("still names no one from a place, a report or a call to make (memory-r10-2)", () => {
    for (const said of ["It's Paris, not london.", "It's raining, not snowing.", "It's Monday, not Tuesday", "My friends call me Raj", "My friends call me Raj, and my boss calls me Ram",
      "My boss said call me Dr. Patel", "Call me back, Dr. Patel", "It's Raj, not Ram, said Priya", "Is it Raj, not Ram?"]) {
      expect(nameSaid(said), said).toBeNull();
    }
  });
});

describe("an answer length said the everyday way replaces the one from Tell Ember about you (memory-r10-2)", () => {
  const LENGTHS: [string, "short" | "detailed"][] = [
    ["Keep it brief.", "short"], ["Stop rambling.", "short"], ["Less waffle please.", "short"],
    // Neighbours.
    ["Ember, keep it short please.", "short"], ["No more waffling.", "short"], ["Keep things detailed.", "detailed"],
  ];
  it.each(LENGTHS)("“%s” leaves the new length, and only it, with every request (memory-r10-2)", async (said, length) => {
    expect(lengthSaid(said)).toBe(length);
    const r = rig();
    r.l.introduce({ name: "Ram", length: length === "short" ? "detailed" : "short" });
    r.day();
    const fact = length === "short" ? "Prefers short answers" : "Prefers detailed answers";
    expect(r.remember(said, fact)).toMatch(/^Remembered \[f3\], replacing \[f2\]\.$/);
    expect(r.list()).toEqual([`user: ${fact}`, "user: Likes to be called Ram"].sort());
    expect(await r.profile()).toContain(`- ${fact}\n`);
  });

  it("still reads no length from a page to write, a request about someone else or a report (memory-r10-2)", () => {
    for (const said of ["Write to Priya and keep it brief", "Draft the email, shorter please", "Summarise this, keep it short", "Tell Bob to stop rambling",
      "Priya said stop rambling", "The talk should be shorter", "Shorter than the last one?", "Keep it brief for the board"]) {
      expect(lengthSaid(said), said).toBeNull();
    }
  });
});

describe("a length alone, or “It's X, not Y”, never overwrites what the user set (r10-memory-x10-3)", () => {
  it.each([["Shorter, please.", "Prefers shorter answers"], ["Much shorter, please.", "Prefers short answers"], ["More detail, please.", "Prefers detailed answers"], ["Longer.", "Prefers longer answers"]])(
    "“%s” alone keeps the profile's length, and “%s” stays the conversation's (r10-memory-x10-3)", async (said, fact) => {
      expect(lengthSaid(said)).toBeNull();
      const r = rig();
      r.l.introduce({ name: "Ram", length: fact.includes("detail") || fact.includes("longer") ? "short" : "detailed" });
      r.day();
      expect(r.remember(said, fact)).not.toMatch(/replacing \[f2\]/);
      expect(r.list()).toContain(fact.includes("detail") || fact.includes("longer") ? "user: Prefers short answers" : "user: Prefers detailed answers");
    });

  it.each([["It's Paris, not London.", "Paris"], ["It's March, not June.", "March"], ["It's Python, not Java.", "Python"], ["It's Zoom, not Teams.", "Zoom"]])(
    "“%s” never renames the user, whose name is Ram (r10-memory-x10-3)", async (said, word) => {
      expect(nameSaid(said, "Ram")).toBeNull();
      expect(nameSaid(said)).toBeNull();
      const r = rig();
      r.l.introduce({ name: "Ram", length: "detailed" });
      r.day();
      expect(r.remember(said, `Likes to be called ${word}`)).not.toMatch(/replacing \[f1\]/);
      expect(await r.profile()).toContain("- Likes to be called Ram\n");
    });

  it("still renames the user from “It's Raj, not Ram” when Ram is their name now (r10-memory-x10-3)", () => {
    expect(nameSaid("It's Raj, not Ram.", "Ram")).toBe("Raj");
    expect(nameSaid("It's Raj, not Sam.", "Ram")).toBeNull();
  });
});

describe("“keep it short” beside a request to make something leaves the user's length alone (r10-memory-y10-1)", () => {
  const MAKES: [string, "short" | "detailed"][] = [
    ["Make a toast for my sister's wedding, keep it short", "short"], ["Give me a caption for this photo, keep it brief", "short"],
    ["Create a bio for my LinkedIn. Keep it short.", "short"], ["Plan a speech for Friday, keep it brief please", "short"],
    ["Make a shopping list, keep it short", "short"], ["Put together a eulogy for my gran, keep it brief", "short"],
    ["Do a cover letter for Globex. Keep it detailed.", "detailed"], ["What's the capital of Peru? Keep it short.", "short"],
  ];
  it.each(MAKES)("“%s” keeps the profile's length (r10-memory-y10-1)", async (said, length) => {
    expect(lengthSaid(said)).toBeNull();
    const r = rig();
    r.l.introduce({ name: "Ram", length: length === "short" ? "detailed" : "short" });
    r.day();
    const fact = length === "short" ? "Prefers short answers" : "Prefers detailed answers";
    expect(r.remember(said, fact)).not.toMatch(/replacing \[f2\]/);
    expect(r.list()).toContain(length === "short" ? "user: Prefers detailed answers" : "user: Prefers short answers");
  });

  it("still reads “keep it brief” as the user's length when it is all the turn says (r10-memory-y10-1)", () => {
    for (const said of ["Keep it brief.", "Ember, keep it short please.", "Stop rambling, thanks.", "Please keep it brief. Stop rambling."]) {
      expect(lengthSaid(said), said).toBe("short");
    }
  });
});
