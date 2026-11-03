/**
 * A task that closes its own window on Windows and macOS (the owner's report of 2026-11-03: "close Microsoft Edge"):
 * the accessibility host, over UI Automation's model (the fake provider), says the Close click worked and left nothing to
 * read back, and every later read of that window, by the key the worker holds (process and window key), finds nothing,
 * promptly and not as busy: never another window of the same app that is there now, which a task could act on.
 */

import { describe, expect, it } from "vitest";
import { Host } from "../../app/sidecar-host/host";
import { FakeProvider, type FakeWindowSpec } from "../../app/sidecar-host/providers/fake";
import type { ActionResult, ReadWindowResult } from "../../app/main/perception/sidecar";

const at = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const PID = 40;

/** Two Edge windows of one process; the user is in the first, whose Close button closes it. */
function edge(): FakeWindowSpec[] {
  return [
    { role: "Window", name: "News - Microsoft Edge", pid: PID, app: "msedge", native: 0x400, active: true, bounds: at(0, 0, 1000, 700), children: [
      { role: "Button", name: "Close", bounds: at(960, 0, 40, 30), actions: ["invoke", "focus"], onInvoke: "closeWindow" },
    ] },
    { role: "Window", name: "Mail - Microsoft Edge", pid: PID, app: "msedge", native: 0x500, bounds: at(100, 100, 1000, 700), children: [
      { role: "Button", name: "Close", bounds: at(1060, 100, 40, 30), actions: ["invoke", "focus"], onInvoke: "closeWindow" },
    ] },
  ];
}

function harness() {
  const fake = new FakeProvider(edge(), { deadlineMs: 300 });
  const host = new Host(fake, { env: { EMBER_ATSPI_ID_BASE: "10000000" }, settleMs: 0 });
  let n = 1;
  const call = async <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const msg = JSON.parse((await host.handle(JSON.stringify({ jsonrpc: "2.0", id: n++, method, params })))!);
    if (msg.error) throw new Error(msg.error.message);
    return msg.result as T;
  };
  return { fake, call };
}

describe("a window that closes under the task's own click (Windows and macOS host)", () => {
  it("reports the click done with nothing to read back, then finds nothing at that window's key", async () => {
    const { fake, call } = harness();
    const first = await call<ReadWindowResult>("read_window", { title: "News - Microsoft Edge" });
    expect(first.window).toMatchObject({ name: "News - Microsoft Edge", pid: PID });
    // What the worker keeps after a read (worker.ts perceive): the window's own key.
    const target = { pid: PID, title: first.window!.name, path: first.window!.path };
    expect(target.path).toBeTruthy();
    const close = first.nodes.find(x => x.name === "Close")!;
    const r = await call<ActionResult>("do_action", { id: close.id, action: "click" });
    expect(r.ok).toBe(true);
    expect(r.after ?? null).toBeNull();
    expect(r.busy ?? false).toBe(false);
    expect(fake.log).toEqual([{ op: "invoke", name: "Close", role: "Button" }]);

    const t0 = Date.now();
    const again = await call<ReadWindowResult>("read_window", target);
    expect(Date.now() - t0).toBeLessThan(1000);
    // Gone, not busy, and never the other Edge window of the same process that is there now.
    expect(again).toMatchObject({ window: null, nodes: [] });
    expect(again.busy ?? false).toBe(false);
    // Its element is gone too: a click on it does nothing anywhere.
    await expect(call("do_action", { id: close.id, action: "click" })).rejects.toThrow(/gone/);
    expect(fake.log).toHaveLength(1);
  });
});
