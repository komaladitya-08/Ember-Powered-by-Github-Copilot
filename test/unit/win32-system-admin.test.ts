/**
 * The administrator's policy on Windows (win32/system/admin-policy.ts): HKLM\SOFTWARE\Policies\Ember PolicyJson, read
 * through the registry's 64-bit view. Absent is "no policy"; everything else that isn't a valid policy locks Ember
 * down (fail closed): access denied, another value type, over 256 KiB, bad JSON, a schema error, a missing registry
 * API, and provider.apiKeyFile (unsupported on Windows). A REG_MULTI_SZ is read as lines of one JSON text. The
 * provider's key comes from ProviderApiKey, else EMBER_PROVIDER_API_KEY, and a key that can't be read throws.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APIKEY_FILE_REFUSED, MAX_POLICY_BYTES, POLICY_KEY, POLICY_LOCATION, win32AdminPolicy } from "../../app/main/platform/win32/system/admin-policy";
import { FakeRegistry, fakeApi, HKLM } from "./win32-system-fakes";

const source = (registry: FakeRegistry, env: NodeJS.ProcessEnv = {}) => win32AdminPolicy({ api: () => fakeApi(registry), env });
const LOCKED = { features: { voice: false, actions: false, cursor: false, desk: false, screenImages: false }, allowGrants: false, confirmEveryAction: true };

describe("loading the Windows admin policy", () => {
  it("names where the policy lives", () => {
    expect(source(new FakeRegistry()).location).toBe("HKLM\\SOFTWARE\\Policies\\Ember (PolicyJson)");
  });

  it("gives no policy when the key or the value isn't there", () => {
    const r = source(new FakeRegistry()).load();
    expect(r.source).toBeNull();
    expect(r.error).toBeUndefined();
    expect(r.policy.allowGrants).toBe(true);
    expect(source(new FakeRegistry().sz(HKLM, POLICY_KEY, "Other", "x")).load().source).toBeNull();
  });

  it("reads a REG_SZ policy", () => {
    const r = source(new FakeRegistry().sz(HKLM, POLICY_KEY, "PolicyJson", JSON.stringify({ confirmEveryAction: true, neverLook: ["keepass"] }))).load();
    expect(r).toMatchObject({ source: POLICY_LOCATION, policy: { confirmEveryAction: true, neverLook: ["keepass"] } });
    expect(r.error).toBeUndefined();
  });

  it("reads a REG_MULTI_SZ policy as one JSON text, line by line", () => {
    const r = source(new FakeRegistry().multiSz(HKLM, POLICY_KEY, "PolicyJson", ["{", "  \"allowGrants\": false,", "  \"maxActionsPerMinute\": 10", "}"])).load();
    expect(r.policy).toMatchObject({ allowGrants: false, maxActionsPerMinute: 10 });
    expect(r.error).toBeUndefined();
  });

  it("locks down for every value that can't be used", () => {
    const cases: [string, FakeRegistry, RegExp][] = [
      ["denied", new FakeRegistry().deny(HKLM, POLICY_KEY), /access denied \(error 5\)/],
      ["a DWORD", new FakeRegistry().dword(HKLM, POLICY_KEY, "PolicyJson", 1), /must be a string \(REG_SZ\) or a multi-string/],
      ["too large", new FakeRegistry().sz(HKLM, POLICY_KEY, "PolicyJson", `{"neverLook":["${"a".repeat(MAX_POLICY_BYTES / 2)}"]}`), /larger than 256 KiB/],
      ["bad JSON", new FakeRegistry().sz(HKLM, POLICY_KEY, "PolicyJson", "{ not json"), /is not valid JSON/],
      ["a schema error", new FakeRegistry().sz(HKLM, POLICY_KEY, "PolicyJson", "{\"maxActionsPerMinute\": 99}"), /maxActionsPerMinute/],
      ["an unknown key", new FakeRegistry().sz(HKLM, POLICY_KEY, "PolicyJson", "{\"surprise\": true}"), /surprise|Unrecognized/],
    ];
    for (const [what, registry, error] of cases) {
      const r = source(registry).load();
      expect(r.source, what).toBe(POLICY_LOCATION);
      expect(r.error, what).toMatch(error);
      expect(r.policy, what).toMatchObject(LOCKED);
    }
  });

  it("locks down when the registry can't be read at all", () => {
    const r = win32AdminPolicy({ api: () => null, env: {} }).load();
    expect(r.error).toMatch(/couldn't read the Windows registry/);
    expect(r.policy).toMatchObject(LOCKED);
  });

  it("locks down a policy that names an API key file (unsupported on Windows)", () => {
    const policy = { provider: { type: "openai", baseUrl: "https://llm.example.org/v1", apiKeyFile: "C:\\keys\\key.txt" } };
    const r = source(new FakeRegistry().sz(HKLM, POLICY_KEY, "PolicyJson", JSON.stringify(policy))).load();
    expect(r.error).toBe(APIKEY_FILE_REFUSED);
    expect(r.policy).toMatchObject(LOCKED);
  });

  it("reads a development policy file without the registry when EMBER_ADMIN_POLICY is given", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-admin-"));
    try {
      const file = path.join(dir, "policy.json");
      fs.writeFileSync(file, JSON.stringify({ allowGrants: false }));
      const r = win32AdminPolicy({ api: () => { throw new Error("the registry must not be read"); }, env: {} }).load(file);
      expect(r).toMatchObject({ source: file, policy: { allowGrants: false } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the provider's API key on Windows", () => {
  const provider = { type: "openai" as const, baseUrl: "https://llm.example.org/v1" };

  it("reads ProviderApiKey, trimmed", () => {
    expect(source(new FakeRegistry().sz(HKLM, POLICY_KEY, "ProviderApiKey", "  sk-123\r\n")).providerApiKey(provider)).toBe("sk-123");
  });

  it("falls back to EMBER_PROVIDER_API_KEY when the value isn't there", () => {
    expect(source(new FakeRegistry(), { EMBER_PROVIDER_API_KEY: "env-key" }).providerApiKey(provider)).toBe("env-key");
    expect(source(new FakeRegistry(), {}).providerApiKey(provider)).toBeUndefined();
  });

  it("throws when the value can't be read", () => {
    expect(() => source(new FakeRegistry().deny(HKLM, POLICY_KEY)).providerApiKey(provider)).toThrow(/can't read the ProviderApiKey value: access denied/);
    expect(() => win32AdminPolicy({ api: () => null, env: {} }).providerApiKey(provider)).toThrow(/couldn't read the Windows registry/);
  });
});
