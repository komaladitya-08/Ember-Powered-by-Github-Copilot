/**
 * Ember keeps off its handle and the task cards, on the display it is on: another display's cards never push it
 * away from the cursor (review #127). Beside a control it works on, it never parks under the cards, and the cards
 * make way for the control's ring (review #126). Near the seam between two displays, only the display Ember is on
 * shows its bubble (review #128).
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
import { besideControl, followTarget } from "../../app/main/follow";
import { askGrew, askGrownInto, askGrows, askKeepOff, askKeepOffKey, bubbleHere, cardsCorner, handleSide, stackPlace } from "../../app/renderer/overlay/layout";
import { bubbleCut, bubbleFit } from "../../packages/bubble/src/bubble";

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
  // Time moves 16 ms a tick, as at 60 Hz (on either clock the tick may read).
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(performance, "now").mockImplementation(() => now);
  /** Where Ember settles with the cursor at `p`. */
  const settle = (p: { x: number; y: number }) => {
    pointer.x = p.x; pointer.y = p.y;
    for (let i = 0; i < 400; i++) { now += 16; (m as unknown as { tick(): void }).tick(); }
    return m.position;
  };
  return { m, settle, sent, pointer };
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

  it("tells the open Ask box where every display's cards are, so what it shows keeps off them too, and again as they change (companion-r5-1)", async () => {
    const left = display(2, -1920, 0);
    const c = cardsOn(primary), d = cardsOn(left);
    const { m } = await manager([primary, left], [c, d], handle);
    expect(m.cardsRects()).toEqual([c, d]);
    const { m: one } = await manager([primary, left], [null, d], handle);
    expect(one.cardsRects()).toEqual([d]);
    // Ember hidden: no cards show.
    one.setHidden(true);
    expect(one.cardsRects()).toEqual([]);
    const { readFileSync } = await import("node:fs");
    const main = readFileSync("app/main/main.ts", "utf8");
    expect(main).toContain("cards: () => overlay?.cardsRects() ?? [],");
    expect(main).toMatch(/overlay\.setCards\(event\.sender, rect\);\n(\s+\/\/[^\n]*\n)+\s+askWindow\.keepClear\(\);/);
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

/** Ember's body (about 36 px each way at size 60) overlaps `r`. */
const under = (p: { x: number; y: number }, r: Box, half = 36) => p.x + half > r.x && p.x - half < r.x + r.width && p.y + half > r.y && p.y - half < r.y + r.height;

describe("Ember beside a control near the task cards", () => {
  const screen = display(1, 0, 0);
  const area = screen.workArea;
  const cards = cardsOn(screen);
  /** A "Next" button just left of the card column. */
  const next: Box = { x: cards.x - 90, y: cards.y + 100, width: 80, height: 30 };

  it("parks on the side of the control away from the cards (beside it, above or below)", () => {
    expect(under(besideControl(next, 60, area), cards)).toBe(true);
    const p = besideControl(next, 60, area, cards);
    expect(under(p, cards)).toBe(false);
    expect(p.x).toBeLessThan(next.x);
  });

  it("parks where it always did when nothing is in the way", () => {
    const far: Box = { x: 400, y: 300, width: 80, height: 30 };
    expect(besideControl(far, 60, area, cards)).toEqual(besideControl(far, 60, area));
  });

  it("the overlay manager parks it off the cards of that display", async () => {
    const { m, settle } = await manager([screen], [cards], null);
    m.setState({ focus: next });
    expect(under(settle({ x: 300, y: 300 }), cards)).toBe(false);
  });

  it("moves off when cards come up over where it holds still beside the control", async () => {
    const { m, settle } = await manager([screen], [null], null);
    m.setState({ focus: next });
    expect(under(settle({ x: 300, y: 300 }), cards)).toBe(true);
    const overlay = [...(m as unknown as { overlays: Map<number, { win: { webContents: Electron.WebContents } }> }).overlays.values()][0];
    m.setCards(overlay.win.webContents, cards);
    expect(under(settle({ x: 300, y: 300 }), cards)).toBe(false);
  });
});

describe("the handle at the bottom-right and the cards moved to the bottom-left", () => {
  const small: Shown = { id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1366, height: 768 }, workArea: { x: 0, y: 0, width: 1366, height: 728 } };
  const area = small.workArea;
  const handle: Box = { x: 1366 - 212, y: 768 - 68 - 40, width: 200, height: 56 };
  const left: Box = { x: 16, y: 555, width: 270, height: 101 };
  const right: Box = { x: 1080, y: 555, width: 270, height: 101 };
  /** The wizard's "Next" at the bottom-right, under where the cards were (so the overlay moved them left). */
  const next: Box = { x: 1210, y: 620, width: 100, height: 32 };
  const done = { visible: true, mood: "done" as const, title: "Ember", thought: "Installed.", step: null, streaming: false, actions: [] };

  /** Where Ember holds still by the cursor at the bottom-centre once its work on Next ends with an answer. */
  const holdStill = async (cards: Box | null) => {
    const { m, settle, pointer } = await manager([small], [cards], handle);
    pointer.x = 683; pointer.y = 690;
    m.setState({ focus: next });
    // Main parks Ember before the overlay has put the cards back in their corner.
    m.setState({ focus: null, bubble: done });
    return settle({ x: 683, y: 690 });
  };

  it("Ember holds still by the cursor just as with no cards (two areas to keep off, not a band across the bottom)", async () => {
    const free = await holdStill(null);
    for (const cards of [left, right]) {
      const at = await holdStill(cards);
      expect(Math.abs(at.x - free.x)).toBeLessThan(1);
      expect(Math.abs(at.y - free.y)).toBeLessThan(1);
    }
  });

  it("following the cursor, Ember keeps off each area on its own", () => {
    const areas = [handle, left];
    expect(followTarget({ x: 683, y: 690 }, 60, area, areas)).toEqual(followTarget({ x: 683, y: 690 }, 60, area));
    expect(followTarget({ x: 1200, y: 680 }, 60, area, areas).y + 36).toBeLessThanOrEqual(handle.y);
    expect(followTarget({ x: 100, y: 560 }, 60, area, areas).y + 36).toBeLessThanOrEqual(left.y);
  });

  it("beside a control, Ember parks on a side clear of both (not under the handle for want of room in a band)", () => {
    const areas = [handle, left];
    const mid: Box = { x: 600, y: 650, width: 80, height: 30 };
    expect(besideControl(mid, 60, area, areas)).toEqual(besideControl(mid, 60, area));
    // A control just left of the handle: its usual spot (to the right) is under the handle; the left is clear.
    const byHandle: Box = { x: 1060, y: 670, width: 80, height: 30 };
    expect(under(besideControl(byHandle, 60, area), handle)).toBe(true);
    const p = besideControl(byHandle, 60, area, areas);
    expect(areas.some(r => under(p, r))).toBe(false);
    expect(p.x).toBeLessThan(byHandle.x);
  });
});

describe("the task cards and the ring round a control", () => {
  const vw = 1366;
  /** The stack at the bottom-right, 270 wide, 12 px in. */
  const stack: Box = { x: vw - 282, y: 420, width: 270, height: 268 };

  it("stay in their corner when the ring is elsewhere (or there is none)", () => {
    expect(cardsCorner(null, stack, vw)).toBe("right");
    expect(cardsCorner({ x: 260, y: 48, width: 920, height: 32 }, stack, vw)).toBe("right");
  });

  it("move to the other corner when the ring is under them", () => {
    expect(cardsCorner({ x: 1210, y: 620, width: 80, height: 30 }, stack, vw)).toBe("left");
    // The ring's glow counts: a control just beside the column still moves them.
    expect(cardsCorner({ x: stack.x - 84, y: 600, width: 80, height: 30 }, stack, vw)).toBe("left");
  });

  it("stay where they are when the ring would be under them in either corner (a bar as wide as the screen)", () => {
    expect(cardsCorner({ x: 0, y: 640, width: vw, height: 30 }, stack, vw)).toBe("right");
  });
});

describe("the handle in the bottom-left corner (Handle position, review #75)", () => {
  const primary = display(1, 0, 0);
  const right: Box = { x: 1920 - 212, y: 1040 - 68, width: 200, height: 56 };
  const left: Box = { x: 12, y: 1040 - 68, width: 200, height: 56 };
  const vw = 1920, vh = 1080;

  it("Ember keeps off it there, as it does in the bottom right", async () => {
    const { settle } = await manager([primary], [null], left);
    const at = settle({ x: left.x + 100, y: left.y + 20 });
    expect(at.y + 36).toBeLessThanOrEqual(left.y);
  });

  it("every overlay hears the handle's new place as the settings change, not a second later", async () => {
    const { m, sent } = await manager([primary], [null], right);
    let now: Box = right;
    m.avoid = () => now;
    m.broadcastSettings({ size: 60, handlePosition: "bottom-right" } as Settings);
    const inits = () => sent.filter(x => x.channel === "overlay:init").map(x => (x.value as { handle: Box | null }).handle);
    expect(inits()).toEqual([right]);
    // The menu's "Move to the other side": main moves the handle, then sends the settings.
    now = left;
    m.broadcastSettings({ size: 60, handlePosition: "bottom-left" } as Settings);
    expect(inits()).toEqual([right, left]);
    // Settings that don't move it send no new place.
    m.broadcastSettings({ size: 72, handlePosition: "bottom-left" } as Settings);
    expect(inits()).toEqual([right, left]);
  });

  it("the cards take the handle's side: where its pill is on this display, else the setting's", () => {
    expect(handleSide(right, vw, "bottom-left")).toBe("right");
    expect(handleSide(left, vw, "bottom-right")).toBe("left");
    // The handle on another display: the setting says.
    expect(handleSide(null, vw, "bottom-left")).toBe("left");
    expect(handleSide(null, vw, "bottom-right")).toBe("right");
    expect(handleSide(null, vw, undefined)).toBe("right");
  });

  it("stack a card's gap above the pill, lined up with its outer edge on either side", () => {
    // The pill is drawn 4 px inside its window; the cards' right (or left) edge meets the pill's.
    expect(stackPlace(right, { width: vw, height: vh })).toEqual({ inset: 1920 - (right.x + 200 - 4), bottom: 1080 - (right.y + 4) + 8 });
    expect(stackPlace(left, { width: vw, height: vh })).toEqual({ inset: left.x + 4, bottom: 1080 - (left.y + 4) + 8 });
    expect(stackPlace(right, { width: vw, height: vh }).inset).toBe(stackPlace(left, { width: vw, height: vh }).inset);
    // No handle on this display: 12 px in, 80 up, on the side the setting names.
    expect(stackPlace(null, { width: vw, height: vh })).toEqual({ inset: 12, bottom: 80 });
  });

  it("make way for the ring round a control to the bottom right, as they do to the bottom left from there", () => {
    const stack: Box = { x: 16, y: 420, width: 270, height: 268 };
    expect(cardsCorner(null, stack, vw, "left")).toBe("left");
    expect(cardsCorner({ x: 600, y: 48, width: 200, height: 32 }, stack, vw, "left")).toBe("left");
    // A chat button at the bottom left, under them: they go to the bottom right.
    expect(cardsCorner({ x: 40, y: 620, width: 80, height: 30 }, stack, vw, "left")).toBe("right");
    // A bar as wide as the screen: they stay.
    expect(cardsCorner({ x: 0, y: 640, width: vw, height: 30 }, stack, vw, "left")).toBe("left");
  });
});

describe("Ember near the seam between two displays", () => {
  const a = { ...display(1, 0, 0), bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 0, width: 1440, height: 900 } };
  const b = { ...display(2, 1440, 0), bounds: { x: 1440, y: 0, width: 1440, height: 900 }, workArea: { x: 1440, y: 0, width: 1440, height: 900 } };

  it("every overlay is told which display Ember is on (the one nearest its centre)", async () => {
    const { settle, sent } = await manager([a, b], [null, null], null);
    // The cursor just inside B: Ember follows to its right, about 47 px further in.
    const at = settle({ x: 1450, y: 400 });
    expect(at.x).toBeGreaterThan(1440);
    const last = (id: number) => sent.filter(m => m.channel === "overlay:frame" && m.display === id).at(-1)!.value as { on?: number };
    expect(last(1).on).toBe(2);
    expect(last(2).on).toBe(2);
  });

  it("only that display shows the bubble, though both draw Ember's body", () => {
    const frame = { ember: { x: 1470, y: 400 }, on: 2 };
    expect(bubbleHere(frame, 1, a.bounds)).toBe(false);
    expect(bubbleHere(frame, 2, b.bounds)).toBe(true);
  });

  it("without main's word, the display that holds Ember's centre shows it", () => {
    const frame = { ember: { x: 1430, y: 400 } };
    expect(bubbleHere(frame, 1, a.bounds)).toBe(true);
    expect(bubbleHere(frame, 2, b.bounds)).toBe(false);
  });
});

