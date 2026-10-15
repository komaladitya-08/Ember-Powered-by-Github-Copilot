/**
 * Screenshots for the model: captured straight from X11 (fast, includes
 * composited windows), with Ember's overlay hidden, never-look windows blacked
 * out, downscaled to at most 1280 px wide JPEG, and a record of how image
 * pixels map back to screen pixels.
 */

import { createRequire } from "node:module";
import type Sharp from "sharp";
import type { X11 } from "../x11";
import type { Bounds } from "./sidecar";

export interface Capture {
  /** What was captured, in screen (physical) pixels. */
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
  maxWidth?: number;
  /** Rectangles (screen px) to paint black before encoding. */
  mask?: Bounds[];
  format?: "jpeg" | "png";
  /** Called to hide Ember's overlay; resolves when hidden. Returns a function that shows it again. */
  hideOverlay?: () => Promise<() => void>;
  /** Extra layers drawn on top (e.g. set-of-marks), in image coordinates. */
  overlaySvg?: (scale: number, width: number, height: number) => string | null;
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

export async function captureRect(x11: X11, rect: Bounds, opts: CaptureOptions = {}): Promise<Capture | null> {
  const show = opts.hideOverlay ? await opts.hideOverlay() : null;
  let img;
  try {
    img = x11.capture(Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height));
  } finally {
    show?.();
  }
  if (!img) return null;
  const rgba = bgraToRgba(img.bgra);
  for (const m of opts.mask ?? []) {
    maskRect(rgba, img.width, img.height, { x: m.x - rect.x, y: m.y - rect.y, width: m.width, height: m.height });
  }
  const maxWidth = opts.maxWidth ?? 1280;
  const scale = Math.min(1, maxWidth / img.width);
  const width = Math.round(img.width * scale), height = Math.round(img.height * scale);
  let pipeline = sharp(rgba, { raw: { width: img.width, height: img.height, channels: 4 } }).resize(width, height);
  const svg = opts.overlaySvg?.(scale, width, height);
  if (svg) {
    const base = await pipeline.png().toBuffer();
    pipeline = sharp(base).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
  }
  const format = opts.format ?? "jpeg";
  const data = format === "png" ? await pipeline.png().toBuffer() : await pipeline.jpeg({ quality: 78 }).toBuffer();
  return { rect: { x: rect.x, y: rect.y, width: img.width, height: img.height }, data, mimeType: format === "png" ? "image/png" : "image/jpeg", width, height, scale };
}

/** Screen point for an image point in a capture. */
export function imageToScreen(c: Capture, p: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.round(c.rect.x + p.x / c.scale), y: Math.round(c.rect.y + p.y / c.scale) };
}
