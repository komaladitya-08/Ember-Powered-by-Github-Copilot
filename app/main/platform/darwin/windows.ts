/**
 * The macOS window system: Ember's WindowSystem over CoreGraphics' window list, CGEvent state and AX, in points
 * (CGEvent, CGWindowList, AX and Electron's screen share that unit, so DIP conversion is the identity). Window ids
 * are CGWindowIDs, and Ember's own windows get theirs from getMediaSourceId() ("window:<CGWindowID>:0"), never from
 * getNativeWindowHandle() (an NSView* on macOS). Pixels come from a capture function main injects (Electron's
 * desktopCapturer, see capture.ts), never without the Screen Recording permission. AX runs with a 0.25 s messaging
 * timeout because these calls block Electron's main thread, and is never asked about Ember's own process.
 * createDarwinWindows() holds the logic over a DarwinDesktop, so it is unit-tested with a fake on any OS.
 */

import type { OwnWindowHandle, Rect, ScreenLike, StackedWindow, WindowSystem, X11Image, X11Window } from "../types";
import { captureRect, type DarwinCapture } from "./capture";
import { openDesktop, desktopError, type DarwinDesktop } from "./desktop";
import { resolveActive, resolveFocus, type Resolved } from "./focus";
import { FLAG, MOUSE_BUTTON } from "./cg";
import { VK } from "./keys";
import { SECURITY_OWNERS, clientWindowsOf, parseMediaSourceId, sameFrame, stackOf, unionRect } from "./model";

/** What openDarwinWindows() takes from main. */
export interface DarwinWindowsDeps {
  /** Electron's screen (displays in points). */
  screen: ScreenLike;
  /** Takes the pixels (see DarwinCapture for the contract). Without it capture() always answers null. */
  capture?: DarwinCapture;
  /** Does Ember have the Screen Recording permission? Defaults to CGPreflightScreenCaptureAccess(). */
  screenAccess?: () => boolean;
  /**
   * Extension: Electron's BrowserWindow.getFocusedWindow(). When one of Ember's windows has the keyboard (a
   * non-activating panel can, with another app still frontmost), focusWindow() reports it without asking AX.
   */
  focusedOwnWindow?: () => OwnWindowHandle | null;
}

/** The modifier chord held now: X11's three keys, plus Shift and Command for macOS's shortcuts. */
export interface DarwinKeysDown {
  control: boolean;
  alt: boolean;
  space: boolean;
  shift: boolean;
  command: boolean;
}

/** WindowSystem on macOS, with what only macOS can tell. */
export interface DarwinWindowSystem extends WindowSystem {
  readonly kind: "darwin";
  keysDown(): DarwinKeysDown | null;
  /**
   * An authentication dialog (SecurityAgent, coreautha) is on screen, or secure keyboard entry is on (a password is
   * being typed somewhere): no screenshot. True when it can't be checked.
   */
  systemDialogOpen(): boolean;
  /** Is Ember trusted for Accessibility (focus, titles, activation and input need it)? */
  accessibilityTrusted(): boolean;
  /** Does Ember have the Screen Recording permission (capture and other apps' window titles need it)? */
  screenRecording(): boolean;
}

/** Tunables and seams for the tests. */
export interface DarwinWindowsOptions {
  ownPid?: number;
  now?: () => number;
  /** How long clientWindows() may spend asking AX for titles CGWindowList didn't give (ms). */
  titleBudgetMs?: number;
}

