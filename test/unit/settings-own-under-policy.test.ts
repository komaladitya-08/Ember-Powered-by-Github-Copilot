/**
 * Home sends a section of settings whole, as it was shown them: the settings in force, with the organisation's values
 * on top (applyAdminPolicy). A change to one field must never write the organisation's forced values into the user's
 * own settings.json, where they would outlive the policy (home-r9-1): withOwnWhereForced puts the user's own back.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AdminPolicySchema, lockedDown } from "../../app/main/admin";
import { SettingsStore, withOwnWhereForced } from "../../app/main/settings";

function store(admin: ReturnType<typeof AdminPolicySchema.parse>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-own-"));
  const f = path.join(dir, "settings.json");
  const mine = new SettingsStore(f, null);
  mine.load();
  mine.update({ voice: { ...mine.own().voice, natural: true, naturalModel: "kokoro", clearHearing: true }, memory: { ...mine.own().memory, on: true } });
  const s = new SettingsStore(f, admin);
  s.load();
  const file = () => JSON.parse(fs.readFileSync(f, "utf8")) as { voice: { natural: boolean; naturalModel: string; clearHearing: boolean; rate: number }; memory: { on: boolean; askedAt?: unknown } };
  return { s, file };
}

describe("a change Home sends under the organisation's policy", () => {
  for (const [name, admin] of [["listening turned off", AdminPolicySchema.parse({ features: { voice: false } })], ["a lockdown", lockedDown("test", "broken").policy]] as const) {
    it(`keeps the user's own voice choice and Hear me more clearly when Speaking speed changes under ${name} (home-r9-1)`, () => {
      const { s, file } = store(admin);
      expect(s.get().voice).toMatchObject({ natural: false, clearHearing: false });
      // Home sends the whole voice object as it was shown it, with the one change.
      const sent = { voice: { ...s.get().voice, rate: 0.9 } };
      s.update(withOwnWhereForced(sent, s.own(), s.get()));
      expect(file().voice).toMatchObject({ natural: true, naturalModel: "kokoro", clearHearing: true, rate: 0.9 });
      // In force, the policy still holds.
      expect(s.get().voice).toMatchObject({ natural: false, clearHearing: false, rate: 0.9 });
    });
  }

  it("keeps memory on in the user's own file when a lockdown has it off and another memory field changes (home-r9-1)", () => {
    const { s, file } = store(lockedDown("test", "broken").policy);
    s.update(withOwnWhereForced({ memory: { ...s.get().memory, askedAt: "2026-11-13T09:00:00.000Z" } }, s.own(), s.get()));
    expect(file().memory.on).toBe(true);
    expect(s.get().memory.on).toBe(false);
  });

  it("still saves a value the user changed themselves, also one the organisation forces otherwise (home-r9-1)", () => {
    const { s, file } = store(AdminPolicySchema.parse({ features: { voice: false } }));
    s.update(withOwnWhereForced({ voice: { ...s.get().voice, clearHearing: true, natural: false } }, s.own(), s.get()));
    // natural: false is the forced value, so the user's own (true) stays; clearHearing true differs from it, so it's theirs.
    expect(file().voice).toMatchObject({ natural: true, clearHearing: true });
  });

  it("changes nothing where no policy forces a value", () => {
    const own = { voice: { natural: true, rate: 1 } } as never;
    expect(withOwnWhereForced({ voice: { natural: false, rate: 1 } } as never, own, own)).toEqual({ voice: { natural: false, rate: 1 } });
  });
});

describe("main's own changes to a settings section", () => {
  it("are built on the user's own settings, never on those in force (home-r9-1)", () => {
    const main = fs.readFileSync("app/main/main.ts", "utf8");
    expect(main).toContain("const mine = withOwnWhereForced(patch, settings.own(), settings.get());");
    // Mute, Voice Match on and off, memory's asked time, the update check's record.
    expect(main).not.toMatch(/settings\.update\(\{ (voice|memory|updates): \{ \.\.\.settings\.get\(\)\./);
    expect(main).toContain("settings.update({ voice: { ...settings.own().voice, muted: voice.isMuted } })");
    expect(main).toContain("settings.update({ memory: { ...settings.own().memory, askedAt: at } })");
  });
});
