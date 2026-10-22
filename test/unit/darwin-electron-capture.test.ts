/**
 * The macOS capture over Electron's desktopCapturer (design §8.2), with a fake desktopCapturer and screen: thumbnails
 * are asked for at the largest touched display's point size, each display's real thumbnail size goes to port/darwin's
 * composePoints (no NativeImage crop or resize), and anything short of every touched display (a missing display_id, an
 * empty thumbnail, a rejection, a timeout) gives no picture at all.
 */

import { describe, expect, it, vi } from "vitest";
import type { CaptureScreen, DesktopCapturerLike, DisplayLike, NativeImageLike, Rect } from "../../app/main/platform/types";
import { composePoints } from "../../app/main/platform/darwin/capture";
import { electronCapture } from "../../app/main/platform/darwin/electron-capture";

/** A thumbnail filled with one BGRA colour; crop and resize must never be called (they run on Electron's main thread). */
function thumb(width: number, height: number, bgra: [number, number, number, number] = [10, 20, 30, 255]): NativeImageLike {
  const px = Buffer.alloc(width * height * 4);
  for (let i = 0; i < px.length; i += 4) px.set(bgra, i);
  return {
    isEmpty: () => width === 0 || height === 0,
    getSize: () => ({ width, height }),
    crop: () => { throw new Error("crop called"); },
    resize: () => { throw new Error("resize called"); },
    toBitmap: () => px,
  };
}

const display = (id: number, bounds: Rect, scaleFactor = 2): DisplayLike => ({ id, bounds, scaleFactor, size: { width: bounds.width, height: bounds.height } });

function screenOf(displays: DisplayLike[]): CaptureScreen {
  return { getPrimaryDisplay: () => displays[0]!, getAllDisplays: () => displays };
}

type Sources = Awaited<ReturnType<DesktopCapturerLike["getSources"]>>;
function capturer(sources: Sources | (() => Promise<Sources>)) {
  const getSources = vi.fn((_o: Parameters<DesktopCapturerLike["getSources"]>[0]) => (typeof sources === "function" ? sources() : Promise.resolve(sources)));
  return { getSources };
}

const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(), file: "" });

