/** The organisation's switch for the vault (the round's brief, decision 9): `features.vault: false` and a lockdown turn it off, shown managed. */

import { describe, expect, it } from "vitest";
import { AdminPolicySchema, heldUntilRestart, lockedDown, managedKeys, parseAdminPolicy, vaultAllowed, type LoadedAdminPolicy } from "../../app/main/admin";
import { FEATURE_TEXT, turnedOffWords } from "../../app/renderer/home/admin-copy";

const loaded = (raw: unknown): LoadedAdminPolicy => ({ policy: AdminPolicySchema.parse(raw), source: null });

describe("the organisation's policy and the vault", () => {
  it("allows the vault when the policy doesn't mention it or says true (vault-5)", () => {
    expect(vaultAllowed(loaded({}))).toBe(true);
    expect(vaultAllowed(loaded({ features: { vault: true } }))).toBe(true);
    expect(managedKeys(loaded({}).policy)).not.toContain("vault");
  });

  it("turns the vault off with features.vault: false, and Home shows it managed (vault-5)", () => {
    const off = loaded({ features: { vault: false } });
    expect(vaultAllowed(off)).toBe(false);
    expect(managedKeys(off.policy)).toContain("vault");
    expect(FEATURE_TEXT.vault).toBe("keeping logins, cards and contact details in the vault");
    expect(turnedOffWords({ vault: false }, "linux")).toEqual(["keeping logins, cards and contact details in the vault"]);
  });

  it("turns the vault off under a lockdown: a broken policy, and one that changed while Ember ran (vault-5)", () => {
    const broken = parseAdminPolicy("{ nope", "/etc/ember/policy.json");
    expect(broken.policy.features.vault).toBe(false);
    expect(vaultAllowed(broken)).toBe(false);
    expect(vaultAllowed(lockedDown("S", "unreadable"))).toBe(false);
    expect(vaultAllowed(heldUntilRestart(loaded({})))).toBe(false);
    expect(managedKeys(broken.policy)).toContain("vault");
  });

  it("reads a policy with a vault value that isn't true or false as broken (vault-5)", () => {
    expect(parseAdminPolicy(JSON.stringify({ features: { vault: "no" } }), "S").error).toMatch(/^S: features\.vault: /);
  });
});
