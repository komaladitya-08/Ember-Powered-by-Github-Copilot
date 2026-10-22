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
    // A folder that can't be written to. Windows ignores a folder's read-only flag, but won't replace a read-only file.
    const windows = process.platform === "win32";
    const locked = windows ? file : path.dirname(file);
    fs.chmodSync(locked, windows ? 0o444 : 0o500);
    try {
      if (process.getuid?.() === 0) return; // root can write anyway
      expect(() => s.update({ size: 90 })).toThrow();
      expect(s.get().size).toBe(70);
    } finally {
      fs.chmodSync(locked, windows ? 0o666 : 0o700);
    }
  });

  const touch = (f: string, ahead = 5000) => fs.utimesSync(f, new Date(), new Date(Date.now() + ahead));

  it("a hand edit that isn't valid JSON while Ember runs keeps the settings in use (and the user's file)", () => {
    const dir = tmp();
    const file = path.join(dir, "settings.json");
    const s = new SettingsStore(file);
    s.load();
    s.update({ consent: { version: 99, at: "now" }, onboarded: true, privacy: { neverLook: ["payroll"] }, wakeWord: false });
    const problems: (string | null)[] = [];
    s.onProblem(m => problems.push(m));
    // A quote missing: not JSON even read leniently.
    const broken = fs.readFileSync(file, "utf8").replace('"payroll"', '"payroll", "salary');
    fs.writeFileSync(file, broken);
    touch(file);
    expect(s.reloadIfChanged()).toBe(false);
    expect(s.get()).toMatchObject({ onboarded: true, wakeWord: false, privacy: { neverLook: ["payroll"] } });
    expect(fs.readFileSync(file, "utf8")).toBe(broken);
    expect(problems[0]).toMatch(/isn't valid JSON/);
    // Ember's next save keeps the user's version beside the file first.
    s.update({ size: 72 });
    expect(fs.readdirSync(dir).some(f => f.startsWith("settings.json.bad-") && fs.readFileSync(path.join(dir, f), "utf8") === broken)).toBe(true);
    expect(problems.at(-1)).toMatch(/saved its settings over it; your version is kept as settings\.json\.bad-/);
    // Fixed by hand: picked up, and the problem is cleared.
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), privacy: { neverLook: ["payroll", "salary"] } }));
    touch(file, 9000);
    expect(s.reloadIfChanged()).toBe(true);
    expect(s.get().privacy.neverLook).toEqual(["payroll", "salary"]);
    expect(problems.at(-1)).toBeNull();
  });

  it("a trailing comma or a comment in a hand edit is read anyway (and the file tidied)", () => {
    const dir = tmp();
    const file = path.join(dir, "settings.json");
    const s = new SettingsStore(file);
    s.load();
    s.update({ privacy: { neverLook: ["payroll"] } });
    const edited = fs.readFileSync(file, "utf8").replace('"payroll"', '"payroll", "salary", // added by hand\n');
    fs.writeFileSync(file, edited);
    touch(file);
    expect(s.reloadIfChanged()).toBe(true);
    expect(s.get().privacy.neverLook).toEqual(["payroll", "salary"]);
    expect(() => JSON.parse(fs.readFileSync(file, "utf8"))).not.toThrow();
  });

  it("at start-up, a file that can't be read at all still gives back its never-look list", () => {
    const dir = tmp();
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, '{ "consent": { "version": 2, "privacy": { "neverLook": ["payroll", "Thunderbird"] }, "size": 70 ');
    const s = new SettingsStore(file);
    const r = s.load();
    expect(r.recoveredFrom).toBeTruthy();
    expect(s.get().privacy.neverLook).toEqual(["payroll", "Thunderbird"]);
    expect(s.lastProblem).toMatch(/defaults/);
  });

  it("a deleted file is written again from the settings in use, not from defaults", () => {
    const dir = tmp();
    const file = path.join(dir, "settings.json");
    const s = new SettingsStore(file);
    s.load();
    s.update({ privacy: { neverLook: ["payroll"] }, wakeWord: false });
    fs.rmSync(file);
    expect(s.reloadIfChanged()).toBe(false);
    s.update({ size: 80 });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ size: 80, wakeWord: false, privacy: { neverLook: ["payroll"] } });
  });

  it("a slider's many changes apply at once and are saved together a moment later", async () => {
    const dir = tmp();
    const file = path.join(dir, "settings.json");
    const s = new SettingsStore(file);
    s.load();
    s.update({ size: 60 });
    for (let v = 62; v <= 90; v += 2) s.update({ size: v }, { soon: true });
    expect(s.get().size).toBe(90);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).size).toBe(60);
    await new Promise(r => setTimeout(r, 500));
    expect(JSON.parse(fs.readFileSync(file, "utf8")).size).toBe(90);
    s.update({ size: 70 }, { soon: true });
    s.flush();
    expect(JSON.parse(fs.readFileSync(file, "utf8")).size).toBe(70);
  });
});
