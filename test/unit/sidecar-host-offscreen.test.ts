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

  it("is handed only the first 50 of a long level's offscreen children, as the bridge reads one, with the rest cut \"offscreen\"", async () => {
    // A Win32 list's rows answer each property with a message to the app: the bridge reads a long level's offscreen
    // rows slim and lists 50 of them (PROTOCOL.md, snapshot).
    const { fake } = harness([page([...above(3000), ...visible(25)])]);
    const snap = await fake.snapshot((await fake.topWindows())[0]!.handle, { maxDepth: 64, maxNodes: 1600, deadlineMs: 2000 });
    expect(snap.nodes.filter(n => n.name?.startsWith("Visible link"))).toHaveLength(25);
    expect(snap.nodes.filter(n => n.name?.startsWith("Old link"))).toHaveLength(50);
    expect(snap.cut).toEqual(["offscreen"]);
    // AX has no such limit.
    const ax = harness([page([...above(3000), ...visible(25)])], {}, "ax").fake;
    const all = await ax.snapshot((await ax.topWindows())[0]!.handle, { maxDepth: 64, maxNodes: 4000, deadlineMs: 2000 });
    expect(all.nodes.filter(n => n.name?.startsWith("Old link"))).toHaveLength(3000);
  });

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

  it("withholds such a name when the snapshot left the field out as offscreen past its limit, with nothing after it that shows", async () => {
    // A checkout page scrolled so the card's row sits at the bottom edge: everything after it in the page is out of
    // view. The window, the page, 1596 unnamed groups, the cell and its label fill the snapshot (1600 elements); the
    // bridge then leaves the offscreen field out as "offscreen", not "nodes", and the read ends on the cell.
    const groups = (n: number): FakeElementSpec[] => Array.from({ length: n }, (_, i) => ({ role: "Group", name: "", bounds: at(1 + (i % 700), 40 + (i % 20), 2, 2) }));
    const cell = (): FakeElementSpec => ({ role: "DataItem", name: "Card number 4111 1111 1111 1111", bounds: at(10, 560, 400, 80), children: [
      { role: "Text", name: "Card number", bounds: at(10, 562, 100, 16) },
      field("Card number", "4111 1111 1111 1111", at(10, 610, 200, 24), { offscreen: true })] });
    const page = (children: FakeElementSpec[]): FakeElementSpec => ({ role: "Document", name: "Checkout", framework: "Chrome", bounds: at(0, 30, 800, 570), children });
    for (const [what, children] of [
      ["the field cut as offscreen", [...groups(1596), cell()]],
      ["a link that shows after it (cut nodes)", [...groups(1596), cell(), { role: "Hyperlink", name: "Help", bounds: at(500, 40, 40, 16) }]],
      ["a page under the limit", [...groups(100), cell()]],
    ] as const) {
      const { call } = harness([page([...children])]);
      const r = await read(call);
      expect(JSON.stringify(r.nodes), what).not.toContain("4111");
      expect(r.nodes.find(n => n.role === "table cell"), what).toMatchObject({ name: "", withheld: true });
    }
    // Nothing that shows is missing, so the read still says nothing was cut.
    const { call } = harness([page([...groups(1596), cell()])]);
    expect((await read(call)).truncated).toBe(false);
  });

  it("judges an unnamed field it doesn't list by the label the read lists beside or above it", async () => {
    // The field has no name of its own: the text just above it, which shows, says what it holds (secret_by_labels).
    const cell = (label: string, name: string, value: string | undefined): FakeElementSpec => ({ role: "DataItem", name, bounds: at(10, 540, 400, 80), children: [
      { role: "Text", name: label, bounds: at(10, 562, 100, 16) },
      field("", value, at(10, 584, 200, 24), { offscreen: true })] });
    const page = (c: FakeElementSpec) => [web([{ role: "Hyperlink", name: "Help", bounds: at(500, 40, 40, 16) }, c])];
    const known = harness(page(cell("Card number", "Card number 4111 1111 1111 1111", "4111 1111 1111 1111")));
    const r = await read(known.call);
    expect(JSON.stringify(r.nodes)).not.toContain("4111");
    const held = r.nodes.find(n => n.role === "table cell")!;
    expect(held).toMatchObject({ name: "", withheld: true });
    expect((await known.call<{ name: string }>("read_element", { id: held.id })).name).toBe("");
    // Its value is remembered: a name that says it later, elsewhere in the app, is withheld too.
    expect(known.host.secrets.saysSecret("Pay with 4111 1111 1111 1111", 30)).toBe(true);
    // Beside it on its row, as well as above it.
    const beside: FakeElementSpec = { role: "DataItem", name: "PIN 4821", bounds: at(10, 560, 400, 30), children: [
      { role: "Text", name: "PIN", bounds: at(10, 566, 40, 16) }, field("", "4821", at(60, 562, 80, 24), { offscreen: true })] };
    expect(JSON.stringify((await read(harness(page(beside)).call)).nodes)).not.toContain("4821");
    // What it holds can't be told (macOS reads no offscreen values): a name that says something like a value is withheld.
    const unknown = await read(harness(page(cell("Card number", "Card number 4111 1111 1111 1111", undefined))).call);
    expect(JSON.stringify(unknown.nodes)).not.toContain("4111");
    // A plain label leaves the name alone.
    const plain = await read(harness(page(cell("Ship to", "Ship to Ada 12 Main Street", "Ada 12 Main Street"))).call);
    expect(plain.nodes.find(n => n.role === "table cell")?.name).toBe("Ship to Ada 12 Main Street");
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
