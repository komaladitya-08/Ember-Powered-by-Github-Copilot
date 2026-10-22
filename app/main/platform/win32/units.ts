/**
 * Screen units on Windows: physical virtual-desktop pixels (Electron's main process is per-monitor DPI aware, so
 * GetCursorPos, GetWindowRect, BitBlt and the SM_*VIRTUALSCREEN metrics all use them). The virtual desktop's origin
 * is the primary monitor's top-left, so monitors left of or above it have negative coordinates. Electron windows use
 * DIP, which Chromium lays out per monitor (not linear across mixed scale factors): only Electron's own
 * screenToDipRect/screenToDipPoint convert exactly, and they are injected. Pure.
 */

import type { Rect, ScreenLike } from "../types";

/**
 * The requested rectangle (floored, as X11's capture does) clipped to `screen`, or null when none of it is on the
 * screen. Negative origins are valid: there is no clip at 0.
 */
export function clipToScreen(x: number, y: number, width: number, height: number, screen: Rect): Rect | null {
  if (!(width > 0) || !(height > 0)) return null;
  const x0 = Math.max(screen.x, Math.floor(x)), y0 = Math.max(screen.y, Math.floor(y));
  const x1 = Math.min(screen.x + screen.width, Math.floor(x + width)), y1 = Math.min(screen.y + screen.height, Math.floor(y + height));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** The primary display's scale factor, or 1 when it is missing or nonsense. */
function primaryScale(screen: ScreenLike): number {
  try {
    const f = screen.getPrimaryDisplay().scaleFactor;
    return Number.isFinite(f) && f > 0 ? f : 1;
  } catch {
    return 1; // no display information: treat pixels as DIP rather than throw from a coordinate conversion
  }
}

/**
 * Physical rectangle → DIP through Electron's screen.screenToDipRect (per monitor). Without it (or if it throws),
 * ÷ the primary display's scale factor: exact with one monitor or one scale factor, approximate otherwise.
 */
export function rectToDip(rect: Rect, screen: ScreenLike): Rect {
  if (screen.screenToDipRect) {
    try {
      return screen.screenToDipRect(null, rect);
    } catch {
      // A conversion Electron refuses (no displays during startup or shutdown): use the approximation below.
    }
  }
  const s = primaryScale(screen);
  return { x: rect.x / s, y: rect.y / s, width: rect.width / s, height: rect.height / s };
}

/** Physical point → DIP through Electron's screen.screenToDipPoint, with the same fallback as rectToDip. */
export function pointToDip(point: { x: number; y: number }, screen: ScreenLike): { x: number; y: number } {
  if (screen.screenToDipPoint) {
    try {
      return screen.screenToDipPoint(point);
    } catch {
      // As in rectToDip.
    }
  }
  const s = primaryScale(screen);
  return { x: point.x / s, y: point.y / s };
}
