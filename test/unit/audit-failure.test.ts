/**
 * The audit log when it can't be written (review #117). A folder removed while Ember runs (a clean-up tool) is made
 * again, so writing works without a restart; a write that still fails throws (callers that must not act unrecorded
 * rely on it), still reaches the journal, and is reported once per run of failures. In a worker, a step already taken
 * whose record fails is reported as it went (an error would have the model try a "Send" again), and nothing more is
 * done: the task stops with a plain sentence; a step whose record fails before it is taken isn't taken.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog, afterTheStep } from "../../app/main/policy/audit";
import { Worker, type WorkerDeps } from "../../app/main/agent/worker";
import { Presenter } from "../../app/main/agent/presenter";
import { PolicyEngine } from "../../app/main/policy/policy";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ember-audit-fail-"));

describe("AuditLog when it can't write (review #117)", () => {
  it("makes a removed audit folder again and goes on writing (no restart needed)", () => {
    const root = tmp();
    const dir = path.join(root, "audit");
    const log = new AuditLog(dir, () => new Date("2026-10-15T10:00:00Z"));
    log.write({ event: "decision", task: "t1" });
    fs.rmSync(dir, { recursive: true });
    expect(() => log.write({ event: "action", task: "t1", ok: true })).not.toThrow();
    expect(fs.readFileSync(log.file, "utf8").trim().split("\n")).toHaveLength(1);
    if (process.platform !== "win32") expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("throws when the file can't be written, sends the line to the journal anyway, and reports it once per run of failures", () => {
    const dir = tmp();
    const sunk: string[] = [];
    const errors: unknown[] = [];
    const log = new AuditLog(dir, () => new Date("2026-10-15T10:00:00Z"), l => sunk.push(l), err => errors.push(err));
    // The month's file is a folder now (as in the review's run): every append fails with EISDIR.
    fs.mkdirSync(log.file);
    expect(() => log.write({ event: "decision", task: "t1" })).toThrow();
    expect(() => log.write({ event: "decision", task: "t2" })).toThrow();
    expect(sunk.map(l => JSON.parse(l).task)).toEqual(["t1", "t2"]);
    expect(errors).toHaveLength(1);
    // Writing works again: then a new failure is reported again.
    fs.rmdirSync(log.file);
    log.write({ event: "decision", task: "t3" });
    expect(errors).toHaveLength(1);
    fs.rmSync(log.file);
    fs.mkdirSync(log.file);
    expect(() => log.write({ event: "decision", task: "t4" })).toThrow();
    expect(errors).toHaveLength(2);
  });

  it("tells entries written after their step (an action, a command that started or ended) from those before it", () => {
    expect(afterTheStep({ event: "action", ok: true })).toBe(true);
    expect(afterTheStep({ event: "command", phase: "started" })).toBe(true);
    expect(afterTheStep({ event: "command", phase: "ended" })).toBe(true);
    expect(afterTheStep({ event: "command", phase: "tainted" })).toBe(true);
    expect(afterTheStep({ event: "command", phase: "cd" })).toBe(true);
    expect(afterTheStep({ event: "decision", verdict: "allow" })).toBe(false);
    expect(afterTheStep({ event: "confirm", answer: "once" })).toBe(false);
    expect(afterTheStep({ event: "command", phase: "decided" })).toBe(false);
    expect(afterTheStep({ event: "command", phase: "answered" })).toBe(false);
  });
});

/** A worker on a gedit window whose audit log fails for the entries `fails` picks. */
function makeWorker(fails: (e: Record<string, unknown>) => boolean) {
  const audit: Record<string, unknown>[] = [];
  const events: string[] = [];
  const window = { app: "gedit", pid: 1, name: "notes.txt", role: "frame", active: true, bounds: { x: 0, y: 0, width: 800, height: 600 } };
  const node = { id: 1, parent: null, depth: 1, role: "push button", name: "Send", states: ["enabled", "sensitive"], bounds: { x: 10, y: 10, width: 40, height: 20 } };
  const seen = { window, x11Window: null, nodes: [node], blocked: false, ms: 0 };
  const w = new Worker({
    client: {} as never, log: quiet, model: "m", vision: false, workDir: "/tmp",
    perception: { perceive: async () => ({ ...seen, text: "[1] push button \"Send\"", capture: null }), read: async () => seen, windows: async () => [window] } as never,
    sidecar: {
      readElement: async () => ({ role: node.role, name: node.name, states: node.states, bounds: node.bounds }),
      doAction: async () => { events.push("clicked"); return { ok: true, after: { role: "push button", name: "Send", states: [], bounds: node.bounds } }; },
    } as never,
    policy: new PolicyEngine({ neverLook: () => [], grants: () => ({ gedit: "act" }) }),
    confirmer: { ask: async () => "once" } as never,
    audit: {
      write: (e: Record<string, unknown>) => {
        if (fails(e)) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
        audit.push(e);
      },
    } as never,
    settings: { get: () => ({ grants: {} }), update: () => undefined } as never,
    presenter: new Presenter(() => undefined),
    lease: async () => () => undefined, flyTo: () => undefined, onProgress: () => undefined,
  } as unknown as WorkerDeps, { id: "t1", goal: "press Send", userWords: "press Send", target: { title: "notes.txt" } });
  const call = (name: string, args: Record<string, unknown>) => w.tools().find(t => t.name === name)!.handler!(args, {} as never) as Promise<{ textResultForLlm: string; resultType: string }>;
  const halt = () => w as unknown as { halted: boolean; haltReason: string | null };
  return { w, call, events, audit, halt };
}

describe("a worker whose audit log fails (review #117)", () => {
  it("a step already taken is reported as done, not as an error to retry, and the task stops with a plain sentence", async () => {
    const { call, events, halt } = makeWorker(e => e.event === "action");
    await call("perceive_window", {});
    const r = await call("click", { id: 1 });
    expect(events).toEqual(["clicked"]);
    expect(r.resultType).toBe("success");
    expect(r.textResultForLlm).toMatch(/^Done/);
    expect(halt().halted).toBe(true);
    expect(halt().haltReason).toMatch(/audit log/);
    // Nothing more is done.
    const again = await call("click", { id: 1 });
    expect(again.textResultForLlm).toMatch(/^Stopped/);
    expect(events).toEqual(["clicked"]);
  });

  it("a step whose record can't be written before it is taken isn't taken, and the task stops", async () => {
    const { call, events, halt } = makeWorker(e => e.event === "decision");
    await call("perceive_window", {});
    await expect(call("click", { id: 1 })).rejects.toThrow();
    expect(events).toEqual([]);
    expect(halt().halted).toBe(true);
    expect(halt().haltReason).toMatch(/audit log/);
  });
});
