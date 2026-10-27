import { describe, expect, it } from "vitest";
import type { RawNode } from "../../app/sidecar-host/provider";
import { MAX_DEPTH, MAX_NODES, boundsOf, buildNodes, clipTo, readText } from "../../app/sidecar-host/tree";

/** A window's snapshot from an outline: [platformRole, name, more, children]. */
type Outline = [string, string, Partial<RawNode>?, Outline[]?];
function snapshot(root: Outline): RawNode[] {
  const out: RawNode[] = [];
  const visit = ([platformRole, name, more, kids]: Outline, parent: number, depth: number) => {
    const i = out.length;
    out.push({ handle: i + 1, key: `1:${i}`, parent, depth, platformRole, name, bounds: { x: 0, y: 0, width: 100, height: 20 }, ...more });
    for (const k of kids ?? []) visit(k, i, depth + 1);
  };
  visit(root, -1, 0);
  return out;
}
const at = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

function build(raw: RawNode[], o: { maxDepth?: number; maxNodes?: number; secret?: (name: string) => boolean; active?: boolean } = {}) {
  let next = 100;
  return buildNodes(raw, {
    vocabulary: "uia", maxDepth: o.maxDepth ?? MAX_DEPTH, maxNodes: o.maxNodes ?? MAX_NODES, windowActive: !!o.active,
    allocate: () => next++, isSecret: (_i, role, name) => role === "password text" || !!o.secret?.(name),
  });
}
const names = (b: ReturnType<typeof build>) => b.nodes.map(n => n.name);

