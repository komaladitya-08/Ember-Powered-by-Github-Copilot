/**
 * The settings window ("home"), the command window ("Ember commands") and the prompt window, the check that an IPC
 * message comes from one of Ember's own bundled pages, what the settings page may change, and the quit question's
 * words. Every BrowserWindow keeps contextIsolation, the sandbox and a preload of its own. The command and prompt
 * windows are made here with their options per OS (L13: no other new module imports Electron); their controllers
 * (commands/window.ts, remote/prompt-window.ts) are plain Node and show, raise and hide them. Also the app-wide
 * chrome main sets once Electron is ready: the application menu, the About panel, the native theme, the windows' icon
 * on Linux and DevTools in a packaged build.
 */

import { app, BrowserWindow, Menu, nativeTheme, type MenuItemConstructorOptions } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { OS } from "../shared/shortcuts";
import type { SettingsPatch } from "./settings";

/** Root of the built app (dist/app), where main.cjs lives. */
const appDir = __dirname;

export function createHomeWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 760,
    height: 640,
    minWidth: 420,
    minHeight: 420,
    title: "Ember",
    show: false,
    backgroundColor: "#121011",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(appDir, "preload", "home.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.once("ready-to-show", () => win.show());
  void win.loadFile(path.join(appDir, "renderer", "home", "index.html"));
  return win;
}

/** What every Ember page gets: its own preload, contextIsolation, the sandbox, no Node and no spellchecker downloads. */
const webPreferences = (page: string) => ({
  preload: path.join(appDir, "preload", `${page}.cjs`),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  spellcheck: false,
});

/**
 * The command window ("Ember commands", §3.10, §8.5): hidden until its controller shows it. macOS: a non-activating panel
 * whose first click counts (one click allows; the user's app stays active). Windows: its controller shows it inactive.
 * On Windows and macOS it is left out of screen captures too (Linux has no such switch: Perception masks it, §3.10).
 */
export function createCommandWindow(os: OS): BrowserWindow {
  const win = new BrowserWindow({
    width: 760,
    height: 480,
    minWidth: 480,
    minHeight: 280,
    title: "Ember commands",
    show: false,
    backgroundColor: "#121011",
    autoHideMenuBar: true,
    ...(os === "darwin" ? { type: "panel", acceptFirstMouse: true } : {}),
    webPreferences: webPreferences("command"),
  });
  if (os === "win32" || os === "darwin") win.setContentProtection(true);
  void win.loadFile(path.join(appDir, "renderer", "command", "index.html"));
  return win;
}

/**
 * The prompt window ("Ember", §8.6): one small card at a time (a host key, a password, a consent card), always on top.
 * It takes focus, as it takes typing. On Windows and macOS it is left out of screen captures.
 */
export function createPromptWindow(os: OS): BrowserWindow {
  const win = new BrowserWindow({
    width: 440,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Ember",
    show: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: "#121011",
    autoHideMenuBar: true,
    webPreferences: webPreferences("prompt"),
  });
  win.setAlwaysOnTop(true, "floating");
  if (os === "win32" || os === "darwin") win.setContentProtection(true);
  void win.loadFile(path.join(appDir, "renderer", "prompt", "index.html"));
  return win;
}

/** What the application menu's own items do: main's closures. */
export interface AppMenuActions {
  /** Settings… (Command+,). */
  showSettings(): void;
  /** Quit Ember (Command+Q): main's quitEmber, which asks first when quitting would stop something. */
  quit(): void;
}

/**
 * The application menu (review #243, #176, #232). macOS (`appMenu`, from the platform's lifecycle): About Ember,
 * Settings…, the hide items and a Quit that asks as the handle's Quit does, with the Edit menu that makes
 * Command+C/V/X/A/Z work in fields and the Window menu. Windows and Linux: none. Electron's default menu stayed there
 * otherwise, with Ctrl+Q quitting at once (no "still working" question), Ctrl+R reloading a card, Ctrl+Shift+I opening
 * DevTools on the password card, Ctrl+W closing the ask box, F11, and the bar Alt showed. Chromium itself still cuts,
 * copies, pastes and undoes in fields there.
 */
