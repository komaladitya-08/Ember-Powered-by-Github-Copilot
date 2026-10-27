/** Where the ask box and the desk view go on the screen (small screens and Ember near an edge included). */

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: class {}, screen: {}, ipcMain: { on() {} } }));

const { askBounds, grownBounds } = await import("../../app/main/ask");
const { deskViewBounds } = await import("../../app/main/desk/view");
const { foldCount, foldedLine, stackOrder } = await import("../../app/renderer/overlay/stack");

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

  it("keeps clear of the handle card in the corner (no compositor), whatever its height", () => {
    for (const screen of [{ x: 0, y: 0, width: 1280, height: 800 }, wa, { x: 0, y: 27, width: 1280, height: 773 }]) {
      for (const h of [120, 150, 260, 360]) {
        const card = { x: screen.x + screen.width - 372, y: screen.y + screen.height - 12 - h, width: 360, height: h };
        const b = askBounds(null, screen, card);
        expect(inside(b, screen), `${screen.width}x${screen.height} ${h}`).toBe(true);
        expect(overlaps(b, card), `${screen.width}x${screen.height} ${h}`).toBe(false);
      }
    }
    // Clear of it already: where it always goes.
    expect(askBounds(null, wa, { x: 0, y: 0, width: 50, height: 50 })).toEqual(askBounds(null, wa));
  });

  it("keeps clear of the pill when Ember is beside it in the corner", () => {
    const pill = { x: 812, y: 532, width: 200, height: 56 };
    for (const c of [{ x: 900, y: 540 }, { x: 980, y: 500 }, { x: 700, y: 560 }]) {
      const b = askBounds({ ...c, size: 60 }, wa, pill);
      expect(overlaps(b, pill), JSON.stringify(c)).toBe(false);
      expect(overlaps(hintRow(b), ember(c, 60)), JSON.stringify(c)).toBe(false);
    }
  });
});

