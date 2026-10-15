import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { coveringRects, matchFrame, uncoveredArea } from "../../app/main/perception/windows";
import { Perception } from "../../app/main/perception";
import type { AtspiSidecar, AxNode, AxWindow, Bounds, ReadWindowResult } from "../../app/main/perception/sidecar";
import type { StackedWindow, X11 } from "../../app/main/x11";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const top = (id: number, pid: number | null, r: Bounds, title = "", outer: Bounds = r): StackedWindow =>
  ({ id, client: id + 1, pid, title, wmClass: "app", ...r, outer, overrideRedirect: false });
const axWin = (pid: number | null, name: string, bounds: Bounds | null, path?: string): AxWindow => ({ app: "app", pid, path, name, role: "frame", active: true, bounds });

describe("matchFrame", () => {
  it("finds the frame of a window at the same scale", () => {
    const stack = [top(1, 7, { x: 0, y: 1115, width: 762, height: 485 }, "a.txt"), top(2, 8, { x: 0, y: 1115, width: 762, height: 485 }, "b.txt")];
    expect(matchFrame(axWin(8, "b.txt", { x: 0, y: 1115, width: 762, height: 485 }), stack)).toMatchObject({ index: 1, scale: 1 });
    expect(matchFrame(axWin(9, "b.txt", { x: 0, y: 1115, width: 762, height: 485 }), stack)).toBeNull();
  });

  it("works out the scale of a HiDPI app (GDK_SCALE=2 mousepad, as measured on Xvfb)", () => {
    const stack = [top(1, 11991, { x: 519, y: 327, width: 1522, height: 945 }, "b.txt - Mousepad")];
    const m = matchFrame(axWin(11991, "b.txt - Mousepad", { x: 259, y: 163, width: 762, height: 473 }), stack);
    expect(m?.scale).toBe(2);
  });

  it("tells an app's windows apart by place and title, and ignores popups and other shapes", () => {
    const stack = [
      top(1, 7, { x: 0, y: 0, width: 400, height: 300 }, "Inbox"),
      top(2, 7, { x: 500, y: 0, width: 400, height: 300 }, "Compose"),
      { ...top(3, 7, { x: 500, y: 0, width: 400, height: 300 }, "Compose"), overrideRedirect: true },
    ];
    expect(matchFrame(axWin(7, "Compose", { x: 500, y: 0, width: 400, height: 300 }), stack)?.index).toBe(1);
    expect(matchFrame(axWin(7, "Inbox", { x: 0, y: 0, width: 400, height: 300 }), stack)?.index).toBe(0);
    expect(matchFrame(axWin(7, "Inbox", { x: 0, y: 0, width: 400, height: 100 }), stack)).toBeNull();
    // No pid on one side: the title has to match.
    expect(matchFrame(axWin(null, "Inbox", { x: 0, y: 0, width: 400, height: 300 }), [top(1, null, { x: 0, y: 0, width: 400, height: 300 }, "Inbox")])?.index).toBe(0);
  });
});

describe("covering windows", () => {
  const target = { x: 0, y: 0, width: 200, height: 100 };
  const stack = [
    top(1, 77, { x: 0, y: 0, width: 50, height: 50 }),          // below the target: hidden by it
    top(2, 42, target),                                           // the target
    top(3, 77, { x: 150, y: 50, width: 100, height: 100 }),      // another app, on top
    top(4, 42, { x: 10, y: 10, width: 20, height: 20 }),         // the target's own menu
    top(5, 999, { x: 0, y: 0, width: 4000, height: 4000 }),      // Ember's overlay
  ];
  it("lists what windows above the target hide of it", () => {
    expect(coveringRects(stack, 1, target, [999, 42])).toEqual([{ x: 150, y: 50, width: 50, height: 50 }]);
  });
  it("measures what is left", () => {
    expect(uncoveredArea(target, [{ x: 150, y: 50, width: 50, height: 50 }])).toBe(200 * 100 - 50 * 50);
    expect(uncoveredArea(target, [{ x: -10, y: -10, width: 120, height: 200 }, { x: 100, y: 0, width: 100, height: 100 }])).toBe(0);
    expect(uncoveredArea(target, [{ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 0, width: 100, height: 100 }])).toBe(50 * 100);
  });
});

/** A pretend desktop: one app's window read over accessibility, X11 windows in stacking order, a grey screen. */
function desktop(o: { window: AxWindow | null; nodes?: AxNode[]; stack: StackedWindow[] | (() => StackedWindow[]) }) {
  const calls: Record<string, unknown>[] = [];
  const scaled: [number[], number][] = [];
  const sidecar = {
    readWindow: async (params: Record<string, unknown>): Promise<ReadWindowResult> => {
      calls.push(params);
      return { window: o.window, nodes: o.window ? o.nodes ?? [] : [], ms: 1 };
    },
    listWindows: async () => ({ windows: o.window ? [o.window] : [] }),
    scaleElements: (ids: number[], k: number) => { scaled.push([ids, k]); },
  } as unknown as AtspiSidecar;
  const x11 = {
    stack: typeof o.stack === "function" ? o.stack : () => o.stack,
    focusWindow: () => null,
    activeWindow: () => null,
    capture: (x: number, y: number, width: number, height: number) => ({ x, y, width, height, bgra: Buffer.alloc(width * height * 4, 200) }),
  } as unknown as X11;
  const perception = new Perception({ sidecar, x11, neverLook: () => [], screenBounds: () => ({ x: 0, y: 0, width: 1000, height: 1000 }), log: quiet, ownPid: 999 });
  return { perception, calls, scaled };
}

