/**
 * Ember's handle: a small always-on-top pill in the corner of the primary
 * display with Ember's face and status. Clicking it opens Ember's menu, so
 * nothing depends on a tray (GNOME 3.32 has none by default).
 *
 * Without a compositor (xrdp, VNC) transparent overlays render black, so the
 * handle becomes an opaque card that also shows what Ember is saying.
 *
 * The platform says how a floating window is made on this OS (a macOS panel,
 * a Windows tool window) and whether click-through forwards the pointer.
 */

import { BrowserWindow, screen } from "electron";
import path from "node:path";
import type { Settings } from "./settings";
import { revive } from "./revive";
import { OVERLAY, type EmberState, type OverlayInit } from "../shared/overlay";
import type { FloatingWindow } from "./platform/types";
import { applyAllWorkspaces } from "./platform/compose";
import { scaledSize, textScale } from "./page-prefs";
import { pageUrl } from "./page-url";

const appDir = __dirname;
/** At the default text size; it widens with the text (its two lines fit its height at every size). */
const PILL = { width: 200, height: 56 };
/** While Ember is hidden: the pill shrinks to a tab with just Ember's face (still the way back to Show Ember). */
const TAB = { width: 56, height: 56 };
const CARD = { width: 360, height: 150 };
/** The card's height follows what it shows (a question with its buttons, a task with Stop), within these limits. */
const CARD_MIN = 120, CARD_MAX = 360;
const MARGIN = 12;

export class HandleWindow {
  readonly win: BrowserWindow;

  /**
   * `o.floating`: the platform's options and workspace rule for the handle (default: today's Linux window, on every
   * workspace); `o.forward`: click-through forwards the pointer's moves (macOS).
   */
  constructor(private settings: () => Settings, readonly fallback: boolean, private o: { floating?: FloatingWindow; forward?: boolean } = {}) {
    const size = fallback ? CARD : this.pill();
    this.pillWidth = size.width;
    this.win = new BrowserWindow({
      ...size,
      ...this.corner(size),
      transparent: !fallback,
      backgroundColor: fallback ? "#242022" : "#00000000",
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
      ...(o.floating?.options ?? {}),
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
    applyAllWorkspaces(this.win, o.floating ? o.floating.allWorkspaces : "plain");
    this.win.webContents.on("did-finish-load", () => {
      const primary = screen.getPrimaryDisplay();
      const init: OverlayInit = { displayId: primary.id, bounds: primary.bounds, settings: this.settings(), fallback };
      this.win.webContents.send(OVERLAY.init, init);
      if (this.last) this.win.webContents.send(OVERLAY.state, this.last);
      this.win.showInactive();
    });
    // The handle is the way to Quit and Stop when shortcuts are taken: a crashed one comes back.
    revive(this.win);
    screen.on("display-metrics-changed", this.reposition);
    screen.on("display-removed", this.reposition);
    void this.win.loadURL(pageUrl(path.join(appDir, "renderer", "handle", "index.html")));
  }

  private last: EmberState | null = null;

  /** Ember is hidden: the pill is a tab with only its face (the page drops its words at that width). */
  private compact = false;

  /**
   * Ember was hidden (true) or shown again (false): the pill shrinks to its face in the same corner, or grows back, so
   * "Hide Ember" leaves only what is needed to show it again. The card (no compositor) never shrinks. Returns whether the
   * handle's place changed.
   */
  setCompact(on: boolean): boolean {
    if (this.fallback || on === this.compact || this.win.isDestroyed()) return false;
    this.compact = on;
    this.reposition();
    return true;
  }

  private cardHeight = CARD.height;

  sendState(state: EmberState): void {
    this.last = state;
    if (this.win.isDestroyed()) return;
    this.win.webContents.send(OVERLAY.state, state);
  }

  /** Fallback card: grows or shrinks (upward, same corner) to the height its content needs. */
  fit(height: number): void {
    if (!this.fallback || !Number.isFinite(height)) return;
    const h = Math.round(Math.min(Math.max(height, CARD_MIN), CARD_MAX));
    if (h === this.cardHeight) return;
    this.cardHeight = h;
    this.reposition();
  }

  /** The handle's place on screen (Ember keeps off it). */
  get bounds(): { x: number; y: number; width: number; height: number } | null {
    return this.win.isDestroyed() ? null : this.win.getBounds();
  }

  /** While Ember borrows the mouse, its own windows let clicks through (a borrowed click must never land on Ember). */
  setClickThrough(on: boolean): void {
    if (this.win.isDestroyed()) return;
    if (on && this.o.forward) this.win.setIgnoreMouseEvents(true, { forward: true });
    else this.win.setIgnoreMouseEvents(on);
  }

  /**
   * Sends the settings to the page; true when the text size changed the pill's width, which then moves (main tells the
   * desk view). The tab (Ember hidden) keeps its size; the pill takes the new width when Ember is shown again.
   */
  sendSettings(s: Settings): boolean {
    if (this.win.isDestroyed()) return false;
    this.win.webContents.send(OVERLAY.settings, s);
    if (this.fallback || this.compact || this.pill().width === this.pillWidth) return false;
    this.reposition();
    return true;
  }

  /** The pill's width as last placed. */
  private pillWidth = PILL.width;

  /** The pill at the text size: wider as its words grow ("Microphone problem", the computer's name), as high. */
  private pill(): { width: number; height: number } {
    return { width: scaledSize({ width: PILL.width }, textScale(this.settings().textSize)).width, height: PILL.height };
  }

  private corner(size: { width: number; height: number }) {
    const wa = screen.getPrimaryDisplay().workArea;
    return { x: wa.x + wa.width - size.width - MARGIN, y: wa.y + wa.height - size.height - MARGIN };
  }

  /** Gone for good (Ember switches between the pill and the card when the compositor comes or goes). */
  destroy(): void {
    screen.off("display-metrics-changed", this.reposition);
    screen.off("display-removed", this.reposition);
    if (!this.win.isDestroyed()) this.win.destroy();
  }

  private reposition = (): void => {
    if (this.win.isDestroyed()) return;
    const size = this.fallback ? { width: CARD.width, height: this.cardHeight } : this.compact ? TAB : this.pill();
    if (!this.fallback && !this.compact) this.pillWidth = size.width;
    this.win.setBounds({ ...size, ...this.corner(size) });
  };
}
