/**
 * Ember keeps off its handle and the task cards, on the display it is on: another display's cards never push it
 * away from the cursor (review #127).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

type Box = { x: number; y: number; width: number; height: number };
type Shown = { id: number; scaleFactor: number; bounds: Box; workArea: Box };

/** The displays the fake screen has (set per test). */
const layout = vi.hoisted(() => ({ displays: [] as Shown[] }));

vi.mock("electron", () => {
  const distance = (b: Box, p: { x: number; y: number }) =>
    Math.hypot(Math.max(b.x - p.x, 0, p.x - (b.x + b.width - 1)), Math.max(b.y - p.y, 0, p.y - (b.y + b.height - 1)));
  const nearest = (p: { x: number; y: number }) => layout.displays.reduce((a, d) => (distance(d.bounds, p) < distance(a.bounds, p) ? d : a));
  return {
    BrowserWindow: class {},
    screen: {
      getAllDisplays: () => layout.displays,
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: nearest,
      getDisplayMatching: (r: Box) => nearest({ x: r.x + r.width / 2, y: r.y + r.height / 2 }),
      on() {}, off() {},
    },
  };
});

import type { Logger } from "../../app/main/logger";
import type { Settings } from "../../app/main/settings";
import type { OverlayShaper } from "../../app/main/platform/types";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const shaper: OverlayShaper = { setInputRegion: () => false, release() {}, forward: false, floating: () => ({ options: {}, allWorkspaces: null }) };

const display = (id: number, x: number, y: number): Shown => ({
  id, scaleFactor: 1, bounds: { x, y, width: 1920, height: 1080 }, workArea: { x, y, width: 1920, height: 1040 },
});
/** The task cards at the bottom-right of a display (as the overlay places them above the handle), 270 x 180. */
const cardsOn = (d: Shown): Box => ({ x: d.bounds.x + d.bounds.width - 290, y: d.workArea.y + d.workArea.height - 260, width: 270, height: 180 });

afterEach(() => { vi.restoreAllMocks(); });

/** An overlay manager with one overlay per display (each with `cards` or none), the cursor at `cursor`. */
async function manager(displays: Shown[], cards: (Box | null)[], handle: Box | null) {
  layout.displays = displays;
  const { OverlayManager } = await import("../../app/main/overlay");
  const pointer = { x: 900, y: 600, buttons: 0 };
  const m = new OverlayManager(() => ({ size: 60, reduceMotion: false }) as Settings, quiet, () => pointer, shaper);
  m.avoid = () => handle;
  const sent: { channel: string; value: unknown; display: number }[] = [];
  const senders = displays.map((d, i) => {
    const webContents = { send: (channel: string, value: unknown) => sent.push({ channel, value, display: d.id }), isLoading: () => false };
    const win = { webContents, isDestroyed: () => false, destroy() {}, setIgnoreMouseEvents() {} };
    (m as unknown as { overlays: Map<number, unknown> }).overlays.set(d.id, { win, display: d, interactive: [], clickThrough: true, shaped: false, cards: null });
    return { sender: webContents as unknown as Electron.WebContents, cards: cards[i] };
  });
  for (const s of senders) m.setCards(s.sender, s.cards);
  // Time moves 16 ms a tick, as at 60 Hz.
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  /** Where Ember settles with the cursor at `p`. */
  const settle = (p: { x: number; y: number }) => {
    pointer.x = p.x; pointer.y = p.y;
    for (let i = 0; i < 400; i++) { now += 16; (m as unknown as { tick(): void }).tick(); }
    return m.position;
  };
  return { m, settle, sent };
}

describe("what Ember keeps off, with more than one display", () => {
  const primary = display(1, 0, 0);
  const handle: Box = { x: 1920 - 212, y: 1040 - 68, width: 200, height: 56 };

  it("another display's cards don't push Ember away from the cursor (a second display to the left)", async () => {
    const left = display(2, -1920, 0);
    const alone = await manager([primary, left], [null, null], handle);
    const free = alone.settle({ x: 900, y: 1000 });
    const both = await manager([primary, left], [cardsOn(primary), cardsOn(left)], handle);
    const withCards = both.settle({ x: 900, y: 1000 });
    expect(Math.abs(withCards.y - free.y)).toBeLessThan(1);
    expect(Math.abs(withCards.x - free.x)).toBeLessThan(1);
  });

  it("stacked displays: the upper display's cards don't send Ember to the top of the lower one", async () => {
    const upper = display(2, 0, -1080);
    const alone = await manager([primary, upper], [null, null], handle);
    const free = alone.settle({ x: 1800, y: 500 });
    const both = await manager([primary, upper], [cardsOn(primary), cardsOn(upper)], handle);
    const withCards = both.settle({ x: 1800, y: 500 });
    expect(Math.abs(withCards.y - free.y)).toBeLessThan(1);
  });

  it("still keeps off the cards of the display it is on", async () => {
    const left = display(2, -1920, 0);
    const c = cardsOn(primary);
    const { settle } = await manager([primary, left], [c, null], handle);
    const at = settle({ x: c.x + 100, y: c.y + 120 });
    // Ember's body (about 36 px each way at size 60) sits above the cards, not on them.
    expect(at.y + 36).toBeLessThanOrEqual(c.y);
  });

  it("on the other display, keeps off that display's cards and not the handle's corner on this one", async () => {
    const left = display(2, -1920, 0);
    const c = cardsOn(left);
    const { settle } = await manager([primary, left], [cardsOn(primary), c], handle);
    const at = settle({ x: c.x + 100, y: c.y + 120 });
    expect(at.y + 36).toBeLessThanOrEqual(c.y);
  });
});
