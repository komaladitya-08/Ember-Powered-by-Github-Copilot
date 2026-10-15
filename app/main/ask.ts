/** The "Ask Ember" text box (Ctrl+Alt+Space): a focusable pill above Ember. */

import { BrowserWindow, screen } from "electron";
import path from "node:path";

const appDir = __dirname;
const SIZE = { width: 520, height: 58 };

export class AskWindow {
  private win: BrowserWindow | null = null;

  show(near: { x: number; y: number } | null): void {
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
      void this.win.loadFile(path.join(appDir, "renderer", "ask", "index.html"));
      this.win.once("ready-to-show", () => { this.win?.show(); this.win?.focus(); });
    } else {
      this.win.setBounds(bounds);
      this.win.show();
      this.win.focus();
    }
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  owns(sender: Electron.WebContents): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.webContents === sender;
  }
}
