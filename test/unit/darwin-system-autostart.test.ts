/**
 * The macOS login item (design §9.5, finding M21) over a fake app: the OS is touched only when it is out of step
 * (every register shows a notification), "requires-approval" counts as on, a register that reads back "not-found"
 * isn't repeated in the session, a login start is told by wasOpenedAtLogin as well as --autostart, and the note says
 * what the user can do (approve in Login Items, or move Ember to Applications).
 */

import { describe, expect, it, vi } from "vitest";
import { MOVE_FIRST, NEEDS_APPROVAL, darwinAutostart, loginItemOn } from "../../app/main/platform/darwin/system/autostart";
import type { LoginItemSettingsLike } from "../../app/main/platform/types";

function fakeApp(start: LoginItemSettingsLike, after?: (on: boolean) => LoginItemSettingsLike, inApplications: boolean | undefined = true) {
  let s = start;
  return {
    getLoginItemSettings: vi.fn(() => s),
    setLoginItemSettings: vi.fn((o: { openAtLogin: boolean }) => { s = after ? after(o.openAtLogin) : { ...s, openAtLogin: o.openAtLogin, status: o.openAtLogin ? "enabled" : "not-registered" }; }),
    isInApplicationsFolder: vi.fn(() => inApplications as boolean),
    set: (n: LoginItemSettingsLike) => { s = n; },
  };
}

describe("loginItemOn", () => {
  it("reads the SMAppService status, and openAtLogin only where there is none", () => {
    expect(loginItemOn({ openAtLogin: false, status: "enabled" })).toBe(true);
    expect(loginItemOn({ openAtLogin: false, status: "requires-approval" })).toBe(true);
    expect(loginItemOn({ openAtLogin: true, status: "not-registered" })).toBe(false);
    expect(loginItemOn({ openAtLogin: true, status: "not-found" })).toBe(false);
    expect(loginItemOn({ openAtLogin: true })).toBe(true);
  });
});

describe("darwinAutostart", () => {
  it("registers when turned on and unregisters when turned off, with no arguments", () => {
    const app = fakeApp({ openAtLogin: false, status: "not-registered" });
    const a = darwinAutostart(app);
    expect(a.sync(true)).toBe(true);
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: true });
    expect(a.sync(false)).toBe(true);
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: false });
  });

  it("never touches the login item when it is already in step (each register shows a notification)", () => {
    const app = fakeApp({ openAtLogin: false, status: "enabled" });
    const a = darwinAutostart(app);
    expect(a.sync(true)).toBe(false);
    app.set({ openAtLogin: false, status: "requires-approval" });
    expect(a.sync(true)).toBe(false);
    app.set({ openAtLogin: false, status: "not-registered" });
    expect(a.sync(false)).toBe(false);
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it("registers a not-found copy once a session, then asks the user to move Ember", () => {
    const app = fakeApp({ openAtLogin: false, status: "not-found" }, () => ({ openAtLogin: false, status: "not-found" }));
    const a = darwinAutostart(app);
    expect(a.note()).toBeNull();
    expect(a.sync(true)).toBe(true);
    expect(a.sync(true)).toBe(false);
    expect(a.sync(true)).toBe(false);
    expect(app.setLoginItemSettings).toHaveBeenCalledTimes(1);
    expect(a.note()).toBe(MOVE_FIRST);
    // Turning it off still works (nothing is registered, so nothing to do).
    expect(a.sync(false)).toBe(false);
  });

  it("tells a login start by --autostart or by wasOpenedAtLogin", () => {
    const app = fakeApp({ openAtLogin: true, status: "enabled", wasOpenedAtLogin: false });
    const a = darwinAutostart(app);
    expect(a.launchedAtLogin(["/Applications/Ember.app/Contents/MacOS/Ember"])).toBe(false);
    expect(a.launchedAtLogin(["Ember", "--autostart"])).toBe(true);
    app.set({ openAtLogin: true, status: "enabled", wasOpenedAtLogin: true });
    expect(a.launchedAtLogin(["Ember"])).toBe(true);
  });

  it("answers false, not an exception, when the login item can't be read", () => {
    const a = darwinAutostart({ getLoginItemSettings: () => { throw new Error("no"); }, setLoginItemSettings: vi.fn(), isInApplicationsFolder: () => true });
    expect(a.launchedAtLogin(["Ember"])).toBe(false);
    expect(a.note()).toBeNull();
  });

  it("notes a login item waiting for approval, and one that can't stick where Ember is", () => {
    expect(darwinAutostart(fakeApp({ openAtLogin: false, status: "requires-approval" })).note()).toBe(NEEDS_APPROVAL);
    expect(NEEDS_APPROVAL).toBe("Allow Ember in System Settings › General › Login Items to start it when you log in.");
    expect(darwinAutostart(fakeApp({ openAtLogin: true, status: "enabled" }, undefined, false)).note()).toBe(MOVE_FIRST);
    // Off: nothing to move Ember for (the location setup check says it anyway).
    expect(darwinAutostart(fakeApp({ openAtLogin: false, status: "not-registered" }, undefined, false)).note()).toBeNull();
    expect(darwinAutostart(fakeApp({ openAtLogin: true, status: "enabled" })).note()).toBeNull();
  });
});
