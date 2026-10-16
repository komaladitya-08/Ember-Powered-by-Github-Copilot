/**
 * Scrolling with the user's wheel (tier 3), with a pretend app: the wheel never lands on a control it would change,
 * also where a read can't see (GTK 3 hides a page scrolled past its first screen from reads), inside a notebook,
 * and without reading the whole window for every notch. And clearing a field leaves the user's clipboard alone.
 */

import { describe, expect, it } from "vitest";
import { Worker, aimedAt, atSpot, cellSettled, cellTook, formulaIn, sameCellValue, seesInside, sheetNumbers, tabPage, takerInside, wheelControls, wheelTarget, type WorkerDeps } from "../../app/main/agent/worker";
import { marksSvg } from "../../app/main/perception/marks";
import { Presenter } from "../../app/main/agent/presenter";
import { PolicyEngine } from "../../app/main/policy/policy";
import type { AxNode, Bounds, PointElement } from "../../app/main/perception/sidecar";
import type { Hand } from "../../app/main/hands/borrow";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const FRAME: Bounds = { x: 0, y: 0, width: 800, height: 600 };
const under = (p: { x: number; y: number }, b: Bounds) => p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;

interface Item { role: string; name: string; bounds: Bounds; states?: string[]; text?: string }

/**
 * A settings page: `items` at their places when it isn't scrolled, moving up `notch` px per wheel notch inside the
 * frame (y 40 to 600). `blindAfter`: past this far, reads see only the frame and its scroll bar (GTK 3's viewport).
 */
function app(items: Item[], o: { notch?: number; blindAfter?: number; atPoint?: boolean; read?: (n: number, nodes: AxNode[]) => object; extra?: AxNode[]; clip?: Bounds; emptyChain?: boolean } = {}) {
  const st = { offset: 0, reads: 0, points: 0, asked: 0, notches: [] as { x: number; y: number }[], keys: [] as string[], typed: [] as string[], pointer: { x: 0, y: 0 }, clicks: [] as { x: number; y: number }[] };
  const notch = o.notch ?? 40;
  const shown = () => items.map((it, i) => ({ id: i + 2, parent: 1, depth: 2, role: it.role, name: it.name, states: it.states ?? ["enabled", "sensitive"], ...(it.text !== undefined ? { text: it.text } : {}), bounds: { ...it.bounds, y: it.bounds.y - st.offset } }))
    .filter(n => n.bounds.y + n.bounds.height > 40 && n.bounds.y < 600);
  const frame: AxNode = { id: 1, parent: null, depth: 0, role: "frame", name: "Settings", states: [], bounds: FRAME };
  const bar: AxNode = { id: 99, parent: 1, depth: 1, role: "scroll bar", name: "", states: [], bounds: { x: 785, y: 40, width: 15, height: 560 } };
  const nodes = (): AxNode[] => (o.blindAfter !== undefined && st.offset > o.blindAfter ? [frame, bar] : [frame, ...shown(), ...(o.extra ?? []), bar]);
  const window = { app: "settings", pid: 7, path: "/org/a11y/atspi/accessible/9", name: "Settings", role: "frame", active: true, bounds: FRAME };
  const seen = () => ({ window, x11Window: null, nodes: nodes(), blocked: false, busy: false, truncated: null, others: [], ms: 0, axScale: 1 });
  const perception = {
    perceive: async () => ({ ...seen(), text: "<screen>", capture: null }),
    read: async () => { st.reads++; const s = seen(); return { ...s, ...(o.read?.(st.reads, s.nodes) ?? {}) }; },
    windows: async () => [window],
    ...(o.atPoint ? {
      atPoint: async (_t: unknown, p: { x: number; y: number }): Promise<PointElement[]> => {
        st.points++;
        // Chromium's hit test from the window can end on an empty panel lying over its page.
        if (o.emptyChain) return [{ role: "panel", name: "", bounds: FRAME, empty: true }];
        const hit = shown().find(n => under(p, n.bounds));
        return [{ role: "scroll pane", name: "", bounds: { x: 0, y: 40, width: 800, height: 560 } }, ...(hit ? [{ role: hit.role, name: hit.name, bounds: hit.bounds }] : [])];
      },
    } : {}),
  };
  const sidecar = {
    readElement: async (id: number) => {
      const n = id === 1 ? frame : nodes().find(x => x.id === id) ?? shown().find(x => x.id === id) ?? { ...items[id - 2], states: items[id - 2].states ?? [], bounds: null };
      // The real helper says which part of an element shows (inside its scroll pane and its window).
      const b = n.bounds, c = o.clip;
      const cut = b && c ? { x: Math.max(b.x, c.x), y: Math.max(b.y, c.y), width: Math.max(0, Math.min(b.x + b.width, c.x + c.width) - Math.max(b.x, c.x)), height: Math.max(0, Math.min(b.y + b.height, c.y + c.height) - Math.max(b.y, c.y)) } : null;
      const shownPart = cut && b && (cut.width !== b.width || cut.height !== b.height) ? { shown: cut } : {};
      return { role: n.role, name: n.name, states: n.states, bounds: n.bounds, ...shownPart, ...(n.text !== undefined ? { text: n.text } : {}) };
    },
    setText: async () => { throw new Error("background_unavailable: this app takes no text this way"); },
    doAction: async () => { throw new Error("background_unavailable: no accessible action"); },
  };
  const hand: Hand = {
    glideTo: async (x: number, y: number) => { st.pointer = { x, y }; },
    click: async () => { st.clicks.push(st.pointer); },
    keys: async (k: string) => { st.keys.push(k); if (k === "Delete") for (const it of items) if (it.text !== undefined) it.text = ""; },
    type: async (t: string) => { st.typed.push(t); },
    scroll: async (_d: string, n: number) => { for (let i = 0; i < n; i++) { st.notches.push(st.pointer); st.offset += notch; } },
  } as unknown as Hand;
  const clip = { saved: 0, written: [] as string[], restored: 0 };
  const w = new Worker({
    client: {} as never, log: quiet, model: "m", vision: false, workDir: "/tmp",
    perception: perception as never, sidecar: sidecar as never,
    policy: new PolicyEngine({ neverLook: () => [], grants: () => ({ settings: "act" }) }),
    confirmer: { ask: async () => { st.asked++; return "once"; } } as never,
    audit: { write: () => undefined } as never,
    settings: { get: () => ({ grants: {} }), update: () => undefined } as never,
    presenter: new Presenter(() => undefined),
    lease: async () => () => undefined, flyTo: () => undefined, onProgress: () => undefined,
    cursor: { borrow: { borrow: async (fn: (h: Hand) => Promise<void>, b: { onStart?: () => void }) => { b.onStart?.(); await fn(hand); } } as never, findWindow: () => 1, setBorrowing: () => undefined },
    clipboard: {
      save: async () => { clip.saved++; return { items: [{ "text/plain": "the user's" }], look: "x" }; },
      unchanged: async () => true,
      writeText: async (t: string) => { clip.written.push(t); },
      restore: async () => { clip.restored++; },
    },
  } as unknown as WorkerDeps, { id: "t1", goal: "change the settings", target: { title: "Settings" } });
  const call = (name: string, args: Record<string, unknown>) => w.tools().find(t => t.name === name)!.handler!(args, {} as never) as Promise<{ textResultForLlm: string; resultType: string }>;
  return { w, st, call, clip };
}

