import { afterEach, describe, expect, it, vi } from "vitest";
import type { CopilotClient } from "@github/copilot-sdk";
import { CodingWorker, type CodingWorkerOptions } from "../../app/main/agent/coding-worker";
import { CodingRuntime, CodingRuntimeCleanupError } from "../../app/main/agent/coding-runtime";
import { CodingSession } from "../../app/main/agent/coding-session";
import type { TaskSpec } from "../../app/main/agent/worker";
import type { ModeInForce } from "../../app/shared/approvals";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function fixture() {
  let mode: ModeInForce = "interactive", changed: () => void = () => undefined;
  const onRetiring = vi.fn();
  const spec: TaskSpec = { id: "coding-1", goal: "Inspect the project", target: {} as TaskSpec["target"], codingWorkspace: { path: "/project", current: () => true } };
  const options: CodingWorkerOptions = {
    runtime: { userData: "/private", runtimePath: "/runtime", env: {} }, gitHubToken: "fake-session-token", model: "model",
    mode: () => mode, onModeChange: cb => { changed = cb; return () => undefined; },
    confirmer: { ask: async () => "not-now" }, commandPolicy: () => ({ state: "on", askEvery: false }),
    home: "/home", os: "linux", ember: async () => ({ paths: ["/private"], pids: [], names: /^ember$/ }),
    progress: () => undefined, beforeStart: async () => undefined, onRetiring,
  };
  return { spec, options, onRetiring, switchMode: (next: ModeInForce) => { mode = next; changed(); } };
}

afterEach(() => vi.restoreAllMocks());

