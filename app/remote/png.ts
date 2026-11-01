/**
 * Screenshots on a remote without Electron or sharp (§5.3.6, L16): XGetImage through the existing X11 code, masks
 * painted before anything is encoded (mask.ts), a box-filter downscale to at most 1280 px on the longer side, and a
 * plain-JavaScript PNG (8-bit RGB, filter 0 on every row, zlib's deflate at level 6, CRC-32 in JS). `remoteCapture` has
 * captureRect's signature, so Perception takes it as `PerceptionOptions.capture`; the PC draws the numbered marks
 * (`overlaySvg` is ignored here) and re-encodes JPEG. Fails closed like captureRect: no pixels or masks that can't be
 * known → null. Pure but for the window system it is given.
 */

import { deflateSync } from "node:zlib";
import type { Capture, CaptureOptions } from "../main/perception/capture";
import type { Bounds } from "../main/perception/sidecar";
import type { PerceptionWindows, X11Image } from "../main/platform/types";
import { bgraToRgba, downscale, maskRect } from "./mask";

/** The longest side of a remote screenshot (as the PC's own). */
export const MAX_SIDE = 1280;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (ISO 3309, as PNG's chunks use it) of `bytes`, continuing from `crc` (0 to start). */
export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** One PNG chunk: length, type, data and the CRC of type and data. */
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(data, crc32(head.subarray(4, 8))), 0);
  return Buffer.concat([head, data, crc]);
}

/** RGBA pixels (alpha dropped: every pixel is opaque) as a PNG: 8-bit RGB, no interlace, filter 0 on each row. */
export function encodePng(rgba: Buffer, width: number, height: number): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error("a PNG needs a positive size");
  if (rgba.length !== width * height * 4) throw new Error("the pixels don't match the size");
  const stride = width * 3 + 1;
  const raw = Buffer.allocUnsafe(stride * height);
  for (let y = 0; y < height; y++) {
    let o = y * stride;
    raw[o++] = 0;
    let i = y * width * 4;
    for (let x = 0; x < width; x++, i += 4) {
      raw[o++] = rgba[i];
      raw[o++] = rgba[i + 1];
      raw[o++] = rgba[i + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // filter method 0
  ihdr[12] = 0; // no interlace
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Is this capture's answer still to come? (X11's synchronous image is a plain object without `then`.) */
function isPromiseLike<T>(v: T | PromiseLike<T>): v is PromiseLike<T> {
  return typeof (v as { then?: unknown } | null)?.then === "function";
}

/**
 * captureRect's twin for the remote: captures `rect` (screen pixels), blacks out `mask` and what `maskAfter` names
 * (null from it: no image), downscales to `maxSide` (default 1280) and encodes PNG whatever `format` asks. `rect` of the
 * result is what was captured (clipped to the screen); image px = (screen px - rect.x|y) * scale.
 */
export async function remoteCapture(x11: Pick<PerceptionWindows, "capture">, rect: Bounds, opts: CaptureOptions = {}): Promise<Capture | null> {
  const show = opts.hideOverlay ? await opts.hideOverlay() : null;
  let img: X11Image | null;
  try {
    const r = x11.capture(Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height));
    img = isPromiseLike(r) ? await r : r;
  } finally {
    show?.();
  }
  if (!img || img.width < 1 || img.height < 1 || img.bgra.length < img.width * img.height * 4) return null;
  const after = opts.maskAfter ? await opts.maskAfter() : [];
  if (after === null) return null;
  const origin: Bounds = { x: img.x, y: img.y, width: img.width, height: img.height };
  const rgba = bgraToRgba(img.bgra.subarray(0, img.width * img.height * 4));
  for (const m of [...opts.mask ?? [], ...after]) {
    maskRect(rgba, img.width, img.height, { x: m.x - origin.x, y: m.y - origin.y, width: m.width, height: m.height });
  }
  const small = downscale(rgba, img.width, img.height, opts.maxSide ?? MAX_SIDE);
  return { rect: origin, data: encodePng(small.rgba, small.width, small.height), mimeType: "image/png", width: small.width, height: small.height, scale: small.scale };
}
