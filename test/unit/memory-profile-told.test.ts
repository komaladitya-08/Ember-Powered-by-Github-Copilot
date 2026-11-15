/**
 * What to call the user and how long answers should be go with every request, so a fact takes their place in the
 * profile only when the user's own words tell Ember so and the fact is about them alone (memory-x9-1): never a name
 * or a length that the request only contains (a report, an errand, a pasted letter, the user's own writing). Those
 * are kept as the model gave them, as before the profile could be told in conversation.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryGraph } from "../../app/main/memory/graph";
import type { OneShot } from "../../app/main/memory/learn";
import { MemoryLearning } from "../../app/main/memory/learning";
import { aboutUser, lengthSaid, nameSaid, profileKind, profileSaid } from "../../app/main/memory/profile";
import { MemoryService } from "../../app/main/memory/service";

const quiet = { info: () => undefined, warn: () => undefined };
type About = { name: string; kind?: string }[];
const USER: About = [{ name: "User", kind: "person" }];

function rig() {
  const n = { e: 0, f: 0 };
  let now = Date.parse("2026-11-12T10:00:00Z");
  const clock = { now: () => new Date(now), id: (p: "e" | "f") => `${p}${++n[p]}` };
  const s = new MemoryService({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ember-memtold-")), log: quiet, clock });
  let offered: unknown[] = [];
  const model: OneShot = async () => JSON.stringify({ facts: offered });
  const l = new MemoryLearning({ memory: s, inForce: () => true, questionsOn: () => false, askedAt: () => null, setAskedAt: () => undefined, idle: () => true, locked: () => false, say: () => true, log: quiet, now: () => now });
  l.setModel(model);
  const tools = l.conductorMemory();
  return {
    l, s, tools,
    day: () => { now += 86_400_000; },
    /** What Settings lists: what holds now, then what no longer does. */
    review: () => s.review().map(i => `${i.source}: ${i.text}${i.until ? " (closed)" : ""}`),
    /** A turn in which the model calls remember. */
    remember: (said: string, fact: string, about: About = USER, replaces?: string) => { tools.began(); return tools.remember(fact, about, said, replaces); },
    /** A turn with no tool call, read afterwards for facts. */
    read: async (said: string, fact: string, about: About | undefined, evidence: string, more: Record<string, unknown> = {}) => {
      const mark = tools.asked();
      tools.began();
      tools.heard(said, "OK.", true, mark);
      offered = [{ from: 1, fact, ...(about ? { about } : {}), confidence: 0.9, evidence, ...more }];
      now += 61_000;
      await l.flush();
    },
    /** The `<memory>` block that goes with the next request, without ids and dates. */
    profile: async () => (await tools.forRequest("What's on today?", true)).replace(/^- \[[^\]]+\] \([^)]*\) /gm, "- "),
  };
}

const RAM = "<memory untrusted=\"true\">\n- Likes to be called Ram\n- Prefers detailed answers\n</memory>";

