import { describe, expect, it } from "vitest";
import { Host } from "../../app/sidecar-host/host";
import { FakeProvider, benchDesktop, type FakeElementSpec, type FakeWindowSpec } from "../../app/sidecar-host/providers/fake";
import { NO_ANSWER } from "../../app/sidecar-host/protocol";
import type { ActionResult, AxNode, CanDo, ReadWindowResult } from "../../app/main/perception/sidecar";

const at = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
/** What Ember's worker matches for a busy app, an unknown outcome, and what the mouse could do. */
const IS_BUSY = /\bbusy\b|did not (receive a reply|answer)|timeout was reached/i;

function harness(windows: FakeWindowSpec[] = benchDesktop(), deadlineMs = 300) {
  const fake = new FakeProvider(windows, { deadlineMs });
  const host = new Host(fake, { env: { EMBER_ATSPI_ID_BASE: "10000000" }, settleMs: 0 });
  let n = 1;
  const call = async <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const msg = JSON.parse((await host.handle(JSON.stringify({ jsonrpc: "2.0", id: n++, method, params })))!);
    if (msg.error) throw new Error(msg.error.message);
    return msg.result as T;
  };
  const fails = (method: string, params: Record<string, unknown> = {}) => call(method, params).then(() => "resolved", (e: Error) => e.message);
  const readAll = (params: Record<string, unknown> = {}) => call<ReadWindowResult>("read_window", params);
  /** The control called `name`: never the label beside it that says the same (the bench's "Theme" and "Theme"). */
  const id = async (name: string, params: Record<string, unknown> = {}) => {
    const nodes = (await readAll(params)).nodes;
    const node = nodes.find(x => x.name === name && x.role !== "label") ?? nodes.find(x => x.name === name);
    if (!node) throw new Error(`no node "${name}"`);
    return node.id;
  };
  return { fake, host, call, fails, readAll, id };
}
/** One app window holding `children` (the user is in it unless `active` is false). */
const app = (children: FakeElementSpec[], more: Partial<FakeWindowSpec> = {}): FakeWindowSpec[] =>
  [{ role: "Window", name: "App", pid: 30, app: "app", native: 300, active: true, bounds: at(0, 0, 600, 500), children, ...more }];
const list = (names: string[], more: Partial<FakeElementSpec> = {}, item: Partial<FakeElementSpec> = {}): FakeElementSpec => ({
  role: "List", name: "Files", bounds: at(10, 10, 300, 300), selection: { multiple: false }, actions: ["focus"], ...more,
  children: names.map((name, i) => ({ role: "ListItem", name, bounds: at(10, 10 + i * 20, 300, 20), actions: ["invoke", "select", "removeFromSelection", "focus"], ...item })),
});

