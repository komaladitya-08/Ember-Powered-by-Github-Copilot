/**
 * Ember's handle: a small always-on-top pill in the corner of the primary
 * display with Ember's face and status. Clicking it opens Ember's menu, so
 * nothing depends on a tray (GNOME 3.32 has none by default).
 *
 * Without a compositor (xrdp, VNC) transparent overlays render black, so the
 * handle becomes an opaque card that also shows what Ember is saying.
 */

import { BrowserWindow, screen } from "electron";
import path from "node:path";
import type { Settings } from "./settings";
import { OVERLAY, type EmberState, type OverlayInit } from "../shared/overlay";

const appDir = __dirname;
const PILL = { width: 200, height: 56 };
const CARD = { width: 340, height: 132 };
const MARGIN = 12;

export class HandleWindow {
  readonly win: BrowserWindow;

  constructor(private settings: () => Settings, readonly fallback: boolean) {
    const size = fallback ? CARD : PILL;
    this.win = new BrowserWindow({
      ...size,
      ...this.corner(size),
      transparent: !fallback,
      backgroundColor: fallback ? "#1a120e" : "#00000000",
      frame: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      type: "toolbar",
      title: "Ember",
      webPreferences: {
        preload: path.join(appDir, "preload", "handle.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    this.win.setAlwaysOnTop(true, "screen-saver");
    this.win.setVisibleOnAllWorkspaces(true);
    this.win.webContents.once("did-finish-load", () => {
      const primary = screen.getPrimaryDisplay();
      const init: OverlayInit = { displayId: primary.id, bounds: primary.bounds, settings: this.settings(), fallback };
      this.win.webContents.send(OVERLAY.init, init);
      this.win.showInactive();
    });
    screen.on("display-metrics-changed", () => this.reposition());
    screen.on("display-removed", () => this.reposition());
    void this.win.loadFile(path.join(appDir, "renderer", "handle", "index.html"));
  }

  sendState(state: EmberState): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(OVERLAY.state, state);
  }

  sendSettings(s: Settings): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(OVERLAY.settings, s);
  }

  private corner(size: { width: number; height: number }) {
    const wa = screen.getPrimaryDisplay().workArea;
    return { x: wa.x + wa.width - size.width - MARGIN, y: wa.y + wa.height - size.height - MARGIN };
  }

  private reposition(): void {
    if (this.win.isDestroyed()) return;
    const size = this.fallback ? CARD : PILL;
    this.win.setBounds({ ...size, ...this.corner(size) });
  }
}