describe("a name the request only contains never becomes what to call the user (memory-x9-1)", () => {
  // [what the user said, the fact the model saves, what it is about, the words it rests on, how it is kept by the tool and when read]
  const CASES: [string, string, About | undefined, string, string, string][] = [
    ["Summarise this email for me: Hi, my name is Daniel. I'm the new account manager at Globex and I'd like to set up a call.",
      "The new account manager at Globex is named Daniel", [{ name: "Daniel", kind: "person" }], "my name is Daniel", "user", "conversation"],
    ["Summarise this email for me. Hi, my name is Daniel. I'm the new account manager at Globex.", "Likes to be called Daniel", undefined, "my name is Daniel", "conversation", "conversation"],
    ["My boss said call me Dave", "Boss likes to be called Dave", [{ name: "Boss", kind: "person" }], "My boss said call me Dave", "conversation", "conversation"],
    ["Write to Priya: my name is Bob", "Priya's contact is named Bob", [{ name: "Priya", kind: "person" }], "my name is Bob", "conversation", "conversation"],
    ["Call me Sam. My brother is also called Sam", "Brother is also called Sam", [{ name: "Brother", kind: "person" }], "My brother is also called Sam", "user", "user"],
    ["Play Call Me Al", "Likes the song called Call Me Al", [{ name: "Call Me Al", kind: "thing" }], "Play Call Me Al", "conversation", "conversation"],
  ];
  it.each(CASES)("“%s” saved as “%s” by the remember tool leaves the name they gave with every request (memory-x9-1)", async (said, fact, about, _evidence, tool) => {
    const r = rig();
    r.l.introduce({ name: "Ram", length: "detailed" });
    r.day();
    // Kept as the model gave it, never in place of what the user told Ember about themselves.
    expect(r.remember(said, fact, about ?? USER)).toMatch(/^Remembered \[f3\]\.(?: It didn't replace what the user told Ember themselves, \[f1\] “Likes to be called Ram”.*)?$/);
    expect(r.review()).toEqual([`${tool}: ${fact}`, "user: Prefers detailed answers", "user: Likes to be called Ram"]);
    r.day();
    expect(await r.profile()).toBe(RAM);
  });
  it.each(CASES)("“%s” read as “%s” leaves the name they gave with every request (memory-x9-1)", async (said, fact, about, evidence, _tool, read) => {
    const r = rig();
    r.l.introduce({ name: "Ram", length: "detailed" });
    r.day();
    await r.read(said, fact, about, evidence);
    expect(r.review()).toEqual([`${read}: ${fact}`, "user: Prefers detailed answers", "user: Likes to be called Ram"]);
    r.day();
    expect(await r.profile()).toBe(RAM);
  });

  it("takes a name only from a clause that begins with the telling, never one a report, an errand, a colon or quotes hold (memory-x9-1)", () => {
    for (const said of [
      "My boss said call me Dave", "My boss says just call me Dave", "Tell Priya to call me Sam", "Remind me to tell the team to call me Sam", "ask him to call me Thursday",
      "Play Call Me Al", "Search for the lyrics of Call Me Maybe", "Write to Priya: my name is Bob", "Text mum: call me Tonight", "Translate 'my name is Juan' into Spanish",
      "Translate “my name is Juan” into Spanish", "The form says my name is Samuel", "Everyone at work thinks my name is Samuel",
      "Summarise this email for me: Hi, my name is Daniel. I'm the new account manager at Globex.", "Summarise this email for me. Hi, my name is Daniel.",
      "Reply to this. Hi, my name is Daniel.", "Fix the grammar. my name is daniel and i has a question", "Hi, my name is Daniel.\nI'm the new account manager at Globex.",
      `Hi, my name is Daniel. ${"I'd like to talk about our renewal and what we can offer next year. ".repeat(3)}`, "Call me \"Sam\"",
    ]) expect(nameSaid(said), said).toBeNull();
    // Told plainly, it is still taken (memory-r9-5).
    for (const said of ["Call me Sam from now on.", "Hey Ember, call me Sam", "Actually, my name is Sam.", "By the way, I go by Sam now", "OK so you can call me Sam, please", "Call me Sam. What's on today?"]) {
      expect(nameSaid(said), said).toBe("Sam");
    }
  });

  it("keeps the profile for a fact about the user alone that says only what to call them (memory-x9-1)", () => {
    expect(profileSaid("Likes to be called Sam", USER, "Call me Sam")).toMatchObject({ text: "Likes to be called Sam", predicate: "called", source: "user" });
    expect(profileSaid("The user's preferred name is Sam", [{ name: "the user" }, { name: "Sam", kind: "person" }], "Call me Sam")).toMatchObject({ text: "Likes to be called Sam" });
    // About someone else, or about the user and someone else.
    expect(profileSaid("Likes to be called Sam", [{ name: "Boss", kind: "person" }], "Call me Sam")).toBeNull();
    expect(profileSaid("Likes to be called Sam", [...USER, { name: "Priya", kind: "person" }], "Call me Sam")).toBeNull();
    // Said of someone else in the fact's own words, whatever it is filed under.
    for (const fact of ["Boss likes to be called Sam", "Brother is also called Sam", "The new account manager at Globex is named Sam", "Sam is the name of the new account manager",
      "Priya's contact is named Sam", "Has a brother called Sam", "Likes the song called Sam", "Works with someone called Sam"]) {
      expect(profileSaid(fact, USER, "Call me Sam"), fact).toBeNull();
      expect(profileKind(fact), fact).toBeNull();
    }
    expect(aboutUser(USER)).toBe(true);
    expect(aboutUser([{ name: "Ember", kind: "app" }, ...USER])).toBe(false);
    expect(aboutUser([])).toBe(false);
  });
});

describe("a length that is about something else never becomes how long Ember's answers should be (memory-x9-1)", () => {
  // [what the user said, the fact the model saves, what it is about, how it is kept by the tool, and when read (null: not kept)]
  const CASES: [string, string, About | undefined, string, string | null][] = [
    ["Keep my replies to customers short and polite", "Prefers short, polite replies to customers", undefined, "user", null],
    ["Make my explanations in the report more detailed", "Wants more detailed explanations in the report", [{ name: "Report", kind: "thing" }], "user", "conversation"],
    ["I always write detailed replies to my manager", "Writes detailed replies to their manager", undefined, "user", null],
    ["Write a short reply to Priya", "Prefers short replies", undefined, "user", "conversation"],
  ];
  it.each(CASES)("“%s” saved as “%s” by the remember tool leaves the answer length they chose with every request (memory-x9-1)", async (said, fact, about, tool) => {
    const r = rig();
    r.l.introduce({ name: "Ram", length: "detailed" });
    r.day();
    expect(r.remember(said, fact, about ?? USER)).not.toContain("replacing");
    expect(r.review()).toEqual([`${tool}: ${fact}`, "user: Prefers detailed answers", "user: Likes to be called Ram"]);
    r.day();
    expect(await r.profile()).toBe(RAM);
  });
  it.each(CASES)("“%s” read as “%s” leaves the answer length they chose with every request (memory-x9-1)", async (said, fact, about, _tool, read) => {
    const r = rig();
    r.l.introduce({ name: "Ram", length: "detailed" });
    r.day();
    await r.read(said, fact, about, said);
    expect(r.review()).toEqual([...(read ? [`${read}: ${fact}`] : []), "user: Prefers detailed answers", "user: Likes to be called Ram"]);
    r.day();
    expect(await r.profile()).toBe(RAM);
  });

  it("reads a length only from words about Ember's answers to the user (memory-x9-1)", () => {
    for (const said of [
      "Keep my replies to customers short and polite", "Write a short reply to Priya", "Draft a detailed response to the auditor", "The presentation should be brief",
      "Give Priya a short answer: no", "Give Priya short answers", "Make my explanations in the report more detailed", "Summarise this in a short answer",
      "I want a detailed explanation of this error", "Be brief with Priya", "I always write detailed replies to my manager", "Priya wants short answers",
      "My boss says your answers are too long", "Why are your answers so short?", "Priya's answers are too long", "Write short answers to these questions",
      "Proofread this: your answers are too long", "Your answers are fine. Write a short email to Bob.",
    ]) expect(lengthSaid(said), said).toBeNull();
    // Told plainly, it is still read (memory-r9-5).
    expect(lengthSaid("Your answers are too long. Write a detailed report for Priya.")).toBe("short");
    expect(lengthSaid("Can you give me shorter answers?")).toBe("short");
    expect(lengthSaid("Ember, be more concise")).toBe("short");
    expect(lengthSaid("You're too wordy")).toBe("short");
    expect(lengthSaid("Shorter answers, please")).toBe("short");
    expect(lengthSaid("I'd like more detailed answers")).toBe("detailed");
  });

  it("keeps the profile for a fact about the user alone that says only how long answers should be (memory-x9-1)", () => {
    expect(profileSaid("Prefers shorter answers", USER, "Your answers are too long")).toMatchObject({ text: "Prefers short answers", predicate: "answer_length", source: "user" });
    expect(profileSaid("Prefers shorter answers", [{ name: "Priya", kind: "person" }], "Your answers are too long")).toBeNull();
    for (const fact of ["Prefers short, polite replies to customers", "Wants more detailed explanations in the report", "Writes detailed replies to their manager", "Priya prefers short answers"]) {
      expect(profileSaid(fact, USER, "Your answers are too long. I prefer short answers"), fact).toBeNull();
      expect(profileKind(fact), fact).toBeNull();
    }
  });
});

describe("saying your name again keeps it in the profile (memory-x9-5)", () => {
  const SAM = "<memory untrusted=\"true\">\n- Likes to be called Sam\n</memory>";

  it("leaves the name under the profile's relation when the turn that restates it is read under another relation's name (memory-x9-5)", async () => {
    const r = rig();
    r.l.introduce({ name: "Sam" });
    r.day();
    await r.read("I like to be called Sam, as you know", "Likes to be called Sam", USER, "I like to be called Sam", { predicate: "preferred_name", single: true });
    expect(r.review()).toEqual(["user: Likes to be called Sam"]);
    r.day();
    expect(await r.profile()).toBe(SAM);
    // And a later answer in Tell Ember about you still replaces it.
    r.l.introduce({ name: "Samuel" });
    expect(r.review()).toEqual(["user: Likes to be called Samuel", "user: Likes to be called Sam (closed)"]);
  });

  it("leaves it there when the remember tool restates it as another relation's one value (memory-x9-5)", async () => {
    const r = rig();
    r.l.introduce({ name: "Sam", length: "short" });
    r.day();
    expect(r.remember("Remember: likes to be called Sam.", "Likes to be called Sam", USER, "preferred_name")).toBe("Already remembered [f1].");
    expect(await r.profile()).toBe("<memory untrusted=\"true\">\n- Likes to be called Sam\n- Prefers short answers\n</memory>");
  });

  it("re-labels a fact said again only when it had no relation or a stronger source says it (memory-x9-5)", () => {
    const n = { e: 0, f: 0 };
    const g = new MemoryGraph(undefined, { now: () => new Date("2026-11-12T10:00:00Z"), id: p => `${p}${++n[p]}` });
    const add = (text: string, source: "user" | "conversation", predicate?: string) => g.add({ text, about: USER.map(a => ({ name: a.name, kind: "person" as const })), source, ...(predicate ? { predicate, single: true } : {}) });
    add("Lives in Leeds", "user", "lives_in");
    // The same source, another name for the relation: the fact stays where the user's later "Lives in York" will find it.
    expect(add("Lives in Leeds", "user", "home_city")).toMatchObject({ kind: "reinforced", fact: { predicate: "lives_in" } });
    expect(add("Lives in Leeds", "conversation", "based_in")).toMatchObject({ kind: "reinforced", fact: { predicate: "lives_in", source: "user" } });
    expect(add("Lives in York", "user", "lives_in")).toMatchObject({ kind: "added", closed: [{ text: "Lives in Leeds" }] });
    // No relation yet: it takes the one it is said again under (memory-r9-5).
    add("Likes to be called Ram", "user", "called");
    add("Likes to be called Sam", "conversation");
    expect(add("Likes to be called Sam", "user", "called")).toMatchObject({ kind: "reinforced", fact: { predicate: "called", source: "user" } });
    expect(g.allFacts(true).map(f => f.text).sort()).toEqual(["Likes to be called Sam", "Lives in York"]);
    // The conversation's, under a model's own name for the relation: the user's telling takes it over.
    add("Works at Globex", "user", "works_at");
    add("Works at Initech", "conversation", "employer");
    expect(add("Works at Initech", "user", "works_at")).toMatchObject({ kind: "reinforced", fact: { predicate: "works_at", source: "user" } });
    expect(g.allFacts(true).map(f => f.text).sort()).toEqual(["Likes to be called Sam", "Lives in York", "Works at Initech"]);
  });
});

describe("the natural ways of giving a new name replace the one from Tell Ember about you (memory-x9-4)", () => {
  const WORDINGS: [string, string, string | undefined][] = [
    ["Call me Sam, not Ram.", "Likes to be called Sam", undefined],
    ["Can you call me Sam?", "Likes to be called Sam", undefined],
    ["Could you call me Sam from now on?", "Likes to be called Sam", "called"],
    ["Would you call me Sam please?", "Prefers to be called Sam", "preferred_name"],
    ["Please call me Sam instead of Ram.", "Likes to be called Sam instead of Ram", undefined],
    ["I'm Sam, not Ram.", "Name is Sam", "name"],
    ["My name's Sam, not Ram.", "Name is Sam, not Ram", "name"],
    ["Don't call me Ram, call me Sam.", "Likes to be called Sam", undefined],
    ["Stop calling me Ram, it's Sam", "Goes by Sam", undefined],
    ["I'd rather be called Sam.", "Would rather be called Sam", undefined],
    ["I'd rather you called me Sam.", "Likes to be called Sam", undefined],
    ["My name is Sam and I work at Globex.", "Name is Sam", "name"],
    ["Call me Sam please, and open Firefox", "Likes to be called Sam", undefined],
  ];
  it.each(WORDINGS)("“%s” saved as “%s” leaves one name, the new one, with every request (memory-x9-4)", async (said, fact, replaces) => {
    const r = rig();
    r.l.introduce({ name: "Ram", length: "detailed" });
    r.day();
    expect(r.remember(said, fact, USER, replaces)).toBe("Remembered [f3], replacing [f1].");
    // The same turn, read afterwards, keeps no second copy under another subject.
    await r.read(said, fact, undefined, said.replace(/[.!?]$/, ""), replaces ? { predicate: replaces, single: true } : {});
    expect(r.review()).toEqual(["user: Likes to be called Sam", "user: Prefers detailed answers", "user: Likes to be called Ram (closed)"]);
    r.day();
    expect(await r.profile()).toBe("<memory untrusted=\"true\">\n- Likes to be called Sam\n- Prefers detailed answers\n</memory>");
  });

  it("takes them only as tellings: never a call to make, a comparison, a report or a condition (memory-x9-4)", () => {
    for (const [said] of WORDINGS) expect(nameSaid(said), said).toBe("Sam");
    for (const said of [
      "Can you call me?", "Can you call me a taxi?", "Could you call me back?", "Can you call me tomorrow?", "Can you call me Thursday?", "Would you call me Sam if you were me?",
      "Can you call me Sam's number?", "Call me Sam?", "Call me Sam, will you?", "Don't call me Sam", "Don't call me Ram, call Sam", "Never call me Ram",
      "I'm tired, not hungry", "I'm Sam's brother, not Ram's", "I'm sure, not certain", "I'm Sam", "I'm in Leeds, not York", "Call me Sam, said my boss",
      "Call me Sam, not Ram, said the email", "Call me Sam and tell Priya I said hi", "Call me Sam when you're ready", "Call me crazy but I love Mondays",
      "I'd rather be called back", "I'd rather you called me tomorrow", "My name is Sam said nobody ever", "It's Sam actually.", "Just Sam is fine.",
    ]) expect(nameSaid(said), said).toBeNull();
  });

  it("says which name still goes with every request when a fact of the user's own about their name stands beside it (memory-x9-4)", async () => {
    const r = rig();
    r.l.introduce({ name: "Ram", length: "detailed" });
    r.day();
    // In the user's own words, so theirs, but not in words Ember takes as what to call them.
    expect(r.remember("Name is Sam Lee, that is all", "Name is Sam Lee", USER, "name"))
      .toBe("Remembered [f3]. It didn't replace [f1] “Likes to be called Ram”, which still holds and goes with every request: Ember couldn't tell from the user's words that this takes its place. Tell the user plainly, and that they can say it plainly (“Call me …”, “Give me shorter answers”) or use Correct… in Settings › Memory.");
    expect(r.review()).toEqual(["user: Name is Sam Lee", "user: Prefers detailed answers", "user: Likes to be called Ram"]);
    expect(await r.profile()).toContain("- Likes to be called Ram");
    // Nothing to say for a fact of theirs about something else.
    expect(r.remember("I have a brother called Sam", "Has a brother called Sam", USER)).toMatch(/^Remembered \[f\d+\]\.$/);
  });
});
