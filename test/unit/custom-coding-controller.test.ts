/* eslint-disable @typescript-eslint/no-explicit-any -- offline SDK event/handler boundary */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CopilotSession } from "@github/copilot-sdk";
import { CodingControllerCleanupError, CustomCodingController, type CustomCodingControllerOptions, type CodingControllerOptions, type FileOnlyCodingControllerOptions } from "../../app/main/agent/custom-coding-controller";
import { ScopedCodingFileError, type CodingFileTools } from "../../app/main/agent/coding-platform";
import { CodingPrivacyCleanupError } from "../../app/main/agent/coding-privacy-scanner";
import { PrivateControllerCleanupError } from "../../app/main/agent/private-controller-runtime";

const sim = vi.hoisted(() => ({ sessions: [] as any[], inputs: [] as any[], drive: null as null | ((session: any) => Promise<void>), stops: 0, calls: 0, createFailure: false,
  runtimeCloseGate: null as Promise<void> | null, runtimeCloseFailure: false, runtimeStartFailure: false }));
vi.mock("../../app/main/agent/private-controller-runtime", async importOriginal => ({ ...await importOriginal<typeof import("../../app/main/agent/private-controller-runtime")>(), PrivateControllerRuntime: {
  start: async (input: unknown) => {
    sim.inputs.push(input);
    if (sim.runtimeStartFailure) throw new PrivateControllerCleanupError();
    return { workingDirectory: "/private/coding-cwd", close: async () => {
      sim.stops++; if (sim.runtimeCloseGate) await sim.runtimeCloseGate;
      if (sim.runtimeCloseFailure) throw new Error("synthetic private runtime cleanup canary");
    }, client: {
      createSession: async (config: any) => {
        if (sim.createFailure) throw new Error("An upstream initialization error echoed a synthetic provider secret");
        const listeners = new Set<(event: any) => void>();
        const session = { config, sessionId: config.sessionId,
          rpc: { tools: { initializeAndValidate: async () => ({}), getCurrentMetadata: async () => ({ tools: config.tools.map((tool: any) => ({ name: tool.name })) }) } },
          on: (listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
          emit: (type: string, data: any) => { for (const listener of listeners) listener({ type, data }); },
          sendAndWait: vi.fn(async () => { await sim.drive?.(session); return undefined; }), abort: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
        };
        sim.sessions.push(session); return session as unknown as CopilotSession;
      }, deleteSession: async () => undefined,
    } };
  },
} }));

const controllers: CustomCodingController[] = [];
beforeEach(() => { sim.sessions = []; sim.inputs = []; sim.drive = null; sim.stops = 0; sim.calls = 0; sim.createFailure = false;
  sim.runtimeCloseGate = null; sim.runtimeCloseFailure = false;
  sim.runtimeStartFailure = false;
});
afterEach(async () => { for (const owner of controllers.splice(0)) await owner.close(); vi.useRealTimers(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const fileRead = () => ({ path: "/work/a.ts", text: "old", sha256: "0".repeat(64), bytes: 3, totalLines: 1, startLine: 1, endLine: 1 });
const fileWrite = () => ({ path: "/work/a.ts", bytes: 3, sha256: "0".repeat(64), created: false });
const withheld = () => ({ hidden: 0, sensitive: 0, unsupported: 0, binary: 0, secrets: 0 });
function fixture(extra: Partial<CustomCodingControllerOptions> = {}) {
  // A plain structural port, with no Linux file-broker private fields or nominal casts.
  const files = {
    list: vi.fn(async () => ({ path: "/work", scope: "direct-children" as const, entries: [{ path: "/work/a.ts", kind: "file" as const, bytes: 3 }], withheld: withheld() })),
    readText: vi.fn(async () => fileRead()), writeText: vi.fn(async () => fileWrite()),
    replaceText: vi.fn(async () => ({ ...fileWrite(), replaced: 1 as const })),
    delete: vi.fn(async () => ({ path: "/work/a.ts", kind: "file" as const, deleted: true as const })),
    mkdir: vi.fn(async () => ({ path: "/work/new", created: true as const })),
    searchLiteral: vi.fn(async () => ({ path: "/work", matches: [], files: 1, withheld: withheld() })), close: vi.fn(async () => undefined),
  } satisfies CodingFileTools;
  const createFiles = vi.fn(async (_signal: AbortSignal) => files);
  const runCommand = vi.fn<CustomCodingControllerOptions["runCommand"]>(async () => ({ result: "<command_output>fixture</command_output>", success: true }));
  const finishCheck = vi.fn(async () => true);
  let current = true;
  const options: CustomCodingControllerOptions = { runtime: { userData: "/private", runtimePath: "/fixed/runtime", env: {} }, model: "fixture",
    files: createFiles, commands: { target: "This computer", shells: ["bash"] }, runCommand, finishCheck, current: () => current, ...extra };
  return { files, createFiles, runCommand, finishCheck, options, retire: () => { current = false; } };
}
async function start(o: CodingControllerOptions) { const c = await CustomCodingController.start(o); controllers.push(c); return c; }
async function call(session: any, name: string, args: unknown, id = `call-${++sim.calls}`) {
  session.emit("assistant.message", { toolRequests: [{ toolCallId: id, name }] });
  session.emit("tool.execution_start", { toolCallId: id, toolName: name });
  const answer = await session.config.tools.find((tool: any) => tool.name === name).handler(args, { toolCallId: id });
  session.emit("tool.execution_complete", { toolCallId: id, success: answer.resultType === "success" });
  return answer;
}
const command = { target: "This computer", command: "node test.js", why: "Check the copied code" };
const finish = (session: any) => call(session, "finish_coding", { success: true, summary: "Observed the requested checks." });

function fileOnly() {
  const f = fixture();
  const { commands: _commands, runCommand: _runCommand, runNode: _runNode, toolchain: _toolchain, ...common } = f.options;
  const options: FileOnlyCodingControllerOptions = { ...common, mode: "files-only" };
  return { ...f, options };
}

it("edits through explicit file-only tools with no command authority and a truthful no-checks notice", async () => {
  const f = fileOnly(), c = await start(f.options), config = sim.sessions[0].config;
  expect(config.tools.map((tool: any) => tool.name).sort()).toEqual(["coding_list", "coding_read", "coding_write", "coding_replace", "coding_delete", "coding_mkdir", "coding_search", "finish_coding"].sort());
  expect(config).toMatchObject({ availableTools: [], enableConfigDiscovery: false, enableFileHooks: false, enableSkills: false,
    enableHostGitOperations: false, pluginDirectories: [], customAgents: [], mcpServers: {}, requestExtensions: false });
  expect(JSON.stringify(config.systemMessage)).toContain("Commands and test execution are unavailable");
  sim.drive = async session => {
    await call(session, "coding_read", { path: "a.ts" });
    await call(session, "coding_replace", { path: "a.ts", oldText: "old", newText: "new" });
    await call(session, "finish_coding", { success: true, summary: "Edited the private copy for review." });
  };
  expect(await c.run("Edit the private file without running commands")).toEqual({ success: true, summary: "Edited the private copy for review. No commands or tests were run." });
  expect(f.files.replaceText).toHaveBeenCalledTimes(1); expect(f.runCommand).not.toHaveBeenCalled();
  expect(f.finishCheck).toHaveBeenCalledTimes(2);
});

it.each(["run_command", "powershell", "shell", "view", "create_file", "spawn_agent", "web_fetch"])("refuses an invented execution or native tool in file-only mode: %s", async name => {
  const f = fileOnly(), c = await start(f.options);
  sim.drive = async session => {
    session.emit("assistant.message", { toolRequests: [{ toolCallId: "unavailable", name }] });
    expect(session.config.tools.some((tool: any) => tool.name === name)).toBe(false);
    await call(session, "finish_coding", { success: true, summary: "No execution was available." });
  };
  expect((await c.run("Review copied files")).success).toBe(false);
  expect(f.runCommand).not.toHaveBeenCalled(); expect(f.files.readText).not.toHaveBeenCalled();
});

it("never converts a missing command capability into file-only mode implicitly", async () => {
  const f = fixture();
  await expect(CustomCodingController.start({ ...f.options, commands: { target: "This computer", shells: [] } })).rejects.toThrow("command capability is invalid");
  await expect(CustomCodingController.start({ ...f.options, mode: "files-only" } as unknown as FileOnlyCodingControllerOptions)).rejects.toThrow("command capability is invalid");
  await expect(CustomCodingController.start({ ...fileOnly().options, mode: "unknown" } as unknown as CodingControllerOptions)).rejects.toThrow("command capability is invalid");
  expect(sim.inputs).toEqual([]);
});

it("revokes a pending file-only read before accepting its result and drains normal teardown", async () => {
  const f = fileOnly(), entered = deferred<void>(), release = deferred<void>();
  f.files.readText.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return fileRead(); });
  const c = await start(f.options);
  sim.drive = async session => { const read = await call(session, "coding_read", { path: "a.ts" }); expect(read.resultType).toBe("failure"); };
  const running = c.run("Read copied text"); await entered.promise; f.retire(); release.resolve();
  expect((await running).success).toBe(false);
  await c.close(); expect(f.files.close).toHaveBeenCalledTimes(1); expect(sim.stops).toBe(1);
});

it("creates a fresh hardened custom-only session, delegates commands and requires explicit settled completion", async () => {
  const f = fixture(), c = await start(f.options);
  const config = sim.sessions[0].config;
  expect(config).toMatchObject({ workingDirectory: "/private/coding-cwd", enableConfigDiscovery: false, availableTools: [], enableFileHooks: false,
    enableSkills: false, enableHostGitOperations: false, skipCustomInstructions: true, mcpServers: {}, pluginDirectories: [], customAgents: [], requestExtensions: false });
  expect(config.systemMessage.mode).toBe("customize"); expect(config.systemMessage.sections).not.toHaveProperty("safety");
  expect(config.tools.map((tool: any) => tool.name).sort()).toEqual(["coding_list", "coding_read", "coding_write", "coding_replace", "coding_delete", "coding_mkdir", "coding_search", "run_command", "finish_coding"].sort());
  sim.drive = async session => { await call(session, "coding_read", { path: "a.ts" }); await call(session, "run_command", command); await finish(session); };
  expect(await c.run("Verify the copied code")).toEqual({ success: true, summary: "Observed the requested checks." });
  expect(f.files.readText).toHaveBeenCalledWith("a.ts", { startLine: undefined, endLine: undefined });
  expect(f.runCommand).toHaveBeenCalledWith(command, expect.objectContaining({ signal: expect.any(AbortSignal), waiting: expect.any(Function) }));
  expect(f.finishCheck).toHaveBeenCalledTimes(2);
});

it("cleans up a failed initialization without exposing upstream exception text", async () => {
  const f = fixture(); sim.createFailure = true;
  await expect(CustomCodingController.start(f.options)).rejects.toThrow("The coding controller could not be initialized safely.");
  expect(f.files.close).toHaveBeenCalledTimes(1); expect(sim.stops).toBe(1);
});

it("preserves a typed cleanup failure when initialization fails before the controller can be returned", async () => {
  const f = fixture(); sim.createFailure = true; f.files.close.mockRejectedValueOnce(new Error("untrusted cleanup diagnostic"));
  await expect(CustomCodingController.start(f.options)).rejects.toBeInstanceOf(CodingControllerCleanupError);
});

it("preserves unknown runtime retirement when startup rejected before the controller received its runtime", async () => {
  const f = fixture(); sim.runtimeStartFailure = true;
  await expect(CustomCodingController.start(f.options)).rejects.toBeInstanceOf(CodingControllerCleanupError);
  expect(sim.stops).toBe(0); expect(f.createFiles).not.toHaveBeenCalled(); expect(sim.sessions).toEqual([]);
});

it("preserves a file-factory privacy cleanup failure after awaiting normal controller retirement", async () => {
  const failure = new CodingPrivacyCleanupError(), retired = deferred<void>();
  const f = fixture({ files: async () => { throw failure; } });
  sim.runtimeCloseGate = retired.promise;
  let settled = false;
  const starting = CustomCodingController.start(f.options).then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
  try {
    await vi.waitFor(() => expect(sim.stops).toBe(1));
    expect(settled).toBe(false); expect(sim.sessions).toHaveLength(0);
    expect(f.files.close).not.toHaveBeenCalled(); // The factory rejected before assigning a broker to the controller.
    retired.resolve();
    expect(await starting).toBe(failure);
  } finally { retired.resolve(); await starting; }
});

it("retains controller cleanup failure precedence over a file-factory privacy failure", async () => {
  const privacyFailure = new CodingPrivacyCleanupError();
  const f = fixture({ files: async () => { throw privacyFailure; } }); sim.runtimeCloseFailure = true;
  const failure = await CustomCodingController.start(f.options).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(CodingControllerCleanupError);
  expect(failure).not.toBe(privacyFailure);
  expect(String(failure)).not.toContain("synthetic private runtime cleanup canary");
  expect(sim.stops).toBe(1); expect(sim.sessions).toHaveLength(0);
});

it("sanitizes an unrelated file-factory initialization error", async () => {
  const f = fixture({ files: async () => { throw new Error("private file factory path canary"); } });
  const failure = await CustomCodingController.start(f.options).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(CodingPrivacyCleanupError);
  expect(failure).toEqual(expect.objectContaining({ message: "The coding controller could not be initialized safely." }));
  expect(String(failure)).not.toContain("private file factory path canary");
  expect(sim.stops).toBe(1); expect(sim.sessions).toHaveLength(0);
});

it("rejects invalid tool arguments before a broker or command callback can run", async () => {
  const f = fixture(), c = await start(f.options);
  sim.drive = async session => {
    expect((await call(session, "coding_read", { path: "a.ts", grant: "/private" })).resultType).toBe("failure");
    expect((await call(session, "run_command", { ...command, env: { token: "bad" } })).resultType).toBe("failure");
    await finish(session);
  };
  expect((await c.run("Inspect copied code")).success).toBe(false);
  expect(f.files.readText).not.toHaveBeenCalled(); expect(f.runCommand).not.toHaveBeenCalled();
});

it("rejects another command target before invoking the injected policy callback", async () => {
  const f = fixture(), c = await start(f.options);
  sim.drive = async session => { await call(session, "run_command", { ...command, target: "Another computer" }); await finish(session); };
  expect((await c.run("Check copied code")).success).toBe(false);
  expect(f.runCommand).not.toHaveBeenCalled();
});

it("does not dispatch a model request for an already-aborted run signal", async () => {
  const f = fixture(), c = await start(f.options), signal = new AbortController(); signal.abort();
  expect(await c.run("Inspect copied code", signal.signal)).toMatchObject({ success: false, stopped: true });
  expect(sim.sessions[0].sendAndWait).not.toHaveBeenCalled();
});

it("never substitutes model success for a failed observed command result", async () => {
  const f = fixture(); f.runCommand.mockResolvedValue({ result: "The model says it succeeded", success: false });
  const c = await start(f.options);
  sim.drive = async session => { await call(session, "run_command", command); await finish(session); };
  expect((await c.run("Run the copied test")).success).toBe(false);
});

it("can fix copied code and recover a fully observed failed check by rerunning that exact check", async () => {
  const f = fixture(), key = "a".repeat(64);
  f.runCommand.mockResolvedValueOnce({ result: { resultType: "failure", textResultForLlm: "Exit 1: assertion failed" }, success: false, check: { key, passed: false } })
    .mockResolvedValueOnce({ result: "Exit 0: assertion passed", success: true, check: { key, passed: true } });
  const c = await start(f.options);
  sim.drive = async session => {
    expect((await call(session, "run_command", command)).resultType).toBe("success");
    const premature = await finish(session);
    expect(premature.resultType).toBe("success"); expect(premature.textResultForLlm).toContain("Finish not recorded");
    await call(session, "coding_replace", { path: "fixture.ts", oldText: "wrong", newText: "right" });
    await call(session, "run_command", command);
    await finish(session);
  };
  expect((await c.run("Fix the copied failing test")).success).toBe(true);
  expect(f.files.replaceText).toHaveBeenCalledTimes(1); expect(f.runCommand).toHaveBeenCalledTimes(2);
});

it("a different check key cannot clear the original failure and an honest incomplete finish remains available", async () => {
  const f = fixture();
  f.runCommand.mockResolvedValueOnce({ result: "Exit 1: original check failed", success: false, check: { key: "a".repeat(64), passed: false } })
    .mockResolvedValueOnce({ result: "Exit 0: different check passed", success: true, check: { key: "b".repeat(64), passed: true } });
  const c = await start(f.options);
  sim.drive = async session => {
    await call(session, "run_command", command);
    await call(session, "run_command", { ...command, command: "node other-test.js" });
    expect((await finish(session)).textResultForLlm).toContain("Finish not recorded");
    await call(session, "finish_coding", { success: false, summary: "The original check remains failing." });
  };
  expect(await c.run("Check the copied project")).toEqual({ success: false, summary: "The original check remains failing." });
});

it("a failing observed check does not make a concurrent finish framing error recoverable", async () => {
  const f = fixture(); f.runCommand.mockResolvedValue({ result: "Exit 1", success: false, check: { key: "a".repeat(64), passed: false } });
  const c = await start(f.options);
  sim.drive = async session => {
    await call(session, "run_command", command);
    const id = "batched-finish";
    session.emit("assistant.message", { toolRequests: [{ toolCallId: id, name: "finish_coding" }, { toolCallId: "other-call", name: "coding_read" }] });
    session.emit("tool.execution_start", { toolCallId: id, toolName: "finish_coding" });
    session.emit("tool.execution_start", { toolCallId: "other-call", toolName: "coding_read" });
    const answer = await session.config.tools.find((tool: any) => tool.name === "finish_coding").handler({ success: true, summary: "wrong framing" }, { toolCallId: id });
    expect(answer.resultType).toBe("failure");
    session.emit("tool.execution_complete", { toolCallId: id, success: false });
    session.emit("tool.execution_complete", { toolCallId: "other-call", success: true });
    f.runCommand.mockResolvedValue({ result: "Exit 0", success: true, check: { key: "a".repeat(64), passed: true } });
    await call(session, "run_command", command); await finish(session);
  };
  expect((await c.run("Check copied code")).success).toBe(false);
});

it("a later passing check cannot erase a denied or unobserved command", async () => {
  const f = fixture();
  f.runCommand.mockResolvedValueOnce({ result: "The user refused this command", success: false })
    .mockResolvedValueOnce({ result: "Exit 0", success: true, check: { key: "a".repeat(64), passed: true } });
  const c = await start(f.options);
  sim.drive = async session => { await call(session, "run_command", command); await call(session, "run_command", command); await finish(session); };
  expect((await c.run("Check copied code")).success).toBe(false);
});

it.each([
  { key: "bad", passed: true }, { key: "a".repeat(64), passed: false },
])("rejects malformed or contradictory host check evidence %j", async check => {
  const f = fixture(); f.runCommand.mockResolvedValue({ result: "Exit 0", success: true, check });
  const c = await start(f.options); sim.drive = async session => { await call(session, "run_command", command); await finish(session); };
  expect((await c.run("Check copied code")).success).toBe(false);
});

it.each(["missing", "exists", "conflict", "ambiguous", "not-empty"] as const)("a validated no-mutation file error %s can be corrected without declaring a permission refusal", async code => {
  const f = fixture(); f.files.readText.mockRejectedValueOnce(new ScopedCodingFileError(code));
  const c = await start(f.options);
  sim.drive = async session => {
    const response = await call(session, "coding_read", { path: "missing.ts" });
    expect(response.resultType).toBe("success"); expect(response.textResultForLlm).toContain('"operationApplied":false');
    await call(session, "coding_read", { path: "correct.ts" }); await finish(session);
  };
  expect((await c.run("Inspect the correct copied file")).success).toBe(true);
});

it.each(["path", "boundary", "unsupported", "privacy", "binary", "secret", "limit", "io", "cancelled"] as const)("file error %s remains fatal despite a later ordinary operation", async code => {
  const f = fixture(); f.files.readText.mockRejectedValueOnce(new ScopedCodingFileError(code));
  const c = await start(f.options);
  sim.drive = async session => { await call(session, "coding_read", { path: "blocked.ts" }); await call(session, "coding_read", { path: "other.ts" }); await finish(session); };
  expect((await c.run("Inspect copied code")).success).toBe(false);
});

it("does not recover or expose a native error merely because it resembles a platform file error", async () => {
  const f = fixture();
  f.files.readText.mockRejectedValueOnce(Object.assign(new Error("private native path canary"), { code: "missing" }));
  let response: any;
  const c = await start(f.options);
  sim.drive = async session => { response = await call(session, "coding_read", { path: "a.ts" }); await finish(session); };
  expect((await c.run("Inspect copied code")).success).toBe(false);
  expect(response.resultType).toBe("failure");
  expect(response.textResultForLlm).not.toContain("private native path canary");
  expect(response.textResultForLlm).not.toContain('"operationApplied":false');
});

it("rejects missing completion and a backend that cannot establish quiescence", async () => {
  const f = fixture(), c = await start(f.options);
  sim.drive = async session => { await call(session, "coding_list", {}); };
  expect(await c.run("Inspect the copied files")).toMatchObject({ success: false, summary: expect.stringContaining("explicit") });
  const other = fixture(); other.finishCheck.mockResolvedValue(false);
  const second = await start(other.options); sim.drive = finish;
  expect((await second.run("Report copied results")).success).toBe(false);
});

it("does not report a provider failure as a user Stop or expose its error text", async () => {
  const f = fixture(), c = await start(f.options);
  sim.drive = async () => { throw new Error("untrusted provider error with a synthetic secret"); };
  expect(await c.run("Inspect copied code")).toEqual({ success: false, summary: "The coding model could not finish the task." });
});

it("fails when the final backend settlement check changes after finish was recorded", async () => {
  const f = fixture(); f.finishCheck.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const c = await start(f.options); sim.drive = finish;
  expect(await c.run("Report copied results")).toEqual({ success: false, summary: "The coding workspace could not be verified as quiescent." });
});

it("revokes file/command lifetimes and blocks queued writes after Stop", async () => {
  const f = fixture(), pending = deferred<ReturnType<typeof fileRead>>(); f.files.readText.mockImplementation(() => pending.promise);
  const c = await start(f.options);
  sim.drive = async session => { await Promise.all([call(session, "coding_read", { path: "a.ts" }), call(session, "coding_write", { path: "b.ts", text: "bad" })]); };
  const running = c.run("Inspect copied code");
  await vi.waitFor(() => expect(f.files.readText).toHaveBeenCalledTimes(1));
  const stopped = c.stop(); expect(f.createFiles.mock.calls[0][0].aborted).toBe(true);
  expect(f.files.writeText).not.toHaveBeenCalled(); pending.resolve(fileRead()); await stopped;
  expect(await running).toMatchObject({ success: false, stopped: true }); expect(f.files.writeText).not.toHaveBeenCalled();
});

it("retires on a stale owner before any further tool can execute", async () => {
  const f = fixture(), c = await start(f.options);
  sim.drive = async session => { f.retire(); await call(session, "coding_write", { path: "b.ts", text: "bad" }); };
  expect((await c.run("Update copied code")).success).toBe(false);
  expect(f.files.writeText).not.toHaveBeenCalled();
});

it("never forwards events from a stale owner to host observers", async () => {
  const onEvent = vi.fn(), f = fixture({ onEvent }), c = await start(f.options);
  sim.drive = async session => { f.retire(); session.emit("assistant.message", { content: "old account data" }); };
  expect((await c.run("Inspect copied code")).success).toBe(false);
  expect(onEvent).not.toHaveBeenCalled();
});

it("drains an active tool even if the SDK abort request fails before closing file authority", async () => {
  const f = fixture(), pending = deferred<ReturnType<typeof fileRead>>(); f.files.readText.mockImplementation(() => pending.promise);
  const c = await start(f.options);
  sim.sessions[0].abort.mockRejectedValue(new Error("synthetic abort failure"));
  sim.drive = async session => { await call(session, "coding_read", { path: "a.ts" }); };
  const running = c.run("Read copied code");
  await vi.waitFor(() => expect(f.files.readText).toHaveBeenCalledTimes(1));
  const closing = c.close(); void closing.catch(() => undefined);
  await Promise.resolve(); await Promise.resolve();
  expect(f.files.close).not.toHaveBeenCalled();
  pending.resolve(fileRead());
  expect(await running).toMatchObject({ success: false, stopped: true });
  await expect(closing).rejects.toThrow("could not be closed safely");
  expect(f.files.close).toHaveBeenCalledTimes(1);
  controllers.splice(controllers.indexOf(c), 1);
});

it("reserves the fixed 150-call budget before asynchronous calls can queue more work", async () => {
  const f = fixture(), c = await start(f.options);
  sim.drive = async session => { await Promise.all(Array.from({ length: 151 }, () => call(session, "coding_list", {}))); };
  expect(await c.run("Inspect copied code")).toMatchObject({ success: false, limit: true });
  expect(f.files.list).not.toHaveBeenCalled();
});

it("counts unavailable native tool requests toward the same fixed task budget", async () => {
  const f = fixture(), c = await start(f.options);
  sim.drive = async session => {
    for (let index = 0; index < 151; index++) session.emit("assistant.message", { toolRequests: [{ toolCallId: `ungranted-${index}`, name: "bash" }] });
  };
  expect(await c.run("Inspect copied code")).toMatchObject({ success: false, limit: true });
  expect(f.files.list).not.toHaveBeenCalled(); expect(f.runCommand).not.toHaveBeenCalled();
});

it("cannot bypass the budget by reusing a model-supplied tool call id", async () => {
  const f = fixture(), c = await start(f.options);
  sim.drive = async session => {
    for (let index = 0; index < 151; index++) await call(session, "coding_list", {}, "reused-call-id");
  };
  expect(await c.run("Inspect copied code")).toMatchObject({ success: false, limit: true });
  expect(f.files.list).toHaveBeenCalledTimes(150);
});

it("stops a silent model after the fixed 20 active minutes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const f = fixture(), c = await start(f.options);
  sim.drive = () => new Promise<void>(() => undefined);
  const run = c.run("Inspect copied code");
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  expect(await run).toMatchObject({ success: false, limit: true, summary: expect.stringContaining("20 minutes") });
});

it("pauses the active-time budget for an injected human clarification", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const answer = deferred<{ answer: string; wasFreeform: boolean }>();
  const clarify = vi.fn(() => answer.promise), f = fixture({ clarify }), c = await start(f.options);
  sim.drive = async session => { await call(session, "ask_coding_question", { question: "Which fixture?", choices: ["one", "two"], allowFreeform: false }); await finish(session); };
  const run = c.run("Inspect the chosen copied fixture");
  await vi.advanceTimersByTimeAsync(0);
  expect(clarify).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(21 * 60_000);
  expect(f.createFiles.mock.calls[0][0].aborted).toBe(false);
  answer.resolve({ answer: "one", wasFreeform: false });
  expect((await run).success).toBe(true);
});

