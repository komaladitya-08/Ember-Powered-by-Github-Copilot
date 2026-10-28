/**
 * The settings window ("home"), the command window ("Ember commands") and the prompt window, the check that an IPC
 * message comes from one of Ember's own bundled pages, what the settings page may change, and the quit question's
 * words. Every BrowserWindow keeps contextIsolation, the sandbox and a preload of its own. The command and prompt
 * windows are made here with their options per OS (L13: no other new module imports Electron); their controllers
 * (commands/window.ts, remote/prompt-window.ts) are plain Node and show, raise and hide them.
 */

import { app, BrowserWindow, screen } from "electron";
import path from "node:path";
import type { OS } from "../shared/shortcuts";
import { PROMPT_SIZE, fitBounds } from "./remote/prompt-window";
import type { SettingsPatch } from "./settings";
import { placeOnDisplay, type CloseGuarded, type Placeable } from "./commands/window";
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