/** Ember's WindowSystem over a DarwinDesktop. */
export function createDarwinWindows(desktop: DarwinDesktop, deps: DarwinWindowsDeps, o: DarwinWindowsOptions = {}): DarwinWindowSystem {
  const ownPid = o.ownPid ?? process.pid;
  const now = o.now ?? Date.now;
  let open = true;

  const windowId = (win: OwnWindowHandle): number => {
    try {
      return parseMediaSourceId(win.getMediaSourceId());
    } catch {
      return 0; // a destroyed window
    }
  };
  const ownFocusedId = () => {
    const win = deps.focusedOwnWindow?.();
    return win ? windowId(win) : 0;
  };
  const focus = { desktop, ownPid, ownFocusedId };
  const describe = (r: Resolved | null): (X11Window & { wmClass: string }) | null => {
    if (!r) return null;
    if (!r.entry) return { id: r.id, pid: ownPid, title: r.title, x: 0, y: 0, width: 0, height: 0, wmClass: "" };
    return { id: r.id, pid: r.entry.pid, title: r.title, ...r.entry.bounds, wmClass: r.entry.owner };
  };
  const displays = (): Rect[] => {
    try {
      const all = deps.screen.getAllDisplays().map(d => d.bounds);
      return all.length ? all : [deps.screen.getPrimaryDisplay().bounds];
    } catch {
      return []; // no screen information: capture clips to nothing
    }
  };
  const screenAccess = (): boolean => {
    try {
      return deps.screenAccess ? !!deps.screenAccess() : desktop.screenAccess();
    } catch {
      return false; // can't tell: treat as not granted
    }
  };

  return {
    kind: "darwin",
    compositorMayChange: false,

    hasCompositor() {
      return true; // Quartz always composites
    },

    pointer() {
      if (!open) return null;
      const p = desktop.pointer();
      if (!p) return null;
      // X's button mask whatever the platform: 256 left (the primary, as macOS swaps at the driver), 512 middle, 1024 right.
      const mask = (desktop.buttonDown(MOUSE_BUTTON.left) ? 256 : 0) | (desktop.buttonDown(MOUSE_BUTTON.center) ? 512 : 0)
        | (desktop.buttonDown(MOUSE_BUTTON.right) ? 1024 : 0);
      return { x: Math.round(p.x), y: Math.round(p.y), mask };
    },

    keysDown() {
      if (!open) return null;
      const flags = desktop.flags();
      return {
        control: (flags & FLAG.control) !== 0,
        alt: (flags & FLAG.alternate) !== 0,
        space: desktop.keyDown(VK.space),
        shift: (flags & FLAG.shift) !== 0,
        command: (flags & FLAG.command) !== 0,
      };
    },

    activeWindow() {
      if (!open) return null;
      return describe(resolveActive(focus, desktop.windows()));
    },

    focusWindow() {
      if (!open) return null;
      return describe(resolveFocus(focus, desktop.windows()));
    },

    clientWindows() {
      if (!open) return [];
      const list = desktop.windows();
      const out = clientWindowsOf(list);
      // Without Screen Recording other apps' titles are empty: AX has them, at one round trip per app, within a budget.
      const untitled = [...new Set(out.filter(w => !w.title && w.pid !== null && w.pid !== ownPid).map(w => w.pid!))];
      const until = now() + (o.titleBudgetMs ?? 250);
      for (const pid of untitled) {
        if (now() > until) break;
        const axWindows = desktop.appWindows(pid);
        if (!axWindows) continue;
        for (const w of out) {
          if (w.pid !== pid || w.title) continue;
          const match = axWindows.filter(a => (a.id ? a.id === w.id : sameFrame(a.frame, w)));
          if (match.length === 1) w.title = match[0]!.title;
        }
      }
      return out;
    },

    stack(): StackedWindow[] {
      if (!open) return [];
      return stackOf(desktop.windows());
    },

    capture(x: number, y: number, width: number, height: number): Promise<X11Image | null> | null {
      if (!open) return null;
      return captureRect({ capture: deps.capture, screenAccess, screen: unionRect(displays()) }, x, y, width, height);
    },

    windowId,

    toDip(rect) {
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    },

    toDipPoint(point) {
      return { x: point.x, y: point.y };
    },

    screenBounds() {
      return unionRect(displays()) ?? { x: 0, y: 0, width: 0, height: 0 };
    },

    systemDialogOpen() {
      if (!open) return true;
      try {
        if (desktop.secureInput()) return true;
        return desktop.windows().some(e => SECURITY_OWNERS.has(e.owner) && e.alpha > 0);
      } catch {
        return true; // can't check: assume one is up
      }
    },

    accessibilityTrusted() {
      return open && desktop.trusted();
    },

    screenRecording() {
      return open && screenAccess();
    },

    close() {
      open = false;
    },
  };
}

/** Why the last openDarwinWindows() returned null (for the log). */
export let darwinWindowsError: unknown = null;

/**
 * The macOS window system, or null off macOS or when CoreGraphics can't be bound (darwinWindowsError says why).
 * Opening it needs no permission; what each permission unlocks is in DarwinWindowSystem.
 */
export function openDarwinWindows(deps: DarwinWindowsDeps): DarwinWindowSystem | null {
  if (process.platform !== "darwin") {
    darwinWindowsError = new Error("not macOS");
    return null;
  }
  try {
    const desktop = openDesktop();
    if (!desktop) {
      darwinWindowsError = desktopError;
      return null;
    }
    return createDarwinWindows(desktop, deps);
  } catch (err) {
    darwinWindowsError = err;
    return null;
  }
}
