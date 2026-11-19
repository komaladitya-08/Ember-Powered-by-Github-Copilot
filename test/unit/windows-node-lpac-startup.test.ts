import { expect, it, vi } from "vitest";
import { WINDOWS_NODE_STARTUP_ARGS, WindowsNodeHostCleanupError, WindowsNodeStartupGate, runWindowsNodeHostStartup, type WindowsNodeHostNative } from "../fixtures/windows-node-lpac-startup";
import type { WindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";

function rig() {
  const events: string[] = [], command = Buffer.from("fixed-command\0", "utf16le"), environment = Buffer.from("CLEAN=1\0\0", "utf16le");
  let exited = false, active = 1;
  const api = {
    createJob: vi.fn(() => { events.push("job"); return 30n; }),
    assign: vi.fn(() => { events.push("assigned"); }),
    resume: vi.fn(() => { events.push("resume"); exited = true; active = 0; }),
    terminateProcess: vi.fn(() => { events.push("terminate-root"); exited = true; }),
    terminateJob: vi.fn(() => { events.push("terminate-job"); active = 0; }),
    exited: vi.fn(() => { events.push("root-observed"); return exited; }),
    jobState: vi.fn(() => { events.push("job-observed"); return { active, listed: active }; }),
    exitCode: vi.fn(() => { events.push("exit-code"); return 0; }),
    close: vi.fn((handle: bigint) => { events.push(`close-${handle}`); }),
  } satisfies Pick<WindowsLpacApi, "createJob" | "assign" | "resume" | "terminateProcess" | "terminateJob" | "exited" | "jobState" | "exitCode" | "close">;
  const native: WindowsNodeHostNative = {
    create: vi.fn(() => { events.push("created-suspended"); return { process: 10n, thread: 20n, pid: 123 }; }),
    verify: vi.fn(() => { events.push("verified-host-image"); }),
  };
  const input = { program: "C:\\fresh\\tools\\node.exe", command, cwd: "C:\\fresh\\work", environment, unchanged: vi.fn(() => { events.push("pinned-assets"); }) };
  return { api, native, input, events, setExit(value: boolean) { exited = value; }, setActive(value: number) { active = value; } };
}

it("uses one fixed startup eval and returns a numeric result only after exact process and job observations", async () => {
  expect(WINDOWS_NODE_STARTUP_ARGS).toEqual(["--eval", "process.exitCode = 0"]); expect(Object.isFrozen(WINDOWS_NODE_STARTUP_ARGS)).toBe(true);
  const r = rig(); await expect(runWindowsNodeHostStartup(r.input, r.api, r.native)).resolves.toEqual({ exitCode: 0, jobStopped: true });
  expect(r.events).toEqual(["pinned-assets", "job", "created-suspended", "assigned", "verified-host-image", "pinned-assets", "resume", "root-observed", "job-observed", "exit-code", "close-20", "close-10", "close-30"]);
  const sent = vi.mocked(r.native.create).mock.calls[0]!;
  expect(sent).toEqual([r.input.program, r.input.command, r.input.cwd, r.input.environment]);
  expect(sent[1]).not.toBe(r.input.command); expect(sent[3]).not.toBe(r.input.environment);
});

it("stops an unassigned suspended root and verifies the empty job when assignment fails", async () => {
  const r = rig(), problem = new Error("assignment refused"); r.api.assign.mockImplementation(() => { throw problem; });
  await expect(runWindowsNodeHostStartup(r.input, r.api, r.native)).rejects.toBe(problem);
  expect(r.api.resume).not.toHaveBeenCalled(); expect(r.api.terminateProcess).toHaveBeenCalledWith(10n);
  expect(r.api.terminateJob).toHaveBeenCalledWith(30n); expect(r.api.exitCode).not.toHaveBeenCalled();
  expect(r.events.slice(-3)).toEqual(["close-20", "close-10", "close-30"]);
});

it("still terminates an unassigned suspended root when its initial exit inspection fails", async () => {
  const r = rig(), problem = new Error("assignment refused"); r.api.assign.mockImplementation(() => { throw problem; });
  r.api.exited.mockImplementationOnce(() => { throw new Error("initial query unavailable"); }).mockReturnValue(true);
  await expect(runWindowsNodeHostStartup(r.input, r.api, r.native)).rejects.toBe(problem);
  expect(r.api.terminateProcess).toHaveBeenCalledWith(10n); expect(r.api.terminateJob).toHaveBeenCalledWith(30n);
  expect(r.events.slice(-3)).toEqual(["close-20", "close-10", "close-30"]);
});

it("never resumes an unexpected token/image or a changed asset and still drains native ownership", async () => {
  for (const stage of ["identity", "assets"]) {
    const r = rig(), problem = new Error("verification refused");
    if (stage === "identity") vi.mocked(r.native.verify).mockImplementation(() => { throw problem; });
    else r.input.unchanged.mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw problem; });
    await expect(runWindowsNodeHostStartup(r.input, r.api, r.native)).rejects.toBe(problem);
    expect(r.api.resume).not.toHaveBeenCalled(); expect(r.api.terminateProcess).toHaveBeenCalled();
    expect(r.events.slice(-3)).toEqual(["close-20", "close-10", "close-30"]);
  }
});