describe("grownBounds (review #70: the field grows to four lines)", () => {
  const wa = { x: 0, y: 0, width: 1024, height: 600 };

  it("grows upward above Ember, so the hint row stays where it was, and back down to one line", () => {
    const b = askBounds({ x: 500, y: 300 }, wa);
    const tall = grownBounds(b, 4, wa, true);
    expect(tall).toEqual({ ...b, height: 92 + 3 * 24, y: b.y + b.height - (92 + 3 * 24) });
    expect(grownBounds(tall, 1, wa, true)).toEqual(b);
    // Never more than four lines, never less than one.
    expect(grownBounds(b, 9, wa, true).height).toBe(164);
    expect(grownBounds(b, 0, wa, true).height).toBe(92);
  });

  it("grows downward below Ember (near the top of the screen), and stays inside the work area", () => {
    const b = askBounds({ x: 500, y: 20 }, wa);
    expect(grownBounds(b, 3, wa, false)).toEqual({ ...b, height: 140 });
    const low = { x: 200, y: 500, width: 560, height: 92 };
    expect(inside(grownBounds(low, 4, wa, false), wa)).toBe(true);
    const high = { x: 200, y: 10, width: 560, height: 92 };
    expect(inside(grownBounds(high, 4, wa, true), wa)).toBe(true);
  });

  it("keeps clear of the pill as it grows", () => {
    const pill = { x: 812, y: 532, width: 200, height: 56 };
    const b = askBounds({ x: 900, y: 540, size: 60 }, wa, pill);
    expect(overlaps(grownBounds(b, 4, wa, false, pill), pill)).toBe(false);
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

  it("takes over clear of the wider handle card (no compositor) on 1280 × 800 and 1024 × 600", () => {
    for (const wa of [{ x: 0, y: 0, width: 1280, height: 800 }, { x: 0, y: 0, width: 1024, height: 600 }, { x: 0, y: 27, width: 1280, height: 773 }]) {
      for (const h of [120, 360]) {
        const card = { x: wa.x + wa.width - 372, y: wa.y + wa.height - 12 - h, width: 360, height: h };
        const small = deskViewBounds({ x: 16, y: wa.y, width: 0, height: wa.height }, false, wa, card);
        const large = deskViewBounds(small, true, wa, card);
        for (const b of [small, large]) {
          expect(inside(b, wa), `${wa.width} ${h}`).toBe(true);
          expect(b.x + b.width + 12 <= card.x, `${wa.width} ${h}`).toBe(true);
        }
        expect(large.width / large.height).toBeCloseTo(980 / 646, 2);
        expect(deskViewBounds(large, false, wa, card)).toEqual(small);
        // Dragged towards the card first: it still grows clear of it.
        expect(overlaps(deskViewBounds({ ...small, x: wa.width - 400 }, true, wa, card), card)).toBe(false);
      }
    }
  });

  it("makes room for the pill when the handle's place isn't known", () => {
    const wa = { x: 0, y: 0, width: 1024, height: 600 };
    const small = deskViewBounds({ x: 16, y: 0, width: 0, height: 600 }, false, wa);
    expect(deskViewBounds(small, true, wa, null)).toEqual(deskViewBounds(small, true, wa));
    // A handle on another screen: the same.
    expect(deskViewBounds(small, true, wa, { x: 3000, y: 0, width: 360, height: 150 })).toEqual(deskViewBounds(small, true, wa));
    expect(overlaps(deskViewBounds(small, true, wa, null), handle(wa))).toBe(false);
  });

  it("keeps its bottom edge on screen wherever it was dragged", () => {
    const wa = { x: 0, y: 27, width: 1280, height: 773 };
    for (const b of [{ x: 900, y: 700, width: 340, height: 238 }, { x: -50, y: 0, width: 340, height: 238 }, { x: 16, y: 600, width: 980, height: 646 }]) {
      for (const large of [false, true]) expect(inside(deskViewBounds(b, large, wa), wa), JSON.stringify([b, large])).toBe(true);
    }
  });
});

describe("task card stack", () => {
  type Card = Parameters<typeof stackOrder>[0][number];
  const card = (id: string, status: Card["status"]): Card => ({
    id, title: id, status, detail: "",
    actions: status === "running" || status === "waiting" ? [{ id: `task:${id}:stop`, label: "Stop" }] : status === "failed" ? [{ id: `task:${id}:dismiss`, label: "Close" }] : [],
  });

  it("puts the tasks under way nearest the handle, in their order", () => {
    const tasks = [card("r1", "running"), card("f1", "failed"), card("w1", "waiting"), card("d1", "done"), card("f2", "failed")];
    expect(stackOrder(tasks).map(t => t.id)).toEqual(["f1", "d1", "f2", "r1", "w1"]);
  });

  it("folds the oldest ended cards until the stack fits, never a task under way", () => {
    // Four failures (96 px) above one running task (78 px), 8 px apart; the "+N more" line is 44 px.
    const heights = [96, 96, 96, 96, 78];
    expect(foldCount(heights, 4, 1000, 8, 44)).toBe(0);
    // 418 px above the handle: the two oldest fold, and what is left (with the line) fits.
    const k = foldCount(heights, 4, 418, 8, 44);
    expect(k).toBe(2);
    expect(heights.slice(k).reduce((a, h) => a + h, 0) + 44 + 8 * (heights.length - k)).toBeLessThanOrEqual(418);
    // Even the tasks under way don't fit: every ended card folds (the stack scrolls), none under way.
    expect(foldCount([96, 78, 78, 78], 1, 150, 8, 44)).toBe(1);
    expect(foldCount([78, 78], 0, 100, 8, 44)).toBe(0);
  });

  it("says how many folded and closes only the failures among them", () => {
    const line = foldedLine([card("f1", "failed"), card("d1", "done"), card("f2", "failed")]);
    expect(line).toEqual({ title: "+3 more", detail: "Ended earlier", close: ["task:f1:dismiss", "task:f2:dismiss"] });
    expect(foldedLine([card("d1", "done")]).close).toEqual([]);
  });
});
