import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { captureRect } from "../../app/main/perception/capture";
import { Perception } from "../../app/main/perception";
import type { AtspiSidecar, Bounds } from "../../app/main/perception/sidecar";
import type { X11, X11Image } from "../../app/main/x11";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const SCREEN = { width: 300, height: 200 };

/** A pretend X server: a grey screen, clipped like the real x11.capture. */
function fakeX11(onCapture: () => void = () => undefined): X11 {
  return {
    capture(x: number, y: number, width: number, height: number): X11Image | null {
      onCapture();
      const x0 = Math.max(0, x), y0 = Math.max(0, y);
      const x1 = Math.min(SCREEN.width, x + width), y1 = Math.min(SCREEN.height, y + height);
      if (x1 <= x0 || y1 <= y0) return null;
      return { x: x0, y: y0, width: x1 - x0, height: y1 - y0, bgra: Buffer.alloc((x1 - x0) * (y1 - y0) * 4, 200) };
    },
    focusWindow: () => null,
    activeWindow: () => null,
    clientWindows: () => [],
  } as unknown as X11;
}

async function pixel(data: Buffer, x: number, y: number): Promise<number[]> {
  const { data: raw, info } = await sharp(data).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [raw[i], raw[i + 1], raw[i + 2]];
}

describe("captureRect", () => {
  it("records the part of the rectangle that is on screen, and masks and marks relative to it", async () => {
    let origin: Bounds | null = null;
    const c = await captureRect(fakeX11(), { x: -50, y: 20, width: 150, height: 100 }, {
      format: "png",
      mask: [{ x: 0, y: 20, width: 10, height: 10 }],
      overlaySvg: (_scale, _w, _h, o) => { origin = o; return null; },
    });
    expect(c?.rect).toEqual({ x: 0, y: 20, width: 100, height: 100 });
    expect(origin).toEqual({ x: 0, y: 20, width: 100, height: 100 });
    expect(await pixel(c!.data, 0, 0)).toEqual([0, 0, 0]);
    expect(await pixel(c!.data, 50, 50)).toEqual([200, 200, 200]);
  });

  it("gives nothing for a rectangle entirely off screen", async () => {
    expect(await captureRect(fakeX11(), { x: 400, y: 0, width: 100, height: 100 })).toBeNull();
  });

  it("limits the longer side, so portrait screens are scaled by height", async () => {
    const tall = { capture: () => ({ x: 0, y: 0, width: 800, height: 2000, bgra: Buffer.alloc(800 * 2000 * 4) }) } as unknown as X11;
    const c = await captureRect(tall, { x: 0, y: 0, width: 800, height: 2000 });
    expect(c).toMatchObject({ width: 512, height: 1280, scale: 0.64 });
  });

  it("blacks out where private windows are after the capture too, and fails closed when it can't tell", async () => {
    const after = await captureRect(fakeX11(), { x: 0, y: 0, width: 100, height: 100 }, {
      format: "png", maskAfter: async () => [{ x: 40, y: 40, width: 20, height: 20 }],
    });
    expect(await pixel(after!.data, 50, 50)).toEqual([0, 0, 0]);
    expect(await captureRect(fakeX11(), { x: 0, y: 0, width: 100, height: 100 }, { maskAfter: async () => null })).toBeNull();
  });
});

describe("Perception.perceive screenshots", () => {
  const sidecar = {
    readWindow: async () => ({ window: { app: "gedit", pid: 42, name: "notes.txt", role: "frame", active: true, bounds: { x: 1000, y: 1000, width: 50, height: 50 } }, nodes: [], ms: 1 }),
    listWindows: async () => ({ windows: [] }),
  } as unknown as AtspiSidecar;

  it("says why there is no screenshot", async () => {
    const p = new Perception({ sidecar, x11: fakeX11(), neverLook: () => [], screenBounds: () => ({ x: 0, y: 0, ...SCREEN }), log: quiet });
    const off = await p.perceive({ image: true, scope: "window" });
    expect(off.capture).toBeNull();
    expect(off.text).toContain("(No screenshot: the window is off screen");
    const none = await new Perception({ sidecar, x11: null, neverLook: () => [], screenBounds: () => ({ x: 0, y: 0, ...SCREEN }), log: quiet })
      .perceive({ image: true, scope: "window" });
    expect(none.text).toContain("(No screenshot:");
  });

  it("keeps Ember hidden until the last of several overlapping captures is done", async () => {
    let hidden = false, hides = 0, shows = 0;
    const seenHidden: boolean[] = [];
    const p = new Perception({
      sidecar, x11: fakeX11(() => seenHidden.push(hidden)), neverLook: () => [], screenBounds: () => ({ x: 0, y: 0, ...SCREEN }), log: quiet,
      hideOverlay: async () => {
        hides++;
        hidden = true;
        await new Promise(r => setTimeout(r, 30));
        return () => { shows++; hidden = false; };
      },
    });
    const a = p.perceive({ image: true, scope: "screen" });
    await new Promise(r => setTimeout(r, 10));
    const b = p.perceive({ image: true, scope: "screen" });
    const [ca, cb] = await Promise.all([a, b]);
    expect(ca.capture && cb.capture).toBeTruthy();
    expect(seenHidden).toEqual([true, true]);
    expect([hides, shows, hidden]).toEqual([1, 1, false]);
    // The next capture hides again.
    await p.perceive({ image: true, scope: "screen" });
    expect([hides, shows]).toEqual([2, 2]);
  });
});