async function pixel(data: Buffer, x: number, y: number): Promise<number> {
  const { data: raw, info } = await sharp(data).raw().toBuffer({ resolveWithObject: true });
  return raw[(y * info.width + x) * info.channels];
}

describe("HiDPI windows", () => {
  const node: AxNode = { id: 20000005, parent: null, depth: 1, role: "push button", name: "Save", states: ["enabled"], bounds: { x: 300, y: 200, width: 40, height: 20 } };

  it("hands out physical pixels and says by how much it scaled", async () => {
    const { perception, scaled } = desktop({
      window: axWin(42, "b.txt", { x: 259, y: 163, width: 762, height: 473 }), nodes: [node],
      stack: [top(1, 42, { x: 519, y: 327, width: 1522, height: 945 }, "b.txt")],
    });
    const seen = await perception.read({ pid: 42 });
    expect(seen.axScale).toBe(2);
    expect(seen.nodes[0].bounds).toEqual({ x: 600, y: 400, width: 80, height: 40 });
    expect(seen.window?.bounds).toEqual({ x: 518, y: 326, width: 1524, height: 946 });
    // Later reads of these elements (readElement, action results) are scaled by the sidecar client.
    expect(scaled).toEqual([[[20000005], 2]]);
  });

  it("leaves ordinary windows alone", async () => {
    const { perception, scaled } = desktop({
      window: axWin(42, "a.txt", { x: 0, y: 0, width: 762, height: 485 }), nodes: [node],
      stack: [top(1, 42, { x: 0, y: 0, width: 762, height: 485 }, "a.txt")],
    });
    const seen = await perception.read({ pid: 42 });
    expect([seen.axScale, seen.nodes[0].bounds]).toEqual([1, node.bounds]);
    expect(scaled).toEqual([]);
  });
});

describe("reading a named window", () => {
  const win = axWin(42, "notes.txt", { x: 0, y: 0, width: 100, height: 100 }, "/org/a11y/atspi/accessible/7");

  it("asks for exactly that window, by pid and path", async () => {
    const { perception, calls } = desktop({ window: null, stack: [] });
    const seen = await perception.read({ pid: 42, path: "/org/a11y/atspi/accessible/7", title: "notes.txt" });
    expect(calls).toEqual([{ pid: 42, path: "/org/a11y/atspi/accessible/7" }]);
    expect(seen.window).toBeNull();
  });

  it("never reads the active window instead of one that wasn't found", async () => {
    const { perception, calls } = desktop({ window: null, stack: [] });
    await perception.read({ title: "Report.odt" });
    await perception.read({ pid: 42, title: "Report.odt" });
    await perception.read({ path: "/org/a11y/atspi/accessible/7" });
    expect(calls).toEqual([{ title: "Report.odt" }, { pid: 42, title: "Report.odt" }]);
  });

  it("reads the active window only when nothing is named", async () => {
    const { perception, calls } = desktop({ window: win, stack: [] });
    expect((await perception.read({})).window?.path).toBe("/org/a11y/atspi/accessible/7");
    expect(calls).toEqual([{}]);
  });
});

describe("window screenshots", () => {
  const target = { x: 0, y: 0, width: 200, height: 100 };
  const win = axWin(42, "notes.txt", target);
  const shot = (stack: StackedWindow[] | (() => StackedWindow[])) => desktop({ window: win, stack }).perception.perceive({ image: true, scope: "window", target: { pid: 42 } });

  it("blacks out other apps' windows on top of the window, and says so", async () => {
    const p = await shot([top(1, 42, target, "notes.txt"), top(2, 77, { x: 150, y: 50, width: 100, height: 100 }, "Bank - Firefox")]);
    expect(p.capture).not.toBeNull();
    expect(await pixel(p.capture!.data, 175, 75)).toBeLessThan(30);
    expect(await pixel(p.capture!.data, 50, 50)).toBeGreaterThan(170);
    expect(p.text).toContain("(Screenshot: parts covered by other windows are hidden.)");
  });

  it("doesn't count windows below it, its own menus, or Ember", async () => {
    const p = await shot([
      top(1, 77, { x: 0, y: 0, width: 300, height: 300 }),
      top(2, 42, target, "notes.txt"),
      top(3, 42, { x: 10, y: 10, width: 50, height: 50 }),
      top(4, 999, { x: 0, y: 0, width: 1000, height: 1000 }),
    ]);
    expect(await pixel(p.capture!.data, 20, 20)).toBeGreaterThan(170);
    expect(await pixel(p.capture!.data, 150, 80)).toBeGreaterThan(170);
    expect(p.text).not.toContain("covered");
  });

  it("takes no picture of a window that is covered, or can't be found", async () => {
    const covered = await shot([top(1, 42, target, "notes.txt"), top(2, 77, { x: 0, y: 0, width: 300, height: 300 })]);
    expect(covered.capture).toBeNull();
    expect(covered.text).toContain("(No screenshot: the window is covered by other windows.)");
    const lost = await shot([top(1, 43, { x: 500, y: 500, width: 10, height: 10 })]);
    expect(lost.capture).toBeNull();
    expect(lost.text).toContain("can't tell what covers it");
  });

  it("also blacks out a window that came on top while the picture was taken", async () => {
    let looks = 0;
    const p = await shot(() => (looks++ === 0
      ? [top(1, 42, target, "notes.txt")]
      : [top(1, 42, target, "notes.txt"), top(2, 77, { x: 0, y: 0, width: 50, height: 50 })]));
    expect(await pixel(p.capture!.data, 10, 10)).toBeLessThan(30);
    expect(p.text).toContain("parts covered by other windows are hidden");
  });
});
