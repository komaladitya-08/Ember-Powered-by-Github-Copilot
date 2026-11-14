/**
 * The read probe's stages in the accessibility host (cifix-x9-10): on Windows the app the Ask box opened over took the
 * foreground back while Ember's read of it ran, and not with the read off, so the Windows suite opens the box once per
 * stage left out (EMBER_TEST_ASK_READ=skip:<stage>, development only) to find which part of the read does it. Each
 * stage left out only reads less and gives back less: "looks" gives back nothing, since no field is then redacted.
 */

import { describe, expect, it, vi } from "vitest";
import { Host } from "../../app/sidecar-host/host";
import { FakeProvider, type FakeWindowSpec } from "../../app/sidecar-host/providers/fake";
import type { ReadWindowResult } from "../../app/main/perception/sidecar";

const at = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const PID = 30;
const BENCH: FakeWindowSpec[] = [{
  role: "Window", name: "Ember Bench (Windows)", pid: PID, app: "EmberBench", bounds: at(0, 0, 800, 600), native: 0x40, children: [
    { role: "Edit", name: "Name", native: 0x41, editable: true, focusable: true, value: "q", bounds: at(10, 10, 300, 24) },
    { role: "Edit", name: "Password", native: 0x42, password: true, editable: true, focusable: true, bounds: at(10, 40, 300, 24) },
    { role: "Document", name: "Notes", editable: true, multiLine: true, value: "a long note", text: "a long note, with more of it than its value says", focused: true, bounds: at(10, 70, 300, 200) },
  ],
}];

function harness() {
  const fake = new FakeProvider(BENCH);
  const host = new Host(fake, { env: { EMBER_ATSPI_ID_BASE: "10000000" }, settleMs: 0 });
  let n = 1;
  const read = async (params: Record<string, unknown> = {}): Promise<ReadWindowResult & { secretKeys?: unknown[] }> => {
    const msg = JSON.parse((await host.handle(JSON.stringify({ jsonrpc: "2.0", id: n++, method: "read_window", params: { pid: PID, title: "Ember Bench (Windows)", ...params } })))!);
    if (msg.error) throw new Error(msg.error.message);
    return msg.result;
  };
  return { fake, read };
}

describe("the host's read with a probe's stage left out (cifix-x9-10)", () => {
  it("reads the window whole without a stage named, as always", async () => {
    const h = harness();
    const snapshot = vi.spyOn(h.fake, "snapshot");
    const r = await h.read();
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(r.window?.name).toBe("Ember Bench (Windows)");
    expect(r.nodes.map(n => n.name)).toContain("Name");
  });

  it("finds the window and walks nothing of it for \"lookup\"", async () => {
    const h = harness();
    const snapshot = vi.spyOn(h.fake, "snapshot");
    const r = await h.read({ probeSkip: "lookup" });
    expect(snapshot).not.toHaveBeenCalled();
    expect(r.window?.name).toBe("Ember Bench (Windows)");
    expect(r.nodes).toEqual([]);
  });

  it("walks the tree but reads no field's text for \"texts\"", async () => {
    const h = harness();
    const texts = vi.spyOn(h.fake, "textInfo");
    const whole = harness();
    const wholeTexts = vi.spyOn(whole.fake, "textInfo");
    await whole.read();
    const r = await h.read({ probeSkip: "texts" });
    expect(wholeTexts.mock.calls.length).toBeGreaterThan(0);
    expect(texts).not.toHaveBeenCalled();
    expect(r.nodes.map(n => n.name)).toContain("Name");
  });

  it("gives back nothing at all for \"looks\", so no field goes unredacted", async () => {
    const r = await harness().read({ probeSkip: "looks" });
    expect(r.nodes).toEqual([]);
    expect(r.secretKeys).toEqual([]);
  });

  it("reads the window whole for a stage it doesn't know", async () => {
    const r = await harness().read({ probeSkip: "everything" });
    expect(r.nodes.map(n => n.name)).toContain("Name");
  });
});
