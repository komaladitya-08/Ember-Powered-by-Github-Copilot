import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SettingsStore, DEFAULT_SETTINGS } from "../../app/main/settings";

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-settings-"));
  file = path.join(dir, "settings.json");
});

describe("SettingsStore", () => {
  it("uses defaults when no file exists, without writing one", () => {
    const s = new SettingsStore(file);
    expect(s.load().settings).toEqual(DEFAULT_SETTINGS);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("persists updates atomically and reloads them", () => {
    const s = new SettingsStore(file);
    s.load();
    s.update({ character: "glint", size: 72 });
    expect(fs.readdirSync(dir)).toEqual(["settings.json"]);
    const again = new SettingsStore(file);
    expect(again.load().settings).toMatchObject({ character: "glint", size: 72 });
  });

  it("rejects invalid updates and keeps the old value", () => {
    const s = new SettingsStore(file);
    s.load();
    expect(() => s.update({ size: 500 })).toThrow();
    expect(() => s.update({ character: "dragon" as never })).toThrow();
    expect(s.get().size).toBe(DEFAULT_SETTINGS.size);
  });

  it("repairs a partly invalid file, keeping valid fields and a backup", () => {
    fs.writeFileSync(file, JSON.stringify({ character: "wisp", size: "huge", speak: true }));
    const r = new SettingsStore(file).load();
    expect(r.settings).toMatchObject({ character: "wisp", size: DEFAULT_SETTINGS.size, speak: true });
    expect(r.recoveredFrom && fs.existsSync(r.recoveredFrom)).toBe(true);
  });

  it("recovers from a corrupt file", () => {
    fs.writeFileSync(file, "{ not json");
    const r = new SettingsStore(file).load();
    expect(r.settings).toEqual(DEFAULT_SETTINGS);
    expect(r.recoveredFrom).toBeDefined();
  });

  it("notifies listeners on change", () => {
    const s = new SettingsStore(file);
    s.load();
    const seen: string[] = [];
    const off = s.onChange(v => seen.push(v.character));
    s.update({ character: "glassling" });
    off();
    s.update({ character: "cinder" });
    expect(seen).toEqual(["glassling"]);
  });
});
