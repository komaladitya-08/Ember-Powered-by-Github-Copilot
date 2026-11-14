/**
 * After a Forget in Settings, the conversation still holds the fact (the user's statement, earlier `<memory>` blocks,
 * Ember's replies), so until it ends the remember tool keeps only what rests on the user's own words in that request,
 * as a turn already did (memory-r10-3). Before, it held back only a wording much like the forgotten one, and "Does not
 * eat meat" came back from Ember's own reply after "Is vegetarian" was forgotten.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConversationHold, HELD_UNSAID } from "../../app/main/memory/hold";
import { MemoryLearning } from "../../app/main/memory/learning";
import { MemoryService } from "../../app/main/memory/service";

const quiet = { info: () => undefined, warn: () => undefined };
const USER = [{ name: "User", kind: "person" as const }];

function rig() {
  const n = { e: 0, f: 0 };
  let now = Date.parse("2026-11-12T10:00:00Z");
  const clock = { now: () => new Date(now), id: (p: "e" | "f") => `${p}${++n[p]}` };
  const s = new MemoryService({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ember-memreworded-")), log: quiet, clock });
  const l = new MemoryLearning({ memory: s, inForce: () => true, questionsOn: () => false, askedAt: () => null, setAskedAt: () => undefined, idle: () => true, locked: () => false, say: () => true, log: quiet, now: () => now });
  const cm = l.conductorMemory();
  return {
    l, s, cm,
    later: (ms: number) => { now += ms; },
    /** A turn as the conductor runs it, with the remember tool's calls. */
    turn: async (said: string, reply: string, remember: string[]) => {
      const mark = cm.asked();
      await cm.forRequest(said, true);
      cm.began();
      const answers = remember.map(f => cm.remember(f, USER, said));
      cm.heard(said, reply, true, mark);
      return answers;
    },
    list: () => s.list().map(i => `${i.source}: ${i.text}`).sort(),
  };
}

describe("a fact forgotten in Settings, put back by the remember tool in other words (memory-r10-3)", () => {
  it("keeps nothing Ember's reply rewords after the Forget, only what rests on the user's words in the request (memory-r10-3)", async () => {
    const r = rig();
    await r.turn("I'm vegetarian, remember that.", "Noted.", ["Is vegetarian"]);
    r.later(60_000);
    r.l.forget(r.s.list()[0]!.id);
    r.later(5 * 60_000);
    const answers = await r.turn("Suggest a dinner recipe for tonight", "How about a mushroom risotto, since you don't eat meat?", ["Does not eat meat", "Follows a plant-based diet", "Wants dinner recipes"]);
    expect(answers.slice(0, 2)).toEqual([HELD_UNSAID, HELD_UNSAID]);
    // What rests on the user's own words in that request is still kept.
    expect(answers[2]).toMatch(/^Remembered/);
    expect(r.list()).toEqual(["user: Wants dinner recipes"]);
  });

  it("still keeps what the user says themselves in that request, and anything after the conversation ends (memory-r10-3)", async () => {
    const r = rig();
    await r.turn("I'm vegetarian, remember that.", "Noted.", ["Is vegetarian"]);
    r.l.forget(r.s.list()[0]!.id);
    r.later(5 * 60_000);
    expect((await r.turn("Remember that I work at Globex now", "Noted.", ["Works at Globex"]))[0]).toMatch(/^Remembered/);
    expect((await r.turn("My sister Priya lives in York", "Nice.", ["Sister Priya lives in York"]))[0]).toMatch(/^Remembered/);
    r.l.conversationEnded();
    expect((await r.turn("Suggest a dinner recipe", "Here is one.", ["Likes mushroom risotto"]))[0]).toMatch(/^Remembered/);
  });

  it("holds back a task's facts and the remember tool's alike after a correction too (memory-r10-3)", () => {
    const h = new ConversationHold();
    h.asked();
    h.gave("[f1] Is vegetarian");
    h.corrected("f1", "Is vegetarian", "Is pescatarian");
    expect(h.heldBack("Does not eat meat", "conversation", "tool", "Suggest a dinner recipe")).toBe("unsaid");
    expect(h.heldBack("Avoids meat in meals", "conversation", "task")).toBe("unsaid");
    expect(h.heldBack("Works at Globex", "conversation", "tool", "Remember that I work at Globex")).toBeNull();
    expect(h.heldBack("Does not eat meat", "user", "tool", "I don't eat meat")).toBeNull();
  });
});
