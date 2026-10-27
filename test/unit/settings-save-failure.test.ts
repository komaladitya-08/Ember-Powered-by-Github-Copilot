/**
 * A settings change that can't be saved (a full disk, an unwritable folder, a locked file) is said plainly, never
 * swallowed (review #84): the store's notice tells every open window why, the settings window's request fails with
 * that one plain sentence (plainSaveError; the raw error is its cause), a change saved later (the size slider) says it
 * will be tried again, and the notice goes once a save works. The window's own words for it come from copy.ts.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore, plainSaveError, saveFailure } from "../../app/main/settings";
import { saveFailedText } from "../../app/renderer/home/copy";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-save-"));
  const file = path.join(dir, "settings.json");
  const store = new SettingsStore(file);
  store.load();
  store.update({ size: 70 });
  const notices: (string | null)[] = [];
  store.onProblem(m => notices.push(m));
  // A folder where the new file is written first: every save fails until it goes.
  const tmp = `${file}.tmp-${process.pid}`;
  return { file, store, notices, block: () => fs.mkdirSync(tmp), unblock: () => fs.rmdirSync(tmp) };
}

describe("a settings change that can't be saved (review #84)", () => {
  it("throws one plain sentence, tells every window, and keeps the settings as they were", () => {
    const { file, store, notices, block } = setup();
    block();
    let raw: unknown;
    try { store.update({ startAtLogin: true }); } catch (err) { raw = err; }
    // Thrown on as it came (callers in main log it), and worded for the settings window.
    expect((raw as NodeJS.ErrnoException).code).toBeTypeOf("string");
    const told = plainSaveError(raw) as Error & { cause?: unknown };
    expect(told.message).toMatch(/^Ember couldn't save your settings: .*\. Your change wasn't kept\.$/);
    expect(told.cause).toBe(raw);
    expect(notices.at(-1)).toBe(told.message);
    expect(store.lastProblem).toBe(told.message);
    expect(store.get().startAtLogin).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).startAtLogin).toBe(false);
  });

  it("the notice goes once a save works again", () => {
    const { store, notices, block, unblock } = setup();
    block();
    expect(() => store.update({ startAtLogin: true })).toThrow();
    unblock();
    store.update({ startAtLogin: true });
    expect(notices.at(-1)).toBeNull();
    expect(store.lastProblem).toBeNull();
  });

  it("a change saved a moment later (the size slider) is kept in use and said to be tried again", () => {
    const { store, block } = setup();
    block();
    store.update({ size: 90 }, { soon: true });
    expect(() => store.flush()).toThrow();
    expect(store.get().size).toBe(90);
    expect(store.lastProblem).toMatch(/^Ember couldn't save your settings: .*\. It will try again with your next change\.$/);
  });

  it("leaves an error that isn't a failed save as it is", () => {
    const e = new Error("onboarding can't finish before the user gives consent");
    expect(plainSaveError(e)).toBe(e);
  });

  it("names the usual causes plainly", () => {
    const e = (code: string) => Object.assign(new Error(code), { code });
    expect(saveFailure(e("ENOSPC"))).toBe("Ember couldn't save your settings: the disk is full. Your change wasn't kept.");
    expect(saveFailure(e("EDQUOT"))).toMatch(/the disk is full/);
    expect(saveFailure(e("EROFS"))).toMatch(/its folder is on a disk that can only be read/);
    expect(saveFailure(e("EACCES"))).toMatch(/it isn't allowed to write to its folder/);
    expect(saveFailure(e("EPERM"))).toMatch(/it isn't allowed to write to its folder/);
    expect(saveFailure(e("EBUSY"))).toMatch(/another program is holding settings\.json/);
    expect(saveFailure(e("EIO"), true)).toBe("Ember couldn't save your settings: the file couldn't be written. It will try again with your next change.");
  });
});

describe("the settings window's words for a change that wasn't saved (review #84)", () => {
  it("shows main's own sentence without Electron's prefix", () => {
    const said = "Ember couldn't save your settings: the disk is full. Your change wasn't kept.";
    expect(saveFailedText(new Error(`Error invoking remote method 'ember:update-settings': Error: ${said}`))).toBe(said);
  });

  it("never shows a raw error", () => {
    expect(saveFailedText(new Error("Error invoking remote method 'ember:update-settings': Error: EISDIR: illegal operation on a directory, rename"))).toBe("Ember couldn't save that change.");
    expect(saveFailedText("nope")).toBe("Ember couldn't save that change.");
  });
});
