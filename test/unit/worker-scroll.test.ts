/**
 * Scrolling with the user's wheel (tier 3), with a pretend app: the wheel never lands on a control it would change,
 * also where a read can't see (GTK 3 hides a page scrolled past its first screen from reads), inside a notebook,
 * and without reading the whole window for every notch. And clearing a field leaves the user's clipboard alone.
 */

import { describe, expect, it } from "vitest";
import { Worker, aimedAt, atSpot, seesInside, tabPage, wheelControls, wheelTarget, type WorkerDeps } from "../../app/main/agent/worker";
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
