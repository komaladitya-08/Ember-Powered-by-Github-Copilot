/**
 * The desk mini-view: a small always-on-top window in the corner showing
 * Ember's desk live (about 4 frames a second). "Take over" enlarges it and
 * sends the user's mouse and keys to the desk; Ember stops acting there until
 * the user hands it back (button, Ctrl+Alt+End, or the kill switch).
 */

import { BrowserWindow, ipcMain, screen } from "electron";
import path from "node:path";
import { DESK, type DeskInput } from "../../shared/desk";
import { SHORTCUT_MODIFIERS, planKey } from "./keys";
import type { DeskPlace } from "./place";
import type { Logger } from "../logger";
import { x11WindowId } from "../platform/linux/window-system";
import { revive } from "../revive";
import { pageUrl } from "../page-url";

const appDir = path.join(__dirname);
/** The view at the default text size: its 30 px bar (BAR) over a 16:10 picture. */
const SMALL = { width: 340, height: 238 };
const LARGE = { width: 980, height: 646 };
/** The bar's height at the default text size (renderer/desk/styles.css): it grows with the text size, the picture doesn't. */
const BAR = 30;
/** Gap to the screen's edges. */
const EDGE = 16;
/** Gap kept between the view and Ember's handle beside it. */
const HANDLE_GAP = 12;

interface Box { x: number; y: number; width: number; height: number }

/** Ember's handle when nothing says where it is: the 200 × 56 pill, 12 px in from the bottom-right corner. */
const pillIn = (wa: Box): Box => ({ x: wa.x + wa.width - 212, y: wa.y + wa.height - 68, width: 200, height: 56 });

/** Ember's handle on this work area (`handle`, global DIP); the pill's usual place when not known or on another screen. */
const handleOn = (wa: Box, handle?: Box | null): Box =>
  handle && handle.x < wa.x + wa.width && handle.x + handle.width > wa.x && handle.y < wa.y + wa.height && handle.y + handle.height > wa.y
    ? handle : pillIn(wa);
/** The handle is in the work area's bottom-left corner (Handle position, review #75). */
const handleLeft = (wa: Box, handle?: Box | null): boolean => { const h = handleOn(wa, handle); return h.x + h.width / 2 < wa.x + wa.width / 2; };
/** `b` mirrored across the middle of the work area. */
const mirrored = (b: Box, wa: Box): Box => ({ ...b, x: 2 * wa.x + wa.width - b.x - b.width });

/**
 * The view's bounds at its small or large size, from where it is now (`b`): it grows and shrinks from its
 * bottom-left corner, as large as the work area allows (same shape, left of Ember's handle in the corner:
 * the pill, or the 360 px card without a compositor), and its bottom edge is always on screen. With the handle in the
 * bottom-left corner, all of that mirrored: right of the handle, growing from its bottom-right corner.
 * `handle`: the handle's bounds (global DIP); the pill's place when not known or on another screen.
 * `textScale`: the text's scale (page-prefs.ts textScale; 1 when it can't be read): the bar is taller by it.
 */
export function deskViewBounds(b: Box, large: boolean, wa: Box, handle?: Box | null, textScale = 1): Box {
  const h = handleOn(wa, handle);
  if (handleLeft(wa, h)) return mirrored(deskViewBounds(mirrored(b, wa), large, wa, mirrored(h, wa), textScale), wa);
  const usual = large ? LARGE : SMALL;
  // The bar's words grow with the text size: the window grows by the bar, so the picture under it keeps its size.
  const text = Number.isFinite(textScale) && textScale > 0 ? textScale : 1;
  const want = { width: usual.width, height: usual.height + Math.max(0, Math.round(BAR * text) - BAR) };
  const scale = Math.min(1, (h.x - HANDLE_GAP - wa.x - EDGE) / want.width, (wa.height - 2 * EDGE) / want.height);
  const width = Math.max(1, Math.round(want.width * scale)), height = Math.max(1, Math.round(want.height * scale));
  const bottom = Math.min(Math.max(b.y + b.height, wa.y + height + EDGE), wa.y + wa.height - EDGE);
  const y = bottom - height;
  // Level with the handle, the view stays left of it (its buttons are where a dialog's OK and Cancel are).
  const level = y < h.y + h.height + HANDLE_GAP && bottom > h.y - HANDLE_GAP;
  const right = level ? h.x - HANDLE_GAP : wa.x + wa.width;
  return { width, height, x: Math.max(wa.x, Math.min(b.x, right - width)), y };
}

