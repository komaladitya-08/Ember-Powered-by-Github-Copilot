import { describe, expect, it } from "vitest";
import { AX_ERROR } from "../../app/main/platform/darwin/ax";
import { ProviderError } from "../../app/sidecar-host/provider";
import {
  AxSession, BusyApps, MAX_CHILDREN, MAX_TRIPS, NEEDS_PERMISSION, actionsOf, doPerform, errorCode, factsOf, nodeOf, overlaps,
  releaseFacts, textOf, walk, type Facts, type WalkResult,
} from "../../app/sidecar-host/providers/ax-darwin-read";
import { FakeAx, benchApp, type AppSpec, type ElSpec } from "./sidecar-host-ax-darwin-fake";

const at = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const PID = 4300;

/** Walks the window `id` of a fake desktop; the references the walk kept are given back afterwards. */
function walkOf(fake: FakeAx, o: { maxDepth?: number; maxNodes?: number; deadlineMs?: number; busy?: BusyApps; pid?: number; window?: string } = {}) {
  const busy = o.busy ?? new BusyApps(fake.now);
  const s = new AxSession(fake, o.pid ?? PID, busy);
  const win = fake.ref(fake.el(o.window ?? "window"));
  try {
    const r = walk(s, win, { maxDepth: o.maxDepth ?? 64, maxNodes: o.maxNodes ?? 1600, deadlineMs: o.deadlineMs ?? 1500, now: fake.now });
    return { r, s, busy, done: () => { for (const n of r.nodes) fake.release(n.ref); fake.release(win); } };
  } catch (err) {
    fake.release(win);
    throw err;
  }
}
const byName = (r: WalkResult, name: string) => r.nodes.find(n => n.node.name === name)!;
const app = (windows: ElSpec[], more: Partial<AppSpec> = {}): AppSpec => ({ pid: PID, owner: "Test", windows, ...more });
const window = (children: ElSpec[], more: Partial<ElSpec> = {}): ElSpec =>
  ({ role: "AXWindow", subrole: "AXStandardWindow", title: "W", id: "window", frame: at(0, 0, 800, 600), windowId: 77, children, ...more });

