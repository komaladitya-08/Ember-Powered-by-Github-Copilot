/**
 * Screen capture for the macOS window system. Ember doesn't take the pixels itself on macOS: main injects a function
 * built on Electron's desktopCapturer (CGWindowListCreateImage is obsoleted in the macOS 15 SDK), and this module
 * holds the contract around it. Without the Screen Recording permission macOS hands out the wallpaper and Ember's
 * own windows instead of an error, so no capture is attempted unless the permission is there (fail closed). The
 * request is clipped to the screen, and only an image of exactly the clipped rectangle at one pixel per point is
 * accepted, because Perception's masks are placed by "1 image pixel = 1 screen unit". composePoints() is the pure
 * resampling the injected function uses to turn each display's bitmap (pixels) into that image (points).
 */

import type { Rect, X11Image } from "../types";

/**
 * What main injects: the screen inside `rect` (global points, already clipped to the screen, integral) as BGRA at one
 * pixel per point, with x/y/width/height equal to `rect` and bgra.length = width * height * 4. Retina bitmaps are
 * resampled down to points (composePoints does it), areas no display covers are black, and null means "couldn't".
 */
export type DarwinCapture = (rect: Rect) => Promise<X11Image | null>;

/** The screen's extent (union of the displays, points; may start at negative coordinates), or null if unknown. */
export function clipToScreen(x: number, y: number, width: number, height: number, screen: Rect | null): Rect | null {
  if (!screen || ![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const x0 = Math.max(Math.floor(screen.x), Math.floor(x)), y0 = Math.max(Math.floor(screen.y), Math.floor(y));
  const x1 = Math.min(Math.floor(screen.x + screen.width), Math.floor(x + width));
  const y1 = Math.min(Math.floor(screen.y + screen.height), Math.floor(y + height));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** The injected function's image when it is exactly the requested rectangle at one pixel per point; else null. */
export function acceptImage(img: X11Image | null | undefined, rect: Rect): X11Image | null {
  if (!img || !Buffer.isBuffer(img.bgra)) return null;
  if (img.x !== rect.x || img.y !== rect.y || img.width !== rect.width || img.height !== rect.height) return null;
  return img.bgra.length === rect.width * rect.height * 4 ? img : null;
}

export interface CaptureOptions {
  capture?: DarwinCapture;
  /** Does Ember have the Screen Recording permission now? */
  screenAccess: () => boolean;
  /** The screen's extent in points (union of display bounds). */
  screen: Rect | null;
}

/**
 * WindowSystem.capture on macOS: null at once (no promise) without a capture function, without the permission, or
 * when nothing of the rectangle is on screen; otherwise a promise of the image, null when it isn't the contract's.
 */
export function captureRect(o: CaptureOptions, x: number, y: number, width: number, height: number): Promise<X11Image | null> | null {
  if (!o.capture) return null;
  let allowed: boolean;
  try {
    allowed = !!o.screenAccess();
  } catch {
    allowed = false; // can't tell: no capture
  }
  if (!allowed) return null;
  const rect = clipToScreen(x, y, width, height, o.screen);
  if (!rect) return null;
  let pending: Promise<X11Image | null>;
  try {
    pending = Promise.resolve(o.capture(rect));
  } catch {
    return null; // the injected function threw before it started: no image
  }
  return pending.then(img => acceptImage(img, rect), () => null);
}

/** One display's capture, as main gets it from desktopCapturer (thumbnail.toBitmap(): BGRA on macOS). */
export interface DisplayBitmap {
  /** The display's bounds in points (Electron's Display.bounds). */
  bounds: Rect;
  /** The bitmap's size in pixels (about bounds × scaleFactor; desktopCapturer may round it). */
  width: number;
  height: number;
  /** BGRA, stride = width * 4. */
  bgra: Buffer;
}

/** For each output cell along one axis, the source range [from, to) it averages (at least one source pixel). */
function spans(cells: number, origin: number, start: number, length: number, pixels: number): Int32Array {
  const k = pixels / length;
  const out = new Int32Array(cells * 2);
  for (let i = 0; i < cells; i++) {
    const s0 = (origin + i - start) * k, s1 = s0 + k;
    let from = k >= 1 ? Math.round(s0) : Math.floor(s0 + k / 2);
    let to = k >= 1 ? Math.round(s1) : from + 1;
    from = Math.min(Math.max(from, 0), pixels - 1);
    to = Math.min(Math.max(to, from + 1), pixels);
    out[i * 2] = from;
    out[i * 2 + 1] = to;
  }
  return out;
}

/**
 * The image of `rect` (integral global points) at one pixel per point, from each display's bitmap: every point
 * averages the block of pixels it covers (2×2 on a Retina display), or takes the nearest pixel when a bitmap is
 * smaller than its display. Points no display covers stay black. Alpha is always opaque.
 */
export function composePoints(displays: readonly DisplayBitmap[], rect: Rect): X11Image {
  const width = Math.max(0, Math.round(rect.width)), height = Math.max(0, Math.round(rect.height));
  const out = Buffer.alloc(width * height * 4);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  for (const d of displays) {
    const b = d.bounds;
    if (d.width <= 0 || d.height <= 0 || b.width <= 0 || b.height <= 0 || d.bgra.length < d.width * d.height * 4) continue;
    const ox0 = Math.max(rect.x, Math.ceil(b.x)), oy0 = Math.max(rect.y, Math.ceil(b.y));
    const ox1 = Math.min(rect.x + width, Math.floor(b.x + b.width)), oy1 = Math.min(rect.y + height, Math.floor(b.y + b.height));
    if (ox1 <= ox0 || oy1 <= oy0) continue;
    const xs = spans(ox1 - ox0, ox0, b.x, b.width, d.width);
    const ys = spans(oy1 - oy0, oy0, b.y, b.height, d.height);
    const stride = d.width * 4;
    for (let row = 0; row < oy1 - oy0; row++) {
      const sy0 = ys[row * 2]!, sy1 = ys[row * 2 + 1]!;
      let o = ((oy0 - rect.y + row) * width + (ox0 - rect.x)) * 4;
      for (let col = 0; col < ox1 - ox0; col++, o += 4) {
        const sx0 = xs[col * 2]!, sx1 = xs[col * 2 + 1]!;
        let bl = 0, gr = 0, rd = 0, n = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          let p = sy * stride + sx0 * 4;
          for (let sx = sx0; sx < sx1; sx++, p += 4) {
            bl += d.bgra[p]!;
            gr += d.bgra[p + 1]!;
            rd += d.bgra[p + 2]!;
            n++;
          }
        }
        out[o] = Math.round(bl / n);
        out[o + 1] = Math.round(gr / n);
        out[o + 2] = Math.round(rd / n);
      }
    }
  }
  return { x: rect.x, y: rect.y, width, height, bgra: out };
}
