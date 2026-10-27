/**
 * Ember on screen: one transparent, click-through, always-on-top window per
 * display, driven at 60 Hz from the main process. Ember's position (a spring
 * toward the cursor) lives here in global coordinates, so it can cross
 * displays; each overlay renderer only draws what falls inside its bounds.
 *
 * Clicks reach an overlay only inside the interactive rectangles each renderer
 * reports: on Linux through the X input region the platform's shaper sets (Linux
 * has no `forward` option for click-through); on Windows and macOS, which have no
 * input region, by polling the cursor against those rectangles.
 */

import { BrowserWindow, screen, type Display } from "electron";
import path from "node:path";
import { Follower, followTarget, contains, besideRect, besideControl, overlapsBody, takesPointer } from "./follow";
import { revive } from "./revive";
import type { Logger } from "./logger";
import type { Settings } from "./settings";
import type { OverlayShaper } from "./platform/types";
import { applyAllWorkspaces } from "./platform/compose";
import { linuxOverlayShaper } from "./platform/linux/overlay-shaper";
import { OVERLAY, IDLE_BUBBLE, type EmberState, type OverlayInit, type Rect } from "../shared/overlay";

const appDir = __dirname;

interface Overlay {
  win: BrowserWindow;
  display: Display;
  interactive: Rect[];
  clickThrough: boolean;
  /** The input region is set to the clickable rectangles (clicks elsewhere pass through at X, not by hover polling). */
  shaped: boolean;
  /** The task cards on this display (global DIP). */
  cards: Rect | null;
}

export class OverlayManager {
  private overlays = new Map<number, Overlay>();
  private follower: Follower;
  private timer: NodeJS.Timeout | null = null;
  private topTimer: NodeJS.Timeout | null = null;
  private last = Date.now();
  private hidden = false;
  /** While Ember borrows the cursor its windows never take clicks, so every click reaches the app. */
  private borrowing = false;
  private state: EmberState = { emotion: "neutral", talking: false, bubble: IDLE_BUBBLE, tasks: [], status: null };

  constructor(
    private settings: () => Settings,
    private log: Logger,
    /** Cursor in global DIP, and the mouse buttons held (X's mask) when known; defaults to Electron's (which can be stale on X11). */
    private cursor: () => { x: number; y: number; buttons?: number } = () => screen.getCursorScreenPoint(),
    /** The platform's input regions and window options (Linux XShape by default; hover polling elsewhere). */
    private shaper: OverlayShaper = linuxOverlayShaper(),
  ) {
    const c = this.cursor();
    this.follower = new Follower({ x: c.x + 60, y: c.y + 60 });
  }

  private onAdded = (_e: unknown, d: Display) => { this.log.info("display.added", { id: d.id }); this.create(d); };
  private onRemoved = (_e: unknown, d: Display) => { this.log.info("display.removed", { id: d.id }); this.destroy(d.id); };
  private onMetrics = (_e: unknown, d: Display) => {
    const o = this.overlays.get(d.id);
    if (!o) return;
    o.display = d;
    o.win.setBounds(d.bounds);
    o.win.webContents.send(OVERLAY.init, this.initFor(o));
  };

  start(): void {
    for (const d of screen.getAllDisplays()) this.create(d);
    screen.on("display-added", this.onAdded);
    screen.on("display-removed", this.onRemoved);
    screen.on("display-metrics-changed", this.onMetrics);
    this.timer = setInterval(() => this.tick(), 16);
    // Some shell surfaces (Activities, notifications) can rise above us; take the top back.
    this.topTimer = setInterval(() => this.raise(), 2000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.topTimer) clearInterval(this.topTimer);
    screen.off("display-added", this.onAdded);
    screen.off("display-removed", this.onRemoved);
    screen.off("display-metrics-changed", this.onMetrics);
    for (const id of [...this.overlays.keys()]) this.destroy(id);
    // The X connection the input shapes went over goes with the windows (a new manager opens its own).
    this.shaper.release();
  }

  setHidden(on: boolean): void {
    this.hidden = on;
  }

  isHidden(): boolean {
    return this.hidden;
  }

  private paused = false;

  setPaused(on: boolean): void {
    this.paused = on;
    this.follower.setPaused(on);
  }

  park(at: { x: number; y: number } | null): void {
    this.follower.park(at);
  }

