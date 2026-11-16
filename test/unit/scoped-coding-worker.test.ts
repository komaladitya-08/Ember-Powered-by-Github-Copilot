/** Lifecycle regressions with a host workspace factory; no SDK process or native command starts in these cases. */
import { expect, it, vi } from "vitest";
import { ScopedCodingWorker, type ScopedCodingWorkerOptions, type FileOnlyScopedCodingWorkerOptions } from "../../app/main/agent/scoped-coding-worker";
import type { IsolatedCommandWorkspace } from "../../app/main/agent/isolated-command-workspace";
import type { CommandService } from "../../app/main/commands/types";
import type { TaskSpec } from "../../app/main/agent/worker";
import { CodingPrivacyCleanupError } from "../../app/main/agent/coding-privacy-scanner";
import { CustomCodingController, CodingControllerCleanupError } from "../../app/main/agent/custom-coding-controller";
import type { CodingFileBroker, CodingReviewWorkspace, CodingWorkspaceReview } from "../../app/main/agent/coding-platform";

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

function fileOnlyFixture() {
  const f = fixture(), { commandService: _service, commandContext: _context, ...base } = f.options;
  const files = vi.fn(async () => { throw new Error("No file broker should start in this lifecycle fixture"); });
  const options: FileOnlyScopedCodingWorkerOptions = { ...base, mode: "files-only", platform: { files } };
  const spec = { id: "file-only-lifecycle", goal: "Review files without commands", target: {} } as TaskSpec;
  return { ...f, options, worker: new ScopedCodingWorker(spec, options), files };
}

it("requires an explicit file-only capability with no injected command service or fallback file adapter", async () => {
  const f = fileOnlyFixture();
  const spec = { id: "bad-file-only", goal: "Review files", target: {} } as TaskSpec;
  for (const options of [{ ...f.options, commandService: f.service }, { ...f.options, platform: undefined }]) {
    const worker = new ScopedCodingWorker(spec, options as unknown as FileOnlyScopedCodingWorkerOptions);
    expect((await worker.run(new AbortController().signal)).success).toBe(false);
    await worker.dispose(); expect(await worker.disposed).toBe(true);
  }
  expect(f.beforeStart).not.toHaveBeenCalled(); expect(f.createWorkspace).not.toHaveBeenCalled(); expect(f.facts).not.toHaveBeenCalled();
});

it("never consults command facts after stopping an asynchronously created file-only copy", async () => {
  const f = fileOnlyFixture(), entered = deferred<void>(), release = deferred<IsolatedCommandWorkspace>();
  f.createWorkspace.mockImplementationOnce(async () => { entered.resolve(); return release.promise; });
  const running = f.worker.run(new AbortController().signal); await entered.promise;
  const disposing = f.worker.dispose(); let done = false; void disposing.then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false);
  release.resolve(f.backend as unknown as IsolatedCommandWorkspace);
  expect((await running).success).toBe(false); await disposing;
  expect(f.backend.stop).toHaveBeenCalled(); expect(f.backend.close).toHaveBeenCalledTimes(1);
  expect(f.facts).not.toHaveBeenCalled(); expect(f.files).not.toHaveBeenCalled(); expect(f.service.runner.start).not.toHaveBeenCalled();
});

it("cannot upgrade a captured file-only task by changing its options while startup waits", async () => {
  const f = fileOnlyFixture(), entered = deferred<void>(), release = deferred<void>();
  f.options.beforeStart = async () => { entered.resolve(); await release.promise; };
  const start = vi.spyOn(CustomCodingController, "start").mockImplementationOnce(async options => {
    expect(options.mode).toBe("files-only"); expect(options.commands).toBeUndefined(); expect(options.runCommand).toBeUndefined();
    throw new Error("No SDK process in this capability-capture fixture");
  });
  try {
    const running = f.worker.run(new AbortController().signal); await entered.promise;
    Object.assign(f.options, { mode: "commands", commandService: f.service, commandContext: vi.fn() });
    release.resolve(); expect((await running).success).toBe(false); await f.worker.dispose();
    expect(start).toHaveBeenCalledTimes(1); expect(f.facts).not.toHaveBeenCalled(); expect(f.service.runner.start).not.toHaveBeenCalled();
  } finally { release.resolve(); start.mockRestore(); }
});

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

