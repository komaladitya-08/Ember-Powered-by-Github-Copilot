/**
 * Ember's app-wide chrome (windows.ts): the application menu and DevTools in a packaged build (review #243, #176).
 * Windows and Linux had Electron's default menu: Ctrl+Q quit with no "still working" question, Ctrl+Shift+I opened
 * DevTools on the password card, Ctrl+R reloaded a card, Ctrl+W closed the ask box and Alt showed a menu bar.
 * main.ts can't be loaded in a unit test (it is Electron's entry point), so its call is read from its source; the
 * rest runs against fakes of Electron's Menu and app.
 */

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { MenuItemConstructorOptions } from "electron";
import type { OS } from "../../app/shared/shortcuts";

vi.mock("electron", () => ({ BrowserWindow: class {}, Menu: {}, app: {} }));

const { appMenuTemplate, lockDevTools, setUpAppChrome } = await import("../../app/main/windows");

/** main.ts without its comments, every run of white space made one space. */
const MAIN = fs.readFileSync(path.resolve("app/main/main.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1").replace(/\s+/g, " ");

/** Every item of a template, submenus included. */
const flat = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
  items.flatMap(i => [i, ...(Array.isArray(i.submenu) ? flat(i.submenu) : [])]);

/** A fake of the Electron objects setUpAppChrome touches, recording what it was told. */
function fakeElectron(o: { packaged?: boolean } = {}) {
  const calls: string[] = [];
  const handlers = new Map<string, (e: unknown, x: never) => void>();
  const built: MenuItemConstructorOptions[][] = [];
  const menus: (string | null)[] = [];
  const e = {
    Menu: {
      buildFromTemplate: (t: MenuItemConstructorOptions[]) => { built.push(t); return "built menu"; },
      setApplicationMenu: (m: string | null) => { menus.push(m); },
    },
    app: {
      isPackaged: o.packaged ?? false,
      on: (event: string, fn: (e: unknown, x: never) => void) => { calls.push(event); handlers.set(event, fn); },
    },
  };
  return { e, calls, handlers, built, menus };
}

const actions = () => ({ showSettings: vi.fn(), quit: vi.fn() });

describe("the application menu (review #243, #176)", () => {
  it("is none at all on Windows and Linux: no Quit that skips the question, no reload, DevTools, close or full screen", () => {
    expect(appMenuTemplate(false, actions())).toBeNull();
    for (const os of ["linux", "win32"] as OS[]) {
      const f = fakeElectron();
      setUpAppChrome({ os, appMenu: false, actions: actions() }, f.e as never);
      // null, not an empty menu: Electron's default menu goes, and with it the bar Alt showed.
      expect(f.menus).toEqual([null]);
      expect(f.built).toEqual([]);
    }
  });

  it("on macOS opens Settings with Command+, and quits through the quit question", () => {
    const a = actions();
    const t = appMenuTemplate(true, a);
    expect(t).not.toBeNull();
    const ember = t![0].submenu as MenuItemConstructorOptions[];
    expect(t![0].label).toBe("Ember");
    const settings = ember.find(i => i.label === "Settings…")!;
    expect(settings.accelerator).toBe("Command+,");
    const quit = ember.find(i => i.label === "Quit Ember")!;
    expect(quit.accelerator).toBe("Command+Q");
    expect(quit.role).toBeUndefined();
    (settings.click as () => void)();
    (quit.click as () => void)();
    expect(a.showSettings).toHaveBeenCalledTimes(1);
    expect(a.quit).toHaveBeenCalledTimes(1);
    // The Edit menu is what makes Command+C/V/X/A/Z work in the settings window's fields.
    expect(t!.slice(1)).toEqual([{ role: "editMenu" }, { role: "windowMenu" }]);
    const roles = flat(t!).map(i => i.role).filter(Boolean);
    for (const r of ["quit", "reload", "forceReload", "toggleDevTools", "togglefullscreen"]) expect(roles).not.toContain(r);
    const f = fakeElectron();
    setUpAppChrome({ os: "darwin", appMenu: true, actions: a }, f.e as never);
    expect(f.built).toHaveLength(1);
    expect(f.built[0][0].label).toBe("Ember");
    expect(f.menus).toEqual(["built menu"]);
  });

  it("is set by main.ts on every OS, before the first window, in place of the macOS-only menu", () => {
    expect(MAIN).toContain("setUpAppChrome({ os: platform.os, appMenu: sys.lifecycle.appMenu, actions: { showSettings: () => showHome(), quit: () => void quitEmber() } });");
    expect(MAIN).not.toContain("if (sys.lifecycle.appMenu)");
    const ready = MAIN.indexOf("const whenReady = () => {");
    const chrome = MAIN.indexOf("setUpAppChrome(", ready);
    expect(ready).toBeGreaterThan(0);
    expect(chrome).toBeGreaterThan(ready);
    expect(chrome).toBeLessThan(MAIN.indexOf("platform.openWindows(log)", ready));
    expect(chrome).toBeLessThan(MAIN.indexOf("askWindow.prepare()", ready));
  });
});

describe("DevTools in a packaged Ember (review #176)", () => {
  it("are closed on every page as soon as anything opens them", () => {
    const f = fakeElectron({ packaged: true });
    setUpAppChrome({ os: "linux", appMenu: false, actions: actions() }, f.e as never);
    expect(f.calls).toContain("web-contents-created");
    const opened: (() => void)[] = [];
    const contents = { on: (event: string, fn: () => void) => { if (event === "devtools-opened") opened.push(fn); }, closeDevTools: vi.fn() };
    f.handlers.get("web-contents-created")!({}, contents as never);
    expect(opened).toHaveLength(1);
    opened[0]();
    expect(contents.closeDevTools).toHaveBeenCalledTimes(1);
  });

  it("stay available in a development run", () => {
    const f = fakeElectron({ packaged: false });
    setUpAppChrome({ os: "win32", appMenu: false, actions: actions() }, f.e as never);
    expect(f.calls).not.toContain("web-contents-created");
    const contents = { on: vi.fn(), closeDevTools: vi.fn() };
    lockDevTools(contents);
    expect(contents.on).toHaveBeenCalledWith("devtools-opened", expect.any(Function));
  });
});