  get position(): { x: number; y: number } {
    return this.follower.position;
  }

  /**
   * Where Ember's handle sits (Ember keeps off it), and whether the desktop asks for less motion: read at start, then
   * as the overlay's page sees it change (reducedMotionChanged), so the spring follows the switch without a restart.
   */
  avoid: (() => Rect | null) | null = null;
  systemReducedMotion = false;

  /** Called by IPC when an overlay's page sees the desktop's reduce-motion preference change. */
  reducedMotionChanged(on: boolean): void {
    if (on === this.systemReducedMotion) return;
    this.systemReducedMotion = on;
    this.log.info("overlay.reduced_motion", { on });
  }
  /** A window of Ember's own the user is working in (settings): Ember waits beside it, or out of sight. */
  private aside: Rect | null = null;

  stepAside(r: Rect | null): void {
    this.aside = r;
  }

  setState(next: Partial<EmberState>): void {
    // Ember holds still while you decide (buttons) and while you read a finished answer or error;
    // following the cursor resumes when the bubble goes.
    const waiting = (s: EmberState) => s.bubble.visible && (s.bubble.actions.length > 0
      || (!s.bubble.streaming && !!s.bubble.thought && (s.bubble.mood === "idle" || s.bubble.mood === "done" || s.bubble.mood === "error")));
    const asks = (s: EmberState) => s.bubble.visible && s.bubble.actions.some(a => !a.id.startsWith("ui:"));
    const before = waiting(this.state);
    const askedBefore = asks(this.state);
    this.state = { ...this.state, ...next };
    const now = waiting(this.state);
    // A question appears: Ember stops right where it is, so its buttons are where they first showed when the user
    // reaches for them (flying on to a spot by the cursor moved them under a pointer already aimed at Allow).
    if (asks(this.state) && !askedBefore && !this.state.focus) {
      const at = this.follower.position;
      this.follower.jump(at);
      this.follower.park(at);
      for (const o of this.overlays.values()) o.win.webContents.send(OVERLAY.state, this.state);
      return;
    }
    if ("focus" in next || now !== before) {
      const f = this.state.focus;
      const size = this.settings().size;
      // Working on a control: Ember sits just beside it (on screen). Waiting for a decision: it holds still by
      // the cursor (where it would be now, not wherever it was on its way), so its buttons don't run away.
      // Otherwise it follows the cursor again.
      const c = this.cursor();
      const here = () => { const d = screen.getDisplayNearestPoint(c); return followTarget(c, size, d.workArea, this.keepOff(d)); };
      // ("Stay put": it answers where it already is.)
      this.follower.park(f ? this.besideFocus(f) : now ? (this.paused ? this.follower.position : here()) : null);
    }
    for (const o of this.overlays.values()) o.win.webContents.send(OVERLAY.state, this.state);
  }

  /**
   * Makes every overlay fully transparent so a screenshot doesn't include Ember,
   * waits for the compositor to repaint, and returns a function that restores them.
   */
  async hideForCapture(): Promise<() => void> {
    const wins = [...this.overlays.values()].map(o => o.win).filter(w => !w.isDestroyed());
    for (const w of wins) w.setOpacity(0);
    await new Promise(r => setTimeout(r, 60));
    return () => { for (const w of wins) if (!w.isDestroyed()) w.setOpacity(1); };
  }

  setBorrowing(on: boolean): void {
    this.borrowing = on;
    for (const o of this.overlays.values()) this.applyHits(o);
  }

  private lastHandleCheck = 0;
  private lastFrame: { ember: { x: number; y: number }; cursor: { x: number; y: number }; visible: boolean; on: number; at: number } | null = null;

  getState(): EmberState {
    return this.state;
  }

  broadcastSettings(s: Settings): void {
    for (const o of this.overlays.values()) o.win.webContents.send(OVERLAY.settings, s);
  }

  /** Where Ember holds still beside the control it works on (null: it isn't). */
  private beside: { x: number; y: number } | null = null;

  /** Beside the control Ember works on, off its handle and that display's task cards. */
  private besideFocus(f: Rect): { x: number; y: number } {
    const d = screen.getDisplayMatching(f);
    this.beside = besideControl(f, this.settings().size, d.workArea, this.keepOff(d));
    return this.beside;
  }