describe("do_action", () => {
  it("clicks an element by its own action, once, and reads it again", async () => {
    const { fake, call, id } = harness();
    const r = await call<ActionResult>("do_action", { id: await id("Save"), action: "click" });
    expect(r).toMatchObject({ ok: true, action: "click", before: { role: "push button", name: "Save" }, after: { role: "push button", name: "Save" } });
    expect(fake.log).toEqual([{ op: "invoke", name: "Save", role: "Button" }]);
  });

  it("refuses an element that is disabled, hidden or gone", async () => {
    const { fake, fails, id } = harness();
    const save = await id("Save");
    fake.el("Save").spec.enabled = false;
    for (const m of ["do_action", "set_text", "select_option", "set_value"]) expect(await fails(m, { id: save, text: "x", option: "x", value: 1 })).toMatch(/disabled right now/);
    fake.el("Save").spec.enabled = true;
    fake.el("Save").spec.offscreen = true;
    expect(await fails("do_action", { id: save })).toMatch(/no longer on screen; read the window again/);
    fake.remove(fake.el("Save"));
    expect(await fails("do_action", { id: save })).toBe(`element ${save} is gone (the window changed); read the window again`);
    expect(fake.log).toEqual([]);
  });

  it("says busy in the exact words when the app doesn't answer, never gone", async () => {
    const { fake, fails, id } = harness();
    const save = await id("Save");
    fake.el("Save").spec.slowMs = 1000;
    const why = await fails("do_action", { id: save });
    expect(why).toBe("the app is busy (it didn't answer in time); try again in a moment");
    expect(why).toMatch(IS_BUSY);
  });

  it("counts a click that closes its own dialog as done (gone is an answer)", async () => {
    const { call, id } = harness(app([{ role: "Button", name: "OK", bounds: at(10, 10, 60, 24), actions: ["invoke"], onInvoke: "closeWindow" }]));
    expect(await call("do_action", { id: await id("OK") })).toMatchObject({ ok: true, action: "click", after: null, gone: true });
  });

  it("never blocks on a button that opens a modal dialog: it says it can't tell, and the dialog can be read at once", async () => {
    const { fake, call, fails, id } = harness();
    const t0 = Date.now();
    const why = await fails("do_action", { id: await id("Open dialog") });
    expect(why).toBe(NO_ANSWER);
    expect(why).toMatch(/did not answer/);
    expect(why).toMatch(IS_BUSY);
    expect(Date.now() - t0).toBeLessThan(2000);
    const dialog = await call<ReadWindowResult>("read_window", { title: "Saved?" });
    expect(dialog.window).toMatchObject({ role: "dialog", active: true });
    expect(dialog.busy).toBeUndefined();
    const ok = dialog.nodes.find(n => n.name === "OK")!;
    expect(await call("do_action", { id: ok.id })).toMatchObject({ ok: true, gone: true });
    expect(fake.windows.map(w => w.spec.name)).toEqual(["Ember Bench (Windows)"]);
  });

  it("toggles a check box, and its states say so right after (Ember checks them)", async () => {
    const { call, id } = harness();
    const box = await id("Remember me");
    const on = await call<ActionResult>("do_action", { id: box, action: "toggle" });
    expect(on).toMatchObject({ ok: true, action: "toggle" });
    expect(on.before!.states).not.toContain("checked");
    expect(on.after!.states).toContain("checked");
    const off = await call<ActionResult>("do_action", { id: box, action: "toggle" });
    expect(off.after!.states).not.toContain("checked");
    expect((await call<{ states: string[] }>("read_element", { id: box })).states).not.toContain("checked");
  });

  it("uses a one-way action only where it changes something", async () => {
    const { fake, call, fails, id } = harness(app([
      { role: "RadioButton", name: "Express", selected: false, bounds: at(10, 10, 100, 20), actions: ["select"] },
      { role: "Button", name: "Dark mode", className: "ToggleSwitch", toggle: "off", bounds: at(10, 40, 100, 20), actions: ["legacy"],
        onInvoke: el => { el.spec.toggle = el.spec.toggle === "on" ? "off" : "on"; } },
    ]));
    const radio = await id("Express");
    expect(await call("do_action", { id: radio })).toMatchObject({ ok: true, action: "select" });
    expect(await fails("do_action", { id: radio })).toBe("background_unavailable: no 'click' action (has: select)");
    expect(fake.log.filter(l => l.name === "Express")).toHaveLength(1);
    // A switch whose only action is its default one: done, and checked after.
    const sw = await call<ActionResult>("do_action", { id: await id("Dark mode"), action: "toggle" });
    expect(sw).toMatchObject({ ok: true, action: "dodefault" });
    expect(sw.after!.states).toContain("checked");
  });

  it("selects a list's item as a single click does and never opens it, in the window the user is in", async () => {
    const { fake, call, id } = harness(app([list(["a.txt", "b.txt", "c.txt"])]));
    const b = await id("b.txt");
    expect(await call<CanDo>("can_do", { id: b, kind: "click" })).toEqual({ tier1: true, action: "select item" });
    const r = await call<ActionResult>("do_action", { id: b, action: "click" });
    expect(r).toMatchObject({ ok: true, action: "select item" });
    expect(r.after!.states).toContain("selected");
    // Selected (what tells the app), then given the keyboard (the list's focus goes there, where Enter goes); never invoked.
    expect(fake.log.map(l => l.op)).toEqual(["select", "focus"]);
    expect(fake.el("b.txt").spec.selected).toBe(true);
    expect(fake.el("a.txt").spec.selected).toBeFalsy();
    // Already selected, with the keyboard: nothing more is done.
    fake.log.length = 0;
    expect(await call("do_action", { id: b })).toMatchObject({ ok: true, action: "select item" });
    expect(fake.log).toEqual([]);
  });

  it("selects a classic list box's item so that its app hears it, though its focus would select it silently (CI windows-2022)", async () => {
    // .NET's WindowsListBox proxy: SetFocus moves the selection without LBN_SELCHANGE, and Select on what is selected
    // already sends nothing, so focusing first left a WinForms list's SelectedIndexChanged unraised.
    const { fake, call, id } = harness(app([list(["Apple", "Banana", "Cherry"], { name: "Fruit" }, { actions: ["select", "focus", "scrollIntoView"], focusSelects: true })]));
    const r = await call<ActionResult>("do_action", { id: await id("Banana"), action: "click" });
    expect(r).toMatchObject({ ok: true, action: "select item", after: { states: expect.arrayContaining(["focused", "selected"]) } });
    expect(fake.log).toEqual([{ op: "select", name: "Banana", role: "ListItem" }, { op: "focus", name: "Banana", role: "ListItem" }]);
    expect(["Apple", "Banana", "Cherry"].map(n => !!fake.el(n).spec.selected)).toEqual([false, true, false]);
  });

  it("chooses an item by the keyboard where its list's Select does nothing", async () => {
    const { fake, call, id } = harness(app([list(["a", "b"], {}, { actions: ["select", "focus"], focusSelects: true })]));
    const b = fake.el("b");
    b.spec.actions = ["select", "focus"];
    // This list's Select fails (an app that chooses only by the keyboard); its focus selects.
    const real = fake.perform.bind(fake);
    fake.perform = async (h, op, value) => {
      if (op === "select") throw new Error("unsupported:select");
      return real(h, op, value);
    };
    expect(await call<ActionResult>("do_action", { id: await id("b"), action: "click" })).toMatchObject({ ok: true, action: "select item" });
    expect(fake.log.map(l => [l.op, l.name])).toEqual([["focus", "b"]]);
    expect(b.spec.selected).toBe(true);
  });

  it("unselects the others in a list that lets several be chosen", async () => {
    const { fake, call, id } = harness(app([list(["a", "b", "c"], { selection: { multiple: true } }, { selected: true })]));
    fake.el("b").spec.selected = false;
    await call("do_action", { id: await id("b") });
    expect(["a", "b", "c"].map(n => !!fake.el(n).spec.selected)).toEqual([false, true, false]);
  });

  it("leaves an item in a window the user isn't in to the mouse (choosing it there would bring the window to the front)", async () => {
    const { fake, call, fails, id } = harness(app([list(["a.txt", "b.txt"])], { active: false }));
    const b = await id("b.txt", { pid: 30 });
    const can = await call<CanDo>("can_do", { id: b, kind: "click" });
    expect(can).toMatchObject({ tier1: false, action: "select item" });
    expect(can.why).toMatch(/isn't the active one/);
    expect(await fails("do_action", { id: b })).toMatch(/^background_unavailable: its window isn't the active one/);
    expect(fake.log).toEqual([]);
    // Selected already: that is done.
    fake.el("b.txt").spec.selected = true;
    expect(await call<CanDo>("can_do", { id: b, kind: "click" })).toEqual({ tier1: true, action: "select item" });
    expect(await call("do_action", { id: b })).toMatchObject({ ok: true, action: "select item" });
  });

  it("leaves an item its list can't select to the mouse, opening nothing", async () => {
    const { fake, call, fails, id } = harness(app([list(["a.txt"], {}, { actions: ["invoke"] })]));
    const a = await id("a.txt");
    expect(await call<CanDo>("can_do", { id: a, kind: "click" })).toMatchObject({ tier1: false, action: "select item", why: "it can't be selected by accessibility" });
    expect(await fails("do_action", { id: a })).toBe("background_unavailable: it can't be selected by accessibility");
    expect(fake.log).toEqual([]);
  });

  it("refuses a toggle on an item whose click only selects it, and leaves a check box in a list to the mouse", async () => {
    const { call, fails, id } = harness(app([
      list(["plain"]),
      { role: "List", name: "Services", bounds: at(320, 10, 200, 100), selection: { multiple: true }, children: [
        { role: "ListItem", name: "ssh", toggle: "off", bounds: at(320, 10, 200, 20), actions: ["invoke", "select"] },
        { role: "ListItem", name: "http", toggle: "off", bounds: at(320, 30, 200, 20), actions: ["toggle", "select"] },
      ] },
    ]));
    const plain = await id("plain");
    expect(await call<CanDo>("can_do", { id: plain, kind: "toggle" })).toEqual({ tier1: true, action: "select item" });
    expect(await fails("do_action", { id: plain, action: "toggle" })).toBe(`element ${plain} is no switch or check box: a click on it only selects it`);
    const ssh = await id("ssh");
    const can = await call<CanDo>("can_do", { id: ssh, kind: "toggle" });
    expect(can).toMatchObject({ tier1: false, action: "toggle" });
    expect(can.why).toMatch(/ticked only by a click on it/);
    expect(can.handler).toBeUndefined();
    const why = await fails("do_action", { id: ssh, action: "toggle" });
    expect(why).toMatch(/^background_unavailable: /);
    expect(why).toMatch(/check box in a list/);
    // A box in a list with a toggle of its own is ticked by it.
    expect(await call("do_action", { id: await id("http"), action: "toggle" })).toMatchObject({ ok: true, action: "toggle" });
  });
});

describe("can_do", () => {
  it("tells whether accessibility can do it, as the action checks it, doing nothing", async () => {
    const { fake, call, id } = harness();
    expect(await call("can_do", { id: await id("Remember me"), kind: "toggle" })).toEqual({ tier1: true, action: "toggle" });
    expect(await call("can_do", { id: await id("Save"), kind: "click" })).toEqual({ tier1: true, action: "click" });
    expect(await call("can_do", { id: await id("Name"), kind: "text" })).toEqual({ tier1: true });
    expect(await call("can_do", { id: await id("Volume"), kind: "value" })).toEqual({ tier1: true });
    expect(fake.log).toEqual([]);
  });

  it("says why not, in the words the mouse route shows", async () => {
    const { call, id } = harness(app([
      { role: "Edit", name: "Read-only", value: "x", bounds: at(10, 10, 100, 20) },
      { role: "Slider", name: "Fixed", range: { value: 1, min: 0, max: 2 }, bounds: at(10, 40, 100, 20) },
      { role: "ComboBox", name: "Menu-ish", expanded: false, bounds: at(10, 70, 100, 20), actions: ["expand", "collapse"] },
    ]));
    expect(await call("can_do", { id: await id("Read-only"), kind: "text", caret: true })).toEqual({
      tier1: false, why: "this element's text can't be edited directly", focused: false, windowActive: true,
    });
    expect(await call("can_do", { id: await id("Fixed"), kind: "value" })).toEqual({ tier1: false, why: "this element has no value to set" });
    const can = await call<CanDo>("can_do", { id: await id("Menu-ish"), kind: "toggle" });
    expect(can.tier1).toBe(false);
    expect(can.why).toMatch(/no 'toggle' action \(has: expand or contract\)/);
    expect("action" in can).toBe(false);
  });

  it("names the control a click on text inside it goes to", async () => {
    const { call } = harness(app([{ role: "Document", name: "Page", framework: "Chrome", bounds: at(0, 0, 600, 500), children: [
      { role: "Hyperlink", name: "Delete my account", bounds: at(10, 10, 200, 20), actions: ["invoke"], children: [
        { role: "Text", name: "Delete my account", bounds: at(10, 10, 200, 20), actions: ["legacy"] },
      ] },
      { role: "Group", name: "Row", bounds: at(10, 40, 300, 40), actions: ["invoke"], children: [
        { role: "ListItem", name: "", bounds: at(10, 40, 300, 40), children: [{ role: "Text", name: "Item", bounds: at(12, 44, 100, 20), actions: ["legacy"] }] },
      ] },
      { role: "Text", name: "Loose words", bounds: at(10, 100, 100, 20), actions: ["legacy"] },
      { role: "Button", name: "Own", bounds: at(10, 130, 100, 20), actions: ["invoke", "legacy"] },
    ] }]));
    const r = await call<ReadWindowResult>("read_window", {});
    const node = (name: string, role?: string) => r.nodes.find((n: AxNode) => n.name === name && (!role || n.role === role))!.id;
    expect(await call("can_do", { id: node("Delete my account", "static"), kind: "click" })).toEqual({ tier1: true, action: "dodefault", handler: { role: "link", name: "Delete my account" } });
    // A row without actions is passed over for the box round it that acts.
    expect((await call<CanDo>("can_do", { id: node("Item"), kind: "click" })).handler).toEqual({ role: "section", name: "Row" });
    // Nothing acting up to the page: no handler.
    expect(await call("can_do", { id: node("Loose words"), kind: "click" })).toEqual({ tier1: true, action: "dodefault" });
    expect(await call("can_do", { id: node("Own"), kind: "click" })).toEqual({ tier1: true, action: "click" });
  });

  it("names the row a mouse click on its unnamed label goes to", async () => {
    const { call } = harness(app([list([""], {}, { actions: [], children: [{ role: "Text", name: "Deutsch", bounds: at(12, 12, 100, 16) }] } as Partial<FakeElementSpec>)]));
    const r = await call<ReadWindowResult>("read_window", {});
    const label = r.nodes.find(n => n.name === "Deutsch")!;
    expect(await call("can_do", { id: label.id, kind: "click" })).toEqual({ tier1: false, why: "this element has no accessible actions", handler: { role: "list item", name: "" } });
  });
});

describe("set_text and set_value", () => {
  it("replaces a field's text, and reads it back for Ember to check", async () => {
    const { fake, call, id } = harness();
    const r = await call<ActionResult>("set_text", { id: await id("Name"), text: "Ada Lovelace", mode: "replace" });
    expect(r).toMatchObject({ ok: true, after: { role: "entry", text: "Ada Lovelace" } });
    expect(fake.log).toEqual([{ op: "setValue", name: "Name", role: "Edit", value: 12 }]);
  });

  it("appends, and inserts where the caret is only where that can be told", async () => {
    const { fake, call, fails, id } = harness(app([{ role: "Edit", name: "Notes", value: "Hello", editable: true, bounds: at(10, 10, 300, 24), actions: ["setValue"] }]));
    const notes = await id("Notes");
    expect((await call<ActionResult>("set_text", { id: notes, text: " world", mode: "append" })).after!.text).toBe("Hello world");
    fake.el("Notes").spec.caretAtEnd = false;
    expect(await fails("set_text", { id: notes, text: "!", mode: "insert" })).toMatch(/^background_unavailable: where the caret is/);
    fake.el("Notes").spec.caretAtEnd = true;
    expect((await call<ActionResult>("set_text", { id: notes, text: "!", mode: "insert" })).after!.text).toBe("Hello world!");
    // At the caret, a selection there not replaced (as AT-SPI inserts).
    Object.assign(fake.el("Notes").spec, { caret: 5, caretAtEnd: false, selectionText: " world" });
    expect((await call<ActionResult>("set_text", { id: notes, text: ",", mode: "insert" })).after!.text).toBe("Hello, world!");
  });

  it("refuses secret fields, and text where it can't be set", async () => {
    const { fails, id } = harness(app([
      { role: "Edit", name: "Password", password: true, editable: true, bounds: at(10, 10, 100, 20), actions: ["setValue"] },
      { role: "Edit", name: "Card number", value: "", editable: true, bounds: at(10, 40, 100, 20), actions: ["setValue"] },
      { role: "Edit", name: "Label-like", value: "fixed", bounds: at(10, 70, 100, 20) },
    ]));
    expect(await fails("set_text", { id: await id("Password"), text: "x" })).toBe("password fields are off limits to Ember; the user must fill them in");
    expect(await fails("set_text", { id: await id("Card number"), text: "x" })).toBe("this looks like a password or payment field; the user must fill it in");
    expect(await fails("set_text", { id: await id("Label-like"), text: "x" })).toBe("background_unavailable: this element's text can't be edited directly");
  });

  it("sets a value within its range only", async () => {
    const { fake, call, fails, id } = harness();
    const volume = await id("Volume");
    expect(await fails("set_value", { id: volume, value: 150 })).toBe("value 150.0 is outside 0.0..100.0");
    expect(await fails("set_value", { id: volume })).toBe("'value'");
    const r = await call<ActionResult>("set_value", { id: volume, value: 75 });
    expect(r).toMatchObject({ ok: true, after: { role: "slider", value: 75 } });
    expect(fake.log).toEqual([{ op: "setRange", name: "Volume", role: "Slider", value: 75 }]);
    expect(await fails("set_value", { id: await id("Save"), value: 1 })).toBe("background_unavailable: this element has no value to set");
  });
});

describe("list_options and select_option", () => {
  it("lists a closed drop-down's options and chooses one by its full name only", async () => {
    const { fake, call, fails, id } = harness();
    const theme = await id("Theme");
    expect(await call("list_options", { id: theme })).toEqual({ options: ["Light", "Dark", "System"] });
    const why = await fails("select_option", { id: theme, option: "ark" });
    expect(why).toBe("no option has exactly that name (it has 3 options); list them and use one in full");
    expect(why).not.toMatch(/Dark/);
    const r = await call<ActionResult & { already?: boolean }>("select_option", { id: theme, option: "dark" });
    expect(r).toMatchObject({ ok: true, option: "Dark", after: { selected: "Dark" } });
    expect(fake.log).toEqual([{ op: "select", name: "Dark", role: "ListItem" }]);
    fake.log.length = 0;
    expect(await call("select_option", { id: theme, option: "Dark" })).toMatchObject({ ok: true, option: "Dark", already: true });
    expect(fake.log).toEqual([]);
  });

  it("names unnamed options by the label inside them", async () => {
    const { fake, call, id } = harness(app([{ role: "List", name: "Language", bounds: at(10, 10, 200, 100), selection: { multiple: false }, children:
      ["English", "Français", "Deutsch"].map((w, i) => ({ role: "ListItem", name: "", bounds: at(10, 10 + i * 20, 200, 20), actions: ["select"], children: [
        { role: "Pane", name: "", bounds: at(10, 10 + i * 20, 200, 20), children: [{ role: "Text", name: w, bounds: at(12, 12 + i * 20, 80, 16) }] },
      ] })) }]));
    const lang = await id("Language");
    expect(await call("list_options", { id: lang })).toEqual({ options: ["English", "Français", "Deutsch"] });
    expect(await call("select_option", { id: lang, option: "Deutsch" })).toMatchObject({ ok: true, option: "Deutsch" });
    expect(fake.log).toEqual([{ op: "select", name: "", role: "ListItem" }]);
  });

  it("says ok: false where an option won't take the choice, and leaves the choice as it was", async () => {
    const { fake, call, id } = harness();
    fake.el("System").spec.actions = [];
    expect(await call("select_option", { id: await id("Theme"), option: "System" })).toMatchObject({ ok: false, option: "System", after: { selected: "Light" } });
  });

  it("says ok: false where the option says it is chosen but its box still shows another", async () => {
    const { fake, call, id } = harness();
    // The app didn't hear of the choice: its box (an editable one, which shows its choice as its value) goes on showing
    // the old one.
    fake.el("Dark").spec.onInvoke = undefined;
    const theme = fake.el("Theme", "ComboBox");
    theme.spec.value = "Light";
    const realPerform = fake.perform.bind(fake);
    fake.perform = async (h, op, value) => {
      await realPerform(h, op, value);
      theme.spec.value = "Light";
    };
    expect(await call("select_option", { id: await id("Theme"), option: "Dark" })).toMatchObject({ ok: false, option: "Dark", after: { selected: "Light" } });
  });

  it("refuses what holds no options", async () => {
    const { fails, id } = harness();
    expect(await fails("list_options", { id: await id("Save") })).toBe("background_unavailable: this element has no selectable options");
  });

  it("chooses a list's row by its words, never one of two that share them", async () => {
    const rows = (names: string[]): FakeElementSpec => ({ role: "Tree", name: "Folders", bounds: at(10, 10, 300, 300), selection: { multiple: false }, children: names.map((n, i) => ({
      role: "TreeItem", name: "", bounds: at(10, 10 + i * 20, 300, 20), actions: ["select", "focus"], children: [{ role: "Text", name: n, bounds: at(12, 12 + i * 20, 100, 16) }],
    })) });
    const { fake, call, fails, id } = harness(app([rows(["notes.txt", "budget.csv", "Budget.csv", "plan.md"])]));
    const tree = await id("Folders");
    expect(await call("list_options", { id: tree })).toEqual({ options: ["notes.txt", "budget.csv", "Budget.csv", "plan.md"] });
    expect(await fails("select_option", { id: tree, option: "budget.csv" })).toBe("several rows are called that; click a cell of the one meant instead");
    expect(fake.log).toEqual([]);
    const r = await call<ActionResult>("select_option", { id: tree, option: "plan.md" });
    expect(r).toMatchObject({ ok: true, option: "plan.md", after: { role: "tree", selected: "plan.md" } });
  });

  it("looks through a long list in time: the rows not named in time are left, and a name too far down is to be typed", async () => {
    const tree: FakeElementSpec = { role: "Tree", name: "Folder", bounds: at(10, 10, 300, 300), selection: { multiple: false }, children:
      Array.from({ length: 1200 }, (_, i) => ({ role: "TreeItem", name: "", slowMs: 3, bounds: at(10, 10, 300, 20), actions: ["select", "focus"],
        children: [{ role: "Text", name: `file${i}.txt`, bounds: at(12, 12, 100, 16) }] })) };
    const { call, fails, id } = harness(app([tree]));
    const folder = await id("Folder");
    const t0 = Date.now();
    const listed = await call<{ options: string[]; left?: number }>("list_options", { id: folder });
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(listed.options.length).toBeGreaterThan(10);
    expect(listed.options.slice(0, 3)).toEqual(["file0.txt", "file1.txt", "file2.txt"]);
    expect(listed.left).toBe(1200 - listed.options.length);
    expect(await fails("select_option", { id: folder, option: "file1199.txt" })).toMatch(
      /^Ember looked through the list's first \d+ rows of 1200 in time and none is called exactly that: in a long list, type the name instead/);
    const r = await call<ActionResult>("select_option", { id: folder, option: "file3.txt" });
    expect(r).toMatchObject({ ok: true, option: "file3.txt" });
    expect(r.unchecked).toBeGreaterThan(0);
    expect(r.unchecked).toBeLessThan(1196);
  }, 20_000);

  it("chooses a row by name only in the window the user is in: elsewhere a click on it does that", async () => {
    const tree: FakeElementSpec = { role: "Tree", name: "Folders", bounds: at(10, 10, 300, 300), selection: { multiple: false }, children: [
      { role: "TreeItem", name: "a", bounds: at(10, 10, 300, 20), actions: ["select", "focus"] },
    ] };
    const { fake, fails, id } = harness(app([tree], { active: false }));
    const why = await fails("select_option", { id: await id("Folders", { pid: 30 }), option: "a" });
    expect(why).toBe("its window isn't the active one, and choosing a row there by name would bring it to the front: click a cell of that row instead");
    expect(why).not.toMatch(/background_unavailable/);
    expect(fake.log).toEqual([]);
  });
});

describe("focus", () => {
  it("gives an element the keyboard only in the window the user is in", async () => {
    const { fake, call, fails, id } = harness();
    expect(await call("focus", { id: await id("Name") })).toMatchObject({ ok: true, after: { states: expect.arrayContaining(["focused"]) } });
    expect(fake.log.map(l => l.op)).toEqual(["focus"]);
    const inactive = harness(app([{ role: "Edit", name: "Field", value: "", bounds: at(10, 10, 100, 20), actions: ["focus", "setValue"] }], { active: false }));
    expect(await inactive.fails("focus", { id: await inactive.id("Field", { pid: 30 }) })).toMatch(/^background_unavailable: its window isn't the active one/);
    expect(await fails("focus", { id: 1 })).toMatch(/no longer known/);
  });
});
