/** The "Ask Ember" text box (Ctrl+Alt+Space): a focusable pill above Ember (below it near the top of the screen). */

import { BrowserWindow, screen } from "electron";
import path from "node:path";
import { IPC, type AskContext } from "../shared/ipc";

const appDir = __dirname;
const SIZE = { width: 560, height: 92 };
/** Ember's size when the caller doesn't say (the default setting). */
const EMBER_SIZE = 60;

/**
 * Where the box goes (global DIP): centred over Ember (`near`: its centre, and its size in px), with its hint row
 * clear of Ember's head; below Ember when there's no room above (Ember near the top of the screen); without
 * `near`, low in the middle of the work area. Always inside the work area.
 */
export function askBounds(near: { x: number; y: number; size?: number } | null, wa: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } {
  const size = near?.size ?? EMBER_SIZE;
  const top = wa.y + 8, bottom = wa.y + wa.height - SIZE.height - 8;
  let y = wa.y + wa.height - SIZE.height - 90;
  if (near) {
    const above = near.y - SIZE.height - Math.max(18, size * 0.5 - 8);
    const below = near.y + size * 0.6;
    y = above >= top || below > bottom ? above : below;
  }
  const x = near ? near.x - SIZE.width / 2 : wa.x + (wa.width - SIZE.width) / 2;
  return {
    ...SIZE,
    x: Math.round(Math.min(Math.max(x, wa.x + 8), wa.x + wa.width - SIZE.width - 8)),
    y: Math.round(Math.min(Math.max(y, top), bottom)),
  };
}

export class AskWindow {
  private win: BrowserWindow | null = null;
  private context: AskContext = { sees: null, history: [] };

  /**
   * Opens the box by Ember (`near`: its centre in global DIP, and its size in px when known); `context` says what
   * Ember will read and lists earlier questions (it can follow a moment later via setContext).
   */
  show(near: { x: number; y: number; size?: number } | null, context?: AskContext): void {
    if (context) this.context = context;
    const display = screen.getDisplayNearestPoint(near ?? screen.getCursorScreenPoint());
    const bounds = askBounds(near, display.workArea);
    if (!this.win || this.win.isDestroyed()) {
      this.win = new BrowserWindow({
        ...bounds,
        transparent: true, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
        fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, show: false, hasShadow: false, title: "Ask Ember",
        backgroundColor: "#00000000",
        webPreferences: {
          preload: path.join(appDir, "preload", "ask.cjs"),
          contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
        },
      });
      this.win.setAlwaysOnTop(true, "screen-saver");
      this.win.on("blur", () => this.hide());
      // A crashed ask box is rebuilt on the next Ctrl+Alt+Space.
      this.win.webContents.on("render-process-gone", () => { if (this.win && !this.win.isDestroyed()) this.win.destroy(); this.win = null; });
      this.win.webContents.on("did-finish-load", () => this.sendContext());
      void this.win.loadFile(path.join(appDir, "renderer", "ask", "index.html"));
      this.win.once("ready-to-show", () => { this.win?.show(); this.win?.focus(); });
    } else {
      this.win.setBounds(bounds);
      this.win.show();
      this.win.focus();
      this.sendContext();
    }
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
}
