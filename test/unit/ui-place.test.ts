/** Where the ask box and the desk view go on the screen (small screens and Ember near an edge included). */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: class {}, screen: {}, ipcMain: { on() {} } }));

const { askBounds, askSize, clearOfBubble, grownBounds, openingBounds } = await import("../../app/main/ask");
const { deskViewBounds, deskViewStart } = await import("../../app/main/desk/view");
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

describe("grownBounds (review #70: the field grows to four lines, and a row for the note that a paste was cut)", () => {
  const wa = { x: 0, y: 0, width: 1024, height: 600 };

  it("grows upward above Ember, so the hint row stays where it was, and back down to one line", () => {
    const b = askBounds({ x: 500, y: 300 }, wa);
    const tall = grownBounds(b, 4, wa, true);
    expect(tall).toEqual({ ...b, height: 92 + 3 * 24, y: b.y + b.height - (92 + 3 * 24) });
    expect(grownBounds(tall, 1, wa, true)).toEqual(b);
    // Wrapped suggestions can need more rows than the field. Even an excessive request stays inside the work area.
    expect(grownBounds(b, 5, wa, true)).toEqual({ ...b, height: 92 + 4 * 24, y: b.y + b.height - (92 + 4 * 24) });
    expect(grownBounds(b, 9, wa, true).height).toBe(284);
    expect(grownBounds(b, 12, wa, true).height).toBe(356);
    expect(grownBounds(b, 1000, wa, true).height).toBe(wa.height - 16);
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

describe("the ask box beside Ember's bubble (companion-1: it opened on the answer or question it should sit beside)", () => {
  const wa = { x: 0, y: 0, width: 1280, height: 800 };
  const pill = { x: 1072, y: 736, width: 200, height: 56 };
  /** Ember from the top of its head to its hands, around its centre. */
  const ember = (c: { x: number; y: number }, size = 60) => ({ x: c.x - size * 0.75, y: c.y - size * 0.5, width: size * 1.5, height: size * 0.9 });
  const clearOfAll = (b: Box, bubble: Box, c: { x: number; y: number }, label: string) => {
    expect(inside(b, wa), label).toBe(true);
    expect(overlaps(b, bubble), label).toBe(false);
    expect(overlaps(b, pill), label).toBe(false);
    expect(overlaps(b, ember(c)), label).toBe(false);
  };

  it("keeps off an answer below Ember near the top of the screen, where it opens below Ember too", () => {
    // The verifier's run: the pointer at (640, 60), the answer at (665, 155), the box 188 px tall at (407, 149) on it.
    const c = { x: 640, y: 110, size: 60 }, answer = { x: 665, y: 155, width: 330, height: 123 };
    for (const rows of [3, 4, 6]) {
      // Where it opened before: on the answer.
      expect(overlaps(openingBounds(c, wa, pill, 1, rows).bounds, answer), `${rows} rows`).toBe(true);
      const { bounds, up } = openingBounds(c, wa, pill, 1, rows, answer);
      clearOfAll(bounds, answer, c, `${rows} rows: ${JSON.stringify(bounds)}`);
      expect(up, `${rows} rows`).toBe(bounds.y + bounds.height <= c.y);
    }
  });

  it("goes to the other side of Ember from a question above it, and beside the question where there is no room there", () => {
    // The verifier's run: the pointer at (300, 760), the question at (326, 504), the box at (68, 518) over its Allow.
    const question = { x: 326, y: 504, width: 366, height: 152 };
    const low = { x: 300, y: 700, size: 60 };
    const below = openingBounds(low, { ...wa, height: 1024 }, null, 1, 4, question);
    expect(below.bounds.y, JSON.stringify(below)).toBeGreaterThan(low.y);
    expect(below.up).toBe(false);
    expect(overlaps(below.bounds, question)).toBe(false);
    // No room below Ember (the bottom of the screen): beside the question, at the height it would have had.
    const c = { x: 300, y: 740, size: 60 };
    expect(overlaps(openingBounds(c, wa, pill, 1, 4).bounds, question)).toBe(true);
    const { bounds, up } = openingBounds(c, wa, pill, 1, 4, question);
    clearOfAll(bounds, question, c, JSON.stringify(bounds));
    expect(up).toBe(true);
    expect(bounds.y).toBe(openingBounds(c, wa, pill, 1, 4).bounds.y);
  });

  it("opens where it always has when the bubble isn't in its way, or nothing clear of it is left", () => {
    const c = { x: 640, y: 400, size: 60 };
    const usual = openingBounds(c, wa, pill, 1, 4);
    // The answer below-right of Ember, the box above it: as before.
    expect(openingBounds(c, wa, pill, 1, 4, { x: 665, y: 445, width: 330, height: 123 })).toEqual(usual);
    expect(openingBounds(c, wa, pill, 1, 4, null)).toEqual(usual);
    // A bubble as wide as the screen on both sides of Ember: nowhere is clear, so the usual place.
    const huge = { x: 0, y: 100, width: 1280, height: 600 };
    expect(openingBounds(c, wa, pill, 1, 4, huge)).toEqual(usual);
  });

  it("slides aside rather than grow over the bubble as the field gains lines", () => {
    const b = { x: 360, y: 300, width: 560, height: 140 };
    const answer = { x: 700, y: 200, width: 330, height: 120 };
    const grown = clearOfBubble(grownBounds(b, 6, wa, true), wa, answer, pill);
    expect(overlaps(grown, answer)).toBe(false);
    expect(grown.height).toBe(92 + 5 * 24);
    expect(grown.y).toBe(grownBounds(b, 6, wa, true).y);
  });

  /**
   * Where the live sweep found the box on the bubble (Xvfb with a compositor, the mock model): Ember's centre, the
   * bubble as the overlay reported it, on screens without a panel. Each opening reserved 5 rows (Listen once's two, a
   * suggestions row). The box fits beside neither side of the bubble there: it stacks over or under it.
   */
  const sweep: { screen: [number, number]; scale: number; kind: string; ember: { x: number; y: number }; bubble: Box }[] = [
    // A 1024x768 screen at the default text size (a common RHEL 8 VM size): 11 of 14 openings were on the bubble.
    { screen: [1024, 768], scale: 1, kind: "answer, top left", ember: { x: 297, y: 113 }, bubble: { x: 275, y: 155, width: 330, height: 123 } },
    { screen: [1024, 768], scale: 1, kind: "answer, top centre", ember: { x: 559, y: 113 }, bubble: { x: 537, y: 155, width: 330, height: 123 } },
    { screen: [1024, 768], scale: 1, kind: "answer, top right", ember: { x: 821, y: 113 }, bubble: { x: 513, y: 155, width: 330, height: 123 } },
    { screen: [1024, 768], scale: 1, kind: "answer, bottom left", ember: { x: 247, y: 679 }, bubble: { x: 225, y: 484, width: 330, height: 123 } },
    { screen: [1024, 768], scale: 1, kind: "answer, bottom centre", ember: { x: 559, y: 679 }, bubble: { x: 537, y: 484, width: 330, height: 123 } },
    { screen: [1024, 768], scale: 1, kind: "answer, bottom right", ember: { x: 821, y: 660 }, bubble: { x: 513, y: 465, width: 330, height: 123 } },
    { screen: [1024, 768], scale: 1, kind: "question, top centre", ember: { x: 559, y: 113 }, bubble: { x: 537, y: 155, width: 366, height: 152 } },
    { screen: [1024, 768], scale: 1, kind: "question, top right", ember: { x: 821, y: 113 }, bubble: { x: 477, y: 155, width: 366, height: 152 } },
    { screen: [1024, 768], scale: 1, kind: "question, bottom left", ember: { x: 247, y: 679 }, bubble: { x: 225, y: 455, width: 366, height: 152 } },
    { screen: [1024, 768], scale: 1, kind: "question, bottom centre", ember: { x: 559, y: 679 }, bubble: { x: 537, y: 455, width: 366, height: 152 } },
    { screen: [1024, 768], scale: 1, kind: "question, bottom right", ember: { x: 821, y: 660 }, bubble: { x: 477, y: 436, width: 366, height: 152 } },
    // 1280x800 at Larger text: 9 of 14.
    { screen: [1280, 800], scale: 1.3, kind: "answer, top left", ember: { x: 297, y: 113 }, bubble: { x: 275, y: 155, width: 330, height: 185 } },
    { screen: [1280, 800], scale: 1.3, kind: "answer, top centre", ember: { x: 687, y: 113 }, bubble: { x: 665, y: 155, width: 330, height: 185 } },
    { screen: [1280, 800], scale: 1.3, kind: "answer, bottom left", ember: { x: 247, y: 711 }, bubble: { x: 225, y: 454, width: 330, height: 185 } },
    { screen: [1280, 800], scale: 1.3, kind: "answer, bottom centre", ember: { x: 687, y: 711 }, bubble: { x: 665, y: 454, width: 330, height: 185 } },
    { screen: [1280, 800], scale: 1.3, kind: "question, top centre", ember: { x: 687, y: 113 }, bubble: { x: 665, y: 155, width: 366, height: 224 } },
    { screen: [1280, 800], scale: 1.3, kind: "question, top right", ember: { x: 1077, y: 113 }, bubble: { x: 733, y: 155, width: 366, height: 224 } },
    { screen: [1280, 800], scale: 1.3, kind: "question, bottom left", ember: { x: 247, y: 711 }, bubble: { x: 225, y: 415, width: 366, height: 224 } },
    { screen: [1280, 800], scale: 1.3, kind: "question, bottom centre", ember: { x: 687, y: 711 }, bubble: { x: 665, y: 415, width: 366, height: 224 } },
    { screen: [1280, 800], scale: 1.3, kind: "question, bottom right", ember: { x: 1077, y: 692 }, bubble: { x: 733, y: 396, width: 366, height: 224 } },
    // 1366x768 at Larger, and 1280x800 and 1366x768 at Large (the bubble as tall as at Larger: the worst case).
    { screen: [1366, 768], scale: 1.3, kind: "answer, top centre", ember: { x: 730, y: 113 }, bubble: { x: 708, y: 155, width: 330, height: 185 } },
    { screen: [1366, 768], scale: 1.3, kind: "question, bottom centre", ember: { x: 730, y: 679 }, bubble: { x: 708, y: 415, width: 366, height: 224 } },
    { screen: [1280, 800], scale: 1.15, kind: "answer, top centre", ember: { x: 687, y: 113 }, bubble: { x: 665, y: 155, width: 330, height: 185 } },
    { screen: [1280, 800], scale: 1.15, kind: "question, bottom left", ember: { x: 247, y: 711 }, bubble: { x: 225, y: 415, width: 366, height: 224 } },
    { screen: [1366, 768], scale: 1.15, kind: "answer, top centre", ember: { x: 730, y: 113 }, bubble: { x: 708, y: 155, width: 330, height: 185 } },
    { screen: [1366, 768], scale: 1.15, kind: "question, bottom left", ember: { x: 247, y: 679 }, bubble: { x: 225, y: 415, width: 366, height: 224 } },
  ];
  /** Ember from where the box's foot may come above it (askBounds) to where its top may come below it. */
  const emberRoom = (c: { x: number; y: number }, size = 60) => ({ x: c.x - size * 0.75, y: c.y - 22, width: size * 1.5, height: 22 + size * 0.6 });

  it("stacks over or under the bubble where it fits beside neither, at every text size, on 1024-, 1280- and 1366-wide screens (companion-1)", () => {
    for (const s of sweep) {
      const area = { x: 0, y: 0, width: s.screen[0], height: s.screen[1] };
      const handle = { x: area.width - 12 - Math.round(200 * s.scale), y: area.height - 12 - 56, width: Math.round(200 * s.scale), height: 56 };
      const near = { ...s.ember, size: 60 };
      const label = `${s.screen.join("x")} at ${s.scale}, ${s.kind}`;
      // Where it opened before: on the bubble.
      expect(overlaps(openingBounds(near, area, handle, s.scale, 5).bounds, s.bubble), label).toBe(true);
      const { bounds, up } = openingBounds(near, area, handle, s.scale, 5, s.bubble);
      const at = `${label}: ${JSON.stringify(bounds)}`;
      expect(inside(bounds, area), at).toBe(true);
      expect(overlaps(bounds, s.bubble), at).toBe(false);
      expect(overlaps(bounds, handle), at).toBe(false);
      expect(overlaps(bounds, emberRoom(s.ember)), at).toBe(false);
      // It grows away from Ember and the bubble: up when it sits above Ember.
      expect(up, at).toBe(bounds.y + bounds.height <= s.ember.y);
      // A field that gains lines keeps off Ember too, on the side of it where it is (it never jumps across Ember).
      const grown = clearOfBubble(grownBounds(bounds, 7, area, up, handle, s.scale), area, s.bubble, handle, near, false);
      expect(inside(grown, area), `${at}, grown`).toBe(true);
      expect(overlaps(grown, emberRoom(s.ember)), `${at}, grown`).toBe(false);
      expect(grown.y + grown.height <= s.ember.y, `${at}, grown`).toBe(up);
    }
  });

  it("never stacks itself over Ember: under an answer below Ember, not over it (companion-1)", () => {
    const area = { x: 0, y: 0, width: 1024, height: 768 };
    const near = { x: 559, y: 113, size: 60 }, answer = { x: 537, y: 155, width: 330, height: 123 };
    const b = openingBounds(near, area, null, 1, 5, answer).bounds;
    expect(b.y).toBe(answer.y + answer.height + 8);
    expect(b.x).toBe(openingBounds(near, area, null, 1, 5).bounds.x);
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

  it("starts where it always has with the handle in the bottom right (or not known)", () => {
    const wa = { x: 0, y: 27, width: 1280, height: 773 };
    expect(deskViewStart(wa, handle(wa))).toEqual({ x: 16, y: 27, width: 0, height: 773 });
    expect(deskViewStart(wa, null)).toEqual({ x: 16, y: 27, width: 0, height: 773 });
    expect(deskViewStart(wa)).toEqual({ x: 16, y: 27, width: 0, height: 773 });
  });

  it("with the handle in the bottom left (Handle position), is bottom-right, growing up and to the left (review #75)", () => {
    const wa = { x: 0, y: 0, width: 1920, height: 1080 };
    const left = { x: 12, y: 1012, width: 200, height: 56 };
    const small = deskViewBounds(deskViewStart(wa, left), false, wa, left);
    expect(small).toEqual({ x: 1920 - 16 - 340, y: 826, width: 340, height: 238 });
    const large = deskViewBounds(small, true, wa, left);
    expect(large).toEqual({ x: 1920 - 16 - 980, y: 418, width: 980, height: 646 });
    expect(deskViewBounds(large, false, wa, left)).toEqual(small);
  });

  it("with the handle or its card in the bottom left, keeps clear of it on small screens and a left taskbar too", () => {
    for (const wa of [{ x: 0, y: 0, width: 1024, height: 600 }, { x: 0, y: 27, width: 1280, height: 773 }, { x: 48, y: 0, width: 1232, height: 800 }]) {
      for (const h of [56, 120, 360]) {
        const width = h === 56 ? 200 : 360;
        const card = { x: wa.x + 12, y: wa.y + wa.height - 12 - h, width, height: h };
        const small = deskViewBounds(deskViewStart(wa, card), false, wa, card);
        const large = deskViewBounds(small, true, wa, card);
        for (const b of [small, large]) {
          expect(inside(b, wa), `${wa.width} ${h}`).toBe(true);
          expect(overlaps(b, card), `${wa.width} ${h}`).toBe(false);
          expect(b.width, `${wa.width} ${h}`).toBeGreaterThan(100);
        }
        expect(large.width / large.height).toBeCloseTo(980 / 646, 2);
        expect(deskViewBounds(large, false, wa, card)).toEqual(small);
        // Dragged towards the handle first: it still grows clear of it.
        expect(overlaps(deskViewBounds({ ...small, x: wa.x + 100 }, true, wa, card), card)).toBe(false);
      }
    }
  });

  it("keeps its bottom edge on screen wherever it was dragged", () => {
    const wa = { x: 0, y: 27, width: 1280, height: 773 };
    for (const b of [{ x: 900, y: 700, width: 340, height: 238 }, { x: -50, y: 0, width: 340, height: 238 }, { x: 16, y: 600, width: 980, height: 646 }]) {
      for (const large of [false, true]) expect(inside(deskViewBounds(b, large, wa), wa), JSON.stringify([b, large])).toBe(true);
    }
  });
});

describe("the ask box at the text size (review #57)", () => {
  const wa = { x: 0, y: 0, width: 1280, height: 800 };

  it("grows the ask box by the scale of its words: its field and the line under it, not its insets", () => {
    expect(askSize(1)).toEqual({ width: 560, height: 92 });
    expect(askSize(1.15)).toEqual({ width: 644, height: 101 });
    expect(askSize(1.3)).toEqual({ width: 728, height: 111 });
    // A scale that can't be read is the default's.
    expect(askSize(Number.NaN)).toEqual(askSize(1));
    expect(askSize(0)).toEqual(askSize(1));
    // Centred over Ember, its hint row (the box's foot) as far from Ember's head as at the default size.
    const usual = askBounds({ x: 500, y: 300 }, wa), larger = askBounds({ x: 500, y: 300 }, wa, null, 1.3);
    expect(larger).toEqual({ x: 136, y: 167, width: 728, height: 111 });
    expect(larger.y + larger.height).toBe(usual.y + usual.height);
    expect(askBounds({ x: 500, y: 300 }, wa, null, 1)).toEqual(usual);
    // Without Ember: low in the middle, its foot where it always is.
    const alone = askBounds(null, wa, null, 1.15);
    expect(alone).toEqual({ x: 318, y: 609, width: 644, height: 101 });
    expect(alone.y + alone.height).toBe(askBounds(null, wa).y + askBounds(null, wa).height);
  });

  it("keeps the larger box inside a small screen, below Ember near its top, and clear of the handle", () => {
    const small = { x: 0, y: 0, width: 1024, height: 600 };
    const pill = { x: 782, y: 532, width: 230, height: 56 };
    for (const scale of [1.15, 1.3]) {
      for (const c of [{ x: 66, y: 60 }, { x: 980, y: 560 }, { x: 512, y: 300 }]) {
        const b = askBounds({ ...c, size: 60 }, small, pill, scale);
        expect(inside(b, small), `${scale} ${JSON.stringify(c)}`).toBe(true);
        expect(overlaps(b, pill), `${scale} ${JSON.stringify(c)}`).toBe(false);
        for (const rows of [1, 4, 6]) expect(inside(grownBounds(b, rows, small, b.y < c.y, pill, scale), small)).toBe(true);
      }
    }
    // Leave room for the edge gaps even below the usual width.
    expect(askBounds(null, { x: 0, y: 0, width: 640, height: 480 }, null, 1.3).width).toBe(624);
    expect(askBounds(null, { x: 0, y: 0, width: 500, height: 480 }, null, 1.3)).toMatchObject({ x: 8, width: 484 });
  });

  it("has room for its field, the line under it, and the note's and the tip's rows at every size (styles.css)", () => {
    const css = readFileSync(new URL("../../app/renderer/ask/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const px = (re: RegExp) => Number(re.exec(css)?.[1] ?? NaN);
    const inset = px(/\.ask \{[^}]*inset: (\d+)px/), gap = px(/\.ask \{[^}]*gap: (\d+)px/);
    // What grows with the text: each size the page sets times --text-scale, the default's px in its usual rule.
    const grows = (sel: string, prop: string, usual: number) => {
      expect(css, `${sel} ${prop}`).toContain(`${prop}: calc(${usual}px * var(--text-scale))`);
      expect(new RegExp(`html\\[data-text-size\\] ${sel.replace(/\./g, "\\.")}[^{]*\\{[^}]*${prop}: calc\\(${usual}px \\* var\\(--text-scale\\)\\)`).test(css), `${sel} ${prop}`).toBe(true);
      return usual;
    };
    const field = grows(".field", "flex-basis", px(/\.field \{[^}]*flex: 0 0 (\d+)px/));
    const metaLine = grows(".meta", "line-height", px(/\.meta \{[^}]*line-height: (\d+)px/));
    const noteLine = grows(".tip", "line-height", px(/\.tip \{[^}]*line-height: (\d+)px/));
    expect(px(/\.cut \{[^}]*line-height: (\d+)px/)).toBe(noteLine);
    // The lines' padding and border (1 px each, top and bottom) don't grow.
    const edges = 4;
    for (const scale of [1, 1.15, 1.3]) {
      const one = 2 * inset + field * scale + gap + metaLine * scale + edges;
      expect(one, `${scale}`).toBeLessThanOrEqual(askSize(scale).height);
      // Each further row: a field line (24 px times the scale), or the note's or the tip's line with its gap and edges.
      expect(gap + noteLine * scale + edges, `${scale}`).toBeLessThanOrEqual(24 * scale);
      // Six rows at most: four lines, the note and the tip, inside the box main makes.
      const wa = { x: 0, y: 0, width: 1920, height: 1080 };
      const tallest = 2 * inset + (field + 3 * 24) * scale + gap + metaLine * scale + edges + 2 * (gap + noteLine * scale + edges);
      expect(tallest, `${scale}`).toBeLessThanOrEqual(grownBounds(askBounds(null, wa, null, scale), 6, wa, true, null, scale).height);
    }
  });

  it("grows the ask box a line of the larger size at a time, upward above Ember", () => {
    for (const [scale, line] of [[1, 24], [1.15, 27.6], [1.3, 31.2]]) {
      const b = askBounds({ x: 500, y: 400 }, wa, null, scale);
      for (const rows of [1, 2, 4, 6]) {
        const g = grownBounds(b, rows, wa, true, null, scale);
        expect(g.height, `${scale} ${rows}`).toBe(askSize(scale).height + Math.round((rows - 1) * line));
        // Above Ember: the hint row stays where it was.
        expect(g.y + g.height, `${scale} ${rows}`).toBe(b.y + b.height);
      }
      expect(grownBounds(grownBounds(b, 6, wa, true, null, scale), 1, wa, true, null, scale)).toEqual(b);
    }
  });
});

describe("the desk view at the text size (review #57)", () => {
  it("grows the desk view by its bar only, so the picture under it keeps its size", () => {
    const big = { x: 0, y: 0, width: 1920, height: 1080 };
    const start = { x: 16, y: 0, width: 0, height: 1080 };
    expect(deskViewBounds(start, false, big, null, 1)).toEqual({ x: 16, y: 826, width: 340, height: 238 });
    for (const [scale, bar] of [[1.15, 35], [1.3, 39]]) {
      const small = deskViewBounds(start, false, big, null, scale);
      expect(small, `${scale}`).toEqual({ x: 16, y: 826 - (bar - 30), width: 340, height: 208 + bar });
      const large = deskViewBounds(small, true, big, null, scale);
      expect(large, `${scale}`).toEqual({ x: 16, y: 418 - (bar - 30), width: 980, height: 616 + bar });
      // Its foot stays put, at every size and back.
      expect(deskViewBounds(large, false, big, null, scale)).toEqual(small);
      expect(deskViewBounds(small, false, big, null, 1)).toEqual(deskViewBounds(start, false, big, null, 1));
    }
    // On a small screen, the larger bar still fits, clear of the handle.
    const wa = { x: 0, y: 0, width: 1024, height: 600 };
    const pill = { x: 782, y: 532, width: 230, height: 56 };
    const large = deskViewBounds(deskViewBounds(start, false, wa, pill, 1.3), true, wa, pill, 1.3);
    expect(inside(large, wa)).toBe(true);
    expect(large.x + large.width + 12).toBeLessThanOrEqual(pill.x);
    // A scale that can't be read is the default's.
    expect(deskViewBounds(start, false, big, null, Number.NaN)).toEqual(deskViewBounds(start, false, big));
  });

  it("grows by its bar the same with the handle in the bottom left (Handle position, review #75)", () => {
    const big = { x: 0, y: 0, width: 1920, height: 1080 };
    const left = { x: 12, y: 1012, width: 200, height: 56 };
    for (const [scale, bar] of [[1, 30], [1.15, 35], [1.3, 39]]) {
      const small = deskViewBounds(deskViewStart(big, left), false, big, left, scale);
      expect(small, `${scale}`).toEqual({ x: 1920 - 16 - 340, y: 826 - (bar - 30), width: 340, height: 208 + bar });
      const large = deskViewBounds(small, true, big, left, scale);
      expect(large, `${scale}`).toEqual({ x: 1920 - 16 - 980, y: 418 - (bar - 30), width: 980, height: 616 + bar });
      expect(deskViewBounds(large, false, big, left, scale)).toEqual(small);
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
