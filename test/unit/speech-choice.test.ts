/** Whether Ember speaks out loud: automatically with a screen reader, always, or never (review #55, WCAG 1.4.2). */

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SettingsSchema } from "../../app/main/settings";
import { applyAdminPolicy, parseAdminPolicy } from "../../app/main/admin";
import { speakChoice, speakSettings, speaksAloud } from "../../app/shared/speech";

describe("speaking out loud", () => {
  it("by default always speaks, with or without a screen reader (Ember is a voice assistant)", () => {
    expect(speakChoice(DEFAULT_SETTINGS)).toBe("always");
    expect(speaksAloud(DEFAULT_SETTINGS, () => true)).toBe(true);
    expect(speaksAloud(DEFAULT_SETTINGS, () => false)).toBe(true);
  });

  it("“Never” wins over a screen reader: one voice, the reader's (review #55)", () => {
    const never = { ...DEFAULT_SETTINGS, ...speakSettings("never") };
    expect(speakChoice(never)).toBe("never");
    expect(speaksAloud(never, () => true)).toBe(false);
  });

  it("“Always” speaks without a screen reader, and doesn't ask whether one runs", () => {
    const always = { ...DEFAULT_SETTINGS, ...speakSettings("always") };
    expect(speakChoice(always)).toBe("always");
    expect(speaksAloud(always, () => { throw new Error("not asked"); })).toBe(true);
  });

  it("reads a settings file from before the choice as it was meant", () => {
    expect(speakChoice(SettingsSchema.parse({ speak: true }))).toBe("always");
    expect(speakChoice(SettingsSchema.parse({ speak: false }))).toBe("reader");
  });

  it("shows “Never” when the organisation turned speaking off", () => {
    const admin = parseAdminPolicy(JSON.stringify({ features: { speak: false } }), "/etc/ember/policy.json");
    expect(speakChoice(applyAdminPolicy({ ...DEFAULT_SETTINGS, ...speakSettings("always") }, admin.policy))).toBe("never");
  });
});
