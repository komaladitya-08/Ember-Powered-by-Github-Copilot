/** Lifecycle regressions with a host workspace factory; no SDK process or native command starts in these cases. */
import { expect, it, vi } from "vitest";
import { ScopedCodingWorker, type ScopedCodingWorkerOptions, type FileOnlyScopedCodingWorkerOptions } from "../../app/main/agent/scoped-coding-worker";
import type { IsolatedCommandWorkspace } from "../../app/main/agent/isolated-command-workspace";
import type { CommandService } from "../../app/main/commands/types";
import type { TaskSpec } from "../../app/main/agent/worker";
import { CodingPrivacyCleanupError } from "../../app/main/agent/coding-privacy-scanner";
import { CustomCodingController, CodingControllerCleanupError } from "../../app/main/agent/custom-coding-controller";
import { ScopedCodingFileError, type CodingFileBroker, type CodingReviewWorkspace, type CodingWorkspaceReview } from "../../app/main/agent/coding-platform";
import { WindowsCodingCleanupError } from "../../app/main/agent/windows-coding-native";
import { WindowsFileOnlyWorkspaceCleanupError } from "../../app/main/agent/windows-file-only-workspace";
import { CodingArtifactCleanupError } from "../../app/main/agent/coding-artifact-store";
import { CodingSeedCleanupError } from "../../app/main/agent/coding-seed-snapshot";
import { PUBLIC_NPM_LIMITS, PUBLIC_NPM_REGISTRY, PublicNpmPreparationError, type PublicNpmPreparationAuthorize, type PublicNpmPreparationRequest } from "../../app/main/agent/public-npm-lock";
import type { CodingControllerOptions, CodingControllerToolContext } from "../../app/main/agent/custom-coding-controller";
import type { CommandFlowContext } from "../../app/main/commands/flow";

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
  const f = fixture(), { commandService: _service, commandContext: _context, publicDependencies: _dependencies, ...base } = f.options;
  const files = vi.fn(async () => { throw new Error("No file broker should start in this lifecycle fixture"); });
  const options: FileOnlyScopedCodingWorkerOptions = { ...base, mode: "files-only", platform: { files } };
  const spec = { id: "file-only-lifecycle", goal: "Review files without commands", target: {} } as TaskSpec;
  return { ...f, options, worker: new ScopedCodingWorker(spec, options), files };
}