describe("coding worker runtime ownership", () => {
  it("holds retirement on Stop until both the session and separate runtime actually close", async () => {
    const f = fixture(), sessionClosed = deferred<void>(), runtimeClosed = deferred<void>();
    const closeSession = vi.fn(() => sessionClosed.promise), closeRuntime = vi.fn(() => runtimeClosed.promise);
    const session = { modeStatus: {}, close: closeSession, run: vi.fn((_prompt: string, signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
    })) } as unknown as CodingSession;
    const runtime = { client: {} as CopilotClient, close: closeRuntime } as unknown as CodingRuntime;
    vi.spyOn(CodingRuntime, "start").mockResolvedValue(runtime);
    const create = vi.spyOn(CodingSession, "create").mockResolvedValue(session);
    const worker = new CodingWorker(f.spec, f.options), abort = new AbortController();
    const run = worker.run(abort.signal);
    await vi.waitFor(() => expect(session.run).toHaveBeenCalledOnce());
    expect(create.mock.calls[0][0].gitHubToken).toBe("fake-session-token");
    expect(worker.sessionId).toBeNull();
    abort.abort();
    expect(f.onRetiring).toHaveBeenCalled();
    expect(await run).toMatchObject({ stopped: true });
    let disposed = false;
    void worker.disposed.then(() => { disposed = true; });
    const closing = worker.dispose();
    expect(disposed).toBe(false);
    sessionClosed.resolve();
    await vi.waitFor(() => expect(closeRuntime).toHaveBeenCalledOnce());
    expect(disposed).toBe(false);
    runtimeClosed.resolve();
    await closing;
    expect(await worker.disposed).toBe(true);
  });

  it("holds retirement as soon as the approval mode changes", async () => {
    const f = fixture();
    const session = { modeStatus: {}, close: vi.fn(async () => undefined), run: vi.fn((_prompt: string, signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
    })) } as unknown as CodingSession;
    vi.spyOn(CodingRuntime, "start").mockResolvedValue({ client: {} as CopilotClient, close: async () => undefined } as CodingRuntime);
    vi.spyOn(CodingSession, "create").mockResolvedValue(session);
    const worker = new CodingWorker(f.spec, f.options), run = worker.run(new AbortController().signal);
    await vi.waitFor(() => expect(session.run).toHaveBeenCalledOnce());
    f.switchMode("autopilot");
    expect(f.onRetiring).toHaveBeenCalledOnce();
    expect(await run).toMatchObject({ success: false, summary: expect.stringContaining("approval mode changed") });
    await worker.dispose();
  });

  it("never reports safe disposal after runtime startup cleanup failed", async () => {
    const f = fixture();
    vi.spyOn(CodingRuntime, "start").mockRejectedValue(new CodingRuntimeCleanupError());
    const worker = new CodingWorker(f.spec, f.options);
    await expect(worker.run(new AbortController().signal)).rejects.toBeInstanceOf(CodingRuntimeCleanupError);
    await expect(worker.dispose()).rejects.toBeInstanceOf(CodingRuntimeCleanupError);
    expect(await worker.disposed).toBe(false);
  });

  it("does not pass a GitHub token into a user-provider session", async () => {
    const f = fixture();
    f.options.provider = { type: "openai", baseUrl: "http://127.0.0.1:1", apiKey: "fake-provider-key" };
    const session = { modeStatus: {}, close: async () => undefined, run: async () => "Done" } as unknown as CodingSession;
    vi.spyOn(CodingRuntime, "start").mockResolvedValue({ client: {} as CopilotClient, close: async () => undefined } as CodingRuntime);
    const create = vi.spyOn(CodingSession, "create").mockResolvedValue(session);
    const worker = new CodingWorker(f.spec, f.options);
    expect(await worker.run(new AbortController().signal)).toMatchObject({ success: true });
    expect(create.mock.calls[0][0].gitHubToken).toBeUndefined();
    expect(create.mock.calls[0][0].provider).toEqual(f.options.provider);
    await worker.dispose();
  });

  it("still stops the runtime when the session fails to close, and reports unconfirmed cleanup", async () => {
    const f = fixture(), closeRuntime = vi.fn(async () => undefined);
    const session = { modeStatus: {}, close: async () => { throw new Error("not closed"); }, run: async () => "Done" } as unknown as CodingSession;
    vi.spyOn(CodingRuntime, "start").mockResolvedValue({ client: {} as CopilotClient, close: closeRuntime } as unknown as CodingRuntime);
    vi.spyOn(CodingSession, "create").mockResolvedValue(session);
    const worker = new CodingWorker(f.spec, f.options);
    await worker.run(new AbortController().signal);
    await expect(worker.dispose()).rejects.toBeInstanceOf(CodingRuntimeCleanupError);
    expect(closeRuntime).toHaveBeenCalledOnce();
    expect(await worker.disposed).toBe(false);
  });

  it("shares disposal with concurrent callers and never turns a failed disposal into success", async () => {
    const f = fixture(), release = deferred<void>(), closeSession = vi.fn(() => release.promise), closeRuntime = vi.fn(async () => undefined);
    const session = { modeStatus: {}, close: closeSession, run: async () => "Done" } as unknown as CodingSession;
    vi.spyOn(CodingRuntime, "start").mockResolvedValue({ client: {} as CopilotClient, close: closeRuntime } as unknown as CodingRuntime);
    vi.spyOn(CodingSession, "create").mockResolvedValue(session);
    const worker = new CodingWorker(f.spec, f.options);
    await worker.run(new AbortController().signal);
    const first = worker.dispose(), second = worker.dispose();
    expect(second).toBe(first);
    expect(closeSession).toHaveBeenCalledOnce();
    expect(closeRuntime).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all([first, second]);
    expect(closeRuntime).toHaveBeenCalledOnce();
    expect(await worker.disposed).toBe(true);

    const broken = new CodingWorker(f.spec, f.options);
    closeSession.mockRejectedValueOnce(new Error("not disconnected"));
    await broken.run(new AbortController().signal);
    await expect(broken.dispose()).rejects.toBeInstanceOf(CodingRuntimeCleanupError);
    await expect(broken.dispose()).rejects.toBeInstanceOf(CodingRuntimeCleanupError);
    expect(closeSession).toHaveBeenCalledTimes(2);
    expect(closeRuntime).toHaveBeenCalledTimes(2);
    expect(await broken.disposed).toBe(false);
  });

  it("denies the 151st native tool call, stops its session, and prevents a successful handoff", async () => {
    const f = fixture();
    f.spec.codingCompletion = true;
    const session = { modeStatus: {}, close: async () => undefined, handoffResult: vi.fn(() => ({ success: true, summary: "Done" })), run: vi.fn((_prompt: string, signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
    })) } as unknown as CodingSession;
    vi.spyOn(CodingRuntime, "start").mockResolvedValue({ client: {} as CopilotClient, close: async () => undefined } as CodingRuntime);
    const create = vi.spyOn(CodingSession, "create").mockResolvedValue(session);
    const worker = new CodingWorker(f.spec, f.options), run = worker.run(new AbortController().signal);
    await vi.waitFor(() => expect(session.run).toHaveBeenCalledOnce());
    const check = create.mock.calls[0][0].preToolUse;
    // Unknown native tool names still consume host budget, irrespective of the runtime's own accounting.
    const input = { toolName: "native_tool", toolArgs: {}, sessionId: "coding-1", timestamp: new Date(), workingDirectory: "/project" };
    for (let i = 0; i < 150; i++) expect(await check(input)).toBeNull();
    expect(await check(input)).toContain("150 tool calls");
    expect(await run).toMatchObject({ success: false, limit: true, summary: expect.stringContaining("150 tool calls") });
    expect(worker.handoffSafe()).toBe(false);
    expect(session.handoffResult).not.toHaveBeenCalled();
    await worker.dispose();
  });
});
