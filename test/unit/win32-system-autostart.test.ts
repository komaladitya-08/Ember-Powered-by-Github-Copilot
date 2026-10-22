/**
 * Start at login on Windows (win32/system/autostart.ts) against a fake of Electron's login-item settings that keeps
 * the Run value as Electron does: named after the AppUserModelId, matched by path and args. Ember never passes a
 * name, reads and writes with the same path and args, touches the OS only when out of step (both halves: on, then
 * off again), quotes a development app path with a space, and notes an entry turned off in Task Manager.
 */

import { describe, expect, it } from "vitest";
import type { AppLike, LoginItemSettingsLike } from "../../app/main/platform/types";
import { loginItem, quoteArg, TURNED_OFF_NOTE, win32Autostart } from "../../app/main/platform/win32/system/autostart";
import { AUMID } from "../../app/main/platform/win32/system/lifecycle";

/** Electron's Windows behaviour: one Run value named after the AUMID; openAtLogin when its command matches path + args. */
function fakeApp(o: { taskManagerOff?: boolean; willLaunch?: boolean } = {}) {
  let run: { path: string; args: string[] } | null = null;
  const sets: Parameters<AppLike["setLoginItemSettings"]>[0][] = [];
  const reads: (Parameters<AppLike["getLoginItemSettings"]>[0])[] = [];
  const app: Pick<AppLike, "getLoginItemSettings" | "setLoginItemSettings"> = {
    getLoginItemSettings(q) {
      reads.push(q);
      const on = !!run && run.path === q?.path && JSON.stringify(run.args) === JSON.stringify(q?.args ?? []);
      const s: LoginItemSettingsLike = { openAtLogin: on, executableWillLaunchAtLogin: on && (o.willLaunch ?? true) };
      if (run) s.launchItems = [{ name: AUMID, path: run.path, args: run.args, enabled: !o.taskManagerOff }];
      return s;
    },
    setLoginItemSettings(s) {
      sets.push(s);
      run = s.openAtLogin ? { path: s.path ?? "", args: s.args ?? [] } : null;
    },
  };
  return { app, sets, reads, run: () => run };
}

describe("loginItem", () => {
  it("registers Ember's own program with --autostart, plus the quoted app folder in development", () => {
    expect(loginItem({ packaged: true, execPath: "C:\\Program Files\\Ember\\Ember.exe", appPath: "C:\\x" })).toEqual({ path: "C:\\Program Files\\Ember\\Ember.exe", args: ["--autostart"] });
    expect(loginItem({ packaged: false, execPath: "C:\\dev\\electron.exe", appPath: "C:\\My Projects\\ember" })).toEqual({ path: "C:\\dev\\electron.exe", args: ["\"C:\\My Projects\\ember\"", "--autostart"] });
    expect(quoteArg("C:\\ember")).toBe("C:\\ember");
  });
});

describe("Windows autostart", () => {
  const opts = { packaged: true, execPath: "C:\\Ember\\Ember.exe", appPath: "C:\\Ember\\resources\\app.asar" };

  it("turns on once and off once, never passing a name, reading with the same path and args", () => {
    const f = fakeApp();
    const a = win32Autostart({ app: f.app, ...opts });
    expect(a.sync(true)).toBe(true);
    expect(f.run()).toEqual({ path: "C:\\Ember\\Ember.exe", args: ["--autostart"] });
    expect(a.sync(true)).toBe(false); // in step: the OS isn't touched again
    expect(a.sync(false)).toBe(true);
    expect(f.run()).toBeNull();
    expect(a.sync(false)).toBe(false);
    expect(f.sets).toEqual([
      { openAtLogin: true, path: "C:\\Ember\\Ember.exe", args: ["--autostart"] },
      { openAtLogin: false, path: "C:\\Ember\\Ember.exe", args: ["--autostart"] },
    ]);
    expect(f.sets.every(s => !("name" in s))).toBe(true);
    expect(f.reads.every(q => q?.path === "C:\\Ember\\Ember.exe" && JSON.stringify(q?.args) === "[\"--autostart\"]")).toBe(true);
  });

  it("knows it was started at login from --autostart", () => {
    const a = win32Autostart({ app: fakeApp().app, ...opts });
    expect(a.launchedAtLogin(["Ember.exe", "--autostart"])).toBe(true);
    expect(a.launchedAtLogin(["Ember.exe"])).toBe(false);
  });

  it("notes an entry turned off in Task Manager's Startup apps, and only while it is on", () => {
    const off = fakeApp({ taskManagerOff: true });
    const a = win32Autostart({ app: off.app, ...opts });
    expect(a.note()).toBeNull();
    a.sync(true);
    expect(a.note()).toBe(TURNED_OFF_NOTE);
    const wont = fakeApp({ willLaunch: false });
    const b = win32Autostart({ app: wont.app, ...opts });
    b.sync(true);
    expect(b.note()).toBe(TURNED_OFF_NOTE);
    const fine = fakeApp();
    const c = win32Autostart({ app: fine.app, ...opts });
    c.sync(true);
    expect(c.note()).toBeNull();
  });

  it("gives no note when Electron can't say", () => {
    const a = win32Autostart({ app: { getLoginItemSettings: () => { throw new Error("no"); }, setLoginItemSettings: () => undefined }, ...opts });
    expect(a.note()).toBeNull();
  });
});
