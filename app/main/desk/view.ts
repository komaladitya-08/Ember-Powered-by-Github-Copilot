/**
 * The desk mini-view: a small always-on-top window in the corner showing
 * Ember's desk live (about 4 frames a second). "Take over" enlarges it and
 * sends the user's mouse and keys to the desk; Ember stops acting there until
 * the user hands it back (button, Ctrl+Alt+End, or the kill switch).
 */

import { BrowserWindow, ipcMain, screen } from "electron";
import path from "node:path";
import { createRequire } from "node:module";
import type Sharp from "sharp";
import { DESK, type DeskInput } from "../../shared/desk";
import { bgraToRgba } from "../perception/capture";
import type { DeskPlace } from "./place";
import type { Logger } from "../logger";

const appDir = path.join(__dirname);
const SMALL = { width: 340, height: 238 };
const LARGE = { width: 980, height: 646 };
/** How long the view stays up after the last desk task ends, so the user sees the result. */
const LINGER_MS = 10_000;
/**
 * With Ctrl+Alt held, these keys hand the desk back (the way out by keyboard, as Tab and Esc go to the desk).
 * GNOME keeps Ctrl+Alt+Esc for itself (switch system controls), so End is the one the view shows.
 */
const HAND_BACK = /^(End|Escape)$/;

/** Browser KeyboardEvent.key → X keysym name. */
const KEYS: Record<string, string> = {
  Enter: "Return", Backspace: "BackSpace", Tab: "Tab", Escape: "Escape", " ": "space", Delete: "Delete",
  ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", Home: "Home", End: "End",
  PageUp: "Prior", PageDown: "Next", Control: "Control_L", Shift: "Shift_L", Alt: "Alt_L", Meta: "Super_L", CapsLock: "Caps_Lock",
};

/** `code` (KeyboardEvent.code) picks the right-hand modifier keys (ShiftRight → Shift_R). */
export function keysymFor(key: string, lookup: (name: string) => number, code = ""): number {
  if (KEYS[key]) return lookup(/Right$/.test(code) && KEYS[key].endsWith("_L") ? KEYS[key].replace(/_L$/, "_R") : KEYS[key]);
  if (/^F\d{1,2}$/.test(key)) return lookup(key);
  if (key.length === 1) {
    const c = key.charCodeAt(0);
    if (c >= 0x20 && c <= 0x7e) return c; // Latin-1 keysyms are the character codes
  }
  return 0;
}

/** MouseEvent.button → X button: left, middle, right, then back and forward (8 and 9 in X). 0 for others. */
export function xButton(button: number): number {
  return [1, 2, 3, 8, 9][button] ?? 0;
}

/** Wheel direction → X buttons: 4/5 scroll up/down, 6/7 left/right. Nothing for no movement. */
export function wheelButtons(dx: number, dy: number): number[] {
  return [...(dy ? [dy > 0 ? 5 : 4] : []), ...(dx ? [dx > 0 ? 7 : 6] : [])];
}

export class DeskView {
  private win: BrowserWindow | null = null;
  private timer: NodeJS.Timeout | null = null;
  private hideTimer: NodeJS.Timeout | null = null;
  private place: DeskPlace | null = null;
  private control = false;
  private busy = false;
  private sharp: typeof Sharp | null = null;
  /** Desk tasks working now: the view stays up while any is. */
  private users = 0;
  /** What the user holds down on the desk while in control (physical key → X keycode, X buttons), let go on hand back. */
  private keys = new Map<string, number>();
  private buttons = new Set<number>();

  constructor(private log: Logger, private onControl: (userInControl: boolean) => void = () => undefined, private o: { lingerMs?: number } = {}) {
    ipcMain.on(DESK.takeOver, e => { if (this.owns(e.sender)) this.setControl(true); });
    ipcMain.on(DESK.handBack, e => { if (this.owns(e.sender)) this.setControl(false); });
    ipcMain.on(DESK.hide, e => { if (this.owns(e.sender)) this.hide(); });
    ipcMain.on(DESK.release, e => { if (this.owns(e.sender)) this.releaseAll(); });
    ipcMain.on(DESK.input, (e, input: DeskInput) => { if (this.owns(e.sender) && this.control) this.forward(input); });
  }

  /** True while the user is using the desk: Ember must not act there. */
  get userInControl(): boolean {
    return this.control;
  }

