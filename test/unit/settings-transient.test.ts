/**
 * settings.json that can't be read for a moment at start-up (an antivirus or sync client holding it, an NFS hiccup):
 * the read is tried again, and if it still fails Ember starts on defaults with a notice and never saves over the
 * user's file until it reads again; changes made meanwhile go on top of it then (review #83).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsStore } from "../../app/main/settings";
import { CONSENT_VERSION } from "../../app/shared/consent";

const good = {
  character: "wisp", size: 80, onboarded: true, consent: { version: CONSENT_VERSION, at: "2026-01-01T00:00:00.000Z" },
  privacy: { neverLook: ["Bank"] }, grants: { gedit: "act" },
};

function settingsFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-busy-"));
  const f = path.join(dir, "settings.json");
  fs.writeFileSync(f, JSON.stringify(good, null, 2));
  return f;
}

/** readFileSync of `file` fails with `code` for the next `times` reads (Infinity: until undo()). */
function failReads(file: string, code: string, times: number) {
  const real = fs.readFileSync;
  let left = times;
  const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) => {
    if (String(p) === file && left > 0) { left--; throw Object.assign(new Error(`${code}: resource busy or locked, open '${file}'`), { code }); }
    return (real as (p: fs.PathOrFileDescriptor, o?: unknown) => unknown)(p, o);
  }) as typeof fs.readFileSync);
  return { undo: () => spy.mockRestore() };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("settings.json that can't be read at start-up (review #83)", () => {
  it("a lock that lasts a moment is waited out: the user's settings load, with no notice", () => {
    const f = settingsFile();
    failReads(f, "EBUSY", 1);
    const store = new SettingsStore(f);
    const r = store.load();
    expect(r.settings).toMatchObject({ character: "wisp", size: 80, onboarded: true });
    expect(store.lastProblem).toBeNull();
  });

  it("a file that still can't be read starts Ember on defaults with a notice, and a change never saves over it", () => {
    const f = settingsFile();
    const before = fs.readFileSync(f, "utf8");
    const fail = failReads(f, "EIO", Infinity);
    const store = new SettingsStore(f);
    const r = store.load();
    expect(r.settings.character).toBe("cinder");
    expect(store.lastProblem).toMatch(/can't read .*settings\.json.*default settings/);
    store.update({ size: 70 });
    expect(store.get().size).toBe(70);
    store.flush();
    fail.undo();
    expect(fs.readFileSync(f, "utf8")).toBe(before);
    expect(fs.readdirSync(path.dirname(f))).toEqual(["settings.json"]);
  });

  it("once the file reads again, it is used, the changes made meanwhile go on top and are saved, and the notice goes", () => {
    const f = settingsFile();
    const fail = failReads(f, "EACCES", Infinity);
    const store = new SettingsStore(f);
    store.load();
    store.update({ size: 70 });
    // The watcher looks again (the file's time hasn't changed: it was never edited).
    expect(store.reloadIfChanged()).toBe(false);
    fail.undo();
    expect(store.reloadIfChanged()).toBe(true);
    expect(store.get()).toMatchObject({ character: "wisp", size: 70, onboarded: true, grants: { gedit: "act" } });
    expect(store.lastProblem).toBeNull();
    expect(JSON.parse(fs.readFileSync(f, "utf8"))).toMatchObject({ character: "wisp", size: 70, onboarded: true });
  });

  it("a change made when the file reads again goes on top of the user's settings, not the defaults", () => {
    const f = settingsFile();
    const fail = failReads(f, "EPERM", Infinity);
    const store = new SettingsStore(f);
    store.load();
    fail.undo();
    store.update({ speak: false });
    expect(store.get()).toMatchObject({ character: "wisp", size: 80, speak: false });
    expect(JSON.parse(fs.readFileSync(f, "utf8"))).toMatchObject({ character: "wisp", size: 80, speak: false });
    expect(store.lastProblem).toBeNull();
  });

  it("changes held meanwhile are kept when the next change, not the watcher, finds the file readable", () => {
    const f = settingsFile();
    const fail = failReads(f, "EIO", Infinity);
    const store = new SettingsStore(f);
    store.load();
    store.update({ size: 70 });
    fail.undo();
    store.update({ speak: false });
    expect(store.get()).toMatchObject({ character: "wisp", size: 70, speak: false });
    expect(JSON.parse(fs.readFileSync(f, "utf8"))).toMatchObject({ character: "wisp", size: 70, speak: false, grants: { gedit: "act" } });
  });

  it("the same through the size slider: a change held meanwhile is saved with the slider's", () => {
    const f = settingsFile();
    const fail = failReads(f, "EIO", Infinity);
    const store = new SettingsStore(f);
    store.load();
    store.update({ reduceMotion: true });
    fail.undo();
    store.update({ size: 75 }, { soon: true });
    store.flush();
    expect(store.get()).toMatchObject({ character: "wisp", size: 75, reduceMotion: true });
    expect(JSON.parse(fs.readFileSync(f, "utf8"))).toMatchObject({ character: "wisp", size: 75, reduceMotion: true });
  });

  it("a missing file is still a first run: defaults, no notice, and the first change is saved", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-busy-"));
    const f = path.join(dir, "settings.json");
    const store = new SettingsStore(f);
    store.load();
    expect(store.lastProblem).toBeNull();
    store.update({ size: 70 });
    expect(JSON.parse(fs.readFileSync(f, "utf8")).size).toBe(70);
  });
});

