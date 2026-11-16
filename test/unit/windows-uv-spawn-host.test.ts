import { afterEach, expect, it, vi } from "vitest";
import { runWindowsUvSpawnHost } from "../fixtures/windows-uv-spawn-host";
import { WindowsUvSpawnCleanupError } from "../fixtures/windows-uv-spawn-ownership";

afterEach(() => vi.useRealTimers());
const setup = (natural = true) => {
  const events: string[] = [], fence = { unsafe: false, retained: [] as unknown[] }; let exited = natural;
  const input = { program: "C:\\fixed.exe", command: Buffer.alloc(2), cwd: "C:\\work", environment: Buffer.alloc(4), unchanged() {} };
  const api = { createJob: () => 1n, assign() {}, resume() {}, terminateProcess() { events.push("stop-root"); exited = true; }, terminateJob() { events.push("stop-job"); },
    exited: () => exited, jobState: () => ({ active: exited ? 0 : 1, listed: exited ? 0 : 1 }), exitCode: () => 0, close(value: bigint) { events.push(`close-${value}`); } };
  const native = { create: () => ({ process: 2n, thread: 3n, pid: 4 }), verify() {}, bind() {} };
  const observer = { bind() {}, admit(): number | null { events.push("admit"); exited = true; return 8; }, requireStopped() {}, waitStoppedBefore() { events.push("children-stopped"); }, closeStopped() { events.push("close-child-pins"); }, observation: () => ({ operation: 0, domain: 0, code: 0, tracked: 0, candidates: 0 }) };
  return { input, api, native, observer, fence, events };
};

it("returns a naturally closed root with no child so the caller can reject its ordinary positive control", async () => {
  const value = setup(); await expect(runWindowsUvSpawnHost(value.input, value.api, value.native, value.observer, value.fence)).resolves.toEqual({ exitCode: 0, jobStopped: true, admitted: false });
  expect(value.events).toEqual(["children-stopped", "close-child-pins", "close-3", "close-2", "close-1"]); expect(value.fence.retained).toEqual([]);
});
it("observes the running child before returning the full useful host route", async () => {
  const value = setup(false); await expect(runWindowsUvSpawnHost(value.input, value.api, value.native, value.observer, value.fence)).resolves.toEqual({ exitCode: 0, jobStopped: true, admitted: true });
  expect(value.events[0]).toBe("admit"); expect(value.fence.unsafe).toBe(false);
});
it("permanently retains missing natural completion after later Stop succeeds and performs no closes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
  const value = setup(false); value.observer.admit = () => null;
  const running = runWindowsUvSpawnHost(value.input, value.api, value.native, value.observer, value.fence), refused = expect(running).rejects.toBeInstanceOf(WindowsUvSpawnCleanupError);
  await vi.advanceTimersByTimeAsync(20_010); await refused;
  expect(value.events).toEqual(["stop-root", "stop-job", "children-stopped"]); expect(value.fence.retained).toHaveLength(1);
  const before = [...value.events]; await expect(runWindowsUvSpawnHost(value.input, value.api, value.native, value.observer, value.fence)).rejects.toBeInstanceOf(WindowsUvSpawnCleanupError); expect(value.events).toEqual(before);
});
it.each(["verify", "bind", "root-exit", "child-stop", "exit-code", "nonzero", "close"])("retains all host owners after %s failure", async fault => {
  const value = setup();
  if (fault === "verify") value.native.verify = () => { throw new Error("private path"); };
  if (fault === "bind") value.native.bind = () => { throw new Error(); };
  if (fault === "root-exit") value.api.exited = () => { throw new Error(); };
  if (fault === "child-stop") value.observer.waitStoppedBefore = () => { throw new Error(); };
  if (fault === "exit-code") value.api.exitCode = () => { throw new Error(); };
  if (fault === "nonzero") value.api.exitCode = () => 101;
  if (fault === "close") value.api.close = () => { value.events.push("failed-close"); throw new Error(); };
  await expect(runWindowsUvSpawnHost(value.input, value.api, value.native, value.observer, value.fence)).rejects.toBeInstanceOf(WindowsUvSpawnCleanupError);
  expect(value.fence.unsafe).toBe(true); expect(value.fence.retained).toHaveLength(1);
  if (fault !== "close") expect(value.events.some(event => event.startsWith("close-"))).toBe(false);
});