  /** Called by IPC when a renderer reports where its task cards are. */
  setCards(sender: Electron.WebContents, r: Rect | null): void {
    for (const o of this.overlays.values()) if (o.win.webContents === sender) o.cards = r;
    // Cards that came up over where Ember holds still beside a control: it moves off them (only then: a question's
    // buttons move with it).
    const f = this.state.focus;
    const off = f && this.beside ? this.keepOff(screen.getDisplayMatching(f)) : null;
    if (f && this.beside && off && overlapsBody(this.beside, this.settings().size * 0.6, off)) this.follower.park(this.besideFocus(f));
  }

  /**
   * What Ember keeps off on `display`: its handle (when it is there) and that display's task cards stacked above it
   * (one area: they touch), within the display's work area. Each display draws its own cards: one area round every
   * display's would be a band across the desktop that Ember could not follow the cursor into.
   */
  private keepOff(display: Pick<Display, "id" | "workArea">): Rect | null {
    const a = display.workArea;
    const clip = (r: Rect | null | undefined): Rect | null => {
      if (!r) return null;
      const x = Math.max(r.x, a.x), y = Math.max(r.y, a.y);
      const width = Math.min(r.x + r.width, a.x + a.width) - x, height = Math.min(r.y + r.height, a.y + a.height) - y;
      return width > 0 && height > 0 ? { x, y, width, height } : null;
    };
    const r = clip(this.avoid?.());
    const c = clip([...this.overlays.values()].find(o => o.display.id === display.id)?.cards);
    if (!r || !c) return r ?? c;
    const x = Math.min(r.x, c.x), y = Math.min(r.y, c.y);
    return { x, y, width: Math.max(r.x + r.width, c.x + c.width) - x, height: Math.max(r.y + r.height, c.y + c.height) - y };
  }

  /** Called by IPC when a renderer reports where its clickable parts are. */
  setInteractive(sender: Electron.WebContents, rects: Rect[]): void {
    for (const o of this.overlays.values()) if (o.win.webContents === sender) {
      o.interactive = rects;
      this.applyHits(o);
    }
    this.log.debug("overlay.interactive", { rects });
  }

  /**
   * Clicks hit only the reported rectangles. On X11 that is the window's ShapeInput (so a press on Allow or Stop
   * is the overlay's even if hover polling has not run yet). Without a shape (Windows, macOS), hover-to-interact.
   */
  private applyHits(o: Overlay): void {
    if (o.win.isDestroyed()) return;
    const rects = this.borrowing ? [] : o.interactive;
    const hit = rects.length > 0;
    const scale = o.display.scaleFactor || 1;
    if (hit && this.shaper.setInputRegion(o.win, rects, scale)) {
      if (o.clickThrough) {
        o.win.setIgnoreMouseEvents(false);
        o.clickThrough = false;
        // setIgnoreMouseEvents(false) restores a full input region: put the holes back. Only then: the reports
        // come every frame while Ember flies, and an already shaped window needs the one request above.
        this.shaper.setInputRegion(o.win, rects, scale);
      }
      o.shaped = true;
      return;
    }
    o.shaped = false;
    if (!hit && !o.clickThrough) {
      o.clickThrough = true;
      this.passThrough(o.win);
    }
  }

  /**
   * Clicks go through `win` to what is under it. macOS forwards the pointer's moves meanwhile (the renderer sees
   * hover); Linux and Windows take no options, as always (on Windows `forward` would hook every app's mouse).
   */
  private passThrough(win: BrowserWindow): void {
    if (this.shaper.forward) win.setIgnoreMouseEvents(true, { forward: true });
    else win.setIgnoreMouseEvents(true);
  }

  owns(sender: Electron.WebContents): boolean {
    for (const o of this.overlays.values()) if (o.win.webContents === sender) return true;
    return false;
  }

  private initFor(o: Overlay): OverlayInit {
    const h = this.avoid?.() ?? null;
    const b = o.display.bounds;
    const here = !!h && h.x < b.x + b.width && h.x + h.width > b.x && h.y < b.y + b.height && h.y + h.height > b.y;
    return { displayId: o.display.id, bounds: b, workArea: o.display.workArea, settings: this.settings(), fallback: false, handle: here ? h : null };
  }