describe("the AX provider's walk of a window", () => {
  it("reads every element with one batched read, and never spends more than three round trips on one (M10)", () => {
    const fake = new FakeAx([benchApp()]);
    const { r, done } = walkOf(fake);
    expect(r.nodes.length).toBeGreaterThan(20);
    for (const n of r.nodes) {
      const uid = uidOf(fake, n.ref);
      const calls = fake.calls.filter(c => c.uid === uid);
      expect(calls.filter(c => c.op === "attrs"), `${n.node.platformRole} "${n.node.name}"`).toHaveLength(1);
      expect(calls.length, `${n.node.platformRole} "${n.node.name}"`).toBeLessThanOrEqual(MAX_TRIPS);
      expect(n.trips).toBeLessThanOrEqual(MAX_TRIPS);
    }
    expect(fake.calls.some(c => c.op === "attrs" && c.name !== undefined)).toBe(false);
    done();
    expect(fake.outstanding).toBe(0);
  });

  it("never reads a secure field's value, length or selection, and says it is a password field", () => {
    const fake = new FakeAx([benchApp()]);
    const { r, done } = walkOf(fake);
    const pw = r.nodes.find(n => n.node.name === "Password" && n.node.platformRole === "AXTextField")!;
    expect(pw.node).toMatchObject({ platformRole: "AXTextField", platformSubrole: "AXSecureTextField", password: true, editable: true });
    expect(pw.node.value).toBeUndefined();
    expect(pw.node.actions).not.toContain("setValue");
    expect(fake.callsAbout("password").map(c => c.op)).toEqual(["attrs"]);
    expect(JSON.stringify(r.nodes.map(n => n.node))).not.toContain("hunter2");
    done();
  });

  it("takes a text field whose subrole couldn't be read for a secure one, reading nothing of its value (fail closed)", () => {
    const fake = new FakeAx([benchApp()]);
    fake.el("password").spec.slots = { AXSubrole: AX_ERROR.failure };
    fake.el("name").spec.slots = { AXSubrole: AX_ERROR.failure };
    fake.el("save").spec.slots = { AXSubrole: AX_ERROR.failure };
    const { r, done } = walkOf(fake);
    for (const id of ["password", "name"]) {
      expect(fake.callsAbout(id).map(c => c.op), id).toEqual(["attrs"]);
      expect(r.nodes.find(n => n.ref !== undefined && uidOf(fake, n.ref) === fake.el(id).uid)!.node).toMatchObject({ password: true });
    }
    expect(JSON.stringify(r.nodes.map(n => n.node))).not.toContain("hunter2");
    // A subrole that is simply absent (NoValue) says nothing of the kind, and a button is no text field either way.
    expect(byName(r, "Save").node.password).toBeUndefined();
    done();
    const absent = new FakeAx([benchApp()]);
    absent.el("name").spec.value = "Ada";
    const again = walkOf(absent);
    expect(again.r.nodes.find(n => n.node.platformRole === "AXTextField" && n.node.name === "Name")!.node).toMatchObject({ value: "Ada" });
    again.done();
  });

  it("names a label by its text, a field by its label (without a round trip), and keeps a field's text cut to 2000 characters", () => {
    const fake = new FakeAx([benchApp()]);
    fake.el("name").spec.value = "x".repeat(2500);
    const { r, done } = walkOf(fake);
    expect(byName(r, "Name").node.platformRole).toBe("AXStaticText");
    const name = r.nodes.find(n => n.node.platformRole === "AXTextField" && n.node.name === "Name")!;
    expect(name.node).toMatchObject({ labelledBy: "Name", editable: true, focusable: true, focused: true });
    expect(name.node.value).toHaveLength(2000);
    expect(fake.callsAbout("nameLabel").filter(c => c.op === "attrs")).toHaveLength(1);
    done();
  });

  it("reads a label the walk didn't reach on its own, where the field's budget allows, and never past it", () => {
    const fake = new FakeAx([app([window([
      { role: "AXGroup", hidden: true, frame: at(0, 0, 100, 30), children: [{ role: "AXStaticText", value: "Card number", id: "far", frame: at(0, 0, 100, 30) }] },
      { role: "AXTextField", id: "card", titleElement: "far", value: "", frame: at(110, 0, 200, 30) },
      { role: "AXTextArea", id: "doc", titleElement: "far", value: "x", frame: at(110, 40, 200, 30) },
    ])])]);
    const { r, done } = walkOf(fake);
    const card = r.nodes.find(n => n.node.platformRole === "AXTextField")!;
    expect(card.node.labelledBy).toBe("Card number");
    expect(fake.callsAbout("card").length).toBe(2);
    expect(fake.callsAbout("far").map(c => c.op)).toEqual(["attrs"]);
    // The text area spent its three round trips (batch, length, value): its label isn't read.
    expect(r.nodes.find(n => n.node.platformRole === "AXTextArea")!.node.labelledBy).toBeUndefined();
    done();
    expect(fake.outstanding).toBe(0);
  });

  it("never names a field after a secure field's value, should an app make one its label", () => {
    const fake = new FakeAx([app([window([
      { role: "AXGroup", hidden: true, frame: at(0, 0, 100, 30), children: [
        { role: "AXTextField", subrole: "AXSecureTextField", id: "secret", value: "hunter2", frame: at(0, 0, 100, 30) },
      ] },
      { role: "AXTextField", id: "card", titleElement: "secret", value: "", frame: at(110, 0, 200, 30) },
    ])])]);
    const { r, done } = walkOf(fake);
    expect(r.nodes.find(n => n.node.platformRole === "AXTextField" && !n.node.offscreen)!.node.labelledBy).toBeUndefined();
    expect(JSON.stringify(r.nodes.map(n => n.node))).not.toContain("hunter2");
    done();
    expect(fake.outstanding).toBe(0);
  });

  it("reads a long document's first 2000 characters through AXStringForRange, never its whole AXValue", () => {
    const fake = new FakeAx([benchApp()]);
    fake.el("notes").spec.value = "a".repeat(1_000_000);
    const { r, done } = walkOf(fake);
    expect(byName(r, "Notes").node.value).toHaveLength(2000);
    const ops = fake.callsAbout("notes").map(c => `${c.op}${c.name ? ` ${c.name}` : ""}`);
    expect(ops).toEqual(["attrs", "attr AXNumberOfCharacters", "textRange"]);
    done();
  });

  it("reads a table's rows that show (AXVisibleRows), not all of its 200", () => {
    const fake = new FakeAx([benchApp()]);
    const { r, done } = walkOf(fake);
    expect(r.nodes.filter(n => n.node.platformRole === "AXRow")).toHaveLength(12);
    expect(fake.callsAbout("list").filter(c => c.op === "range").map(c => c.name)).toEqual(["AXVisibleRows"]);
    expect(r.cut).toEqual([]);
    done();
  });

  it("reads a long list by range, MAX_CHILDREN at most, and says the read was cut", () => {
    const items: ElSpec[] = Array.from({ length: 10_000 }, (_, i) => ({ role: "AXStaticText", value: `Item ${i}`, frame: at(0, i * 10, 100, 10) }));
    const fake = new FakeAx([app([window([{ role: "AXList", id: "list", frame: at(0, 0, 200, 600), children: items }])])]);
    const { r, done } = walkOf(fake);
    const ranges = fake.callsAbout("list").filter(c => c.op === "range");
    // AXVisibleChildren isn't there: AXChildren, one call, for the first MAX_CHILDREN + 1.
    expect(ranges.map(c => c.name)).toEqual(["AXVisibleChildren", "AXChildren"]);
    expect(r.nodes.filter(n => n.node.platformRole === "AXStaticText")).toHaveLength(MAX_CHILDREN);
    expect(r).toMatchObject({ truncated: true, cut: ["nodes"] });
    done();
    expect(fake.outstanding).toBe(0);
  });

  it("reads no more elements than it was asked for, however they nest, and says the read was cut", () => {
    for (const maxNodes of [1, 5, 10, 17]) {
      const fake = new FakeAx([benchApp()]);
      const { r, done } = walkOf(fake, { maxNodes });
      expect(r.nodes.length, `maxNodes ${maxNodes}`).toBeLessThanOrEqual(maxNodes);
      expect(r.cut).toEqual(["nodes"]);
      done();
      expect(fake.outstanding).toBe(0);
    }
  });

  it("marks what a scroll area hides, or AXHidden hides, as offscreen and reads nothing inside it", () => {
    const fake = new FakeAx([app([window([
      { role: "AXScrollArea", frame: at(0, 0, 400, 300), children: [{ role: "AXGroup", frame: at(0, 0, 400, 3000), children: [
        { role: "AXButton", title: "Shown", frame: at(10, 10, 80, 20), actions: ["AXPress"] },
        { role: "AXGroup", id: "below", frame: at(10, 1000, 300, 200), children: [{ role: "AXButton", title: "Deep", id: "deep", frame: at(10, 1010, 80, 20) }] },
        { role: "AXButton", title: "Edge", frame: at(10, 290, 80, 20) },
      ] }] },
      { role: "AXGroup", title: "Hidden", hidden: true, frame: at(500, 10, 100, 100), children: [{ role: "AXButton", title: "Inside", id: "inside", frame: at(510, 20, 50, 20) }] },
    ])])]);
    const { r, done } = walkOf(fake);
    expect(byName(r, "Shown").node.offscreen).toBeUndefined();
    expect(byName(r, "Edge").node.offscreen).toBeUndefined();
    expect(r.nodes.find(n => n.node.bounds?.y === 1000)!.node.offscreen).toBe(true);
    expect(byName(r, "Hidden").node.offscreen).toBe(true);
    expect(r.nodes.some(n => n.node.name === "Deep" || n.node.name === "Inside")).toBe(false);
    expect(fake.callsAbout("deep")).toEqual([]);
    expect(fake.callsAbout("inside")).toEqual([]);
    done();
  });

  it("marks an element with no frame offscreen unless something inside it shows", () => {
    const fake = new FakeAx([app([window([
      { role: "AXGroup", title: "Empty", frame: null, children: [{ role: "AXMenuItem", title: "Closed", frame: null }] },
      { role: "AXGroup", title: "Holder", frame: null, children: [{ role: "AXButton", title: "Shows", frame: at(10, 10, 50, 20) }] },
    ])])]);
    const { r, done } = walkOf(fake);
    expect(byName(r, "Empty").node.offscreen).toBe(true);
    expect(byName(r, "Closed").node.offscreen).toBe(true);
    expect(byName(r, "Holder").node.offscreen).toBeUndefined();
    expect(byName(r, "Shows").node.offscreen).toBeUndefined();
    done();
  });

  it("stops before the round trip that would pass the deadline less one messaging timeout, cut \"time\"", () => {
    const fake = new FakeAx([benchApp()]);
    fake.cost = 100;
    const t0 = fake.clock;
    const { r, done } = walkOf(fake, { deadlineMs: 1500 });
    expect(r).toMatchObject({ truncated: true, cut: ["time"], busy: false });
    expect(r.nodes[0]!.node.platformRole).toBe("AXWindow");
    // No call began after 1500 - 800 ms, so none could run past the deadline.
    expect(fake.clock - t0).toBeLessThanOrEqual(800);
    done();
    expect(fake.outstanding).toBe(0);
  });

  it("reads the window even when its whole budget is under one messaging timeout, then stops", () => {
    const fake = new FakeAx([benchApp()]);
    const { r, done } = walkOf(fake, { deadlineMs: 300 });
    expect(r.nodes).toHaveLength(1);
    expect(r.cut).toEqual(["time"]);
    done();
  });

  it("says \"depth\" where something lies below the deepest level asked for", () => {
    const fake = new FakeAx([app([window([{ role: "AXGroup", title: "G", frame: at(0, 0, 10, 10), children: [{ role: "AXButton", title: "B", frame: at(0, 0, 5, 5) }] }])])]);
    const { r, done } = walkOf(fake, { maxDepth: 1 });
    expect(r.nodes.map(n => n.node.name)).toEqual(["W", "G"]);
    expect(r).toMatchObject({ truncated: true, cut: ["depth"] });
    done();
    expect(fake.outstanding).toBe(0);
  });

  it("gives what it read with busy when the app stops answering partway, and leaves the app alone for 5 s", () => {
    const fake = new FakeAx([benchApp()]);
    fake.el("volume").spec.fail = AX_ERROR.cannotComplete;
    const { r, busy, done } = walkOf(fake);
    expect(r.busy).toBe(true);
    expect(r.nodes.some(n => n.node.name === "Remember me")).toBe(true);
    expect(r.nodes.some(n => n.node.name === "Save")).toBe(false);
    expect(busy.isBusy(PID)).toBe(true);
    expect(() => new AxSession(fake, PID, busy)).toThrow(ProviderError);
    fake.clock += 5000;
    expect(busy.isBusy(PID)).toBe(false);
    done();
    expect(fake.outstanding).toBe(0);
  });

  it("maps a slot's CannotComplete to busy, its NoValue or kCFNull to absent, and an element gone mid-read is left out", () => {
    const busyFake = new FakeAx([benchApp()]);
    busyFake.el("save").spec.slots = { AXTitle: AX_ERROR.cannotComplete };
    const busy = walkOf(busyFake);
    expect(busy.r.busy).toBe(true);
    expect(busy.busy.isBusy(PID)).toBe(true);
    busy.done();
    const fake = new FakeAx([benchApp()]);
    fake.el("save").spec.slots = { AXEnabled: AX_ERROR.noValue, AXFocused: null, AXHelp: AX_ERROR.attributeUnsupported };
    fake.el("remember").spec.fail = AX_ERROR.invalidUIElement;
    const { r, done } = walkOf(fake);
    expect(r.busy).toBe(false);
    const save = byName(r, "Save").node;
    expect(save.enabled).toBeUndefined();
    expect(save.focused).toBeUndefined();
    expect(save.focusable).toBeUndefined();
    expect(r.nodes.some(n => n.node.name === "Remember me")).toBe(false);
    done();
    expect(fake.outstanding).toBe(0);
  });

  it("gives every reference back when the permission goes partway through a walk", () => {
    const fake = new FakeAx([benchApp()]);
    fake.el("volume").spec.fail = AX_ERROR.apiDisabled;
    expect(() => walkOf(fake)).toThrow(NEEDS_PERMISSION);
    expect(fake.outstanding).toBe(0);
  });

  it("throws when the window itself is busy, gone or denied", () => {
    for (const [fail, code] of [[AX_ERROR.cannotComplete, "busy"], [AX_ERROR.invalidUIElement, "gone"], [AX_ERROR.apiDisabled, "denied"]] as const) {
      const fake = new FakeAx([benchApp()]);
      fake.el("window").spec.fail = fail;
      expect(() => walkOf(fake)).toThrow(expect.objectContaining({ code }));
      expect(fake.outstanding).toBe(0);
    }
  });
});

