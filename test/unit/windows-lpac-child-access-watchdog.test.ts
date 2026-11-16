/** Pure metadata and mocked-thread contracts. No real Worker, koffi binding, tool, download or driver runs. */
import fs from "node:fs";
import path from "node:path/win32";
import vm from "node:vm";
import type { EventEmitter } from "node:events";
import type { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowsLpacChildAccessTool } from "../fixtures/windows-lpac-child-access-native";

type ThreadData = { shared: SharedArrayBuffer; paths: string[]; deadline: bigint };
interface FakeThread extends EventEmitter {
  entry: URL;
  options: { workerData: ThreadData; stdout: boolean; stderr: boolean; env: NodeJS.ProcessEnv; execArgv: string[] };
  stdout: PassThrough;
  stderr: PassThrough;
  terminate: ReturnType<typeof vi.fn>;
}
const threads = vi.hoisted(() => ({ made: [] as FakeThread[], failConstruction: false }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events"), { PassThrough } = await import("node:stream");
  return { Worker: class extends EventEmitter implements FakeThread {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly terminate = vi.fn(() => Promise.resolve(0));
    constructor(readonly entry: URL, readonly options: FakeThread["options"]) {
      super(); if (threads.failConstruction) throw new Error("C:\\private\\worker loader secret");
      threads.made.push(this);
    }
  } };
});
import { ChildAccessWatchdog, ChildAccessWatchdogError } from "../fixtures/windows-lpac-child-access-watchdog";

const PML = "D:\\private\\witness\\capture.pml", CSV = "D:\\private\\witness\\export.csv";
const source = fs.readFileSync(new URL("../fixtures/windows-lpac-child-access-watchdog.cjs", import.meta.url), "utf8");
type Reason = (files: unknown, now: unknown, deadline: unknown) => number;
function sourceModule(main = true, over: { command?: number; job?: bigint; jobs?: bigint[]; deadline?: bigint; stat?: (file: string) => unknown; terminate?: () => unknown; loadFailure?: boolean } = {}) {
  const shared = new SharedArrayBuffer(96), control = new Int32Array(shared, 0, 8), jobs = new BigUint64Array(shared, 32, 8);
  if (over.command !== undefined) Atomics.store(control, 0, over.command);
  if (over.job !== undefined) { Atomics.store(jobs, 0, over.job); Atomics.store(control, 3, 1); }
  if (over.jobs) { over.jobs.forEach((job, index) => Atomics.store(jobs, index, job)); Atomics.store(control, 3, over.jobs.length); }
  const required: string[] = [], postMessage = vi.fn(), terminate = vi.fn(over.terminate ?? (() => 1));
  const stat = vi.fn(over.stat ?? (() => { throw Object.assign(new Error("private metadata unavailable"), { code: "EIO" }); }));
  const processState = { platform: "win32", arch: "x64", hrtime: { bigint: () => 100n }, exitCode: 0 };
  const module = { exports: {} as { childAccessWatchdogReason?: Reason } };
  const load = vi.fn(() => { if (over.loadFailure) throw new Error("private native loader"); return { func: vi.fn((prototype: string) => {
    expect(prototype).toBe("int __stdcall TerminateJobObject(void *job, uint32_t code)"); return terminate;
  }) }; });
  const require = (name: string): unknown => {
    required.push(name);
    if (name === "node:worker_threads") return { isMainThread: main, parentPort: { postMessage }, workerData: { shared, paths: [PML, CSV], deadline: over.deadline ?? 1_000n } };
    if (name === "node:fs") return { lstatSync: stat };
    if (name === "node:path/win32") return path;
    if (!main && name === "koffi") return { sizeof: () => 8, load };
    throw new Error("A native module is unavailable in this portable test.");
  };
  vm.runInNewContext(source, { module, require, process: processState, SharedArrayBuffer, Int32Array, BigUint64Array, Atomics },
    { timeout: 1_000, filename: "fixed-watchdog-portable-test.cjs" });
  return { reason: module.exports.childAccessWatchdogReason!, required, stat, load, postMessage, terminate, processState, control, jobs };
}
const files = () => [{ exists: true, ordinary: true, links: 1, bytes: 0 }, { exists: true, ordinary: true, links: 1, bytes: 0 }];
const controls = (thread: FakeThread) => new Int32Array(thread.options.workerData.shared, 0, 8);
const borrowed = (thread: FakeThread) => new BigUint64Array(thread.options.workerData.shared, 32, 8);
const tool = (job: unknown = 10n) => ({ pid: 4242, borrowedJob: vi.fn(() => job), current: vi.fn(), isExited: vi.fn(() => true),
  sampleMembers: vi.fn(), waitExitedBefore: vi.fn(() => 0), stopBefore: vi.fn(), closeStopped: vi.fn() });