it("does not allow an additional tool after explicit finish", async () => {
  const f = fixture(), c = await start(f.options);
  sim.drive = async session => { await finish(session); await call(session, "coding_write", { path: "b.ts", text: "bad" }); };
  expect((await c.run("Report copied code")).success).toBe(false);
  expect(f.files.writeText).not.toHaveBeenCalled();
});


it("offers direct Node only with a captured host capability and sends literal argv to its guarded callback", async () => {
  const runNode = vi.fn<NonNullable<CustomCodingControllerOptions["runNode"]>>(async () => ({ result: "checked", success: true }));
  const f = fixture({ commands: { target: "This computer", shells: ["bash"], node: true }, runNode });
  const c = await start(f.options), args = { argv: ["tool.js", "", "a b", "$(echo literal)"], cwd: "/work", why: "Verify the copy" };
  sim.drive = async session => { await call(session, "run_node", args); await finish(session); };
  expect((await c.run("Verify the copied code")).success).toBe(true);
  expect(runNode).toHaveBeenCalledWith(args, expect.objectContaining({ signal: expect.any(AbortSignal), waiting: expect.any(Function) }));
  expect(f.runCommand).not.toHaveBeenCalled();
});

it.each([{ argv: ["--version"], shell: "bash" }, { argv: ["--version"], env: {} }, { argv: ["--version"], executable: "/tmp/node" },
  { argv: ["x\0y"] }, { argv: ["\ud800"] }, { argv: ["x".repeat(8000)] }])("rejects invalid direct-Node arguments before the callback %#", async raw => {
  const runNode = vi.fn<NonNullable<CustomCodingControllerOptions["runNode"]>>(async () => ({ result: "", success: true }));
  const f = fixture({ commands: { target: "This computer", shells: ["bash"], node: true }, runNode }), c = await start(f.options);
  sim.drive = async session => { expect((await call(session, "run_node", { why: "Check the copy", ...raw })).resultType).toBe("failure"); await finish(session); };
  expect((await c.run("Check the code")).success).toBe(false); expect(runNode).not.toHaveBeenCalled();
});