export function appMenuTemplate(appMenu: boolean, actions: AppMenuActions): MenuItemConstructorOptions[] | null {
  if (!appMenu) return null;
  return [
    { label: "Ember", submenu: [
      // app.name is "ember" (the data folder's name): the roles' own labels would say "About ember", "Hide ember".
      { role: "about", label: "About Ember" },
      { type: "separator" },
      { label: "Settings…", accelerator: "Command+,", click: () => actions.showSettings() },
      { type: "separator" }, { role: "hide", label: "Hide Ember" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" },
      { label: "Quit Ember", accelerator: "Command+Q", click: () => actions.quit() },
    ] },
    { role: "editMenu" },
    { role: "windowMenu" },
  ];
}

/** What macOS's About Ember panel says. */
export interface AboutPanel { applicationName: string; applicationVersion: string; version: string; copyright: string }

/**
 * What macOS's About Ember panel says (review #232): the name, this build's version once (an empty build number, or
 * macOS writes "Version 0.1.0 (0.1.0)": Info.plist has both) and the licence.
 */
export function aboutPanel(version: string): AboutPanel {
  return { applicationName: "Ember", applicationVersion: version, version: "", copyright: "Copyright © 2026 komaladitya-08. Released under the MIT licence." };
}

/** The windows' icon on Linux: build-app.mjs renders it from assets/ember.svg beside main.cjs. */
export const WINDOW_ICON = path.join(appDir, "ember.png");

/**
 * The icon Ember's windows carry, or null (review #247). Linux window managers take a window's icon from its
 * _NET_WM_ICON, else from a .desktop entry matching its WM_CLASS: the RPM installs one, but an AppImage without desktop
 * integration and a development run have none, and GNOME showed a generic icon in Alt-Tab and the dash. Windows takes
 * the icon from Ember.exe and macOS from the bundle, so they are given none, as before; nor is Linux when the build
 * couldn't render it.
 */
export function windowIconFor(os: OS, exists: (file: string) => boolean = fs.existsSync): string | null {
  return os === "linux" && exists(WINDOW_ICON) ? WINDOW_ICON : null;
}

/** A page's webContents, as far as lockDevTools needs it. */
export interface DevToolsHost {
  on(event: "devtools-opened", listener: () => void): unknown;
  closeDevTools(): void;
}

/**
 * DevTools close as soon as anything opens them on this page (review #176): from their console a page's preload
 * bridges could be called, and they show what is typed in the password card. Nothing in Ember opens them and no menu
 * offers them any more; this is for a packaged build, whatever still might (a development run keeps them).
 */
export function lockDevTools(contents: DevToolsHost): void {
  contents.on("devtools-opened", () => contents.closeDevTools());
}

/** The parts of Electron setUpAppChrome uses (tests pass fakes). */
export interface ChromeElectron {
  Menu: { buildFromTemplate(template: MenuItemConstructorOptions[]): Menu; setApplicationMenu(menu: Menu | null): void };
  nativeTheme: { themeSource: "system" | "light" | "dark" };
  app: {
    readonly isPackaged: boolean;
    getVersion(): string;
    setAboutPanelOptions(options: AboutPanel): void;
    on(event: "web-contents-created", listener: (event: unknown, contents: DevToolsHost) => void): unknown;
    on(event: "browser-window-created", listener: (event: unknown, window: { setIcon(icon: string): void }) => void): unknown;
  };
  /** fs.existsSync, for the window icon. */
  exists?: (file: string) => boolean;
}

/**
 * Ember's app-wide chrome, set once Electron is ready and before any window opens: the application menu (none on
 * Windows and Linux, so Electron's default one goes, with its bar) with its About panel on macOS, dark native chrome
 * on every OS, on Linux Ember's icon on every window made from then on, and in a packaged build DevTools locked on
 * every page made from then on. Every page is dark-only
 * (ember.css says color-scheme: dark), so title bars, native menus and dialogs follow it rather than a light system
 * theme around a near-black window (review #245); a light appearance would be a design of its own.
 */
export function setUpAppChrome(o: { os: OS; appMenu: boolean; actions: AppMenuActions }, e: ChromeElectron = { Menu, nativeTheme, app }): void {
  e.nativeTheme.themeSource = "dark";
  if (o.appMenu) e.app.setAboutPanelOptions(aboutPanel(e.app.getVersion()));
  const template = appMenuTemplate(o.appMenu, o.actions);
  e.Menu.setApplicationMenu(template ? e.Menu.buildFromTemplate(template) : null);
  if (e.app.isPackaged) e.app.on("web-contents-created", (_event, contents) => lockDevTools(contents));
  const icon = windowIconFor(o.os, e.exists);
  if (icon) e.app.on("browser-window-created", (_event, window) => window.setIcon(icon));
}

/**
 * What the settings page may change through IPC.updateSettings: anything but where Ember works (`targets`) and what
 * commands may do (`commands`). Those change only through the targets runtime's own channel, behind their consent
 * cards (TARGETS_IPC): a page that sent them here would skip a card, so they are dropped (fail closed).
 */
export function settingsFromHome(patch: SettingsPatch): { patch: SettingsPatch; dropped: ("targets" | "commands")[] } {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { patch, dropped: [] };
  const dropped = (["targets", "commands"] as const).filter(k => Object.prototype.hasOwnProperty.call(patch, k));
  if (!dropped.length) return { patch, dropped };
  const { targets: _targets, commands: _commands, ...rest } = patch;
  return { patch: rest, dropped };
}

/**
 * The quit question's words (§8.9) when quitting would stop something: tasks under way, commands running, computers
 * connected over SSH (`connected`: their names, when known). null when nothing would: Ember quits at once. With tasks
 * only, today's words; several tasks are "them", as in the mixed case (review #226).
 */
export function quitQuestion(tasks: number, busy: { commands: number; connections: number }, connected: string[] = []): { message: string; detail: string } | null {
  const { commands, connections } = busy;
  if (tasks <= 0 && commands <= 0 && connections <= 0) return null;
  if (commands <= 0 && connections <= 0) return { message: `Ember is still working on ${tasks === 1 ? "a task" : `${tasks} tasks`}.`, detail: `Quitting ${tasks === 1 ? "stops it where it is" : "stops them where they are"}.` };
  const work = [
    ...(tasks > 0 ? [`working on ${tasks === 1 ? "a task" : `${tasks} tasks`}`] : []),
    ...(commands > 0 ? [`running ${commands === 1 ? "1 command" : `${commands} commands`}`] : []),
  ];
  const names = connected.length === connections && connections <= 2 ? connected.join(" and ") : connections === 1 ? "another computer" : `${connections} computers`;
  const message = !work.length ? `Ember is connected to ${names}.`
    : `Ember is still ${work.join(" and ")}${connections > 0 ? `, and is connected to ${names}` : ""}.`;
  const one = tasks + Math.max(commands, 0) === 1;
  const stops = one ? "stops it where it is" : "stops them where they are";
  const detail = !work.length ? "Quitting disconnects." : connections > 0 ? `Quitting ${stops} and disconnects.` : `Quitting ${stops}.`;
  return { message, detail };
}

/**
 * True when an IPC message comes from one of our own bundled pages. File URLs use "/" on every OS: path.sep is "\" on
 * Windows, which never appears in one, so testing for it refused every settings request there.
 */
export function isTrustedSender(url: string): boolean {
  return url.startsWith("file://") && decodeURIComponent(url).includes("/renderer/");
}
