/**
 * What a locked-down Ember may still use (review #107): while the administrator's policy can't be used, Ember sends
 * nothing to any model service (neither GitHub Copilot nor the organisation's own endpoint it can no longer read), and
 * says why in plain words.
 */

import { describe, expect, it } from "vitest";
import { AdminPolicySchema, lockedDown, modelServiceRefusal, parseAdminPolicy, type LoadedAdminPolicy } from "../../app/main/admin";

const FILE = "/etc/ember/policy.json";
const none: LoadedAdminPolicy = { policy: AdminPolicySchema.parse({}), source: null };

describe("modelServiceRefusal", () => {
  it("refuses every model service while the policy can't be used, in plain words", () => {
    // The organisation requires its own endpoint, but the file has a key this Ember doesn't know.
    const broken = parseAdminPolicy(JSON.stringify({ provider: { type: "openai", baseUrl: "https://llm.example.com/v1" }, futureKey: 1 }), FILE);
    const why = modelServiceRefusal(broken);
    expect(why).toMatch(/policy has a problem/);
    expect(why).toMatch(/model service/);
    expect(why).not.toMatch(/brain|sidecar|worker|tier|lockdown/i);
    expect(modelServiceRefusal(lockedDown(FILE, "must belong to root"))).toBe(why);
  });

  it("refuses nothing for a policy that reads fine, or none", () => {
    expect(modelServiceRefusal(none)).toBeNull();
    expect(modelServiceRefusal(parseAdminPolicy(JSON.stringify({ features: { actions: false } }), FILE))).toBeNull();
    expect(modelServiceRefusal(parseAdminPolicy(JSON.stringify({ provider: { type: "openai", baseUrl: "https://llm.example.com/v1" } }), FILE))).toBeNull();
  });
});
