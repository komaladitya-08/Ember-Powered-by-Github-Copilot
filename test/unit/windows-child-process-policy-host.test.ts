import { afterEach, expect, it, vi } from "vitest";
import { runWindowsChildPolicyHost } from "../fixtures/windows-child-process-policy-host";
import { WindowsNodeHostCleanupError } from "../fixtures/windows-node-lpac-startup";
import { readWindowsChildProcessPolicyAfterStopped } from "../fixtures/windows-child-process-policy-ownership";
import { disposeWindowsChildPolicyProbe } from "../fixtures/windows-child-process-policy-disposal";
afterEach(() => vi.useRealTimers());
const setup = (natural: boolean) => {
  const calls: string[] = [], fence = { unsafe: false, retained: [] as unknown[] }; let stopped = natural;
  const api = { createJob: () => 1n, assign() {}, resume() {}, terminateProcess() { calls.push("stop-root"); stopped = true; }, terminateJob() { calls.push("stop-job"); },
    exited: () => stopped, jobState: () => ({ active: stopped ? 0 : 1, listed: stopped ? 0 : 1 }), exitCode: () => 0, close(value: bigint) { calls.push(`close-${value}`); } };
  const input = { program: "C:\\fixed.exe", command: Buffer.alloc(2), cwd: "C:\\work", environment: Buffer.alloc(4), unchanged() {} };
  const native = { create: () => ({ process: 2n, thread: 3n, pid: 4 }), verify() {} };
  return { api, input, native, fence, calls };
};
it("releases the host owner only after natural exit0 and private-job zero", async () => {
  const value = setup(true); await expect(runWindowsChildPolicyHost(value.input, value.api, value.native, value.fence)).resolves.toEqual({ exitCode: 0, jobStopped: true });
  expect(value.calls).toEqual(["close-3", "close-2", "close-1"]); expect(value.fence.retained).toEqual([]);
});
it("quarantines a retaining host C child after timeout even if non-disposing Stop subsequently succeeds", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
  const value = setup(false), promise = runWindowsChildPolicyHost(value.input, value.api, value.native, value.fence);
  const refused = expect(promise).rejects.toBeInstanceOf(WindowsNodeHostCleanupError);
  await vi.advanceTimersByTimeAsync(20_010); await refused;
  expect(value.calls).toEqual(["stop-root", "stop-job"]); expect(value.fence.unsafe).toBe(true); expect(value.fence.retained).toHaveLength(1);
  const before = [...value.calls]; await expect(runWindowsChildPolicyHost(value.input, value.api, value.native, value.fence)).rejects.toBeInstanceOf(WindowsNodeHostCleanupError);
  expect(value.calls).toEqual(before);
});
it("keeps the entire LPAC disposal/removal path revoked after missing natural completion and a successful later Stop", async () => {
  const calls: string[] = []; let unsafe = false, remove = false, read = false;
  try {
    await readWindowsChildProcessPolicyAfterStopped({ async waitRootExited() { throw new Error("retaining C root deadline"); },
      async waitStopped() { return { requireStopped() {} }; }, exitCode: () => 0, read() { read = true; } });
  } catch (error) { unsafe = error instanceof WindowsNodeHostCleanupError; }
  const retained = await disposeWindowsChildPolicyProbe({ unsafe, lpacCreated: true, async stopLpac() { calls.push("non-disposing-stop"); },
    async closeFixture() { calls.push("close-profile-and-io"); }, releasePins() { calls.push("release-pins"); } });
  if (!retained) remove = true;
  expect(read).toBe(false); expect(retained).toBe(true); expect(remove).toBe(false); expect(calls).toEqual(["non-disposing-stop"]);
});