it("does not read an exit code merely because the root exited while its job still owns a process", async () => {
  const r = rig(); let inspected = 0;
  r.api.jobState.mockImplementation(() => { r.events.push("job-observed"); if (++inspected === 2) { r.setActive(0); return { active: 0, listed: 0 }; } return { active: 1, listed: 1 }; });
  await expect(runWindowsNodeHostStartup(r.input, r.api, r.native)).resolves.toEqual({ exitCode: 0, jobStopped: true });
  expect(r.api.jobState).toHaveBeenCalledTimes(2); expect(r.events.indexOf("exit-code")).toBeGreaterThan(r.events.lastIndexOf("job-observed"));
});

it("preserves uncertain creation or cleanup and does not release native ownership as if verified", async () => {
  const r = rig(); vi.mocked(r.native.create).mockImplementation(() => { throw new WindowsNodeHostCleanupError(); });
  await expect(runWindowsNodeHostStartup(r.input, r.api, r.native)).rejects.toBeInstanceOf(WindowsNodeHostCleanupError);
  expect(r.api.resume).not.toHaveBeenCalled(); expect(r.api.close).not.toHaveBeenCalled();
  const other = rig(); other.api.close.mockImplementation(handle => { if (handle === 20n) throw new Error("close refused"); });
  await expect(runWindowsNodeHostStartup(other.input, other.api, other.native)).rejects.toBeInstanceOf(WindowsNodeHostCleanupError);
  expect(other.api.close.mock.calls.map(call => call[0])).toEqual([20n, 10n, 30n]);
});

it("preserves a shutdown failure without querying results or closing still-live native handles", async () => {
  const r = rig(); vi.mocked(r.native.verify).mockImplementation(() => { throw new Error("unexpected image"); });
  r.api.terminateProcess.mockImplementation(() => { throw new Error("termination unknown"); });
  r.api.exited.mockImplementationOnce(() => false).mockImplementation(() => { throw new Error("exit observation unknown"); });
  await expect(runWindowsNodeHostStartup(r.input, r.api, r.native)).rejects.toBeInstanceOf(WindowsNodeHostCleanupError);
  expect(r.api.terminateJob).toHaveBeenCalledWith(30n); expect(r.api.close).not.toHaveBeenCalled(); expect(r.api.exitCode).not.toHaveBeenCalled();
});

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
it("shares one host launch and retires a queued LPAC start synchronously before pending host cleanup", async () => {
  const gate = new WindowsNodeStartupGate(), held = deferred<{ exitCode: number; jobStopped: true }>(), host = vi.fn(() => held.promise), lpac = vi.fn(async () => 123);
  const first = gate.host(host); expect(gate.host(host)).toBe(first); await Promise.resolve(); expect(host).toHaveBeenCalledTimes(1);
  const launch = gate.launch(lpac); gate.retire(); const refused = expect(launch).rejects.toThrow("closed");
  held.resolve({ exitCode: 0, jobStopped: true }); await first; await refused;
  expect(lpac).not.toHaveBeenCalled(); await expect(gate.launch(lpac)).rejects.toThrow("closing");
  await expect(gate.host(host)).rejects.toThrow("no longer admissible");
});

it("does not create even the host control if close wins before its queued admission", async () => {
  const gate = new WindowsNodeStartupGate(), host = vi.fn(async () => ({ exitCode: 0, jobStopped: true as const }));
  const pending = gate.host(host); gate.retire(); await expect(pending).rejects.toThrow("closed"); expect(host).not.toHaveBeenCalled();
});

it("does not admit a host control after LPAC launch was requested", async () => {
  const gate = new WindowsNodeStartupGate(), lpac = vi.fn(async () => 123), host = vi.fn(async () => ({ exitCode: 0, jobStopped: true as const }));
  const pending = gate.launch(lpac); await expect(gate.host(host)).rejects.toThrow("no longer admissible");
  await expect(pending).resolves.toBe(123); expect(host).not.toHaveBeenCalled();
});

it("propagates the exact uncertain host cleanup to queued LPAC admission without starting another process", async () => {
  const gate = new WindowsNodeStartupGate(), held = deferred<{ exitCode: number; jobStopped: true }>(), problem = new WindowsNodeHostCleanupError();
  const host = gate.host(() => held.promise), lpac = vi.fn(async () => 123), launch = gate.launch(lpac);
  const hostRejected = expect(host).rejects.toBe(problem), launchRejected = expect(launch).rejects.toBe(problem);
  held.reject(problem); await hostRejected; await launchRejected; expect(lpac).not.toHaveBeenCalled();
});