describe("electronCapture", () => {
  const left = display(1, { x: 0, y: 0, width: 1440, height: 900 });
  const right = display(2, { x: 1440, y: 0, width: 1920, height: 1080 }, 1);

  it("asks once for screen thumbnails at the largest touched display's point size, without window icons", async () => {
    const dc = capturer([
      { id: "screen:1:0", name: "A", display_id: "1", thumbnail: thumb(1728, 1080) },
      { id: "screen:2:0", name: "B", display_id: "2", thumbnail: thumb(1920, 1080) },
    ]);
    const img = await electronCapture({ desktopCapturer: dc, screen: screenOf([left, right]) })({ x: 1400, y: 100, width: 80, height: 50 });
    expect(dc.getSources).toHaveBeenCalledTimes(1);
    expect(dc.getSources.mock.calls[0]![0]).toEqual({ types: ["screen"], thumbnailSize: { width: 1920, height: 1080 }, fetchWindowIcons: false });
    expect(img).not.toBeNull();
    expect({ x: img!.x, y: img!.y, width: img!.width, height: img!.height }).toEqual({ x: 1400, y: 100, width: 80, height: 50 });
  });

  it("composes the displays' bitmaps at their real thumbnail sizes through composePoints", async () => {
    const a = thumb(1728, 1080, [0, 0, 255, 255]), b = thumb(1920, 1080, [255, 0, 0, 255]);
    const dc = capturer([
      { id: "screen:2:0", name: "B", display_id: "2", thumbnail: b },
      { id: "screen:1:0", name: "A", display_id: "1", thumbnail: a },
    ]);
    const rect = { x: 1430, y: 10, width: 20, height: 4 };
    const img = await electronCapture({ desktopCapturer: dc, screen: screenOf([left, right]) })(rect);
    const expected = composePoints([
      { bounds: left.bounds, width: 1728, height: 1080, bgra: a.toBitmap() },
      { bounds: right.bounds, width: 1920, height: 1080, bgra: b.toBitmap() },
    ], rect);
    expect(img).toEqual(expected);
    // Left half red (B=0,G=0,R=255), right half blue.
    expect([...img!.bgra.subarray(0, 4)]).toEqual([0, 0, 255, 255]);
    expect([...img!.bgra.subarray(19 * 4, 20 * 4)]).toEqual([255, 0, 0, 255]);
  });

  it("asks only for the displays the rectangle touches", async () => {
    const dc = capturer([{ id: "screen:1:0", name: "A", display_id: "1", thumbnail: thumb(1440, 900) }]);
    const img = await electronCapture({ desktopCapturer: dc, screen: screenOf([left, right]) })({ x: 10, y: 10, width: 5, height: 5 });
    expect(dc.getSources.mock.calls[0]![0].thumbnailSize).toEqual({ width: 1440, height: 900 });
    expect(img?.width).toBe(5);
  });

  it("works left of and above the primary display (negative origins)", async () => {
    const west = display(7, { x: -1280, y: -200, width: 1280, height: 800 });
    const dc = capturer([{ id: "screen:7:0", name: "W", display_id: "7", thumbnail: thumb(2560, 1600, [1, 2, 3, 255]) }]);
    const img = await electronCapture({ desktopCapturer: dc, screen: screenOf([left, west]) })({ x: -100, y: -150, width: 10, height: 10 });
    expect(img).not.toBeNull();
    expect({ x: img!.x, y: img!.y }).toEqual({ x: -100, y: -150 });
    expect([...img!.bgra.subarray(0, 4)]).toEqual([1, 2, 3, 255]);
  });

  it("gives no picture when a touched display has no source with its display_id", async () => {
    const l = log();
    const dc = capturer([{ id: "screen:1:0", name: "A", display_id: "1", thumbnail: thumb(1440, 900) }]);
    expect(await electronCapture({ desktopCapturer: dc, screen: screenOf([left, right]), log: l })({ x: 1400, y: 0, width: 100, height: 10 })).toBeNull();
    expect(l.warn).toHaveBeenCalledWith("capture.display_missing", expect.objectContaining({ display: 2 }));
  });

  it("gives no picture for an empty thumbnail", async () => {
    const dc = capturer([{ id: "screen:1:0", name: "A", display_id: "1", thumbnail: thumb(0, 0) }]);
    expect(await electronCapture({ desktopCapturer: dc, screen: screenOf([left]) })({ x: 0, y: 0, width: 10, height: 10 })).toBeNull();
  });

  it("gives no picture for a bitmap shorter than its size says", async () => {
    const short: NativeImageLike = { ...thumb(10, 10), getSize: () => ({ width: 1440, height: 900 }) };
    const dc = capturer([{ id: "screen:1:0", name: "A", display_id: "1", thumbnail: short }]);
    expect(await electronCapture({ desktopCapturer: dc, screen: screenOf([left]) })({ x: 0, y: 0, width: 10, height: 10 })).toBeNull();
  });

  it("gives no picture for a bitmap longer than its size says (it would be read with the wrong stride)", async () => {
    // A Retina-sized bitmap behind a point-sized getSize(), or padded rows: never a sheared picture.
    const long: NativeImageLike = { ...thumb(2880, 1800), getSize: () => ({ width: 1440, height: 900 }) };
    const dc = capturer([{ id: "screen:1:0", name: "A", display_id: "1", thumbnail: long }]);
    expect(await electronCapture({ desktopCapturer: dc, screen: screenOf([left]) })({ x: 0, y: 0, width: 10, height: 10 })).toBeNull();
  });

  it("gives no picture when desktopCapturer rejects", async () => {
    const l = log();
    const dc = capturer(() => Promise.reject(new Error("denied")));
    expect(await electronCapture({ desktopCapturer: dc, screen: screenOf([left]), log: l })({ x: 0, y: 0, width: 10, height: 10 })).toBeNull();
    expect(l.warn).toHaveBeenCalledWith("capture.failed", expect.anything());
  });

  it("gives no picture when desktopCapturer doesn't answer in time", async () => {
    vi.useFakeTimers();
    try {
      const l = log();
      const dc = capturer(() => new Promise<Sources>(() => { /* never settles */ }));
      const pending = electronCapture({ desktopCapturer: dc, screen: screenOf([left]), log: l, timeoutMs: 3000 })({ x: 0, y: 0, width: 10, height: 10 });
      await vi.advanceTimersByTimeAsync(2999);
      let settled = false;
      void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBeNull();
      expect(l.warn).toHaveBeenCalledWith("capture.timeout", { ms: 3000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks nothing when no display touches the rectangle, or the displays can't be read", async () => {
    const dc = capturer([]);
    expect(await electronCapture({ desktopCapturer: dc, screen: screenOf([left]) })({ x: 5000, y: 0, width: 10, height: 10 })).toBeNull();
    const broken: CaptureScreen = { getPrimaryDisplay: () => { throw new Error("before ready"); }, getAllDisplays: () => { throw new Error("before ready"); } };
    expect(await electronCapture({ desktopCapturer: dc, screen: broken })({ x: 0, y: 0, width: 10, height: 10 })).toBeNull();
    expect(dc.getSources).not.toHaveBeenCalled();
  });

  it("swaps red and blue when the bitmap is RGBA", async () => {
    const t = thumb(1440, 900, [255, 0, 0, 255]);
    const dc = capturer([{ id: "screen:1:0", name: "A", display_id: "1", thumbnail: t }]);
    const img = await electronCapture({ desktopCapturer: dc, screen: screenOf([left]), order: "rgba" })({ x: 0, y: 0, width: 2, height: 2 });
    expect([...img!.bgra.subarray(0, 4)]).toEqual([0, 0, 255, 255]);
    expect([...t.toBitmap().subarray(0, 4)]).toEqual([255, 0, 0, 255]); // the thumbnail's own buffer is left alone
  });
});
