/**
 * The desk mini-view: a small always-on-top window in the corner showing
 * Ember's desk live (about 4 frames a second). "Take over" enlarges it and
 * sends the user's mouse and keys to the desk; Ember stops acting there until
 * the user hands it back.
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

/** Browser KeyboardEvent.key → X keysym name. */
const KEYS: Record<string, string> = {
  Enter: "Return", Backspace: "BackSpace", Tab: "Tab", Escape: "Escape", " ": "space", Delete: "Delete",
  ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", Home: "Home", End: "End",
  PageUp: "Prior", PageDown: "Next", Control: "Control_L", Shift: "Shift_L", Alt: "Alt_L", Meta: "Super_L", CapsLock: "Caps_Lock",
};

export function keysymFor(key: string, lookup: (name: string) => number): number {
  if (KEYS[key]) return lookup(KEYS[key]);
  if (/^F\d{1,2}$/.test(key)) return lookup(key);
  if (key.length === 1) {
    const c = key.charCodeAt(0);
    if (c >= 0x20 && c <= 0x7e) return c; // Latin-1 keysyms are the character codes
  }
  return 0;
}

export class DeskView {
  private win: BrowserWindow | null = null;
  private timer: NodeJS.Timeout | null = null;
  private place: DeskPlace | null = null;
  private control = false;
  private busy = false;
  private sharp: typeof Sharp | null = null;

  constructor(private log: Logger, private onControl: (userInControl: boolean) => void = () => undefined) {
    ipcMain.on(DESK.takeOver, e => { if (this.owns(e.sender)) this.setControl(true); });
    ipcMain.on(DESK.handBack, e => { if (this.owns(e.sender)) this.setControl(false); });
    ipcMain.on(DESK.hide, e => { if (this.owns(e.sender)) this.hide(); });
    ipcMain.on(DESK.input, (e, input: DeskInput) => { if (this.owns(e.sender) && this.control) this.forward(input); });
  }

  /** True while the user is using the desk: Ember must not act there. */
  get userInControl(): boolean {
    return this.control;
  }

  show(place: DeskPlace): void {
    this.place = place;
    if (!this.win || this.win.isDestroyed()) {
      const wa = screen.getPrimaryDisplay().workArea;
      this.win = new BrowserWindow({
        ...SMALL, x: wa.x + wa.width - SMALL.width - 16, y: wa.y + wa.height - SMALL.height - 80,
        frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true, show: false, title: "Ember's desk",
        backgroundColor: "#1a0f0b",
        webPreferences: { preload: path.join(appDir, "preload", "desk.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
      });
      this.win.setAlwaysOnTop(true, "screen-saver");
      void this.win.loadFile(path.join(appDir, "renderer", "desk", "index.html"));
      // Shown without focus so it never takes the user's keys; it is focusable so
      // "Take over" can give it the keyboard (a non-focusable X window can't get it later).
      this.win.once("ready-to-show", () => this.win?.showInactive());
      this.win.on("closed", () => { this.win = null; this.stopFrames(); });
    } else {
      this.win.showInactive();
    }
    this.startFrames();
  }

  hide(): void {
    this.setControl(false);
    this.stopFrames();
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  owns(sender: Electron.WebContents): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.webContents === sender;
  }

  private setControl(on: boolean): void {
    if (!this.win || this.win.isDestroyed()) { this.control = false; return; }
    if (this.control === on) return;
    this.control = on;
    this.log.info("desk.control", { user: on });
    this.onControl(on);
    const b = this.win.getBounds();
    const size = on ? LARGE : SMALL;
    const wa = screen.getDisplayMatching(b).workArea;
    this.win.setBounds({ ...size, x: Math.max(wa.x, b.x + b.width - size.width), y: Math.max(wa.y, b.y + b.height - size.height) });
    if (on) this.win.focus();
    this.win.webContents.send(DESK.mode, { control: on });
  }

  private forward(e: DeskInput): void {
    const input = this.place?.input;
    if (!input) return;
    const clamp = (x: number, y: number) => ({ x: Math.max(0, Math.min(this.place!.info.width - 1, x)), y: Math.max(0, Math.min(this.place!.info.height - 1, y)) });
    if (e.type === "move") { const p = clamp(e.x, e.y); input.move(p.x, p.y); }
    else if (e.type === "button") { const p = clamp(e.x, e.y); input.move(p.x, p.y); input.button(Math.min(3, Math.max(1, e.button)), e.down); }
    else if (e.type === "wheel") { const p = clamp(e.x, e.y); input.move(p.x, p.y); const b = e.dy > 0 ? 5 : 4; input.button(b, true); input.button(b, false); }
    else if (e.type === "key") { const sym = keysymFor(e.key, n => input.keysymOf(n)); if (sym) input.keysym(sym, e.down); }
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
    if (this.busy || !this.place || !this.win || this.win.isDestroyed() || !this.win.isVisible()) return;
    this.busy = true;
    try {
      const { info, x11 } = this.place;
      const img = x11.capture(0, 0, info.width, info.height);
      if (!img) return;
      this.sharp ??= createRequire(__filename)("sharp") as typeof Sharp;
      const width = this.control ? 960 : 320;
      const jpg = await this.sharp(bgraToRgba(img.bgra), { raw: { width: img.width, height: img.height, channels: 4 } })
        .resize(width).jpeg({ quality: this.control ? 80 : 65 }).toBuffer();
      const active = x11.activeWindow();
      this.win.webContents.send(DESK.frame, { url: `data:image/jpeg;base64,${jpg.toString("base64")}`, width: info.width, height: info.height, title: active?.title ?? "" });
    } catch (err) {
      this.log.debug("desk.frame_failed", { err });
    } finally {
      this.busy = false;
    }
  }
}
