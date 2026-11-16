/** Captured host exit diagnostics only; injected owned handles never invoke Windows or release uncertain owners. */
import { describe, expect, it, vi } from "vitest";
import { brandWindowsChildPolicyExitFailure, brandWindowsChildPolicyFailure, preserveWindowsChildPolicyFailure, windowsChildPolicyFailure } from "../fixtures/windows-child-process-policy-diagnostic";
import { runWindowsChildPolicyHost } from "../fixtures/windows-child-process-policy-host";
import { WindowsNodeHostCleanupError } from "../fixtures/windows-node-lpac-startup";

const context = { phase: 2, operation: 13, predicate: 10 };
const nonzeroExits = [1, 101, 102, 103, 104, 105, 0x7fffffff, 0x80000000, 0x80000003, 0xc0000022, 0xdeadbeef, 0xffffffff];
const malformed = [undefined, null, false, true, "0", "101", "private native text", 0n, 101n, -1, 0x100000000, 1.5, NaN, Infinity, -Infinity, {}, [], Symbol("private")];

function setup(returned: unknown) {
  const process = { process: 2n, thread: 3n, pid: 4 };
  const fence = { unsafe: false, retained: [] as unknown[] };
  const input = { program: "C:\\fixed.exe", command: Buffer.alloc(2), cwd: "C:\\work", environment: Buffer.alloc(4), unchanged: vi.fn() };
  const api = { createJob: vi.fn(() => 1n), assign: vi.fn(), resume: vi.fn(), terminateProcess: vi.fn(), terminateJob: vi.fn(),
    exited: vi.fn(() => true), jobState: vi.fn(() => ({ active: 0, listed: 0 })), exitCode: vi.fn((_handle: bigint) => returned as number), close: vi.fn() };
  const native = { create: vi.fn(() => process), verify: vi.fn() };
  return { api, native, input, fence, process };
}

