/**
 * Ember on screen: one transparent, click-through, always-on-top window per
 * display, driven at 60 Hz from the main process. Ember's position (a spring
 * toward the cursor) lives here in global coordinates, so it can cross
 * displays; each overlay renderer only draws what falls inside its bounds.
 *
 * Linux has no `forward` option for click-through, so hover is detected by
 * polling the cursor against the interactive rectangles each renderer reports.
 */

import { BrowserWindow, screen, type Display } from "electron";
import path from "node:path";
import { Follower, followTarget, contains } from "./follow";
import type { Logger } from "./logger";
import type { Settings } from "./settings";
import { OVERLAY, IDLE_BUBBLE, type EmberState, type OverlayInit, type Rect } from "../shared/overlay";

const appDir = __dirname;

interface Overlay {
  win: BrowserWindow;
  display: Display;
  interactive: Rect[];
  clickThrough: boolean;
}

export class OverlayManager {
  private overlays = new Map<number, Overlay>();
  private follower: Follower;
  private timer: NodeJS.Timeout | null = null;
  private topTimer: NodeJS.Timeout | null = null;
  private last = Date.now();
  private hidden = false;
  private state: EmberState = { emotion: "neutral", talking: false, bubble: IDLE_BUBBLE, tasks: [], status: null };

  constructor(
    private settings: () => Settings,
    private log: Logger,
    /** Cursor in global DIP; defaults to Electron's (which can be stale on X11). */
    private cursor: () => { x: number; y: number } = () => screen.getCursorScreenPoint(),
  ) {
    const c = this.cursor();
    this.follower = new Follower({ x: c.x + 60, y: c.y + 60 });
  }

  start(): void {
    for (const d of screen.getAllDisplays()) this.create(d);
    screen.on("display-added", (_e, d) => { this.log.info("display.added", { id: d.id }); this.create(d); });
    screen.on("display-removed", (_e, d) => { this.log.info("display.removed", { id: d.id }); this.destroy(d.id); });
    screen.on("display-metrics-changed", (_e, d) => {
      const o = this.overlays.get(d.id);
      if (!o) return;
      o.display = d;
      o.win.setBounds(d.bounds);
      o.win.webContents.send(OVERLAY.init, this.initFor(o));
    });
    this.timer = setInterval(() => this.tick(), 16);
    // Some shell surfaces (Activities, notifications) can rise above us; take the top back.
    this.topTimer = setInterval(() => this.raise(), 2000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.topTimer) clearInterval(this.topTimer);
    for (const id of [...this.overlays.keys()]) this.destroy(id);
  }

  setHidden(on: boolean): void {
    this.hidden = on;
  }

  isHidden(): boolean {
    return this.hidden;
  }

  setPaused(on: boolean): void {
    this.follower.setPaused(on);
  }

  park(at: { x: number; y: number } | null): void {
    this.follower.park(at);
  }

  get position(): { x: number; y: number } {
    return this.follower.position;
  }

  setState(next: Partial<EmberState>): void {
    const waiting = (s: EmberState) => s.bubble.visible && s.bubble.actions.length > 0;
    const before = waiting(this.state);
    this.state = { ...this.state, ...next };
    // While Ember waits for a decision it holds still, so its buttons don't run away from the cursor.
    if (waiting(this.state) !== before) this.follower.park(waiting(this.state) ? this.follower.position : null);
    for (const o of this.overlays.values()) o.win.webContents.send(OVERLAY.state, this.state);
  }

  getState(): EmberState {
    return this.state;
  }

  broadcastSettings(s: Settings): void {
    for (const o of this.overlays.values()) o.win.webContents.send(OVERLAY.settings, s);
  }

  /** Called by IPC when a renderer reports where its clickable parts are. */
  setInteractive(sender: Electron.WebContents, rects: Rect[]): void {
    for (const o of this.overlays.values()) if (o.win.webContents === sender) o.interactive = rects;
    this.log.debug("overlay.interactive", { rects });
  }

  owns(sender: Electron.WebContents): boolean {
    for (const o of this.overlays.values()) if (o.win.webContents === sender) return true;
    return false;
  }

  private initFor(o: Overlay): OverlayInit {
    return { displayId: o.display.id, bounds: o.display.bounds, settings: this.settings(), fallback: false };
  }

  private create(display: Display): void {
    if (this.overlays.has(display.id)) return;
    const win = new BrowserWindow({
      ...display.bounds,
      transparent: true,
      frame: false,
      backgroundColor: "#00000000",
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
      title: "Ember overlay",
      webPreferences: {
        preload: path.join(appDir, "preload", "overlay.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setIgnoreMouseEvents(true);
    const overlay: Overlay = { win, display, interactive: [], clickThrough: true };
    this.overlays.set(display.id, overlay);
    win.webContents.once("did-finish-load", () => {
      win.webContents.send(OVERLAY.init, this.initFor(overlay));
      win.webContents.send(OVERLAY.state, this.state);
      win.showInactive();
      win.setBounds(display.bounds); // re-apply after map; some WMs adjust on first show
      this.log.info("overlay.shown", { display: display.id, bounds: display.bounds });
    });
    win.on("closed", () => this.overlays.delete(display.id));
    void win.loadFile(path.join(appDir, "renderer", "overlay", "index.html"));
  }

  private destroy(id: number): void {
    const o = this.overlays.get(id);
    if (o && !o.win.isDestroyed()) o.win.destroy();
    this.overlays.delete(id);
  }

  private raise(): void {
    for (const o of this.overlays.values()) {
      if (o.win.isDestroyed()) continue;
      o.win.setAlwaysOnTop(true, "screen-saver");
      o.win.moveTop();
    }
  }

  private tick(): void {
    const now = Date.now();
    const dt = (now - this.last) / 1000;
    this.last = now;
    const cursor = this.cursor();
    const display = screen.getDisplayNearestPoint(cursor);
    const s = this.settings();
    const ember = this.follower.step(followTarget(cursor, s.size, display.workArea), dt);
    const frame = { ember, cursor, visible: !this.hidden };

    for (const o of this.overlays.values()) {
      if (o.win.isDestroyed()) continue;
      o.win.webContents.send(OVERLAY.frame, frame);
      // Hover-to-interact: only while the cursor is over something clickable.
      const local = { x: cursor.x - o.display.bounds.x, y: cursor.y - o.display.bounds.y };
      const over = contains(o.display.bounds, cursor) && o.interactive.some(r => contains(r, local));
      if (over === o.clickThrough) {
        o.clickThrough = !over;
        o.win.setIgnoreMouseEvents(!over);
        this.log.debug("overlay.clickthrough", { display: o.display.id, clickThrough: !over });
      }
    }
  }
}
