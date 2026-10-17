/**
 * The "Ask Ember" text box (Ctrl+Alt+Space): a focusable pill above Ember (below it near the top of the screen).
 * Without a compositor (xrdp, VNC) a transparent window paints black, so the box is then an opaque panel.
 */

import { BrowserWindow, screen } from "electron";
import path from "node:path";
import { IPC, type AskContext } from "../shared/ipc";

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

  /**
   * `keepOff`: Ember's handle in the corner now (global DIP); the box never covers it. `takeFocus`: gives X window
   * `xid` the keyboard (a window manager that prevents focus stealing would leave it with the app the user is in,
   * and their first letters would go there).
   */
  constructor(private o: { keepOff?: () => Box | null; takeFocus?: (xid: number) => void } = {}) {}

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
      backgroundColor: opaque ? "#1a120e" : "#00000000",
      webPreferences: {
        preload: path.join(appDir, "preload", "ask.cjs"),
        contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
      },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.on("blur", () => { if (this.win === win) this.hide(); });
    // A crashed ask box is rebuilt on the next Ctrl+Alt+Space.
    win.webContents.on("render-process-gone", () => { if (!win.isDestroyed()) win.destroy(); if (this.win === win) this.win = null; });
    // Once it has loaded (isLoading() is still true during "did-finish-load", so the context waited for the next
    // update and the first box opened from the menu never showed "Ember will see: …").
    win.webContents.on("did-stop-loading", () => { if (this.win === win) this.sendContext(); });
    void win.loadFile(path.join(appDir, "renderer", "ask", "index.html"), opaque ? { query: { opaque: "1" } } : {});
    win.once("ready-to-show", () => {
      if (this.win !== win) return;
      this.loaded = true;
      if (this.wanted && Date.now() - this.wantedAt <= LATE_MS) this.reveal(win);
      else this.wanted = false;
    });
    return win;
  }

  private reveal(win: BrowserWindow): void {
    win.show();
    win.focus();
    try { const xid = win.getNativeWindowHandle().readUInt32LE(0); if (xid) this.o.takeFocus?.(xid); } catch { /* not X11 */ }
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
  show(near: { x: number; y: number; size?: number } | null, context?: AskContext): void {
    this.context = { ...(context ?? this.context), opened: true };
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
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  /** Open now (it closes when it loses focus, so open means the user is typing in it). */
  get visible(): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.isVisible();
  }

  focus(): void {
    if (this.win && !this.win.isDestroyed()) this.win.focus();
  }

  owns(sender: Electron.WebContents): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.webContents === sender;
  }

  /** Is X window `xid` the box (it closes when it loses focus, so focus never goes back to it)? */
  isWindow(xid: number): boolean {
    try { return !!this.win && !this.win.isDestroyed() && this.win.getNativeWindowHandle().readUInt32LE(0) === xid; } catch { return false; }
  }
}
