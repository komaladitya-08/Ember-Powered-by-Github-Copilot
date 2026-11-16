import { afterEach, expect, it, vi } from "vitest";
import { TaskManager, type WorkerLike } from "../../app/main/agent/tasks";
import type { Logger } from "../../app/main/logger";
import type { WorkerResult } from "../../app/main/agent/worker";
import { waitForTaskSettlement } from "../../app/main/agent/task-wait";
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const managers: TaskManager[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.close(); });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup(options: { handoff?: boolean | "missing" | "throw"; cleanup?: boolean | "missing" | "throw"; result?: WorkerResult; coding?: boolean; deferredHandoff?: boolean; maxRunning?: number } = {}) {
  const execution = deferred<WorkerResult>(), disposal = deferred<void>(); let witness = false;
  const worker: WorkerLike = { run: () => execution.promise, dispose: () => disposal.promise, steer: async () => true, sessionId: null,
    ...(options.cleanup === "missing" ? {} : { cleanupComplete: () => { if (options.cleanup === "throw") throw new Error("private cleanup witness error"); return witness && options.cleanup !== false; } }),
    ...(options.handoff === "missing" ? {} : { handoffSafe: () => { if (options.handoff === "throw") throw new Error("private witness error"); return witness && options.handoff !== false; } }) };
  const manager = new TaskManager({ log: quiet, makeWorker: () => worker, currentWindow: () => null, setCards() {}, deleteSession: async () => undefined, maxRunning: options.maxRunning });
  managers.push(manager);
  const task = manager.start("Synthetic delegated task", { ...(options.deferredHandoff ? { deferHandoff: true } : {}),
    ...(options.coding ? { codingWorkspace: { path: "/source", current: () => true } } : {}) });
  const wait = () => waitForTaskSettlement({ ids: [task.id], timeoutMs: 1000, current: () => true,
    snapshot: () => [manager.observeSettlement(task)], subscribe: callback => manager.subscribeSettlement(callback) });
  return { manager, task, execution, disposal, wait, finish() { execution.resolve(options.result ?? { success: true, summary: "Observed result" }); },
    dispose() { witness = true; disposal.resolve(); } };
}
it("keeps ordinary card completion before disposal while a join waits for the positive post-disposal witness", async () => {
  const value = setup(), waiting = value.wait(); let completed = false; void waiting.then(() => { completed = true; }); value.finish();
  await vi.waitFor(() => expect(value.task.status).toBe("done"));
  expect(value.manager.observeSettlement(value.task)).toMatchObject({ status: "done", cleanup: "pending", handoffSafe: false }); expect(completed).toBe(false);
  value.dispose(); expect(await waiting).toMatchObject({ reason: "settled", dependentSuccess: true, tasks: [{ cleanup: "complete", handoffSafe: true, summary: "Observed result" }] });
  expect(value.manager.takeReports()).toEqual([value.task]); expect(value.manager.takeReports()).toEqual([]);
});
it.each([false, "missing", "throw"] as const)("reports fulfilled disposal independently from an unavailable handoff witness (%s)", async handoff => {
  const value = setup({ handoff }); value.finish(); value.dispose();
  expect(await value.wait()).toMatchObject({ dependentSuccess: false, tasks: [{ status: "done", cleanup: "complete", handoffSafe: false }] });
});
it.each([false, "missing", "throw"] as const)("keeps fulfilled best-effort disposal unknown without a positive cleanup witness (%s)", async cleanup => {
  const value = setup({ cleanup }); value.finish(); value.dispose();
  expect(await value.wait()).toMatchObject({ reason: "settled", dependentSuccess: false, tasks: [{ status: "done", cleanup: "unknown", handoffSafe: false, summary: "Observed result" }] });
});
it("keeps failed disposal unknown even though its ordinary card already says done", async () => {
  const value = setup(); value.finish(); await vi.waitFor(() => expect(value.task.status).toBe("done")); value.disposal.reject(new Error("private disposal failure"));
  expect(await value.wait()).toMatchObject({ dependentSuccess: false, tasks: [{ status: "done", cleanup: "unknown", handoffSafe: false }] });
});
it.each(["coding", "deferred"])("observes %s settlement only after actual disposal and the existing finish boundary", async kind => {
  const value = setup({ coding: kind === "coding", deferredHandoff: kind === "deferred" }); value.finish();
  await Promise.resolve(); await Promise.resolve(); expect(value.task.status).toBe("running"); expect(value.manager.observeSettlement(value.task).cleanup).toBe("pending");
  value.dispose(); expect(await value.wait()).toMatchObject({ dependentSuccess: true, tasks: [{ status: "done", cleanup: "complete", handoffSafe: true }] });
});
it("reports a failed worker with completed cleanup as failed rather than successful dependent work", async () => {
  const value = setup({ result: { success: false, summary: "Synthetic check failed" } }); value.finish(); value.dispose();
  expect(await value.wait()).toMatchObject({ dependentSuccess: false, tasks: [{ status: "failed", cleanup: "complete", handoffSafe: false }] });
});
it("reports a dismissed exact task as missing and refuses a forged object with the same id", async () => {
  const value = setup(); value.finish(); value.dispose(); await value.wait();
  expect(value.manager.observeSettlement({ ...value.task })).toMatchObject({ status: "missing", summary: "", handoffSafe: false });
  value.manager.dismiss(value.task.id); expect(await value.wait()).toMatchObject({ dependentSuccess: false, tasks: [{ status: "missing", summary: "" }] });
});
it("positively settles a queued cancellation without manufacturing a worker handoff", async () => {
  const value = setup({ maxRunning: 1 }), queued = value.manager.start("Still queued"); value.manager.cancel(queued.id);
  expect(value.manager.observeSettlement(queued)).toMatchObject({ status: "cancelled", cleanup: "complete", handoffSafe: false });
  value.finish(); value.dispose(); await value.wait();
});
