/**
 * What the settings window says while the administrator's policy locks Ember down (review #112): a policy that changed
 * while Ember ran asks for a restart (it isn't called a problem), and in any lockdown the data list says that nothing
 * goes to a model service and no record of actions is deleted (#106, #107), not "go to GitHub Copilot" and "kept 30 days".
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FEATURE_TEXT, keptWords, lockdownNotice, lockdownSendLine, turnedOffWords } from "../../app/renderer/home/admin-copy";
import { AdminPolicySchema } from "../../app/main/admin";

const inForce = { error: null, retentionDays: 30 };
const broken = { error: "/etc/ember/policy.json: Unrecognized key: \"futureKey\"", retentionDays: null };
const held = { error: "it changed while Ember was running; restart Ember to use it", held: true, retentionDays: null };

describe("the settings window under a lockdown", () => {
  it("asks for a restart when the policy changed while Ember ran, and names a broken policy's problem", () => {
    expect(lockdownNotice(held)).toBe("Your organisation changed Ember's policy. Restart Ember to use it.");
    expect(lockdownNotice(broken)).toBe(`Your organisation's Ember policy has a problem, so Ember is locked down until it's fixed (${broken.error}).`);
    expect(lockdownNotice(inForce)).toBeNull();
  });

  it("says nothing goes to a model service while locked down", () => {
    expect(lockdownSendLine(inForce)).toBeNull();
    expect(lockdownSendLine(broken)).toMatch(/^, nothing is sent to a model service until your organisation fixes its policy/);
    expect(lockdownSendLine(held)).toMatch(/^, nothing is sent to a model service until you restart Ember/);
    for (const a of [broken, held]) expect(lockdownSendLine(a)).not.toMatch(/Copilot/);
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
