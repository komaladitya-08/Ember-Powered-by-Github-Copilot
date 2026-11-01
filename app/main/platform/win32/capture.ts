/**
 * Screen capture on Windows: GDI BitBlt from the screen DC into a 32-bit top-down DIB section, synchronous, with X11's
 * contract (BGRA, stride width × 4, the requested rectangle clipped to the screen, 1 image pixel = 1 screen pixel).
 * With DWM the screen DC is the composed desktop, so other apps' windows are in it; the copy adds CAPTUREBLT so
 * layered windows (Ember's overlay is one) are too. CAPTUREBLT may hide and redraw a software cursor on each capture,
 * so test/integration/win32-desktop.test.ts measures whether layered windows are in the capture without it; the flag
 * goes only on that evidence. It fails closed: nothing on screen, the secure desktop (UAC, the lock screen) or a
 * failed BitBlt all give null, never a black or stale picture.
 */

import type { X11Image } from "../types";
import type { Win32Api } from "./ffi";
import { virtualScreen } from "./hwnd";
import { onUsersDesktop } from "./security";
import { clipToScreen } from "./units";

/**
 * A rectangle of the virtual desktop (physical pixels; negative coordinates are valid) as BGRA pixels, or null.
 * The alpha bytes are whatever GDI left there: Perception forces them opaque.
 */
export function captureScreen(api: Win32Api, x: number, y: number, width: number, height: number): X11Image | null {
  const r = clipToScreen(x, y, width, height, virtualScreen(api));
  if (!r) return null;
  // While the secure desktop has the screen, the user's desktop can still be read but shows what was there before.
  if (!onUsersDesktop(api.inputDesktopName())) return null;
  const bgra = api.blit(r.x, r.y, r.width, r.height);
  if (!bgra || bgra.length !== r.width * r.height * 4) return null;
  return { ...r, bgra };
}
