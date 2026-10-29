/**
 * Ember's app-wide chrome (windows.ts): the application menu, the About panel, the native theme, the window icon on
 * Linux and DevTools in a packaged build (review #243, #176, #232, #245, #247), and the quit question's words (review
 * #226). Windows and Linux had
 * Electron's default menu: Ctrl+Q quit with no "still working" question, Ctrl+Shift+I opened DevTools on the password
 * card, Ctrl+R reloaded a card, Ctrl+W closed the ask box and Alt showed a menu bar.
 * main.ts can't be loaded in a unit test (it is Electron's entry point), so its call is read from its source; the
 * rest runs against fakes of Electron's Menu, nativeTheme and app.
 */

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { MenuItemConstructorOptions } from "electron";
import type { OS } from "../../app/shared/shortcuts";

/** The window factories' BrowserWindows: each one's options and the handlers put on its page. */
const electron = vi.hoisted(() => ({
  made: [] as { options: Record<string, unknown>; page: { handlers: Map<string, (...args: never[]) => void>; level: number } }[],
}));
vi.mock("electron", () => ({
  BrowserWindow: class {
    webContents = {
      handlers: new Map<string, (...args: never[]) => void>(),
      level: 0,
      on(event: string, fn: (...args: never[]) => void) { this.handlers.set(event, fn); return this; },
      getZoomLevel() { return this.level; },
      setZoomLevel(level: number) { this.level = level; },
    };
    constructor(options: Record<string, unknown>) { electron.made.push({ options, page: this.webContents }); }
    once() { /* shown by main */ }
    loadFile() { return Promise.resolve(); }
    setContentProtection() { /* not what these tests look at */ }
    setAlwaysOnTop() { /* not what these tests look at */ }
    /** The window's own events (closed, close, session-end), which the command and prompt windows listen to. */
    on() { /* not what these tests look at */ }
  },
  // The command window lets a quit through its close guard (app's before-quit).
  Menu: {}, nativeTheme: {}, app: { on() { /* not what these tests look at */ }, removeListener() { /* nor this */ } },
}));

const { WINDOW_ICON, ZOOM, aboutPanel, appMenuTemplate, createCommandWindow, createHomeWindow, createPromptWindow, lockDevTools, quitQuestion, setUpAppChrome, windowIconFor, zoomLevelFor } = await import("../../app/main/windows");

