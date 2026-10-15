/** The "Ask Ember" text box (Ctrl+Alt+Space): a focusable pill above Ember. */

import { BrowserWindow, screen } from "electron";
import path from "node:path";
import { IPC, type AskContext } from "../shared/ipc";

const appDir = __dirname;
const SIZE = { width: 560, height: 92 };

export class AskWindow {
  private win: BrowserWindow | null = null;
  private context: AskContext = { sees: null, history: [] };

  /** Opens the box; `context` says what Ember will read and lists earlier questions (it can follow a moment later via setContext). */
  show(near: { x: number; y: number } | null, context?: AskContext): void {
    if (context) this.context = context;
    const display = screen.getDisplayNearestPoint(near ?? screen.getCursorScreenPoint());
    const wa = display.workArea;
    const x = near ? near.x - SIZE.width / 2 : wa.x + (wa.width - SIZE.width) / 2;
    const y = near ? near.y - 110 : wa.y + wa.height - SIZE.height - 90;
    const bounds = {
      ...SIZE,
      x: Math.round(Math.min(Math.max(x, wa.x + 8), wa.x + wa.width - SIZE.width - 8)),
      y: Math.round(Math.min(Math.max(y, wa.y + 8), wa.y + wa.height - SIZE.height - 8)),
    };
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
