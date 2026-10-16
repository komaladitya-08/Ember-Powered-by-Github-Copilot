/**
 * A worker's tools called directly (no model): one at a time, and every
 * refusal is in the audit log.
 */

import { describe, expect, it } from "vitest";
import { Worker, clearLane, pickOption, type WorkerDeps } from "../../app/main/agent/worker";
import { Presenter } from "../../app/main/agent/presenter";
import { PolicyEngine } from "../../app/main/policy/policy";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function makeWorker(o: { blocked?: boolean; busy?: boolean } = {}) {
  const audit: Record<string, unknown>[] = [];
  const events: string[] = [];
  const window = { app: "gedit", pid: 1, name: "notes.txt", role: "frame", active: true, bounds: { x: 0, y: 0, width: 800, height: 600 }, ...(o.busy ? { busy: true } : {}) };
  const node = { id: 1, parent: null, depth: 1, role: "push button", name: "Bold", states: ["enabled", "sensitive"], bounds: { x: 10, y: 10, width: 40, height: 20 } };
  const seen = { window, x11Window: null, nodes: [node], blocked: !!o.blocked, ms: 0 };
  const w = new Worker({
    client: {} as never, log: quiet, model: "m", vision: false, workDir: "/tmp",
    perception: { perceive: async () => ({ ...seen, text: "[1] push button \"Bold\"", capture: null }), read: async () => seen, windows: async () => [window] } as never,
    sidecar: {
      readElement: async () => ({ role: "push button", name: "Bold", states: ["enabled", "sensitive"], bounds: node.bounds }),
      doAction: async () => { events.push("start"); await sleep(80); events.push("end"); return { ok: true, after: { role: "push button", name: "Bold", states: [], bounds: node.bounds } }; },
    } as never,
    policy: new PolicyEngine({ neverLook: () => [], grants: () => ({ gedit: "act" }) }),
    confirmer: { ask: async () => "once" } as never,
    audit: { write: (e: Record<string, unknown>) => audit.push(e) } as never,
    settings: { get: () => ({ grants: {} }), update: () => undefined } as never,
    presenter: new Presenter(() => undefined),
    lease: async () => () => undefined, flyTo: () => undefined, onProgress: () => undefined,
    cursor: { borrow: {} as never, findWindow: () => 1, setBorrowing: () => undefined },
  } as unknown as WorkerDeps, { id: "t1", goal: "make it bold", target: { title: "notes.txt" } });
  const tool = (name: string) => w.tools().find(t => t.name === name)!;
  const call = (name: string, args: Record<string, unknown>) => tool(name).handler!(args, {} as never) as Promise<{ textResultForLlm: string; resultType: string }>;
  return { w, audit, events, call };
}

describe("worker tools", () => {
  it("run one at a time when the runtime calls several at once", async () => {
    const { call, events } = makeWorker();
    await call("perceive_window", {});
    const results = await Promise.all([call("click", { id: 1 }), call("click", { id: 1 }), call("report_progress", { text: "bolding" })]);
    expect(results.map(r => r.resultType)).toEqual(["success", "success", "success"]);
    expect(events).toEqual(["start", "end", "start", "end"]);
  });

  it("an option is chosen by its whole name (case and spacing aside), never by a part of it", () => {
    const options = ["Keep", "Delete permanently", "delete  permanently ", "Move to Trash"];
    expect(pickOption(options, "permanently")).toBeNull();
    expect(pickOption(options, "Keep")).toBe("Keep");
    expect(pickOption(options, " move to trash")).toBe("Move to Trash");
    // Two names that differ only in case or spacing: the exact one, or none.
    expect(pickOption(options, "Delete permanently")).toBe("Delete permanently");
    expect(pickOption(options, "DELETE PERMANENTLY")).toBeNull();
  });

  it("a busy app's window is listed as busy, not gone", async () => {
    const { call } = makeWorker({ busy: true });
    expect((await call("list_windows", {})).textResultForLlm).toContain('- "gedit": "notes.txt" (focused by the user) (busy, not answering)');
  });

  it("a key press refused in a private window is in the audit log", async () => {
    const { call, audit } = makeWorker({ blocked: true });
    const r = await call("press_keys", { keys: "Return" });
    expect(r.resultType).toBe("denied");
    expect(audit).toContainEqual(expect.objectContaining({ event: "decision", kind: "keys", verdict: "deny", tier: "never", value: "Return" }));
  });
});

describe("where the wheel goes (review round 4)", () => {
  const list = { x: 0, y: 0, width: 400, height: 300 };
  it("the widest lane across the list that no wheel-changed control touches, inside the window", () => {
    // Rows with a label column (0–150) and a combo box or spin button filling the rest.
    expect(clearLane(list, [{ x: 156, y: 40, width: 244, height: 30 }, { x: 156, y: 900, width: 244, height: 30 }], true, list)).toBe(78);
    // Sideways, a row no control spans.
    expect(clearLane(list, [{ x: 0, y: 0, width: 400, height: 100 }], false, list)).toBe(200);
    // The window cuts the list: only its visible part counts.
    expect(clearLane(list, [{ x: 0, y: 0, width: 200, height: 20 }], true, { x: 0, y: 0, width: 300, height: 300 })).toBe(250);
  });
  it("none when controls cover every column", () => {
    expect(clearLane(list, [{ x: 0, y: 40, width: 220, height: 30 }, { x: 200, y: 400, width: 200, height: 30 }], true, list)).toBeNull();
  });
});
