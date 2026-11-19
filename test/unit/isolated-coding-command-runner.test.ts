import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { IsolatedCodingCommandRunner, type ObservedCodingCommand } from "../../app/main/agent/isolated-coding-command-runner";
import type { RunnerFacts, RunSpec, ShellId } from "../../app/main/commands/types";
import { nodeInvocationSha256, type NodeRunSpec } from "../../app/main/commands/node-invocation";

const facts: RunnerFacts = { os: "linux", shells: ["bash"], shellPaths: { bash: "/usr/bin/bash" }, script: null,
  home: "/state", user: "fixture", privileged: false, pty: false, ember: { paths: ["/host/private"], pids: [123], names: /ember/i }, extraPath: [] };
const observed: ObservedCodingCommand = { observed: true, exitCode: 0, signal: null, stopped: false, timedOut: false, outputLimited: false };
const spec = (command = "node --test", shell: ShellId = "bash"): RunSpec => ({ runId: "0123456789abcdef", taskId: "fixture-task", shell, command, cwd: "/work", timeoutMs: 1000, cols: 80, rows: 24,
  stamp: { taskId: "fixture-task", sha256: createHash("sha256").update(`local\0${shell}\0/work\0${command}`).digest("hex"), verdict: "run", classes: [], rules: [], approval: null } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
function setup(runnerFacts: RunnerFacts = facts, nodeAvailable = false) {
  const owner = new AbortController();
  const state = { current: true };
  const run = vi.fn(async (_command: string, _cwd: string, output: (bytes: Uint8Array, stream: "stdout" | "stderr") => void, _signal: AbortSignal, _shell: ShellId) => { output(Buffer.from("passed\n"), "stdout"); return observed; });
  const runNode = vi.fn(async (_argv: readonly string[], _cwd: string, output: (bytes: Uint8Array, stream: "stdout" | "stderr") => void, _signal: AbortSignal) => { output(Buffer.from("node passed\n"), "stdout"); return observed; });
  const stop = vi.fn(async (): Promise<void> => undefined);
  const inspect = vi.fn(async (paths: string[]) => paths.map(() => ({ exists: true, real: "/work/file.ts" })));
  const workspace = { executionRoot: "/work", nodeAvailable, run, runNode, stop };
  const runner = new IsolatedCodingCommandRunner({ workspace, facts: runnerFacts, inspect,
    current: () => state.current, signal: owner.signal });
  return { runner, run, runNode, workspace, stop, inspect, state, owner };
}
afterEach(() => vi.useRealTimers());

it("binds decided bytes before yielding and exposes only observed exit metadata", async () => {
  const { runner, run } = setup();
  const input = spec();
  const command = runner.start(input);
  input.command = "different command";
  input.cwd = "/elsewhere";
  input.shell = "powershell";
  expect(await command.done).toMatchObject({ code: 0, ended: "exit" });
  expect(run).toHaveBeenCalledWith("node --test", "/work", expect.any(Function), expect.any(AbortSignal), "bash");
  expect(runner.exitsAfter(0)).toMatchObject([{ sequence: 1, runId: input.runId, exit: { code: 0, ended: "exit" } }]);
  expect(JSON.stringify(runner.exitsAfter(0))).not.toContain("node --test");
  expect(command.interactive).toBe(false);
});

it("rejects changed stamps or unsupported shells before executing without disabling later valid work", async () => {
  const { runner, run } = setup();
  const changed = spec(); changed.command = "modified after approval";
  expect(await runner.start(changed).done).toMatchObject({ ended: "failed-to-start" });
  expect(await runner.start(spec("Write-Output safe", "powershell")).done).toMatchObject({ ended: "failed-to-start" });
  expect(run).not.toHaveBeenCalled();
  expect(await runner.start(spec()).done).toMatchObject({ ended: "exit", code: 0 });
});

it("preserves the decided grammar and literal bytes for a port advertising another shell", async () => {
  const { runner, run } = setup({ ...facts, os: "win32", shells: ["powershell"], shellPaths: { powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" } });
  const text = "Write-Output 'literal $HOME; & | ` value'";
  const input = spec(text, "powershell");
  const command = runner.start(input);
  input.shell = "bash";
  input.command = "printf substituted";
  expect(await command.done).toMatchObject({ ended: "exit", code: 0 });
  expect(run).toHaveBeenCalledWith(text, "/work", expect.any(Function), expect.any(AbortSignal), "powershell");
});

it("returns a failed observation for malformed requests without throwing or starting a process", async () => {
  const { runner, run } = setup();
  for (const input of [undefined, null, "command", [], () => undefined]) {
    expect(await runner.start(input as unknown as RunSpec).done).toMatchObject({ ended: "failed-to-start" });
  }
  expect(run).not.toHaveBeenCalled();
});

it("replays bounded original output to late subscribers without sharing mutable bytes", async () => {
  const { runner } = setup();
  const command = runner.start(spec());
  await command.done;
  command.onOutput(bytes => { bytes.fill(0); });
  const received: string[] = [];
  command.onOutput(bytes => received.push(Buffer.from(bytes).toString("utf8")));
  expect(received).toEqual(["passed\n"]);
});

it("does not resolve a timed-out command before its backend confirms writer shutdown", async () => {
  vi.useFakeTimers();
  const { runner, run } = setup();
  const end = deferred<ObservedCodingCommand>();
  let signal: AbortSignal | undefined;
  run.mockImplementationOnce(async (_command, _cwd, _output, active) => { signal = active; return await end.promise; });
  const command = runner.start({ ...spec(), timeoutMs: 20 });
  let complete = false; void command.done.then(() => { complete = true; });
  await vi.advanceTimersByTimeAsync(21);
  expect(signal?.aborted).toBe(true);
  expect(complete).toBe(false);
  end.resolve({ ...observed, stopped: true });
  expect(await command.done).toMatchObject({ ended: "timeout" });
});

it("shares Stop completion and revokes queued admission before waiting on native shutdown", async () => {
  const { runner, run, stop } = setup();
  const end = deferred<void>(); stop.mockImplementationOnce(async () => { await end.promise; });
  const queued = runner.start(spec());
  const stopping = runner.stopAll("killswitch");
  expect(runner.stopAll("quit")).toBe(stopping);
  expect(await queued.done).toMatchObject({ ended: "stopped-task" });
  expect(run).not.toHaveBeenCalled();
  let complete = false; void stopping.then(() => { complete = true; });
  await Promise.resolve(); expect(complete).toBe(false);
  end.resolve(); await stopping;
  expect(stop).toHaveBeenCalledTimes(1);
  expect(await runner.start(spec()).done).toMatchObject({ ended: "stopped-task" });
});

it("treats unverified native shutdown as lost and fences later work", async () => {
  const { runner, run } = setup();
  run.mockRejectedValueOnce(new Error("untrusted backend diagnostic"));
  const exit = await runner.start(spec()).done;
  expect(exit).toMatchObject({ ended: "lost", endLost: true, outputCut: true });
  expect(JSON.stringify(exit)).not.toContain("untrusted backend diagnostic");
  await runner.start(spec()).done;
  expect(run).toHaveBeenCalledTimes(1);
});

it("withholds a delayed inspection after its context changes", async () => {
  const { runner, inspect, state } = setup();
  const end = deferred<{ exists: boolean; real: string }[]>();
  inspect.mockImplementationOnce(async () => await end.promise);
  const pending = runner.inspect(["source.ts"], "/work");
  state.current = false;
  end.resolve([{ exists: true, real: "/work/private.ts" }]);
  expect(await pending).toEqual([{ exists: null, real: null }]);
});

it("bounds buffered output and awaits shutdown after the output limit is exceeded", async () => {
  const { runner, run } = setup();
  run.mockImplementationOnce(async (_command, _cwd, output, signal) => {
    output(new Uint8Array(256 * 1024), "stdout");
    output(new Uint8Array(1), "stderr");
    expect(signal.aborted).toBe(true);
    return { ...observed, stopped: true, outputLimited: true };
  });
  expect(await runner.start(spec()).done).toMatchObject({ ended: "stopped-task", outputCut: true });
});


const nodeSpec = (argv: readonly string[] = ["--test", "check.cjs"]): NodeRunSpec => ({ kind: "node", argv: [...argv],
  runId: "fedcba9876543210", taskId: "fixture-task", cwd: "/work", timeoutMs: 1000, cols: 80, rows: 24,
  stamp: { taskId: "fixture-task", sha256: nodeInvocationSha256("local", "/work", argv), verdict: "run", classes: [], rules: [], approval: null } });

it("captures literal Node arguments and its bound backend before yielding without inventing a shell", async () => {
  const { runner, run, runNode, workspace } = setup({ ...facts, shells: [], shellPaths: {} }, true);
  const argv = ["-e", "process.stdout.write('literal')", "--", "", "two words", "'quoted'", "$HOME", "$(touch marker)", "*", "é"];
  const input = nodeSpec(argv), started = runner.startNode(input);
  (input.argv as string[]).fill("mutated"); input.cwd = "/elsewhere";
  workspace.runNode = vi.fn(async () => { throw new Error("replaced capability"); });
  expect(await started.done).toMatchObject({ ended: "exit", code: 0 });
  expect(runNode).toHaveBeenCalledWith(argv, "/work", expect.any(Function), expect.any(AbortSignal));
  expect(workspace.runNode).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  expect(runner.nodeAvailable).toBe(true);
});

it("captures Node availability at construction and refuses an absent capability without disabling shell work", async () => {
  const { runner, runNode, workspace } = setup();
  workspace.nodeAvailable = true;
  expect(runner.nodeAvailable).toBe(false);
  expect(await runner.startNode(nodeSpec()).done).toMatchObject({ ended: "failed-to-start" });
  expect(runNode).not.toHaveBeenCalled();
  expect(await runner.start(spec()).done).toMatchObject({ ended: "exit", code: 0 });
  const missing = new IsolatedCodingCommandRunner({ workspace: { ...workspace, nodeAvailable: true, runNode: undefined },
    facts, inspect: async () => [], current: () => true, signal: new AbortController().signal });
  expect(missing.nodeAvailable).toBe(false);
  expect(await missing.startNode(nodeSpec()).done).toMatchObject({ ended: "failed-to-start" });
  expect(runNode).not.toHaveBeenCalled();
});

it("rejects invalid Node argument boundaries, mixed shell requests and stale approval identities before dispatch", async () => {
  const { runner, run, runNode } = setup(facts, true);
  const invalid: unknown[] = [null, undefined, [], "node", () => undefined,
    { ...nodeSpec(), argv: ["a\0b"] }, { ...nodeSpec(), argv: ["\ud800"] }, { ...nodeSpec(), argv: Array(257).fill("") },
    { ...nodeSpec(), argv: ["é".repeat(4000)] }, { ...nodeSpec(), argv: ["changed"] }, { ...nodeSpec(), cwd: "/work/other" },
    { ...nodeSpec(), kind: "shell" }, { ...nodeSpec(), shell: "bash" }, { ...nodeSpec(), command: "node --test" },
    { ...nodeSpec(), timeoutMs: 0 }, { ...nodeSpec(), stamp: spec().stamp }];
  for (const input of invalid) expect(await runner.startNode(input as NodeRunSpec).done).toMatchObject({ ended: "failed-to-start" });
  expect(runNode).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  expect(await runner.startNode(nodeSpec()).done).toMatchObject({ ended: "exit", code: 0 });
});

it("keeps shell and Node observations in one sequence with separate exact check identities and no raw arguments", async () => {
  const { runner } = setup(facts, true);
  const literal = "ARGUMENT_PRIVACY_CANARY", direct = nodeSpec(["test.cjs", literal]);
  await runner.start(spec()).done; await runner.startNode(direct).done;
  const exits = runner.exitsAfter(0);
  expect(exits.map(exit => [exit.sequence, exit.checkKey])).toEqual([[1, spec().stamp.sha256], [2, direct.stamp.sha256]]);
  expect(exits[0].checkKey).not.toBe(exits[1].checkKey);
  expect(JSON.stringify(exits)).not.toContain(literal);
  exits[1].exit.code = 99;
  expect(runner.exitsAfter(1)[0].exit.code).toBe(0);
});

it("waits for Node writer shutdown after a timeout and retains its buffered output without sharing mutable bytes", async () => {
  vi.useFakeTimers();
  const { runner, runNode } = setup(facts, true), end = deferred<ObservedCodingCommand>();
  let active: AbortSignal | undefined;
  runNode.mockImplementationOnce(async (_argv, _cwd, output, signal) => { active = signal; output(Buffer.from("before timeout"), "stdout"); return end.promise; });
  const command = runner.startNode({ ...nodeSpec(), timeoutMs: 20 });
  let completed = false; void command.done.then(() => { completed = true; });
  await vi.advanceTimersByTimeAsync(21);
  expect(active?.aborted).toBe(true); expect(completed).toBe(false); expect(runner.running).toBe(1);
  end.resolve({ ...observed, stopped: true });
  expect(await command.done).toMatchObject({ ended: "timeout" }); expect(runner.running).toBe(0);
  command.onOutput(bytes => bytes.fill(0));
  const received: string[] = []; command.onOutput(bytes => received.push(Buffer.from(bytes).toString("utf8")));
  expect(received).toEqual(["before timeout"]);
});

it("revokes both queued execution types synchronously and shares the same awaited Stop proof", async () => {
  const { runner, run, runNode, stop } = setup(facts, true), proof = deferred<void>();
  stop.mockImplementationOnce(async () => proof.promise);
  const direct = runner.startNode(nodeSpec()), shell = runner.start(spec()), stopped = runner.stopAll("killswitch");
  expect(runner.stopAll("quit")).toBe(stopped);
  expect(await direct.done).toMatchObject({ ended: "stopped-task" }); expect(await shell.done).toMatchObject({ ended: "stopped-task" });
  expect(run).not.toHaveBeenCalled(); expect(runNode).not.toHaveBeenCalled();
  let completed = false; void stopped.then(() => { completed = true; });
  await Promise.resolve(); expect(completed).toBe(false);
  proof.resolve(); await stopped; expect(stop).toHaveBeenCalledTimes(1);
  expect(await runner.startNode(nodeSpec()).done).toMatchObject({ ended: "stopped-task" });
});

it.each(["shell", "node"] as const)("an unverified %s shutdown fences later work in both execution types", async kind => {
  const { runner, run, runNode } = setup(facts, true);
  (kind === "node" ? runNode : run).mockRejectedValueOnce(new Error("PRIVATE_SHUTDOWN_CANARY"));
  const exit = await (kind === "node" ? runner.startNode(nodeSpec()) : runner.start(spec())).done;
  expect(exit).toMatchObject({ ended: "lost", outputCut: true, endLost: true });
  expect(JSON.stringify(exit)).not.toContain("PRIVATE_SHUTDOWN_CANARY");
  await runner.start(spec()).done; await runner.startNode(nodeSpec()).done;
  expect(run.mock.calls.length + runNode.mock.calls.length).toBe(1);
});

it("applies the same bounded-output shutdown gate to Node", async () => {
  const { runner, runNode } = setup(facts, true), proof = deferred<ObservedCodingCommand>();
  runNode.mockImplementationOnce(async (_argv, _cwd, output, signal) => {
    output(new Uint8Array(256 * 1024), "stdout"); output(new Uint8Array(1), "stderr");
    expect(signal.aborted).toBe(true); return proof.promise;
  });
  const running = runner.startNode(nodeSpec());
  let completed = false; void running.done.then(() => { completed = true; });
  await Promise.resolve(); await Promise.resolve(); expect(completed).toBe(false);
  proof.resolve({ ...observed, stopped: true, outputLimited: true });
  expect(await running.done).toMatchObject({ ended: "stopped-task", outputCut: true });
});

it("counts mixed shell and Node invocations against one run budget", async () => {
  const { runner, run, runNode } = setup(facts, true);
  for (let i = 0; i < 200; i++) expect(await (i % 2 ? runner.startNode(nodeSpec()) : runner.start(spec())).done).toMatchObject({ ended: "exit" });
  expect(await runner.startNode(nodeSpec()).done).toMatchObject({ ended: "failed-to-start" });
  expect(await runner.start(spec()).done).toMatchObject({ ended: "failed-to-start" });
  expect(run).toHaveBeenCalledTimes(100); expect(runNode).toHaveBeenCalledTimes(100);
  expect(runner.exitsAfter(0)).toHaveLength(200);
});

it("binds WSL command stamps to the exact selected distro and refuses local or other-target stamps", async () => {
  const f = setup(), target = "wsl:Ubuntu" as const;
  const runner = new IsolatedCodingCommandRunner({ workspace: f.workspace, facts, target, signal: f.owner.signal, current: () => true, inspect: f.inspect });
  expect(runner.target).toBe(target);
  expect(await runner.start(spec()).done).toMatchObject({ ended: "failed-to-start" }); expect(f.run).not.toHaveBeenCalled();
  const accepted = spec(); accepted.stamp.sha256 = createHash("sha256").update(`${target}\0${accepted.shell}\0${accepted.cwd}\0${accepted.command}`).digest("hex");
  const command = runner.start(accepted); expect(await command.done).toMatchObject({ ended: "exit", code: 0 }); expect(f.run).toHaveBeenCalledTimes(1);
});
it("rejects non-coding remote targets before any workspace execution", () => {
  const f = setup();
  expect(() => new IsolatedCodingCommandRunner({ workspace: f.workspace, facts, target: "ssh:host", signal: f.owner.signal, current: () => true, inspect: f.inspect })).toThrow("target");
  expect(f.run).not.toHaveBeenCalled();
});
