/**
 * A worker's tools called directly (no model): one at a time, and every
 * refusal is in the audit log.
 */

import { describe, expect, it } from "vitest";
import { Worker, type WorkerDeps } from "../../app/main/agent/worker";
import { Presenter } from "../../app/main/agent/presenter";
import { PolicyEngine } from "../../app/main/policy/policy";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function makeWorker(o: { blocked?: boolean } = {}) {
  const audit: Record<string, unknown>[] = [];
  const events: string[] = [];
  const window = { app: "gedit", pid: 1, name: "notes.txt", role: "frame", active: true, bounds: { x: 0, y: 0, width: 800, height: 600 } };
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

  it("a key press refused in a private window is in the audit log", async () => {
    const { call, audit } = makeWorker({ blocked: true });
    const r = await call("press_keys", { keys: "Return" });
    expect(r.resultType).toBe("denied");
    expect(audit).toContainEqual(expect.objectContaining({ event: "decision", kind: "keys", verdict: "deny", tier: "never", value: "Return" }));
  });
});
