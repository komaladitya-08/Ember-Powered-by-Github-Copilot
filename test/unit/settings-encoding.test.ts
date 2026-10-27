/**
 * settings.json and the administrator's policy saved with a byte-order mark or as UTF-16 (Windows PowerShell 5.1's
 * `Set-Content -Encoding UTF8` and `Out-File`, older editors, deployment scripts) read as the same JSON: no setting
 * is reset (consent and onboarding included), and the policy doesn't lock Ember down (review #82).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore } from "../../app/main/settings";
import { loadAdminPolicy, parseAdminPolicy } from "../../app/main/admin";
import { decodeText } from "../../app/main/text-file";
import { CONSENT_VERSION } from "../../app/shared/consent";

const good = {
  character: "wisp", size: 80, onboarded: true, consent: { version: CONSENT_VERSION, at: "2026-01-01T00:00:00.000Z" },
  privacy: { neverLook: ["Bank"] }, grants: { gedit: "act" },
};
const json = JSON.stringify(good, null, 2);
const utf16be = (s: string) => { const b = Buffer.from(s, "utf16le"); for (let i = 0; i + 1 < b.length; i += 2) [b[i], b[i + 1]] = [b[i + 1], b[i]]; return b; };
const ENCODINGS: [string, Buffer][] = [
  ["UTF-8 with a byte-order mark", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json, "utf8")])],
  ["UTF-16 LE with a byte-order mark", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, "utf16le")])],
  ["UTF-16 BE with a byte-order mark", Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(json)])],
];

function fileWith(content: Buffer | string, name = "settings.json"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-enc-"));
  const f = path.join(dir, name);
  fs.writeFileSync(f, content);
  return f;
}

describe("settings.json in other encodings (review #82)", () => {
  for (const [name, bytes] of ENCODINGS) {
    it(`${name} keeps every setting, consent included, and isn't rewritten or kept as a bad copy`, () => {
      const f = fileWith(bytes);
      const store = new SettingsStore(f);
      const r = store.load();
      expect(r.recoveredFrom).toBeUndefined();
      expect(store.lastProblem).toBeNull();
      expect(r.settings).toMatchObject({ character: "wisp", size: 80, onboarded: true, grants: { gedit: "act" } });
      expect(r.settings.privacy.neverLook).toContain("Bank");
      expect(fs.readdirSync(path.dirname(f))).toEqual(["settings.json"]);
      expect(fs.readFileSync(f).equals(bytes)).toBe(true);
    });
  }

  it("a hand edit saved with a byte-order mark while Ember runs is picked up too", () => {
    const f = fileWith(JSON.stringify({ ...good, size: 60 }));
    const store = new SettingsStore(f);
    store.load();
    fs.writeFileSync(f, ENCODINGS[0][1]);
    fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
    expect(store.reloadIfChanged()).toBe(true);
    expect(store.get().size).toBe(80);
    expect(store.lastProblem).toBeNull();
  });

  it("decodeText leaves plain UTF-8 as it is", () => {
    expect(decodeText(Buffer.from("{\"a\":\"é\"}", "utf8"))).toBe("{\"a\":\"é\"}");
    expect(decodeText(Buffer.alloc(0))).toBe("");
  });
});

describe("the administrator's policy in other encodings (review #82)", () => {
  const policy = JSON.stringify({ allowGrants: false, neverLook: ["Payroll"] });

  it("a byte-order mark left on the text (a registry value, a remote's file) doesn't lock Ember down", () => {
    const r = parseAdminPolicy(`\uFEFF${policy}`, "policy.json");
    expect(r.error).toBeUndefined();
    expect(r.policy).toMatchObject({ allowGrants: false, neverLook: ["Payroll"] });
  });

  for (const [name, bytes] of ENCODINGS.map(([n]) => [n, n.startsWith("UTF-8") ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(policy)])
    : n.includes("LE") ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(policy, "utf16le")]) : Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(policy)])] as const)) {
    it(`a policy file in ${name} is read, not taken for a broken one`, () => {
      const r = loadAdminPolicy(fileWith(bytes, "policy.json"), { requireRootOwned: false });
      expect(r.error).toBeUndefined();
      expect(r.policy).toMatchObject({ allowGrants: false, neverLook: ["Payroll"] });
    });
  }

  it("a policy that still isn't JSON locks Ember down as before", () => {
    expect(parseAdminPolicy("\uFEFF{ nope", "policy.json").error).toMatch(/not valid JSON/);
  });
});
