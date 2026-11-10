/**
 * A settings file that stays unreadable after start-up must fail an update closed (audit: consent without persistence).
 * The store used to apply such a change in memory only, so a consent could be in force with nothing on disk; now the
 * update throws, memory and listeners are untouched and the user's file is never rewritten.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { plainSaveError, SettingsStore } from "../../app/main/settings";
import { CONSENT_VERSION } from "../../app/shared/consent";
import { saveFailedText } from "../../app/renderer/home/copy";

const good = {
  character: "wisp", size: 80, onboarded: true, consent: { version: CONSENT_VERSION, at: "2026-01-01T00:00:00.000Z" },
  privacy: { neverLook: ["Bank"] },
};
// A real unreadable file needs POSIX permissions and a non-root user.
const canChmod = process.platform !== "win32" && process.getuid?.() !== 0;

function unreadableFile(): { f: string; bytes: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-unread-"));
  const f = path.join(dir, "settings.json");
  const bytes = JSON.stringify(good, null, 2);
  fs.writeFileSync(f, bytes);
  fs.chmodSync(f, 0o000);
  return { f, bytes };
}

describe.skipIf(!canChmod)("update while settings.json is unreadable", () => {
  it("rejects with a plain sentence, keeps nothing in memory, tells nobody, and leaves the file as it was", () => {
    const { f, bytes } = unreadableFile();
    const modeBefore = fs.statSync(f).mode;
    const store = new SettingsStore(f);
    store.load();
    const told: unknown[] = [];
    store.onChange(s => told.push(s));
    const consent = { voice: { ...store.get().voice, consent: true } };
    let thrown: unknown;
    try { store.update(consent); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(Error);
    expect(saveFailedText(plainSaveError(thrown))).toMatch(/^Ember couldn't save /);
    expect(store.get().voice.consent).toBe(false);
    expect(store.own().voice.consent).toBe(false);
    expect(told).toEqual([]);
    // The slider's deferred path is refused too.
    expect(() => store.update({ size: 70 }, { soon: true })).toThrow();
    expect(store.get().size).not.toBe(70);
    store.flush();
    expect(fs.statSync(f).mode).toBe(modeBefore);
    expect(fs.readdirSync(path.dirname(f))).toEqual(["settings.json"]);
    fs.chmodSync(f, 0o600);
    expect(fs.readFileSync(f, "utf8")).toBe(bytes);
  });

  it("once the file is readable, the next update merges with what is on disk and writes", () => {
    const { f } = unreadableFile();
    const store = new SettingsStore(f);
    store.load();
    expect(() => store.update({ speak: false })).toThrow();
    fs.chmodSync(f, 0o600);
    store.update({ speak: false });
    expect(store.get()).toMatchObject({ character: "wisp", size: 80, speak: false, onboarded: true });
    const disk = JSON.parse(fs.readFileSync(f, "utf8"));
    expect(disk).toMatchObject({ character: "wisp", size: 80, speak: false, privacy: { neverLook: ["Bank"] } });
    expect(store.lastProblem).toBeNull();
  });

  it("the consent journey: every write is refused, so memory and disk agree on no consent", () => {
    const { f } = unreadableFile();
    const store = new SettingsStore(f);
    store.load();
    const handler = (patch: Parameters<SettingsStore["update"]>[0]) => { try { return store.update(patch); } catch (e) { throw plainSaveError(e); } };
    expect(() => handler({ onboarded: true })).toThrow();
    expect(() => handler({ wakeWord: true, voice: { ...store.get().voice, consent: true } })).toThrow(/^Ember couldn't save/);
    expect(store.get().voice.consent).toBe(false);
    fs.chmodSync(f, 0o600);
    expect(JSON.parse(fs.readFileSync(f, "utf8")).voice?.consent ?? false).toBe(false);
  });
});

// The same safety on every OS (Windows and root ignore chmod): the read of settings.json fails by injection.
describe("update while settings.json can't be read (injected EACCES, any OS)", () => {
  it("rejects with a plain sentence, keeps nothing in memory, tells nobody, and never rewrites the file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-unread-inj-"));
    const f = path.join(dir, "settings.json");
    const bytes = JSON.stringify(good, null, 2);
    fs.writeFileSync(f, bytes);
    const real = fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((p: unknown, ...a: unknown[]) => {
      if (String(p) === f) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return (real as (...x: unknown[]) => unknown)(p, ...a);
    }) as typeof fs.readFileSync);
    try {
      const store = new SettingsStore(f);
      store.load();
      const told: unknown[] = [];
      store.onChange(s => told.push(s));
      let thrown: unknown;
      try { store.update({ voice: { ...store.get().voice, consent: true } }); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(Error);
      expect(saveFailedText(plainSaveError(thrown))).toMatch(/^Ember couldn't save /);
      expect(store.get().voice.consent).toBe(false);
      expect(told).toEqual([]);
      expect(() => store.update({ size: 70 }, { soon: true })).toThrow();
      store.flush();
    } finally { spy.mockRestore(); }
    expect(fs.readFileSync(f, "utf8")).toBe(bytes);
    expect(fs.readdirSync(dir)).toEqual(["settings.json"]);
  });
});
