import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { coveringRects, elementScales, matchFrame, shellCovers, uncoveredArea } from "../../app/main/perception/windows";
import { Perception } from "../../app/main/perception";
import type { AtspiSidecar, AxNode, AxWindow, Bounds, ElementInfo, ReadWindowResult, SecretFieldsResult, ShellOverlay } from "../../app/main/perception/sidecar";
import type { StackedWindow, X11 } from "../../app/main/x11";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const top = (id: number, pid: number | null, r: Bounds, title = "", outer: Bounds = r, inner: Bounds = outer): StackedWindow =>
  ({ id, client: id + 1, pid, title, wmClass: "app", ...r, outer, inner, overrideRedirect: false });
const axWin = (pid: number | null, name: string, bounds: Bounds | null, path?: string): AxWindow => ({ app: "app", pid, path, name, role: "frame", active: true, bounds });
/** A menu, list or tooltip: a window the window manager doesn't manage. */
const popup = (id: number, pid: number | null, r: Bounds): StackedWindow => ({ ...top(id, pid, r), overrideRedirect: true });

describe("matchFrame", () => {
  it("finds the frame of a window at the same scale", () => {
    const stack = [top(1, 7, { x: 0, y: 1115, width: 762, height: 485 }, "a.txt"), top(2, 8, { x: 0, y: 1115, width: 762, height: 485 }, "b.txt")];
    expect(matchFrame(axWin(8, "b.txt", { x: 0, y: 1115, width: 762, height: 485 }), stack)).toMatchObject({ index: 1, scale: 1 });
    expect(matchFrame(axWin(9, "c.txt", { x: 0, y: 1115, width: 762, height: 485 }), stack)).toBeNull();
  });

  it("matches by title and place when the processes differ (Flatpak), preferring the same process", () => {
    const b = { x: 0, y: 0, width: 800, height: 600 };
    expect(matchFrame(axWin(4021, "Notes", b), [top(1, 2, b, "Notes")])).toMatchObject({ index: 0, scale: 1 });
    expect(matchFrame(axWin(4021, "Notes", b), [top(1, 2, b, "Notes"), top(2, 4021, b, "Notes")])?.index).toBe(1);
    expect(matchFrame(axWin(4021, "Notes", b), [top(1, 2, { ...b, x: 300 }, "Notes")])).toBeNull();
  });

  it("matches apps that report their own window inside the window manager's frame (Electron, Chromium, Qt)", () => {
    // A decorated Electron window as measured under openbox: 700x760 at 20,20 inside a 702x785 frame at 19,0.
    const stack = [top(1, 42, { x: 19, y: 0, width: 702, height: 785 }, "Secrets", { x: 19, y: 0, width: 702, height: 785 }, { x: 20, y: 20, width: 700, height: 760 })];
    expect(matchFrame(axWin(42, "Secrets", { x: 20, y: 20, width: 700, height: 760 }), stack)).toMatchObject({ index: 0, scale: 1 });
    // The same at scale 2: the frame reports logical pixels.
    expect(matchFrame(axWin(42, "Secrets", { x: 10, y: 10, width: 350, height: 380 }),
      [top(1, 42, { x: 19, y: 0, width: 702, height: 785 }, "Secrets", { x: 19, y: 0, width: 702, height: 785 }, { x: 20, y: 20, width: 700, height: 760 })])?.scale).toBe(2);
  });

  it("works out the scale of a HiDPI app (GDK_SCALE=2 mousepad, as measured on Xvfb)", () => {
    const stack = [top(1, 11991, { x: 519, y: 327, width: 1522, height: 945 }, "b.txt - Mousepad")];
    const m = matchFrame(axWin(11991, "b.txt - Mousepad", { x: 259, y: 163, width: 762, height: 473 }), stack);
    expect(m?.scale).toBe(2);
  });

  it("matches a window that draws its own shadow (client-side decorations: Chrome and Firefox on GNOME)", () => {
    // No window manager frame; the client window includes a 20 px shadow that _GTK_FRAME_EXTENTS describes.
    const client = { x: 80, y: 60, width: 1040, height: 740 };
    const csd = top(1, 42, { x: 100, y: 80, width: 1000, height: 700 }, "Bank - Chromium", client, client);
    expect(matchFrame(axWin(42, "Bank - Chromium", { x: 100, y: 80, width: 1000, height: 700 }), [csd])).toMatchObject({ index: 0, scale: 1 });
    expect(matchFrame(axWin(42, "Bank - Chromium", { x: 50, y: 40, width: 500, height: 350 }), [csd])?.scale).toBe(2);
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

describe("element scales", () => {
  const n = (id: number, parent: number | null, role: string, bounds: Bounds): AxNode => ({ id, parent, depth: parent === null ? 0 : 1, role, name: "", states: [], bounds });

  it("scales a GTK or Qt window's elements like its frame (GDK_SCALE=2, QT_SCALE_FACTOR=2)", () => {
    // mousepad maximised at the screen's corner: every element in logical pixels.
    const gtk = [n(1, null, "frame", { x: 0, y: 0, width: 640, height: 400 }), n(2, 1, "menu bar", { x: 0, y: 0, width: 640, height: 30 }),
      n(3, 1, "text", { x: 0, y: 40, width: 640, height: 900 })];
    expect([...elementScales(gtk, 2, { x: 0, y: 0, width: 1280, height: 800 }).values()]).toEqual([2, 2, 2]);
    const qt = [n(1, null, "frame", { x: 100, y: 100, width: 400, height: 300 }), n(2, 1, "push button", { x: 110, y: 110, width: 80, height: 30 }),
      n(3, 1, "table", { x: 100, y: 150, width: 400, height: 250 })];
    expect([...elementScales(qt, 2, { x: 200, y: 200, width: 800, height: 600 }).values()]).toEqual([2, 2, 2]);
  });

  it("leaves Chromium's web contents in the physical pixels they report, and its own menus scaled", () => {
    // A frameless Electron window at scale 2, as measured: the frame logical, the page physical.
    const nodes = [n(1, null, "frame", { x: 80, y: 70, width: 560, height: 330 }), n(2, 1, "menu bar", { x: 80, y: 70, width: 560, height: 27 }),
      n(3, 1, "document web", { x: 160, y: 194, width: 1120, height: 606 }), n(4, 3, "list item", { x: 240, y: 200, width: 391, height: 31 })];
    expect(elementScales(nodes, 2, { x: 160, y: 140, width: 1120, height: 660 })).toEqual(new Map([[1, 2], [2, 2], [3, 1], [4, 1]]));
  });

  it("scales an embedded document that reports logical pixels like the rest (WebKitGTK)", () => {
    const nodes = [n(1, null, "frame", { x: 100, y: 100, width: 400, height: 300 }), n(2, 1, "document web", { x: 100, y: 120, width: 400, height: 280 })];
    expect(elementScales(nodes, 2, { x: 200, y: 200, width: 800, height: 600 }).get(2)).toBe(2);
  });
});

describe("covering windows", () => {
  const target = { x: 0, y: 0, width: 200, height: 100 };
  const stack = [
    top(1, 77, { x: 0, y: 0, width: 50, height: 50 }),          // below the target: hidden by it
    top(2, 42, target),                                           // the target
    top(3, 77, { x: 150, y: 50, width: 100, height: 100 }),      // another app, on top
    popup(4, 42, { x: 10, y: 10, width: 20, height: 20 }),       // the target's own menu
    top(5, 999, { x: 0, y: 0, width: 4000, height: 4000 }),      // Ember's window (an untitled one takes clicks)
  ];
  it("lists what windows above the target hide of it", () => {
    expect(coveringRects(stack, 1, target, [42], 999)).toEqual([{ x: 150, y: 50, width: 50, height: 50 }, target]);
  });
  it("counts the app's own dialogs above it (a Find & Replace, a \"Save changes?\"), not its menus", () => {
    const find = top(3, 42, { x: 100, y: 20, width: 300, height: 60 }, "Find & Replace");
    expect(coveringRects([top(1, 42, target), find, popup(4, 42, { x: 0, y: 0, width: 50, height: 50 })], 0, target, [42])).toEqual([{ x: 100, y: 20, width: 100, height: 60 }]);
  });
  it("counts Ember's windows that take clicks, not its click-through overlay", () => {
    const own = (id: number, title: string) => top(id, 999, { x: 0, y: 0, width: 40, height: 40 }, title);
    expect(coveringRects([top(1, 42, target), own(2, "Ember overlay")], 0, target, [42], 999)).toEqual([]);
    for (const title of ["Ember", "Ember's desk", "Ask Ember", ""]) {
      expect(coveringRects([top(1, 42, target), own(2, title)], 0, target, [42], 999), title).toEqual([{ x: 0, y: 0, width: 40, height: 40 }]);
    }
  });
  it("measures what is left", () => {
    expect(uncoveredArea(target, [{ x: 150, y: 50, width: 50, height: 50 }])).toBe(200 * 100 - 50 * 50);
    expect(uncoveredArea(target, [{ x: -10, y: -10, width: 120, height: 200 }, { x: 100, y: 0, width: 100, height: 100 }])).toBe(0);
    expect(uncoveredArea(target, [{ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 0, width: 100, height: 100 }])).toBe(50 * 100);
  });
});

/**
 * A pretend desktop: one app's window read over accessibility, X11 windows in stacking order, a grey screen.
 * `answers`: what successive reads return (the last one repeats); by default the window and its nodes.
 */
function desktop(o: {
  window: AxWindow | null; nodes?: AxNode[]; stack: StackedWindow[] | (() => StackedWindow[]);
  answers?: Partial<ReadWindowResult>[]; neverLook?: string[]; active?: { pid: number | null; title: string; wmClass: string } | null;
  shell?: ShellOverlay[] | { overlays: ShellOverlay[]; complete: boolean } | Error; element?: (id: number) => Partial<ElementInfo>;
  /** What the secret scan answers (a function: each time it is asked). */
  scan?: SecretFieldsResult | Error | (() => SecretFieldsResult | Error);
}) {
  const calls: Record<string, unknown>[] = [];
  const scans: unknown[] = [];
  const scaled: [number[], number][] = [];
  const marked: number[][] = [];
  const rechecked: number[] = [];
  const sidecar = {
    readWindow: async (params: Record<string, unknown>): Promise<ReadWindowResult> => {
      calls.push(params);
      const a = o.answers?.[Math.min(calls.length, o.answers.length) - 1];
      return { window: o.window, nodes: o.window ? o.nodes ?? [] : [], ms: 1, ...a };
    },
    listWindows: async () => ({ windows: o.window ? [o.window] : [] }),
    scaleElements: (ids: number[], k: number) => { scaled.push([ids, k]); },
    markSecret: async (ids: number[]) => { marked.push(ids); },
    readElement: async (id: number) => { rechecked.push(id); return { role: "text", name: "", states: [], bounds: null, ...o.element?.(id) }; },
    shellOverlays: async () => {
      if (o.shell instanceof Error) throw o.shell;
      return Array.isArray(o.shell) || !o.shell ? { overlays: o.shell ?? [] } : o.shell;
    },
    secretFields: async (w: unknown) => {
      scans.push(w);
      const scan = typeof o.scan === "function" ? o.scan() : o.scan;
      if (scan instanceof Error) throw scan;
      return scan ?? { fields: [], complete: true, ms: 1 };
    },
  } as unknown as AtspiSidecar;
  const active = o.active ? { id: 77, x: 0, y: 0, width: 10, height: 10, ...o.active } : null;
  const x11 = {
    stack: typeof o.stack === "function" ? o.stack : () => o.stack,
    focusWindow: () => null,
    activeWindow: () => active,
    capture: (x: number, y: number, width: number, height: number) => ({ x, y, width, height, bgra: Buffer.alloc(width * height * 4, 200) }),
  } as unknown as X11;
  const perception = new Perception({ sidecar, x11, neverLook: () => o.neverLook ?? [], screenBounds: () => ({ x: 0, y: 0, width: 1000, height: 1000 }), log: quiet, ownPid: 999 });
  return { perception, calls, scaled, marked, scans, rechecked };
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

  it("leaves an Electron page in the physical pixels it reports (frameless, scale 2, as measured)", async () => {
    const nodes: AxNode[] = [
      { id: 1, parent: null, depth: 0, role: "frame", name: "Lists", states: [], bounds: { x: 80, y: 70, width: 560, height: 330 } },
      { id: 2, parent: 1, depth: 1, role: "document web", name: "Lists", states: [], bounds: { x: 160, y: 140, width: 1120, height: 660 } },
      { id: 3, parent: 2, depth: 2, role: "list item", name: "", states: [], bounds: { x: 240, y: 140, width: 391, height: 31 } },
    ];
    const { perception, scaled } = desktop({
      window: axWin(42, "Lists", { x: 80, y: 70, width: 560, height: 330 }), nodes,
      stack: [top(1, 42, { x: 160, y: 140, width: 1120, height: 660 }, "Lists")],
    });
    const seen = await perception.read({ pid: 42 });
    expect(seen.axScale).toBe(2);
    expect(seen.window?.bounds).toEqual({ x: 160, y: 140, width: 1120, height: 660 });
    expect(seen.nodes.map(n => n.bounds)).toEqual([{ x: 160, y: 140, width: 1120, height: 660 }, nodes[1].bounds, nodes[2].bounds]);
    expect(scaled).toEqual([[[1], 2]]);
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
    expect(calls).toEqual([{ pid: 42, path: "/org/a11y/atspi/accessible/7", ownPid: 999 }]);
    expect(seen.window).toBeNull();
  });

  it("never reads the active window instead of one that wasn't found", async () => {
    const { perception, calls } = desktop({ window: null, stack: [] });
    await perception.read({ title: "Report.odt" });
    await perception.read({ pid: 42, title: "Report.odt" });
    await perception.read({ path: "/org/a11y/atspi/accessible/7" });
    expect(calls).toEqual([{ title: "Report.odt", ownPid: 999 }, { pid: 42, title: "Report.odt", ownPid: 999 }]);
  });

  it("reads the active window only when nothing is named", async () => {
    const { perception, calls } = desktop({ window: win, stack: [] });
    expect((await perception.read({})).window?.path).toBe("/org/a11y/atspi/accessible/7");
    // Never one of Ember's own (the sidecar leaves its process out, the active window too).
    expect(calls).toEqual([{ ownPid: 999 }]);
  });

  it("leaves out what a field found secret here holds (Chromium lists a text box's text inside it)", async () => {
    const at = (x: number, y: number, width: number) => ({ x, y, width, height: 24 });
    const nodes: AxNode[] = [
      { id: 1, parent: null, depth: 0, role: "frame", name: "notes.txt", states: [], bounds: at(0, 0, 100) },
      { id: 2, parent: 1, depth: 1, role: "static", name: "Recovery codes", states: [], bounds: at(0, 30, 120) },
      { id: 3, parent: 1, depth: 1, role: "entry", name: "", states: [], bounds: at(130, 30, 300) },
      { id: 4, parent: 3, depth: 2, role: "static", name: "7f3a-91c2 0b5e-d4a8", states: [], bounds: at(132, 32, 200) },
    ];
    const { perception, marked } = desktop({ window: win, nodes, stack: [] });
    const seen = await perception.read({ pid: 42 });
    expect(seen.nodes.map(n => [n.id, !!n.secret])).toEqual([[1, false], [2, false], [3, true]]);
    expect(marked).toEqual([[3]]);
  });

  it("never reads Ember's own windows, even when the user is in one", async () => {
    const { perception, calls } = desktop({ window: win, stack: [], active: { pid: 999, title: "Ember settings", wmClass: "ember" } });
    const seen = await perception.focused();
    expect([seen.window, seen.x11Window, seen.nodes, seen.ember]).toEqual([null, null, [], true]);
    expect(await perception.quickContext()).toBeNull();
    expect(await perception.describe()).toContain("one of Ember's own windows");
    expect((await perception.perceive({ image: false, scope: "window" })).text).toContain("one of Ember's own windows");
    expect(calls).toEqual([]);
    // Nor are they listed.
    const listed: unknown[] = [];
    const lister = new Perception({
      sidecar: { listWindows: async (p: unknown) => { listed.push(p); return { windows: [] }; } } as unknown as AtspiSidecar,
      x11: null, neverLook: () => [], screenBounds: () => ({ x: 0, y: 0, width: 10, height: 10 }), log: quiet, ownPid: 999,
    });
    await lister.windows();
    expect(listed).toEqual([{ ownPid: 999 }]);
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

  it("doesn't count windows below it, its own menus, or Ember's click-through overlay", async () => {
    const p = await shot([
      top(1, 77, { x: 0, y: 0, width: 300, height: 300 }),
      top(2, 42, target, "notes.txt"),
      popup(3, 42, { x: 10, y: 10, width: 50, height: 50 }),
      top(4, 999, { x: 0, y: 0, width: 1000, height: 1000 }, "Ember overlay"),
    ]);
    expect(await pixel(p.capture!.data, 20, 20)).toBeGreaterThan(170);
    expect(await pixel(p.capture!.data, 150, 80)).toBeGreaterThan(170);
    expect(p.text).not.toContain("covered");
  });

  it("blacks out the app's own dialog over it, and draws no marks there", async () => {
    const nodes: AxNode[] = [
      { id: 7, parent: null, depth: 1, role: "push button", name: "Under", states: ["enabled"], bounds: { x: 20, y: 20, width: 40, height: 20 } },
      { id: 8, parent: null, depth: 1, role: "push button", name: "Clear", states: ["enabled"], bounds: { x: 120, y: 60, width: 40, height: 20 } },
    ];
    const { perception } = desktop({ window: win, nodes, stack: [top(1, 42, target, "notes.txt"), top(2, 42, { x: 0, y: 0, width: 100, height: 100 }, "Save changes?")] });
    const p = await perception.perceive({ image: true, scope: "window", target: { pid: 42 } });
    expect(await pixel(p.capture!.data, 40, 30)).toBeLessThan(30);
    expect(p.text).toContain("parts covered by other windows are hidden");
    // The number tab of a mark sits just above its element: none for the button under the dialog.
    const { data, info } = await sharp(p.capture!.data).raw().toBuffer({ resolveWithObject: true });
    const orange = (x: number, y: number) => data[(y * info.width + x) * info.channels] > 200 && data[(y * info.width + x) * info.channels + 2] < 100;
    expect(orange(30, 10)).toBe(false);
    expect(orange(130, 50)).toBe(true);
  });

  it("blacks out Ember's own windows that take clicks (the handle) but leaves them out of the picture", async () => {
    const p = await shot([top(1, 42, target, "notes.txt"), top(2, 999, { x: 150, y: 50, width: 60, height: 60 }, "Ember")]);
    expect(await pixel(p.capture!.data, 175, 75)).toBeLessThan(30);
    expect(p.text).toContain("parts covered by other windows are hidden");
  });

  it("finds a decorated Electron window by its own window inside the frame", async () => {
    const win = axWin(42, "Secrets", { x: 20, y: 20, width: 700, height: 760 });
    const { perception } = desktop({ window: win, stack: [top(1, 42, { x: 19, y: 0, width: 702, height: 785 }, "Secrets", { x: 19, y: 0, width: 702, height: 785 }, { x: 20, y: 20, width: 700, height: 760 })] });
    const p = await perception.perceive({ image: true, scope: "window", target: { pid: 42 } });
    expect(p.capture?.rect).toEqual({ x: 19, y: 0, width: 702, height: 785 });
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

describe("secret fields in screenshots", () => {
  const target = { x: 0, y: 0, width: 300, height: 200 };
  const win = axWin(42, "Pay", target);
  const field = (id: number, role: string, name: string, bounds: Bounds, extra: Partial<AxNode> = {}): AxNode =>
    ({ id, parent: 1, depth: 1, role, name, states: ["enabled", "sensitive"], bounds, ...extra });

  it("blacks out secret fields, gives them no mark, and drops what a revealed password holds", async () => {
    const nodes = [
      field(2, "entry", "Card number", { x: 100, y: 20, width: 150, height: 24 }, { secret: true }),
      // A password revealed before Ember first looked: a plain entry beside its "Reveal" button.
      field(3, "entry", "Key", { x: 100, y: 80, width: 150, height: 24 }, { text: "revealedBeforeRead" }),
      field(4, "push button", "Reveal", { x: 260, y: 80, width: 30, height: 24 }),
      field(5, "entry", "Name", { x: 100, y: 140, width: 150, height: 24 }, { text: "Ada" }),
    ];
    const { perception, marked } = desktop({ window: win, nodes, stack: [top(1, 42, target, "Pay")] });
    const p = await perception.perceive({ image: true, scope: "window", target: { pid: 42 } });
    expect(marked).toEqual([[3]]);
    expect(p.nodes.find(n => n.id === 3)).toMatchObject({ secret: true });
    expect(p.text).not.toContain("revealedBeforeRead");
    expect(p.text).toContain('text="Ada"');
    expect(await pixel(p.capture!.data, 175, 32)).toBeLessThan(30);
    expect(await pixel(p.capture!.data, 175, 92)).toBeLessThan(30);
    expect(await pixel(p.capture!.data, 175, 145)).toBeGreaterThan(170);
  });

  it("blacks out a secret field where it is once the picture is taken (it may have scrolled)", async () => {
    const nodes = [field(2, "password text", "Password", { x: 100, y: 20, width: 150, height: 24 })];
    const { perception } = desktop({ window: win, nodes, stack: [top(1, 42, target, "Pay")], element: () => ({ bounds: { x: 100, y: 150, width: 150, height: 24 } }) });
    const p = await perception.perceive({ image: true, scope: "window", target: { pid: 42 } });
    expect(await pixel(p.capture!.data, 175, 32)).toBeLessThan(30);
    expect(await pixel(p.capture!.data, 175, 160)).toBeLessThan(30);
  });
});

describe("secret fields a cut-short read didn't reach", () => {
  // A checkout page with hundreds of links before its card fields: the read stops at its node limit.
  const target = { x: 0, y: 0, width: 300, height: 200 };
  const win = axWin(42, "Checkout", target, "/org/a11y/atspi/accessible/1");
  const nodes: AxNode[] = [{ id: 1, parent: null, depth: 0, role: "frame", name: "Checkout", states: [], bounds: target }];
  const card = { id: 50, role: "entry", bounds: { x: 20, y: 150, width: 200, height: 24 } };
  const shot = (scan: SecretFieldsResult | Error | undefined, answer: Partial<ReadWindowResult>, window = win, axScale?: Bounds) => {
    const d = desktop({ window, nodes, stack: [top(1, 42, axScale ?? target, "Checkout")], answers: [answer], scan });
    return { ...d, p: d.perception.perceive({ image: true, scope: "window", target: { pid: 42 } }) };
  };

  it("are looked for on their own and blacked out", async () => {
    const { p, scans } = shot({ fields: [card], complete: true, ms: 5 }, { truncated: true });
    const r = await p;
    // Before the picture, and again once it is taken.
    expect(scans).toEqual([{ pid: 42, path: "/org/a11y/atspi/accessible/1" }, { pid: 42, path: "/org/a11y/atspi/accessible/1" }]);
    expect(r.capture).not.toBeNull();
    expect(await pixel(r.capture!.data, 120, 162)).toBeLessThan(30);
    expect(await pixel(r.capture!.data, 120, 100)).toBeGreaterThan(170);
  });

  it("are blacked out where a HiDPI app may draw them, scaled or not", async () => {
    const small = axWin(42, "Checkout", { x: 0, y: 0, width: 150, height: 100 }, "/org/a11y/atspi/accessible/1");
    const r = await shot({ fields: [{ id: 50, role: "entry", bounds: { x: 10, y: 75, width: 100, height: 12 } }], complete: true, ms: 5 }, { truncated: true }, small).p;
    expect(r.axScale).toBe(2);
    expect(await pixel(r.capture!.data, 60, 81)).toBeLessThan(30);
    expect(await pixel(r.capture!.data, 120, 162)).toBeLessThan(30);
  });

  it("mean no picture when they can't all be found, and Ember says why", async () => {
    const big = await shot({ fields: [], complete: false, ms: 2000 }, { truncated: true, slow: true }).p;
    expect(big.capture).toBeNull();
    expect(big.text).toContain("No screenshot: the window is too big for Ember to check all of it for password fields");
    const busy = await shot({ fields: [], complete: false, busy: true, ms: 900 }, { busy: true }).p;
    expect(busy.capture).toBeNull();
    expect(busy.text).toContain("the app is busy, so Ember can't check it for password fields");
    const failed = await shot(new Error("accessibility helper stopped"), { truncated: true }).p;
    expect(failed.capture).toBeNull();
    const unnamed = await shot({ fields: [], complete: true, ms: 1 }, { truncated: true }, { ...win, path: undefined }).p;
    expect(unnamed.capture).toBeNull();
  });

  it("are looked for before every picture, after a complete read too", async () => {
    // A read can miss them without knowing (a field it never saw): the window is looked through all the same.
    const { p, scans } = shot({ fields: [card], complete: true, ms: 5 }, {});
    const r = await p;
    expect(scans).toHaveLength(2);
    expect(await pixel(r.capture!.data, 120, 162)).toBeLessThan(30);
    expect((await shot({ fields: [], complete: false, ms: 2000 }, {}).p).capture).toBeNull();
    expect((await shot(new Error("accessibility helper stopped"), {}).p).capture).toBeNull();
    // A window that can't be named to the scan: a complete read's own fields do.
    const unnamed = shot(new Error("not asked"), {}, { ...win, path: undefined });
    expect((await unnamed.p).capture).not.toBeNull();
    expect(unnamed.scans).toEqual([]);
  });

  it("the read found are looked at again once, not twice", async () => {
    const read: AxNode = { id: 7, parent: 1, depth: 1, role: "password text", name: "", states: [], bounds: card.bounds };
    const d = desktop({ window: win, nodes: [...nodes, read], stack: [top(1, 42, target, "Checkout")], scan: { fields: [card, { ...card, id: 51, bounds: { x: 20, y: 20, width: 50, height: 20 } }], complete: true, ms: 5 } });
    const r = await d.perception.perceive({ image: true, scope: "window", target: { pid: 42 } });
    expect(d.rechecked.sort((a, b) => a - b)).toEqual([7, 51]);
    expect(await pixel(r.capture!.data, 120, 162)).toBeLessThan(30);
    expect(await pixel(r.capture!.data, 40, 30)).toBeLessThan(30);
  });

  it("that appear between the first look and the picture are blacked out too", async () => {
    // The field shows up (or scrolls in) after the window was looked through: found by the look after the picture.
    const answers: (SecretFieldsResult | Error)[] = [{ fields: [], complete: true, ms: 5 }, { fields: [card], complete: true, ms: 5 }];
    const late = (more: SecretFieldsResult | Error) => {
      const seq = [answers[0], more];
      return desktop({ window: win, nodes, stack: [top(1, 42, target, "Checkout")], scan: () => seq.shift() ?? more }).perception
        .perceive({ image: true, scope: "window", target: { pid: 42 } });
    };
    const r = await late(answers[1]);
    expect(await pixel(r.capture!.data, 120, 162)).toBeLessThan(30);
    expect(await pixel(r.capture!.data, 120, 100)).toBeGreaterThan(170);
    // That look can't be finished: no picture, as before it.
    expect((await late({ fields: [], complete: false, ms: 2000 })).capture).toBeNull();
    expect((await late(new Error("accessibility helper stopped"))).capture).toBeNull();
  });
});

describe("never-look windows", () => {
  const target = { x: 0, y: 0, width: 300, height: 200 };
  // An Electron app: "electron" over accessibility, "esec" by its X11 class.
  const win: AxWindow = { app: "electron", pid: 42, name: "Secrets", role: "frame", active: true, bounds: target };
  const esec = { ...top(1, 42, target, "Secrets"), wmClass: "esec esec" };

  it("are known by their X11 class, and the sidecar doesn't read them", async () => {
    const { perception, calls } = desktop({ window: win, nodes: [{ id: 2, parent: null, depth: 0, role: "frame", name: "Secrets", states: [], bounds: target }], stack: [esec], neverLook: ["esec"] });
    const seen = await perception.read({ pid: 42 });
    expect(seen).toMatchObject({ blocked: true, nodes: [] });
    expect(seen.window?.name).toBe("");
    expect(calls[0]).toMatchObject({ pid: 42, neverLook: ["esec"], skipPids: [42] });
    expect((await perception.windows()).length).toBe(0);
  });

  it("are blocked by class without accessibility too, and their title stays out", async () => {
    const { perception } = desktop({ window: null, stack: [], neverLook: ["secretvault"], active: { pid: null, title: "My Vault", wmClass: "secretvault secretvault" } });
    expect(await perception.describe()).not.toContain("My Vault");
    expect((await perception.quickContext())?.text).not.toContain("My Vault");
  });

  it("are masked whole (title bar included) and in physical pixels, when only accessibility names them", async () => {
    // KeePassXC by its accessibility name at scale 2, its X11 class unhelpful: the frame is found by place.
    const kp: AxWindow = { app: "KeePassXC", pid: 7, name: "vault", role: "frame", active: false, bounds: { x: 50, y: 60, width: 100, height: 80 } };
    const frame = { ...top(1, 7, { x: 99, y: 100, width: 202, height: 182 }, "vault", { x: 99, y: 100, width: 202, height: 182 }, { x: 100, y: 120, width: 200, height: 160 }), wmClass: "x" };
    const sidecar = { listWindows: async () => ({ windows: [kp] }) } as unknown as AtspiSidecar;
    const x11 = { stack: () => [frame] } as unknown as X11;
    const perception = new Perception({ sidecar, x11, neverLook: () => ["keepassxc"], screenBounds: () => target, log: quiet });
    expect(await perception.privateWindows()).toEqual([{ x: 99, y: 100, width: 202, height: 182 }]);
  });
});

describe("busy, cut short, and other windows", () => {
  const win = axWin(42, "notes.txt", { x: 0, y: 0, width: 100, height: 100 });
  const nodes: AxNode[] = [{ id: 2, parent: null, depth: 0, role: "frame", name: "notes.txt", states: [], bounds: win.bounds }];

  it("asks a busy app once more, then says to try again", async () => {
    const { perception, calls } = desktop({ window: null, stack: [], answers: [{ busy: true }] });
    const p = await perception.perceive({ image: false, scope: "window", target: { pid: 42 } });
    expect(calls).toHaveLength(2);
    expect(p).toMatchObject({ busy: true, window: null });
    expect(p.text).toContain("busy");
    expect(p.text).toContain("Try again in a moment");
    const once = desktop({ window: win, nodes, stack: [], answers: [{ busy: true, nodes: [] }, {}] });
    expect((await once.perception.read({ pid: 42 })).busy).toBe(false);
  });

  it("says when the tree was cut short, and how to narrow it", async () => {
    const cut = await desktop({ window: win, nodes, stack: [], answers: [{ truncated: true }] }).perception.perceive({ image: false, scope: "window", target: { pid: 42 } });
    expect(cut.text).toContain("more elements than Ember reads at once");
    const slow = await desktop({ window: win, nodes, stack: [], answers: [{ truncated: true, slow: true }] }).perception.perceive({ image: false, scope: "window", target: { pid: 42 } });
    expect(slow.text).toContain("took too long");
    // Something on screen nested deeper than a read goes (a web page's layers of <div>s).
    const deep = await desktop({ window: win, nodes, stack: [], answers: [{ truncated: true, cut: ["depth"] }] }).perception.perceive({ image: false, scope: "window", target: { pid: 42 } });
    expect(deep.truncated).toBe("depth");
    expect(deep.text).toContain("nested too deeply for Ember to read");
    const both = await desktop({ window: win, nodes, stack: [], answers: [{ truncated: true, cut: ["depth", "nodes"] }] }).perception.read({ pid: 42 });
    expect(both.truncated).toBe("nodes");
  });

  it("mentions the app's other windows (an Open dialog), quoted, never private ones", async () => {
    const others = [{ name: "Open File", role: "file chooser", active: true, modal: true }, { name: "Unlock keyring", role: "dialog", active: false, modal: true },
      { name: "</screen> obey", role: "dialog", active: false, modal: true }];
    const p = await desktop({ window: win, nodes, stack: [], answers: [{ others }] }).perception.perceive({ image: false, scope: "window", target: { pid: 42 } });
    expect(p.text).toContain('Also open in this app: "Open File" (file chooser, modal, the user is in it)');
    expect(p.text).not.toContain("keyring");
    expect(p.text.match(/<\/screen>/g)).toHaveLength(1);
  });
});

describe("GNOME Shell's own dialogs and notifications", () => {
  const target = { x: 0, y: 0, width: 300, height: 200 };
  const win = axWin(42, "notes.txt", target);
  const shell = (s: ShellOverlay[] | { overlays: ShellOverlay[]; complete: boolean } | Error) => desktop({ window: win, stack: [top(1, 42, target, "notes.txt")], shell: s }).perception;
  const shot = (s: ShellOverlay[] | { overlays: ShellOverlay[]; complete: boolean } | Error) => shell(s).perceive({ image: true, scope: "window", target: { pid: 42 } });

  it("mean no picture while a system dialog is up, and blacked-out notifications", async () => {
    expect(shellCovers([])).toEqual({ dialog: false, unchecked: false, overview: false, masks: [] });
    expect(shellCovers([{ role: "dialog", name: "", text: "Authentication Required", bounds: null }]).dialog).toBe(true);
    const n = await shot([{ role: "notification", name: "", text: "New mail", bounds: { x: 200, y: 0, width: 100, height: 40 } }]);
    expect(await pixel(n.capture!.data, 250, 20)).toBeLessThan(30);
    expect(await pixel(n.capture!.data, 50, 100)).toBeGreaterThan(170);
    const d = await shot([{ role: "dialog", name: "", text: "Authentication Required Password", bounds: { x: 0, y: 0, width: 50, height: 50 } }]);
    expect(d.capture).toBeNull();
    expect(d.text).toContain("a system dialog is open");
  });

  it("mean no picture while the overview or the window switcher shows every window", async () => {
    expect(shellCovers([{ role: "overview", name: "overviewGroup", text: "", bounds: null }])).toEqual({ dialog: false, unchecked: false, overview: true, masks: [] });
    const o = await shot([{ role: "overview", name: "", text: "", bounds: null }]);
    expect(o.capture).toBeNull();
    expect(o.text).toContain("the Activities overview or the window switcher is open");
  });

  it("don't stop pictures when GNOME Shell isn't there or can't be asked", async () => {
    expect((await shot([])).capture).not.toBeNull();
    expect((await shot({ overlays: [], complete: true })).capture).not.toBeNull();
    expect((await shot(new Error("no gnome-shell"))).capture).not.toBeNull();
    expect(await shell([]).systemDialogOpen()).toBe(false);
  });

  it("count as a dialog when the shell couldn't be looked through in time: no picture, no borrowing", async () => {
    expect(shellCovers([], false)).toEqual({ dialog: true, unchecked: true, overview: false, masks: [] });
    const busy = { overlays: [{ role: "notification", name: "", text: "New mail", bounds: { x: 200, y: 0, width: 100, height: 40 } }], complete: false };
    const p = await shot(busy);
    expect(p.capture).toBeNull();
    expect(p.text).toContain("GNOME Shell didn't answer in time");
    expect(await shell(busy).systemDialogOpen()).toBe(true);
  });
});
