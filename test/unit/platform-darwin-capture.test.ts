/**
 * The macOS capture contract: nothing is captured without a capture function or the Screen Recording permission
 * (macOS would hand out the wallpaper instead of an error), the request is clipped to the screen (negative
 * coordinates included), only an image of exactly the clipped rectangle at one pixel per point is accepted, and
 * composePoints() turns each display's bitmap (pixels) into points: 2×2 blocks averaged on Retina, displays
 * stitched, uncovered points black.
 */

import { describe, expect, it, vi } from "vitest";
import { acceptImage, captureRect, clipToScreen, composePoints, type DisplayBitmap } from "../../app/main/platform/darwin/capture";
import type { Rect, X11Image } from "../../app/main/platform/types";

const SCREEN: Rect = { x: -1280, y: 0, width: 2720, height: 900 };
const exact = async (r: Rect): Promise<X11Image> => ({ ...r, bgra: Buffer.alloc(r.width * r.height * 4, 7) });

describe("clipping a capture to the screen", () => {
  it("clips to the screen, which may start left of the main display", () => {
    expect(clipToScreen(-1300, -10, 100, 50, SCREEN)).toEqual({ x: -1280, y: 0, width: 80, height: 40 });
    expect(clipToScreen(10.7, 20.2, 30, 40, SCREEN)).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });
  it("gives nothing for a rectangle off the screen, empty, or when the screen is unknown", () => {
    expect(clipToScreen(1500, 0, 10, 10, SCREEN)).toBeNull();
    expect(clipToScreen(0, 0, 0, 10, SCREEN)).toBeNull();
    expect(clipToScreen(0, 0, 10, 10, null)).toBeNull();
    expect(clipToScreen(NaN, 0, 10, 10, SCREEN)).toBeNull();
  });
});

describe("capturing on macOS", () => {
  it("captures nothing without a capture function", () => {
    expect(captureRect({ screenAccess: () => true, screen: SCREEN }, 0, 0, 10, 10)).toBeNull();
  });

  it("never calls the capture function without the Screen Recording permission, or when it can't be checked", () => {
    const capture = vi.fn(exact);
    expect(captureRect({ capture, screenAccess: () => false, screen: SCREEN }, 0, 0, 10, 10)).toBeNull();
    expect(captureRect({ capture, screenAccess: () => { throw new Error("no"); }, screen: SCREEN }, 0, 0, 10, 10)).toBeNull();
    expect(capture).not.toHaveBeenCalled();
  });

  it("asks for the clipped rectangle and passes its image on", async () => {
    const capture = vi.fn(exact);
    const img = await captureRect({ capture, screenAccess: () => true, screen: SCREEN }, -1290.5, 10, 30, 20)!;
    expect(capture).toHaveBeenCalledWith({ x: -1280, y: 10, width: 19, height: 20 });
    expect(img).toMatchObject({ x: -1280, y: 10, width: 19, height: 20 });
  });

  it("refuses an image that isn't exactly the rectangle at one pixel per point (masks would land in the wrong place)", async () => {
    const o = { screenAccess: () => true, screen: SCREEN };
    const retina = async (r: Rect) => ({ ...r, width: r.width * 2, height: r.height * 2, bgra: Buffer.alloc(r.width * r.height * 16) });
    expect(await captureRect({ ...o, capture: retina }, 0, 0, 10, 10)).toBeNull();
    const short = async (r: Rect) => ({ ...r, bgra: Buffer.alloc(4) });
    expect(await captureRect({ ...o, capture: short }, 0, 0, 10, 10)).toBeNull();
    const moved = async (r: Rect) => ({ ...r, x: r.x + 1, bgra: Buffer.alloc(r.width * r.height * 4) });
    expect(await captureRect({ ...o, capture: moved }, 0, 0, 10, 10)).toBeNull();
    expect(await captureRect({ ...o, capture: async () => null }, 0, 0, 10, 10)).toBeNull();
  });

  it("answers null when the capture function fails, at once or later", async () => {
    const o = { screenAccess: () => true, screen: SCREEN };
    expect(captureRect({ ...o, capture: () => { throw new Error("sync"); } }, 0, 0, 10, 10)).toBeNull();
    expect(await captureRect({ ...o, capture: () => Promise.reject(new Error("async")) }, 0, 0, 10, 10)).toBeNull();
  });

  it("accepts only a Buffer of the right size", () => {
    const r = { x: 0, y: 0, width: 2, height: 1 };
    expect(acceptImage({ ...r, bgra: Buffer.alloc(8) }, r)).not.toBeNull();
    expect(acceptImage({ ...r, bgra: new Uint8Array(8) as unknown as Buffer }, r)).toBeNull();
    expect(acceptImage(null, r)).toBeNull();
  });
});

/** A bitmap whose pixel (px, py) has blue = px, green = py, red = 200. */
function bitmap(bounds: Rect, width: number, height: number): DisplayBitmap {
  const bgra = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) bgra.set([x, y, 200, 255], (y * width + x) * 4);
  return { bounds, width, height, bgra };
}
const px = (img: X11Image, x: number, y: number) => [...img.bgra.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

describe("turning display bitmaps into points", () => {
  it("averages each 2×2 block of a Retina display into one point", () => {
    const img = composePoints([bitmap({ x: 0, y: 0, width: 4, height: 3 }, 8, 6)], { x: 1, y: 1, width: 2, height: 2 });
    expect([img.x, img.y, img.width, img.height]).toEqual([1, 1, 2, 2]);
    expect(px(img, 0, 0)).toEqual([3, 3, 200, 255]); // pixels 2..3 × 2..3 averaged (2.5 rounds to 3)
    expect(px(img, 1, 1)).toEqual([5, 5, 200, 255]);
  });

  it("copies a 1× display pixel for pixel", () => {
    const img = composePoints([bitmap({ x: 0, y: 0, width: 4, height: 4 }, 4, 4)], { x: 0, y: 0, width: 4, height: 4 });
    expect(px(img, 3, 2)).toEqual([3, 2, 200, 255]);
  });

  it("stitches displays, one left of the main display, and leaves points no display covers black", () => {
    const left = bitmap({ x: -2, y: 0, width: 2, height: 2 }, 2, 2);
    const main = bitmap({ x: 0, y: 0, width: 2, height: 2 }, 4, 4);
    const img = composePoints([left, main], { x: -2, y: 0, width: 4, height: 3 });
    expect(px(img, 0, 0)).toEqual([0, 0, 200, 255]); // the left display's first pixel
    expect(px(img, 1, 1)).toEqual([1, 1, 200, 255]);
    expect(px(img, 2, 0)).toEqual([1, 1, 200, 255]); // the main display's first 2×2 block
    expect(px(img, 0, 2)).toEqual([0, 0, 0, 255]); // below both displays
  });

  it("takes the nearest pixel when a bitmap is smaller than its display", () => {
    const img = composePoints([bitmap({ x: 0, y: 0, width: 4, height: 4 }, 2, 2)], { x: 0, y: 0, width: 4, height: 4 });
    expect(px(img, 0, 0)).toEqual([0, 0, 200, 255]);
    expect(px(img, 3, 3)).toEqual([1, 1, 200, 255]);
  });

  it("skips a bitmap that is shorter than it says", () => {
    const broken = { ...bitmap({ x: 0, y: 0, width: 2, height: 2 }, 2, 2), bgra: Buffer.alloc(4, 9) };
    expect(px(composePoints([broken], { x: 0, y: 0, width: 2, height: 2 }), 0, 0)).toEqual([0, 0, 0, 255]);
  });
});
