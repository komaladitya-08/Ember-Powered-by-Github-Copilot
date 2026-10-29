/**
 * The "Ask Ember" text box (Ctrl+Alt+Space): a focusable pill above Ember (below it near the top of the screen).
 * Without a compositor (xrdp, VNC) a transparent window paints black, so the box is then an opaque panel.
 */

import { BrowserWindow, Menu, screen } from "electron";
import path from "node:path";
import { IPC, type AskContext } from "../shared/ipc";
import type { OS } from "../shared/shortcuts";
import type { FloatingWindow } from "./platform/types";
import { applyAllWorkspaces } from "./platform/compose";
import { x11WindowId } from "./platform/linux/window-system";
import { pageUrl } from "./page-url";

const appDir = __dirname;
/** The box at the default text size. */
const SIZE = { width: 560, height: 92 };
/**
 * Of its 92 px, what grows with the text size (Settings > Comfort & access): the field's line (46 px) and the line under
 * it (17 px); the insets, the gap between them and that line's padding (29 px) keep theirs (renderer/ask/styles.css).
 */
const GROWS = 46 + 17;
/**
 * The field grows a line at a time (its line height, at the text size), up to MAX_LINES, as the user types or pastes
 * several lines; the note that a paste was cut and the tip to wait for the box take one more row of the same height
 * each (MAX_ROWS).
 */
const LINE = 24, MAX_LINES = 4, MAX_ROWS = MAX_LINES + 2;
/** The openings that say to wait for the box before typing, where Ember can't hold the letters typed meanwhile (review #78). */
export const WAIT_TIP_OPENINGS = 5;

/**
 * Whether this opening says to wait for the box before typing: only where Ember can't hold the letters typed while it
 * opens (`holds`: Linux's keyboard hold), and only until it has opened WAIT_TIP_OPENINGS times there (`opened`).
 */
export function showsWaitTip(holds: boolean, opened: number): boolean {
  return !holds && opened < WAIT_TIP_OPENINGS;
}
/** Ember's size when the caller doesn't say (the default setting). */
const EMBER_SIZE = 60;
/** Gap to the work area's edges and to Ember's handle. */
const GAP = 8;
/** A box asked for that is still loading after this long isn't shown (the user has moved on: their keys went elsewhere). */
const LATE_MS = 1500;
/**
 * After the field's right-click menu closes, how long the OS has to say where the keyboard went (a click on another app
 * that dismissed the menu activates that app) before the box takes it back or goes away.
 */
const MENU_SETTLE_MS = 120;

type Box = { x: number; y: number; width: number; height: number };

/** A text scale as given (page-prefs.ts textScale: 1, 1.15 or 1.3), or the default's 1 when it can't be read. */
const scaleOf = (scale: number): number => (Number.isFinite(scale) && scale > 0 ? scale : 1);

/**
 * The box's size at the text's scale (`scale`: page-prefs.ts textScale), one line tall: as wide as its words grow, and
 * as tall as its field and the line under it at that size (560 × 92 at the default size, 644 × 101 at Large and
 * 728 × 111 at Larger).
 */
export function askSize(scale = 1): { width: number; height: number } {
  const s = scaleOf(scale);
  return { width: Math.round(SIZE.width * s), height: Math.round(SIZE.height + GROWS * (s - 1)) };
}

/** The box's size at `scale` on work area `wa`: no wider than it (with its gaps), never narrower than the usual box. */
function sizeIn(wa: Box, scale: number): { width: number; height: number } {
  const size = askSize(scale);
  return { ...size, width: Math.max(SIZE.width, Math.min(size.width, wa.width - 2 * GAP)) };
}

const overlap = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/**
 * Where the box goes (global DIP): centred over Ember (`near`: its centre, and its size in px), with its hint row
 * clear of Ember's head; below Ember when there's no room above (Ember near the top of the screen); without
 * `near`, low in the middle of the work area. Always inside the work area, and clear of `keepOff` (Ember's
 * handle in the corner): above it, else beside it. `scale`: the text's (askSize).
 */
export function askBounds(near: { x: number; y: number; size?: number } | null, wa: Box, keepOff?: Box | null, scale = 1): Box {
  const box = sizeIn(wa, scale);
  const size = near?.size ?? EMBER_SIZE;
  const top = wa.y + GAP, bottom = wa.y + wa.height - box.height - GAP;
  const left = wa.x + GAP, right = wa.x + wa.width - box.width - GAP;
  let y = wa.y + wa.height - box.height - 90;
  if (near) {
    const above = near.y - box.height - Math.max(18, size * 0.5 - 8);
    const below = near.y + size * 0.6;
    y = above >= top || below > bottom ? above : below;
  }
  const x = near ? near.x - box.width / 2 : wa.x + (wa.width - box.width) / 2;
  const b = { ...box, x: Math.round(Math.min(Math.max(x, left), right)), y: Math.round(Math.min(Math.max(y, top), bottom)) };
  return clearOf(b, wa, keepOff);
}

