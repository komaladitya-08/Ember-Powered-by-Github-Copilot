/**
 * Scrolling with the user's wheel (tier 3), with a pretend app: the wheel never lands on a control it would change,
 * also where a read can't see (GTK 3 hides a page scrolled past its first screen from reads), inside a notebook,
 * and without reading the whole window for every notch. And clearing a field leaves the user's clipboard alone.
 */

import { describe, expect, it } from "vitest";
import { Worker, seesInside, wheelControls, wheelTarget, type WorkerDeps } from "../../app/main/agent/worker";
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
function app(items: Item[], o: { notch?: number; blindAfter?: number; atPoint?: boolean; read?: (n: number, nodes: AxNode[]) => object; extra?: AxNode[] } = {}) {
  const st = { offset: 0, reads: 0, points: 0, notches: [] as { x: number; y: number }[], keys: [] as string[], typed: [] as string[], pointer: { x: 0, y: 0 } };
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
        const hit = shown().find(n => under(p, n.bounds));
        return [{ role: "scroll pane", name: "", bounds: { x: 0, y: 40, width: 800, height: 560 } }, ...(hit ? [{ role: hit.role, name: hit.name, bounds: hit.bounds }] : [])];
      },
    } : {}),
  };
  const sidecar = {
    readElement: async (id: number) => {
      const n = id === 1 ? frame : nodes().find(x => x.id === id) ?? shown().find(x => x.id === id) ?? { ...items[id - 2], states: items[id - 2].states ?? [], bounds: null };
      return { role: n.role, name: n.name, states: n.states, bounds: n.bounds, ...(n.text !== undefined ? { text: n.text } : {}) };
    },
    setText: async () => { throw new Error("background_unavailable: this app takes no text this way"); },
  };
  const hand: Hand = {
    glideTo: async (x: number, y: number) => { st.pointer = { x, y }; },
    click: async () => undefined,
    keys: async (k: string) => { st.keys.push(k); if (k === "Delete") for (const it of items) if (it.text !== undefined) it.text = ""; },
    type: async (t: string) => { st.typed.push(t); },
    scroll: async (_d: string, n: number) => { for (let i = 0; i < n; i++) { st.notches.push(st.pointer); st.offset += notch; } },
  } as unknown as Hand;
  const clip = { saved: 0, written: [] as string[], restored: 0 };
  const w = new Worker({
    client: {} as never, log: quiet, model: "m", vision: false, workDir: "/tmp",
    perception: perception as never, sidecar: sidecar as never,
    policy: new PolicyEngine({ neverLook: () => [], grants: () => ({ settings: "act" }) }),
    confirmer: { ask: async () => "once" } as never,
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
    expect(st.reads).toBe(1);
    expect(st.points).toBe(21);
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
