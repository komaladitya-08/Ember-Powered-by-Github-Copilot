/** admin.ts split into parseAdminPolicy and lockedDown (design §4.16, §9.4): every OS's policy source reuses them, Linux unchanged. */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdminPolicySchema, loadAdminPolicy, lockedDown, parseAdminPolicy } from "../../app/main/admin";

const LOCKDOWN = AdminPolicySchema.parse({
  features: { voice: false, actions: false, cursor: false, desk: false, screenImages: false, wsl: false, ssh: false },
  allowGrants: false,
  confirmEveryAction: true,
  commands: { local: "off", wsl: "off", ssh: "off" },
});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ember-admin-"));
const write = (text: string) => { const f = path.join(tmp(), "policy.json"); fs.writeFileSync(f, text); return f; };

describe("parseAdminPolicy", () => {
  it("reads a valid policy and names its source", () => {
    const r = parseAdminPolicy(JSON.stringify({ features: { voice: false }, maxActionsPerMinute: 10 }), "HKLM\\SOFTWARE\\Policies\\Ember (PolicyJson)");
    expect(r).toEqual({ policy: AdminPolicySchema.parse({ features: { voice: false }, maxActionsPerMinute: 10 }), source: "HKLM\\SOFTWARE\\Policies\\Ember (PolicyJson)" });
    expect(r.error).toBeUndefined();
  });

  it("locks Ember down for text that isn't JSON, with today's wording", () => {
    const r = parseAdminPolicy("{ nope", "/etc/ember/policy.json");
    expect(r.policy).toEqual(LOCKDOWN);
    expect(r.source).toBe("/etc/ember/policy.json");
    expect(r.error).toMatch(/^\/etc\/ember\/policy\.json is not valid JSON: /);
  });

  it("locks Ember down for a schema break, naming the field (or the top) as before", () => {
    expect(parseAdminPolicy(JSON.stringify({ features: { voice: "no" } }), "S")).toMatchObject({ policy: LOCKDOWN, source: "S", error: expect.stringMatching(/^S: features\.voice: /) });
    expect(parseAdminPolicy(JSON.stringify({ surprise: true }), "S").error).toMatch(/^S: \(top\): /);
    expect(parseAdminPolicy("[]", "S").error).toMatch(/^S: \(top\): /);
  });
});

describe("lockedDown", () => {
  it("is the lockdown policy with its source and reason", () => {
    expect(lockedDown("/Library/Application Support/Ember", "must belong to root")).toEqual({ policy: LOCKDOWN, source: "/Library/Application Support/Ember", error: "must belong to root" });
  });
});

describe("loadAdminPolicy (built on them)", () => {
  it("gives the same answers and texts as before for each case", () => {
    const missing = path.join(tmp(), "none.json");
    expect(loadAdminPolicy(missing)).toEqual({ policy: AdminPolicySchema.parse({}), source: null });

    const good = write(JSON.stringify({ confirmEveryAction: true }));
    expect(loadAdminPolicy(good)).toEqual({ policy: AdminPolicySchema.parse({ confirmEveryAction: true }), source: good });

    const bad = write("{,}");
    const r = loadAdminPolicy(bad);
    expect(r).toMatchObject({ policy: LOCKDOWN, source: bad });
    expect(r.error).toBe(parseAdminPolicy("{,}", bad).error);

    const invalid = write(JSON.stringify({ maxActionsPerMinute: 99 }));
    expect(loadAdminPolicy(invalid).error).toMatch(new RegExp(`^${invalid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: maxActionsPerMinute: `));
  });

  it("still requires a root-owned, root-only-writable file when asked", () => {
    const f = write("{}");
    const r = loadAdminPolicy(f, { requireRootOwned: true });
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      expect(r).toEqual({ policy: LOCKDOWN, source: f, error: `${f} must belong to root and be writable only by root` });
    }
  });

  it("locks down an unreadable file with today's wording", () => {
    const dir = tmp();
    const r = loadAdminPolicy(dir);
    expect(r).toMatchObject({ policy: LOCKDOWN, source: dir, error: expect.stringMatching(new RegExp(`^can't read `)) });
  });
});
