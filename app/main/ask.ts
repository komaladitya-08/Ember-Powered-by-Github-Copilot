/**
 * The "Ask Ember" text box (Ctrl+Alt+Space): a focusable pill above Ember (below it near the top of the screen).
 * Without a compositor (xrdp, VNC) a transparent window paints black, so the box is then an opaque panel.
 */

import { BrowserWindow, screen } from "electron";
import path from "node:path";
import { IPC, type AskContext } from "../shared/ipc";
import type { FloatingWindow } from "./platform/types";
import { applyAllWorkspaces } from "./platform/compose";
import { x11WindowId } from "./platform/linux/window-system";
import { pageUrl } from "./page-url";

const appDir = __dirname;
const SIZE = { width: 560, height: 92 };
/** Ember's size when the caller doesn't say (the default setting). */
const EMBER_SIZE = 60;
/** Gap to the work area's edges and to Ember's handle. */
const GAP = 8;
/** A box asked for that is still loading after this long isn't shown (the user has moved on: their keys went elsewhere). */
const LATE_MS = 1500;

type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/**
 * Where the box goes (global DIP): centred over Ember (`near`: its centre, and its size in px), with its hint row
 * clear of Ember's head; below Ember when there's no room above (Ember near the top of the screen); without
 * `near`, low in the middle of the work area. Always inside the work area, and clear of `keepOff` (Ember's
 * handle in the corner): above it, else beside it.
 */
export function askBounds(near: { x: number; y: number; size?: number } | null, wa: Box, keepOff?: Box | null): Box {
  const size = near?.size ?? EMBER_SIZE;
  const top = wa.y + GAP, bottom = wa.y + wa.height - SIZE.height - GAP;
  const left = wa.x + GAP, right = wa.x + wa.width - SIZE.width - GAP;
  let y = wa.y + wa.height - SIZE.height - 90;
  if (near) {
    const above = near.y - SIZE.height - Math.max(18, size * 0.5 - 8);
    const below = near.y + size * 0.6;
    y = above >= top || below > bottom ? above : below;
  }
  const x = near ? near.x - SIZE.width / 2 : wa.x + (wa.width - SIZE.width) / 2;
  const b = { ...SIZE, x: Math.round(Math.min(Math.max(x, left), right)), y: Math.round(Math.min(Math.max(y, top), bottom)) };
  return clearOf(b, wa, keepOff);
}

/** `b` moved off `keepOff` when over it: up above it (Ember is under the box, so this keeps clear of it too), else to its left. */
function clearOf(b: Box, wa: Box, keepOff?: Box | null): Box {
  if (!keepOff || !overlap(b, keepOff)) return b;
  const up = Math.round(keepOff.y - SIZE.height - GAP);
  if (up >= wa.y + GAP) return { ...b, y: up };
  const aside = Math.round(keepOff.x - SIZE.width - GAP);
  return aside >= wa.x + GAP ? { ...b, x: aside } : b;
}

export class AskWindow {
  private win: BrowserWindow | null = null;
  private context: AskContext = { sees: null, history: [] };
  /** No compositor: the box is drawn opaque (a transparent window would paint as a black rectangle). */
  private opaque = false;
  /** Whether the window there now was made opaque (it can't change after it is made). */
  private builtOpaque = false;
  /** The page in the window there now has loaded (it can show at once). */
  private loaded = false;
  /**
   * The user asked for the box and hasn't closed it since: a window still loading shows once it has loaded only
   * then (never later on its own, over whatever the user went on to do).
   */
  private wanted = false;
  /** When it was asked for: a box that took longer than LATE_MS to load doesn't pop up after all. */
  private wantedAt = 0;
  /** Who asked for the box (hotkey, menu, test): logged when it is actually shown. */
  private source = "unknown";

  /**
   * `keepOff`: Ember's handle in the corner now (global DIP); the box never covers it. `takeFocus`: gives the box,
   * window `id`, the keyboard (on X11 a window manager that prevents focus stealing would leave it with the app the
   * user is in, and their first letters would go there); called on every reveal with whatever `windowId` answered, 0
   * included, and the caller decides what to do with it. `hasFocus`: whether X itself says the box has the keyboard
   * now (Electron can report focus before the window manager has moved it). `onReveal`: every time the box is
   * actually shown (the only path that maps it): live unprompted opens that bypassed `openAsk` show up here.
   * `windowId`: the box's id in the window system's id space (default: its X id), 0 when it can't be told.
   * `floating`: the platform's window options and workspace rule (default: today's Linux window).
   */
  constructor(private o: {
    keepOff?: () => Box | null; takeFocus?: (id: number) => void; hasFocus?: () => boolean; onReveal?: (source: string) => void;
    windowId?: (w: BrowserWindow) => number; floating?: FloatingWindow;
  } = {}) {}

  /** The id of `win` in the window system's id space; 0 when it can't be told (never an id of another window). */
  private idOf(win: BrowserWindow): number {
    try { return (this.o.windowId ?? x11WindowId)(win); } catch { return 0; }
  }

  /** Makes the box ahead of time (hidden), so the first Ctrl+Alt+Space opens it at once. */
  prepare(): void {
    if (this.win && !this.win.isDestroyed()) return;
    const display = screen.getPrimaryDisplay();
    this.build(askBounds(null, display.workArea, this.keepOff()));
  }