/** `b` moved off `keepOff` when over it: up above it (Ember is under the box, so this keeps clear of it too), else to its left. */
function clearOf(b: Box, wa: Box, keepOff?: Box | null): Box {
  if (!keepOff || !overlap(b, keepOff)) return b;
  const up = Math.round(keepOff.y - b.height - GAP);
  if (up >= wa.y + GAP) return { ...b, y: up };
  const aside = Math.round(keepOff.x - b.width - GAP);
  return aside >= wa.x + GAP ? { ...b, x: aside } : b;
}

/**
 * `b` (the box now) as tall as `rows` rows (1 to MAX_ROWS: the field's lines, the note's when a paste was cut, the tip's):
 * growing upward when the box is above Ember (`up`, its hint row stays put beside Ember's head), else downward; always
 * inside the work area and clear of `keepOff`. `scale`: the text's (askSize), by which each row is taller too.
 */
export function grownBounds(b: Box, rows: number, wa: Box, up: boolean, keepOff?: Box | null, scale = 1): Box {
  const extra = Math.min(MAX_ROWS, Math.max(1, Math.round(rows))) - 1;
  const height = askSize(scale).height + Math.round(extra * LINE * scaleOf(scale));
  const top = wa.y + GAP, bottom = wa.y + wa.height - height - GAP;
  const y = up ? b.y + b.height - height : b.y;
  return clearOf({ ...b, height, y: Math.round(Math.max(top, Math.min(y, bottom))) }, wa, keepOff);
}

/** What the field's right-click menu may do now (Electron's context-menu editFlags). */
export interface EditFlags {
  canCut: boolean;
  canCopy: boolean;
  canPaste: boolean;
  canSelectAll: boolean;
}