it("does not let shell success clear a failing direct-Node check", async () => {
  const nodeKey = "d".repeat(64), shellKey = "e".repeat(64);
  const runNode = vi.fn<NonNullable<CustomCodingControllerOptions["runNode"]>>()
    .mockResolvedValueOnce({ result: "Exit 1", success: false, check: { key: nodeKey, passed: false } })
    .mockResolvedValueOnce({ result: "Exit 0", success: true, check: { key: nodeKey, passed: true } });
  const f = fixture({ commands: { target: "This computer", shells: ["bash"], node: true }, runNode });
  f.runCommand.mockResolvedValue({ result: "Exit 0", success: true, check: { key: shellKey, passed: true } });
  const c = await start(f.options);
  sim.drive = async session => {
    await call(session, "run_node", { argv: ["test.js"], why: "Check the copy" });
    await call(session, "run_command", command);
    expect((await finish(session)).textResultForLlm).toContain("Finish not recorded");
    await call(session, "coding_replace", { path: "test.js", oldText: "bad", newText: "good" });
    await call(session, "run_node", { argv: ["test.js"], why: "Check the copy" }); await finish(session);
  };
  expect((await c.run("Fix the failed check")).success).toBe(true); expect(runNode).toHaveBeenCalledTimes(2);
});

it("rejects injected direct-Node capability in file-only mode before starting a runtime", async () => {
  const f = fileOnly();
  await expect(CustomCodingController.start(Object.assign(f.options, { runNode: async () => ({ result: "", success: true }) }))).rejects.toThrow("capability is invalid");
  expect(sim.inputs).toHaveLength(0);
});


