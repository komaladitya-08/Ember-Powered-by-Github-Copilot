/** Lifecycle regressions with a host workspace factory; no SDK process or native command starts in these cases. */
import { expect, it, vi } from "vitest";
import { ScopedCodingWorker, type ScopedCodingWorkerOptions } from "../../app/main/agent/scoped-coding-worker";
import type { IsolatedCommandWorkspace } from "../../app/main/agent/isolated-command-workspace";
import type { CommandService } from "../../app/main/commands/types";
import type { TaskSpec } from "../../app/main/agent/worker";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const backend = { stop: vi.fn(async () => undefined), close: vi.fn(async () => undefined), exportReview: vi.fn(async () => { throw new Error("No initialized controller result"); }) };
  const beforeStart = vi.fn(async () => undefined), createWorkspace = vi.fn(async (_signal: AbortSignal, _admit: () => boolean) => backend as unknown as IsolatedCommandWorkspace);
  const facts = vi.fn(async () => { throw new Error("No runtime is needed in this fixture"); });
  const service = { binding: { id: "local", kind: "local" }, runner: { facts, start: vi.fn() } } as unknown as CommandService;
  const options: ScopedCodingWorkerOptions = { runtime: { userData: "/private", runtimePath: "/fixed/runtime", env: {} },
    createWorkspace, commandService: service, commandContext: vi.fn(() => { throw new Error("No controller should start"); }), current: () => true,
    reviewBase: "/private-reviews", publish: vi.fn(async () => { throw new Error("No artifact was exported"); }), progress: vi.fn(), beforeStart, onRetiring: vi.fn() };
  const spec = { id: "task-fixture", goal: "Fix the copied project", target: { xid: 1, pid: 1, title: "fixture", bounds: { x: 0, y: 0, width: 10, height: 10 } } } as unknown as TaskSpec;
  return { worker: new ScopedCodingWorker(spec, options), options, backend, beforeStart, createWorkspace, facts, service };
}

it("does no startup work for a pre-aborted task and shares verified disposal", async () => {
  const f = fixture(), task = new AbortController(); task.abort();
  expect(await f.worker.run(task.signal)).toMatchObject({ success: false, stopped: true });
  expect(f.beforeStart).not.toHaveBeenCalled(); expect(f.createWorkspace).not.toHaveBeenCalled(); expect(f.facts).not.toHaveBeenCalled();
  const disposed = f.worker.dispose(); expect(f.worker.dispose()).toBe(disposed); await disposed;
  expect(await f.worker.disposed).toBe(true); expect(f.worker.handoffSafe()).toBe(false); expect(f.worker.sessionId).toBeNull();
  expect(await f.worker.steer()).toBe(false);
});

it("waits for asynchronous startup to settle and stops a late workspace before any command facts or model process", async () => {
  const f = fixture(), task = new AbortController(), entered = deferred<void>(), release = deferred<IsolatedCommandWorkspace>();
  f.createWorkspace.mockImplementationOnce(async () => { entered.resolve(); return await release.promise; });
  const running = f.worker.run(task.signal); await entered.promise;
  const disposing = f.worker.dispose(); let done = false; void disposing.then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false);
  release.resolve(f.backend as unknown as IsolatedCommandWorkspace);
  expect((await running).success).toBe(false); await disposing;
  expect(f.backend.stop).toHaveBeenCalled(); expect(f.backend.close).toHaveBeenCalledTimes(1); expect(f.facts).not.toHaveBeenCalled();
  expect(await f.worker.disposed).toBe(true); expect(f.worker.handoffSafe()).toBe(false);
});

it("retains a failed shutdown witness for concurrent and later disposal callers", async () => {
  const f = fixture(), entered = deferred<void>(), release = deferred<IsolatedCommandWorkspace>();
  f.createWorkspace.mockImplementationOnce(async () => { entered.resolve(); return await release.promise; });
  f.backend.stop.mockRejectedValue(new Error("Unknown native command shutdown"));
  const running = f.worker.run(new AbortController().signal); await entered.promise;
  const first = f.worker.dispose(), rejected = expect(first).rejects.toThrow("verified as closed");
  expect(f.worker.dispose()).toBe(first);
  release.resolve(f.backend as unknown as IsolatedCommandWorkspace);
  expect(await running).toMatchObject({ success: false, summary: expect.stringContaining("blocked") }); await rejected;
  expect(await f.worker.disposed).toBe(false); expect(f.worker.handoffSafe()).toBe(false);
  expect(f.worker.dispose()).toBe(first);
});

it("revokes a captured admission capability synchronously on explicit host invalidation", async () => {
  const f = fixture(), entered = deferred<void>(), release = deferred<IsolatedCommandWorkspace>();
  let admit!: () => boolean;
  f.createWorkspace.mockImplementationOnce(async (_signal, current) => { admit = current; entered.resolve(); return await release.promise; });
  const running = f.worker.run(new AbortController().signal); await entered.promise;
  expect(admit()).toBe(true); f.worker.invalidate(); expect(admit()).toBe(false);
  release.resolve(f.backend as unknown as IsolatedCommandWorkspace);
  expect((await running).success).toBe(false); await f.worker.dispose();
  expect(f.facts).not.toHaveBeenCalled(); expect(f.options.commandContext).not.toHaveBeenCalled();
  expect(f.service.runner.start).not.toHaveBeenCalled();
});

it("does not start a worker which was disposed before run", async () => {
  const f = fixture(); await f.worker.dispose();
  expect(await f.worker.run(new AbortController().signal)).toMatchObject({ success: false, stopped: true });
  expect(f.createWorkspace).not.toHaveBeenCalled(); expect(await f.worker.disposed).toBe(true);
});