/** The field's right-click menu: Cut, Copy, Paste and Select all, each only when it can act. */
export function editMenuItems(f: EditFlags): Electron.MenuItemConstructorOptions[] {
  return [
    { role: "cut", label: "Cut", enabled: f.canCut },
    { role: "copy", label: "Copy", enabled: f.canCopy },
    { role: "paste", label: "Paste", enabled: f.canPaste },
    { type: "separator" },
    { role: "selectAll", label: "Select all", enabled: f.canSelectAll },
  ];
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
  /** Who asked for the box (hotkey, menu, test): logged when it is actually shown. */
  private source = "unknown";
  /** The box sits above Ember (or low in the middle of the screen): a taller field grows it upward. */
  private up = true;
  /** The field's right-click menu is open: the box keeps its place while the menu has the keyboard. */
  private menuUp = false;
  /** The box lost the keyboard while that menu was up and hasn't had it back since. */
  private menuBlur = false;
  /** Shown, and not yet told by Electron that it has the keyboard (onKeyboard says when it is). */
  private awaitingKeyboard = false;

  /**
   * `keepOff`: Ember's handle in the corner now (global DIP); the box never covers it. `takeFocus`: gives the box,
   * window `id`, the keyboard (on X11 a window manager that prevents focus stealing would leave it with the app the
   * user is in, and their first letters would go there); called on every reveal with whatever `windowId` answered, 0
   * included, and the caller decides what to do with it. `hasFocus`: whether X itself says the box has the keyboard
   * now (Electron can report focus before the window manager has moved it). `onReveal`: every time the box is
   * actually shown (the only path that maps it): live unprompted opens that bypassed `openAsk` show up here.
   * `windowId`: the box's id in the window system's id space (default: its X id), 0 when it can't be told.
   * `floating`: the platform's window options and workspace rule (default: today's Linux window). `os`: the page names
   * its keys as this OS does (Return on a Mac). `onKeyboard`: the first time Electron says the box has the keyboard
   * after each reveal (letters typed before went elsewhere where Ember holds no keys: review #78). `textScale`: the
   * text's scale now (page-prefs.ts textScale; default 1): the box is as large as its words at that size (review #57).
   */
  constructor(private o: {
    keepOff?: () => Box | null; takeFocus?: (id: number) => void; hasFocus?: () => boolean; onReveal?: (source: string) => void;
    windowId?: (w: BrowserWindow) => number; floating?: FloatingWindow; os?: OS; onKeyboard?: () => void; textScale?: () => number;
  } = {}) {}

  /** The id of `win` in the window system's id space; 0 when it can't be told (never an id of another window). */
  private idOf(win: BrowserWindow): number {
    try { return (this.o.windowId ?? x11WindowId)(win); } catch { return 0; }
  }

  /** The text's scale now (the default's 1 when it can't be told; askSize reads a bad one as 1 too). */
  private scale(): number {
    try { return this.o.textScale?.() ?? 1; } catch { return 1; }
  }

  /** Makes the box ahead of time (hidden), so the first Ctrl+Alt+Space opens it at once. */
  prepare(): void {
    if (this.win && !this.win.isDestroyed()) return;
    const display = screen.getPrimaryDisplay();
    this.build(askBounds(null, display.workArea, this.keepOff(), this.scale()));
  }

  private build(bounds: Box): BrowserWindow {
    const opaque = this.builtOpaque = this.opaque;
    this.loaded = false;
    const win = this.win = new BrowserWindow({
      ...bounds,
      transparent: !opaque, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, show: false, hasShadow: false, title: "Ask Ember",
      backgroundColor: opaque ? "#242022" : "#00000000",
      ...(this.o.floating?.options ?? {}),
      webPreferences: {
        preload: path.join(appDir, "preload", "ask.cjs"),
        contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
      },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    if (this.o.floating) applyAllWorkspaces(win, this.o.floating.allWorkspaces);
    try { win.setIgnoreMouseEvents(true); } catch { /* test double */ }
    win.on("blur", () => {
      if (this.win !== win) return;
      if (this.menuUp) this.menuBlur = true;
      else this.hide();
    });
    win.on("focus", () => {
      if (this.win !== win) return;
      this.menuBlur = false;
      if (this.awaitingKeyboard) { this.awaitingKeyboard = false; this.o.onKeyboard?.(); }
    });
    // Right-click in the field: Cut, Copy, Paste and Select all, for a mouse-only paste or copy.
    win.webContents.on("context-menu", (_e, p) => this.editMenu(win, p.editFlags));
    // The page asks for the rows its field and note need (Shift+Enter, a pasted traceback, a paste cut at the limit):
    // only this box's page is heard here.
    win.webContents.ipc.on(IPC.askFit, (_e, rows: unknown) => { if (this.win === win && typeof rows === "number" && Number.isFinite(rows)) this.fit(rows); });
    // A crashed ask box is rebuilt on the next Ctrl+Alt+Space.
    win.webContents.on("render-process-gone", () => { if (!win.isDestroyed()) win.destroy(); if (this.win === win) this.win = null; });
    // Once it has loaded (isLoading() is still true during "did-finish-load", so the context waited for the next
    // update and the first box opened from the menu never showed "Ember will see: …").
    win.webContents.on("did-stop-loading", () => { if (this.win === win) this.sendContext(); });
    const query: Record<string, string> = { ...(opaque ? { opaque: "1" } : {}), ...(this.o.os ? { os: this.o.os } : {}) };
    void win.loadURL(pageUrl(path.join(appDir, "renderer", "ask", "index.html"), query));
    win.once("ready-to-show", () => {
      if (this.win !== win) return;
      this.loaded = true;
      if (this.wanted && Date.now() - this.wantedAt <= LATE_MS) this.reveal(win);
      else this.wanted = false;
    });
    return win;
  }

  private reveal(win: BrowserWindow): void {
    // What the box shows (where Ember will look, the earlier questions) goes first: the page has it before the window
    // has the keyboard, so nothing it does on opening lands on letters already typed into it (review #78).
    this.sendContext();
    try { win.setIgnoreMouseEvents(false); } catch { /* test double */ }
    // Before show(): Windows activates the window, and says so ("focus"), inside it.
    this.awaitingKeyboard = true;
    win.show();
    win.focus();
    // Best effort, as it always was: the box is shown and gets its context whatever the window manager says.
    try { this.o.takeFocus?.(this.idOf(win)); } catch { /* the keyboard stays where the window manager put it */ }
    // Said once the box is up: a log line written before it would hold up the keyboard.
    this.o.onReveal?.(this.source);
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
  show(near: { x: number; y: number; size?: number } | null, context?: AskContext, source = "open"): void {
    this.context = { ...(context ?? this.context), opened: true };
    this.source = source;
    this.wanted = true;
    this.wantedAt = Date.now();
    const display = screen.getDisplayNearestPoint(near ?? screen.getCursorScreenPoint());
    // As large as its words at the text size now (it is hidden while Settings changes it, so each opening is sized here).
    const scale = this.scale();
    let bounds = askBounds(near, display.workArea, this.keepOff(), scale);
    this.up = !near || bounds.y + bounds.height <= near.y;
    // Saying to wait for it: a row taller from the start, so it doesn't grow once shown.
    if (this.context.tip) bounds = grownBounds(bounds, 2, display.workArea, this.up, this.keepOff(), scale);
    // The compositor came or went since the box was made: it is made again, opaque or not.
    if (this.win && !this.win.isDestroyed() && this.builtOpaque !== this.opaque) { this.win.destroy(); this.win = null; }
    if (!this.win || this.win.isDestroyed()) { this.build(bounds); return; }
    this.win.setBounds(bounds);
    if (this.loaded) this.reveal(this.win);
  }

  /**
   * The field's right-click menu; the box stays open while it is up. Once it has closed (and the OS has said where the
   * keyboard went): the box keeps or takes back the keyboard, or, when the user dismissed the menu by clicking another
   * app, goes away as on any click away, instead of taking the keyboard back from that app.
   */
  private editMenu(win: BrowserWindow, flags: EditFlags): void {
    if (this.win !== win || win.isDestroyed() || !win.isVisible()) return;
    this.menuUp = true;
    this.menuBlur = false;
    Menu.buildFromTemplate(editMenuItems(flags)).popup({
      window: win,
      callback: () => {
        // A blur from here on closes the box as usual; one that came while the menu was up is decided below.
        this.menuUp = false;
        setTimeout(() => {
          if (this.win !== win || win.isDestroyed() || !win.isVisible() || win.isFocused()) return;
          if (this.menuBlur) this.hide();
          else win.focus();
        }, MENU_SETTLE_MS);
      },
    });
  }

  /**
   * The page needs `rows` rows (1 to 6: the field's lines, the note's when a paste was cut, the tip's): the box grows
   * or shrinks to fit, away from Ember.
   */
  fit(rows: number): void {
    if (!this.win || this.win.isDestroyed()) return;
    const b = this.win.getBounds();
    const next = grownBounds(b, rows, screen.getDisplayMatching(b).workArea, this.up, this.keepOff(), this.scale());
    if (next.height !== b.height || next.y !== b.y || next.x !== b.x) this.win.setBounds(next);
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
    this.awaitingKeyboard = false;
    if (!this.win || this.win.isDestroyed()) return;
    this.win.hide();
    // A hidden always-on-top box on X11 can stay mapped and steal a click into the app beneath (that click then
    // looks like the box opening by itself). While hidden it takes no pointer.
    try { this.win.setIgnoreMouseEvents(true); } catch { /* test double */ }
    // What was left in the field is selected now, while nothing can be typed in it, so typing replaces it when the box
    // opens again (selected as it opened, it took the letters typed first: review #78).
    if (!this.win.webContents.isLoading()) this.win.webContents.send(IPC.askHidden);
  }

  /**
   * Resolves once the box has the keyboard (true), or after `ms` (false). The keys typed while it opened are given to
   * it then (typed()).
   */
  hasKeyboard(ms = 1200): Promise<boolean> {
    const win = this.win;
    if (!win || win.isDestroyed()) return Promise.resolve(false);
    return new Promise(resolve => {
      const t0 = Date.now();
      const check = () => {
        const ok = !win.isDestroyed() && win.isVisible() && win.isFocused() && this.loaded && (this.o.hasFocus?.() ?? true);
        if (ok || win.isDestroyed() || Date.now() - t0 > ms) { clearInterval(timer); resolve(ok); }
      };
      const timer = setInterval(check, 10);
      check();
    });
  }

  /** What was typed while the box opened goes into it (only while it is open and was asked for). */
  typed(t: { text: string; submit: boolean; cancel: boolean }): void {
    if (!this.wanted || !this.win || this.win.isDestroyed() || !this.loaded) return;
    if (!t.text && !t.submit && !t.cancel) return;
    this.win.webContents.send(IPC.askTyped, t);
  }

  /** Open now (it closes when it loses focus, so open means the user is typing in it). */
  get visible(): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.isVisible();
  }

  focus(): void {
    if (this.wanted && this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.focus();
  }

  owns(sender: Electron.WebContents): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.webContents === sender;
  }

  /**
   * Is window `id` the box (it closes when it loses focus, so focus never goes back to it)? Never for 0: an id that
   * can't be told is no window, so it never matches a box whose own id can't be told either.
   */
  isWindow(id: number): boolean {
    return id !== 0 && !!this.win && !this.win.isDestroyed() && this.idOf(this.win) === id;
  }
}
