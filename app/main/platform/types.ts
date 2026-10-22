/**
 * The contract every OS backend implements (Linux X11, Windows, macOS). The rest of Ember talks to the desktop only
 * through these shapes, so each backend keeps X11's names and conventions: window and key vocabularies stay as they
 * were on Linux, and the Linux backend is the existing X11 code unchanged.
 *
 * Conventions every backend keeps:
 * - Units: "native" screen units. Linux and Windows use physical pixels; macOS uses points (what CGEvent,
 *   CGWindowList, AX and Electron's screen all use). Coordinates may be negative on Windows and macOS (a monitor left
 *   of or above the primary one).
 * - Window ids are numbers in one space per backend: the X client window (Linux), the HWND (Windows), the CGWindowID
 *   (macOS). They are compared with ===, so every member that returns or takes a window uses the same space.
 * - App names (`wmClass`): Linux keeps WM_CLASS ("gedit gedit"). Windows uses the program's file name without
 *   ".exe" as the system reports it ("notepad", "msedge"); for a UWP app's frame (ApplicationFrameHost) it is the
 *   hosted app's program. macOS uses the app's localized name ("TextEdit"). The accessibility sidecar reports the same
 *   name in its `app` field, so policy, never-look and grants match on both.
 * - Keys are named by X keysym names ("Return", "Control_L", "a") and keysym numbers. Key codes are opaque per backend
 *   (never 0). Mouse buttons use X's numbers (1 left, 2 middle, 3 right, 4–7 wheel) and X's button-mask bits (256 left,
 *   512 middle, 1024 right).
 */

import type { X11, X11Image, Rect } from "../x11";
import type { XInput } from "../hands/input";

export type { Rect, X11Image };
export type { StackedWindow, X11Window } from "../x11";

/** The part of Electron's `screen` a backend needs (injected: platform code below main.ts doesn't import electron). */
export interface ScreenLike {
  getPrimaryDisplay(): { bounds: Rect; scaleFactor: number };
  getAllDisplays(): { bounds: Rect; scaleFactor: number }[];
  /** Windows only (Electron): physical screen rectangle → DIP. */
  screenToDipRect?(window: null, rect: Rect): Rect;
  /** Windows only (Electron): physical screen point → DIP. */
  screenToDipPoint?(point: { x: number; y: number }): { x: number; y: number };
  /** Windows only (Electron): DIP point → physical screen point. */
  dipToScreenPoint?(point: { x: number; y: number }): { x: number; y: number };
}

/** What a backend needs to know about one of Ember's own BrowserWindows (structurally typed). */
export interface OwnWindowHandle {
  getNativeWindowHandle(): Buffer;
  getMediaSourceId(): string;
}

/**
 * The window system: X11's members, plus what X11 code got from Electron or assumed.
 * `capture` may answer asynchronously (macOS captures through Electron's desktopCapturer).
 */
export interface WindowSystem extends Omit<X11, "capture"> {
  /** "x11" | "win32" | "darwin". */
  readonly kind: "x11" | "win32" | "darwin";
  /** False where compositing can't come and go (Windows, macOS): the 2 s compositor watch isn't needed. */
  readonly compositorMayChange: boolean;
  capture(x: number, y: number, width: number, height: number): X11Image | null | Promise<X11Image | null>;
  /** The id of one of Ember's own windows in this backend's window-id space (0 when it can't be told). */
  windowId(win: OwnWindowHandle): number;
  /** Native screen rectangle → Electron DIP (Linux: ÷ primary scale; Windows: per monitor; macOS: identity). */
  toDip(rect: Rect): Rect;
  /** Native screen point → Electron DIP. */
  toDipPoint(point: { x: number; y: number }): { x: number; y: number };
  /** Every display together, in native units. */
  screenBounds(): Rect;
}

/**
 * Synthetic input: XInput's members (Linux XTest), so CursorBorrow and its fakes work unchanged. The optional
 * additions let Windows and macOS do what X11 does differently.
 */
export interface Input extends XInput {
  /**
   * Types one character whatever the keyboard layout (Windows KEYEVENTF_UNICODE, macOS
   * CGEventKeyboardSetUnicodeString). False when the backend can't.
   */
  textKey?(ch: string, down: boolean): boolean;
  /** Is this point on some display (negative coordinates are valid off Linux)? Replaces "inside screenSize()". */
  onScreen?(x: number, y: number): boolean;
  /**
   * Why input can't reach `window`, or null when it can (Windows: the window belongs to an elevated program and UIPI
   * would silently drop Ember's input; macOS: Ember lacks the Accessibility permission, or secure input is on).
   */
  blockedReason?(window: number): string | null;
}