async function terminal(value: ReturnType<typeof setup>) {
  let failure: unknown;
  try { await runWindowsChildPolicyHost(value.input, value.api, value.native, value.fence); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(WindowsNodeHostCleanupError);
  expect(value.api.exitCode).toHaveBeenCalledTimes(1);
  expect(value.api.exitCode).toHaveBeenCalledWith(value.process.process);
  expect(value.api.terminateProcess).toHaveBeenCalledExactlyOnceWith(value.process.process);
  expect(value.api.terminateJob).toHaveBeenCalledExactlyOnceWith(1n);
  expect(value.api.close).not.toHaveBeenCalled();
  expect(value.fence.unsafe).toBe(true);
  expect(value.fence.retained).toEqual([{ job: 1n, process: value.process, input: value.input, api: value.api, native: value.native }]);
  return failure;
}

describe("An exactly captured host DWORD exit", () => {
  it.each([0, -0])("keeps the existing successful zero predicate and queries it once: %s", async returned => {
    const value = setup(returned);
    await expect(runWindowsChildPolicyHost(value.input, value.api, value.native, value.fence)).resolves.toEqual({ exitCode: 0, jobStopped: true });
    expect(value.api.exitCode).toHaveBeenCalledExactlyOnceWith(2n);
    expect(value.api.close.mock.calls).toEqual([[3n], [2n], [1n]]);
    expect(value.api.terminateProcess).not.toHaveBeenCalled(); expect(value.api.terminateJob).not.toHaveBeenCalled();
    expect(value.fence).toEqual({ unsafe: false, retained: [] });
  });

  it.each(nonzeroExits)("retains a nonzero exit without filtering public or unfamiliar statuses: %s", async returnedExit => {
    const value = setup(returnedExit), error = await terminal(value);
    expect(windowsChildPolicyFailure(error)).toEqual({ schema: 1, ...context, domain: 2, returnedExit });
    expect(Object.isFrozen(windowsChildPolicyFailure(error))).toBe(true);
    expect(value.api.jobState).toHaveBeenCalledTimes(2);
    expect(value.api.exited).toHaveBeenCalledTimes(2);
  });

  it.each(malformed)("refuses a malformed return without publishing it: %s", async returned => {
    const error = await terminal(setup(returned));
    expect(windowsChildPolicyFailure(error)).toEqual({ schema: 1, ...context, domain: 0 });
    expect(Object.keys(windowsChildPolicyFailure(error)!)).toEqual(["schema", "phase", "operation", "predicate", "domain"]);
  });

  it("distinguishes an API exception from a returned DWORD without forwarding private exception text", async () => {
    const value = setup(101), privateError = new Error("private native path and handle value");
    value.api.exitCode.mockImplementation(() => { throw privateError; });
    const error = await terminal(value);
    expect(windowsChildPolicyFailure(error)).toEqual({ schema: 1, ...context, domain: 0 });
    expect(error).not.toBe(privateError);
    expect((error as Error).message).toBe(new WindowsNodeHostCleanupError().message);
    expect(JSON.stringify(windowsChildPolicyFailure(error))).not.toContain("private");
    expect(Object.hasOwn(error as object, "cause")).toBe(false);
  });

  it("never coerces a malformed return while it retains the host owners", async () => {
    let reads = 0;
    const value = setup(new Proxy({}, { get() { reads++; throw new Error("private native getter"); } }));
    expect(windowsChildPolicyFailure(await terminal(value))).toEqual({ schema: 1, ...context, domain: 0 });
    expect(reads).toBe(0);
  });

  it("keeps the first captured exit through cleanup failures and fences every later start", async () => {
    const value = setup(105);
    value.api.terminateProcess.mockImplementation(() => { throw new Error("private root Stop failure"); });
    value.api.terminateJob.mockImplementation(() => { throw new Error("private job Stop failure"); });
    const error = await terminal(value);
    expect(windowsChildPolicyFailure(error)).toEqual({ schema: 1, ...context, domain: 2, returnedExit: 105 });
    const calls = [value.api.createJob.mock.calls.length, value.native.create.mock.calls.length, value.api.exitCode.mock.calls.length];
    await expect(runWindowsChildPolicyHost(value.input, value.api, value.native, value.fence)).rejects.toBeInstanceOf(WindowsNodeHostCleanupError);
    expect([value.api.createJob.mock.calls.length, value.native.create.mock.calls.length, value.api.exitCode.mock.calls.length]).toEqual(calls);
    expect(value.api.close).not.toHaveBeenCalled(); expect(value.fence.retained).toHaveLength(1);
  });

  it.each(["BOOL", "exit"] as const)("preserves earlier %s facts thrown by the existing exit query", async kind => {
    const value = setup(101), first = kind === "BOOL"
      ? brandWindowsChildPolicyFailure(new Error("private first BOOL"), { phase: 1, operation: 3, predicate: 7 }, false)
      : brandWindowsChildPolicyExitFailure(new Error("private first exit"), context, 104);
    value.api.exitCode.mockImplementation(() => { throw first; });
    const error = await terminal(value);
    expect(windowsChildPolicyFailure(error)).toBe(windowsChildPolicyFailure(first));
    expect(windowsChildPolicyFailure(error)).toEqual(kind === "BOOL"
      ? { schema: 1, phase: 1, operation: 3, predicate: 7, domain: 1, returnedBool: 0 } : { schema: 1, ...context, domain: 2, returnedExit: 104 });
  });
});

describe("Closed exit receipt branding", () => {
  it.each([0, ...nonzeroExits])("brands the original error with one frozen DWORD and no BOOL: %s", returnedExit => {
    let reads = 0;
    const error = new Proxy({}, { get() { reads++; throw new Error("private error getter"); } });
    expect(brandWindowsChildPolicyExitFailure(error, context, returnedExit)).toBe(error);
    const receipt = windowsChildPolicyFailure(error);
    expect(receipt).toEqual({ schema: 1, ...context, domain: 2, returnedExit });
    expect(Object.isFrozen(receipt)).toBe(true); expect(Object.hasOwn(receipt!, "returnedBool")).toBe(false); expect(reads).toBe(0);
  });

  it.each(malformed)("keeps malformed captured data out of the closed receipt: %s", captured => {
    const error = Object.freeze(new Error("private captured value"));
    expect(brandWindowsChildPolicyExitFailure(error, context, captured)).toBe(error);
    expect(windowsChildPolicyFailure(error)).toEqual({ schema: 1, ...context, domain: 0 });
  });

  it("cannot replace a first BOOL brand with an exit or a first exit brand with a BOOL", () => {
    const bool = brandWindowsChildPolicyFailure(new Error(), context, 0), firstBool = windowsChildPolicyFailure(bool);
    brandWindowsChildPolicyExitFailure(bool, context, 101);
    expect(windowsChildPolicyFailure(bool)).toBe(firstBool);
    const exit = brandWindowsChildPolicyExitFailure(new Error(), context, 0xdeadbeef), firstExit = windowsChildPolicyFailure(exit);
    brandWindowsChildPolicyFailure(exit, { phase: 6, operation: 14, predicate: 11 }, true);
    expect(windowsChildPolicyFailure(exit)).toBe(firstExit);
    brandWindowsChildPolicyExitFailure(exit, context, 105); expect(windowsChildPolicyFailure(exit)).toBe(firstExit);
  });

  it("preserves the earliest BOOL or exit receipt across already branded wrappers", () => {
    const firstExit = brandWindowsChildPolicyExitFailure(new Error(), context, 104), firstReceipt = windowsChildPolicyFailure(firstExit);
    const laterBool = brandWindowsChildPolicyFailure(new TypeError(), { phase: 6, operation: 14, predicate: 11 }, 1);
    expect(preserveWindowsChildPolicyFailure(firstExit, laterBool)).toBe(laterBool);
    expect(windowsChildPolicyFailure(laterBool)).toBe(firstReceipt);
    const final = brandWindowsChildPolicyExitFailure(new WindowsNodeHostCleanupError(), context, 105);
    expect(preserveWindowsChildPolicyFailure(laterBool, final)).toBe(final); expect(windowsChildPolicyFailure(final)).toBe(firstReceipt);
    expect(preserveWindowsChildPolicyFailure(final, firstExit)).toBe(firstExit); expect(windowsChildPolicyFailure(firstExit)).toBe(firstReceipt);
    const earlierBool = brandWindowsChildPolicyFailure(new Error(), context, false), boolReceipt = windowsChildPolicyFailure(earlierBool);
    const laterExit = brandWindowsChildPolicyExitFailure(new Error(), context, 101);
    preserveWindowsChildPolicyFailure(laterExit, earlierBool); expect(windowsChildPolicyFailure(earlierBool)).toBe(boolReceipt);
    preserveWindowsChildPolicyFailure(earlierBool, laterExit); expect(windowsChildPolicyFailure(laterExit)).toBe(boolReceipt);
  });

  it("keeps the first unknown brand unknown and refuses forged receipt-shaped objects", () => {
    const error = brandWindowsChildPolicyExitFailure(new Error(), context, "101"), unknown = windowsChildPolicyFailure(error);
    brandWindowsChildPolicyExitFailure(error, context, 101); expect(windowsChildPolicyFailure(error)).toBe(unknown);
    for (const forged of [{ ...unknown }, Object.create(error), { domain: 2, returnedExit: 101 }, null, "private", 101]) expect(windowsChildPolicyFailure(forged)).toBeUndefined();
  });
});
