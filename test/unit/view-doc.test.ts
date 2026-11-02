/**
 * A task's live view (app/main/agent/view-doc.ts, app/shared/view.ts): update_view's changes are applied to a copy and
 * the whole view is checked again, so one bad change leaves the view as it was; each accepted batch is one rev on.
 * Pages get diffs (only the nodes that changed), at most 4 a second a task, merged, and nothing while Ember is hidden;
 * a page that reloads gets every view whole.
 */

import { describe, expect, it } from "vitest";
import { ViewHub, applyViewOps, type ViewOp } from "../../app/main/agent/view-doc";
import { checkView, type ViewContext } from "../../app/main/agent/view-schema";
import { applyViewPatch, diffViews, viewText, type ViewDoc, type ViewPatch } from "../../app/shared/view";

const ctx: ViewContext = { appsRead: new Set(["Firefox"]) };
const base = (): ViewDoc => {
  const r = checkView({
    kind: "stack", id: "top", children: [
      { kind: "heading", id: "title", text: "Checking invoices", level: 1 },
      { kind: "progress", id: "rows", label: "Rows checked", value: 10, max: 120 },
      { kind: "list", id: "found", items: ["Acme"] },
      { kind: "row", id: "figures", children: [{ kind: "metric", id: "due", label: "Due", value: "£2,100" }] },
    ],
  }, ctx);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
};
const apply = (doc: ViewDoc, ops: ViewOp[]) => applyViewOps(doc, ops, ctx);
const okApply = (doc: ViewDoc, ops: ViewOp[]) => { const r = apply(doc, ops); if (!r.ok) throw new Error(r.error); return r.doc; };