/** The uid of the element a reference names (through a fake round trip-free lookup). */
function uidOf(fake: FakeAx, ref: bigint): number {
  return (fake as unknown as { get(r: bigint): { uid: number } }).get(ref).uid;
}

describe("AX errors in the host's words", () => {
  it("maps each AXError as design §5.3 says", () => {
    expect(errorCode(AX_ERROR.cannotComplete)).toBe("busy");
    expect(errorCode(AX_ERROR.invalidUIElement)).toBe("gone");
    expect(errorCode(AX_ERROR.apiDisabled)).toBe("denied");
    for (const e of [AX_ERROR.attributeUnsupported, AX_ERROR.actionUnsupported, AX_ERROR.notImplemented]) expect(errorCode(e)).toBe("unsupported");
    expect(errorCode(AX_ERROR.noValue)).toBeNull();
    for (const e of [AX_ERROR.failure, AX_ERROR.illegalArgument, -1]) expect(errorCode(e)).toBe("failed");
  });

  it("says the Accessibility permission is missing when the API is disabled", () => {
    const fake = new FakeAx([benchApp()]);
    const s = new AxSession(fake, PID, new BusyApps(fake.now));
    expect(() => s.raise(AX_ERROR.apiDisabled, "x")).toThrow(NEEDS_PERMISSION);
    expect(() => s.raise(AX_ERROR.actionUnsupported, "press it")).toThrow(/^unsupported: press it$/);
  });

  it("tells overlapping rectangles, including ones with no area", () => {
    const clip = at(0, 0, 100, 100);
    expect(overlaps(at(50, 50, 10, 10), clip)).toBe(true);
    expect(overlaps(at(100, 50, 10, 10), clip)).toBe(false);
    expect(overlaps(at(-10, -10, 10, 10), clip)).toBe(false);
    expect(overlaps(at(50, 50, 0, 0), clip)).toBe(true);
    expect(overlaps(at(50, 50, 10, 10), at(0, 0, 0, 0))).toBe(false);
  });
});

