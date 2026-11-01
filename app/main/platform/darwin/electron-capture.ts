/**
 * The capture function the macOS window system is given (port/darwin's DarwinCapture): the screen inside a rectangle
 * of global points, as BGRA at one pixel per point, taken through Electron's desktopCapturer (CGWindowListCreateImage
 * is obsoleted in the macOS 15 SDK, and ScreenCaptureKit has no koffi-friendly API). captureRect has already checked
 * the Screen Recording permission (without it macOS hands out the wallpaper instead of an error) and clipped the
 * rectangle to the screen. Thumbnails are requested at the displays' point size, so Chromium scales each display while
 * it makes the thumbnail and no 5K bitmap is decoded, cropped or resized on Electron's main thread; composePoints does
 * the rest. Any display it can't match, an empty thumbnail, a rejection or a timeout gives null: never part of a picture.
 * Plain Node: Electron's objects come in as structural types.
 */

import type { CaptureScreen, DesktopCapturerLike, DisplayLike, Rect, X11Image } from "../types";
import type { Logger } from "../../logger";
import { composePoints, type DarwinCapture, type DisplayBitmap } from "./capture";

/** How long one capture may take before it counts as failed (every display is grabbed: 100–300 ms is usual). */
export const CAPTURE_TIMEOUT_MS = 3000;

/**
 * The byte order of NativeImage.toBitmap() on macOS: BGRA (Chromium's N32 on little-endian). The darwin-system
 * integration test captures a pure red swatch and checks this constant against the bytes it gets, so a build that
 * ever hands out RGBA is caught there and this switches the module to swapping red and blue. On macos-15 with
 * Electron 44 (CI runs 120 to 123) the swatch's centre came back as 00 00 FF FF: BGRA.
 */
export const THUMBNAIL_ORDER: "bgra" | "rgba" = "bgra";

/** What electronCapture() takes from main (all injected: this module never imports Electron). */
export interface ElectronCaptureOptions {
  desktopCapturer: DesktopCapturerLike;
  screen: CaptureScreen;
  log?: Logger;
  /** Default CAPTURE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Seam for the tests: the bitmap's byte order (default THUMBNAIL_ORDER). */
  order?: "bgra" | "rgba";
}

const intersects = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Swaps the first and third byte of every pixel (RGBA ↔ BGRA), in a copy. */
function swapRedBlue(px: Buffer): Buffer {
  const out = Buffer.from(px);
  for (let i = 0; i + 3 < out.length; i += 4) {
    const r = out[i]!;
    out[i] = out[i + 2]!;
    out[i + 2] = r;
  }
  return out;
}

/** `p`, or null when it doesn't settle within `ms` (the timer never outlives the race). */
async function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * port/darwin's DarwinCapture over desktopCapturer: for `rect` (global points, integral, inside the screen) the
 * pixels of every display it touches, composed into one image of exactly `rect`, or null (see the module comment).
 */
export function electronCapture(o: ElectronCaptureOptions): DarwinCapture {
  const timeoutMs = o.timeoutMs ?? CAPTURE_TIMEOUT_MS;
  const order = o.order ?? THUMBNAIL_ORDER;
  return async (rect: Rect): Promise<X11Image | null> => {
    let parts: DisplayLike[];
    try {
      parts = o.screen.getAllDisplays().filter(d => intersects(d.bounds, rect));
    } catch (err) {
      o.log?.warn("capture.displays_unreadable", { err });
      return null;
    }
    if (!parts.length) return null;
    // The largest point size among the displays: each thumbnail fits inside it at (about) one pixel per point.
    const thumbnailSize = {
      width: Math.max(...parts.map(d => Math.round(d.bounds.width))),
      height: Math.max(...parts.map(d => Math.round(d.bounds.height))),
    };
    let sources: Awaited<ReturnType<DesktopCapturerLike["getSources"]>> | null;
    const started = Date.now();
    try {
      sources = await within(o.desktopCapturer.getSources({ types: ["screen"], thumbnailSize, fetchWindowIcons: false }), timeoutMs);
    } catch (err) {
      o.log?.warn("capture.failed", { err });
      return null;
    }
    if (!sources) {
      o.log?.warn("capture.timeout", { ms: timeoutMs });
      return null;
    }
    const bitmaps: DisplayBitmap[] = [];
    for (const d of parts) {
      const source = sources.find(s => s.display_id === String(d.id));
      if (!source || source.thumbnail.isEmpty()) {
        // A display desktopCapturer didn't list (or gave nothing for) would be a hole in the picture: send none.
        // R5: display_id is sometimes empty; the ids listed say so in the log, and no source is guessed.
        o.log?.warn("capture.display_missing", { display: d.id, listed: sources.map(s => s.display_id), empty: !!source });
        return null;
      }
      const size = source.thumbnail.getSize();
      const px = source.thumbnail.toBitmap();
      // Exactly width × height × 4: a longer buffer (padded rows, or a bitmap at another scale than getSize reports)
      // would be read with the wrong stride and give a sheared picture, so it counts as a failure too.
      if (size.width <= 0 || size.height <= 0 || px.length !== size.width * size.height * 4) {
        o.log?.warn("capture.bad_bitmap", { display: d.id, width: size.width, height: size.height, bytes: px.length });
        return null;
      }
      bitmaps.push({ bounds: d.bounds, width: size.width, height: size.height, bgra: order === "rgba" ? swapRedBlue(px) : px });
    }
    o.log?.debug("capture.done", { displays: bitmaps.length, ms: Date.now() - started });
    return composePoints(bitmaps, rect);
  };
}
