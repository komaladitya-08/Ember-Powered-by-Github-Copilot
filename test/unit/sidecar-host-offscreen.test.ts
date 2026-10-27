import { describe, expect, it } from "vitest";
import { Host } from "../../app/sidecar-host/host";
import { FakeProvider, type FakeElementSpec, type FakeWindowSpec } from "../../app/sidecar-host/providers/fake";
import type { AxNode, ReadWindowResult } from "../../app/main/perception/sidecar";

const at = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

/** A host over one fake window of app `pid` 30 (a browser's, UI Automation's words). */
function harness(children: FakeElementSpec[], more: Partial<FakeWindowSpec> = {}, vocabulary: "uia" | "ax" = "uia") {
  const fake = new FakeProvider([{ role: "Window", name: "Page", pid: 30, app: "msedge", native: 300, active: true, bounds: at(0, 0, 800, 600), children, ...more }], { deadlineMs: 2000, vocabulary });
  const host = new Host(fake, { env: { EMBER_ATSPI_ID_BASE: "20000000" }, settleMs: 0 });
  let n = 1;
  const call = async <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const msg = JSON.parse((await host.handle(JSON.stringify({ jsonrpc: "2.0", id: n++, method, params })))!);
    if (msg.error) throw new Error(msg.error.message);
    return msg.result as T;
  };
  return { fake, host, call };
}
type Read = ReadWindowResult & { secretKeys: [string, string][]; withheldKeys: [string, string][] };
const read = (call: ReturnType<typeof harness>["call"]) => call<Read>("read_window", { pid: 30 });
const names = (r: { nodes: AxNode[] }) => r.nodes.map(n => n.name);

/** `count` links scrolled up out of view (real bounds above the window, offscreen), as Chromium reports them. */
const above = (count: number, prefix = "Old link"): FakeElementSpec[] =>
  Array.from({ length: count }, (_, i) => ({ role: "Hyperlink", name: `${prefix} ${i}`, offscreen: true, bounds: at(10, -20 * (count - i), 200, 18) }));
const visible = (count: number): FakeElementSpec[] =>
  Array.from({ length: count }, (_, i) => ({ role: "Hyperlink", name: `Visible link ${i}`, bounds: at(10, 40 + 20 * i, 200, 18) }));
const page = (children: FakeElementSpec[]): FakeElementSpec => ({ role: "Document", name: "Long page", bounds: at(0, 30, 800, 570), children });

describe("a long page scrolled down (review #1)", () => {
  // Chromium hands UI Automation the whole page; what is above the viewport is offscreen with real bounds. The host
  // lists none of it, so the bridge puts what shows first and reads nothing inside what doesn't.
  for (const before of [300, 1700, 3000]) {
    it(`lists every visible link after ${before} links scrolled out of view, and says nothing is missing`, async () => {
      const { call } = harness([page([...above(before), ...visible(25)])]);
      const r = await read(call);
      expect(names(r).filter(n => n.startsWith("Visible link"))).toHaveLength(25);
      expect(names(r).some(n => n.startsWith("Old link"))).toBe(false);
      expect(r.cut ?? []).not.toContain("nodes");
      expect(r.truncated).toBe(false);
    });
  }

  it("reads nothing inside an offscreen section, so a page's sections above the viewport cost one element each", async () => {
    const sections = Array.from({ length: 40 }, (_, s): FakeElementSpec => ({
      role: "Group", name: `Section ${s}`, offscreen: true, bounds: at(0, -5000 + s * 100, 800, 90),
      children: above(200, `Section ${s} link`),
    }));
    const { call } = harness([page([...sections, ...visible(25)])]);
    const r = await read(call);
    expect(names(r).filter(n => n.startsWith("Visible link"))).toHaveLength(25);
    expect(r.truncated).toBe(false);
    // The secret-field scan sees the whole of what shows: screenshots aren't refused for the page's size.
    const scan = await call<{ complete: boolean; busy?: boolean }>("secret_fields", { pid: 30, path: r.window!.path });
    expect(scan.complete).toBe(true);
  });

  it("still says the read was cut when what shows is more than a read lists", async () => {
    const { call } = harness([page([...above(50), ...visible(500)])]);
    const r = await read(call);
    expect(r.truncated).toBe(true);
    expect(r.cut).toContain("nodes");
  });

  it("still reads a closed drop-down's options, which are offscreen, for the choice an editable combo box shows", async () => {
    const { call } = harness([{
      role: "ComboBox", name: "City", editable: true, value: "Par", bounds: at(10, 40, 200, 24), expanded: false, children: [
        { role: "Edit", name: "City", value: "Par", editable: true, bounds: at(10, 40, 180, 24) },
        { role: "List", name: "", offscreen: true, bounds: at(10, 64, 200, 100), children: [
          { role: "ListItem", name: "Paris", selected: true, offscreen: true, bounds: at(10, 64, 200, 20) },
          { role: "ListItem", name: "Parma", offscreen: true, bounds: at(10, 84, 200, 20) },
        ] },
      ],
    }]);
    const r = await read(call);
    expect(r.nodes.find(n => n.role === "combo box")?.selected).toBe("Paris");
  });
});

