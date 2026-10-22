/**
 * Screenshots for the model: captured straight from the window system (X11's
 * XGetImage on Linux: fast, includes composited windows; GDI on Windows;
 * desktopCapturer on macOS, which answers asynchronously), with Ember's overlay
 * hidden, never-look windows blacked out, downscaled to at most 1280 px on its
 * longer side (JPEG), and a record of how image pixels map back to screen units.
 * Ember shows again the moment the pixels are in, and a synchronous capture
 * stays synchronous (no extra wait on Linux).
 */

import { createRequire } from "node:module";
import type Sharp from "sharp";
import type { PerceptionWindows, X11Image } from "../platform/types";
import type { Bounds } from "./sidecar";

export interface Capture {
  /**
   * What was captured, in screen units (physical pixels on Linux and Windows, points on macOS): the requested
   * rectangle, clipped to the screen. It may start left of or above (0, 0) on Windows and macOS.
   */
  rect: Bounds;
  /** Encoded image. */
  data: Buffer;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  /** image px = (screen px - rect.x|y) * scale */
  scale: number;
}

export interface CaptureOptions {
  /** Longest side of the image in px (portrait screens are limited by height). */
  maxSide?: number;
  /** Rectangles (screen px) to paint black before encoding. */
  mask?: Bounds[];
  /**
   * More rectangles to black out, asked for once the pixels are taken (windows can move meanwhile).
   * null means they can't be known: no image (fail closed).
   */
  maskAfter?: () => Promise<Bounds[] | null>;
  format?: "jpeg" | "png";
  /** Called to hide Ember's overlay; resolves when hidden. Returns a function that shows it again. */
  hideOverlay?: () => Promise<() => void>;
  /** Extra layers drawn on top (e.g. set-of-marks), in image coordinates; `origin` is the captured rectangle. */
  overlaySvg?: (scale: number, width: number, height: number, origin: Bounds) => string | null;
}

// Loaded on first capture: sharp's native library is large and screenshots are rare.
const requireCjs = createRequire(__filename);
let sharpModule: typeof Sharp | null = null;
const sharp: typeof Sharp = ((...args: Parameters<typeof Sharp>) => {
  sharpModule ??= requireCjs("sharp") as typeof Sharp;
  return sharpModule(...args);
}) as typeof Sharp;

export function bgraToRgba(bgra: Buffer): Buffer {
  const out = Buffer.allocUnsafe(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    out[i] = bgra[i + 2];
    out[i + 1] = bgra[i + 1];
    out[i + 2] = bgra[i];
    out[i + 3] = 255;
  }
  return out;
}

export function maskRect(rgba: Buffer, width: number, height: number, r: Bounds): void {
  const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(width, Math.ceil(r.x + r.width)), y1 = Math.min(height, Math.ceil(r.y + r.height));
  for (let y = y0; y < y1; y++) rgba.fill(0, (y * width + x0) * 4, (y * width + x1) * 4);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) rgba[(y * width + x) * 4 + 3] = 255;
}

/**
 * Captures `rect` (screen units) with Ember hidden, blacks out the masks and encodes it; null when nothing could be
 * captured or `maskAfter` can't tell what to black out (fail closed).
 */
export async function captureRect(x11: Pick<PerceptionWindows, "capture">, rect: Bounds, opts: CaptureOptions = {}): Promise<Capture | null> {
  const show = opts.hideOverlay ? await opts.hideOverlay() : null;
  let img: X11Image | null;
  try {
    const r = x11.capture(Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height));
    // An asynchronous capture (macOS) keeps Ember hidden until its pixels are in; a synchronous one isn't awaited.
    img = isPromiseLike(r) ? await r : r;
  } finally {
    show?.();
  }
  if (!img) return null;
  const after = opts.maskAfter ? await opts.maskAfter() : [];
  if (after === null) return null;
  // capture() clips the rectangle to the screen: image pixel (0,0) is screen pixel (img.x, img.y), negative or not.
  const origin: Bounds = { x: img.x, y: img.y, width: img.width, height: img.height };
  const rgba = bgraToRgba(img.bgra);
  for (const m of [...opts.mask ?? [], ...after]) {
    maskRect(rgba, img.width, img.height, { x: m.x - origin.x, y: m.y - origin.y, width: m.width, height: m.height });
  }
  const scale = Math.min(1, (opts.maxSide ?? 1280) / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * scale)), height = Math.max(1, Math.round(img.height * scale));
  let pipeline = sharp(rgba, { raw: { width: img.width, height: img.height, channels: 4 } }).resize(width, height);
  const svg = opts.overlaySvg?.(scale, width, height, origin);
  if (svg) {
    const base = await pipeline.png().toBuffer();
    pipeline = sharp(base).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
  }
  const format = opts.format ?? "jpeg";
  const data = format === "png" ? await pipeline.png().toBuffer() : await pipeline.jpeg({ quality: 78 }).toBuffer();
  return { rect: origin, data, mimeType: format === "png" ? "image/png" : "image/jpeg", width, height, scale };
}

/** Is this capture's answer still to come? (Duck-typed: X11's synchronous image is a plain object without `then`.) */
function isPromiseLike<T>(v: T | PromiseLike<T>): v is PromiseLike<T> {
  return typeof (v as { then?: unknown } | null)?.then === "function";
}

/** Screen point for an image point in a capture. */
export function imageToScreen(c: Capture, p: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.round(c.rect.x + p.x / c.scale), y: Math.round(c.rect.y + p.y / c.scale) };
}