describe("where Ember's bubble is, for the Ask box to open beside it (companion-1)", () => {
  it("is what the display showing it last said, none once it goes, and none while Ember is hidden", async () => {
    const a = display(1, 0, 0), b = display(2, 1920, 0);
    const { m } = await manager([a, b], [null, null], null);
    const [first, second] = [...(m as unknown as { overlays: Map<number, { win: { webContents: Electron.WebContents } }> }).overlays.values()].map(o => o.win.webContents);
    expect(m.bubbleRect()).toBeNull();
    const answer = { x: 2585, y: 155, width: 330, height: 123 };
    m.setBubble(first, null);
    m.setBubble(second, answer);
    expect(m.bubbleRect()).toEqual(answer);
    m.setHidden(true);
    expect(m.bubbleRect()).toBeNull();
    m.setHidden(false);
    expect(m.bubbleRect()).toEqual(answer);
    m.setBubble(second, null);
    expect(m.bubbleRect()).toBeNull();
  });

  it("is told by the overlay page only, as a box or null (main.ts checks the sender and the shape)", async () => {
    const { readFileSync } = await import("node:fs");
    const main = readFileSync("app/main/main.ts", "utf8");
    expect(main).toMatch(/ipcMain\.on\(OVERLAY\.bubble, \(event, rect: unknown\) => \{\n\s+if \(!overlay\?\.owns\(event\.sender\) \|\| !\(rect === null \|\| isRect\(rect\)\)\) return;/);
    expect(main).toContain("bubble: () => overlay?.bubbleRect() ?? null,");
  });
});

describe("the open Ask box, for a bubble that comes up while it is open (companion-c1-1)", () => {
  const box = { x: 407, y: 149, width: 560, height: 188 };
  const moved = { x: 97, y: 149, width: 560, height: 188 };
  const none = { box: null, question: "" };

  it("is kept off by a bubble that comes up while it is open, wherever main says the box is now", () => {
    // No question up: the box where main says it is, as it moves and when it closes.
    expect(askKeepOff(box, "", none)).toEqual({ box, question: "" });
    expect(askKeepOff(moved, "", { box, question: "" })).toEqual({ box: moved, question: "" });
    expect(askKeepOff(null, "", { box: moved, question: "" })).toEqual(none);
    // A question that comes up while the box is open is placed clear of it, where it is then.
    expect(askKeepOff(box, "q1:once,q1:deny", { box, question: "" })).toEqual({ box, question: "q1:once,q1:deny" });
  });

  it("never moves a question already shown: it keeps off the box where the box was when it came", () => {
    const held = askKeepOff(box, "q1:once,q1:deny", none);
    // The box steps aside, grows or closes while the same question shows: the question stays where it is.
    expect(askKeepOff(moved, "q1:once,q1:deny", held)).toBe(held);
    expect(askKeepOff(null, "q1:once,q1:deny", held)).toBe(held);
    // The question answered, or the next one: the box where it is now.
    expect(askKeepOff(moved, "", held)).toEqual({ box: moved, question: "" });
    expect(askKeepOff(moved, "q2:once,q2:deny", held)).toEqual({ box: moved, question: "q2:once,q2:deny" });
    // A question that was up before the box opened: the box opens clear of it (ask.ts), and it doesn't move for the box.
    const before = askKeepOff(null, "q3:once", none);
    expect(askKeepOff(box, "q3:once", before)).toBe(before);
  });

  it("never moves an answer already shown for the box opening, growing or closing: only one that comes while it is open keeps off it (companion-c2-4)", () => {
    const answer = { visible: true, mood: "idle" as const, title: "Ember", actions: [] as { id: string; label: string }[] };
    // An answer on screen when the box opens: it keeps off nothing of the box, so it is never thrown across the screen
    // (it went 678 px to the far edge for a box that grew 1 px into it); the box keeps clear of it instead (ask.ts).
    const shown = askKeepOff(null, askKeepOffKey(answer), none);
    expect(askKeepOff(box, askKeepOffKey(answer), shown)).toBe(shown);
    expect(askKeepOff(moved, askKeepOffKey(answer), shown).box).toBeNull();
    // However its words stream in, it is one bubble from when it shows until it goes.
    expect(askKeepOffKey({ ...answer, thought: "Tokyo" } as typeof answer)).toBe(askKeepOffKey(answer));
    // One that comes while the box is open keeps off it where the box was then, and doesn't follow it after.
    const result = { ...answer, mood: "done" as const, title: "Tidy up" };
    const came = askKeepOff(box, askKeepOffKey(result), shown);
    expect(came.box).toEqual(box);
    expect(askKeepOff(moved, askKeepOffKey(result), came)).toBe(came);
    expect(askKeepOff(null, askKeepOffKey(result), came)).toBe(came);
    // "Read all" opened in full is a new bubble (it is larger): it keeps off the box where it is now.
    expect(askKeepOff(moved, askKeepOffKey({ ...answer, expanded: true } as typeof answer), shown).box).toEqual(moved);
    // Gone: nothing is held.
    expect(askKeepOffKey({ ...answer, visible: false })).toBe("");
    // A question is held by its answers' ids, as before.
    expect(askKeepOffKey({ ...answer, mood: "attention", actions: [{ id: "q1:once", label: "Allow" }, { id: "ui:more", label: "More" }] })).toBe("q1:once");
  });

  it("keeps an answer still streaming when the box opened out from under the field as it grows into it; once it has finished it holds still (companion-c3-1)", () => {
    const answer = { visible: true, mood: "idle" as const, title: "Ember", streaming: true, actions: [] as { id: string; label: string }[] };
    // Shown before the box opened: it held off nothing of the box, and the box opened clear of it, beside it.
    const shown = askKeepOff(null, askKeepOffKey(answer), none);
    const at = { x: 490, y: 102, width: 330, height: 123 };
    const opened = { x: 232, y: 233, width: 560, height: 140 };
    expect(askGrownInto(shown, opened, at, askGrows(answer))).toBe(shown);
    // Its words go on streaming in and it grows into the box: from then on it keeps off the box where it is now, so
    // the field never covers its last lines, its Read all and its hint (22,776 to 41,250 px² of it were covered).
    const grown = { ...at, height: 200 };
    const kept = askGrownInto(shown, opened, grown, askGrows(answer));
    expect(kept).toEqual({ box: opened, question: askKeepOffKey(answer), grew: true });
    // ... and it is placed clear of the box, by Ember (Ember at the top of a 1024 x 768 screen: beside it).
    const spot = bubbleFit({ x: 512, y: 84 }, { width: 330, height: 200 }, { width: 1024, height: 768 }, 60, [opened], () => 200);
    expect(spot).toMatchObject({ x: 563, y: 8 });
    const clear = (r: Box, b: Box) => r.x >= b.x + b.width || r.x + r.width <= b.x || r.y >= b.y + b.height || r.y + r.height <= b.y;
    expect(clear(spot!, opened)).toBe(true);
    // The same box again: nothing changes (it doesn't re-place on every drawing).
    expect(askGrownInto(kept, opened, grown, askGrows(answer))).toBe(kept);
    // Finished at the size it streamed to: it holds still where it is, for the box growing or closing (companion-c2-4).
    const done = { ...answer, streaming: false };
    expect(askGrows(done)).toBe(false);
    expect(askGrew(done, grown, grown)).toBe(false);
    expect(askGrownInto(shown, opened, grown, askGrew(done, grown, grown))).toBe(shown);
    expect(askKeepOff(null, askKeepOffKey(done), kept)).toBe(kept);
    // A question never moves for the box, even one whose words come in a line at a time: nothing near it moves.
    const question = { ...answer, mood: "attention" as const, actions: [{ id: "q1:once", label: "Allow" }] };
    expect(askGrows(question)).toBe(false);
    // Its own Stop or More is not a question: an acting step streaming in grows like an answer.
    const step = { ...answer, mood: "acting" as const, actions: [{ id: "ui:more", label: "More" }] };
    expect(askGrows(step)).toBe(true);
    // No box, nothing on screen, or not into the box: what it held.
    expect(askGrownInto(shown, null, grown, true)).toBe(shown);
    expect(askGrownInto(shown, opened, null, true)).toBe(shown);
    expect(askGrownInto(shown, opened, at, true)).toBe(shown);
  });

  it("keeps an answer that streamed in clear of the field as it finishes: its Read all, its hint and its suggestions grow it into the box, and it keeps off the box from there (companion-c3-1)", () => {
    const streaming = { visible: true, mood: "idle" as const, title: "Ember", streaming: true, actions: [] as { id: string; label: string }[] };
    // As measured live: Ember at the top centre of a 1024 x 768 screen at Larger text, the box opened under the answer
    // while it streamed. Capped at three lines as it streams, the answer sat beside Ember and never grew into the box,
    // so it kept off nothing of it.
    const shown = askKeepOff(null, askKeepOffKey(streaming), none);
    const capped = { x: 610, y: 46, width: 330, height: 134 };
    const opened = { x: 195, y: 245, width: 728, height: 173 };
    expect(askGrownInto(shown, opened, capped, askGrew(streaming, capped, capped))).toBe(shown);
    // It finishes: the same bubble (its key doesn't change), laid out in full with Read all and its hint, 277 px tall,
    // under Ember and down over the field (50,490 px² of the field covered it, for as long as the box was open).
    const finished = { ...streaming, streaming: false, actions: [{ id: "ui:more", label: "Read all" }] };
    expect(askKeepOffKey(finished)).toBe(askKeepOffKey(streaming));
    const laidOut = { x: 537, y: 155, width: 330, height: 277 };
    expect(askGrows(finished)).toBe(false);
    expect(askGrew(finished, capped, laidOut)).toBe(true);
    const kept = askGrownInto(shown, opened, laidOut, askGrew(finished, capped, laidOut));
    expect(kept).toEqual({ box: opened, question: askKeepOffKey(finished), grew: true });
    expect(askKeepOff({ ...opened, y: 200 }, askKeepOffKey(finished), kept)).toBe(kept);
    // Nothing by Ember is clear of the box there: it goes below the box (it grew into it, so it may go across it), in
    // Ember's column but for the slide past the handle, whole, with Read all where it can be clicked.
    const anchor = { x: 559, y: 135 }, handle = { x: 752, y: 700, width: 260, height: 56 }, screen = { width: 1024, height: 768 };
    const own = { width: 330, height: 277 };
    expect(bubbleFit(anchor, own, screen, 60, [handle, opened], () => 277)).toBeNull();
    expect(bubbleFit(anchor, own, screen, 60, [handle, opened], () => 277, [opened])).toEqual({ x: 416, y: 424, width: 330, height: 277 });
    // Placed again clear of it: the same box, so nothing changes, and it doesn't dance.
    const below = { x: 416, y: 424, width: 330, height: 277 };
    expect(askGrownInto(kept, opened, below, askGrew(finished, laidOut, below))).toBe(kept);
    // Ember's suggestions come under it a moment later: they grow it too, so they never land under the field either.
    const answer = { ...streaming, streaming: false };
    expect(askGrew(answer, capped, { ...capped, height: 190 })).toBe(true);
    // The box growing into a finished answer (a reply of several lines) never moves the answer: its size is the same.
    const taller = { ...opened, y: 200, height: 283 };
    expect(askGrew(finished, laidOut, laidOut)).toBe(false);
    expect(askGrownInto(shown, taller, laidOut, askGrew(finished, laidOut, laidOut))).toBe(shown);
    // Smaller, first shown (nothing to grow from), or gone: no growth.
    expect(askGrew(finished, laidOut, capped)).toBe(false);
    expect(askGrew(finished, null, laidOut)).toBe(false);
    expect(askGrew(finished, laidOut, null)).toBe(false);
    expect(askGrew({ ...finished, visible: false }, capped, laidOut)).toBe(false);
    // A question never moves for the box, however it grows (the box steps aside for it instead: ask.ts), and one that
    // came while the box was open keeps off it without going across it.
    const question = { ...finished, mood: "attention" as const, actions: [{ id: "q1:once", label: "Allow" }, { id: "q1:deny", label: "Not now" }] };
    expect(askGrew(question, capped, laidOut)).toBe(false);
    expect(askKeepOff(opened, askKeepOffKey(question), kept).grew).toBeUndefined();
  });

  it("keeps an answer whose first words came while the box was open clear of the field as it grows into the box and finishes (companion-v5-1)", () => {
    // As measured live: Ember at the top centre of a 1024 x 768 screen at Larger text, Ask opened during "Thinking…".
    // "Thinking…" showed before the box opened, so it held off nothing of it; the answer's first words are a new bubble
    // that comes while the box is open, so it keeps off the box where it is.
    const thinking = { visible: true, mood: "thinking" as const, title: "Thinking…", streaming: true, actions: [] as { id: string; label: string }[] };
    const opened = { x: 195, y: 168, width: 728, height: 173 };
    const before = askKeepOff(null, askKeepOffKey(thinking), none);
    const streaming = { ...thinking, mood: "idle" as const, title: "Ember" };
    const held = askKeepOff(opened, askKeepOffKey(streaming), before);
    expect(held).toEqual({ box: opened, question: askKeepOffKey(streaming) });
    // Two lines fit beside Ember clear of the box; a third doesn't, and nothing by Ember is clear of the box at that
    // size: kept off the box without going across it, it went to its usual place under Ember, over the field (36,630
    // px² as it streamed, 50,490 once it finished, with the key hint over its words).
    const anchor = { x: 559, y: 135 }, handle = { x: 752, y: 700, width: 260, height: 56 }, screen = { width: 1024, height: 768 };
    expect(bubbleFit(anchor, { width: 330, height: 82 }, screen, 60, [handle, opened], () => 82)).toEqual({ x: 610, y: 70, width: 330, height: 82 });
    expect(bubbleFit(anchor, { width: 330, height: 108 }, screen, 60, [handle, opened], () => 108)).toBeNull();
    const over = { x: 537, y: 155, width: 330, height: 108 };
    // It grows into the box it keeps off as its words come in: from then on it may go across the box, below it here.
    const grown = askGrownInto(held, opened, over, askGrows(streaming));
    expect(grown).toEqual({ box: opened, question: askKeepOffKey(streaming), grew: true });
    expect(bubbleFit(anchor, { width: 330, height: 108 }, screen, 60, [handle, opened], () => 108, [opened])).toEqual({ x: 537, y: 347, width: 330, height: 108 });
    // Placed there, it is clear of the box: nothing changes as it streams on (it doesn't dance) ...
    const below = { x: 537, y: 347, width: 330, height: 134 };
    expect(askGrownInto(grown, opened, below, askGrows(streaming))).toBe(grown);
    // ... and it finishes there, whole, with Read all and its hint clear of the field.
    const finished = { ...streaming, streaming: false, actions: [{ id: "ui:more", label: "Read all" }] };
    expect(askKeepOff(opened, askKeepOffKey(finished), grown)).toBe(grown);
    expect(bubbleFit(anchor, { width: 330, height: 277 }, screen, 60, [handle, opened], () => 277, [opened])).toEqual({ x: 537, y: 347, width: 330, height: 277 });
    expect(askGrownInto(grown, opened, { ...below, height: 277 }, askGrew(finished, below, { ...below, height: 277 }))).toBe(grown);
    // Already free to go across, growing into the box again changes nothing.
    expect(askGrownInto(grown, opened, over, true)).toBe(grown);
    // So does "Listening…" (a wake heard while the box is open) with no room by Ember: above or below the box, not over
    // its field (900 x 700 at Larger text, Ember near the bottom, it sat on the box at y 509).
    const listening = { ...thinking, mood: "listening" as const, title: "Listening…" };
    const heard = askKeepOff(opened, askKeepOffKey(listening), none);
    expect(askGrownInto(heard, opened, { ...over, height: 50 }, askGrows(listening))).toEqual({ ...heard, grew: true });
    // One that came while the box was open and doesn't grow (a task's result shown whole) keeps its place as before,
    // and a question never moves for the box, however it grows.
    const result = { ...streaming, streaming: false, mood: "done" as const, title: "Tidy up" };
    const came = askKeepOff(opened, askKeepOffKey(result), none);
    expect(askGrownInto(came, opened, over, askGrew(result, null, over))).toBe(came);
    const question = { ...streaming, mood: "attention" as const, actions: [{ id: "q1:once", label: "Allow" }, { id: "q1:deny", label: "Not now" }] };
    const asked = askKeepOff(opened, askKeepOffKey(question), none);
    expect(askGrownInto(asked, opened, over, askGrew(question, { ...over, height: 80 }, over))).toBe(asked);
  });

  it("keeps an answer opened in full with Read all while the box is open clear of the field: above or below the box, or cut short to the room by Ember with its text scrolling inside (companion-c5-1)", () => {
    // As measured live on a 1024 x 768 screen at Larger text: a cut answer beside the open box, and Read all clicked.
    // The whole answer, 410 x 489, was laid under the field and its hint (46,359 to 57,528 px² of it), and nothing
    // moved it off: it kept off the box but could go only beside Ember, where nothing was clear of it.
    const cut = { visible: true, mood: "idle" as const, title: "Ember", actions: [{ id: "ui:more", label: "Read all" }] };
    const full = { ...cut, expanded: true, actions: [{ id: "ui:close", label: "Close" }, { id: "ui:conversation", label: "Open conversation" }] };
    const handle = { x: 752, y: 700, width: 260, height: 56 }, screen = { width: 1024, height: 768 };
    const own = { width: 410, height: 489 };
    // Ember mid-screen, the box above it.
    const mid = { x: 195, y: 242, width: 728, height: 173 }, midAnchor = { x: 559, y: 461 };
    const shown = askKeepOff(mid, askKeepOffKey(cut), none);
    // Read all is a new bubble that comes while the box is open: it keeps off the box where it is, and may go across it.
    const opened = askKeepOff(mid, askKeepOffKey(full), shown, full.expanded);
    expect(opened).toEqual({ box: mid, question: askKeepOffKey(full), grew: true });
    // Whole, it fits nowhere clear of the box, across it or not.
    expect(bubbleFit(midAnchor, own, screen, 60, [handle, mid], () => 489, [mid])).toBeNull();
    // Cut short a line at a time (26 px at Larger text, never under three lines of it), it goes under Ember, slid
    // past the handle, as tall as the room there: 281 px, its text scrolling inside and Close still in view.
    const under = bubbleCut(midAnchor, own, screen, 60, [handle, mid], [mid], 26, 489 - 416 + 3 * 26);
    expect(under).toEqual({ x: 336, y: 479, width: 410, height: 281 });
    const clear = (r: Box, b: Box) => r.x >= b.x + b.width || r.x + r.width <= b.x || r.y >= b.y + b.height || r.y + r.height <= b.y;
    expect(clear(under!, mid) && clear(under!, handle)).toBe(true);
    // Ember low, the box above it: beside Ember under the box, cut to the room there (taller than above the box).
    const low = { x: 195, y: 284, width: 728, height: 173 }, lowAnchor = { x: 559, y: 695 };
    const beside = bubbleCut(lowAnchor, own, screen, 60, [handle, low], [low], 26, 151);
    expect(beside).toEqual({ x: 98, y: 479, width: 410, height: 281 });
    expect(clear(beside!, low) && clear(beside!, handle)).toBe(true);
    // Ember at the top, the box under it: a shorter answer opened in full goes under the box whole.
    const top = { x: 195, y: 202, width: 728, height: 173 }, topAnchor = { x: 559, y: 135 };
    expect(bubbleFit(topAnchor, { width: 410, height: 307 }, screen, 60, [handle, top], () => 307, [top])).toEqual({ x: 537, y: 381, width: 410, height: 307 });
    // Where three lines don't fit anywhere clear, it isn't cut (it goes where it always went).
    expect(bubbleCut(midAnchor, own, screen, 60, [handle, mid], [mid], 26, 300)).toBeNull();
    // Opened in full before the box opened: it keeps off nothing of the box and never moves for it (the box opens
    // clear of it instead: companion-c2-4).
    const before = askKeepOff(null, askKeepOffKey(full), none, true);
    expect(before).toEqual({ box: null, question: askKeepOffKey(full) });
    expect(askKeepOff(mid, askKeepOffKey(full), before, true)).toBe(before);
    // And one that grew while the box was open keeps what it held (it is the same bubble).
    expect(askKeepOff({ ...mid, y: 100 }, askKeepOffKey(full), opened, true)).toBe(opened);
  });

  it("shows an answer cut short for the open Ask box whole once the box closes, where all of it fits (companion-v6-3)", () => {
    // As measured live on a 1024 x 768 screen at Larger text, Ember mid-screen: Read all with the box open cut a nine-line
    // answer (410 x 307, 26 px lines) to seven under Ember; after Esc it stayed cut, its last two lines (the offer)
    // behind the scroll bar for as long as it showed, because it still kept off the closed box's place.
    const cut = { visible: true, mood: "idle" as const, title: "Ember", actions: [{ id: "ui:more", label: "Read all" }] };
    const full = { ...cut, expanded: true, actions: [{ id: "ui:close", label: "Close" }, { id: "ui:conversation", label: "Open conversation" }] };
    const handle = { x: 752, y: 700, width: 260, height: 56 }, screen = { width: 1024, height: 768 };
    const box = { x: 195, y: 242, width: 728, height: 173 }, anchor = { x: 559, y: 461 }, own = { width: 410, height: 307 };
    const opened = askKeepOff(box, askKeepOffKey(full), askKeepOff(box, askKeepOffKey(cut), none), true);
    expect(bubbleFit(anchor, own, screen, 60, [handle, box], () => 307, [box])).toBeNull();
    // Cut short under Ember, its last lines scrolling inside.
    expect(bubbleCut(anchor, own, screen, 60, [handle, box], [box], 26, 307 - 234 + 3 * 26)).toEqual({ x: 336, y: 479, width: 410, height: 281 });
    // The box closes (state.askBox null): the cut answer keeps off it no more ...
    const closed = askKeepOff(null, askKeepOffKey(full), opened, true, true);
    expect(closed).toEqual({ box: null, question: askKeepOffKey(full) });
    // ... and goes whole above Ember, where all of it fits clear of the handle.
    expect(bubbleFit(anchor, own, screen, 60, [handle], () => 307, [])).toEqual({ x: 537, y: 58, width: 410, height: 307 });
    // It never moves for the box opening again (the box opens clear of it: companion-c2-4).
    expect(askKeepOff(box, askKeepOffKey(full), closed, true, false)).toBe(closed);
    // One opened in full that shows whole (not cut) stays where it is as the box closes: nothing to gain by moving it.
    expect(askKeepOff(null, askKeepOffKey(full), opened, true, false)).toBe(opened);
    // Nor does any other bubble that kept off the box (an answer that grew into it; a question): companion-c2-4.
    const grown = { box, question: askKeepOffKey(cut), grew: true as const };
    expect(askKeepOff(null, askKeepOffKey(cut), grown, false, false)).toBe(grown);
  });

  it("is a place the bubble keeps off where it can, never one it hides from (main sends it apart from the windows)", async () => {
    const { readFileSync } = await import("node:fs");
    const overlayPage = readFileSync("app/renderer/overlay/main.ts", "utf8");
    expect(overlayPage).toContain("bubble.place({ x: lx, y: ly + size * 0.4 }, viewport, size, avoid, asks ? [] : windows, focusOff, askAcross)");
    expect(overlayPage).toMatch(/askHeld = askKeepOff\(state\?\.askBox \?\? null, askKeepOffKey\(state\?\.bubble \?\? IDLE_BUBBLE\), askHeld, state\?\.bubble\.expanded === true, bubble\.isCut\(\)\);\n\s+const askAt = askHeld\.box && \{[^\n]+\};\n\s+if \(askAt\) list\.push\(askAt\);\n\s+askAcross = askAt && askHeld\.grew \? \[askAt\] : \[\];/);
    // Grown into the box as it streams or finishes: placed again at once, clear of it (companion-c3-1).
    expect(overlayPage).toContain("if (showBubble && grewIntoAsk() && bubble.place({ x: lx, y: ly + size * 0.4 }, viewport, size, avoid, asks ? [] : windows, focusOff, askAcross)) interactiveDirty = true;");
    expect(overlayPage).toContain("const next = askGrownInto(askHeld, state?.askBox ?? null, at, askGrew(b, askSeen.key === key ? askSeen.at : null, at));");
    // ... or as it finishes, larger than the last drawing showed it, which each drawing notes once it is placed.
    expect(overlayPage).toMatch(/reportBubble\(showBubble \? bubble\.rect\(\) : null\);\n(\s+\/\/[^\n]*\n)\s+askSeen = \{ key: askKeepOffKey\(state\?\.bubble \?\? IDLE_BUBBLE\), at: showBubble \? bubbleAt\(\) : null \};\n\}/);
    const main = readFileSync("app/main/main.ts", "utf8");
    expect(main).toMatch(/onBounds: askBox => \{ if \(JSON\.stringify\(lastState\.askBox \?\? null\) !== JSON\.stringify\(askBox\)\) showState\(\{ askBox \}\); agent\?\.holdForAsk\(askBox !== null\); \},/);
    expect(main).toMatch(/overlay\.setBubble\(event\.sender, rect && \{ x: rect\.x, y: rect\.y, width: rect\.width, height: rect\.height, \.\.\.\(endShown \? \{ endShown \} : \{\}\) \}\);\n(\s+\/\/[^\n]*\n)+\s+if \(\(overlay\.bubbleRect\(\)\?\.endShown === true\) !== ended\) askOffersChanged\(\);\n(\s+\/\/[^\n]*\n)+\s+askWindow\.bubbleChanged\(stepsAsideFor\(lastState\.bubble, manualCall\?\.source === "ask"\)\);/);
    // Without a compositor, the corner card grows for a question: the open box moves off it.
    expect(main).toMatch(/handle\.fit\(height\); deskViewRef\?\.handleMoved\(\); askWindow\.keepClear\(\);/);
  });
});
