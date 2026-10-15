/** Where the ask box and the desk view go on the screen (small screens and Ember near an edge included). */

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: class {}, screen: {}, ipcMain: { on() {} } }));

const { askBounds } = await import("../../app/main/ask");
const { deskViewBounds } = await import("../../app/main/desk/view");

type Box = { x: number; y: number; width: number; height: number };
const inside = (b: Box, wa: Box) => b.x >= wa.x && b.y >= wa.y && b.x + b.width <= wa.x + wa.width && b.y + b.height <= wa.y + wa.height;
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

describe("askBounds", () => {
  const wa = { x: 0, y: 0, width: 1024, height: 600 };
  /** Ember from the top of its head to its hands, around its centre. */
  const ember = (c: { x: number; y: number }, size: number) => ({ x: c.x - size * 0.75, y: c.y - size * 0.5, width: size * 1.5, height: size * 0.9 });
  /** The box's hint row, under the field (the window is inset 10 px). */
  const hintRow = (b: Box) => ({ x: b.x + 10, y: b.y + 60, width: b.width - 20, height: 21 });

  it("sits above Ember, centred", () => {
    expect(askBounds({ x: 500, y: 300 }, wa)).toEqual({ x: 220, y: 186, width: 560, height: 92 });
  });

  it("goes below Ember near the top of the screen instead of over it", () => {
    for (const size of [40, 60, 110]) {
      for (const y of [size, 60, 90, 120]) {
        const c = { x: 66, y };
        const b = askBounds({ ...c, size }, wa);
        expect(inside(b, wa), `${size} at ${y}`).toBe(true);
        expect(overlaps(hintRow(b), ember(c, size)), `${size} at ${y}`).toBe(false);
        expect(overlaps({ x: b.x + 10, y: b.y + 10, width: b.width - 20, height: 46 }, ember(c, size)), `${size} at ${y}`).toBe(false);
      }
    }
  });

  it("keeps the hint row clear of a large Ember above it too", () => {
    const c = { x: 500, y: 400 };
    expect(overlaps(hintRow(askBounds({ ...c, size: 110 }, wa)), ember(c, 110))).toBe(false);
  });

  it("without Ember, sits low in the middle", () => {
    expect(askBounds(null, wa)).toEqual({ x: 232, y: 418, width: 560, height: 92 });
  });
});

describe("deskViewBounds", () => {
  const handle = (wa: Box) => ({ x: wa.x + wa.width - 212, y: wa.y + wa.height - 68, width: 200, height: 56 });

  it("is the usual size on a large screen, bottom-left", () => {
    const wa = { x: 0, y: 0, width: 1920, height: 1080 };
    const small = deskViewBounds({ x: 16, y: 0, width: 0, height: 1080 }, false, wa);
    expect(small).toEqual({ x: 16, y: 826, width: 340, height: 238 });
    expect(deskViewBounds(small, true, wa)).toEqual({ x: 16, y: 418, width: 980, height: 646 });
  });

  it("takes over within a 1024 × 600 screen, clear of the handle, and hands back on screen", () => {
    const wa = { x: 0, y: 0, width: 1024, height: 600 };
    const small = deskViewBounds({ x: 16, y: 0, width: 0, height: 600 }, false, wa);
    const large = deskViewBounds(small, true, wa);
    expect(inside(large, wa)).toBe(true);
    expect(overlaps(large, handle(wa))).toBe(false);
    expect(large.width / large.height).toBeCloseTo(980 / 646, 2);
    expect(large.y + large.height).toBe(small.y + small.height);
    const back = deskViewBounds(large, false, wa);
    expect(back).toEqual(small);
  });

  it("keeps its bottom edge on screen wherever it was dragged", () => {
    const wa = { x: 0, y: 27, width: 1280, height: 773 };
    for (const b of [{ x: 900, y: 700, width: 340, height: 238 }, { x: -50, y: 0, width: 340, height: 238 }, { x: 16, y: 600, width: 980, height: 646 }]) {
      for (const large of [false, true]) expect(inside(deskViewBounds(b, large, wa), wa), JSON.stringify([b, large])).toBe(true);
    }
  });
});
