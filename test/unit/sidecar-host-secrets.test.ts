import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Host } from "../../app/sidecar-host/host";
import { FakeProvider, type FakeElementSpec, type FakeWindowSpec } from "../../app/sidecar-host/providers/fake";
import { KeySet, Secrets } from "../../app/sidecar-host/secrets";
import { secretByLayout } from "../../app/sidecar-host/labels";
import type { AxNode, ReadWindowResult } from "../../app/main/perception/sidecar";

const labels = JSON.parse(fs.readFileSync(path.resolve("test/fixtures/secret-labels.json"), "utf8")) as { secret: string[]; plain: string[] };
const at = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

function harness(children: FakeElementSpec[], more: Partial<FakeWindowSpec> = {}) {
  const fake = new FakeProvider([{ role: "Window", name: "Form", pid: 20, app: "app", native: 200, active: true, bounds: at(0, 0, 500, 400), children, ...more }], { deadlineMs: 300 });
  const host = new Host(fake, { env: { EMBER_ATSPI_ID_BASE: "10000000" }, settleMs: 0 });
  let n = 1;
  const call = async <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const msg = JSON.parse((await host.handle(JSON.stringify({ jsonrpc: "2.0", id: n++, method, params })))!);
    if (msg.error) throw new Error(msg.error.message);
    return msg.result as T;
  };
  const fails = (method: string, params: Record<string, unknown> = {}) => call(method, params).then(() => "resolved", (e: Error) => e.message);
  return { fake, host, call, fails };
}
type Read = ReadWindowResult & { secretKeys: [string, string][]; withheldKeys: [string, string][] };
const read = (call: ReturnType<typeof harness>["call"]) => call<Read>("read_window", { pid: 20 });
const find = (r: { nodes: AxNode[] }, test: (n: AxNode) => boolean) => r.nodes.find(test)!;
const edit = (name: string, value: string, more: Partial<FakeElementSpec> = {}): FakeElementSpec =>
  ({ role: "Edit", name, value, editable: true, actions: ["setValue", "focus"], ...more });

describe("secret fields by role, name and label", () => {
  it("judges a field secret by every secret label in the shared table, and none of the plain ones", () => {
    const s = new Secrets();
    for (const label of labels.secret) {
      expect(s.isSecret(null, {}, "entry", label), label).toBe(true);
      expect(s.isSecret(null, { labelledBy: label }, "entry", "", ), label).toBe(true);
      expect(s.isSecret(null, { help: label }, "text", ""), label).toBe(true);
    }
    for (const label of labels.plain) expect(s.isSecret(null, { labelledBy: label }, "entry", label), label).toBe(false);
  });

  it("never judges a button or a document by its name; a password field is secret whatever it is called", () => {
    const s = new Secrets();
    expect(s.isSecret(null, {}, "push button", "Show password")).toBe(false);
    expect(s.isSecret(null, {}, "document text", "secret.odt")).toBe(false);
    expect(s.isSecret(["fake", "1:1"], {}, "password text", "Name")).toBe(true);
    // Remembered by its key: it stays secret after "Show password" turned it into a plain field.
    expect(s.isSecret(["fake", "1:1"], {}, "entry", "Name")).toBe(true);
  });

  it("keeps the most recent keys of each kind, at most 4096", () => {
    const k = new KeySet(3);
    for (const i of [1, 2, 3, 4]) k.add(["a", String(i)]);
    k.add(null);
    expect([k.has(["a", "1"]), k.has(["a", "4"]), k.size]).toEqual([false, true, 3]);
  });

  it("never reports a secret field's text, and lists nothing inside it", async () => {
    const { call } = harness([
      edit("API key", "sk-live-SECRETKEY123", { bounds: at(10, 40, 300, 24), children: [{ role: "Text", name: "sk-live-SECRETKEY123", bounds: at(12, 44, 200, 16) }] }),
      { role: "Text", name: "Card number", bounds: at(10, 80, 100, 16) },
      edit("", "4111 1111 1111 1111", { bounds: at(10, 100, 300, 24), children: [{ role: "Text", name: "4111 1111 1111 1111", bounds: at(12, 104, 200, 16) }] }),
    ]);
    const r = await read(call);
    expect(r.nodes.map(n => [n.name, !!n.secret])).toEqual([["Form", false], ["API key", true], ["Card number", false], ["", true]]);
    expect(JSON.stringify(r)).not.toMatch(/SECRETKEY|4111/);
    expect(r.secretKeys).toHaveLength(2);
    // What was inside the card field (found secret by its label after the snapshot) can't be used by id either.
    const last = r.nodes[r.nodes.length - 1].id;
    await expect(call("read_element", { id: last + 1 })).rejects.toThrow(/no longer known/);
  });

  it("judges unnamed fields by the label beside or above them, but not by one that names a field on its own row", async () => {
    const { call } = harness([
      { role: "Text", name: "Password", bounds: at(8, 10, 60, 18) }, edit("", "indented", { bounds: at(38, 30, 150, 24) }),
      { role: "Text", name: "Password", bounds: at(8, 80, 60, 18) }, edit("", "hunter2", { bounds: at(80, 78, 150, 24) }),
      edit("", "ordinary notes", { bounds: at(8, 104, 400, 60) }),
      { role: "Text", name: "Card number", bounds: at(8, 180, 90, 18) }, { role: "Hyperlink", name: "What's this?", bounds: at(200, 180, 80, 18) },
      edit("", "4111", { bounds: at(8, 200, 150, 24) }),
    ]);
    const r = await read(call);
    expect(r.nodes.filter(n => n.role === "entry").map(n => n.text ?? null)).toEqual([null, null, "ordinary notes", null]);
  });

  it("finds secret layouts with Ember's own label rule", () => {
    const n = (id: number, role: string, name: string, b: ReturnType<typeof at>): AxNode => ({ id, parent: null, depth: 1, role, name, states: [], bounds: b });
    expect(secretByLayout([n(1, "label", "CVV", at(0, 0, 40, 20)), n(2, "entry", "", at(50, 0, 80, 20)), n(3, "entry", "Name", at(50, 40, 80, 20))])).toEqual([2]);
  });

  it("keeps a password field secret after Show password, by its key", async () => {
    const { fake, call } = harness([edit("Password", "", { password: true, bounds: at(10, 10, 200, 24) })]);
    await read(call);
    Object.assign(fake.el("Password", "Edit").spec, { password: false, value: "hunter2" });
    const r = await read(call);
    const field = find(r, n => n.name === "Password");
    expect(field).toMatchObject({ role: "entry", secret: true });
    expect(JSON.stringify(r)).not.toContain("hunter2");
    const info = await call<{ secret?: boolean; text?: string }>("read_element", { id: field.id });
    expect(info.secret).toBe(true);
    expect(info.text).toBeUndefined();
  });
});

