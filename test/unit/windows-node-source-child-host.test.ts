import { expect, it } from "vitest";
import type { WindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";
import { WindowsNodeHostCleanupError } from "../fixtures/windows-node-lpac-startup";
import { runWindowsNodeSourceChildHost } from "../fixtures/windows-node-source-child-host";

function setup(fault = "") {
  const calls: string[] = []; let exited = false, bound = false;
  const process = { process: 20n, thread: 21n, pid: 100 };
  const api = {
    createJob() { calls.push("job"); return 10n; },
    assign() { calls.push("assign"); if (fault === "assign") throw Error("private"); },
    resume() { calls.push("resume"); },
    terminateJob() { calls.push("terminate-job"); exited = true; },
    terminateProcess() { calls.push("terminate-root"); exited = true; },
    exited() { return exited; }, jobState() { return { active: exited ? 0 : 1, listed: exited ? 0 : 1 }; },
    exitCode() { calls.push("exit-code"); return fault === "bad-exit" ? 1 : 0; },
    close(handle: bigint) { calls.push(`close-${handle}`); if (fault === "close" && handle === 21n) throw Error("private"); },
  } as unknown as WindowsLpacApi;
  const observer = {
    admit() { calls.push("admit"); exited = true; if (fault === "admit-unknown") throw new WindowsNodeHostCleanupError(); return fault === "no-admission" ? null : 101; },
    waitStoppedBefore(deadline: number) { calls.push("all-stopped"); expect(Number.isFinite(deadline)).toBe(true); if (!bound || fault === "stop-unknown") throw Error("private"); },
    closeStopped() { calls.push("close-observer"); if (fault === "observer-close") throw Error("private"); },
  } as unknown as Parameters<typeof runWindowsNodeSourceChildHost>[3];
  const native = { create() { calls.push("create"); return process; }, verify() { calls.push("verify"); if (fault === "verify") throw Error("private"); },
    bind() { calls.push("bind"); bound = true; } };
  const start = () => runWindowsNodeSourceChildHost({ program: "C:\\fixed\\node.exe", command: Buffer.alloc(2), cwd: "C:\\fixed", environment: Buffer.alloc(2), unchanged() { calls.push("unchanged"); } }, api, native, observer);
  return { calls, start };
}
it("binds the exact owner before resume and requires child admission, job Stop and all retained handles before closing", async () => {
  const s = setup(); expect(await s.start()).toEqual({ exitCode: 0, jobStopped: true, admitted: true });
  expect(s.calls).toEqual(["unchanged", "job", "create", "assign", "verify", "unchanged", "bind", "resume", "admit", "all-stopped", "exit-code", "close-observer", "close-21", "close-20", "close-10"]);
});
it.each(["bad-exit", "no-admission"])("refuses %s after positive owner cleanup", async fault => {
  const s = setup(fault); await expect(s.start()).rejects.toThrow("closed native contract");
  expect(s.calls).toContain("all-stopped"); expect(s.calls.slice(-4)).toEqual(["close-observer", "close-21", "close-20", "close-10"]);
});
it.each(["assign", "verify"])("attempts non-disposing Stop after %s refuses before observer bind, retaining the unbound owners", async fault => {
  const s = setup(fault); await expect(s.start()).rejects.toBeInstanceOf(WindowsNodeHostCleanupError);
  expect(s.calls).not.toContain("resume"); expect(s.calls).toContain("terminate-root"); expect(s.calls).toContain("terminate-job"); expect(s.calls).toContain("all-stopped");
  expect(s.calls.some(call => call.startsWith("close-"))).toBe(false);
});
it.each(["admit-unknown", "stop-unknown"])("retains all owners after %s despite a best-effort non-disposing Stop", async fault => {
  const s = setup(fault); await expect(s.start()).rejects.toBeInstanceOf(WindowsNodeHostCleanupError);
  expect(s.calls).toContain("terminate-root"); expect(s.calls).toContain("terminate-job"); expect(s.calls.some(call => call.startsWith("close-"))).toBe(false);
});
it("does not release native owners after observer close uncertainty", async () => {
  const s = setup("observer-close"); await expect(s.start()).rejects.toBeInstanceOf(WindowsNodeHostCleanupError);
  expect(s.calls.slice(-1)).toEqual(["close-observer"]);
});
it("stops releasing at the first native CloseHandle uncertainty without retrying", async () => {
  const s = setup("close"); await expect(s.start()).rejects.toBeInstanceOf(WindowsNodeHostCleanupError);
  expect(s.calls.slice(-2)).toEqual(["close-observer", "close-21"]); expect(s.calls.filter(call => call === "close-21")).toHaveLength(1);
});
