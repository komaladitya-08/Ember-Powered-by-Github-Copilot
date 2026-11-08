/**
 * What the settings window says while the administrator's policy locks Ember down (review #112): a policy that changed
 * while Ember ran asks for a restart (it isn't called a problem), and in any lockdown the data list says that nothing
 * goes to a model service and no record of actions is deleted (#106, #107), not "go to GitHub Copilot" and "kept 30 days".
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FEATURE_TEXT, keptWords, lockdownMicWords, lockdownNotice, lockdownSendLine, turnedOffWords } from "../../app/renderer/home/admin-copy";
import { AdminPolicySchema } from "../../app/main/admin";

const inForce = { error: null, retentionDays: 30 };
const broken = { error: "/etc/ember/policy.json: Unrecognized key: \"futureKey\"", retentionDays: null };
const held = { error: "it changed while Ember was running; restart Ember to use it", held: true, retentionDays: null };

describe("the settings window under a lockdown", () => {
  it("asks for a restart when the policy changed while Ember ran, and says who fixes a broken one, never its raw error (safety-privacy-4)", () => {
    expect(lockdownNotice(held)).toBe("Your organisation changed Ember's policy. Restart Ember to use it.");
    expect(lockdownNotice(broken)).toBe("Your organisation's Ember policy has a problem, so Ember is locked down until it's fixed. Ask whoever manages this computer to fix it.");
    const json = { error: "/etc/ember/policy.json is not valid JSON: Expected double-quoted property name in JSON at position 65 (line 2 column 1)", retentionDays: null };
    expect(lockdownNotice(json)).not.toMatch(/\/etc|JSON|position|futureKey/);
    expect(lockdownNotice(inForce)).toBeNull();
  });

  it("says nothing goes to a model service while locked down", () => {
    expect(lockdownSendLine(inForce)).toBeNull();
    expect(lockdownSendLine(broken)).toMatch(/^, nothing is sent to a model service until your organisation fixes its policy/);
    expect(lockdownSendLine(held)).toMatch(/^, nothing is sent to a model service until you restart Ember/);
    for (const a of [broken, held]) expect(lockdownSendLine(a)).not.toMatch(/Copilot/);
  });

  it("says plainly that nothing heard is sent anywhere while locked down, instead of naming no model service mid-sentence (safety-privacy-r4)", () => {
    const before = "unless you turn on “Hey Ember” in settings or choose Listen once for one request. Once you call Ember it keeps listening through the conversation, and what it hears there goes to ";
    const after = " as text, without its name, until you say “That's all” or it has been quiet for 30 seconds. Listen once processes audio on this computer.";
    expect(lockdownMicWords(inForce, before, after)).toBeNull();
    expect(lockdownMicWords(broken, before, after)).toEqual([
      "unless you turn on “Hey Ember” in settings or choose Listen once for one request. Nothing it hears is sent anywhere until your organisation fixes its policy.",
      " Listen once processes audio on this computer.",
    ]);
    expect(lockdownMicWords(held, before, after)?.[0]).toMatch(/Nothing it hears is sent anywhere until you restart Ember\.$/);
    // Words it doesn't know (the page reworded): left alone rather than cut wrongly.
    expect(lockdownMicWords(broken, "something else ", after)).toBeNull();
  });

  it("says records are kept, none deleted, while locked down", () => {
    expect(keptWords(inForce)).toBe("kept 30 days");
    expect(keptWords({ error: null, retentionDays: 365 })).toBe("kept 365 days");
    expect(keptWords(broken)).toBe("none deleted until your organisation fixes its policy");
    expect(keptWords(held)).toBe("none deleted until you restart Ember");
  });

  it("names every switch the organisation turned off in words, never as a raw key such as “routines”", () => {
    const keys = Object.keys(AdminPolicySchema.shape.features.unwrap().shape);
    expect(keys).toEqual(expect.arrayContaining(["memory", "routines", "aiReview", "speak"]));
    for (const k of keys) expect(FEATURE_TEXT[k], k).toBeTruthy();
    const off = turnedOffWords(Object.fromEntries(keys.map(k => [k, false])), "win32");
    expect(off).toHaveLength(keys.length);
    for (const k of keys) expect(off).not.toContain(k);
    expect(turnedOffWords({ memory: false, routines: false, speak: false }, "linux"))
      .toEqual(["remembering between runs", "keeping routines and reminders", "speaking out loud"]);
    // WSL's switch means nothing off Windows (#221).
    expect(turnedOffWords({ wsl: false }, "linux")).toEqual([]);
  });

  it("matches the page's own words while the policy is in force", () => {
    const html = readFileSync(new URL("../../app/renderer/home/index.html", import.meta.url), "utf8");
    expect(html).toContain(`(<span id="retention">${keptWords(inForce)}</span>)`);
    expect(html).toMatch(/<li data-icon="send"><b>When you ask something<\/b>, your request/);
  });
});