describe("names that say what a secret field the read didn't list holds (review #2)", () => {
  // Chromium names a table's cell, a row or a section after the values of the fields in it. A field scrolled out of
  // view, or past where the read stopped, isn't listed, but what holds it may be (partly in view): its name must not
  // carry the field's value to the model. The host's twin of the Python sidecar's PERC9-1 and PERC9-3 cases.
  const web = (children: FakeElementSpec[]): FakeElementSpec => ({ role: "Document", name: "Checkout", framework: "Chrome", bounds: at(0, 0, 600, 300), children });
  const field = (name: string, value: string | undefined, b: ReturnType<typeof at>, more: Partial<FakeElementSpec> = {}): FakeElementSpec =>
    ({ role: "Edit", name, ...(value !== undefined ? { value } : {}), editable: true, bounds: b, ...more });
  const checkout = (cardValue: string | undefined): FakeElementSpec[] => [web([
    { role: "DataItem", name: "Ship to Ada", bounds: at(10, 40, 280, 24), children: [
      { role: "Text", name: "Ship to", bounds: at(12, 42, 50, 16) }, field("Name", "Ada", at(70, 42, 100, 18))] },
    { role: "Button", name: "Pay now", bounds: at(10, 70, 60, 20) },
    { role: "DataItem", name: "PIN 10010", bounds: at(10, 100, 380, 24), children: [
      { role: "Text", name: "PIN", bounds: at(12, 102, 40, 16) }, field("PIN", "10010", at(60, 100, 60, 20))] },
    // Partly in view at the bottom: its label shows, its field is scrolled out.
    { role: "Group", name: "Card number 4111 1111 1111 1111", bounds: at(10, 270, 280, 46), children: [
      { role: "Text", name: "Card number", bounds: at(12, 272, 90, 16) }, field("Card number", cardValue, at(12, 296, 260, 20), { offscreen: true })] },
    { role: "Group", name: "Notes Leave at the door", bounds: at(300, 270, 280, 46), children: [
      { role: "Text", name: "Notes", bounds: at(302, 272, 60, 16) }, field("Delivery notes", "Leave at the door", at(302, 296, 260, 20), { offscreen: true })] },
  ])];

  it("withholds the name of what holds a secret field scrolled out of view, and nothing else", async () => {
    const { call } = harness(checkout("4111 1111 1111 1111"));
    const r = await read(call);
    expect(JSON.stringify(r)).not.toContain("4111");
    expect(r.nodes.filter(n => ["section", "table cell", "push button"].includes(n.role)).map(n => [n.role, n.name])).toEqual([
      ["table cell", "Ship to Ada"], ["push button", "Pay now"], ["table cell", ""], ["section", ""], ["section", "Notes Leave at the door"]]);
    const held = r.nodes.find(n => n.role === "section" && n.withheld)!;
    expect(r.withheldKeys.length).toBeGreaterThanOrEqual(2);
    // Withheld for good: looked at on its own later, it still has no name.
    expect((await call<{ name: string }>("read_element", { id: held.id })).name).toBe("");
  });

  it("withholds such a name when the field's value can't be told, if the name says something like a value that nothing in it says", async () => {
    const { call } = harness(checkout(undefined));
    const r = await read(call);
    expect(JSON.stringify(r)).not.toContain("4111");
    expect(r.nodes.find(n => n.role === "section" && n.withheld)).toBeTruthy();
    expect(r.nodes.find(n => n.name === "Notes Leave at the door")).toBeTruthy();
  });

  it("withholds the name of what holds a secret field that comes after where the read stopped", async () => {
    const filler = Array.from({ length: 6 }, (_, i): FakeElementSpec => ({ role: "Hyperlink", name: `Link ${i}`, bounds: at(10, 10 + 12 * i, 60, 10) }));
    const { call } = harness([web([...filler,
      { role: "DataItem", name: "Card number 4111 1111 1111 1111", bounds: at(300, 200, 280, 40), children: [
        field("Card number", "4111 1111 1111 1111", at(300, 210, 200, 24))] },
    ])]);
    // The window, the page, six links and the cell: the field would be the tenth.
    const r = await call<Read>("read_window", { pid: 30, maxNodes: 9 });
    expect(r.cut).toContain("nodes");
    expect(r.nodes.at(-1)).toMatchObject({ role: "table cell", name: "", withheld: true });
    expect(JSON.stringify(r)).not.toContain("4111");
  });

  it("withholds names that say something like a value where the read stopped and the page went on unread", async () => {
    // Unnamed groups the read doesn't list take up the snapshot (4 elements a listed one): it ends at the cell.
    const nest = (depth: number, inner: FakeElementSpec): FakeElementSpec =>
      depth ? { role: "Group", bounds: at(0, 0, 600, 300), children: [nest(depth - 1, inner)] } : inner;
    const cell = (name: string): FakeElementSpec => ({ role: "DataItem", name, bounds: at(300, 200, 280, 40), children: [
      field("Card number", "4111 1111 1111 1111", at(300, 210, 200, 24))] });
    for (const [name, kept] of [["Card number 4111 1111 1111 1111", false], ["Payment details", true]] as const) {
      const { call } = harness([web([nest(9, cell(name))])]);
      const r = await call<Read>("read_window", { pid: 30, maxNodes: 3 });
      expect(r.truncated).toBe(true);
      expect(r.nodes.at(-1)!.name, name).toBe(kept ? name : "");
    }
  });

  it("leaves names alone outside a web page, and when the field isn't secret", async () => {
    const { call } = harness([{ role: "Group", name: "Order 4111 1111", bounds: at(10, 270, 280, 46), children: [
      field("Reference", "4111 1111", at(12, 296, 260, 20), { offscreen: true })] }]);
    const r = await read(call);
    expect(r.nodes.find(n => n.name === "Order 4111 1111")).toBeTruthy();
  });
});