  /** The handle moved (another screen layout): every overlay is told where it is now. */
  private handleAt = "";
  private checkHandle(): void {
    const at = JSON.stringify(this.avoid?.() ?? null);
    if (at === this.handleAt) return;
    this.handleAt = at;
    for (const o of this.overlays.values()) if (!o.win.isDestroyed() && !o.win.webContents.isLoading()) o.win.webContents.send(OVERLAY.init, this.initFor(o));
  }

  private create(display: Display): void {
    if (this.overlays.has(display.id)) return;
    const floating = this.shaper.floating("overlay");
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
      ...floating.options,
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
    applyAllWorkspaces(win, floating.allWorkspaces);
    this.passThrough(win);
    const overlay: Overlay = { win, display, interactive: [], clickThrough: true, shaped: false, cards: null };
    this.overlays.set(display.id, overlay);
    // Every load (also after a crash and reload) gets the current picture.
    win.webContents.on("did-finish-load", () => {
      win.webContents.send(OVERLAY.init, this.initFor(overlay));
      win.webContents.send(OVERLAY.state, this.state);
      this.lastFrame = null;
      win.showInactive();
      win.setBounds(display.bounds); // re-apply after map; some WMs adjust on first show
      this.log.info("overlay.shown", { display: display.id, bounds: display.bounds });
    });
    // A crashed overlay must not leave an invisible window that swallows clicks: click-through again, then reload
    // (sooner the first time, more slowly if it keeps crashing).
    revive(win, reason => {
      this.log.warn("overlay.renderer_gone", { display: display.id, reason });
      overlay.interactive = [];
      overlay.clickThrough = true;
      overlay.shaped = false;
      if (!win.isDestroyed()) this.passThrough(win);
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
    if (now - this.lastHandleCheck > 1000) { this.lastHandleCheck = now; this.checkHandle(); }
    const cursor = this.cursor();
    const display = screen.getDisplayNearestPoint(cursor);
    const s = this.settings();
    this.follower.setReducedMotion(s.reduceMotion || this.systemReducedMotion);
    // Out of the settings window's way while the user works in it; out of sight when it fills the screen.
    // A question is never hidden, though: with no room beside the window, Ember asks by the cursor as usual.
    const aside = this.aside ? besideRect(this.aside, s.size, screen.getDisplayMatching(this.aside).workArea, this.aside.y + 90) : null;
    const asking = this.state.bubble.visible && this.state.bubble.actions.length > 0;
    const ember = aside
      ? this.follower.step(aside, dt, true)
      : this.follower.step(followTarget(cursor, s.size, display.workArea, this.keepOff(display)), dt);
    // Which display Ember is on (only its overlay shows the bubble; each display it straddles draws its body).
    const on = screen.getDisplayNearestPoint({ x: Math.round(ember.x), y: Math.round(ember.y) }).id;
    const frame = { ember, cursor, visible: !this.hidden && !(this.aside && !aside && !asking), on };
    // Nothing moved: no message (the renderers keep the last frame); a heartbeat each second keeps them in step.
    const p = this.lastFrame;
    const still = !!p && p.visible === frame.visible && p.on === on && Math.abs(p.ember.x - ember.x) < 0.25 && Math.abs(p.ember.y - ember.y) < 0.25
      && p.cursor.x === cursor.x && p.cursor.y === cursor.y && now - p.at < 1000;
    if (!still) this.lastFrame = { ...frame, ember: { ...ember }, at: now };

    for (const o of this.overlays.values()) {
      if (o.win.isDestroyed()) continue;
      if (!still) o.win.webContents.send(OVERLAY.frame, frame);
      // ShapeInput already delivers presses on the buttons. Hover-to-interact is the way where a shape could not
      // be set (Windows, macOS, no X, a test double): a press that starts while still click-through still goes
      // through, which is why live clicks on Allow/Stop missed the overlay on X11 until the shape was used.
      if (o.shaped) continue;
      const local = { x: cursor.x - o.display.bounds.x, y: cursor.y - o.display.bounds.y };
      const over = !this.borrowing && takesPointer(!o.clickThrough, contains(o.display.bounds, cursor) ? local : null, o.interactive, cursor.buttons ?? 0);
      if (over === o.clickThrough) {
        o.clickThrough = !over;
        if (over) o.win.setIgnoreMouseEvents(false); else this.passThrough(o.win);
        this.log.debug("overlay.clickthrough", { display: o.display.id, clickThrough: !over });
      }
    }
  }
}