it("starts a Node-only controller with no shell tool or shell instructions", async () => {
  const runNode = vi.fn<NonNullable<CustomCodingControllerOptions["runNode"]>>(async () => ({ result: "checked", success: true }));
  const f = fixture(), { runCommand: _runCommand, ...base } = f.options;
  const c = await start({ ...base, commands: { target: "This computer", shells: [], node: true }, runNode });
  expect(sim.sessions[0].config.tools.map((tool: any) => tool.name)).toContain("run_node");
  expect(sim.sessions[0].config.tools.map((tool: any) => tool.name)).not.toContain("run_command");
  expect(JSON.stringify(sim.sessions[0].config.systemMessage)).not.toContain("run_command");
  sim.drive = async session => { await call(session, "run_node", { argv: ["--version"], why: "Verify the copy" }); await finish(session); };
  expect((await c.run("Verify the copied code")).success).toBe(true); expect(runNode).toHaveBeenCalledTimes(1); expect(f.runCommand).not.toHaveBeenCalled();
});

it("adds only the fixed host Windows constraints to a genuine Node-only tool inventory", async () => {
  const f = fixture(), { commands: _commands, runCommand: _runCommand, ...base } = f.options;
  const runNode = vi.fn<NonNullable<CustomCodingControllerOptions["runNode"]>>(async () => ({ result: "checked", success: true }));
  await start({ ...base, commands: { target: "This computer", shells: [], node: true }, runNode, toolchain: "windows-node" });
  const config = sim.sessions[0].config, text = JSON.stringify(config.systemMessage);
  expect(text).toContain("Only bundled Node is supplied"); expect(text).toContain("--experimental-test-isolation=none");
  expect(config.tools.map((tool: any) => tool.name)).toContain("run_node");
  expect(config.tools.map((tool: any) => tool.name)).not.toContain("run_command");
});

it("rejects Windows Node constraints on shell and files-only capabilities before starting the controller runtime", async () => {
  const f = fixture();
  await expect(CustomCodingController.start({ ...f.options, toolchain: "windows-node" })).rejects.toThrow("toolchain capability is invalid");
  await expect(CustomCodingController.start({ ...fileOnly().options, toolchain: "windows-node" } as unknown as CodingControllerOptions)).rejects.toThrow("toolchain capability is invalid");
  expect(sim.inputs).toEqual([]);
});

it("rejects neither-lane and forged Node-only startup before creating the runtime", async () => {
  const f = fixture(), { runCommand: _runCommand, ...base } = f.options;
  for (const capability of [{ commands: { target: "This computer", shells: [] } }, { commands: { target: "This computer", shells: [], node: true } },
    { commands: { target: "This computer", shells: [], node: true }, runCommand: f.runCommand, runNode: async () => ({ result: "", success: true }) }]) {
    await expect(CustomCodingController.start({ ...base, ...capability } as CodingControllerOptions)).rejects.toThrow("capability is invalid");
  }
  expect(sim.inputs).toHaveLength(0);
});