describe("a page the browser hasn't handed over yet (review #6)", () => {
  // A very big page, or the first read after a Chromium app turns accessibility on: its document shows with neither
  // contents nor size until the browser has built its tree.
  const browser = (doc: FakeElementSpec): FakeElementSpec[] => [
    { role: "MenuBar", name: "", bounds: at(0, 0, 800, 24), children: [{ role: "MenuItem", name: "File", bounds: at(0, 0, 40, 24) }] },
    doc,
  ];

  it("says the read is still loading, and the secret-field scan that it can't check the page yet", async () => {
    const { call } = harness(browser({ role: "Document", name: "Big page", framework: "Chrome", bounds: at(0, 30, 0, 0) }));
    const r = await read(call);
    expect(r.truncated).toBe(true);
    expect(r.cut).toContain("loading");
    const scan = await call<{ complete: boolean; busy?: boolean }>("secret_fields", { pid: 30, path: r.window!.path });
    expect(scan).toMatchObject({ complete: false, busy: true });
  });

  it("reads a page with its size, or with anything in it, as before", async () => {
    for (const doc of [
      { role: "Document", name: "Blank", framework: "Chrome", bounds: at(0, 30, 800, 570) },
      { role: "Document", name: "Tiny", framework: "Chrome", bounds: at(0, 30, 0, 0), children: [{ role: "Hyperlink", name: "Home", bounds: at(10, 40, 40, 16) }] },
    ] as FakeElementSpec[]) {
      const { call } = harness(browser(doc));
      const r = await read(call);
      expect(r.cut ?? [], doc.name).not.toContain("loading");
      expect((await call<{ complete: boolean }>("secret_fields", { pid: 30, path: r.window!.path })).complete, doc.name).toBe(true);
    }
  });
});