describe("names that say what a secret field holds", () => {
  /** A checkout page in Chromium: cells and boxes named after the fields in them. */
  function checkout(): FakeElementSpec[] {
    return [{ role: "Document", name: "Checkout", framework: "Chrome", bounds: at(0, 0, 400, 300), children: [
      { role: "Group", name: "737", bounds: at(100, 36, 200, 28), actions: ["invoke"], children: [
        edit("CVV", "737", { bounds: at(110, 40, 80, 20) }),
        { role: "Text", name: "Tap to edit", bounds: at(195, 40, 4, 20), actions: ["legacy"] },
      ] },
      { role: "Group", name: "IBAN DE89 3704 0044 0532 0130 00", bounds: at(10, 76, 390, 28), children: [
        { role: "DataItem", name: "IBAN", bounds: at(10, 76, 90, 28) },
        { role: "DataItem", name: "DE89 3704 0044 0532 0130 00", bounds: at(100, 76, 300, 28), children: [edit("IBAN", "DE89 3704 0044 0532 0130 00", { bounds: at(110, 80, 260, 20) })] },
      ] },
      { role: "Group", name: "PIN 4821", bounds: at(10, 116, 200, 28), children: [{ role: "Text", name: "PIN", bounds: at(10, 120, 40, 20) }, edit("", "48 21", { bounds: at(60, 120, 80, 20) })] },
      { role: "Group", name: "Ada", bounds: at(10, 160, 200, 28), children: [edit("Name", "Ada", { bounds: at(60, 164, 80, 20) })] },
      { role: "Group", name: "Order 7374", bounds: at(10, 200, 300, 28) },
    ] }];
  }

  it("withholds the containers named after a secret's value, and any name that says a typed value as words", async () => {
    const { call } = harness(checkout());
    const r = await read(call);
    for (const leak of ["737\"", "DE89", "4821"]) expect(JSON.stringify(r.nodes.filter(n => n.name !== "Order 7374"))).not.toContain(leak);
    expect(r.nodes.map(n => n.name)).toContain("Order 7374");
    expect(r.nodes.map(n => n.name)).toContain("Ada");
    expect(r.nodes.filter(n => n.secret).map(n => n.role)).toEqual(["entry", "entry", "entry"]);
    expect(r.withheldKeys).toHaveLength(4);
    expect(r.nodes.filter(n => n.withheld).every(n => n.name === "")).toBe(true);
  });

  it("keeps them withheld under the wheel, in a look at the element, and in the control a click goes to", async () => {
    const { call } = harness(checkout());
    const r = await read(call);
    const chain = await call<{ chain: { role: string; name: string }[] }>("at_point", { pid: 20, path: "200", x: 250, y: 50 });
    expect(chain.chain.map(c => [c.role, c.name])).toEqual([["document web", "Checkout"], ["section", ""]]);
    const cell = find(r, n => n.role === "section" && n.withheld === true);
    const info = await call<{ name: string; text?: string; withheld?: boolean }>("read_element", { id: cell.id });
    expect([info.name, info.text, info.withheld]).toEqual(["", undefined, true]);
    const tap = find(r, n => n.name === "Tap to edit");
    expect((await call<{ handler?: unknown }>("can_do", { id: tap.id, kind: "click" })).handler).toEqual({ role: "section", name: "" });
  });

  it("withholds them under the wheel even in a process that never read the page (the field there tells)", async () => {
    const { call } = harness(checkout());
    const out = await call<{ chain: { role: string; name: string; secret?: boolean }[]; withheldKeys?: unknown[] }>("at_point", { pid: 20, path: "200", x: 150, y: 85 });
    expect(out.chain.map(c => [c.role, c.name])).toEqual([["document web", "Checkout"], ["section", ""], ["table cell", ""], ["entry", ""]]);
    expect(out.chain[3].secret).toBe(true);
    expect(JSON.stringify(out)).not.toContain("DE89");
    expect(out.withheldKeys).toHaveLength(2);
  });

  it("withholds the names round a field Ember found secret after a read, from then on and in the next process", async () => {
    const page = checkout();
    page[0].children!.push({ role: "Group", name: "hunter2-x", bounds: at(10, 240, 200, 28), children: [edit("", "hunter2-x", { bounds: at(60, 244, 80, 20) })] });
    const { call } = harness(page);
    const r = await read(call);
    expect(r.nodes.map(n => n.name)).toContain("hunter2-x");
    const field = find(r, n => n.role === "entry" && n.text === "hunter2-x");
    const marked = await call<{ keys: [string, string][]; withheldKeys: [string, string][] }>("mark_secret", { ids: [field.id] });
    expect(marked.withheldKeys).toHaveLength(1);
    expect(JSON.stringify(await read(call))).not.toContain("hunter2-x");
    // A host started afresh is handed the keys (as Ember does), and withholds them too.
    const fresh = harness(page);
    await fresh.call("remember_secrets", { keys: marked.keys, withheld: marked.withheldKeys });
    expect(JSON.stringify(await read(fresh.call))).not.toContain("hunter2-x");
  });

  it("judges a combo box named after what it shows by the label beside it", async () => {
    const combo = (shown: string, y: number, kids: FakeElementSpec[] = []): FakeElementSpec =>
      ({ role: "ComboBox", name: shown, value: shown, bounds: at(120, y, 200, 30), selection: { multiple: false }, children: kids });
    const { call, fails } = harness([
      ...[["Card expiry", 40], ["PIN", 80], ["Security question", 120], ["Country", 160]].map(([name, y]) => ({ role: "Text", name: name as string, bounds: at(10, (y as number) + 5, 90, 20) })),
      combo("09/28", 40), combo("4821", 80, [edit("", "4821", { bounds: at(124, 84, 170, 22) })]), combo("Mother's maiden name: Smith", 120), combo("France", 160),
    ]);
    const r = await read(call);
    expect(r.nodes.filter(n => n.role === "combo box").map(n => [n.name, n.selected ?? null, !!n.secret])).toEqual([
      ["", null, true], ["", null, true], ["", null, true], ["France", "France", false],
    ]);
    for (const leak of ["09/28", "4821", "Smith"]) expect(JSON.stringify(r)).not.toContain(leak);
    const pin = r.nodes.filter(n => n.role === "combo box")[1];
    expect(await fails("list_options", { id: pin.id })).toBe("this looks like a password or payment field; the user must fill it in");
    const found = await call<{ fields: { bounds: { y: number } }[]; complete: boolean }>("secret_fields", { pid: 20, path: "200" });
    expect(found.complete).toBe(true);
    // A field is judged as a whole (the PIN combo box's own entry is inside it), as the Python sidecar's scan does.
    expect(found.fields.map(f => f.bounds.y).sort((a, b) => a - b)).toEqual([40, 80, 120]);
  });

  it("never offers an option, or says a choice, that repeats what the user put in a secret field", async () => {
    const { call } = harness([
      edit("Card number", "4242 4242 4242 4242", { bounds: at(10, 10, 200, 24) }),
      { role: "ComboBox", name: "Pay from", value: "Card 4242 4242 4242 4242", bounds: at(10, 50, 200, 24), selection: { multiple: false }, children: [
        { role: "List", name: "", bounds: null, offscreen: true, children: [
          { role: "ListItem", name: "Card 4242 4242 4242 4242", selected: true, actions: ["select"] },
          { role: "ListItem", name: "Bank transfer", actions: ["select"] },
        ] },
      ] },
    ]);
    const r = await read(call);
    const payFrom = find(r, n => n.role === "combo box");
    expect(payFrom.name).toBe("Pay from");
    expect(payFrom.selected).toBeUndefined();
    expect(await call("list_options", { id: payFrom.id })).toEqual({ options: ["", "Bank transfer"] });
    expect((await call<{ selected?: string }>("read_element", { id: payFrom.id })).selected).toBe("");
  });
});