  /** A desk task is working there: show the view. It stays up while any desk task works (see leave()). */
  show(place: DeskPlace): void {
    if (place.dead) return;
    this.users++;
    this.clearHide();
    if (this.place !== place) {
      this.releaseAll();
      this.place = place;
      place.onDead(() => this.lost(place));
    }
    if (!this.win || this.win.isDestroyed()) {
      const wa = screen.getPrimaryDisplay().workArea;
      const win = new BrowserWindow({
        ...SMALL, x: wa.x + wa.width - SMALL.width - 16, y: wa.y + wa.height - SMALL.height - 80,
        frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true, show: false, title: "Ember's desk",
        backgroundColor: "#1a0f0b",
        webPreferences: { preload: path.join(appDir, "preload", "desk.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
      });
      this.win = win;
      win.setAlwaysOnTop(true, "screen-saver");
      void win.loadFile(path.join(appDir, "renderer", "desk", "index.html"));
      // Shown without focus so it never takes the user's keys; it is focusable so
      // "Take over" can give it the keyboard (a non-focusable X window can't get it later).
      win.once("ready-to-show", () => { if (!win.isDestroyed()) win.showInactive(); });
      // Keys and buttons held when the view loses the keyboard would stay down on the desk.
      win.on("blur", () => this.releaseAll());
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

  /** A desk task finished (or left the desk): once none works there and the user isn't using it, hide a little later. */
  leave(): void {
    this.users = Math.max(0, this.users - 1);
    this.armHide();
  }

  hide(): void {
    this.setControl(false);
    this.clearHide();
    this.stopFrames();
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  /** Gives the desk back to Ember (the kill switch calls this too). */
  handBack(): void {
    this.setControl(false);
  }

  owns(sender: Electron.WebContents): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.webContents === sender;
  }

  private setControl(on: boolean): void {
    const win = this.win && !this.win.isDestroyed() ? this.win : null;
    if (!win || !this.place || this.place.dead) on = false;
    if (!on) this.releaseAll();
    const changed = this.control !== on;
    this.control = on;
    if (changed) {
      this.log.info("desk.control", { user: on });
      this.onControl(on);
    }
    if (!win) return;
    if (changed) {
      const b = win.getBounds();
      const size = on ? LARGE : SMALL;
      const wa = screen.getDisplayMatching(b).workArea;
      win.setBounds({ ...size, x: Math.max(wa.x, b.x + b.width - size.width), y: Math.max(wa.y, b.y + b.height - size.height) });
      if (on) win.focus();
    }
    // Always, so the view never shows the wrong button (e.g. after it was reopened).
    win.webContents.send(DESK.mode, { control: on });
    if (changed && !on) this.armHide();
  }

  /** The desk died: nothing more is shown or sent there. */
  private lost(place: DeskPlace): void {
    if (this.place !== place) return;
    this.log.warn("desk.view_lost", {});
    this.users = 0;
    this.hide();
    this.place = null;
  }

  private armHide(): void {
    this.clearHide();
    if (this.users > 0 || this.control || !this.win || this.win.isDestroyed()) return;
    this.hideTimer = setTimeout(() => { this.hideTimer = null; if (!this.users && !this.control) this.hide(); }, this.o.lingerMs ?? LINGER_MS);
  }

  private clearHide(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
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
      for (const code of keys) input.keycode(code, false);
    } catch (err) {
      this.log.debug("desk.release_failed", { err });
    }
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
          const code = input.keycodeOf(keysymFor(e.key, n => input.keysymOf(n), e.code));
          if (!code) return;
          input.keycode(code, true);
          this.keys.set(id, code);
        } else {
          // The key that went down goes up, by keycode ("A" may come up as "a" once Shift is let go).
          const code = this.keys.get(id) ?? input.keycodeOf(keysymFor(e.key, n => input.keysymOf(n), e.code));
          this.keys.delete(id);
          if (code) input.keycode(code, false);
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

  private async frame(): Promise<void> {
    const place = this.place;
    if (this.busy || !place || !this.win || this.win.isDestroyed() || !this.win.isVisible()) return;
    if (place.dead) { this.stopFrames(); return; }
    this.busy = true;
    try {
      const { info, x11 } = place;
      const img = x11.capture(0, 0, info.width, info.height);
      if (!img) return;
      this.sharp ??= createRequire(__filename)("sharp") as typeof Sharp;
      const width = this.control ? 960 : 320;
      const jpg = await this.sharp(bgraToRgba(img.bgra), { raw: { width: img.width, height: img.height, channels: 4 } })
        .resize(width).jpeg({ quality: this.control ? 80 : 65 }).toBuffer();
      if (place.dead || !this.win || this.win.isDestroyed()) return;
      const active = x11.activeWindow();
      this.win.webContents.send(DESK.frame, { url: `data:image/jpeg;base64,${jpg.toString("base64")}`, width: info.width, height: info.height, title: active?.title ?? "" });
    } catch (err) {
      this.log.debug("desk.frame_failed", { err });
    } finally {
      this.busy = false;
    }
  }
}
