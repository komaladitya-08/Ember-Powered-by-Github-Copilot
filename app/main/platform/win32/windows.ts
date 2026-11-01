/**
 * The Windows window system (WindowSystem, kind "win32"): what X11 gives Ember on Linux, from user32, dwmapi and
 * gdi32 through koffi. Window ids are HWNDs (numbers, see hwndOf), in the same space as the input backend's and
 * windowId(own window): `id` and `client` are the same top-level HWND. Coordinates are physical virtual-desktop
 * pixels and may be negative. DWM is always on, so the compositor never changes. After close() every member is a
 * harmless no-op, as on X11.
 */

import type { OwnWindowHandle, ScreenLike, StackedWindow, WindowSystem, X11Image } from "../types";
import { captureScreen } from "./capture";
import { loadWin32, SM, type Win32Api } from "./ffi";
import {
  activateWindow, describe, factsOf, focusedChild, focusedTopLevel, namesOf, topLevels, virtualScreen, visibleFrame,
  type DescribedWindow, type ProgramMemo, type WindowNames,
} from "./hwnd";
import { buttonMask, VK } from "./keys";
import { hwndFromNativeHandle } from "./layouts";
import { coversScreen, isAppWindow, isPopup } from "./rules";
import { pointToDip, rectToDip } from "./units";

/**
 * A window in the Windows lists: X11's fields, `wmClass`, the Win32 class as `wmClassName`, and for a console window
 * (named "conhost") the program its first client runs as `clientProgram` (an extension beyond types.ts).
 */
export type Win32Window = DescribedWindow;

/** A stacked window, with a console window's `clientProgram` (an extension beyond types.ts). */
export type Win32StackedWindow = StackedWindow & WindowNames;

/** The Windows window system: WindowSystem plus activate(), which X11 code got from XInput. */
export interface Win32WindowSystem extends WindowSystem {
  readonly kind: "win32";
  activeWindow(): Win32Window | null;
  focusWindow(): Win32Window | null;
  keyboardFocus(): number;
  clientWindows(): Win32Window[];
  stack(): Win32StackedWindow[];
  /** GDI capture answers synchronously. */
  capture(x: number, y: number, width: number, height: number): X11Image | null;
  /**
   * Brings a top-level window to the front with the keyboard (the documented order, no Alt tap; the same operation as
   * the input backend's activate). Best effort: check activeWindow() after it.
   */
  activate(window: number): void;
}

/** What openWin32Windows needs: Electron's screen (injected), and for tests a fake Win32 API. */
export interface Win32WindowsDeps {
  screen: ScreenLike;
  /** The Win32 calls (default: the real ones, bound on first use; null where unavailable). */
  api?: Win32Api | null;
}

/**
 * Opens the Windows window system, or null off Windows or when koffi or a system library is missing.
 *
 * What each list holds:
 * - stack(): every top-level window that covers something now, bottom to top (GetTopWindow/GW_HWNDNEXT, reversed):
 *   visible, not minimised or cloaked, bigger than a pixel, not click-through (rules.coversScreen). Ember's own
 *   windows and the taskbar are in it: they cover what they cover. `x/y/width/height` is the DWM frame (what is
 *   visibly covered), `outer` the window rectangle with its invisible resize borders (what UIA reports for a frame),
 *   `inner` the client area; `overrideRedirect` marks menus, tooltips and owned popups (rules.isPopup).
 * - clientWindows(): the apps' windows, as Alt+Tab would show them (rules.isAppWindow), top to bottom, minimised
 *   ones included; `wmClassName` is the Win32 window class.
 * - `wmClass` everywhere: the program's file name without ".exe" ("notepad"), the hosted app's for UWP frames, and
 *   "conhost" for console windows, whose first client's program ("python") is reported as `clientProgram`.
 */
export function openWin32Windows(deps: Win32WindowsDeps): Win32WindowSystem | null {
  const api = deps.api !== undefined ? deps.api : loadWin32();
  if (!api) return null;
  const ownPid = process.pid;
  let open = true;

  return {
    kind: "win32",
    compositorMayChange: false,

    hasCompositor() {
      return true; // DWM composes every Windows 8+ desktop, RDP included
    },

    pointer() {
      if (!open) return null;
      const p = api.cursorPos();
      if (!p) return null;
      return { ...p, mask: buttonMask(vk => api.asyncKeyDown(vk), api.systemMetric(SM.SWAPBUTTON) !== 0) };
    },

    keysDown() {
      if (!open) return null;
      const down = (vk: number) => api.asyncKeyDown(vk);
      return { control: down(VK.LCONTROL) || down(VK.RCONTROL), alt: down(VK.LMENU) || down(VK.RMENU), space: down(VK.SPACE) };
    },

    activeWindow() {
      return open ? describe(api, api.foregroundWindow(), ownPid) : null;
    },

    focusWindow() {
      return open ? describe(api, focusedTopLevel(api), ownPid) : null;
    },

    keyboardFocus() {
      return open ? focusedChild(api) : 0;
    },

    clientWindows() {
      if (!open) return [];
      const memo: ProgramMemo = new Map();
      const out: Win32Window[] = [];
      for (const hwnd of topLevels(api)) {
        if (!api.isVisible(hwnd)) continue; // most top-level windows are hidden helpers: skip them before reading more
        const frame = visibleFrame(api, hwnd);
        const facts = factsOf(api, hwnd, ownPid, frame);
        if (!facts.pid || !isAppWindow(facts)) continue;
        out.push({
          id: hwnd, pid: facts.pid, title: facts.title, ...(frame ?? { x: 0, y: 0, width: 0, height: 0 }),
          ...namesOf(api, hwnd, facts.pid, facts.className, facts.title, memo), wmClassName: facts.className,
        });
      }
      return out;
    },

    stack() {
      if (!open) return [];
      const memo: ProgramMemo = new Map();
      const out: Win32StackedWindow[] = [];
      for (const hwnd of topLevels(api).reverse()) {
        if (!api.isVisible(hwnd) || api.isIconic(hwnd)) continue;
        const frame = visibleFrame(api, hwnd);
        if (!frame) continue;
        const facts = factsOf(api, hwnd, ownPid, frame);
        if (!facts.pid || !coversScreen(facts, () => api.layeredAlpha(hwnd))) continue;
        out.push({
          id: hwnd, client: hwnd, pid: facts.pid, title: facts.title,
          ...namesOf(api, hwnd, facts.pid, facts.className, facts.title, memo),
          ...frame,
          outer: api.windowRect(hwnd) ?? frame,
          inner: api.clientRect(hwnd) ?? frame,
          overrideRedirect: isPopup(facts),
        });
      }
      return out;
    },

    capture(x, y, width, height): X11Image | null {
      return open ? captureScreen(api, x, y, width, height) : null;
    },

    windowId(win: OwnWindowHandle) {
      try {
        return hwndFromNativeHandle(win.getNativeWindowHandle());
      } catch {
        return 0; // a destroyed BrowserWindow throws: it has no id any more
      }
    },

    toDip: rect => rectToDip(rect, deps.screen),
    toDipPoint: point => pointToDip(point, deps.screen),

    screenBounds() {
      return virtualScreen(api);
    },

    activate(window) {
      if (open) activateWindow(api, window, ownPid);
    },

    close() {
      open = false;
    },
  };
}