/** Labels down the left (rows 40 px apart from y 60), and a slider as wide as the page in row `sliderRow`. */
const rows = (sliderRow: number): Item[] => Array.from({ length: 40 }, (_, i) => (i === sliderRow
  ? { role: "slider", name: "", bounds: { x: 10, y: 60 + 40 * i, width: 760, height: 30 } }
  : { role: "label", name: `Row ${i}`, bounds: { x: 10, y: 60 + 40 * i, width: 150, height: 30 } }));

describe("the wheel and what it can't see (review round 5)", () => {
  it("a read that can't see inside the page any more stops the wheel before a control can come under it", async () => {
    // GTK 3: past the first screen, reads show the frame and the scroll bar only. The slider in row 20 reaches the
    // wheel (row 0's middle, y 75) after 20 notches; reads are blind from the 14th.
    const { st, call } = app(rows(20), { blindAfter: 540 });
    await call("perceive_window", {});
    const r = await call("scroll", { id: 2, direction: "down", steps: 25 });
    expect(r.textResultForLlm).toMatch(/^Scrolled 14 of 25 steps, then stopped: Ember couldn't see what would come under the wheel next \(the app reports nothing there\)/);
    expect(st.notches).toHaveLength(14);
  });

  it("each notch is checked at the wheel alone: the slider stops it, and the window is read once", async () => {
    const { st, call } = app(rows(20), { blindAfter: 540, atPoint: true });
    await call("perceive_window", {});
    const r = await call("scroll", { id: 2, direction: "down", steps: 25 });
    expect(r.textResultForLlm).toMatch(/^Scrolled 20 of 25 steps, then stopped: "slider" \("slider"\) came under the wheel/);
    expect(st.notches).toHaveLength(20);
    // Once before the user is asked (what would stop it stops it first, W7-3), and once the window is in front.
    expect(st.reads).toBe(2);
    expect(st.points).toBe(22);
  });

  it("nothing is scrolled where a read sees nothing, the app is busy, or (looking notch by notch) left part of the window out", async () => {
    for (const [o, why] of [
      [{ read: (_: number, nodes: AxNode[]) => ({ nodes: nodes.filter(n => n.role === "frame" || n.role === "scroll bar") }) }, "the app reports nothing there"],
      [{ read: () => ({ busy: true }) }, "the app didn't answer in time"],
      [{ read: () => ({ truncated: "nodes" }) }, "the window has more in it than Ember reads at once"],
    ] as const) {
      const { st, call } = app(rows(20), o);
      await call("perceive_window", {});
      const r = await call("scroll", { id: 2, direction: "down", steps: 3 });
      expect(r.textResultForLlm).toBe(`Ember couldn't see what the wheel would land on there (${why}), so nothing was scrolled. Call perceive_window and try again; if it happens again, tell the user in finish_task.`);
      expect(st.notches).toEqual([]);
    }
    // Checked at the wheel, a read that left something out elsewhere doesn't matter.
    const { st, call } = app(rows(20), { read: () => ({ truncated: "nodes" }), atPoint: true });
    await call("perceive_window", {});
    expect((await call("scroll", { id: 2, direction: "down", steps: 3 })).textResultForLlm).toMatch(/^Done/);
    expect(st.notches).toHaveLength(3);
  });

  it("a text editor's notebook (GTK 3's tab list covers the page) is scrolled; its tabs are not", async () => {
    // Mousepad, gedit: the tab list holds the page; a tab, and the text view under it.
    const extra: AxNode[] = [
      { id: 50, parent: 1, depth: 1, role: "page tab list", name: "", states: [], bounds: { x: 0, y: 40, width: 800, height: 560 } },
      { id: 51, parent: 50, depth: 2, role: "page tab", name: "notes.txt", states: [], bounds: { x: 20, y: 44, width: 90, height: 26 } },
    ];
    const text: Item = { role: "text", name: "", bounds: { x: 1, y: 72, width: 780, height: 520 }, states: ["enabled", "editable", "multi line"] };
    for (const atPoint of [false, true]) {
      const { st, call } = app([text], { extra, notch: 0, atPoint });
      await call("perceive_window", {});
      expect((await call("scroll", { id: 2, direction: "down", steps: 3 })).textResultForLlm).toMatch(/^Done/);
      expect(st.notches).toHaveLength(3);
    }
    expect(wheelControls(extra).map(n => n.bounds)).toEqual([{ x: 20, y: 44, width: 90, height: 26 }]);
    // No tabs shown (one document): nothing there the wheel changes; the wheel over a tab would switch it (Qt).
    expect(wheelControls(extra.slice(0, 1))).toEqual([]);
    const chain = [{ role: "page tab list", name: "", bounds: extra[0].bounds }, { role: "page tab", name: "notes.txt", bounds: extra[1].bounds }];
    expect(wheelTarget(chain, { x: 300, y: 300 })).toBeUndefined();
    expect(wheelTarget(chain, { x: 30, y: 50 })?.name).toBe("notes.txt");
    expect(wheelTarget([...chain, { role: "combo box", name: "Size", bounds: null }], { x: 300, y: 300 })?.role).toBe("combo box");
  });

  it("what counts as seeing inside where the wheel goes", () => {
    const region = { x: 10, y: 60, width: 150, height: 30 };
    const frame: AxNode = { id: 1, parent: null, depth: 0, role: "frame", name: "W", states: [], bounds: FRAME };
    const bar: AxNode = { id: 2, parent: 1, depth: 1, role: "scroll bar", name: "", states: [], bounds: { x: 0, y: 0, width: 800, height: 600 } };
    expect(seesInside([frame, bar], region)).toBe(false);
    // A text view holding all of it is what is there; a list holding it is only where its rows are.
    expect(seesInside([frame, { ...bar, id: 3, role: "text" }], region)).toBe(true);
    const list: AxNode = { id: 4, parent: 1, depth: 1, role: "list", name: "", states: [], bounds: FRAME };
    expect(seesInside([frame, list, { ...bar, id: 5, parent: 4, role: "list item", bounds: { x: 0, y: 300, width: 800, height: 30 } }], region)).toBe(false);
    expect(seesInside([frame, list, { ...bar, id: 5, parent: 4, role: "list item", bounds: { x: 0, y: 80, width: 800, height: 30 } }], region)).toBe(true);
  });
});

describe("where the wheel and the mouse go (review round 6)", () => {
  /** A GTK 3 notebook: its tab list holds the page (tabs along the top). */
  const notebook: AxNode[] = [
    { id: 50, parent: 1, depth: 1, role: "page tab list", name: "", states: [], bounds: { x: 0, y: 40, width: 800, height: 560 } },
    { id: 51, parent: 50, depth: 2, role: "page tab", name: "Editor", states: ["selected"], bounds: { x: 20, y: 44, width: 90, height: 26 } },
    { id: 52, parent: 50, depth: 2, role: "page tab", name: "View", states: [], bounds: { x: 120, y: 44, width: 90, height: 26 } },
  ];

  it("a tab list (GTK 3's holds its page) scrolls the page, checked notch by notch: never over a spin button", async () => {
    // A preferences page of spin buttons: one as wide as the page reaches the wheel after three notches. The wheel used
    // to go to the tab list's middle unchecked, like a control asked to change, and turned it.
    const spin: Item = { role: "spin button", name: "Opt 8", bounds: { x: 0, y: 380, width: 800, height: 30 }, states: ["enabled", "editable"] };
    for (const atPoint of [true, false]) {
      const { st, call } = app([spin], { extra: notebook, notch: 20, atPoint });
      await call("perceive_window", {});
      const r = await call("scroll", { id: 50, direction: "down", steps: 5 });
      expect(r.textResultForLlm).toMatch(/^Scrolled 3 of 5 steps, then stopped: "Opt 8" \("spin button"\) came under the wheel/);
      // In the page, below the tabs.
      expect(st.notches).toEqual(Array(3).fill({ x: 120, y: 335 }));
    }
    expect(tabPage(notebook, notebook[0].bounds!, notebook[0].bounds!)).toEqual({ x: 0, y: 70, width: 800, height: 530 });
    // Tabs down the left side; and no tabs shown (one page): all of it.
    const left = notebook.map((n, i) => (i ? { ...n, bounds: { x: 2, y: 50 + 30 * i, width: 80, height: 28 } } : n));
    expect(tabPage(left, left[0].bounds!, left[0].bounds!)).toEqual({ x: 82, y: 40, width: 718, height: 560 });
    expect(tabPage(notebook.slice(0, 1), notebook[0].bounds!, notebook[0].bounds!)).toEqual(notebook[0].bounds);
  });

  it("a tab list that is only its tabs (Qt's tab bar) is the control asked for: the wheel goes over its tabs", async () => {
    const bar: AxNode[] = [
      { id: 50, parent: 1, depth: 1, role: "page tab list", name: "", states: [], bounds: { x: 0, y: 40, width: 800, height: 30 } },
      { id: 51, parent: 50, depth: 2, role: "page tab", name: "One", states: [], bounds: { x: 2, y: 42, width: 90, height: 26 } },
    ];
    expect(tabPage(bar, bar[0].bounds!, bar[0].bounds!)).toBeNull();
    const { st, call } = app([], { extra: bar, atPoint: true });
    await call("perceive_window", {});
    expect((await call("scroll", { id: 50, direction: "down", steps: 2 })).textResultForLlm).toMatch(/^Done/);
    expect(st.notches).toEqual([{ x: 120, y: 55 }, { x: 120, y: 55 }]);
  });

  it("a list taller than its window is scrolled from the part of it that shows", async () => {
    // GtkListBox in a scrolled window (GNOME Settings): 1413 px tall in a 560 px pane. Its middle is off the window.
    const list: Item = { role: "list box", name: "", bounds: { x: 0, y: 40, width: 780, height: 1413 } };
    const pane = { x: 0, y: 40, width: 785, height: 560 };
    const { st, call } = app([list], { notch: 0, atPoint: true, clip: pane });
    await call("perceive_window", {});
    expect((await call("scroll", { id: 2, direction: "down", steps: 3 })).textResultForLlm).toMatch(/^Done/);
    expect(st.notches).toHaveLength(3);
    for (const p of st.notches) expect(under(p, pane)).toBe(true);
  });

  it("where the app's answer ends on an empty container (Chromium), each notch reads the window instead", async () => {
    const { st, call } = app(rows(20), { atPoint: true, emptyChain: true });
    await call("perceive_window", {});
    const r = await call("scroll", { id: 2, direction: "down", steps: 25 });
    expect(r.textResultForLlm).toMatch(/^Scrolled 20 of 25 steps, then stopped: "slider" \("slider"\) came under the wheel/);
    expect(st.notches).toHaveLength(20);
    expect(st.reads).toBe(22);
    // A read that leaves part of the window out can't stand in for it.
    const cut = app(rows(20), { atPoint: true, emptyChain: true, read: n => (n > 2 ? { truncated: "nodes" } : {}) });
    await cut.call("perceive_window", {});
    expect((await cut.call("scroll", { id: 2, direction: "down", steps: 5 })).textResultForLlm)
      .toMatch(/^Scrolled 1 of 5 steps, then stopped: Ember couldn't see what would come under the wheel next \(the window has more in it than Ember reads at once\)/);
  });

  it("a row scrolled almost out of its list isn't clicked at its middle, which lies on the button below the list", async () => {
    // GTK: a list (y 40 to 300) scrolled until "Keep file 7" shows 6 px; "Delete all files" lies below the list.
    const del: Item = { role: "push button", name: "Delete all files", bounds: { x: 1, y: 300, width: 300, height: 40 } };
    const keep = (y: number): Item => ({ role: "check box", name: "Keep file 7", bounds: { x: 1, y, width: 300, height: 30 } });
    const clip = { x: 0, y: 40, width: 400, height: 260 };
    const sliver = app([del, keep(294)], { atPoint: true, clip });
    await sliver.call("perceive_window", {});
    expect((await sliver.call("click", { id: 3 })).textResultForLlm).toMatch(/^Element 3 is scrolled almost all the way out of view \(only a sliver of it shows\), so nothing was done/);
    expect(sliver.st.clicks).toEqual([]);
    // 12 px show: it is clicked there.
    const some = app([del, keep(288)], { atPoint: true, clip });
    await some.call("perceive_window", {});
    expect((await some.call("click", { id: 3 })).textResultForLlm).toMatch(/^Done/);
    expect(some.st.clicks).toEqual([{ x: 121, y: 294 }]);
  });

  it("nothing is clicked where the app says something else shows at the spot", async () => {
    const del: Item = { role: "push button", name: "Delete all files", bounds: { x: 1, y: 70, width: 300, height: 40 } };
    const keep: Item = { role: "check box", name: "Keep file 1", bounds: { x: 1, y: 60, width: 300, height: 30 } };
    const { st, call } = app([del, keep], { atPoint: true });
    await call("perceive_window", {});
    expect((await call("click", { id: 3 })).textResultForLlm).toMatch(/^Something else shows where element 3 should be \("Delete all files" \("push button"\)\)/);
    expect(st.clicks).toEqual([]);
    // What the app's answer can say about the element aimed at.
    const row = { x: 0, y: 100, width: 300, height: 30 };
    const pane = { role: "scroll pane", name: "", bounds: { x: 0, y: 40, width: 400, height: 260 } };
    expect(aimedAt([pane, { role: "check box", name: "", bounds: row }], "check box", row)).toBe("yes");
    expect(aimedAt([pane, { role: "static", name: "Keep", bounds: { x: 20, y: 104, width: 60, height: 20 } }], "link", row)).toBe("yes");
    expect(aimedAt([pane], "check box", row)).toBe("unknown");
    expect(aimedAt([{ ...pane, empty: true }], "check box", row)).toBe("unknown");
    expect(aimedAt([pane, { role: "push button", name: "Delete", bounds: { x: 0, y: 120, width: 300, height: 40 } }], "check box", row)).toBe("other");
  });

  it("a control lying over the element, or another control inside it, is something else; what holds it isn't (HND7-2, SEC7-6)", () => {
    const text = { x: 10, y: 96, width: 54, height: 17 };
    const page = { role: "panel", name: "", bounds: { x: 0, y: 0, width: 520, height: 600 } };
    // A fixed header's button drawn over a row's text (Chromium answers with the deepest element there).
    expect(aimedAt([page, { role: "push button", name: "Delete everything", bounds: { x: 10, y: 72, width: 300, height: 36 } }], "static", text)).toBe("other");
    // A header box of the page over it, too; but the link round it in the read (it is the link's text), or a pane, isn't.
    expect(aimedAt([page, { role: "section", name: "", bounds: { x: 0, y: 60, width: 520, height: 60 } }], "static", text)).toBe("other");
    const link = { role: "link", name: "Delete my account", bounds: { x: 10, y: 96, width: 140, height: 17 } };
    expect(aimedAt([page, link], "static", text, [{ ...link, bounds: { ...link.bounds } }])).toBe("unknown");
    expect(aimedAt([page, { role: "scroll pane", name: "", bounds: { x: 0, y: 60, width: 520, height: 500 } }], "static", text)).toBe("unknown");
    // A row's own "Remove" button where Ember would click the row: something else; its label: the row.
    const row = { x: 0, y: 100, width: 360, height: 38 };
    expect(aimedAt([page, { role: "list item", name: "", bounds: row }, { role: "push button", name: "Remove", bounds: { x: 100, y: 102, width: 85, height: 34 } }], "list item", row)).toBe("other");
    expect(aimedAt([page, { role: "list item", name: "", bounds: row }, { role: "label", name: "Bob", bounds: { x: 2, y: 102, width: 100, height: 34 } }], "list item", row)).toBe("yes");
  });

  it("what the app's answer goes on to beside the spot doesn't count: a GTK notebook's selected tab (HND8-6)", () => {
    // GTK's hit test on the selected tab goes on into the page the tab holds, which lies below the tab.
    const tab = { role: "page tab", name: "Controls", bounds: { x: 66, y: 95, width: 53, height: 30 } };
    const chain = [{ role: "page tab list", name: "", bounds: { x: 45, y: 91, width: 560, height: 723 } }, tab,
      { role: "panel", name: "", bounds: { x: 54, y: 137, width: 542, height: 668 } }];
    expect(aimedAt(chain, "page tab", tab.bounds)).toBe("other");
    expect(aimedAt(chain, "page tab", tab.bounds, [], { x: 93, y: 110 })).toBe("yes");
    expect(atSpot(chain, { x: 93, y: 110 })).toEqual(chain.slice(0, 2));
    // What lies at the spot stays (a button over a row), and so does what has no position.
    const row = { x: 0, y: 100, width: 300, height: 30 };
    const over = [{ role: "scroll pane", name: "", bounds: FRAME }, { role: "push button", name: "Undo", bounds: { x: 100, y: 95, width: 68, height: 34 } }];
    expect(aimedAt(over, "list item", row, [], { x: 120, y: 115 })).toBe("other");
    expect(atSpot([...over, { role: "label", name: "", bounds: null }], { x: 120, y: 115 })).toHaveLength(3);
  });

  it("once a spot was seen covered, one the app can't tell about doesn't let the click go ahead (HND8-3)", async () => {
    // An in-app notification's "Undo" over "Row 1"; asked at the next spot, the app is busy, or answers only with the
    // notification's box round the row's label.
    const label: Item = { role: "label", name: "Row 1", bounds: { x: 3, y: 127, width: 356, height: 17 } };
    for (const later of [null, [{ role: "scroll pane", name: "", bounds: FRAME }, { role: "filler", name: "", bounds: { x: 1, y: 120, width: 360, height: 54 } }]]) {
      const { w, st, call } = app([label], { atPoint: true });
      const answers: (PointElement[] | null)[] = [[{ role: "scroll pane", name: "", bounds: FRAME }, { role: "push button", name: "Undo", bounds: { x: 102, y: 120, width: 68, height: 34 } }], later, later];
      (w as unknown as { perception: { atPoint: () => Promise<PointElement[] | null> } }).perception.atPoint = async () => answers.shift() ?? null;
      await call("perceive_window", {});
      expect((await call("click", { id: 2 })).textResultForLlm).toMatch(/^Something else shows where element 2 should be \("Undo" \("push button"\)\)/);
      expect([st.asked, st.clicks]).toEqual([0, []]);
    }
    // No answer at the first spot (nothing seen covered): the mouse goes ahead, as before.
    const { w, st, call } = app([label], { atPoint: true });
    (w as unknown as { perception: { atPoint: () => Promise<PointElement[] | null> } }).perception.atPoint = async () => null;
    await call("perceive_window", {});
    expect((await call("click", { id: 2 })).resultType).toBe("success");
    expect(st.clicks).toHaveLength(1);
  });

  it("a row is clicked beside its own button, and what refuses a click refuses it before the user is asked (SEC7-6, W7-3)", async () => {
    const remove: Item = { role: "push button", name: "Remove", bounds: { x: 100, y: 62, width: 60, height: 26 } };
    const rowItem: Item = { role: "list item", name: "Ann", bounds: { x: 1, y: 60, width: 300, height: 30 } };
    const { st, call } = app([remove, rowItem], { atPoint: true });
    await call("perceive_window", {});
    expect((await call("click", { id: 3 })).textResultForLlm).toMatch(/^Done.*The click landed on list item "Ann"\.$/);
    expect(st.clicks).toEqual([{ x: 13, y: 75 }]);
    // Only a sliver of it shows: refused, and nobody was asked.
    const clip = { x: 0, y: 40, width: 800, height: 260 };
    const sliver = app([{ role: "check box", name: "Keep", bounds: { x: 1, y: 294, width: 300, height: 30 } }], { atPoint: true, clip });
    await sliver.call("perceive_window", {});
    expect((await sliver.call("click", { id: 2 })).textResultForLlm).toMatch(/^Element 2 is scrolled almost all the way out of view/);
    expect([sliver.st.asked, sliver.st.clicks]).toEqual([0, []]);
    expect((await sliver.call("scroll", { id: 2, direction: "down", steps: 3 })).textResultForLlm).toMatch(/^Element 2 is scrolled almost all the way out of view/);
    expect([sliver.st.asked, sliver.st.notches]).toEqual([0, []]);
  });

  it("the words on a button inside a row are the button's: the row is clicked beside it (H9-6)", async () => {
    // Chromium answers with the deepest element: at the row's middle, the text of its own "Remove Alice" button.
    const page: PointElement = { role: "document web", name: "", bounds: FRAME };
    const row = { x: 0, y: 100, width: 420, height: 41 };
    const wrap: PointElement = { role: "panel", name: "", bounds: { x: 0, y: 100, width: 420, height: 40 } };
    const button: PointElement = { role: "push button", name: "Remove Alice", bounds: { x: 102, y: 108, width: 110, height: 24 } };
    const words: PointElement = { role: "static", name: "Remove Alice", bounds: { x: 110, y: 112, width: 90, height: 16 } };
    const name: PointElement = { role: "static", name: "Alice", bounds: { x: 8, y: 112, width: 70, height: 16 } };
    const item: PointElement = { role: "list item", name: "", bounds: row };
    expect(aimedAt([page, item, wrap, button, words], "list item", row)).toBe("other");
    expect(takerInside([page, item, wrap, button, words], "list item", row)).toBe(button);
    // Without the row in the answer, the button round the words is found all the same.
    expect(aimedAt([page, wrap, button, words], "list item", row)).toBe("other");
    // The row's own words, and a button's words aimed at that button, are what is aimed at.
    expect(aimedAt([page, item, wrap, name], "list item", row)).toBe("yes");
    expect(takerInside([page, item, wrap, name], "list item", row)).toBeUndefined();
    expect(aimedAt([page, item, wrap, button, words], "push button", button.bounds!)).toBe("yes");
    // Chromium's own answer: from the window straight to the words (what lies between is left out). The read found the
    // button inside the row: it is round the words, so a click there presses it. The row's own name isn't in it.
    expect(aimedAt([page, words], "list item", row)).toBe("yes");
    expect(aimedAt([page, words], "list item", row, [], undefined, [button])).toBe("other");
    expect(takerInside([page, words], "list item", row, [button])).toBe(button);
    expect(aimedAt([page, name], "list item", row, [], undefined, [button])).toBe("yes");
    // The click goes in at the row's left part (its name), never on the button's words.
    const known = (b: Bounds): AxNode[] => [{ id: 50, parent: 2, depth: 3, role: "push button", name: "Remove Alice", states: ["enabled", "sensitive"], bounds: b }];
    const chromium = async (_t: unknown, p: { x: number }) => (p.x >= 102 && p.x < 212 ? [page, words] : [page, name]);
    const { w, st, call } = app([{ role: "list item", name: "Alice", bounds: row }], { atPoint: true, extra: known(button.bounds!) });
    (w as unknown as { perception: { atPoint: typeof chromium } }).perception.atPoint = chromium;
    await call("perceive_window", {});
    expect((await call("click", { id: 2 })).textResultForLlm).toMatch(/^Done.*The click landed on static "Alice"\.$/);
    expect(st.clicks).toEqual([{ x: 12, y: 120.5 }]);
    // A button as wide as the row inside it, its words wherever Ember could click: refused, naming the button, unasked.
    const wide = app([{ role: "list item", name: "Alice", bounds: row }], { atPoint: true, extra: known({ x: 2, y: 104, width: 416, height: 32 }) });
    (wide.w as unknown as { perception: { atPoint: (t: unknown, p: { x: number }) => Promise<PointElement[]> } }).perception.atPoint =
      async (_t, p) => [page, { ...words, bounds: { x: p.x - 4, y: 112, width: 8, height: 16 } }];
    await wide.call("perceive_window", {});
    expect((await wide.call("click", { id: 2 })).textResultForLlm).toMatch(/^Another control inside element 2 is where the mouse would click \("Remove Alice" \("push button"\)\)/);
    expect([wide.st.asked, wide.st.clicks]).toEqual([0, []]);
  });

  it("a scroll bar is a place for the wheel: it stays put while what it scrolls moves (W7-3)", async () => {
    const { st, call } = app(rows(39), { atPoint: true, extra: [] });
    await call("perceive_window", {});
    expect((await call("scroll", { id: 99, direction: "down", steps: 4 })).textResultForLlm).toMatch(/^Done/);
    expect(st.notches).toHaveLength(4);
    expect(st.asked).toBe(1);
  });

  it("a screenshot mark goes round the part of an element that shows, and none on a sliver", () => {
    const origin = { x: 0, y: 0, width: 800, height: 600 };
    const box = (shown?: Bounds): AxNode => ({ id: 7, parent: 1, depth: 2, role: "check box", name: "Keep", states: [], bounds: { x: 1, y: 288, width: 300, height: 30 }, ...(shown ? { shown } : {}) });
    expect(marksSvg([box()], origin, 1, 800, 600)).toContain('<rect x="1.0" y="288.0" width="300.0" height="30.0"');
    expect(marksSvg([box({ x: 1, y: 288, width: 300, height: 12 })], origin, 1, 800, 600)).toContain('<rect x="1.0" y="288.0" width="300.0" height="12.0"');
    expect(marksSvg([box({ x: 1, y: 294, width: 300, height: 6 })], origin, 1, 800, 600)).not.toContain("<rect");
  });
});

describe("clearing a field with the user's mouse (review round 5)", () => {
  it("empties it with Ctrl+A and Delete, and never touches the user's clipboard", async () => {
    // A Chromium text field: no text by accessibility, so Ember's hands do it.
    const field: Item = { role: "text", name: "Search", text: "old words", bounds: { x: 10, y: 60, width: 300, height: 30 }, states: ["enabled", "sensitive", "editable", "focusable", "focused"] };
    const { st, call, clip } = app([field]);
    await call("perceive_window", {});
    const r = await call("type_text", { id: 2, text: "", mode: "replace" });
    expect(r.textResultForLlm).toMatch(/^Done/);
    expect(st.keys).toEqual(["ctrl+a", "Delete"]);
    expect(field.text).toBe("");
    expect(clip).toEqual({ saved: 0, written: [], restored: 0 });
  });
});

describe("a long list of rows (review round 9)", () => {
  it("a row the list couldn't be looked through for in time is to be typed instead; a choice not checked all through says so (H9-2)", async () => {
    // A file dialog's list of 800 files: the helper names the first rows in time and says how many it left out.
    const files: Item = { role: "table", name: "Files", bounds: { x: 10, y: 60, width: 600, height: 400 } };
    const { w, call } = app([files]);
    const chosen: string[] = [];
    Object.assign((w as unknown as { d: { sidecar: object } }).d.sidecar, {
      listOptions: async () => ({ options: ["file_001.txt", "file_002.txt"], left: 798 }),
      selectOption: async (_id: number, option: string) => {
        chosen.push(option);
        return { ok: true, option, after: { role: "table", name: "Files", states: [], bounds: files.bounds, selected: option }, unchecked: 798 };
      },
    });
    await call("perceive_window", {});
    expect((await call("choose_option", { id: 2, option: "file_700.txt" })).textResultForLlm).toBe(
      'None of the first 2 rows is called exactly "file_700.txt", and the list is too long for Ember to look through the other 798 in time. Type the name instead: in a file dialog press Ctrl+L (or use its name field) and type the file\'s name.');
    expect(chosen).toEqual([]);
    const r = await call("choose_option", { id: 2, option: "file_002.txt" });
    expect(r.resultType).toBe("success");
    expect(r.textResultForLlm).toMatch(/^Done\. Now: table "Files" selected="file_002\.txt" \(The list is long: its last 798 rows weren't checked for another of that name in time\.\)$/);
    expect(chosen).toEqual(["file_002.txt"]);
  });

  it("a cell read back after Enter took what was typed: the same, Calc's own way of showing it, or a formula's new result (H9-3)", () => {
    expect(cellTook("999", "1200", "999")).toBe(true);
    expect(cellTook("3.10", "", "3.1")).toBe(true); // Calc shows a number its own way
    expect(cellTook("=A1*2", "1200", "2400")).toBe(true); // a formula: something new
    expect(cellTook("", "x", "")).toBe(true); // cleared
    expect(cellTook("1200.0", "1200", "1200")).toBe(true); // the same number
    expect(cellTook("1200", "1200", "1200")).toBe(true); // what it held already
    // Still what it held: a read-only document, a protected cell (or a formula working out to the same).
    expect(cellTook("999", "1200", "1200")).toBe(false);
    expect(cellTook("=A1*2", "1200", "1200")).toBe(false);
    expect(cellTook("", "x", "x")).toBe(false);
    expect(cellTook("Phone", "", "")).toBe(false);
  });
});

describe("a cell that shows what it held, and GTK's lists and icons (review round 10)", () => {
  it("fill_cells takes at most 8 cells in one question, each of them shown in it (UI10-4)", async () => {
    const { call, st } = app([]);
    const cells = Array.from({ length: 9 }, (_, i) => ({ cell: `A${i + 2}`, text: String(i) }));
    const r = await call("fill_cells", { cells });
    expect(r.resultType).toBe("failure");
    expect(r.textResultForLlm).toMatch(/^Invalid arguments for fill_cells: cells: .*8/);
    expect(st.asked).toBe(0);
  });

  it("the same value however the sheet shows it, or the formula typed, is taken (HND10-2, W10-3)", () => {
    // Money, thousands, a percentage, a date: Calc shows each its own way, and tells the cell's number.
    expect(sheetNumbers("$1,200.00")).toEqual([1200]);
    expect(sheetNumbers("5%")).toEqual([0.05]);
    expect(sheetNumbers("2026-03-05")).toEqual([46086]);
    expect(sheetNumbers("3/5/2026")).toEqual([46086, 46145]);
    expect(sheetNumbers("Rent")).toEqual([]);
    expect(cellTook("$1,200.00", "1200", "1200", { value: 1200 })).toBe(true);
    expect(cellTook("0.05", "5%", "5%", { value: 0.05 })).toBe(true);
    expect(cellTook("3/5/2026", "2026-03-05", "2026-03-05", { value: 46086 })).toBe(true);
    expect(sameCellValue("1200", "$1,200.00")).toBe(true);
    // A text's number is 0: a 0 typed over it isn't the same.
    expect(sameCellValue("0", "Item", 0)).toBe(false);
    expect(sameCellValue("7", "Mar 5, 2026", 46086)).toBe(false);
    expect(sameCellValue("46086", "Mar 5, 2026", 46086)).toBe(true);
    // A formula whose result is what was there, or an error (Calc shows #DIV/0! as no text): its formula says it went in.
    expect(cellTook("=1+2.1", "3.10", "3.10", { value: 3.1, formula: "1+2.1" })).toBe(true);
    expect(cellTook("=1/0", "", "", { value: 0, formula: "1/0" })).toBe(true);
    expect(cellTook("=sum(b2:b3)", "1550.5", "1550.5", { formula: "SUM(B2\\" })).toBe(true);
    expect(formulaIn("=SUM(C2:C3)", "SUM(B2\\")).toBe(false);
    expect(formulaIn("=A1*2", "")).toBe(false);
    expect(formulaIn("5", "5")).toBe(false);
    // Neither: still not taken (a read-only document).
    expect(cellTook("999", "1200", "1200", { value: 1200, formula: "" })).toBe(false);
    expect(cellTook("=A1*2", "1200", "1200", { value: 1200, formula: "" })).toBe(false);
  });

  /** A GTK list's check box at (10, 60), its row's name beside it, and a check box of its own (Chromium's "Urgent"). */
  const listApp = (canDo: (id: number, kind: string) => object, o: { flips?: boolean; doAction?: (id: number) => object } = {}) => {
    const box: Item = { role: "table cell", name: "", bounds: { x: 10, y: 60, width: 60, height: 20 }, states: ["enabled", "sensitive", "focusable"] };
    const row: Item = { role: "table cell", name: "http", bounds: { x: 70, y: 60, width: 300, height: 20 }, states: ["enabled", "sensitive", "focusable"] };
    const urgent: Item = { role: "check box", name: "Urgent", bounds: { x: 10, y: 100, width: 100, height: 20 }, states: ["enabled", "sensitive"] };
    const made = app([box, row, urgent]);
    const done: string[] = [];
    Object.assign((made.w as unknown as { d: { sidecar: object } }).d.sidecar, {
      canDo: async (id: number, kind: string) => canDo(id, kind),
      doAction: async (id: number, a: string) => { done.push(`${id} ${a}`); return o.doAction?.(id) ?? { ok: true, after: null }; },
    });
    // The mouse's click ticks the box (or doesn't: an app that ignores it).
    made.st.clicks = Object.assign([] as { x: number; y: number }[], { push: () => { if (o.flips !== false) box.states!.push("checked"); return 0; } });
    return { ...made, box, row, urgent, done };
  };
  const BOX = { tier1: false, action: "toggle", why: "a check box in a list is ticked only by a click on it (its accessible action would open its row instead)" };

  it("a list's check box is ticked with the mouse, asked first, and is done only once it shows ticked (HND10-1)", async () => {
    const { call, st, box, done } = listApp(id => (id === 2 ? BOX : { tier1: true, action: "select row" }));
    await call("perceive_window", {});
    const r = await call("click", { id: 2 });
    expect(r.textResultForLlm).toMatch(/^Done with the user's mouse, which is back where it was\. Now: table cell "" \(.*checked\)$/);
    expect([st.asked, box.states!.includes("checked"), done]).toEqual([1, true, []]);
    // The toggle tool: the same, and already on is left alone.
    expect((await call("toggle", { id: 2, on: true })).textResultForLlm).toMatch(/^Already on/);
  });

  it("a list's check box the click didn't tick isn't reported done (HND10-1)", async () => {
    const { call, box } = listApp(() => BOX, { flips: false });
    await call("perceive_window", {});
    const r = await call("toggle", { id: 2, on: true });
    expect(r.resultType).toBe("failure");
    expect(r.textResultForLlm).toMatch(/^Ember clicked it with the user's mouse \(which is back where it was\), but it didn't turn on: it is still off \(table cell ""/);
    expect(box.states).not.toContain("checked");
  });

  it("a toggle on a list's row or an icon is refused before anything is asked; a click selects it and says it wasn't opened (HND10-1, HND10-5)", async () => {
    const after = (name: string) => ({ ok: true, action: "select row", after: { role: "table cell", name, states: ["selected", "focused"], bounds: { x: 70, y: 60, width: 300, height: 20 } } });
    const { call, st, done } = listApp(id => (id === 3 ? { tier1: true, action: "select row" } : { tier1: true, action: "select item" }), { doAction: id => after(id === 3 ? "http" : "") });
    await call("perceive_window", {});
    const r = await call("toggle", { id: 3, on: true });
    expect(r.resultType).toBe("failure");
    expect(r.textResultForLlm).toMatch(/^Element 3 is a cell of a list's row, not a switch or check box: a click on it only selects it/);
    expect((await call("toggle", { id: 4, on: true })).textResultForLlm).toMatch(/^Element 4 is an icon, not a switch or check box/);
    expect([st.asked, done]).toEqual([0, []]);
    const c = await call("click", { id: 3 });
    expect(c.textResultForLlm).toBe("Selected its row, as a single click does; it wasn't opened: press Enter (press_keys) to open it if that's what the task needs. Now: table cell \"http\" (selected, focused)");
    expect(done).toEqual(["3 click"]);
  });

  it("a toggle the app says it did is done only once it shows turned (HND10-1)", async () => {
    let flips = false;
    const { call, urgent } = listApp(() => ({ tier1: true, action: "check" }), {
      doAction: () => { if (flips) urgent.states!.push("checked"); return { ok: true, action: "check", after: { role: "check box", name: "Urgent", states: [...urgent.states!], bounds: urgent.bounds } }; },
    });
    await call("perceive_window", {});
    const r = await call("toggle", { id: 4, on: true });
    expect(r.resultType).toBe("failure");
    expect(r.textResultForLlm).toMatch(/^The app said it did it, but it didn't turn on: it is still off \(check box "Urgent"/);
    flips = true;
    expect((await call("toggle", { id: 4, on: true })).textResultForLlm).toMatch(/^Done\. Now: check box "Urgent" \(.*checked/);
  });
});

describe("a busy spreadsheet (review round 11)", () => {
  type Looks = { cellWithKeyboard(want?: string, near?: string[]): Promise<{ name: string } | null> };
  const cell = (name: string): AxNode => ({ id: 50, parent: 1, depth: 3, role: "table cell", name, text: "", states: ["enabled", "focused", "selected"], bounds: { x: 100, y: 100, width: 60, height: 20 } });

  it("looks again for the cell with the keyboard when a read was cut short before it found one (PR11-1)", async () => {
    // The first two looks are cut short (a busy Calc) and find no cell; the third finds B3.
    const { w, st } = app([], { read: (n, nodes) => (n <= 2 ? { truncated: "nodes" } : { nodes: [...nodes, cell("B3")] }) });
    expect((await (w as unknown as Looks).cellWithKeyboard(undefined, ["B3"]))?.name).toBe("B3");
    expect(st.reads).toBe(3);
    // Never found: it gives up after a few looks, and says why (cellLookCut).
    const busy = app([], { read: () => ({ truncated: "nodes" }) });
    expect(await (busy.w as unknown as Looks).cellWithKeyboard()).toBeNull();
    expect(busy.st.reads).toBe(5);
    // Not cut short, and the keyboard on something else (the Name Box): the answer at once.
    const none = app([], { extra: [{ id: 60, parent: 1, depth: 2, role: "text", name: "Name Box", states: ["enabled", "focused"], bounds: { x: 0, y: 40, width: 80, height: 20 } }] });
    expect(await (none.w as unknown as Looks).cellWithKeyboard()).toBeNull();
    expect(none.st.reads).toBe(1);
  });
});

describe("a formula's result read back, and a click that ends Ctrl+A (review round 11)", () => {
  /**
   * Calc with B8 (holding `held`, else empty, with the keyboard) and C3. What is typed into B8 is told at once (a
   * formula's Formula attribute, and its number `value`: 0 for an error), and `result` shows from the `showsAt`th read of
   * the cell on (never, without it): no text until then. The mouse's click on C3 gives C3 the keyboard.
   */
  const calc = (o: { held?: string; result?: string; value?: number; showsAt?: number } = {}) => {
    const states = ["enabled", "sensitive", "editable", "focusable"];
    const b8: Item = { role: "table cell", name: "B8", text: o.held ?? "", bounds: { x: 100, y: 200, width: 80, height: 20 }, states: [...states, "focused"] };
    const c3: Item = { role: "table cell", name: "C3", text: "x", bounds: { x: 180, y: 100, width: 80, height: 20 }, states: [...states] };
    const made = app([b8, c3]);
    const prompts: string[] = [];
    let reads = 0;
    const d = (made.w as unknown as { d: { sidecar: { readElement: (id: number, o?: object) => Promise<object> }; confirmer: object } }).d;
    const plain = d.sidecar.readElement;
    Object.assign(d.sidecar, {
      readElement: async (id: number, opt?: { formula?: boolean }) => {
        const typed = made.st.typed.join("");
        if (id !== 2 || !typed) return plain(id, opt);
        reads++;
        const shown = o.showsAt !== undefined && reads >= o.showsAt;
        return { role: "table cell", name: "B8", states: b8.states, bounds: b8.bounds, text: shown ? o.result : "", value: o.value, ...(opt?.formula ? { formula: typed.startsWith("=") ? typed.slice(1) : "" } : {}) };
      },
      canDo: async () => ({ tier1: false, why: "it has no action of its own" }),
    });
    d.confirmer = { ask: async (q: { prompt: string }) => { prompts.push(q.prompt); return "once"; } };
    made.st.clicks = Object.assign([] as { x: number; y: number }[], { push: () => { b8.states = [...states]; c3.states = [...states, "focused"]; return 0; } });
    return { ...made, prompts, reads: () => reads };
  };
  const total = { cell: "B8", text: "=SUM(B2:B7)", mode: "replace" };

  it("a formula's result Calc shows a moment after it tells the formula is read back, not called an error (W11-1)", async () => {
    const { call, reads } = calc({ result: "1655", value: 1655, showsAt: 3 });
    await call("perceive_window", {});
    expect((await call("type_text", total)).textResultForLlm).toBe('Done: typed "=SUM(B2:B7)" into B8 and pressed Enter (the cell cursor moved on). It shows "1655".');
    expect(reads()).toBe(3);
  });

  it("a result Calc doesn't show in time is told by the number the app tells (W11-1)", async () => {
    const { call } = calc({ result: "1655", value: 1655 });
    await call("perceive_window", {});
    expect((await call("type_text", total)).textResultForLlm).toBe('Done: typed "=SUM(B2:B7)" into B8 and pressed Enter (the cell cursor moved on). It works out to 1655, as the app tells it (the cell showed no text for it yet).');
  });

  it("a formula that works out to an error (no text, and 0) still says so, once Calc had its time (W11-1)", async () => {
    const { call, reads } = calc({ result: "", value: 0 });
    await call("perceive_window", {});
    expect((await call("type_text", { cell: "B8", text: "=1/0", mode: "replace" })).textResultForLlm).toBe(
      'Done: typed "=1/0" into B8 and pressed Enter (the cell cursor moved on). It shows nothing: its formula went in, and works out to an error (such as #DIV/0! or #N/A) or to nothing.');
    expect(reads()).toBe(4);
  });

  it("a cell that shows no text yet after Enter is read again, not called empty (HND11-3)", async () => {
    const { call, reads } = calc({ held: "5%", result: "7%", value: 0.07, showsAt: 2 });
    await call("perceive_window", {});
    expect((await call("type_text", { cell: "B8", text: "7%", mode: "replace" })).textResultForLlm).toBe('Done: typed "7%" into B8 and pressed Enter (the cell cursor moved on). It holds "7%".');
    expect(reads()).toBe(2);
  });

  it("a cell is done changing once it shows text where text was typed, and a formula's once it shows something new (W11-1, HND11-3)", () => {
    expect(cellSettled("=SUM(B2:B7)", "", { text: "", value: 1655, formula: "SUM(B2\\" })).toBe(false);
    expect(cellSettled("=SUM(B2:B7)", "", { text: "1655", value: 1655, formula: "SUM(B2\\" })).toBe(true);
    expect(cellSettled("=B5-15", "30", { text: "30", value: 30, formula: "B5-15" })).toBe(false);
    expect(cellSettled("=1/0", "45", { text: "", value: 0, formula: "1/0" })).toBe(false);
    expect(cellSettled("30", "30", { text: "30", value: 30, formula: "" })).toBe(true);
    expect(cellSettled("Total", "", { text: "", value: 0, formula: "" })).toBe(false);
    expect(cellSettled("7%", "5%", { text: "", value: 0, formula: "" })).toBe(false);
    expect(cellSettled("7%", "5%", { text: "7%", value: 0.07, formula: "" })).toBe(true);
    expect(cellSettled("", "x", { text: "", value: 0, formula: "" })).toBe(true);
  });

  it("the mouse's click on a cell ends what Ctrl+A selected: Delete there isn't asked about as taking everything (W11-3)", async () => {
    const { call, prompts } = calc();
    await call("perceive_window", {});
    await call("press_keys", { keys: "ctrl+a" });
    expect((await call("click", { id: 3 })).textResultForLlm).toMatch(/^Done with the user's mouse/);
    await call("perceive_window", {});
    const asked = prompts.length;
    await call("press_keys", { keys: "Delete" });
    expect(prompts.slice(asked).join(" ")).not.toMatch(/everything there is selected/i);
  });

  it("a list's row chosen by accessibility is all that is selected after Ctrl+A (W11-3)", async () => {
    const states = ["enabled", "sensitive", "focusable"];
    const a: Item = { role: "table cell", name: "a.txt", bounds: { x: 10, y: 60, width: 300, height: 20 }, states: [...states, "focused"] };
    const b: Item = { role: "table cell", name: "b.txt", bounds: { x: 10, y: 80, width: 300, height: 20 }, states: [...states] };
    const { w, call } = app([a, b]);
    const prompts: string[] = [];
    const d = (w as unknown as { d: { sidecar: object; confirmer: object } }).d;
    Object.assign(d.sidecar, {
      canDo: async () => ({ tier1: true, action: "select row" }),
      doAction: async () => {
        a.states = [...states];
        b.states = [...states, "selected", "focused"];
        return { ok: true, action: "select row", after: { role: b.role, name: b.name, states: b.states, bounds: b.bounds } };
      },
    });
    d.confirmer = { ask: async (q: { prompt: string }) => { prompts.push(q.prompt); return "once"; } };
    await call("perceive_window", {});
    await call("press_keys", { keys: "ctrl+a" });
    expect((await call("click", { id: 3 })).textResultForLlm).toMatch(/^Selected its row/);
    await call("perceive_window", {});
    const asked = prompts.length;
    await call("press_keys", { keys: "Delete" });
    expect(prompts.slice(asked).join(" ")).not.toMatch(/everything there is selected/i);
  });
});