/** Facts as a batch would give them. */
function facts(spec: ElSpec): Facts {
  const fake = new FakeAx([app([window([spec])])]);
  const el = fake.ref(fake.el("window").children[0]!);
  const m = fake.attrs(el, ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXEnabled", "AXFocused", "AXSelected", "AXExpanded", "AXDisclosing", "AXPosition", "AXSize", "AXMinValue", "AXMaxValue", "AXValueIncrement", "AXMenuItemMarkChar"]);
  if (m instanceof Map) {
    const f = factsOf(fake, m);
    releaseFacts(fake, f);
    return f;
  }
  throw new Error("no facts");
}

describe("an element's facts for the host", () => {
  it("takes a check box's, a radio button's and a disclosure triangle's state, and a slider's number, from AXValue", () => {
    expect(nodeOf(facts({ role: "AXCheckBox" }), 1, [])).toMatchObject({ toggle: "on" });
    expect(nodeOf(facts({ role: "AXCheckBox" }), 2, []).toggle).toBe("mixed");
    expect(nodeOf(facts({ role: "AXCheckBox", subrole: "AXSwitch" }), 0, []).toggle).toBe("off");
    expect(nodeOf(facts({ role: "AXButton", subrole: "AXToggle" }), true, []).toggle).toBe("on");
    expect(nodeOf(facts({ role: "AXRadioButton" }), 1, [])).toMatchObject({ selected: true });
    expect(nodeOf(facts({ role: "AXRadioButton" }), 1, []).value).toBeUndefined();
    expect(nodeOf(facts({ role: "AXSlider", min: 0, max: 100, step: 5 }), 30, ["setRange"]).range).toEqual({ value: 30, min: 0, max: 100, step: 5 });
    expect(nodeOf(facts({ role: "AXProgressIndicator", min: 0, max: 1 }), 0.5, []).range).toEqual({ value: 0.5, min: 0, max: 1, readOnly: true });
  });

  it("keeps a pop-up's choice as its value, a check menu item's mark as on, and a list's choosing", () => {
    expect(nodeOf(facts({ role: "AXPopUpButton", description: "Theme" }), "Dark", [])).toMatchObject({ name: "Theme", value: "Dark" });
    expect(nodeOf(facts({ role: "AXPopUpButton" }), "Dark", []).editable).toBeUndefined();
    expect(nodeOf(facts({ role: "AXMenuItem", title: "Bold", mark: "✓" }), undefined, []).toggle).toBe("on");
    expect(nodeOf(facts({ role: "AXMenuItem", title: "Bold" }), undefined, []).toggle).toBeUndefined();
    expect(nodeOf(facts({ role: "AXTable" }), undefined, []).selection).toEqual({ multiple: false });
    expect(nodeOf(facts({ role: "AXTextArea" }), "a\nb", [])).toMatchObject({ multiLine: true, editable: true, value: "a\nb" });
  });

  it("never says a window has the keyboard (its key window is `active` instead)", () => {
    expect(nodeOf(facts({ role: "AXWindow", focused: true }), undefined, []).focused).toBeUndefined();
  });

  it("lists actions from the role while walking, and from the action names and settable answers when asked", () => {
    expect(actionsOf(facts({ role: "AXButton" }), null, null)).toEqual(["invoke"]);
    expect(actionsOf(facts({ role: "AXCheckBox" }), null, null)).toEqual(["toggle"]);
    expect(actionsOf(facts({ role: "AXRadioButton" }), null, null)).toEqual(["select"]);
    expect(actionsOf(facts({ role: "AXPopUpButton" }), null, null)).toEqual(["expand"]);
    expect(actionsOf(facts({ role: "AXTextField", focused: false }), null, null)).toEqual(["setValue", "focus"]);
    expect(actionsOf(facts({ role: "AXTextField", subrole: "AXSecureTextField", focused: false }), null, null)).toEqual(["focus"]);
    expect(actionsOf(facts({ role: "AXSlider" }), null, null)).toEqual(["setRange"]);
    expect(actionsOf(facts({ role: "AXRow", selected: false }), null, null)).toEqual(["select", "addToSelection", "removeFromSelection"]);
    expect(actionsOf(facts({ role: "AXRow", disclosing: false }), null, null)).toEqual(["expand", "collapse"]);
    expect(actionsOf(facts({ role: "AXMenuItem" }), null, null)).toEqual(["invoke", "select"]);
    expect(actionsOf(facts({ role: "AXLink" }), ["AXPress", "AXScrollToVisible"], null)).toEqual(["invoke", "scrollIntoView"]);
    expect(actionsOf(facts({ role: "AXButton" }), ["AXShowMenu"], null)).toEqual([]);
    expect(actionsOf(facts({ role: "AXTextField", focused: false }), [], { value: false, focused: true })).toEqual(["focus"]);
    expect(actionsOf(facts({ role: "AXSlider" }), ["AXIncrement", "AXDecrement"], { value: false })).toEqual(["setRange"]);
    expect(actionsOf(facts({ role: "AXSlider" }), [], { value: false })).toEqual([]);
    expect(actionsOf(facts({ role: "AXRow", selected: false }), [], { selected: false })).toEqual([]);
  });
});

/** Does `op` on the element `id` of the bench, and says what was done to the app. */
function perform(id: string, op: Parameters<typeof doPerform>[3], value?: unknown, change?: (fake: FakeAx) => void) {
  const fake = new FakeAx([benchApp()]);
  change?.(fake);
  const s = new AxSession(fake, PID, new BusyApps(fake.now));
  const el = fake.ref(fake.el(id));
  const f = s.facts(el);
  try {
    doPerform(s, el, f, op, value);
    return { fake, error: null as unknown };
  } catch (err) {
    return { fake, error: err };
  } finally {
    releaseFacts(fake, f);
    fake.release(el);
  }
}

describe("doing things to an element", () => {
  it("presses buttons and toggles, selects by AXSelected or by pressing, and opens a pop-up's menu", () => {
    expect(perform("save", "invoke").fake.done).toEqual(["perform AXPress on save"]);
    const toggled = perform("remember", "toggle").fake;
    expect(toggled.done).toEqual(["perform AXPress on remember"]);
    expect(toggled.el("remember").spec.value).toBe(1);
    expect(perform("row3", "select").fake.done).toEqual(["set AXSelected=true on row3"]);
    expect(perform("row3", "removeFromSelection").fake.done).toEqual(["set AXSelected=false on row3"]);
    expect(perform("theme", "expand").fake.done).toEqual(["perform AXShowMenu on theme"]);
    expect(perform("save", "scrollIntoView", undefined, f => { f.el("save").spec.actions = ["AXPress", "AXScrollToVisible"]; }).fake.done).toEqual(["perform AXScrollToVisible on save"]);
  });

  it("sets a field's text and a slider's number, and gives a field the keyboard", () => {
    const set = perform("name", "setValue", "Ember 1").fake;
    expect(set.done).toEqual(["set AXValue=\"Ember 1\" on name"]);
    expect(set.el("name").spec.value).toBe("Ember 1");
    expect(perform("volume", "setRange", 70).fake.done).toEqual(["set AXValue=70 on volume"]);
    expect(perform("name", "focus").fake.done).toEqual(["set AXFocused=true on name"]);
  });

  it("steps a range that can't be set with AXIncrement and AXDecrement, stopping at the closest step", () => {
    const { fake } = perform("volume", "setRange", 72, f => { f.el("volume").spec.settable = []; f.el("volume").spec.step = 10; });
    expect(fake.done).toEqual(["perform AXIncrement on volume", "perform AXIncrement on volume"]);
    // Without a known step: one step past, and back when that was further.
    const past = perform("volume", "setRange", 72, f => { f.el("volume").spec.settable = []; f.el("volume").spec.stepBy = 10; }).fake;
    expect(past.done.slice(-2)).toEqual(["perform AXIncrement on volume", "perform AXDecrement on volume"]);
    expect(past.el("volume").spec.value).toBe(70);
    expect(fake.el("volume").spec.value).toBe(70);
    const down = perform("volume", "setRange", 33, f => { f.el("volume").spec.settable = []; f.el("volume").spec.step = 10; }).fake;
    expect(down.el("volume").spec.value).toBe(30);
  });

  it("refuses to set a secure field's text or number without asking the app anything", () => {
    for (const [op, value] of [["setValue", "x"], ["setRange", 3]] as const) {
      const { fake, error } = perform("password", op, value);
      expect(error, op).toMatchObject({ code: "denied" });
      expect(fake.done, op).toEqual([]);
      expect(fake.callsAbout("password").map(c => c.op), op).toEqual(["attrs"]);
    }
  });

  it("says unsupported for UI Automation's legacy action, and for what the element can't do", () => {
    expect(perform("save", "legacy").error).toMatchObject({ code: "unsupported" });
    expect(perform("save", "removeFromSelection").error).toMatchObject({ code: "unsupported" });
    expect(perform("save", "collapse").error).toMatchObject({ code: "unsupported" });
  });

  it("never raises a window or brings an app to the front, whatever it is asked to do", () => {
    const ops = ["invoke", "toggle", "select", "expand", "collapse", "setValue", "setRange", "focus", "scrollIntoView", "legacy"] as const;
    for (const id of ["save", "remember", "theme", "name", "volume", "row1", "window"]) {
      for (const op of ops) {
        const { fake } = perform(id, op, op === "setRange" ? 10 : "x");
        expect(fake.done.filter(d => /AXRaise|AXFrontmost|AXMain/.test(d)), `${op} on ${id}`).toEqual([]);
      }
    }
  });

  it("doesn't remember an app as busy when an action didn't come back (it may be running a modal dialog)", () => {
    const fake = new FakeAx([benchApp()]);
    const busy = new BusyApps(fake.now);
    const s = new AxSession(fake, PID, busy);
    const el = fake.ref(fake.el("save"));
    const f = s.facts(el);
    fake.el("save").spec.failOn = { perform: AX_ERROR.cannotComplete };
    expect(() => doPerform(s, el, f, "invoke")).toThrow(expect.objectContaining({ code: "busy" }));
    expect(busy.isBusy(PID)).toBe(false);
    releaseFacts(fake, f);
    fake.release(el);
  });
});

describe("text an element holds", () => {
  it("reads a field's text, selection and caret", () => {
    const fake = new FakeAx([benchApp()]);
    fake.el("name").spec.value = "Hello";
    const s = new AxSession(fake, PID, new BusyApps(fake.now));
    const el = fake.ref(fake.el("name"));
    expect(textOf(s, el, 100)).toEqual({ text: "Hello", caret: 5, caretAtEnd: true });
    expect(textOf(s, el, 3)).toMatchObject({ text: "Hel", truncated: true, caretAtEnd: true });
    fake.release(el);
    expect(fake.outstanding).toBe(0);
  });

  it("says a secure field is secret after reading only its role", () => {
    const fake = new FakeAx([benchApp()]);
    const s = new AxSession(fake, PID, new BusyApps(fake.now));
    const el = fake.ref(fake.el("password"));
    expect(textOf(s, el, 100)).toEqual({ secret: true });
    expect(fake.callsAbout("password")).toEqual([expect.objectContaining({ op: "attrs" })]);
    fake.release(el);
  });
});