const asTool = (value: ReturnType<typeof tool>) => value as unknown as WindowsLpacChildAccessTool;
function completed(thread: FakeThread, code: unknown = 0, finished = 1, reason = 0) {
  Atomics.store(controls(thread), 1, finished); Atomics.store(controls(thread), 2, reason); thread.emit("exit", code);
}
function assertFixed(error: unknown) {
  expect(error).toBeInstanceOf(ChildAccessWatchdogError);
  expect((error as Error).message).toBe("The private child-access witness watchdog could not verify completion; retain its owners.");
  expect(error).not.toHaveProperty("cause"); expect(JSON.stringify(error)).not.toMatch(/private|secret|loader|C:\\|D:\\/);
}
const observeFailure = async (promise: Promise<unknown>) => { try { await promise; return undefined; } catch (error) { return error; } };
async function admitted() {
  const owner = new ChildAccessWatchdog(PML, CSV), thread = threads.made.at(-1)!;
  const ready = owner.ready(); thread.emit("message", 1); await ready; return { owner, thread };
}
const flush = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };
beforeEach(() => { vi.useFakeTimers(); threads.made.length = 0; threads.failConstruction = false; });
afterEach(() => {
  for (const thread of threads.made) { expect(thread.terminate).not.toHaveBeenCalled(); thread.stdout.destroy(); thread.stderr.destroy(); }
  vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe("watchdog fixed metadata reason", () => {
  it("imports the main-thread export without querying files or loading native code", () => {
    const loaded = sourceModule();
    expect(typeof loaded.reason).toBe("function"); expect(loaded.required).toEqual(["node:worker_threads", "node:fs", "node:path/win32"]);
    expect(loaded.stat).not.toHaveBeenCalled(); expect(loaded.load).not.toHaveBeenCalled(); expect(loaded.postMessage).not.toHaveBeenCalled();
    expect(loaded.processState.exitCode).toBe(0);
  });
  it("accepts absent files and exact ordinary-file size bounds without reading any trace bytes", () => {
    const loaded = sourceModule(); expect(loaded.reason([{ exists: false }, { exists: false }], 0n, 60_000_000_000n)).toBe(0);
    const exact = files(); exact[0].bytes = 64 * 1024 * 1024; exact[1].bytes = 32 * 1024 * 1024;
    expect(loaded.reason(exact, 60_000_000_000n, 60_000_000_000n)).toBe(0); expect(loaded.stat).not.toHaveBeenCalled();
  });
  it.each([{ index: 0, bytes: 64 * 1024 * 1024 + 1, reason: 1 }, { index: 1, bytes: 32 * 1024 * 1024 + 1, reason: 2 }])("distinguishes PML and CSV bounds with fixed reason $reason", ({ index, bytes, reason }) => {
    const input = files(); input[index].bytes = bytes; expect(sourceModule().reason(input, 1n, 2n)).toBe(reason);
  });
  it.each([
    { now: 1, deadline: 2n }, { now: 1n, deadline: 2 }, { now: -1n, deadline: 2n },
    { now: 0n, deadline: -1n }, { now: 3n, deadline: 2n }, { now: null, deadline: 2n },
  ])("refuses expired or invalid monotonic times (%#)", ({ now, deadline }) => { expect(sourceModule().reason(files(), now, deadline)).toBe(3); });
  it.each([null, {}, [], [{ exists: false }], [{ exists: false }, { exists: false }, { exists: false }]].map(input => ({ input })))("requires exactly the two fixed file metadata records (%#)", ({ input }) => {
    expect(sourceModule().reason(input, 1n, 2n)).toBe(4);
  });
  it.each([
    null, {}, { exists: "true" }, { exists: true }, { exists: true, ordinary: false, links: 1, bytes: 0 },
    { exists: true, ordinary: true, links: 2, bytes: 0 }, { exists: true, ordinary: true, links: 1, bytes: -1 },
    { exists: true, ordinary: true, links: 1, bytes: NaN }, { exists: true, ordinary: true, links: 1, bytes: Infinity },
    { exists: true, ordinary: true, links: 1, bytes: 1.5 }, { exists: true, ordinary: true, links: 1, bytes: Number.MAX_SAFE_INTEGER + 1 },
    { exists: true, ordinary: true, links: 1, bytes: 1n },
  ])("refuses unknown/nonordinary/aliased file metadata (%#)", bad => { expect(sourceModule().reason([bad, { exists: false }], 1n, 2n)).toBe(4); });
  it("refuses a worker deadline beyond the original sixty-second bound before loading native code", () => {
    const loaded = sourceModule(false, { deadline: 60_000_000_101n });
    expect(loaded.processState.exitCode).toBe(1); expect(loaded.load).not.toHaveBeenCalled(); expect(loaded.postMessage).not.toHaveBeenCalled();
  });
  it("requests bounded cleanup on each exact borrowed job after metadata failure without releasing ownership", () => {
    const loaded = sourceModule(false, { jobs: [10n, 11n] });
    expect(Atomics.load(loaded.control, 2)).toBe(7); expect(Atomics.load(loaded.control, 1)).toBe(2); expect(loaded.processState.exitCode).toBe(1);
    expect(loaded.postMessage.mock.calls).toEqual([[1]]); expect(loaded.terminate.mock.calls).toEqual([[10n, 125], [11n, 125]]);
    expect([...loaded.jobs].slice(0, 2)).toEqual([10n, 11n]); expect(Atomics.load(loaded.control, 3)).toBe(2);
  });
  it.each([0, true, undefined, () => { throw new Error("private native stop"); }])("does not retry or touch another job after an unknown Stop completion (%#)", result => {
    const loaded = sourceModule(false, { jobs: [10n, 11n], terminate: typeof result === "function" ? result : () => result });
    expect(loaded.terminate.mock.calls).toEqual([[10n, 125]]); expect(Atomics.load(loaded.control, 2)).toBe(7); expect(Atomics.load(loaded.control, 1)).toBe(2);
    expect([...loaded.jobs].slice(0, 2)).toEqual([10n, 11n]);
  });
  it("refuses a loader failure before publishing readiness or touching a collector job", () => {
    const loaded = sourceModule(false, { loadFailure: true });
    expect(loaded.postMessage).not.toHaveBeenCalled(); expect(loaded.terminate).not.toHaveBeenCalled(); expect(loaded.processState.exitCode).toBe(1);
  });
  it("acknowledges the caller's stopped command without closing or terminating borrowed jobs", () => {
    const loaded = sourceModule(false, { command: 1, job: 10n });
    expect(Atomics.load(loaded.control, 1)).toBe(1); expect(Atomics.load(loaded.control, 2)).toBe(0);
    expect(loaded.processState.exitCode).toBe(0); expect(loaded.stat).not.toHaveBeenCalled(); expect(loaded.terminate).not.toHaveBeenCalled();
  });
});

describe("private watchdog thread and borrowed jobs", () => {
  it("starts only the fixed entry with private output streams, an empty environment and the bounded shared layout", async () => {
    const before = process.hrtime.bigint(), owner = new ChildAccessWatchdog(PML, CSV), thread = threads.made[0];
    expect(thread.entry.pathname.endsWith("/windows-lpac-child-access-watchdog.cjs")).toBe(true);
    expect(thread.options).toMatchObject({ stdout: true, stderr: true, env: {}, execArgv: [], workerData: { paths: [PML, CSV] } });
    expect(thread.options.workerData.shared.byteLength).toBe(96);
    expect(thread.options.workerData.deadline >= before + 60_000_000_000n).toBe(true);
    expect(thread.options.workerData.deadline <= process.hrtime.bigint() + 60_000_000_000n).toBe(true);
    const ready = owner.ready(); thread.emit("message", 1); await ready; expect(vi.getTimerCount()).toBe(0);
    const stop = owner.stop(); completed(thread); await stop;
  });
  it("does not borrow a tool before readiness or before the caller has awaited successful admission", async () => {
    const owner = new ChildAccessWatchdog(PML, CSV), thread = threads.made[0], borrowedTool = tool();
    expect(() => owner.register(asTool(borrowedTool))).toThrow(ChildAccessWatchdogError); expect(borrowedTool.borrowedJob).not.toHaveBeenCalled();
    const ready = owner.ready(); thread.emit("message", 1);
    expect(() => owner.register(asTool(borrowedTool))).toThrow(ChildAccessWatchdogError); expect(borrowedTool.borrowedJob).not.toHaveBeenCalled();
    await ready; owner.register(asTool(borrowedTool)); expect(Atomics.load(controls(thread), 3)).toBe(1);
    const stop = owner.stop(); completed(thread); await stop;
  });
  it("publishes only the same borrowed job handles and never gains tool Stop/close authority", async () => {
    const { owner, thread } = await admitted(), first = tool(10n), second = tool(11n);
    owner.register(asTool(first)); owner.register(asTool(second));
    expect(Atomics.load(controls(thread), 3)).toBe(2); expect([...borrowed(thread)].slice(0, 2)).toEqual([10n, 11n]);
    const stop = owner.stop(); expect(Atomics.load(controls(thread), 0)).toBe(1); completed(thread); await stop;
    for (const value of [first, second]) {
      expect(value.borrowedJob).toHaveBeenCalledOnce(); expect(value.current).not.toHaveBeenCalled(); expect(value.sampleMembers).not.toHaveBeenCalled();
      expect(value.isExited).not.toHaveBeenCalled(); expect(value.waitExitedBefore).not.toHaveBeenCalled(); expect(value.stopBefore).not.toHaveBeenCalled(); expect(value.closeStopped).not.toHaveBeenCalled();
    }
  });
  it("refuses duplicate owners and duplicate handles without changing the registered set", async () => {
    const { owner, thread } = await admitted(), first = tool(10n), alias = tool(10n); owner.register(asTool(first));
    expect(() => owner.register(asTool(first))).toThrow(ChildAccessWatchdogError); expect(first.borrowedJob).toHaveBeenCalledOnce();
    expect(() => owner.register(asTool(alias))).toThrow(ChildAccessWatchdogError); expect(alias.borrowedJob).toHaveBeenCalledOnce();
    expect(Atomics.load(controls(thread), 3)).toBe(1); expect(Atomics.load(borrowed(thread), 0)).toBe(10n);
    const stop = owner.stop(); completed(thread); await stop; expect(first.closeStopped).not.toHaveBeenCalled(); expect(alias.closeStopped).not.toHaveBeenCalled();
  });
  it.each([null, 0n, -1n, 0x8000000000000000n, 0xffffffffffffffffn, 10, "10", NaN])("refuses invalid borrowed handle results without closing or publishing them (%#)", async job => {
    const { owner, thread } = await admitted(), borrowedTool = tool(job);
    expect(() => owner.register(asTool(borrowedTool))).toThrow(ChildAccessWatchdogError); expect(Atomics.load(controls(thread), 3)).toBe(0);
    expect([...borrowed(thread)]).toEqual(Array<bigint>(8).fill(0n)); expect(borrowedTool.closeStopped).not.toHaveBeenCalled();
  });
  it("bounds the borrowed set to eight and refuses a ninth without querying it", async () => {
    const { owner, thread } = await admitted(), tools = Array.from({ length: 9 }, (_, index) => tool(BigInt(index + 10)));
    for (const value of tools.slice(0, 8)) owner.register(asTool(value));
    expect(() => owner.register(asTool(tools[8]))).toThrow(ChildAccessWatchdogError); expect(tools[8].borrowedJob).not.toHaveBeenCalled();
    expect(Atomics.load(controls(thread), 3)).toBe(8); const stop = owner.stop(); completed(thread); await stop;
  });
  it("sanitizes a borrowed-job getter failure and retains all caller-owned handles", async () => {
    const { owner, thread } = await admitted(), borrowedTool = tool(); borrowedTool.borrowedJob.mockImplementation(() => { throw new Error("C:\\private\\borrowed job secret", { cause: "private" }); });
    let caught: unknown; try { owner.register(asTool(borrowedTool)); } catch (error) { caught = error; }
    assertFixed(caught); expect(() => owner.healthy()).toThrow(ChildAccessWatchdogError); expect(Atomics.load(controls(thread), 3)).toBe(0);
    expect(borrowedTool.closeStopped).not.toHaveBeenCalled(); expect(borrowedTool.stopBefore).not.toHaveBeenCalled();
  });
});

describe("watchdog completion and private failures", () => {
  it("makes concurrent Stop callers await the same verified worker completion", async () => {
    const { owner, thread } = await admitted(), borrowedTool = tool(); owner.register(asTool(borrowedTool));
    const first = owner.stop(), second = owner.stop(); expect(first).toBe(second);
    let finished = false; void second.then(() => { finished = true; }); await flush(); expect(finished).toBe(false);
    expect(() => owner.register(asTool(tool(11n)))).toThrow(ChildAccessWatchdogError);
    await expect(owner.ready()).rejects.toThrow(ChildAccessWatchdogError);
    completed(thread); await Promise.all([first, second]); expect(finished).toBe(true); expect(owner.stop()).toBe(first); expect(vi.getTimerCount()).toBe(0);
    expect(borrowedTool.closeStopped).not.toHaveBeenCalled();
  });
  it("accepts natural verified worker completion after the authorized Stop request before its await resumes", async () => {
    const { owner, thread } = await admitted(), stop = owner.stop(); completed(thread);
    await stop; expect(() => owner.healthy()).not.toThrow(); expect(vi.getTimerCount()).toBe(0);
  });
  it("revokes an already pending readiness wait when Stop begins before the readiness receipt arrives", async () => {
    const owner = new ChildAccessWatchdog(PML, CSV), thread = threads.made[0], ready = observeFailure(owner.ready()), stopped = owner.stop();
    thread.emit("message", 1); completed(thread); assertFixed(await ready); await stopped;
    expect(() => owner.register(asTool(tool()))).toThrow(ChildAccessWatchdogError); expect(vi.getTimerCount()).toBe(0);
  });
  it("refuses a premature clean-looking exit because it did not cover the capture lifetime", async () => {
    const { owner, thread } = await admitted(); completed(thread);
    expect(() => owner.healthy()).toThrow(ChildAccessWatchdogError); assertFixed(await observeFailure(owner.stop()));
    expect(() => owner.register(asTool(tool()))).toThrow(ChildAccessWatchdogError);
  });
  it.each([{ code: 1, finished: 1, reason: 0 }, { code: 0, finished: 0, reason: 0 }, { code: 0, finished: 2, reason: 0 },
    { code: 0, finished: 1, reason: 1 }, { code: 0, finished: 1, reason: 7 }, { code: "private exit", finished: 1, reason: 0 }])("requires native completion zero, finished one and reason zero (%#)", async result => {
    const { owner, thread } = await admitted(), borrowedTool = tool(); owner.register(asTool(borrowedTool));
    const stopped = observeFailure(owner.stop()); completed(thread, result.code, result.finished, result.reason); assertFixed(await stopped);
    expect(borrowedTool.closeStopped).not.toHaveBeenCalled(); expect(borrowedTool.stopBefore).not.toHaveBeenCalled();
    expect(() => owner.healthy()).toThrow(ChildAccessWatchdogError);
  });
  it("times out Stop without terminating the thread or releasing its borrowed owners", async () => {
    const { owner, thread } = await admitted(), borrowedTool = tool(); owner.register(asTool(borrowedTool));
    const first = owner.stop(), failure = observeFailure(first); await vi.advanceTimersByTimeAsync(2_000); assertFixed(await failure);
    expect(owner.stop()).toBe(first); expect(borrowedTool.closeStopped).not.toHaveBeenCalled(); expect(thread.terminate).not.toHaveBeenCalled();
    completed(thread); expect(() => owner.healthy()).toThrow(ChildAccessWatchdogError); expect(vi.getTimerCount()).toBe(0);
  });
  it("times out readiness and clears its bounded timer without manufacturing admission", async () => {
    const owner = new ChildAccessWatchdog(PML, CSV), thread = threads.made[0], failure = observeFailure(owner.ready());
    await vi.advanceTimersByTimeAsync(5_000); assertFixed(await failure); expect(vi.getTimerCount()).toBe(0);
    thread.emit("message", 1); expect(() => owner.register(asTool(tool()))).toThrow(ChildAccessWatchdogError);
  });
  it.each([null, "private ready", 0, 2, Buffer.from("private receipt")])("refuses unknown readiness receipts without exposing them (%#)", async message => {
    const owner = new ChildAccessWatchdog(PML, CSV), thread = threads.made[0], ready = observeFailure(owner.ready()); thread.emit("message", message);
    assertFixed(await ready); expect(vi.getTimerCount()).toBe(0);
  });
  it("replaces constructor and worker errors with fixed private failures", async () => {
    threads.failConstruction = true; let caught: unknown;
    try { new ChildAccessWatchdog(PML, CSV); } catch (error) { caught = error; } assertFixed(caught); threads.failConstruction = false;
    const owner = new ChildAccessWatchdog(PML, CSV), thread = threads.made[0], ready = observeFailure(owner.ready());
    thread.emit("error", new Error("C:\\private\\worker secret", { cause: "private" })); assertFixed(await ready); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not leave an early worker rejection unobserved before the caller awaits readiness", async () => {
    const owner = new ChildAccessWatchdog(PML, CSV), thread = threads.made[0]; thread.emit("error", new Error("private loader")); await flush();
    assertFixed(await observeFailure(owner.ready())); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["stdout", "stderr"] as const)("wipes and suppresses %s bytes and refuses any subsequent proof", async stream => {
    const { owner, thread } = await admitted(), bytes = Buffer.from("private output secret");
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true), err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try { thread[stream].emit("data", bytes); expect(out).not.toHaveBeenCalled(); expect(err).not.toHaveBeenCalled(); }
    finally { out.mockRestore(); err.mockRestore(); }
    expect(bytes.every(value => value === 0)).toBe(true); expect(() => owner.healthy()).toThrow(ChildAccessWatchdogError);
    assertFixed(await observeFailure(owner.stop()));
  });
  it.each(["stdout", "stderr"] as const)("refuses unexpected %s chunks and stream errors without a raw callback throw", async stream => {
    const first = await admitted(); expect(() => first.thread[stream].emit("data", "private unexpected string")).not.toThrow();
    expect(() => first.owner.healthy()).toThrow(ChildAccessWatchdogError);
    const second = await admitted(); expect(() => second.thread[stream].emit("error", new Error("private stream failure"))).not.toThrow();
    expect(() => second.owner.healthy()).toThrow(ChildAccessWatchdogError);
  });
  it("keeps errors occurring during Stop terminal even if the worker later produces a success-shaped receipt", async () => {
    const { owner, thread } = await admitted(), failure = observeFailure(owner.stop());
    thread.emit("error", new Error("private active worker error")); completed(thread); assertFixed(await failure); expect(vi.getTimerCount()).toBe(0);
  });
});
