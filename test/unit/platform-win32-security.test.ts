/**
 * When Windows won't let Ember's input through (pure): UIPI drops input to elevated or higher-integrity programs
 * silently, so those windows are refused with a plain reason; a token that can't be read is refused too (fail
 * closed); and the secure desktop (UAC, the lock screen) counts as "not the user's desktop".
 */

import { describe, expect, it } from "vitest";
import { blockReason, ELEVATED_REASON, onUsersDesktop, uipiBlock, UNCHECKED_REASON } from "../../app/main/platform/win32/security";

const MEDIUM = 0x2000, HIGH = 0x3000, SYSTEM = 0x4000;

describe("UIPI and elevated windows", () => {
  it("lets input through to programs at Ember's level or below", () => {
    expect(uipiBlock({ elevated: false, integrity: MEDIUM }, { elevated: false, integrity: MEDIUM })).toBeNull();
    expect(uipiBlock({ elevated: true, integrity: HIGH }, { elevated: true, integrity: HIGH })).toBeNull();
    expect(uipiBlock({ elevated: true, integrity: HIGH }, { elevated: false, integrity: MEDIUM })).toBeNull();
    expect(uipiBlock({ elevated: false, integrity: MEDIUM }, { elevated: false, integrity: 0x1000 })).toBeNull();
  });

  it("refuses a program running as administrator, or at a higher integrity level, while Ember isn't", () => {
    expect(uipiBlock({ elevated: false, integrity: MEDIUM }, { elevated: true, integrity: HIGH })).toBe("elevated");
    expect(uipiBlock({ elevated: false, integrity: MEDIUM }, { elevated: false, integrity: HIGH })).toBe("elevated");
    expect(uipiBlock({ elevated: true, integrity: HIGH }, { elevated: false, integrity: SYSTEM })).toBe("elevated");
  });

  it("refuses when a token or an integrity level couldn't be read", () => {
    expect(uipiBlock(null, { elevated: false, integrity: MEDIUM })).toBe("unchecked");
    expect(uipiBlock({ elevated: false, integrity: MEDIUM }, null)).toBe("unchecked");
    expect(uipiBlock({ elevated: false, integrity: null }, { elevated: false, integrity: MEDIUM })).toBe("unchecked");
    expect(uipiBlock({ elevated: false, integrity: MEDIUM }, { elevated: false, integrity: null })).toBe("unchecked");
  });

  it("explains a block in one plain sentence", () => {
    expect(blockReason("elevated")).toBe(ELEVATED_REASON);
    expect(ELEVATED_REASON).toBe("That window belongs to a program running as administrator, so Ember can't use the mouse or keyboard there.");
    expect(blockReason("unchecked")).toBe(UNCHECKED_REASON);
    expect(blockReason(null)).toBeNull();
  });
});

describe("the input desktop", () => {
  it("is the user's only when it is the Default desktop", () => {
    expect(onUsersDesktop("Default")).toBe(true);
    expect(onUsersDesktop("default")).toBe(true);
    expect(onUsersDesktop("Winlogon")).toBe(false);
    expect(onUsersDesktop("Screen-saver")).toBe(false);
    expect(onUsersDesktop(null)).toBe(false); // couldn't be opened: the secure desktop has it
  });
});
