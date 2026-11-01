/**
 * The task queue when the audit log can't be written (a full disk, an exhausted quota, a root-owned audit file): the
 * record failing never breaks the bookkeeping. A task the user asked for gets its card and starts (it isn't left in
 * the queue to run later), and a task that ends while writes fail still ends on screen, is reported, lets go of its
 * worker and lets the queued tasks start (review #79).
 */

import { describe, expect, it, vi } from "vitest";
import { TaskManager, type WorkerLike } from "../../app/main/agent/tasks";
import type { WorkerResult } from "../../app/main/agent/worker";
import type { TaskCard } from "../../app/shared/overlay";
import type { Logger } from "../../app/main/logger";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function setup(o: { failing: () => boolean; maxRunning?: number; run?: () => Promise<WorkerResult> }) {
  const cards: TaskCard[][] = [];
  const warned: string[] = [];
  const finished: string[] = [];
  const disposed: string[] = [];
  const written: Record<string, unknown>[] = [];
  const log = { debug() {}, info() {}, warn(m: string) { warned.push(m); }, error() {}, child() { return log; } } as unknown as Logger;
  const audit = {
    write: (e: Record<string, unknown>) => {
      if (o.failing()) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
      written.push(e);
    },
  };
  let n = 0;
  const tm = new TaskManager({
    log, currentWindow: () => ({ title: "notes.txt", pid: 7 }), setCards: c => cards.push(c), deleteSession: async () => undefined,
    audit: audit as never, keepMs: 0, maxRunning: o.maxRunning ?? 2, onFinished: t => finished.push(t.id),
    makeWorker: () => {
      const id = `w${++n}`;
      return { run: o.run ?? (async () => ({ success: true, summary: "All done." })), steer: async () => false, dispose: async () => { disposed.push(id); }, sessionId: null } satisfies WorkerLike;
    },
  });
  return { tm, cards, warned, finished, disposed, written };
}

describe("TaskManager when the audit log can't be written (review #79)", () => {
  it("a task asked for while writes fail gets its card and starts, instead of waiting in the queue unseen", async () => {
    const { tm, cards, warned } = setup({ failing: () => true });
    let task: ReturnType<TaskManager["start"]> | undefined;
    expect(() => { task = tm.start("Do the thing"); }).not.toThrow();
    expect(cards.at(-1)?.map(c => c.title)).toEqual(["Do the thing"]);
    await vi.waitFor(() => expect(tm.get(task!.id)?.status).toBe("done"));
    expect(cards.at(-1)?.[0]).toMatchObject({ status: "done", detail: "All done." });
    expect(warned).toContain("task.audit_failed");
  });

  it("a later task never brings back one whose start failed (nothing is left queued)", async () => {
    let failing = true;
    const { tm } = setup({ failing: () => failing });
    const a = tm.start("Job A");
    await vi.waitFor(() => expect(tm.get(a.id)?.status).toBe("done"));
    failing = false;
    const b = tm.start("Job B");
    await vi.waitFor(() => expect(tm.get(b.id)?.status).toBe("done"));
    expect(tm.list().map(t => `${t.title}:${t.status}`)).toEqual(["Job A:done", "Job B:done"]);
  });

  it("tasks that end while writes fail leave “Working…”, are told, let go of their workers and start the queued ones", async () => {
    let failing = false;
    const gates = [deferred<WorkerResult>(), deferred<WorkerResult>(), deferred<WorkerResult>()];
    let i = 0;
    const { tm, cards, finished, disposed } = setup({ failing: () => failing, run: () => gates[i++].promise });
    const one = tm.start("Job number 1"), two = tm.start("Job number 2"), three = tm.start("Job number 3");
    await vi.waitFor(() => expect([one, two, three].map(t => tm.get(t.id)!.status)).toEqual(["running", "running", "queued"]));
    failing = true;
    gates[0].resolve({ success: true, summary: "First." });
    gates[1].resolve({ success: true, summary: "Second." });
    await vi.waitFor(() => expect(tm.get(three.id)!.status).toBe("running"));
    gates[2].resolve({ success: true, summary: "Third." });
    await vi.waitFor(() => expect(tm.get(three.id)!.status).toBe("done"));
    expect(cards.at(-1)?.map(c => `${c.title}:${c.status}`)).toEqual(["Job number 1:done", "Job number 2:done", "Job number 3:done"]);
    expect(finished).toEqual([one.id, two.id, three.id]);
    await vi.waitFor(() => expect(disposed).toEqual(["w1", "w2", "w3"]));
    expect(tm.takeReports().map(t => t.id)).toEqual([one.id, two.id, three.id]);
  });

  it("a listener that throws when a task ends doesn't keep its worker or the queue (run never rejects)", async () => {
    const disposed: string[] = [];
    const errors: string[] = [];
    const log = { debug() {}, info() {}, warn() {}, error(m: string) { errors.push(m); }, child() { return log; } } as unknown as Logger;
    let n = 0;
    const tm = new TaskManager({
      log, currentWindow: () => null, setCards: () => undefined, deleteSession: async () => undefined, keepMs: 0, maxRunning: 1,
      onFinished: () => { throw new Error("listener broke"); },
      makeWorker: () => { const id = `w${++n}`; return { run: async () => ({ success: true, summary: "ok" }), steer: async () => false, dispose: async () => { disposed.push(id); }, sessionId: null }; },
    });
    const a = tm.start("a"), b = tm.start("b");
    await vi.waitFor(() => expect(tm.get(b.id)?.status).toBe("done"));
    expect(tm.get(a.id)?.status).toBe("done");
    await vi.waitFor(() => expect(disposed).toEqual(["w1", "w2"]));
  });

  it("the record is still written when it can be: the request and the outcome", async () => {
    const { tm, written } = setup({ failing: () => false });
    const t = tm.start("Do the thing");
    await vi.waitFor(() => expect(tm.get(t.id)?.status).toBe("done"));
    expect(written.map(e => e.phase)).toEqual(["asked", "done"]);
    expect(written[1]).toMatchObject({ event: "task", task: t.id, goal: "Do the thing", summary: "All done." });
  });
});
