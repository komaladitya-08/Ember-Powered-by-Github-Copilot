/**
 * The settings window ("home"), the command window ("Ember commands") and the prompt window, the check that an IPC
 * message comes from one of Ember's own bundled pages, what the settings page may change, and the quit question's
 * words. Every BrowserWindow keeps contextIsolation, the sandbox and a preload of its own. The command and prompt
 * windows are made here with their options per OS (L13: no other new module imports Electron); their controllers
 * (commands/window.ts, remote/prompt-window.ts) are plain Node and show, raise and hide them.
 */

import { BrowserWindow, screen } from "electron";
import path from "node:path";
import type { OS } from "../shared/shortcuts";
import type { SettingsPatch } from "./settings";
import { rescaledBounds, scaledSize } from "./page-prefs";

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
 * The command window ("Ember commands", §3.10, §8.5): hidden until its controller shows it. macOS: a non-activating panel
 * whose first click counts (one click allows; the user's app stays active). Windows: its controller shows it inactive.
 * On Windows and macOS it is left out of screen captures too (Linux has no such switch: Perception masks it, §3.10).
 */
export function createCommandWindow(os: OS): BrowserWindow {
  const win = new BrowserWindow({
    ...forText({ width: 760, height: 480, ...COMMAND_MIN }),
    title: "Ember commands",
    show: false,
    backgroundColor: "#121011",
    autoHideMenuBar: true,
    ...(os === "darwin" ? { type: "panel", acceptFirstMouse: true } : {}),
    webPreferences: webPreferences("command"),
  });
  sizeForText(win, COMMAND_MIN);
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
    ...forText({ width: 440, height: 300 }),
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
  sizeForText(win, null);
  win.setAlwaysOnTop(true, "floating");
  if (os === "win32" || os === "darwin") win.setContentProtection(true);
  void win.loadFile(path.join(appDir, "renderer", "prompt", "index.html"));
  return win;
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
 * only, today's words.
 */
export function quitQuestion(tasks: number, busy: { commands: number; connections: number }, connected: string[] = []): { message: string; detail: string } | null {
  const { commands, connections } = busy;
  if (tasks <= 0 && commands <= 0 && connections <= 0) return null;
  if (commands <= 0 && connections <= 0) return { message: `Ember is still working on ${tasks === 1 ? "a task" : `${tasks} tasks`}.`, detail: "Quitting stops it where it is." };
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
