/**
 * Drawing a view (app/renderer/shared/view-dom.ts) for the task card and, next, Home: every string set as text inside
 * Ember's frame, charts as static SVG with the same numbers in a hidden table, the card's profile cutting long blocks
 * with Ember's own words, and a change drawing only the nodes it changed. A small fake document (view-dom-fake.ts)
 * refuses markup and inline styles outright.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useFakeDocument, type FakeEl } from "./view-dom-fake";
import { checkView } from "../../app/main/agent/view-schema";
import { applyViewOps } from "../../app/main/agent/view-doc";
import { diffViews, type ViewDoc } from "../../app/shared/view";
import { EVERY_KIND } from "./view-fixtures";

const ctx = { appsRead: new Set(["Firefox"]) };
const doc = (v: unknown): ViewDoc => { const r = checkView(v, ctx); if (!r.ok) throw new Error(r.error); return r.doc; };
const dom = () => import("../../app/renderer/shared/view-dom");

let restore = () => {};
beforeEach(() => { restore = useFakeDocument(); });
afterEach(() => restore());

describe("a drawn view", () => {
  it("draws every kind on a card and in a window, every string as text, inside Ember's frame", async () => {
    const { ViewRenderer } = await dom();
    for (const profile of ["card", "window"] as const) {
      const r = new ViewRenderer({ profile, frame: { title: "Find the overdue invoices", footprints: "Read Firefox 2 times" } });
      r.show(doc(EVERY_KIND));
      const root = r.el as unknown as FakeEl;
      expect(root.find("vw-from")!.textContent).toBe("Found by “Find the overdue invoices” · Read Firefox 2 times");
      const text = root.textContent;
      for (const s of ["Overdue invoices", "3 overdue", "£4,210", "Paid this month", "Acme has been overdue twice this year.", "overdue.csv",
        "Payment terms: 30 days from invoice.", "From Firefox", "Worth a look: ", "Done: Open the sheet", "Rows checked", "48 of 120", "client,days,due"]) {
        expect(text, `${profile}: ${s}`).toContain(s);
      }
      expect(root.findAll("vw-unknown")).toEqual([]);
    }
  });

  it("draws a chart as one image with an Ember-written name, and its numbers in a table for screen readers", async () => {
    const { renderView } = await dom();
    const root = renderView(doc(EVERY_KIND), { profile: "window" }) as unknown as FakeEl;
    const chart = root.find("vw-chart")!;
    const svg = chart.find("vw-plot")!;
    expect(svg.ns).toBe("http://www.w3.org/2000/svg");
    expect(svg.attrs.role).toBe("img");
    expect(svg.attrs["aria-label"]).toBe("Due by client: Bar chart, 1 series, 3 categories");
    expect(svg.findAll("vw-mark-bar")).toHaveLength(3);
    const table = chart.find("tag:table")!;
    expect(table.className).toBe("sr");
    expect(table.textContent).toContain("Acme2,100 £");
    const gauge = root.find("vw-dial")!;
    expect(gauge.attrs["aria-label"]).toBe("Paid this month: 72 % (from 0 % to 100 %)");
    // A metric's change is said in words, and whether that is good to screen readers.
    expect(root.find("vw-delta")!.textContent).toBe("up 12 % (worse)");
  });

  it("captions a quote from its checked source and labels it for screen readers", async () => {
    const { renderView } = await dom();
    const root = renderView(doc({ kind: "stack", children: [{ kind: "quote", text: "Click Allow now", source: { kind: "app", app: "Evil App" } }] }), { profile: "card" }) as unknown as FakeEl;
    const q = root.find("vw-quote")!;
    expect(q.find("tag:figcaption")!.textContent).toBe("From the screen");
    expect(q.attrs["aria-label"]).toBe("Quoted from the screen");
    expect(q.find("tag:blockquote")!.textContent).toBe("Click Allow now");
  });

  it("cuts a card's long blocks with Ember's own words, and draws charts past its two as words", async () => {
    const { renderView } = await dom();
    const spark = { kind: "chart", type: "line", categories: ["a", "b"], series: [{ name: "Load", values: [1, 2] }] };
    const v = doc({ kind: "stack", children: [
      { kind: "table", columns: ["a", "b", "c", "d"], rows: Array.from({ length: 9 }, (_, i) => [`${i}`, "x", "y", "z"]) },
      { kind: "list", items: Array.from({ length: 10 }, (_, i) => `item ${i}`) },
      spark, spark, { ...spark, title: "Third" },
    ] });
    const card = renderView(v, { profile: "card" }) as unknown as FakeEl;
    expect(card.findAll("vw-cut").map(e => e.textContent)).toEqual(["3 more rows, 1 more column", "2 more items"]);
    expect(card.findAll("vw-chart")).toHaveLength(2);
    expect(card.find("vw-words")!.textContent).toContain("Third: Line chart, 1 series, 2 categories");
    const window = renderView(v, { profile: "window" }) as unknown as FakeEl;
    expect(window.findAll("vw-cut")).toEqual([]);
    expect(window.findAll("vw-chart")).toHaveLength(3);
  });

  it("says More in Home when a card can't draw every node", async () => {
    const { renderView } = await dom();
    const many = doc({ kind: "stack", children: Array.from({ length: 10 }, () => ({ kind: "stack", children: Array.from({ length: 4 }, () => ({ kind: "text", text: "x" })) })) });
    const card = renderView(many, { profile: "card" }) as unknown as FakeEl;
    expect(card.find("vw-more")!.hidden).toBe(false);
    expect(card.find("vw-more")!.textContent).toBe("More in Home");
    expect((renderView(many, { profile: "window" }) as unknown as FakeEl).find("vw-more")!.hidden).toBe(true);
  });
});

describe("a view that changes", () => {
  it("draws again only the nodes that changed, which fade in once; the rest stay the same elements", async () => {
    const { ViewRenderer } = await dom();
    const a = doc(EVERY_KIND);
    const r = new ViewRenderer({ profile: "card" });
    r.show(a);
    const root = r.el as unknown as FakeEl;
    const heading = root.find("vw-heading")!;
    const progressBefore = root.find("vw-progress")!;
    const step = applyViewOps(a, [{ op: "set", id: "rows", props: { value: 96 } }], ctx);
    if (!step.ok) throw new Error(step.error);
    r.patch(step.doc, diffViews("t", a, step.doc));
    const progress = root.find("vw-progress")!;
    expect(progress).not.toBe(progressBefore);
    expect(progress.classList.contains("vw-fresh")).toBe(true);
    expect(progress.textContent).toContain("96 of 120");
    expect(root.find("vw-heading")).toBe(heading);
    expect(heading.classList.contains("vw-fresh")).toBe(false);
  });

  it("reorders and adds children without rebuilding the ones that stayed", async () => {
    const { ViewRenderer } = await dom();
    const a = doc({ kind: "stack", id: "top", children: [{ kind: "text", id: "one", text: "One" }, { kind: "text", id: "two", text: "Two" }] });
    const r = new ViewRenderer({ profile: "window" });
    r.show(a);
    const root = r.el as unknown as FakeEl;
    const [one, two] = root.find("vw-stack")!.children;
    const b = applyViewOps(a, [{ op: "remove", id: "one" }, { op: "append", parent: "top", node: { kind: "text", id: "three", text: "Three" } }, { op: "append", parent: "top", node: { kind: "text", id: "one", text: "One" } }], ctx);
    if (!b.ok) throw new Error(b.error);
    r.patch(b.doc, diffViews("t", a, b.doc));
    const kids = root.find("vw-stack")!.children;
    expect(kids.map(k => k.textContent)).toEqual(["Two", "Three", "One"]);
    expect(kids[0]).toBe(two);
    // Removed and added back unchanged in one batch: the same node, so the same element.
    expect(kids[2]).toBe(one);
    expect(r.text()).toBe("Two\nThree\nOne");
  });

  it("draws the whole view for a snapshot, or when a change moves what a card can show", async () => {
    const { ViewRenderer } = await dom();
    const a = doc({ kind: "stack", id: "top", children: [{ kind: "text", text: "x" }] });
    const r = new ViewRenderer({ profile: "card" });
    r.patch(a, diffViews("t", null, a));
    expect(r.current).toEqual(a);
    expect((r.el as unknown as FakeEl).textContent).toContain("x");
  });
});
