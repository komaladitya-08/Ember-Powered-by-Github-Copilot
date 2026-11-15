/**
 * Tell Ember about you says which answer memory didn't keep and why (memory-r11-2): main reports the answers the guard
 * refused (`introduceAnswers`), and Home says so in plain words instead of "Saved 1 of 2 answers" or "Couldn't save
 * your answers. Try again.", which a retry of the same words can never make true.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryLearning } from "../../app/main/memory/learning";
import { MemoryService } from "../../app/main/memory/service";
import { aboutYouNotKept, aboutYouOutcome } from "../../app/renderer/home/copy";

const quiet = { info: () => undefined, warn: () => undefined };

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-intro-notkept-"));
  const memory = new MemoryService({ dir, log: quiet });
  const learning = new MemoryLearning({ memory, inForce: () => true, questionsOn: () => false, askedAt: () => null, setAskedAt: () => undefined, idle: () => true, locked: () => false, say: () => true, log: quiet });
  return { memory, learning };
}

describe("Tell Ember about you, when memory refuses an answer", () => {
  it("reports which answers weren't kept, beside how many were (memory-r11-2)", () => {
    const { memory, learning } = rig();
    expect(learning.introduceAnswers({ name: "Ram", work: "I sign in to Jira with ram and Winter#2024", hours: "UK, 9 to 5" })).toEqual({ kept: 2, notKept: ["work"] });
    expect(learning.introduceAnswers({ work: "My Netflix password is sunshine" })).toEqual({ kept: 0, notKept: ["work"] });
    expect(learning.introduceAnswers({ name: "Ram", length: "short" })).toEqual({ kept: 2, notKept: [] });
    // Still the count where only that is asked (the spoken interview, tests).
    expect(learning.introduce({ work: "My Netflix password is sunshine" })).toBe(0);
    expect(memory.list().map(i => i.text).join(" ")).not.toMatch(/Winter#2024|sunshine/);
    memory.stop();
  });

  it("says memory can't be read, never that every answer may hold a password, while memory.json is unreadable (r11-memory-x11-4)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-intro-unreadable-"));
    fs.mkdirSync(path.join(dir, "memory.json"));
    const memory = new MemoryService({ dir, log: quiet });
    expect(memory.unreadable).toBe(true);
    const learning = new MemoryLearning({ memory, inForce: () => true, questionsOn: () => false, askedAt: () => null, setAskedAt: () => undefined, idle: () => true, locked: () => false, say: () => true, log: quiet });
    const r = learning.introduceAnswers({ name: "Ram", work: "Product designer at Acme", hours: "Europe/London" });
    expect(r).toEqual({ kept: 0, notKept: [], unreadable: true });
    const said = aboutYouOutcome(r, ["name", "work", "hours"]);
    expect(said).toBe("Ember couldn't read your saved memory, so it's left as it was and nothing new is kept until Ember starts again. Check that your account can open memory.json in Ember's data folder, then restart Ember.");
    expect(said).not.toMatch(/password/);
    memory.stop();
  });

  it("says what was kept, which answer wasn't and why, or that nothing reached memory (memory-r11-2, r11-memory-x11-4)", () => {
    expect(aboutYouOutcome({ kept: 2, notKept: [] }, ["name", "hours"])).toBe("Saved 2 answers.");
    expect(aboutYouOutcome({ kept: 1, notKept: ["work"] }, ["name", "work"])).toBe(aboutYouNotKept(1, ["work"]));
    // An answer main says it didn't keep but that wasn't sent this time is not named.
    expect(aboutYouOutcome({ kept: 1, notKept: ["work"] }, ["name"])).toBe("Saved 1 answer.");
    expect(aboutYouOutcome(null, ["name"])).toBe("Couldn't save your answers. Try again.");
    expect(aboutYouOutcome({ kept: 0, notKept: [] }, ["name"])).toBe("Couldn't save your answers. Try again.");
  });

  it("says which answer and why, never \"Try again\" (memory-r11-2)", () => {
    expect(aboutYouNotKept(0, ["work"])).toBe("Ember didn't keep your role and work, because it may hold a password, a code or an ID number, which Ember never keeps. Change it or leave it out.");
    expect(aboutYouNotKept(1, ["work"])).toBe("Saved 1 answer. Ember didn't keep your role and work, because it may hold a password, a code or an ID number, which Ember never keeps. Change it or leave it out.");
    expect(aboutYouNotKept(2, ["work", "apps", "hours"])).toBe("Saved 2 answers. Ember didn't keep your role and work, the apps you use and your timezone or hours, because they may hold a password, a code or an ID number, which Ember never keeps. Change them or leave them out.");
  });
});