it("requires an explicit file-only capability with no injected command service or fallback file adapter", async () => {
  const f = fileOnlyFixture();
  const spec = { id: "bad-file-only", goal: "Review files", target: {} } as TaskSpec;
  for (const options of [{ ...f.options, commandService: f.service }, { ...f.options, platform: undefined },
    { ...f.options, publicDependencies: { current: () => true, authorize: async () => true } }]) {
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
  expect(await f.worker.disposed).toBe(true); expect(f.worker.cleanupComplete()).toBe(true); expect(f.worker.handoffSafe()).toBe(false); expect(f.worker.sessionId).toBeNull();
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
  expect(await f.worker.disposed).toBe(false); expect(f.worker.cleanupComplete()).toBe(false); expect(f.worker.handoffSafe()).toBe(false);
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

class NativeWorkspaceCleanupError extends WindowsCodingCleanupError {}

it.each([
  ["native owner", () => new WindowsCodingCleanupError()],
  ["native workspace subtype", () => new NativeWorkspaceCleanupError()],
  ["artifact owner", () => new CodingArtifactCleanupError()],
  ["file-only workspace subtype", () => new WindowsFileOnlyWorkspaceCleanupError()],
  ["continuation seed", () => new CodingSeedCleanupError()],
] as const)("retains unknown %s cleanup when stopped during a rejecting workspace factory", async (_kind, failure) => {
  const f = fixture(), entered = deferred<void>(), release = deferred<void>();
  const seal = vi.fn(async () => undefined); Object.assign(f.backend, { sealForReview: seal });
  f.createWorkspace.mockImplementationOnce(async () => { entered.resolve(); await release.promise; throw failure(); });
  const running = f.worker.run(new AbortController().signal); await entered.promise;
  const disposing = f.worker.dispose(), disposalFailure = disposing.then(() => null, error => error);
  expect(f.worker.dispose()).toBe(disposing);
  try {
    release.resolve();
    expect(await running).toMatchObject({ success: false, summary: expect.stringContaining("blocked") });
    expect(await disposalFailure).toMatchObject({ message: expect.stringContaining("verified as closed") });
    expect(await f.worker.disposed).toBe(false); expect(f.worker.cleanupComplete()).toBe(false); expect(f.worker.handoffSafe()).toBe(false);
    expect(f.worker.dispose()).toBe(disposing);
    expect(f.backend.stop).not.toHaveBeenCalled(); expect(f.backend.close).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled(); expect(f.backend.exportReview).not.toHaveBeenCalled(); expect(f.options.publish).not.toHaveBeenCalled();
    expect(f.facts).not.toHaveBeenCalled(); expect(f.options.commandContext).not.toHaveBeenCalled(); expect(f.service.runner.start).not.toHaveBeenCalled();
  } finally { release.resolve(); await Promise.allSettled([running, disposing]); }
});

it.each(["unavailable", "cancelled", "lookalike"] as const)("keeps known-safe %s factory refusal separate from typed cleanup uncertainty", async kind => {
  const f = fixture(), entered = deferred<void>(), release = deferred<void>();
  const failure = kind === "lookalike" ? Object.assign(new Error("Fixture refusal"), {
    name: "WindowsCodingCleanupError", code: "windows-coding-cleanup-unverified",
  }) : new ScopedCodingFileError(kind);
  f.createWorkspace.mockImplementationOnce(async () => { entered.resolve(); await release.promise; throw failure; });
  const running = f.worker.run(new AbortController().signal); await entered.promise;
  if (kind === "cancelled") f.worker.stop();
  try {
    release.resolve(); expect((await running).success).toBe(false); await f.worker.dispose();
    expect(await f.worker.disposed).toBe(true); expect(f.worker.cleanupComplete()).toBe(true); expect(f.worker.handoffSafe()).toBe(false);
    expect(f.options.publish).not.toHaveBeenCalled(); expect(f.facts).not.toHaveBeenCalled(); expect(f.backend.exportReview).not.toHaveBeenCalled();
  } finally { release.resolve(); await Promise.allSettled([running, f.worker.dispose()]); }
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
    expect(f.seal).toHaveBeenCalledTimes(1); expect(f.publish).toHaveBeenCalledWith(expect.anything(), "done", { ran: 0, passed: 0, failed: 0 }, "Copied-file edits only. No commands or tests were run.");
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

it("routes exact captured WSL policy to an isolated runner without invoking the ordinary distro runner", async () => {
  const f = fixture(), target = { id: "wsl:Ubuntu", kind: "wsl", label: "Ubuntu (WSL)", screenOs: "win32", shellOs: "linux", desktop: "none" } as const;
  const facts = { os: "linux", shells: ["bash"], shellPaths: { bash: "/usr/bin/bash" }, script: null, home: "/work", privileged: false, pty: false, extraPath: [], ember: { paths: [], pids: [], names: /ember/i } } as const;
  const ordinary = vi.fn(), source = { ...f.service, binding: target, runner: { facts: async () => facts, start: ordinary } } as unknown as CommandService;
  Object.assign(f.backend, { executionRoot: "/work", nodeAvailable: true, run: vi.fn(), runNode: vi.fn() });
  const context = vi.fn((service: CommandService) => {
    expect(service.binding).toEqual(target); expect(service.runner).not.toBe(source.runner); expect(service.runner.target).toBe(target.id);
    return { state: {}, service } as never;
  });
  const start = vi.spyOn(CustomCodingController, "start").mockImplementationOnce(async input => {
    expect(input.commands).toMatchObject({ target: "Ubuntu (WSL)", shells: ["bash"], node: true });
    throw new Error("Fixture stops before SDK startup");
  });
  try {
    const options: ScopedCodingWorkerOptions = { ...f.options, target, commandService: source, commandContext: context,
      platform: { facts: () => structuredClone(facts) as never, files: vi.fn() } };
    const worker = new ScopedCodingWorker({ id: "wsl-capture", goal: "Check the copy", target: {}, targetId: target.id } as TaskSpec, options);
    expect((await worker.run(new AbortController().signal)).success).toBe(false); await worker.dispose();
    expect(context).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(1); expect(ordinary).not.toHaveBeenCalled();
  } finally { start.mockRestore(); }
});
it.each([undefined, "wsl:Other", "ssh:Ubuntu"])("refuses a WSL service without its exact captured target (%s)", id => {
  const f = fixture();
  const binding = { id: "wsl:Ubuntu", kind: "wsl", label: "Ubuntu", screenOs: "win32", shellOs: "linux", desktop: "none" } as const;
  const service = { ...f.service, binding } as CommandService;
  const options = { ...f.options, commandService: service, ...(id ? { target: { ...binding, id } } : {}) } as ScopedCodingWorkerOptions;
  const worker = new ScopedCodingWorker({ id: "wrong-target", goal: "Check the copy", target: {} } as TaskSpec, options);
  return worker.run(new AbortController().signal).then(async result => {
    expect(result.success).toBe(false); await worker.dispose(); expect(f.facts).not.toHaveBeenCalled(); expect(f.options.commandContext).not.toHaveBeenCalled();
  });
});

function publicPreparationFixture(enabled = true, heldQuestion = false) {
  const f = fixture(), state = { current: true }, trace: string[] = [], answer = deferred<string | null>();
  const target = { id: "wsl:Ubuntu", kind: "wsl", label: "Ubuntu (WSL)", screenOs: "win32", shellOs: "linux", desktop: "none" } as const;
  const facts = { os: "linux", shells: ["bash"], shellPaths: { bash: "/usr/bin/bash" }, script: null, home: "/tmp", privileged: false, pty: false, extraPath: [], ember: { paths: [], pids: [], names: /ember/i } } as const;
  const source = { ...f.service, binding: target, runner: { facts: async () => facts, start: vi.fn() } } as unknown as CommandService;
  const request = Object.freeze({ kind: "changed" as const, registry: PUBLIC_NPM_REGISTRY, packageJsonSha256: "a".repeat(64), lockSha256: "b".repeat(64), setSha256: "c".repeat(64),
    packageCount: 1, compressedByteLimit: PUBLIC_NPM_LIMITS.compressedBytes, packages: Object.freeze([Object.freeze({ name: "react", version: "19.0.0" })]) });
  const result = { prepared: true as const, packages: 1, lockSha256: request.lockSha256, setSha256: request.setSha256 };
  const prepare = vi.fn(async function (this: unknown, authorize: PublicNpmPreparationAuthorize, signal: AbortSignal) {
    trace.push(this === f.backend ? "held-owner" : "wrong-owner");
    if (!await authorize(request, signal)) throw new PublicNpmPreparationError();
    trace.push("fetch-model"); return result;
  });
  Object.assign(f.backend, { executionRoot: "/work", nodeAvailable: true, run: vi.fn(), runNode: vi.fn(), preparePublicDependencies: prepare });
  const audit = vi.fn(() => { trace.push("prepared-audit"); });
  const authorize = vi.fn(async (_request: Readonly<PublicNpmPreparationRequest>, context: CommandFlowContext, signal: AbortSignal) => {
    trace.push("authorize"); return await context.confirmer.ask({ title: "Exact set", prompt: "Fixed preparation question", options: [{ id: "once", label: "Allow" }, { id: "deny", label: "Not now" }] }, signal) === "once";
  });
  const context = { state: { running: false }, signal: new AbortController().signal, isOver: () => !state.current, audit,
    confirmer: { ask: async () => { trace.push("ask"); return heldQuestion ? answer.promise : "once"; } } };
  const options: ScopedCodingWorkerOptions = { ...f.options, target, commandService: source,
    platform: { facts: () => structuredClone(facts) as never, files: vi.fn() }, commandContext: () => context as never,
    ...(enabled ? { publicDependencies: { current: () => state.current, authorize } } : {}) };
  let captured: CodingControllerOptions | null = null, prepared: unknown;
  const start = vi.spyOn(CustomCodingController, "start").mockImplementationOnce(async input => {
    captured = input;
    return { close: async () => undefined, stop: async () => undefined, run: async () => {
      const hook = input.mode === "files-only" ? undefined : input.preparePublicDependencies;
      if (hook) prepared = await hook({ signal: new AbortController().signal,
        waiting: async <T>(work: () => Promise<T>) => { trace.push("question-enter"); try { return await work(); } finally { trace.push("question-exit"); } } } as CodingControllerToolContext);
      return { success: false, summary: "This lifecycle fixture does not execute commands or create a review." };
    } } as unknown as CustomCodingController;
  });
  const worker = new ScopedCodingWorker({ id: "public-preparation", goal: "Prepare copied dependencies", target: {}, targetId: target.id } as TaskSpec, options);
  return { ...f, worker, options, state, trace, prepare, authorize, answer, context, source, start, captured: () => captured, prepared: () => prepared, result };
}
it.each([false, true])("offers preparation only with captured project intent and keeps actual work outside human waiting (opt-in=%s)", async enabled => {
  const f = publicPreparationFixture(enabled);
  try {
    expect((await f.worker.run(new AbortController().signal)).success).toBe(false); await f.worker.dispose();
    expect(f.captured()).toMatchObject({ executionProfile: enabled ? "wsl-public-lock" : "wsl-offline" });
    if (enabled) {
      expect(f.prepared()).toEqual(f.result); expect(f.trace).toEqual(["held-owner", "authorize", "question-enter", "ask", "question-exit", "fetch-model", "prepared-audit"]);
      expect(f.prepare).toHaveBeenCalledOnce();
    } else { expect(f.captured()).not.toHaveProperty("preparePublicDependencies"); expect(f.prepare).not.toHaveBeenCalled(); }
    expect(f.source.runner.start).not.toHaveBeenCalled(); expect(f.context.state.running).toBe(false);
  } finally { f.answer.resolve("deny"); f.start.mockRestore(); }
});
it("rejects permission revoked while a preparation question waits before the modeled fetch", async () => {
  const f = publicPreparationFixture(true, true);
  try {
    const running = f.worker.run(new AbortController().signal); await vi.waitFor(() => expect(f.trace).toContain("ask"));
    expect(f.context.state.running).toBe(true); f.state.current = false; f.answer.resolve("once");
    expect((await running).success).toBe(false); await f.worker.dispose();
    expect(f.trace).not.toContain("fetch-model"); expect(f.prepared()).toBeUndefined(); expect(f.context.state.running).toBe(false);
  } finally { f.answer.resolve("deny"); f.start.mockRestore(); }
});
it("does not fall back to ordinary execution if opted-in preparation is absent from the selected workspace", async () => {
  const f = publicPreparationFixture(); delete (f.backend as unknown as { preparePublicDependencies?: unknown }).preparePublicDependencies;
  try {
    expect((await f.worker.run(new AbortController().signal)).success).toBe(false); await f.worker.dispose();
    expect(f.start).not.toHaveBeenCalled(); expect(f.authorize).not.toHaveBeenCalled(); expect(f.source.runner.start).not.toHaveBeenCalled();
  } finally { f.start.mockRestore(); }
});
