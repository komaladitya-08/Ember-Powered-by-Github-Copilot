/**
 * The X11 window system behind the platform contract: x11.ts unchanged, plus what main.ts used to work out from
 * Electron's primary scale factor (X11 has one global scale, and XQueryPointer reports physical pixels). $DISPLAY is
 * read here, on Linux only, as main.ts did before; libX11 loads only when openLinuxWindows runs.
 */

import { openX11, type X11 } from "../../x11";
import type { OwnWindowHandle, ScreenLike, WindowSystem } from "../types";
import { primaryScaledUnion } from "../compose";

/**
 * The X id of one of Ember's own windows (the native handle's first 32 bits on X11), or 0 when it can't be read
 * (a window that is gone, a test double).
 */
export function x11WindowId(win: OwnWindowHandle): number {
  try {
    return win.getNativeWindowHandle().readUInt32LE(0);
  } catch {
    return 0;
  }
}

/**
 * The X11 window system, or null without $DISPLAY (without calling `open`) or when the display can't be opened.
 * `screen` is Electron's (after app ready); `open` replaces openX11 in tests.
 */
export function openLinuxWindows(o: { screen: ScreenLike; env: NodeJS.ProcessEnv; open?: () => X11 | null }): WindowSystem | null {
  if (!o.env.DISPLAY) return null;
  const x = (o.open ?? (() => openX11()))();
  if (!x) return null;
  const scale = () => o.screen.getPrimaryDisplay().scaleFactor || 1;
  return {
    kind: "x11",
    compositorMayChange: true,
    hasCompositor: s => x.hasCompositor(s),
    pointer: () => x.pointer(),
    keysDown: () => x.keysDown(),
    activeWindow: () => x.activeWindow(),
    focusWindow: () => x.focusWindow(),
    clientWindows: () => x.clientWindows(),
    stack: () => x.stack(),
    capture: (cx, cy, w, h) => x.capture(cx, cy, w, h),
    close: () => x.close(),
    windowId: x11WindowId,
    toDip: r => { const k = scale(); return { x: r.x / k, y: r.y / k, width: r.width / k, height: r.height / k }; },
    toDipPoint: p => { const k = scale(); return { x: p.x / k, y: p.y / k }; },
    screenBounds: () => primaryScaledUnion(o.screen),
  };
}