/** Where a new view starts (`b` for deskViewBounds): the bottom corner away from Ember's handle and its task cards. */
export function deskViewStart(wa: Box, handle?: Box | null): Box {
  const start = { x: wa.x + EDGE, y: wa.y, width: 0, height: wa.height };
  return handleLeft(wa, handle) ? mirrored(start, wa) : start;
}
/** How long the view stays up after the last desk task ends, so the user sees the result. */
const LINGER_MS = 10_000;
/** Spare keys lent to the user's characters get their nothing back this long after hand back (an app may still be reading them). */
const RESTORE_KEYS_MS = 2000;
/**
 * With Ctrl+Alt held, these keys hand the desk back (the way out by keyboard, as Tab and Esc go to the desk).
 * GNOME keeps Ctrl+Alt+Esc for itself (switch system controls), so End is the one the view shows.
 */
const HAND_BACK = /^(End|Escape)$/;

/** Browser KeyboardEvent.key → X keysym for keys pressed as they are (see keys.ts); 0 for characters and keys the desk doesn't get. */
export function keysymFor(key: string, lookup: (name: string) => number, code = ""): number {
  const plan = planKey(key, code, true, lookup);
  return plan?.sym ?? 0;
}

/** MouseEvent.button → X button: left, middle, right, then back and forward (8 and 9 in X). 0 for others. */
export function xButton(button: number): number {
  return [1, 2, 3, 8, 9][button] ?? 0;
}

/** Wheel direction → X buttons: 4/5 scroll up/down, 6/7 left/right. Nothing for no movement. */
export function wheelButtons(dx: number, dy: number): number[] {
  return [...(dy ? [dy > 0 ? 5 : 4] : []), ...(dx ? [dx > 0 ? 7 : 6] : [])];
}

/** A key the user holds on the desk: its keycode, and whether it is a Shift or a shortcut modifier. */
interface Held { code: number; kind: "shift" | "shortcut" | "key" }

export class DeskView {
  private win: BrowserWindow | null = null;
  private timer: NodeJS.Timeout | null = null;
  private hideTimer: NodeJS.Timeout | null = null;
  private restoreTimer: NodeJS.Timeout | null = null;
  private place: DeskPlace | null = null;
  private control = false;
  /** Ember is moving the user's own mouse (tier 3): the view lets clicks through and can't be taken over. */
  private driving = false;
  private busy = false;
  /** Desk tasks working now, per desk: the view stays up while any works on the desk it shows. */
  private users = new Map<DeskPlace, number>();
  /** What the user holds down on the desk while in control (physical key → keycode, X buttons), let go on hand back. */
  private keys = new Map<string, Held>();
  private buttons = new Set<number>();
  /** Keys were lent to characters the desk's keyboard lacks: they get their nothing back later. */
  private lentKeys = false;
  /** Gives the keyboard back to where the user was before taking over (see `userFocus`). */
  private focusBack: (() => void) | null = null;
  /** The text's scale the window was last sized for (fitText resizes it when the setting changes). */
  private sizedFor = 1;

  /**
   * `handleBounds`: where Ember's handle is now (global DIP), so the view keeps clear of it (the card without a
   * compositor is wider than the pill); the pill's place when not given.
   * `userFocus`: called as the user takes over; what it returns gives the keyboard back to their window on hand back,
   * when the view still has it.
   * `windowId`: the view's id in the window system's id space (default: its X id), 0 when it can't be told.
   * `textScale`: the text's scale now (page-prefs.ts textScale; default 1): the bar grows with it (review #57).
   */
  constructor(private log: Logger, private onControl: (userInControl: boolean) => void = () => undefined,
    private o: {
      lingerMs?: number; handleBounds?: () => Box | null; userFocus?: () => () => void; windowId?: (w: BrowserWindow) => number;
      textScale?: () => number;
    } = {}) {
    ipcMain.on(DESK.takeOver, e => { if (this.owns(e.sender) && !this.driving) this.setControl(true); });
    ipcMain.on(DESK.handBack, e => { if (this.owns(e.sender)) this.setControl(false); });
    ipcMain.on(DESK.hide, e => { if (this.owns(e.sender) && !this.driving) this.hide(); });
    ipcMain.on(DESK.release, e => { if (this.owns(e.sender)) this.releaseAll(); });
    ipcMain.on(DESK.input, (e, input: DeskInput) => { if (this.owns(e.sender) && this.control && !this.driving) this.forward(input); });
  }

