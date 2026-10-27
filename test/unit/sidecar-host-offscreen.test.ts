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
