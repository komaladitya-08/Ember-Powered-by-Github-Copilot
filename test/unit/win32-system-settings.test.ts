/**
 * Windows' tier-0 settings (win32/system/settings.ts): only dark mode for apps is offered; it parses the on/off
 * grammar, writes AppsUseLightTheme (0 = dark) only when it changes, tells running apps through the asynchronous
 * broadcast without waiting for it, and reports the registry's read-back. A missing value, an unreadable or unwritable
 * one, and a missing registry API are plain errors.
 */

import { describe, expect, it } from "vitest";
import { APPS_USE_LIGHT_THEME, BROADCAST_TIMEOUT_MS, PERSONALIZE, win32Settings } from "../../app/main/platform/win32/system/settings";
import { FakeRegistry, fakeApi, HKCU } from "./win32-system-fakes";

const theme = (light: number) => new FakeRegistry().dword(HKCU, PERSONALIZE, APPS_USE_LIGHT_THEME, light);

describe("Windows settings", () => {
  it("offers only dark mode for apps", () => {
    expect(win32Settings({ api: () => null }).available).toEqual({ dark_style: "Dark mode for apps" });
  });

  it("turns dark mode on and off, broadcasting ImmersiveColorSet, and reads the value back", async () => {
    const api = fakeApi(theme(1));
    const settings = win32Settings({ api: () => api });
    expect(await settings.change("dark_style", "on")).toEqual({ before: "false", after: "true" });
    expect(api.registry.get(HKCU, PERSONALIZE, APPS_USE_LIGHT_THEME)?.data.readUInt32LE(0)).toBe(0);
    expect(await settings.change("dark_style", "false")).toEqual({ before: "true", after: "false" });
    expect(api.registry.get(HKCU, PERSONALIZE, APPS_USE_LIGHT_THEME)?.data.readUInt32LE(0)).toBe(1);
    expect(api.broadcasts).toEqual(["ImmersiveColorSet", "ImmersiveColorSet"]);
  });

  it("neither writes nor broadcasts when the setting is already as asked", async () => {
    const api = fakeApi(theme(0));
    expect(await win32Settings({ api: () => api }).change("dark_style", "yes")).toEqual({ before: "true", after: "true" });
    expect(api.registry.writes).toEqual([]);
    expect(api.broadcasts).toEqual([]);
  });

  it("doesn't wait for the broadcast, and logs one that didn't finish or start", async () => {
    const pending: ((ok: boolean) => void)[] = [];
    const logged: string[] = [];
    const api = fakeApi(theme(1), { broadcastSettingChange: (area, ms, done) => { expect([area, ms]).toEqual(["ImmersiveColorSet", BROADCAST_TIMEOUT_MS]); pending.push(done!); return true; } });
    const log = { debug: (msg: string) => logged.push(msg) } as never;
    const settings = win32Settings({ api: () => api, log: () => log });
    expect(await settings.change("dark_style", "1")).toEqual({ before: "false", after: "true" });
    expect(pending).toHaveLength(1); // the change answered while the broadcast was still out
    pending[0](false);
    expect(logged).toEqual(["settings.broadcast_incomplete"]);
    const silent = fakeApi(theme(1), { broadcastSettingChange: () => false });
    await win32Settings({ api: () => silent, log: () => log }).change("dark_style", "on");
    expect(logged).toEqual(["settings.broadcast_incomplete", "settings.broadcast_not_sent"]);
  });

  it("says plainly when dark mode isn't there, can't be read or written, or the registry is out of reach", async () => {
    await expect(win32Settings({ api: () => fakeApi() }).change("dark_style", "on")).rejects.toThrow("Dark mode for apps is not available on this computer");
    await expect(win32Settings({ api: () => fakeApi(new FakeRegistry().deny(HKCU, PERSONALIZE)) }).change("dark_style", "on")).rejects.toThrow("Ember couldn't read Windows' dark mode setting");
    const readonly = fakeApi(theme(1));
    readonly.registry.writeStatus = 5;
    await expect(win32Settings({ api: () => readonly }).change("dark_style", "on")).rejects.toThrow("Ember couldn't change Windows' dark mode setting");
    expect(readonly.broadcasts).toEqual([]);
    await expect(win32Settings({ api: () => null }).change("dark_style", "on")).rejects.toThrow("Ember can't reach Windows' settings on this computer");
  });

  it("refuses a setting Windows doesn't offer", async () => {
    await expect(win32Settings({ api: () => fakeApi(theme(1)) }).change("night_light", "on")).rejects.toThrow(/isn't something Ember can change on Windows/);
  });
});
