/**
 * The consent's bump for the vault and Autopilot's card (the round's brief, decision 8): "Before Ember starts" says what
 * the vault keeps and that only Autopilot uses it, and a user who agreed to Autopilot's old card is asked again.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { CONSENT_CHANGES, CONSENT_VERSION, FEATURE_CONSENT_VERSION, consentChangesSince } from "../../app/shared/consent";
import { modeCardVersion } from "../../app/shared/approvals";
import { AdminPolicySchema } from "../../app/main/admin";
import { approvalsState, chooseMode, modeInForce } from "../../app/main/policy/autonomy";
import { AUTOPILOT_CONSENT_TEXT } from "../../app/renderer/home/copy";
import { CONSENT_CHANGE_SOURCES } from "../../app/renderer/home/welcome-copy";

const PAGE = fs.readFileSync("app/renderer/home/index.html", "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");

describe("the consent and the vault", () => {
  it("is version 10, and tells someone who agreed before what the vault keeps and who uses it (vault-4)", () => {
    expect(CONSENT_VERSION).toBe(10);
    expect(consentChangesSince(9)).toEqual(["If you give me a login, a card or contact details in my Secure Form, I keep them in a vault on this computer, locked with your computer's keyring, until you forget them. Only Autopilot fills them in, and the AI model never sees them."]);
    expect(CONSENT_CHANGES[10]).not.toMatch(/\bwe\b|\bus\b|\bour\b|"/i);
  });

  it("says in Before Ember starts what the vault keeps, where, until when, and that only Autopilot fills it in (vault-4)", () => {
    const full = flat(PAGE.slice(PAGE.indexOf('id="welcome-h"'), PAGE.indexOf('id="w-rows"')));
    expect(full).toContain("If you give Ember a login, a card or contact details in its Secure Form, it keeps them in its vault on this computer, locked with your computer's keyring, until you forget them, sign out or choose Forget everything.");
    expect(full).toContain("It never types passwords. Only in Autopilot, it can fill in a login, a card or contact details from its vault, which the AI model never sees.");
    for (const source of CONSENT_CHANGE_SOURCES[10]) expect(full, source).toContain(source);
    expect(CONSENT_CHANGE_SOURCES[10]).toHaveLength(2);
  });

  it("says on Autopilot's card that Ember fills what was saved in the vault and the model never types or sees it (vault-4)", () => {
    expect(AUTOPILOT_CONSENT_TEXT.split("\n\n")[2]).toBe("It never repeats a step you said no to, never acts in your system's sign-in and password prompts, never uses your terminals, never reads windows on your never-look list and never runs a command that touches its own settings, record or Stop. The AI model never types or sees passwords or card numbers: Ember asks you once in its Secure Form, keeps them locked in its vault for that app or site, and fills them in there itself.");
    expect(AUTOPILOT_CONSENT_TEXT).not.toMatch(/never types passwords or card numbers,/);
    expect(AUTOPILOT_CONSENT_TEXT.split("\n\n")).toHaveLength(4);
  });

  it("asks someone who agreed to Autopilot's old card again before Autopilot is in force (vault-4)", () => {
    expect(FEATURE_CONSENT_VERSION.autopilot).toBe(2);
    expect(modeCardVersion("autopilot")).toBe(2);
    const policy = AdminPolicySchema.parse({});
    const at = "2026-11-12T10:00:00.000Z";
    const card = (version: number) => ({ version, at });
    const agreedOld = { mode: "autopilot" as const, consent: { interactive: card(FEATURE_CONSENT_VERSION.autonomy), assisted: card(FEATURE_CONSENT_VERSION.assisted), autopilot: card(1) } };
    expect(modeInForce(agreedOld, policy)).not.toBe("autopilot");
    const state = approvalsState(agreedOld, policy);
    expect(state.agreed).not.toContain("autopilot");
    expect(state.why).toBe("card");
    // An agreement that carries the old card's version is refused; the new one puts Autopilot in force.
    expect(chooseMode(agreedOld, "autopilot", 1, policy, at).ok).toBe(false);
    const again = chooseMode(agreedOld, "autopilot", 2, policy, at);
    expect(again.ok && modeInForce(again.approvals, policy)).toBe("autopilot");
  });
});
