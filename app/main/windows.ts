/**
 * The settings window ("home"), the command window ("Ember commands") and the prompt window, the check that an IPC
 * message comes from one of Ember's own bundled pages, what the settings page may change, and the quit question's
 * words. Every BrowserWindow keeps contextIsolation, the sandbox and a preload of its own. The command and prompt
 * windows are made here with their options per OS (L13: no other new module imports Electron); their controllers
 * (commands/window.ts, remote/prompt-window.ts) are plain Node and show, raise and hide them. Also the app-wide
 * chrome main sets once Electron is ready: the application menu, the About panel, the native theme, the windows' icon
 * on Linux and DevTools in a packaged build.
 */

import { app, BrowserWindow, Menu, nativeTheme, screen, type MenuItemConstructorOptions } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { OS } from "../shared/shortcuts";
import { PROMPT_SIZE, fitBounds } from "./remote/prompt-window";
import type { SettingsPatch } from "./settings";
import { placeOnDisplay, type CloseGuarded, type Placeable } from "./commands/window";
import { rescaledBounds, scaledSize } from "./page-prefs";

/** Root of the built app (dist/app), where main.cjs lives. */
const appDir = __dirname;

/** The settings window, which zooms by keys on Windows and Linux (zoomByKeys). */
export function createHomeWindow(os: OS): BrowserWindow {
  const win = new BrowserWindow({
    width: 760,
    height: 640,
    minWidth: 420,
    minHeight: 420,
    title: "Ember",
    show: false,
    backgroundColor: "#121011",
    // Linux: GTK's dark variant, so GNOME draws the title bar dark, as the page is (review #245). nativeTheme
    // (setUpAppChrome) doesn't reach GTK; Windows and macOS ignore this and follow nativeTheme.
    darkTheme: true,
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
  zoomByKeys(win.webContents, os);
  void win.loadFile(path.join(appDir, "renderer", "home", "index.html"));
  return win;
}

/** The settings window's zoom: Electron's own step, from 58% (1.2^-3) to 249% (1.2^5), past WCAG's 200% text. */
export const ZOOM = { step: 0.5, min: -3, max: 5 } as const;

/** A key as before-input-event reports it, as far as zoomLevelFor reads it. */
export interface KeyInput { type: string; key: string; control: boolean; shift: boolean; alt: boolean; meta: boolean }

/**
 * The settings window's zoom level after this key, or null when it isn't a zoom key (review #243). Electron's default
 * menu was what zoomed on Windows and Linux, and they have no menu now: Ctrl+= or Ctrl++ (Shift+= on a US keyboard,
 * the + key on others, the numpad's) zooms in, Ctrl+- out, Ctrl+0 back to 100%. Not with Alt (AltGr is Ctrl+Alt on
 * Windows) or the Windows key. macOS: no zoom, as before (its menu has no View menu).
 */
export function zoomLevelFor(os: OS, input: KeyInput, level: number): number | null {
  if (os === "darwin" || input.type !== "keyDown" || !input.control || input.alt || input.meta) return null;
  if (input.key === "0" && !input.shift) return 0;
  const step = input.key === "=" || input.key === "+" ? ZOOM.step : input.key === "-" && !input.shift ? -ZOOM.step : 0;
  return step ? Math.min(ZOOM.max, Math.max(ZOOM.min, level + step)) : null;
}

/** A page's webContents, as far as zoomByKeys needs it. */
export interface ZoomHost {
  on(event: "before-input-event", listener: (event: { preventDefault(): void }, input: KeyInput) => void): unknown;
  getZoomLevel(): number;
  setZoomLevel(level: number): void;
}

/**
 * The page zooms by keys on Windows and Linux (zoomLevelFor), and never sees a zoom key. Only the settings window: the
 * command and prompt windows are fixed in size, and their cards would be cut off. Chromium keeps a file:// page's zoom
 * to its own window.
 */
export function zoomByKeys(contents: ZoomHost, os: OS): void {
  if (os === "darwin") return;
  contents.on("before-input-event", (event, input) => {
    const level = zoomLevelFor(os, input, contents.getZoomLevel());
    if (level === null) return;
    event.preventDefault();
    contents.setZoomLevel(level);
  });
}

/** What every Ember page gets: its own preload, contextIsolation, the sandbox, no Node and no spellchecker downloads. */
const webPreferences = (page: string) => ({
  preload: path.join(appDir, "preload", `${page}.cjs`),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  spellcheck: false,
});

/** The text's scale (1, 1.15 or 1.3: page-prefs.ts's textScale), which main keeps up to date with the settings. */
let textScaleNow = 1;
/**
 * The command and prompt windows open now, with their smallest size at the default text size (null: none). Their
 * controllers make each once and then hide and show it, so one already made grows or shrinks when the text size changes.
 */
const sizedForText = new Map<BrowserWindow, { minWidth: number; minHeight: number } | null>();
export function setTextScale(scale: number): void {
  const from = textScaleNow;
  textScaleNow = Number.isFinite(scale) && scale > 0 ? scale : 1;
  if (textScaleNow === from) return;
  for (const [win, min] of sizedForText) {
    if (win.isDestroyed()) { sizedForText.delete(win); continue; }
    try {
      const now = win.getBounds();
      const area = screen.getDisplayMatching(now).workArea;
      const least = min && scaledSize(min, textScaleNow, area);
      if (least) win.setMinimumSize(least.minWidth, least.minHeight);
      win.setBounds(rescaledBounds(now, from, textScaleNow, area, least ? { width: least.minWidth, height: least.minHeight } : undefined));
    } catch { /* a window that can't be resized keeps its size */ }
  }
}
/** Keeps `win` growing and shrinking with the text while it is open. */
function sizeForText(win: BrowserWindow, min: { minWidth: number; minHeight: number } | null): void {
  sizedForText.set(win, min);
  win.on("closed", () => sizedForText.delete(win));
}

/**
 * A window's usual size grown with the text, so its words keep their room (review #57); inside the primary display's
 * work area. At the default size it is the usual size.
 */
const forText = <T extends Record<string, number>>(size: T): T =>
  textScaleNow === 1 ? size : scaledSize(size, textScaleNow, screen.getPrimaryDisplay().workAreaSize);

/** The command window's smallest size at the default text size. */
const COMMAND_MIN = { minWidth: 480, minHeight: 280 };

/**
 * What the command and prompt windows get to come up where the user is (review #272): the display nearest the pointer,
 * and every workspace (over a full-screen app on macOS) while a card is up. Their controllers call these. A macOS
 * panel (`panel`) is on every Space and over full-screen apps already (platform/compose.ts): it is left alone, as
 * clearing it once a card goes would tie the panel to one Space.
 */
function placeable(win: BrowserWindow, panel = false): Placeable {
  return {
    placeNearUser() {
      const to = placeOnDisplay(win.getBounds(), screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea);
      if (to) win.setBounds(to);
    },
    setOnAllWorkspaces(on) {
      if (panel) return;
      win.setVisibleOnAllWorkspaces(on, { visibleOnFullScreen: true, skipTransformProcessType: true });
    },
  };
}

/**
 * The command window ("Ember commands", §3.10, §8.5): hidden until its controller shows it. macOS: a non-activating panel
 * whose first click counts (one click allows; the user's app stays active). Windows: its controller shows it inactive.
 * On Windows and macOS it is left out of screen captures too (Linux has no such switch: Perception masks it, §3.10).
 */
export function createCommandWindow(os: OS): BrowserWindow & CloseGuarded & Placeable {
  const win = new BrowserWindow({
    ...forText({ width: 760, height: 480, ...COMMAND_MIN }),
    title: "Ember commands",
    show: false,
    backgroundColor: "#121011",
    darkTheme: true,
    autoHideMenuBar: true,
    ...(os === "darwin" ? { type: "panel", acceptFirstMouse: true } : {}),
    webPreferences: webPreferences("command"),
  });
  sizeForText(win, COMMAND_MIN);
  if (os === "win32" || os === "darwin") win.setContentProtection(true);
  closeWhenGone(win);
  void win.loadFile(path.join(appDir, "renderer", "command", "index.html"));
  // Its close button asks the controller's guard first, so a command never runs on unseen (review #262). Never while
  // Ember quits or the session ends: then nothing holds the window (a held window would stop the quit).
  let guard: (() => boolean) | null = null;
  let leaving = false;
  const onLeave = () => { leaving = true; };
  app.on("before-quit", onLeave);
  win.on("session-end", onLeave);
  win.on("closed", () => app.removeListener("before-quit", onLeave));
  const keep = (): boolean => {
    try { return !leaving && guard?.() === true; } catch { return false; } // a guard that fails never holds the window
  };
  win.on("close", e => { if (keep()) e.preventDefault(); });
  return Object.assign(win, { setCloseGuard: (fn: () => boolean) => { guard = fn; } }, placeable(win, os === "darwin"));
}

/**
 * A card window whose page crashed closes rather than staying on screen blank (review #91): its controller then does
 * what it does when the user closes it (an SSH prompt is answered no, a countdown is cancelled, a consent question
 * comes back with the bubble's "Read it"), and the next card gets a new window.
 */
function closeWhenGone(win: BrowserWindow): void {
  win.webContents.on("render-process-gone", () => { if (!win.isDestroyed()) win.destroy(); });
}

/**
 * The prompt window ("Ember", §8.6): one card at a time (a host key, a password, a consent card), always on top. It
 * takes the keyboard, as it takes typing: `takeKeyboard` is main's (as settings is brought to the front: macOS
 * activates Ember, Windows asks through the input backend), else show() and focus(); on macOS its first click counts
 * (review #235). On Windows and macOS it is left out of screen captures. Its controller fits it to each card (`fit`:
 * small for an SSH prompt, larger for a consent card, review #182, #270: sizes of the page, the frame comes on top),
 * centred where it is and inside its display's work area; the user doesn't resize it.
 */
export function createPromptWindow(os: OS, hooks: { takeKeyboard?: (win: BrowserWindow) => void } = {}):
  BrowserWindow & Placeable & { fit(size: { width: number; height: number }): void; takeKeyboard(): void } {
  const win = new BrowserWindow({
    ...forText({ width: PROMPT_SIZE.card.width, height: PROMPT_SIZE.card.height }),
    // The sizes are the page's own: the title bar and borders (Windows, macOS) come on top of them.
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Ember",
    show: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: "#121011",
    darkTheme: true,
    autoHideMenuBar: true,
    // A click on Allow or Connect while another app is active counts, rather than only activating Ember.
    ...(os === "darwin" ? { acceptFirstMouse: true } : {}),
    webPreferences: webPreferences("prompt"),
  });
  sizeForText(win, null);
  win.setAlwaysOnTop(true, "floating");
  if (os === "win32" || os === "darwin") win.setContentProtection(true);
  closeWhenGone(win);
  void win.loadFile(path.join(appDir, "renderer", "prompt", "index.html"));
  const fit = (size: { width: number; height: number }) => {
    if (win.isDestroyed()) return;
    const now = win.getBounds();
    // `size` is the page's: the window is that plus its frame, and the whole of it is kept inside the work area.
    const inner = win.getContentBounds();
    const frame = { width: Math.max(0, now.width - inner.width), height: Math.max(0, now.height - inner.height) };
    // The card's size grows with the text (review #57), as the window's first size does.
    const want = forText(size);
    const next = fitBounds(now, { width: want.width + frame.width, height: want.height + frame.height }, screen.getDisplayMatching(now).workArea);
    // Left where it is when it already has that size there (a window the user moved stays put).
    if (next.x !== now.x || next.y !== now.y || next.width !== now.width || next.height !== now.height) win.setBounds(next);
  };
  const takeKeyboard = () => {
    if (win.isDestroyed()) return;
    if (hooks.takeKeyboard) hooks.takeKeyboard(win);
    else { win.show(); win.focus(); }
  };
  return Object.assign(win, placeable(win), { fit, takeKeyboard });
}

/** One of Ember's windows as main sees it for keeping clear of it: on screen or not, focused or not, and where. */
export interface ShownWindow { visible: boolean; minimized: boolean; focused: boolean; bounds: { x: number; y: number; width: number; height: number } }

/**
 * What Ember steps beside (`aside`) and what its bubble keeps off (`avoid`), in DIP. Settings counts while it is shown
 * and focused (the user works in it), as before. Ember's own approval windows count while they ask (review #125): the
 * prompt window whenever it is shown (it shows only with a card), the command window while a question's command card is
 * up in it. They come first: the overlay stays above every window, so otherwise Ember, its bubble and the task cards
 * would sit on the card the user must read, and on its buttons.
 */
export function keepClearOf(o: { home: ShownWindow | null; prompt: ShownWindow | null; command: ShownWindow | null; commandCard: boolean }):
  { aside: ShownWindow["bounds"] | null; avoid: ShownWindow["bounds"][] } {
  const up = (w: ShownWindow | null): w is ShownWindow => !!w && w.visible && !w.minimized;
  const approvals = [o.prompt, o.commandCard ? o.command : null].filter(up).map(w => w.bounds);
  const home = up(o.home) && o.home.focused ? o.home.bounds : null;
  return { aside: approvals[0] ?? home, avoid: [...approvals, ...(home ? [home] : [])] };
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
 * copies, pastes and undoes in fields there, and the settings window zooms by its own keys (zoomByKeys).
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
 * Windows and Linux, so Electron's default one goes, with its bar) with its About panel on macOS, the dark native
 * theme, and from then on Ember's icon on every window on Linux and, in a packaged build, DevTools locked on every
 * page. Every page is dark-only (ember.css says color-scheme: dark), so the native theme is too, whatever the system's
 * appearance (review #245): on Windows it makes the title bars and Electron's menus dark, and on macOS the title bars,
 * menus and dialogs. Windows' message boxes (the quit question) have no dark mode and stay light. On Linux it reaches
 * nothing GTK draws: the windows ask GTK for its dark variant themselves (darkTheme in their factories), so GNOME's
 * title bars are dark, and menus and dialogs follow the GTK theme. A light appearance would be a design of its own.
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