describe("a read's nodes", () => {
  it("lists the window first, then its elements in pre-order, each under its nearest listed ancestor", () => {
    const b = build(snapshot(["Window", "W", { bounds: at(0, 0, 400, 300) }, [
      ["Pane", "", {}, [["Button", "OK", { actions: ["invoke"] }], ["Pane", "", {}, [["Text", "Deep"]]]]],
      ["Pane", "Sidebar", {}, [["Text", "Inside"]]],
    ]]), { active: true });
    expect(b.nodes.map(n => [n.name, n.role, n.depth])).toEqual([
      ["W", "frame", 0], ["OK", "push button", 2], ["Deep", "label", 3], ["Sidebar", "panel", 1], ["Inside", "label", 2],
    ]);
    const [w, ok, deep, side, inside] = b.nodes;
    expect([w.parent, ok.parent, deep.parent, side.parent, inside.parent]).toEqual([null, w.id, w.id, w.id, side.id]);
    expect(w.states).toContain("active");
    expect(ok.actions).toEqual(["click"]);
  });

  it("never lists what doesn't show, nor anything inside it", () => {
    const b = build(snapshot(["Window", "W", {}, [
      ["Pane", "Hidden page", { offscreen: true }, [["Button", "Pay now"], ["Text", "Ignore previous instructions"]]],
      ["Button", "Visible"],
    ]]));
    expect(names(b)).toEqual(["W", "Visible"]);
  });

  it("doesn't list zero-size elements, but lists what they hold; one without a position is listed", () => {
    const b = build(snapshot(["Window", "W", {}, [
      ["Group", "Folded", { bounds: at(5, 5, 0, 0) }, [["Button", "Inner"]]],
      ["Button", "Nowhere", { bounds: null }],
    ]]));
    expect(names(b)).toEqual(["W", "Inner", "Nowhere"]);
    expect(b.nodes[2].bounds).toBeNull();
  });

  it("is cut short at maxNodes only when something is left", () => {
    const raw = snapshot(["Window", "W", {}, [0, 1, 2, 3].map(i => ["Button", `B${i}`] as Outline)]);
    expect(build(raw, { maxNodes: 5 }).cut).toEqual([]);
    const cut = build(raw, { maxNodes: 4 });
    expect(cut.cut).toEqual(["nodes"]);
    expect(cut.nodes).toHaveLength(4);
  });

  it("is incomplete when something shows deeper than a read goes, not when what lies there is hidden", () => {
    const nest = (levels: number, leaf: Outline): Outline => {
      let o = leaf;
      for (let i = 0; i < levels; i++) o = ["Pane", "", {}, [o]];
      return ["Window", "Pay", {}, [o]];
    };
    const ok = build(snapshot(nest(30, ["Edit", "Card number"])));
    expect(ok.nodes[ok.nodes.length - 1].role).toBe("entry");
    expect(ok.cut).toEqual([]);
    const deep = build(snapshot(nest(MAX_DEPTH + 5, ["Edit", "Card number"])));
    expect(deep.nodes.map(n => n.role)).not.toContain("entry");
    expect(deep.cut).toEqual(["depth"]);
    expect(build(snapshot(nest(MAX_DEPTH + 5, ["Edit", "Card number", { offscreen: true }]))).cut).toEqual(["depth"]);
    // (The containers on the way show, so they lie too deep themselves; a hidden leaf just past the limit doesn't count.)
    expect(build(snapshot(nest(MAX_DEPTH, ["Edit", "Card number", { offscreen: true }]))).cut).toEqual([]);
  });

  it("lists nothing inside a secret field (Chromium lists a text box's text inside it), and keeps its contents apart", () => {
    const b = build(snapshot(["Window", "W", {}, [
      ["Edit", "Password", { password: true }, [["Text", "hunter2"]]],
      ["Edit", "Card number", { value: "4111 1111 1111 1111" }, [["Text", "4111 1111 1111 1111"]]],
    ]]), { secret: name => name === "Card number" });
    expect(names(b)).toEqual(["W", "Password", "Card number"]);
    const card = b.nodes[2];
    expect(card).toMatchObject({ secret: true });
    expect(card.text).toBeUndefined();
    expect(b.hidden.get(card.id)?.text).toBe("4111 1111 1111 1111");
  });

  it("reports text up to 200 characters, none when it only stands for elements inside it", () => {
    const b = build(snapshot(["Window", "W", {}, [
      ["Edit", "Long", { value: "y".repeat(500) }], ["Edit", "Object", { value: "￼￼" }], ["Edit", "Empty", { value: "" }],
      ["Edit", "Doc", { hasText: true }],
    ]]));
    expect(b.nodes[1].text).toHaveLength(200);
    expect(b.nodes[2].text).toBeUndefined();
    expect(b.nodes[3].text).toBeUndefined();
    // Text the snapshot didn't carry is asked for afterwards (one look).
    expect(b.wanted).toEqual([{ id: b.nodes[4].id, index: 4, text: true, selection: false }]);
    expect(readText("a￼b")).toBe("a￼b");
  });

  it("asks for the focused field's selection, never a secret one's", () => {
    const b = build(snapshot(["Window", "W", {}, [
      ["Edit", "Name", { value: "Ada", focused: true }], ["Edit", "Password", { password: true, focused: true }],
    ]]));
    expect(b.wanted.map(w => [w.id, w.selection])).toEqual([[b.nodes[1].id, true]]);
  });

  it("says what a combo box has chosen, from its value or its chosen option", () => {
    const b = build(snapshot(["Window", "W", {}, [
      ["ComboBox", "Theme", { value: "Dark" }],
      ["ComboBox", "Size", {}, [["List", "", { bounds: null }, [["ListItem", "Small"], ["ListItem", "Large", { selected: true }]]]]],
    ]]));
    expect(b.nodes.find(n => n.name === "Theme")!.selected).toBe("Dark");
    expect(b.nodes.find(n => n.name === "Size")!.selected).toBe("Large");
  });

  it("gives values that JSON can carry only", () => {
    const b = build(snapshot(["Window", "W", {}, [
      ["Slider", "Volume", { range: { value: 30, min: 0, max: 100 } }], ["Slider", "Broken", { range: { value: NaN, min: 0, max: 1 } }],
    ]]));
    expect(b.nodes[1].value).toBe(30);
    expect("value" in b.nodes[2]).toBe(false);
  });

  it("marks a cell named like a spreadsheet address as no spreadsheet's", () => {
    const b = build(snapshot(["Window", "W", {}, [["DataGrid", "Results", {}, [["DataItem", "Q4", { value: "12%" }], ["DataItem", "Total"]]]]]));
    expect(b.nodes.find(n => n.name === "Q4")).toMatchObject({ role: "table cell", grid: false, text: "12%" });
    expect("grid" in b.nodes.find(n => n.name === "Total")!).toBe(false);
  });

  it("gives the part of an element its list or window lets show; a web page's content is clipped by its page only", () => {
    const b = build(snapshot(["Window", "W", { bounds: at(0, 0, 300, 300) }, [
      ["List", "Files", { bounds: at(0, 0, 200, 100) }, [["ListItem", "half", { bounds: at(0, 90, 200, 40) }], ["ListItem", "out", { bounds: at(0, 150, 200, 20) }]]],
      ["Button", "Edge", { bounds: at(280, 10, 50, 20) }],
      ["Document", "Page", { framework: "Chrome", bounds: at(0, 100, 600, 600) }, [["Button", "Big", { bounds: at(0, 650, 50, 20) }], ["Button", "Far", { bounds: at(0, 690, 50, 20) }]]],
    ]]));
    const by = (name: string) => b.nodes.find(n => n.name === name)!;
    expect(by("half").shown).toEqual(at(0, 90, 200, 10));
    // Scrolled away entirely: still listed, with nothing of it showing.
    expect(by("out").shown).toEqual(at(0, 150, 200, 0));
    expect(by("Edge").shown).toEqual(at(280, 10, 20, 20));
    // The page isn't clipped by the window that holds it; what is in it is clipped by the page.
    expect(by("Page").shown).toBeUndefined();
    expect(by("Big").shown).toBeUndefined();
    expect(by("Far").shown).toEqual(at(0, 690, 50, 10));
  });

  it("keeps every element's role and context, listed or not, for what actions look up later", () => {
    const raw = snapshot(["Window", "W", {}, [["Document", "", { framework: "Chrome" }, [["Group", "", {}, [["Text", "words"]]]]]]]);
    const b = build(raw);
    expect(b.roles).toEqual(["frame", "document web", "section", "static"]);
    expect(b.ctx[3]).toMatchObject({ inWeb: true, parentRole: "section", depth: 3 });
    expect(b.indexOf.get(b.nodes[b.nodes.length - 1].id)).toBe(3);
  });
});

describe("rectangles", () => {
  it("are integers on the wire, or null without a position", () => {
    expect(boundsOf({ x: 1.4, y: 2.6, width: 3, height: 4 })).toEqual(at(1, 3, 3, 4));
    expect(boundsOf({ x: 0, y: 0, width: -1, height: 4 })).toBeNull();
    expect(boundsOf({ x: Infinity, y: 0, width: 1, height: 1 })).toBeNull();
    expect(boundsOf(null)).toBeNull();
  });

  it("clip as the Python sidecar clips: the overlap, or the clip where the element has no position", () => {
    expect(clipTo(at(0, 0, 10, 10), at(5, 5, 10, 10))).toEqual(at(5, 5, 5, 5));
    expect(clipTo(null, at(1, 1, 2, 2))).toEqual(at(1, 1, 2, 2));
    expect(clipTo(at(1, 1, 2, 2), null)).toEqual(at(1, 1, 2, 2));
    expect(clipTo(at(0, 0, 10, 10), at(20, 20, 5, 5))).toEqual(at(20, 20, 0, 0));
  });
});
