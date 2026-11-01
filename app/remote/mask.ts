/**
 * Pixel helpers for the remote agent's screenshots (§5.3.6): the same blacking-out as app/main/perception/capture.ts
 * (`bgraToRgba`, `maskRect`), copied here because the remote bundle replaces capture.ts as a whole with
 * capture-stub.ts (so sharp's loader never enters it), and a box-filter downscale in place of sharp's resize. Masks
 * are painted before anything is encoded: never-look windows, security windows and secret fields never leave the
 * remote as pixels. Pure.
 */

import type { Bounds } from "../main/perception/sidecar";

/** X11's BGRA (ZPixmap, 32 bits per pixel) as RGBA with every pixel opaque. */
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

/** Paints `r` (image pixels, clipped to the image) opaque black. */
export function maskRect(rgba: Buffer, width: number, height: number, r: Bounds): void {
  const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(width, Math.ceil(r.x + r.width)), y1 = Math.min(height, Math.ceil(r.y + r.height));
  if (!(x1 > x0 && y1 > y0)) return;
  for (let y = y0; y < y1; y++) rgba.fill(0, (y * width + x0) * 4, (y * width + x1) * 4);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) rgba[(y * width + x) * 4 + 3] = 255;
}

/**
 * The image scaled so its longer side is at most `maxSide` (never enlarged), each output pixel the average of the
 * source pixels it covers (a box filter: a masked rectangle stays black, and its edge only darkens what it touches).
 */
export function downscale(rgba: Buffer, width: number, height: number, maxSide: number): { rgba: Buffer; width: number; height: number; scale: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  if (scale >= 1) return { rgba, width, height, scale: 1 };
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const out = Buffer.allocUnsafe(w * h * 4);
  // Each output column's source span, worked out once.
  const xs = new Int32Array(w + 1);
  for (let x = 0; x <= w; x++) xs[x] = Math.min(width, Math.floor((x * width) / w));
  for (let oy = 0; oy < h; oy++) {
    const y0 = Math.floor((oy * height) / h);
    const y1 = Math.max(y0 + 1, Math.min(height, Math.floor(((oy + 1) * height) / h)));
    for (let ox = 0; ox < w; ox++) {
      const x0 = xs[ox], x1 = Math.max(x0 + 1, xs[ox + 1]);
      let r = 0, g = 0, b = 0;
      for (let y = y0; y < y1; y++) {
        let i = (y * width + x0) * 4;
        for (let x = x0; x < x1; x++, i += 4) { r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (oy * w + ox) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return { rgba: out, width: w, height: h, scale };
}
