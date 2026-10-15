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

describe("settings keep what the user set (review fixes)", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ember-settings-"));

  it("one bad never-look entry or grant drops only that entry", () => {
    const dir = tmp();
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ privacy: { neverLook: ["thunderbird", "x".repeat(300), 42, "remmina"] }, grants: { gedit: "act", firefox: "everything" }, voice: { consent: true, speakerRejection: "maybe" } }));
    const s = new SettingsStore(file);
    const r = s.load();
    expect(r.recoveredFrom).toBeTruthy();
    expect(s.get().privacy.neverLook).toEqual(["thunderbird", "remmina"]);
    expect(s.get().grants).toEqual({ gedit: "act" });
    expect(s.get().voice).toEqual({ consent: true, speakerRejection: true, muted: false });
  });

  it("a change made by hand while Ember runs is kept when Ember saves something else", () => {
    const dir = tmp();
    const file = path.join(dir, "settings.json");
    const s = new SettingsStore(file);
    s.load();
    s.update({ size: 70 });
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    onDisk.privacy.neverLook.push("thunderbird");
    fs.writeFileSync(file, JSON.stringify(onDisk));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    s.update({ size: 72 });
    expect(s.get().privacy.neverLook).toContain("thunderbird");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).privacy.neverLook).toContain("thunderbird");
  });

  it("a change that can't be saved isn't applied in memory either", () => {
    const dir = tmp();
    const file = path.join(dir, "sub", "settings.json");
    const s = new SettingsStore(file);
    s.load();
    s.update({ size: 70 });
    fs.chmodSync(path.dirname(file), 0o500);
    try {
      if (process.getuid?.() === 0) return; // root can write anyway
      expect(() => s.update({ size: 90 })).toThrow();
      expect(s.get().size).toBe(70);
    } finally {
      fs.chmodSync(path.dirname(file), 0o700);
    }
  });
});