  /** True while the user is using the desk: Ember must not act there. */
  get userInControl(): boolean {
    return this.control;
  }

  /**
   * Ember starts (true) or stops (false) moving the user's own mouse and keys. Meanwhile the view
   * lets every click through (a borrowed click must never land on it) and can't be taken over.
   */
  setDriving(on: boolean): void {
    this.driving = on;
    if (on) this.releaseAll();
    if (this.win && !this.win.isDestroyed()) this.win.setIgnoreMouseEvents(on);
  }

  /** A desk task is working on `place`: show the view. It stays up while any desk task works there (see leave()). */
  show(place: DeskPlace): void {
    if (place.dead) return;
    this.users.set(place, (this.users.get(place) ?? 0) + 1);
    this.clearHide();
    if (this.place !== place) {
      this.releaseAll();
      this.place = place;
      place.onDead(() => this.lost(place));
    }
    if (!this.win || this.win.isDestroyed()) {
      const wa = screen.getPrimaryDisplay().workArea;
      const handle = this.handle();
      this.handleWasLeft = this.handleIsLeft(handle);
      const win = new BrowserWindow({
        // Bottom-left: the bottom-right corner is Ember's handle and its task cards (the other way round when Handle
        // position puts them in the bottom left).
        ...this.boundsFor(deskViewStart(wa, handle), false, wa, handle),
        frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true, show: false, title: "Ember's desk",
        backgroundColor: "#000000",
        webPreferences: { preload: path.join(appDir, "preload", "desk.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
      });
      this.win = win;
      win.setAlwaysOnTop(true, "screen-saver");
      if (this.driving) win.setIgnoreMouseEvents(true);
      void win.loadURL(pageUrl(path.join(appDir, "renderer", "desk", "index.html")));
      // Shown without focus so it never takes the user's keys; it is focusable so
      // "Take over" can give it the keyboard (a non-focusable X window can't get it later).
      win.once("ready-to-show", () => { if (!win.isDestroyed()) win.showInactive(); });
      // Keys and buttons held when the view loses the keyboard would stay down on the desk.
      win.on("blur", () => this.releaseAll());
      // A crashed page lets go of what it held and loads again (review #91).
      revive(win, () => { this.releaseAll(); this.setControl(false); });
      win.on("closed", () => {
        if (this.win === win) this.win = null;
        this.stopFrames();
        this.setControl(false);
      });
    } else {
      this.win.showInactive();
    }
    this.startFrames();
  }

  /**
   * A desk task finished (or left the desk): once none works on the desk shown and the user isn't using it,
   * hide a little later. `place`: the desk it worked on; a desk that is gone (or not shown) doesn't count.
   */
  leave(place: DeskPlace | null = this.place): void {
    if (!place) return;
    const n = this.users.get(place);
    if (n === undefined) return;
    if (n > 1) this.users.set(place, n - 1); else this.users.delete(place);
    if (place === this.place) this.armHide();
  }

  hide(): void {
    this.setControl(false);
    this.clearHide();
    this.stopFrames();
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  /** The handle was in the bottom-left corner when the view was last placed for it. */
  private handleWasLeft = false;

  /**
   * Ember's handle changed (the pill became the card or back): the view keeps clear of it at its size now. When the
   * handle went to the other side (Handle position) on the display the view is on, the view goes to the side it left,
   * keeping its bottom edge; on another display (the user dragged it there) it stays where it is.
   */
  handleMoved(): void {
    const win = this.win && !this.win.isDestroyed() ? this.win : null;
    if (!win) return;
    const b = win.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const handle = this.handle();
    const left = this.handleIsLeft(handle);
    const across = left !== this.handleWasLeft && handleOn(wa, handle) === handle;
    const from = across ? { ...deskViewStart(wa, handle), y: b.y, height: b.height } : b;
    this.handleWasLeft = left;
    const next = this.boundsFor(from, this.control, wa, handle);
    if (next.x !== b.x || next.y !== b.y || next.width !== b.width || next.height !== b.height) win.setBounds(next);
  }

  /**
   * The text size may have changed (main calls this whenever the settings do): the view, open or hidden, grows or
   * shrinks by its bar from its foot. Left where it is when the size is the one it has (the user may have moved it).
   */
  fitText(): void {
    if (this.scale() !== this.sizedFor) this.handleMoved();
  }

  private handle(): Box | null {
    try { return this.o.handleBounds?.() ?? null; } catch { return null; }
  }

  /** The text's scale now (the default's 1 when it can't be told). */
  private scale(): number {
    try {
      const s = this.o.textScale?.() ?? 1;
      return Number.isFinite(s) && s > 0 ? s : 1;
    } catch { return 1; }
  }

  /** deskViewBounds at the text size now, which the window is then sized for (`handle`: where the handle is now). */
  private boundsFor(b: Box, large: boolean, wa: Box, handle: Box | null = this.handle()): Box {
    this.sizedFor = this.scale();
    return deskViewBounds(b, large, wa, handle, this.sizedFor);
  }

  /** The handle is in the bottom-left corner of its own display's work area (false when not known). */
  private handleIsLeft(handle: Box | null): boolean {
    if (!handle) return false;
    try { return handleLeft(screen.getDisplayMatching(handle).workArea, handle); } catch { return false; }
  }

  /** Gives the desk back to Ember (the kill switch calls this too). */
  handBack(): void {
    this.setControl(false);
  }

  /** Whether window `id` is the view's window (never for 0: an id that can't be told is no window). */
  isWindow(id: number): boolean {
    if (id === 0 || !this.win || this.win.isDestroyed()) return false;
    try { return (this.o.windowId ?? x11WindowId)(this.win) === id; } catch { return false; }
  }

  owns(sender: Electron.WebContents): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.webContents === sender;
  }

  private setControl(on: boolean): void {
    const win = this.win && !this.win.isDestroyed() ? this.win : null;
    if (!win || !this.place || this.place.dead || this.driving) on = false;
    if (!on) this.releaseAll();
    const changed = this.control !== on;
    this.control = on;
    if (changed) {
      this.log.info("desk.control", { user: on });
      this.onControl(on);
      if (on) this.clearRestore(); else this.armRestore();
    }
    const focusBack = changed && !on ? this.focusBack : null;
    if (!on) this.focusBack = null;
    if (!win) return;
    if (changed) {
      const b = win.getBounds();
      // Grows up and to the right from its bottom-left corner, as large as the screen allows, staying on it.
      win.setBounds(this.boundsFor(b, on, screen.getDisplayMatching(b).workArea));
      if (on) {
        try { this.focusBack = this.o.userFocus?.() ?? null; } catch { this.focusBack = null; }
        win.focus();
      } else if (focusBack && win.isFocused()) {
        // Handed back: the user's next keys go to their own window, not to a view that no longer takes them.
        try { focusBack(); } catch { /* their window may be gone */ }
      }
    }
    // Always, so the view never shows the wrong button (e.g. after it was reopened).
    win.webContents.send(DESK.mode, { control: on });
    if (changed && !on) this.armHide();
  }

  /** The desk died: nothing more is shown or sent there, and the tasks that were on it no longer count. */
  private lost(place: DeskPlace): void {
    this.users.delete(place);
    if (this.place !== place) return;
    this.log.warn("desk.view_lost", {});
    this.lentKeys = false;
    this.clearRestore();
    this.hide();
    this.place = null;
  }

  private armHide(): void {
    this.clearHide();
    const busy = () => (this.place ? this.users.get(this.place) ?? 0 : 0) > 0 || this.control;
    if (busy() || !this.win || this.win.isDestroyed()) return;
    this.hideTimer = setTimeout(() => { this.hideTimer = null; if (!busy()) this.hide(); }, this.o.lingerMs ?? LINGER_MS);
  }

  private clearHide(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  /** Spare keys lent to the user's characters go back a little after hand back. */
  private armRestore(): void {
    this.clearRestore();
    if (!this.lentKeys) return;
    const place = this.place;
    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = null;
      if (this.control || !place || place.dead || place !== this.place) return;
      this.lentKeys = false;
      try { place.keys.restore(); } catch (err) { this.log.debug("desk.restore_keys_failed", { err }); }
    }, RESTORE_KEYS_MS);
  }

  private clearRestore(): void {
    if (this.restoreTimer) clearTimeout(this.restoreTimer);
    this.restoreTimer = null;
  }

  /** Lets go of every key and button the user holds on the desk, so nothing stays pressed there. */
  private releaseAll(): void {
    const keys = [...this.keys.values()].reverse(), buttons = [...this.buttons];
    this.keys.clear();
    this.buttons.clear();
    const input = this.place && !this.place.dead ? this.place.input : null;
    if (!input || (!keys.length && !buttons.length)) return;
    try {
      for (const b of buttons) input.button(b, false);
      for (const k of keys) input.keycode(k.code, false);
    } catch (err) {
      this.log.debug("desk.release_failed", { err });
    }
  }

  /**
   * Types a character the user's keyboard made: its key on the desk, with Shift as that key needs it
   * there, whatever the user holds (Shift+7 on a German keyboard makes "/", which needs no Shift on
   * the desk). Returns the keycode pressed, or 0.
   */
  private typeChar(place: DeskPlace, sym: number): number {
    const k = place.keys.key(sym);
    if (!k) return 0;
    // (Shift makes no difference on a lent key, and on few others.)
    if (k.shift === null) this.lentKeys = true;
    const input = place.input;
    const shifts = [...this.keys.values()].filter(h => h.kind === "shift").map(h => h.code);
    if (k.shift === null || k.shift === shifts.length > 0) {
      input.keycode(k.code, true);
    } else if (k.shift) {
      const shift = input.keycodeOf(input.keysymOf("Shift_L"));
      if (shift) input.keycode(shift, true);
      input.keycode(k.code, true);
      if (shift) input.keycode(shift, false);
    } else {
      for (const s of shifts) input.keycode(s, false);
      input.keycode(k.code, true);
      for (const s of shifts) input.keycode(s, true);
    }
    return k.code;
  }

  private forward(e: DeskInput): void {
    const place = this.place;
    if (!place || place.dead) return;
    const input = place.input;
    const clamp = (x: number, y: number) => ({ x: Math.max(0, Math.min(place.info.width - 1, x)), y: Math.max(0, Math.min(place.info.height - 1, y)) });
    try {
      if (e.type === "move") { const p = clamp(e.x, e.y); input.move(p.x, p.y); }
      else if (e.type === "button") {
        const b = xButton(e.button);
        if (!b || e.down === this.buttons.has(b)) return;
        const p = clamp(e.x, e.y);
        input.move(p.x, p.y);
        input.button(b, e.down);
        if (e.down) this.buttons.add(b); else this.buttons.delete(b);
      } else if (e.type === "wheel") {
        const p = clamp(e.x, e.y);
        input.move(p.x, p.y);
        for (const b of wheelButtons(Math.sign(e.dx ?? 0), Math.sign(e.dy))) { input.button(b, true); input.button(b, false); }
      } else if (e.type === "key") {
        const id = e.code || e.key;
        if (e.down) {
          // Ctrl+Alt+End and Ctrl+Alt+Esc are Ember's own: they hand the desk back and never reach the desk.
          const held = [...this.keys.keys()];
          if (HAND_BACK.test(e.key) && held.some(k => /^Control/.test(k)) && held.some(k => /^Alt/.test(k))) { this.setControl(false); return; }
          const shortcut = [...this.keys.values()].some(h => h.kind === "shortcut");
          const plan = planKey(e.key, e.code, shortcut, n => input.keysymOf(n));
          if (!plan) return;
          const code = plan.kind === "char" ? this.typeChar(place, plan.sym) : input.keycodeOf(plan.sym);
          if (!code) return;
          if (plan.kind === "key") input.keycode(code, true);
          this.keys.set(id, { code, kind: e.key === "Shift" ? "shift" : SHORTCUT_MODIFIERS.has(e.key) ? "shortcut" : "key" });
        } else {
          // The key that went down goes up, by keycode ("A" may come up as "a" once Shift is let go).
          const held = this.keys.get(id);
          this.keys.delete(id);
          if (held) input.keycode(held.code, false);
        }
      }
    } catch (err) {
      this.log.debug("desk.input_failed", { err });
    }
  }

  private startFrames(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.frame(), 250);
  }

  private stopFrames(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One picture of the desk, made by the desk's helper (Ember's thread doesn't wait for it). */
  private async frame(): Promise<void> {
    const place = this.place;
    if (this.busy || !place || !this.win || this.win.isDestroyed() || !this.win.isVisible()) return;
    if (place.dead) { this.stopFrames(); return; }
    this.busy = true;
    try {
      const shot = await place.snapshot(this.control ? 960 : 320, this.control ? 80 : 65);
      if (!shot || place.dead || place !== this.place || !this.win || this.win.isDestroyed()) return;
      this.win.webContents.send(DESK.frame, { url: `data:image/jpeg;base64,${shot.jpeg.toString("base64")}`, width: shot.width, height: shot.height, title: shot.title });
    } catch (err) {
      this.log.debug("desk.frame_failed", { err });
    } finally {
      this.busy = false;
    }
  }
}