  private build(bounds: Box): BrowserWindow {
    const opaque = this.builtOpaque = this.opaque;
    this.loaded = false;
    const win = this.win = new BrowserWindow({
      ...bounds,
      transparent: !opaque, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, show: false, hasShadow: false, title: "Ask Ember",
      backgroundColor: opaque ? "#242022" : "#00000000",
      ...(this.o.floating?.options ?? {}),
      webPreferences: {
        preload: path.join(appDir, "preload", "ask.cjs"),
        contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
      },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    if (this.o.floating) applyAllWorkspaces(win, this.o.floating.allWorkspaces);
    try { win.setIgnoreMouseEvents(true); } catch { /* test double */ }
    win.on("blur", () => { if (this.win === win) this.hide(); });
    // A crashed ask box is rebuilt on the next Ctrl+Alt+Space.
    win.webContents.on("render-process-gone", () => { if (!win.isDestroyed()) win.destroy(); if (this.win === win) this.win = null; });
    // Once it has loaded (isLoading() is still true during "did-finish-load", so the context waited for the next
    // update and the first box opened from the menu never showed "Ember will see: …").
    win.webContents.on("did-stop-loading", () => { if (this.win === win) this.sendContext(); });
    void win.loadURL(pageUrl(path.join(appDir, "renderer", "ask", "index.html"), opaque ? { opaque: "1" } : {}));
    win.once("ready-to-show", () => {
      if (this.win !== win) return;
      this.loaded = true;
      if (this.wanted && Date.now() - this.wantedAt <= LATE_MS) this.reveal(win);
      else this.wanted = false;
    });
    return win;
  }

  private reveal(win: BrowserWindow): void {
    try { win.setIgnoreMouseEvents(false); } catch { /* test double */ }
    this.o.onReveal?.(this.source);
    win.show();
    win.focus();
    // Best effort, as it always was: the box is shown and gets its context whatever the window manager says.
    try { this.o.takeFocus?.(this.idOf(win)); } catch { /* the keyboard stays where the window manager put it */ }
    this.sendContext();
  }

  /**
   * With a compositor (false) the box floats, transparent around its rounded field; without one (true) it is
   * an opaque panel. Applies from the next time it opens.
   */
  setOpaque(on: boolean): void {
    this.opaque = on;
  }

  /**
   * Opens the box by Ember (`near`: its centre in global DIP, and its size in px when known); `context` says what
   * Ember will read and lists earlier questions (it can follow a moment later via setContext).
   */
  show(near: { x: number; y: number; size?: number } | null, context?: AskContext, source = "open"): void {
    this.context = { ...(context ?? this.context), opened: true };
    this.source = source;
    this.wanted = true;
    this.wantedAt = Date.now();
    const display = screen.getDisplayNearestPoint(near ?? screen.getCursorScreenPoint());
    const bounds = askBounds(near, display.workArea, this.keepOff());
    // The compositor came or went since the box was made: it is made again, opaque or not.
    if (this.win && !this.win.isDestroyed() && this.builtOpaque !== this.opaque) { this.win.destroy(); this.win = null; }
    if (!this.win || this.win.isDestroyed()) { this.build(bounds); return; }
    this.win.setBounds(bounds);
    if (this.loaded) this.reveal(this.win);
  }

  /** Ember's handle changed (the compositor came or went): a box open over the new one moves off it. */
  keepClear(): void {
    if (!this.win || this.win.isDestroyed() || !this.win.isVisible()) return;
    const b = this.win.getBounds();
    const next = clearOf(b, screen.getDisplayMatching(b).workArea, this.keepOff());
    if (next !== b) this.win.setBounds(next);
  }

  private keepOff(): Box | null {
    try { return this.o.keepOff?.() ?? null; } catch { return null; }
  }

  /** What Ember will read, once the quick look at the screen is done. */
  setContext(context: AskContext): void {
    this.context = context;
    this.sendContext();
  }

  private sendContext(): void {
    if (this.win && !this.win.isDestroyed() && !this.win.webContents.isLoading()) this.win.webContents.send(IPC.askContext, this.context);
  }

  hide(): void {
    this.wanted = false;
    if (!this.win || this.win.isDestroyed()) return;
    this.win.hide();
    // A hidden always-on-top box on X11 can stay mapped and steal a click into the app beneath (that click then
    // looks like the box opening by itself). While hidden it takes no pointer.
    try { this.win.setIgnoreMouseEvents(true); } catch { /* test double */ }
  }

  /**
   * Resolves once the box has the keyboard (true), or after `ms` (false). The keys typed while it opened are given to
   * it then (typed()).
   */
  hasKeyboard(ms = 1200): Promise<boolean> {
    const win = this.win;
    if (!win || win.isDestroyed()) return Promise.resolve(false);
    return new Promise(resolve => {
      const t0 = Date.now();
      const check = () => {
        const ok = !win.isDestroyed() && win.isVisible() && win.isFocused() && this.loaded && (this.o.hasFocus?.() ?? true);
        if (ok || win.isDestroyed() || Date.now() - t0 > ms) { clearInterval(timer); resolve(ok); }
      };
      const timer = setInterval(check, 10);
      check();
    });
  }

  /** What was typed while the box opened goes into it (only while it is open and was asked for). */
  typed(t: { text: string; submit: boolean; cancel: boolean }): void {
    if (!this.wanted || !this.win || this.win.isDestroyed() || !this.loaded) return;
    if (!t.text && !t.submit && !t.cancel) return;
    this.win.webContents.send(IPC.askTyped, t);
  }

  /** Open now (it closes when it loses focus, so open means the user is typing in it). */
  get visible(): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.isVisible();
  }

  focus(): void {
    if (this.wanted && this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.focus();
  }

  owns(sender: Electron.WebContents): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.webContents === sender;
  }

  /**
   * Is window `id` the box (it closes when it loses focus, so focus never goes back to it)? Never for 0: an id that
   * can't be told is no window, so it never matches a box whose own id can't be told either.
   */
  isWindow(id: number): boolean {
    return id !== 0 && !!this.win && !this.win.isDestroyed() && this.idOf(this.win) === id;
  }
}