describe("the notice while settings.json stays unreadable (review #83)", () => {
  it("keeps saying that nothing is saved over the file, through later changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-busy-"));
    const f = path.join(dir, "settings.json");
    fs.writeFileSync(f, "{}");
    failReads(f, "EIO", Infinity);
    const store = new SettingsStore(f);
    store.load();
    store.update({ size: 70 });
    expect(store.lastProblem).toMatch(/won't save over the file until it can read it again/);
  });
});

describe("the notice when the unreadable settings.json is gone (review #83)", () => {
  for (const watcherFirst of [true, false]) {
    it(`goes once Ember can save a new file${watcherFirst ? " (the watcher saw it go)" : ""}`, () => {
      const f = settingsFile();
      const fail = failReads(f, "EACCES", Infinity);
      const store = new SettingsStore(f);
      store.load();
      fail.undo();
      fs.rmSync(f);
      if (watcherFirst) store.reloadIfChanged();
      store.update({ size: 70 });
      expect(JSON.parse(fs.readFileSync(f, "utf8")).size).toBe(70);
      expect(store.lastProblem).toBeNull();
    });
  }
});

describe("a file that reads again with a slip in it (reviews #83 and #92)", () => {
  it("is waited on and repaired with the user's settings, never replaced with defaults plus the changes", () => {
    const f = settingsFile();
    let now = 0;
    const fail = failReads(f, "EIO", Infinity);
    const store = new SettingsStore(f, null, { clock: () => now });
    store.load();
    store.update({ size: 70 });
    // The file reads again, with a trailing comma the user left in it.
    fail.undo();
    fs.writeFileSync(f, JSON.stringify(good, null, 2).replace(/\n}$/, ",\n}"));
    expect(store.reloadIfChanged()).toBe(false);
    expect(JSON.parse(fs.readFileSync(f, "utf8").replace(/,\n}$/, "\n}"))).toMatchObject({ character: "wisp", size: 80 });
    now += 2000;
    expect(store.reloadIfChanged()).toBe(true);
    expect(store.get()).toMatchObject({ character: "wisp", size: 70, onboarded: true });
    expect(JSON.parse(fs.readFileSync(f, "utf8"))).toMatchObject({ character: "wisp", size: 70, onboarded: true, grants: { gedit: "act" } });
  });

  it("a change made while it is waited on keeps the changes held while it couldn't be read", () => {
    const f = settingsFile();
    const fail = failReads(f, "EIO", Infinity);
    const store = new SettingsStore(f, null, { clock: () => 0 });
    store.load();
    store.update({ size: 70 });
    fail.undo();
    fs.writeFileSync(f, JSON.stringify(good, null, 2).replace(/\n}$/, ",\n}"));
    expect(store.reloadIfChanged()).toBe(false);
    store.update({ speak: false });
    expect(store.get()).toMatchObject({ character: "wisp", size: 70, speak: false });
    expect(JSON.parse(fs.readFileSync(f, "utf8"))).toMatchObject({ character: "wisp", size: 70, speak: false, grants: { gedit: "act" } });
  });
});