/** main.ts without its comments, every run of white space made one space. */
const MAIN = fs.readFileSync(path.resolve("app/main/main.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1").replace(/\s+/g, " ");

/** Every item of a template, submenus included. */
const flat = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
  items.flatMap(i => [i, ...(Array.isArray(i.submenu) ? flat(i.submenu) : [])]);

/** A fake of the Electron objects setUpAppChrome touches, recording what it was told. */
function fakeElectron(o: { packaged?: boolean; iconThere?: boolean } = {}) {
  const calls: string[] = [];
  const handlers = new Map<string, (e: unknown, x: never) => void>();
  const built: MenuItemConstructorOptions[][] = [];
  const menus: (string | null)[] = [];
  const about: unknown[] = [];
  const e = {
    Menu: {
      buildFromTemplate: (t: MenuItemConstructorOptions[]) => { built.push(t); return "built menu"; },
      setApplicationMenu: (m: string | null) => { menus.push(m); },
    },
    nativeTheme: { themeSource: "system" as "system" | "light" | "dark" },
    app: {
      isPackaged: o.packaged ?? false,
      getVersion: () => "0.1.0",
      setAboutPanelOptions: (p: unknown) => { about.push(p); },
      on: (event: string, fn: (e: unknown, x: never) => void) => { calls.push(event); handlers.set(event, fn); },
    },
    exists: (file: string) => (o.iconThere ?? true) && file === WINDOW_ICON,
  };
  return { e, calls, handlers, built, menus, about };
}

const actions = () => ({ showSettings: vi.fn(), quit: vi.fn() });

describe("the application menu (review #243, #176, #232)", () => {
  it("is none at all on Windows and Linux: no Quit that skips the question, no reload, DevTools, close or full screen", () => {
    expect(appMenuTemplate(false, actions())).toBeNull();
    for (const os of ["linux", "win32"] as OS[]) {
      const f = fakeElectron();
      setUpAppChrome({ os, appMenu: false, actions: actions() }, f.e as never);
      // null, not an empty menu: Electron's default menu goes, and with it the bar Alt showed.
      expect(f.menus).toEqual([null]);
      expect(f.built).toEqual([]);
      expect(f.about).toEqual([]);
    }
  });

  it("on macOS starts with About Ember, opens Settings with Command+, and quits through the quit question", () => {
    const a = actions();
    const t = appMenuTemplate(true, a);
    expect(t).not.toBeNull();
    const ember = t![0].submenu as MenuItemConstructorOptions[];
    expect(t![0].label).toBe("Ember");
    expect(ember[0]).toEqual({ role: "about", label: "About Ember" });
    // app.name is "ember" (the data folder's name): a role's own label would say "Hide ember".
    expect(ember.filter(i => i.role === "hide")).toEqual([{ role: "hide", label: "Hide Ember" }]);
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

  it("is set on macOS with an About panel that names Ember, its version once and its licence", () => {
    const f = fakeElectron();
    setUpAppChrome({ os: "darwin", appMenu: true, actions: actions() }, f.e as never);
    expect(f.about).toEqual([aboutPanel("0.1.0")]);
    // An empty build version: macOS would otherwise say "Version 0.1.0 (0.1.0)" (Info.plist has both).
    expect(aboutPanel("0.1.0")).toEqual({ applicationName: "Ember", applicationVersion: "0.1.0", version: "", copyright: "Copyright © 2026 komaladitya-08. Released under the MIT licence." });
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

describe("the native theme (review #245)", () => {
  it("is dark on every OS, as every page is", () => {
    for (const [os, appMenu] of [["linux", false], ["win32", false], ["darwin", true]] as [OS, boolean][]) {
      const f = fakeElectron();
      setUpAppChrome({ os, appMenu, actions: actions() }, f.e as never);
      expect(f.e.nativeTheme.themeSource).toBe("dark");
    }
  });

  it("asks GTK for its dark variant on the settings, command and prompt windows, so GNOME draws their title bars dark", () => {
    // themeSource doesn't reach a GTK window: Mutter reads the window's _GTK_THEME_VARIANT, which darkTheme sets.
    // Windows and macOS ignore the option.
    for (const os of ["linux", "win32", "darwin"] as OS[]) {
      for (const [name, make] of [["settings", () => createHomeWindow(os)], ["command", () => createCommandWindow(os)], ["prompt", () => createPromptWindow(os)]] as const) {
        make();
        expect(electron.made.at(-1)!.options.darkTheme, `${name} on ${os}`).toBe(true);
      }
    }
  });
});

describe("zoom in the settings window on Windows and Linux (review #243)", () => {
  /** A key going down with Ctrl held, as before-input-event reports it. */
  const ctrl = (key: string, o: { shift?: boolean; alt?: boolean; meta?: boolean; control?: boolean; type?: string } = {}) =>
    ({ type: o.type ?? "keyDown", key, control: o.control ?? true, shift: o.shift ?? false, alt: o.alt ?? false, meta: o.meta ?? false });

  it("zooms in with Ctrl+= and Ctrl++, out with Ctrl+-, and back to 100% with Ctrl+0, half a level a step, as Electron's menu did", () => {
    for (const os of ["linux", "win32"] as OS[]) {
      expect(zoomLevelFor(os, ctrl("="), 0)).toBe(0.5);
      // Ctrl+Shift+= on a US keyboard, the + key on a German one, the numpad's +.
      expect(zoomLevelFor(os, ctrl("+", { shift: true }), 0.5)).toBe(1);
      expect(zoomLevelFor(os, ctrl("+"), 0)).toBe(0.5);
      expect(zoomLevelFor(os, ctrl("-"), 0)).toBe(-0.5);
      expect(zoomLevelFor(os, ctrl("0"), 2.5)).toBe(0);
      expect(zoomLevelFor(os, ctrl("0"), -1)).toBe(0);
    }
  });

  it("goes no further than 58% and 249% (past WCAG's 200% text)", () => {
    expect(ZOOM).toEqual({ step: 0.5, min: -3, max: 5 });
    expect(1.2 ** ZOOM.max).toBeGreaterThan(2);
    expect(zoomLevelFor("linux", ctrl("="), ZOOM.max)).toBe(ZOOM.max);
    expect(zoomLevelFor("linux", ctrl("="), 4.75)).toBe(ZOOM.max);
    expect(zoomLevelFor("win32", ctrl("-"), ZOOM.min)).toBe(ZOOM.min);
  });

  it("leaves every other key to the page: no Ctrl, Alt or AltGr, the Windows or Command key, Shift with - or 0, key up, macOS", () => {
    for (const input of [
      ctrl("=", { control: false }), ctrl("+", { alt: true }), ctrl("-", { alt: true }), ctrl("0", { meta: true }),
      ctrl("-", { shift: true }), ctrl("0", { shift: true }), ctrl("_", { shift: true }), ctrl("=", { type: "keyUp" }),
      ctrl("a"), ctrl("c"), ctrl("v"), ctrl("z"), ctrl("q"), ctrl("1"),
    ]) expect(zoomLevelFor("linux", input, 0), JSON.stringify(input)).toBeNull();
    // macOS never had zoom: its menu has no View menu.
    for (const k of ["=", "+", "-", "0"]) expect(zoomLevelFor("darwin", ctrl(k), 0)).toBeNull();
  });

  it("is wired to the settings window only, on Windows and Linux: the command and prompt windows are fixed in size", () => {
    for (const os of ["linux", "win32"] as OS[]) {
      createHomeWindow(os);
      const { page } = electron.made.at(-1)!;
      const onKey = page.handlers.get("before-input-event") as unknown as (e: { preventDefault(): void }, input: ReturnType<typeof ctrl>) => void;
      expect(onKey, os).toBeTypeOf("function");
      const e = { preventDefault: vi.fn() };
      onKey(e, ctrl("="));
      onKey(e, ctrl("+", { shift: true }));
      expect(page.level).toBe(1);
      expect(e.preventDefault).toHaveBeenCalledTimes(2);
      onKey(e, ctrl("0"));
      expect(page.level).toBe(0);
      // Not a zoom key: the page gets it, untouched.
      const typed = { preventDefault: vi.fn() };
      onKey(typed, ctrl("a"));
      onKey(typed, ctrl("=", { type: "keyUp" }));
      expect(typed.preventDefault).not.toHaveBeenCalled();
      expect(page.level).toBe(0);
      for (const make of [() => createCommandWindow(os), () => createPromptWindow(os)]) {
        make();
        expect(electron.made.at(-1)!.page.handlers.has("before-input-event")).toBe(false);
      }
    }
    createHomeWindow("darwin");
    expect(electron.made.at(-1)!.page.handlers.has("before-input-event")).toBe(false);
  });

  it("is given the OS by main.ts", () => {
    expect(MAIN).toContain("home = createHomeWindow(platform.os);");
  });
});

describe("the window icon (review #247)", () => {
  it("is the built PNG beside main.cjs, on Linux only and only when it was built", () => {
    expect(path.basename(WINDOW_ICON)).toBe("ember.png");
    expect(windowIconFor("linux", f => f === WINDOW_ICON)).toBe(WINDOW_ICON);
    expect(windowIconFor("linux", () => false)).toBeNull();
    // Windows takes Ember.exe's icon, macOS the bundle's.
    expect(windowIconFor("win32", () => true)).toBeNull();
    expect(windowIconFor("darwin", () => true)).toBeNull();
  });

  it("is given to every window made on Linux, so Alt-Tab and the dash show Ember without a .desktop entry", () => {
    const f = fakeElectron();
    setUpAppChrome({ os: "linux", appMenu: false, actions: actions() }, f.e as never);
    const win = { setIcon: vi.fn() };
    f.handlers.get("browser-window-created")!({}, win as never);
    expect(win.setIcon).toHaveBeenCalledWith(WINDOW_ICON);
    for (const [os, appMenu, iconThere] of [["win32", false, true], ["darwin", true, true], ["linux", false, false]] as [OS, boolean, boolean][]) {
      const other = fakeElectron({ iconThere });
      setUpAppChrome({ os, appMenu, actions: actions() }, other.e as never);
      expect(other.calls).not.toContain("browser-window-created");
    }
  });

  it("is rendered by the build from the same SVG, which goes on without it when sharp is missing", () => {
    const build = fs.readFileSync(path.resolve("scripts/build-app.mjs"), "utf8");
    expect(build).toContain('icon.writePng(fileURLToPath(new URL("assets/ember.svg", root)), fileURLToPath(new URL("ember.png", out)), 256)');
    expect(build).toMatch(/\.catch\(err => console\.warn\(`warning: dist\/app\/ember\.png wasn't made/);
  });
});

describe("the quit question's words (review #226)", () => {
  it("says them for several tasks, it for one", () => {
    expect(quitQuestion(1, { commands: 0, connections: 0 })?.detail).toBe("Quitting stops it where it is.");
    expect(quitQuestion(3, { commands: 0, connections: 0 })).toEqual({ message: "Ember is still working on 3 tasks.", detail: "Quitting stops them where they are." });
  });
});
