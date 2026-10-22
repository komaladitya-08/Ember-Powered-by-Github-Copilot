/** SettingsStore's per-OS parts: the never-look default and retried renames (Windows antivirus and sync locks; design §4.18). */

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SETTINGS, SettingsStore } from "../../app/main/settings";
import { NEVER_LOOK_DEFAULTS } from "../../app/shared/never-look";
import { HOST_OS } from "../../app/main/platform/os";

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ember-settings-")), "settings.json");
const failing = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

/** Makes the next `times` renames fail with `code`, then lets them through. */
function refuseRenames(code: string, times: number) {
  const real = fs.renameSync;
  let left = times;
  return vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (left-- > 0) throw failing(code);
    return real(from, to);
  });
}

afterEach(() => { vi.restoreAllMocks(); });

describe("the never-look default", () => {
  it("is this OS's list from app/shared/never-look.ts (on Linux, today's six entries)", () => {
    expect(DEFAULT_SETTINGS.privacy.neverLook).toEqual([...NEVER_LOOK_DEFAULTS[HOST_OS]]);
    if (HOST_OS === "linux") expect(DEFAULT_SETTINGS.privacy.neverLook).toEqual(["keepassxc", "seahorse", "passwords and keys", "1password", "bitwarden", "polkit"]);
  });

  it("is a copy, so a change to one settings object never reaches the shared list", () => {
    DEFAULT_SETTINGS.privacy.neverLook.push("scratch");
    try {
      expect(NEVER_LOOK_DEFAULTS[HOST_OS]).not.toContain("scratch");
    } finally {
      DEFAULT_SETTINGS.privacy.neverLook.pop();
    }
  });
});

describe("saving settings while another program holds the file", () => {
  it("gives up at once by default (Linux and macOS: as before)", () => {
    const file = tmpFile();
    const store = new SettingsStore(file);
    store.load();
    const rename = refuseRenames("EPERM", 1);
    expect(() => store.update({ size: 70 })).toThrow(/EPERM/);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(store.get().size).toBe(DEFAULT_SETTINGS.size);
    expect(fs.readdirSync(path.dirname(file))).toEqual([]);
  });

  it("tries again 50 ms apart and saves once the lock is gone (Windows: renameRetries 5)", () => {
    const file = tmpFile();
    const store = new SettingsStore(file, null, { renameRetries: 5 });
    store.load();
    const rename = refuseRenames("EBUSY", 2);
    const t0 = Date.now();
    expect(store.update({ size: 70 }).size).toBe(70);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
    expect(rename).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).size).toBe(70);
  });

  it("stops after renameRetries more tries and leaves no temporary file behind", () => {
    const file = tmpFile();
    const store = new SettingsStore(file, null, { renameRetries: 2 });
    store.load();
    const rename = refuseRenames("EACCES", 10);
    expect(() => store.update({ size: 70 })).toThrow(/EACCES/);
    expect(rename).toHaveBeenCalledTimes(3);
    expect(fs.readdirSync(path.dirname(file))).toEqual([]);
  });

  it("never retries other failures (a missing folder is not a lock)", () => {
    const file = tmpFile();
    const store = new SettingsStore(file, null, { renameRetries: 5 });
    store.load();
    const rename = refuseRenames("ENOENT", 1);
    expect(() => store.update({ size: 70 })).toThrow(/ENOENT/);
    expect(rename).toHaveBeenCalledTimes(1);
  });
});