it("retains an unknown privacy-worker exit during startup as an unsafe disposal receipt", async () => {
  const f = fixture(); f.createWorkspace.mockRejectedValueOnce(new CodingPrivacyCleanupError());
  expect(await f.worker.run(new AbortController().signal)).toMatchObject({ success: false, summary: expect.stringContaining("blocked") });
  expect(await f.worker.disposed).toBe(false); expect(f.worker.handoffSafe()).toBe(false);
  await expect(f.worker.dispose()).rejects.toThrow("verified as closed"); expect(f.facts).not.toHaveBeenCalled();
});

function sealedFixture(controllerClose: () => Promise<void>, filesClose: () => Promise<void>) {
  const f = fileOnlyFixture(), output = { directory: "/review", review: {}, cleanup: "complete" } as CodingWorkspaceReview;
  const seal = vi.fn(async () => undefined), publish = vi.fn(async () => ({} as never));
  const workspace: CodingReviewWorkspace = { executionRoot: "/work", files: operation => operation("/copy"),
    stop: vi.fn(async () => undefined), close: vi.fn(async () => undefined), sealForReview: seal,
    exportReview: vi.fn(async () => output) };
  const options: FileOnlyScopedCodingWorkerOptions = { ...f.options, createWorkspace: async () => workspace, publish,
    platform: { files: async () => ({ close: filesClose }) as CodingFileBroker } };
  const start = vi.spyOn(CustomCodingController, "start").mockImplementationOnce(async captured => {
    await captured.files(new AbortController().signal);
    return { run: async () => ({ success: true, summary: "Copied-file edits only. No commands or tests were run." }),
      close: controllerClose } as unknown as CustomCodingController;
  });
  const worker = new ScopedCodingWorker({ id: "sealed-file-only", goal: "Edit the copy", target: {} } as TaskSpec, options);
  return { worker, workspace, seal, publish, start };
}

it("seals a workspace with no command port only after both controller and file-broker closure fulfill", async () => {
  const controllerEntered = deferred<void>(), controllerRelease = deferred<void>(), filesEntered = deferred<void>(), filesRelease = deferred<void>();
  const f = sealedFixture(async () => { controllerEntered.resolve(); await controllerRelease.promise; },
    async () => { filesEntered.resolve(); await filesRelease.promise; });
  try {
    const running = f.worker.run(new AbortController().signal); await controllerEntered.promise;
    expect(f.seal).not.toHaveBeenCalled(); expect(f.workspace.exportReview).not.toHaveBeenCalled();
    controllerRelease.resolve(); await filesEntered.promise; expect(f.seal).not.toHaveBeenCalled();
    filesRelease.resolve(); expect((await running).success).toBe(true); await f.worker.dispose();
    expect(f.seal).toHaveBeenCalledTimes(1); expect(f.publish).toHaveBeenCalledWith(expect.anything(), "done", { ran: 0, passed: 0, failed: 0 });
    expect(f.workspace.close).toHaveBeenCalledTimes(1); expect(await f.worker.disposed).toBe(true);
  } finally { controllerRelease.resolve(); filesRelease.resolve(); f.start.mockRestore(); }
});

it.each(["controller", "files"])("never seals or publishes when %s closure is unknown", async failed => {
  const close = async (kind: string) => { if (kind === failed) throw new CodingControllerCleanupError(); };
  const f = sealedFixture(() => close("controller"), () => close("files"));
  try {
    expect((await f.worker.run(new AbortController().signal)).success).toBe(false);
    expect(f.seal).not.toHaveBeenCalled(); expect(f.workspace.exportReview).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
    expect(await f.worker.disposed).toBe(false); await expect(f.worker.dispose()).rejects.toThrow("verified as closed");
  } finally { f.start.mockRestore(); }
});

it("never seals or publishes after controller startup reports unknown cleanup", async () => {
  const f = fileOnlyFixture(), seal = vi.fn(async () => undefined); Object.assign(f.backend, { sealForReview: seal });
  const start = vi.spyOn(CustomCodingController, "start").mockRejectedValueOnce(new CodingControllerCleanupError());
  try {
    expect((await f.worker.run(new AbortController().signal)).success).toBe(false);
    expect(seal).not.toHaveBeenCalled(); expect(f.backend.exportReview).not.toHaveBeenCalled();
    expect(await f.worker.disposed).toBe(false); await expect(f.worker.dispose()).rejects.toThrow("verified as closed");
  } finally { start.mockRestore(); }
});
