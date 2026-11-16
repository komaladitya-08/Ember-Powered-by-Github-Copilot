import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { IsolatedCodingCommandRunner, type ObservedCodingCommand } from "../../app/main/agent/isolated-coding-command-runner";
import type { RunnerFacts, RunSpec, ShellId } from "../../app/main/commands/types";

const facts: RunnerFacts = { os: "linux", shells: ["bash"], shellPaths: { bash: "/usr/bin/bash" }, script: null,
  home: "/state", user: "fixture", privileged: false, pty: false, ember: { paths: ["/host/private"], pids: [123], names: /ember/i }, extraPath: [] };
const observed: ObservedCodingCommand = { observed: true, exitCode: 0, signal: null, stopped: false, timedOut: false, outputLimited: false };
const spec = (command = "node --test", shell: ShellId = "bash"): RunSpec => ({ runId: "0123456789abcdef", taskId: "fixture-task", shell, command, cwd: "/work", timeoutMs: 1000, cols: 80, rows: 24,
  stamp: { taskId: "fixture-task", sha256: createHash("sha256").update(`local\0${shell}\0/work\0${command}`).digest("hex"), verdict: "run", classes: [], rules: [], approval: null } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
function setup(runnerFacts: RunnerFacts = facts) {
  const owner = new AbortController();
  const state = { current: true };
  const run = vi.fn(async (_command: string, _cwd: string, output: (bytes: Uint8Array, stream: "stdout" | "stderr") => void, _signal: AbortSignal, _shell: ShellId) => { output(Buffer.from("passed\n"), "stdout"); return observed; });
  const stop = vi.fn(async () => undefined);
  const inspect = vi.fn(async (paths: string[]) => paths.map(() => ({ exists: true, real: "/work/file.ts" })));
  const runner = new IsolatedCodingCommandRunner({ workspace: { executionRoot: "/work", run, stop }, facts: runnerFacts, inspect,
    current: () => state.current, signal: owner.signal });
  return { runner, run, stop, inspect, state, owner };
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