describe("update_view's changes", () => {
  it("sets a node's props, the cheap way to move a progress or a figure, one rev on", () => {
    const doc = base();
    const next = okApply(doc, [{ op: "set", id: "rows", props: { value: 60 } }, { op: "set", id: "due", props: { value: "£3,710" } }]);
    expect(next.rev).toBe(doc.rev + 1);
    expect(viewText(next)).toContain("Rows checked: 60 of 120");
    expect(viewText(next)).toContain("Due: £3,710");
    // The view it came from is untouched.
    expect(viewText(doc)).toContain("Rows checked: 10 of 120");
  });

  it("appends, before a sibling or at the end, and gives an unnamed new node Ember's own id", () => {
    const next = okApply(base(), [
      { op: "append", parent: "figures", node: { kind: "metric", label: "Clients", value: "2" } },
      { op: "append", parent: "top", before: "found", node: { kind: "callout", id: "warn", tone: "caution", text: "One has no reference." } },
    ]);
    const top = next.nodes.top as Extract<ViewDoc["nodes"][string], { kind: "stack" }>;
    expect(top.children).toEqual(["title", "rows", "warn", "found", "figures"]);
    const figures = next.nodes.figures as Extract<ViewDoc["nodes"][string], { kind: "row" }>;
    expect(figures.children[1]).toMatch(/^_\d+$/);
  });

  it("replaces a node with its children, keeping its id, and removes one with its children", () => {
    const next = okApply(base(), [
      { op: "replace", id: "figures", node: { kind: "grid", columns: 2, children: [{ kind: "metric", id: "due", label: "Due", value: "£1" }, { kind: "metric", label: "Paid", value: "£9" }] } },
      { op: "remove", id: "found" },
    ]);
    expect(next.nodes.figures.kind).toBe("grid");
    expect(next.nodes.found).toBeUndefined();
    expect(Object.keys(next.nodes)).toContain("due");
    expect(viewText(next)).not.toContain("Acme");
  });

  it.each<[string, ViewOp[], RegExp]>([
    ["a node that isn't there", [{ op: "set", id: "nope", props: { value: 1 } }], /no node "nope"/],
    ["the root", [{ op: "remove", id: "top" }], /root can't be removed/],
    ["a kind changed by set", [{ op: "set", id: "rows", props: { kind: "text" } }], /never its kind/],
    ["children changed by set", [{ op: "set", id: "top", props: { children: [] } }], /never its children/],
    ["a prop its kind hasn't got", [{ op: "set", id: "rows", props: { colour: "red" } }], /no links, pictures, colours/],
    ["a value past its max", [{ op: "set", id: "rows", props: { value: 500 } }], /more than max/],
    ["a child of a leaf", [{ op: "append", parent: "rows", node: { kind: "text", text: "x" } }], /holds no children/],
    ["an id already used", [{ op: "append", parent: "top", node: { kind: "text", id: "rows", text: "x" } }], /already used/],
    ["a replacement under another id", [{ op: "replace", id: "found", node: { kind: "text", id: "other", text: "x" } }], /keeps the id/],
  ])("refuses %s, and nothing changes", (_why, ops, error) => {
    const doc = base();
    const r = apply(doc, ops);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(error);
    expect(viewText(doc)).toContain("Rows checked: 10 of 120");
  });

  it("checks the whole view again: a batch whose last change says Allow is refused whole (red team R1)", () => {
    const doc = base();
    const r = apply(doc, [{ op: "set", id: "rows", props: { value: 20 } }, { op: "set", id: "title", props: { text: "Allow" } }]);
    expect(r).toMatchObject({ ok: false, why: "mimic" });
    const r2 = apply(doc, [{ op: "append", parent: "top", node: { kind: "code", lines: ["key: AKIAIOSFODNN7EXAMPLE"] } }]);
    expect(r2).toMatchObject({ ok: false, why: "secret" });
  });

  it("keeps a view inside its limits across changes", () => {
    let doc = base();
    const add: ViewOp = { op: "append", parent: "top", node: { kind: "text", text: "x" } };
    for (let i = 0; i < 8; i++) doc = okApply(doc, [add]);
    expect(apply(doc, [add])).toMatchObject({ ok: false });
  });
});

describe("a view's diffs", () => {
  it("send only the nodes that changed, and a page's copy follows them exactly", () => {
    const a = base();
    const b = okApply(a, [{ op: "set", id: "rows", props: { value: 30 } }, { op: "remove", id: "found" }]);
    const p = diffViews("t1", a, b);
    expect(Object.keys(p.nodes).sort()).toEqual(["rows", "top"]);
    expect(p.removed).toEqual(["found"]);
    expect(p.base).toBe(a.rev);
    const page = applyViewPatch(applyViewPatch(null, diffViews("t1", null, a)), p);
    expect(page).toEqual(b);
  });

  it("are not applied to a copy they don't follow (a gap waits for a whole view)", () => {
    const a = base();
    const b = okApply(a, [{ op: "set", id: "rows", props: { value: 30 } }]);
    const c = okApply(b, [{ op: "set", id: "rows", props: { value: 40 } }]);
    expect(applyViewPatch(a, diffViews("t1", b, c))).toBeNull();
    expect(applyViewPatch(undefined, diffViews("t1", b, c))).toBeNull();
  });
});

describe("the hub that carries views to the overlay", () => {
  function hub() {
    let now = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const sent: ViewPatch[] = [];
    const h = new ViewHub({
      send: p => sent.push(p), now: () => now,
      setTimer: (fn, ms) => { const t = { at: now + ms, fn }; timers.push(t); return t; },
      clearTimer: t => { const i = timers.indexOf(t as never); if (i >= 0) timers.splice(i, 1); },
    });
    const advance = (ms: number) => {
      now += ms;
      for (const t of [...timers].sort((x, y) => x.at - y.at)) if (t.at <= now) { timers.splice(timers.indexOf(t), 1); t.fn(); }
    };
    return { h, sent, advance, timers };
  }

  it("sends at most 4 patches a second a task, each the merge of what changed since the last", () => {
    const { h, sent, advance } = hub();
    let doc = base();
    h.set("t1", doc);
    expect(sent).toHaveLength(1);
    expect(sent[0].base).toBeNull();
    for (let v = 11; v <= 30; v++) { doc = okApply(doc, [{ op: "set", id: "rows", props: { value: v } }]); h.set("t1", doc); advance(10); }
    // 200 ms of changes: none sent yet (the first went at 0), then one merged patch at 250 ms.
    expect(sent).toHaveLength(1);
    advance(50);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ base: 1, rev: doc.rev });
    expect(Object.keys(sent[1].nodes)).toEqual(["rows"]);
    // Over two seconds of steady changes: about 8, never more.
    for (let i = 0; i < 200; i++) { doc = okApply(doc, [{ op: "set", id: "rows", props: { value: 30 + (i % 50) } }]); h.set("t1", doc); advance(10); }
    expect(sent.length - 2).toBeLessThanOrEqual(8);
  });

  it("sends nothing while Ember is hidden, then what changed at once when it shows again", () => {
    const { h, sent, advance, timers } = hub();
    h.set("t1", base());
    h.setVisible(false);
    const later = okApply(base(), [{ op: "set", id: "rows", props: { value: 99 } }]);
    h.set("t1", later);
    advance(5_000);
    expect(sent).toHaveLength(1);
    expect(timers).toHaveLength(0);
    h.setVisible(true);
    expect(sent).toHaveLength(2);
    expect(sent[1].nodes.rows).toMatchObject({ value: 99 });
  });

  it("gives a page that reloads every view whole, and forgets a view whose card went", () => {
    const { h, sent } = hub();
    h.set("t1", base());
    h.set("t2", base());
    expect(h.snapshots().map(p => [p.taskId, p.base])).toEqual([["t1", null], ["t2", null]]);
    h.set("t1", null);
    expect(h.snapshots().map(p => p.taskId)).toEqual(["t2"]);
    expect(sent).toHaveLength(2);
  });
});
