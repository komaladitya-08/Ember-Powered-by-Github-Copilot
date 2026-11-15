/**
 * The spoken "get to know me" where Ember can't tell the user's voice from its speakers (memory-r9-6): every spoken
 * request on Windows and macOS, every Listen once, and Linux with the speakers' check off. Unchecked speech is never
 * the user's own words, so nothing it says is kept; Ember says so and offers the typed way instead of asking five
 * questions, and it never ends "I'll remember that" when it kept nothing.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { INTRO_DONE, INTRO_NOTHING, INTRO_UNCHECKED, Interview } from "../../app/main/memory/intro";
import { MemoryLearning } from "../../app/main/memory/learning";
import { MemoryService } from "../../app/main/memory/service";
import { ABOUT_YOU, aboutYouHint } from "../../app/renderer/home/copy";
import { sectionRequest } from "../../app/renderer/home/section-request";

const quiet = { info: () => undefined, warn: () => undefined };

function learning() {
  const s = new MemoryService({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ember-memspoken-")), log: quiet });
  const opened = vi.fn();
  const spoken: boolean[] = [];
  const l = new MemoryLearning({ memory: s, inForce: () => true, questionsOn: () => false, askedAt: () => null, setAskedAt: () => undefined, idle: () => true, locked: () => false, say: () => true, openMemory: opened, setSpoken: on => spoken.push(on), log: quiet });
  return { l, s, opened, spoken };
}

describe("“get to know me” heard where Ember can't tell it is the user (memory-r9-6)", () => {
  it("asks nothing it couldn't keep the answer to: it says why, and opens Tell Ember about you (memory-r9-6)", () => {
    const { l, s, opened } = learning();
    expect(l.intent("Ember, get to know me", { own: false })).toBe(INTRO_UNCHECKED);
    expect(INTRO_UNCHECKED).toBe("I can't tell your voice from other sound here, so I don't keep what I hear as yours. I've opened Tell Ember about you in Settings: type your answers there and I'll remember them.");
    expect(opened).toHaveBeenCalledWith("about");
    // No interview began: what is said next is a request like any other, and nothing is kept.
    expect(l.intent("Call me Ram", { own: false })).toBeNull();
    expect(l.intent("I'm a designer at Globex", { own: false })).toBeNull();
    expect(s.list()).toEqual([]);
    // The same words from the user themselves still start it.
    expect(l.intent("Ember, get to know me", { own: true })).toMatch(/What should I call you\?$/);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("never ends “I'll remember that” when it kept nothing: every answer unchecked, or every question skipped (memory-r9-6)", () => {
    const unsure = learning();
    unsure.l.intent("get to know me", { own: true });
    // The interview began in the user's own voice; then Ember can no longer tell (Listen once, the speakers' check lost).
    for (const a of ["Call me Ram", "I'm a designer at Globex", "Figma and Slack", "short, spoken"]) expect(unsure.l.intent(a, { own: false })).toMatch(/^I couldn't be sure that was you, so I didn't keep it\. /);
    const end = unsure.l.intent("UK time", { own: false });
    expect(end).toBe(`I couldn't be sure that was you, so I didn't keep it. ${INTRO_NOTHING}`);
    expect(INTRO_NOTHING).toBe("I didn't keep anything this time. You can type your answers in Settings, under Memory.");
    expect(end).not.toContain("I'll remember that");
    expect(unsure.s.list()).toEqual([]);
    expect(unsure.spoken).toEqual([]);

    const skipped = learning();
    skipped.l.intent("get to know me", { own: true });
    for (let i = 0; i < 4; i++) skipped.l.intent("skip", { own: true });
    expect(skipped.l.intent("skip", { own: true })).toBe(INTRO_NOTHING);
  });

  it("still ends “I'll remember that” when it kept something, and says nothing was kept when memory refused every answer (memory-r9-6)", () => {
    const some = learning();
    some.l.intent("get to know me", { own: true });
    some.l.intent("Ram", { own: true });
    for (let i = 0; i < 3; i++) some.l.intent("skip", { own: false });
    expect(some.l.intent("skip", { own: true })).toBe(INTRO_DONE);
    expect(some.s.list().map(i => i.text)).toEqual(["Likes to be called Ram"]);

    // Every answer given held a secret, so memory kept none of them.
    const refused = learning();
    refused.l.intent("get to know me", { own: true });
    for (let i = 0; i < 4; i++) refused.l.intent("skip", { own: true });
    expect(refused.l.intent("My password is hunter2", { own: true })).toBe(INTRO_NOTHING);
    expect(refused.s.list()).toEqual([]);

    // The interview alone tells the same truth.
    const alone = new Interview(0);
    for (let i = 0; i < 4; i++) alone.answer("skip", true);
    expect(alone.answer("Mornings", false).say).toBe(`I couldn't be sure that was you, so I didn't keep it. ${INTRO_NOTHING}`);
  });

  it("offers the spoken version in Tell Ember about you only where Ember can tell the user's voice (memory-r9-6)", () => {
    expect(aboutYouHint(true, true)).toBe(`${ABOUT_YOU.lead} ${ABOUT_YOU.voice}`);
    expect(aboutYouHint(true, false)).toBe(ABOUT_YOU.lead);
    expect(aboutYouHint(false, true)).toBe(ABOUT_YOU.voice);
    expect(aboutYouHint(false, false)).toBe("");
    // The typed way opens at its first question, which a stray key only types into.
    expect(sectionRequest("memory:about-you")).toEqual({ section: "memory", control: "ay-name" });
    const MAIN = fs.readFileSync(path.join(__dirname, "../../app/main/main.ts"), "utf8");
    expect(MAIN).toContain('sendToHome(IPC.focusSection, at === "list" ? "memory:memory-query" : at === "about" ? "memory:about-you" : "memory:memory-consent-text");');
    const HOME = fs.readFileSync(path.join(__dirname, "../../app/renderer/home/main.ts"), "utf8");
    // Linux with the speakers' check on: the one place a spoken request is checked.
    expect(HOME).toContain("spokenVersion: () => platform?.speakerRejection === true && settings?.voice.speakerRejection !== false,");
    const WELCOME = fs.readFileSync(path.join(__dirname, "../../app/renderer/home/welcome.ts"), "utf8");
    expect(WELCOME).toContain("spokenVersion: () => status?.platform?.speakerRejection === true && settings?.voice.speakerRejection !== false,");
  });
});
